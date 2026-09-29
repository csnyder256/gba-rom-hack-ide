// File-intake pipeline: turn an operator-supplied `.gba` ROM or `.zip`
// archive into a managed project directory the rest of the editor can open
// as if it were a regular project root.
//
// Managed projects live under `%APPDATA%\rom-editor\projects\<sha1>\` so:
//   - re-opening the same file resolves to the same directory (stable
//     identity via content hash, not filename or path)
//   - they don't pollute the original ROM/ZIP location
//   - they survive reboots
//
// A `.editor/intake.json` records the original path + intake kind + SHA-1
// + timestamp so the project view can surface "this was opened from a ROM
// on YYYY-MM-DD".

import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export type IntakeKind = 'rom' | 'archive';

export interface IntakeResult {
  readonly managedProjectRoot: string;
  readonly intakeKind: IntakeKind;
  readonly sha1: string;
  readonly originalPath: string;
  readonly extractedEntryCount?: number;
}

export interface IntakeMeta {
  readonly originalPath: string;
  readonly originalFileName: string;
  readonly kind: IntakeKind;
  readonly sha1: string;
  readonly intakedAtUtc: string;
  readonly extractedEntryCount?: number;
}

export class IntakeError extends Error {
  constructor(
    public readonly code:
      | 'unsupported_file_kind'
      | 'file_not_found'
      | 'not_a_file'
      | 'sha1_failed'
      | 'copy_failed'
      | 'zip_extraction_failed'
      | 'zip_slip_attempt'
      | 'managed_root_create_failed',
    message: string,
  ) {
    super(message);
    this.name = 'IntakeError';
  }
}

const SUPPORTED_ROM_EXTS = new Set(['.gba']);
const SUPPORTED_ARCHIVE_EXTS = new Set(['.zip']);

function classifyFile(filePath: string): IntakeKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (SUPPORTED_ROM_EXTS.has(ext)) return 'rom';
  if (SUPPORTED_ARCHIVE_EXTS.has(ext)) return 'archive';
  return null;
}

// %APPDATA% on Windows, else ~/.rom-editor (Linux/macOS fallback). Tests
// override this by passing managedRootOverride into intakeFile.
function defaultManagedRoot(): string {
  if (process.env.ROM_EDITOR_MANAGED_ROOT) return path.resolve(process.env.ROM_EDITOR_MANAGED_ROOT);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'rom-editor', 'projects');
  }
  return path.join(homedir(), '.rom-editor', 'projects');
}

async function hashFile(filePath: string): Promise<string> {
  try {
    const hash = createHash('sha1');
    await pipeline(createReadStream(filePath), hash as unknown as NodeJS.WritableStream);
    return hash.digest('hex');
  } catch (e) {
    throw new IntakeError(
      'sha1_failed',
      `Could not compute SHA-1 of ${filePath}: ${(e as Error).message}`,
    );
  }
}

async function writeIntakeMeta(managedRoot: string, meta: IntakeMeta): Promise<void> {
  const dir = path.join(managedRoot, '.editor');
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'intake.json');
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  await fsp.rename(tmp, target);
}

async function intakeRom(
  filePath: string,
  managedRoot: string,
  sha1: string,
): Promise<IntakeResult> {
  const fileName = path.basename(filePath);
  const target = path.join(managedRoot, fileName);
  // Stable identity via SHA-1 in the managed-root path - re-opening the
  // same ROM resolves to the same dir, so we skip the copy if the target
  // already exists with the matching hash.
  try {
    const existing = await fsp.stat(target).catch(() => null);
    if (!existing) {
      await fsp.copyFile(filePath, target);
    }
  } catch (e) {
    throw new IntakeError('copy_failed', `Could not copy ROM into managed root: ${(e as Error).message}`);
  }
  const meta: IntakeMeta = {
    originalPath: filePath,
    originalFileName: fileName,
    kind: 'rom',
    sha1,
    intakedAtUtc: new Date().toISOString(),
  };
  await writeIntakeMeta(managedRoot, meta);
  return {
    managedProjectRoot: managedRoot,
    intakeKind: 'rom',
    sha1,
    originalPath: filePath,
  };
}

