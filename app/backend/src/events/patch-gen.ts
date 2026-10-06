import { promises as fsp } from 'node:fs';
import path from 'node:path';
// PD 13 migration (UW-0-T3): IPS encode/decode/apply/diff routes through
// the canonical engine module (`@rom-introspection/engine` → `patch`
// namespace, ships P13-T1 with 14 unit tests + 8 diff tests + 16 MiB
// roundtrip artifact). Editor's legacy `lib/ips-patch.ts` is
// `legacy-pending-removal`; parity proven by
// `lib/ips-patch.parity.test.ts` (6 cases agree round-trip).
import { patch as enginePatch } from '@rom-introspection/engine';

export class PatchGenerationError extends Error {
  constructor(
    public readonly code:
      | 'base_rom_not_found'
      | 'modified_rom_not_found'
      | 'rom_too_large'
      | 'rom_empty'
      | 'output_path_escapes_project_root'
      | 'patch_exceeds_ips_format'
      | 'bps_encode_failed'
      | 'mutation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'PatchGenerationError';
  }
}

/** Modernize-and-Ship slice 8 - supported export formats. IPS is the
 *  default (16 MiB addressable, smaller patches for small diffs) and
 *  BPS is for cases where the edits exceed IPS's range (typical for
 *  CFRU-modernized ROMs that touch the upper half of the expanded
 *  32 MiB ROM). */
export type PatchFormat = 'ips' | 'bps';

const MAX_ROM_BYTES = 32 * 1024 * 1024; // pokemerald + most GBA roms <= 32 MB

export interface GeneratePatchOptions {
  readonly projectRoot: string;
  /** Absolute or project-relative path to the unmodified base ROM. */
  readonly baseRomPath: string;
  /** Project-relative path to the modified (built) ROM. */
  readonly modifiedRomPath: string;
  /** Project-relative path where the patch should land. */
  readonly outputPath: string;
  /** Modernize-and-Ship slice 8 - patch format. Defaults to 'ips' for
   *  backwards compatibility; CFRU-modernized projects should pass
   *  'bps' when their edits exceed IPS's 16 MiB-addressable limit. */
  readonly patchFormat?: PatchFormat;
}

export interface GeneratePatchResult {
  readonly outputPath: string;
  /** Number of records (IPS) or actions (BPS) emitted by the producer. */
  readonly recordCount: number;
  readonly totalPatchedBytes: number;
  readonly patchBytes: number;
  readonly baseSizeBytes: number;
  readonly modifiedSizeBytes: number;
  /** Modernize-and-Ship slice 8 - which format was used. Mirrors the
   *  request's patchFormat (or its 'ips' default). */
  readonly patchFormat: PatchFormat;
}

function resolveRomPath(projectRoot: string, p: string): string {
  // Absolute paths are accepted as-is (writers commonly keep base ROMs outside
  // the project tree). Project-relative paths get resolved + bounded.
  if (path.isAbsolute(p)) return p;
  return path.resolve(projectRoot, p);
}

async function readRom(absPath: string, errorCode: 'base_rom_not_found' | 'modified_rom_not_found'): Promise<Buffer> {
  let buf: Buffer;
  try {
    buf = await fsp.readFile(absPath);
  } catch {
    throw new PatchGenerationError(errorCode, `ROM file not found: ${absPath}`);
  }
  if (buf.length === 0) {
    throw new PatchGenerationError('rom_empty', `ROM file is empty: ${absPath}`);
  }
  if (buf.length > MAX_ROM_BYTES) {
    throw new PatchGenerationError(
      'rom_too_large',
      `ROM size ${buf.length} exceeds max ${MAX_ROM_BYTES}`,
    );
  }
  return buf;
}

