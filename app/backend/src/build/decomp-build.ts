/**
 * One-click decomp build ("Build & Play") for the modern devkitARM toolchain.
 *
 * The proven Windows recipe (see MASTER_PLAN §11) is:
 *
 *   <devkitPro-msys2>/usr/bin/bash.exe -lc
 *     'export PATH="$DEVKITARM/bin:$PATH";
 *      cd <project>;
 *      make modern -jN CPP=/usr/local/bin/arm-none-eabi-cpp'
 *
 * Key environment facts this encodes:
 *   - devkitPro's MSYS2 login shell sets DEVKITARM but does NOT put
 *     $DEVKITARM/bin on PATH, so we prepend it (else arm-none-eabi-gcc
 *     isn't found).
 *   - `make modern` selects the GCC path (no agbcc).
 *   - the CPP override forces a CR-stripping cpp wrapper so pret's
 *     preproc/trainerproc don't choke on devkitARM's CRLF output.
 *
 * Builds take minutes, so this runs asynchronously: callers start a job and
 * poll its status; the streamed stdout/stderr is the live log.
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findFirstGbaFile } from '../scan/binary-rom.js';

export type DecompBuildState = 'running' | 'success' | 'error';

export interface DecompBuildJob {
  readonly id: string;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly command: string;
  readonly startedAtUtc: string;
  state: DecompBuildState;
  log: string;
  exitCode: number | null;
  endedAtUtc: string | null;
  /** Output ROM path relative to projectRoot, set on success. */
  romRelPath: string | null;
  /** One-line plain-English failure summary, set on error. */
  errorSummary: string | null;
}

/** Cap the in-memory log so a runaway build can't exhaust memory. */
const MAX_LOG_CHARS = 200_000;
/** Hard ceiling so a hung build can't run forever (30 min). */
const BUILD_TIMEOUT_MS = 30 * 60_000;
/** The CR-stripping cpp wrapper installed during toolchain setup (§11). */
const CPP_WRAPPER = '/usr/local/bin/arm-none-eabi-cpp';

const jobs = new Map<string, DecompBuildJob>();

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Locate devkitPro's MSYS2 bash (or a standalone MSYS2), or null if absent. */
export async function findMsysBash(): Promise<string | null> {
  const candidates = [
    process.env.ROM_EDITOR_MSYS_BASH,
    'C:\\devkitPro\\msys2\\usr\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

/** Convert a Windows path to its MSYS2 drive-mount form: C:\a\b → /c/a/b. */
export function toMsysPath(winPath: string): string {
  const abs = path.resolve(winPath).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(abs);
  if (!m) return abs;
  return `/${m[1]!.toLowerCase()}/${m[2]!}`;
}

function appendLog(job: DecompBuildJob, chunk: string): void {
  job.log += chunk;
  if (job.log.length > MAX_LOG_CHARS) {
    job.log = '…(earlier output truncated)…\n' + job.log.slice(-MAX_LOG_CHARS);
  }
}

/** Pull the first compiler/make error line for a human-readable summary. */
function summarizeError(log: string, exitCode: number | null): string {
  const lines = log.split(/\r?\n/);
  const errLine = lines.find((l) => /\berror:|No rule to make target|\*\*\* /i.test(l));
  if (errLine) return errLine.trim().slice(0, 240);
  return `Build failed (make exited with code ${exitCode ?? '?'}).`;
}

export interface StartBuildResult {
  readonly job?: DecompBuildJob;
  readonly error?: string;
}

/**
 * Start an async `make modern` build. Returns the created job immediately;
 * the caller polls getDecompBuildJob() for progress + completion.
 */
export async function startDecompBuild(
  sessionId: string,
  projectRoot: string,
): Promise<StartBuildResult> {
  for (const j of jobs.values()) {
    if (j.projectRoot === projectRoot && j.state === 'running') {
      return { error: 'A build is already running for this project.' };
    }
  }
  if (!(await fileExists(path.join(projectRoot, 'Makefile')))) {
    return { error: 'No Makefile here - Build & Play needs a decomp source project.' };
  }
  const windows = process.platform === 'win32';
  const nativeBash = process.env.ROM_EDITOR_MSYS_BASH || '/bin/bash';
  const bash = windows ? await findMsysBash() : await fileExists(nativeBash) ? nativeBash : null;
  if (!bash) {
    return {
      error:
        windows
          ? 'Could not find devkitPro MSYS2 bash. Set ROM_EDITOR_MSYS_BASH to its full path.'
          : 'Could not find bash. Install bash and your project toolchain, or set ROM_EDITOR_MSYS_BASH to the shell path.',
    };
  }

  const jobsN = Math.max(1, os.cpus().length);
  const unixProj = windows ? toMsysPath(projectRoot) : projectRoot;
  // Pass the workspace as a positional argument, never as shell source. Native
  // hosts use their installed toolchain; Windows retains its MSYS2 cpp wrapper.
  const script = `if [ -n "\${DEVKITARM:-}" ]; then export PATH="$DEVKITARM/bin:$PATH"; fi; cd -- "$1" && make modern -j${jobsN}${windows ? ' CPP=' + CPP_WRAPPER : ''}`;
  const shellMode = windows ? '-lc' : '-c';

  const job: DecompBuildJob = {
    id: randomUUID(),
    sessionId,
    projectRoot,
    command: `${bash} ${shellMode} [project root supplied as an argument]`,
    startedAtUtc: new Date().toISOString(),
    state: 'running',
    log: '',
    exitCode: null,
    endedAtUtc: null,
    romRelPath: null,
    errorSummary: null,
  };
  jobs.set(job.id, job);

  const child = spawn(bash, [shellMode, script, 'gba-build', unixProj], { cwd: projectRoot });

  const killTimer = setTimeout(() => {
    appendLog(job, '\n[timeout] build exceeded 30 min - terminating.\n');
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }, BUILD_TIMEOUT_MS);

  child.stdout.on('data', (d: Buffer) => appendLog(job, d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => appendLog(job, d.toString('utf8')));
  child.on('error', (err) => {
    clearTimeout(killTimer);
    job.state = 'error';
    job.errorSummary = err instanceof Error ? err.message : String(err);
    job.endedAtUtc = new Date().toISOString();
    appendLog(job, `\n[spawn error] ${job.errorSummary}\n`);
  });
  child.on('close', (code) => {
    clearTimeout(killTimer);
    job.exitCode = code;
    if (code === 0) {
      // Resolve the output ROM BEFORE flipping to success, so a poll never
      // sees state=success with a null romRelPath.
      void findFirstGbaFile(projectRoot)
        .then((rom) => {
          job.romRelPath = rom ? path.relative(projectRoot, rom).replace(/\\/g, '/') : null;
        })
        .catch(() => {
          job.romRelPath = null;
        })
        .finally(() => {
          job.state = 'success';
          job.endedAtUtc = new Date().toISOString();
        });
    } else {
      job.state = 'error';
      job.errorSummary = summarizeError(job.log, code);
      job.endedAtUtc = new Date().toISOString();
    }
  });

  return { job };
}

export function getDecompBuildJob(id: string): DecompBuildJob | null {
  return jobs.get(id) ?? null;
}