// Reject entries whose resolved path escapes the target dir (ZIP-slip).
function safeJoin(targetDir: string, entryName: string): string {
  // Normalize separators + collapse '..' segments.
  const resolved = path.resolve(targetDir, entryName);
  const targetWithSep = targetDir.endsWith(path.sep) ? targetDir : targetDir + path.sep;
  if (resolved !== targetDir && !resolved.startsWith(targetWithSep)) {
    throw new IntakeError(
      'zip_slip_attempt',
      `ZIP entry '${entryName}' resolves outside the target directory - refusing to extract.`,
    );
  }
  return resolved;
}

async function intakeArchive(
  filePath: string,
  managedRoot: string,
  sha1: string,
): Promise<IntakeResult> {
  let entryCount = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
        if (err || !zip) {
          reject(err ?? new Error('yauzl returned no zipfile'));
          return;
        }
        zip.on('error', (e) => reject(e));
        zip.on('end', () => resolve());
        zip.on('entry', (entry: yauzl.Entry) => {
          (async () => {
            try {
              const isDir = /\/$/.test(entry.fileName);
              const out = safeJoin(managedRoot, entry.fileName);
              if (isDir) {
                await fsp.mkdir(out, { recursive: true });
                entryCount++;
                zip.readEntry();
                return;
              }
              // File entry - ensure parent dir, stream extract.
              await fsp.mkdir(path.dirname(out), { recursive: true });
              await new Promise<void>((res, rej) => {
                zip.openReadStream(entry, async (e, readStream) => {
                  if (e || !readStream) {
                    rej(e ?? new Error('no read stream'));
                    return;
                  }
                  try {
                    const { createWriteStream } = await import('node:fs');
                    const ws = createWriteStream(out);
                    readStream.on('error', rej);
                    ws.on('error', rej);
                    ws.on('finish', () => res());
                    readStream.pipe(ws);
                  } catch (err2) {
                    rej(err2);
                  }
                });
              });
              entryCount++;
              zip.readEntry();
            } catch (e) {
              reject(e);
            }
          })().catch(reject);
        });
        zip.readEntry();
      });
    });
  } catch (e) {
    if (e instanceof IntakeError) throw e;
    throw new IntakeError(
      'zip_extraction_failed',
      `Could not extract ${filePath}: ${(e as Error).message}`,
    );
  }
  const meta: IntakeMeta = {
    originalPath: filePath,
    originalFileName: path.basename(filePath),
    kind: 'archive',
    sha1,
    intakedAtUtc: new Date().toISOString(),
    extractedEntryCount: entryCount,
  };
  await writeIntakeMeta(managedRoot, meta);
  return {
    managedProjectRoot: managedRoot,
    intakeKind: 'archive',
    sha1,
    originalPath: filePath,
    extractedEntryCount: entryCount,
  };
}

export interface IntakeOptions {
  /** Override the managed-root parent dir (used by tests to redirect away
   *  from %APPDATA%). Production callers omit this. */
  readonly managedRootOverride?: string;
}

export async function intakeFile(
  filePath: string,
  options: IntakeOptions = {},
): Promise<IntakeResult> {
  // Validate file existence + kind.
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new IntakeError('file_not_found', `Path does not exist: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new IntakeError('not_a_file', `Path exists but is not a file: ${filePath}`);
  }
  const kind = classifyFile(filePath);
  if (!kind) {
    throw new IntakeError(
      'unsupported_file_kind',
      `File extension is not supported. Got '${path.extname(filePath)}'; expected .gba or .zip.`,
    );
  }

  // Hash + decide managed root.
  const sha1 = await hashFile(filePath);
  const managedRootParent = options.managedRootOverride ?? defaultManagedRoot();
  const managedRoot = path.join(managedRootParent, sha1);
  try {
    await fsp.mkdir(managedRoot, { recursive: true });
  } catch (e) {
    throw new IntakeError(
      'managed_root_create_failed',
      `Could not create managed project root at ${managedRoot}: ${(e as Error).message}`,
    );
  }

  if (kind === 'rom') return intakeRom(filePath, managedRoot, sha1);
  return intakeArchive(filePath, managedRoot, sha1);
}