export async function generatePatch(
  options: GeneratePatchOptions,
): Promise<GeneratePatchResult> {
  const { projectRoot, baseRomPath, modifiedRomPath, outputPath } = options;
  const patchFormat: PatchFormat = options.patchFormat ?? 'ips';

  // Output path stays inside the project so we don't accidentally write
  // patches to system directories.
  const outputAbs = path.resolve(projectRoot, outputPath);
  const projectAbs = path.resolve(projectRoot);
  if (outputAbs !== projectAbs && !outputAbs.startsWith(projectAbs + path.sep)) {
    throw new PatchGenerationError(
      'output_path_escapes_project_root',
      `Output path '${outputPath}' resolves outside the project root`,
    );
  }

  const baseAbs = resolveRomPath(projectRoot, baseRomPath);
  const modifiedAbs = resolveRomPath(projectRoot, modifiedRomPath);
  const base = await readRom(baseAbs, 'base_rom_not_found');
  const modified = await readRom(modifiedAbs, 'modified_rom_not_found');

  let patchBytes: Uint8Array;
  let recordCount: number;
  let totalPatchedBytes: number;

  if (patchFormat === 'ips') {
    let records: readonly enginePatch.IpsRecord[];
    try {
      const report = enginePatch.produceIpsRecordsWithReport(base, modified);
      // Bytes at or past IPS_MAX_OFFSET + 1 differ but have nowhere to
      // live: a 3-byte offset cannot reach them. Letting the patch out
      // anyway would ship a file that applies cleanly and silently
      // leaves those edits out of the rebuilt ROM, so refuse it and
      // point at the format that can carry them.
      if (report.unrepresentableBytes > 0) {
        const first = report.unrepresentableRanges[0]!;
        throw new enginePatch.IpsFormatError(
          `${String(report.unrepresentableBytes)} differing byte(s) sit past the last addressable IPS offset 0x${enginePatch.IPS_MAX_OFFSET.toString(16)} (first at 0x${first[0].toString(16)}) and cannot be represented`,
        );
      }
      records = report.records;
      patchBytes = enginePatch.encodeIps(records);
    } catch (e) {
      if (e instanceof enginePatch.IpsFormatError) {
        const msg = e.message;
        if (msg.includes('cannot shrink')) {
          throw new PatchGenerationError(
            'mutation_failed',
            `IPS encode failed (shrink not supported): ${msg}`,
          );
        }
        throw new PatchGenerationError(
          'patch_exceeds_ips_format',
          `IPS encode failed: ${msg}. Try patchFormat: 'bps'.`,
        );
      }
      throw new PatchGenerationError(
        'mutation_failed',
        `IPS encode failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    recordCount = records.length;
    totalPatchedBytes = records.reduce(
      (sum, r) => sum + (r.kind === 'literal' ? r.data.length : r.rleLength),
      0,
    );
  } else {
    // BPS - no offset cap so shrinks + arbitrary-position diffs work
    // beyond IPS's 16 MiB addressable window.
    let actions: ReadonlyArray<enginePatch.BpsAction>;
    try {
      const baseBytes = new Uint8Array(base.buffer, base.byteOffset, base.byteLength);
      const modBytes = new Uint8Array(modified.buffer, modified.byteOffset, modified.byteLength);
      actions = enginePatch.produceBpsActions(baseBytes, modBytes);
      patchBytes = enginePatch.encodeBps(actions, baseBytes, modBytes);
    } catch (e) {
      throw new PatchGenerationError(
        'bps_encode_failed',
        `BPS encode failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    recordCount = actions.length;
    totalPatchedBytes = actions.reduce(
      (sum, a) =>
        sum +
        (a.kind === 'target_read'
          ? a.data.length
          : a.kind === 'source_read' || a.kind === 'source_copy' || a.kind === 'target_copy'
            ? a.length
            : 0),
      0,
    );
  }
  const encodedBytes = Buffer.from(patchBytes);

  // Ensure parent dir exists then atomic tmp+rename write.
  try {
    await fsp.mkdir(path.dirname(outputAbs), { recursive: true });
  } catch (e) {
    throw new PatchGenerationError(
      'mutation_failed',
      `Could not create patch parent directory: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const tmpPath = outputAbs + '.tmp';
  try {
    await fsp.writeFile(tmpPath, encodedBytes);
    await fsp.rename(tmpPath, outputAbs);
  } catch (e) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new PatchGenerationError(
      'mutation_failed',
      `Atomic patch write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    outputPath,
    recordCount,
    totalPatchedBytes,
    patchBytes: encodedBytes.length,
    baseSizeBytes: base.length,
    modifiedSizeBytes: modified.length,
    patchFormat,
  };
}
