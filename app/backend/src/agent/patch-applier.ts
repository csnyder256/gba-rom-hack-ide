import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  BinaryReplaceTextEdit,
  BinaryRewritePointerEdit,
  BinaryWriteBytesEdit,
  BinaryWriteTextEdit,
  ReplaceInFileEdit,
} from '@rom-editor/shared';
import { text } from '@rom-introspection/engine';

const STRING_TERMINATOR = 0xff;
const DEFAULT_MAX_BYTES = 256;
const GBA_ROM_BASE = 0x08000000;

export type PatchApplyErrorCode =
  | 'unknown_edit_kind'
  | 'unsafe_path'
  | 'file_not_found'
  | 'before_not_found'
  | 'before_ambiguous'
  | 'write_failed'
  | 'rom_not_found'
  | 'rom_offset_out_of_range'
  | 'encode_failed'
  | 'after_too_long'
  | 'slot_not_free'
  | 'pointer_mismatch'
  | 'bad_hex'
  | 'length_mismatch'
  | 'bytes_mismatch';

/**
 * Thrown by applyEdits when a single edit can't be applied. The
 * applier rolls back any prior edits in the same call before throwing,
 * so a failed proposal leaves the project bytes-identical to before.
 */
export class PatchApplyError extends Error {
  constructor(
    public readonly code: PatchApplyErrorCode,
    public readonly editIndex: number,
    public readonly filePath: string,
    message: string,
  ) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

export interface ApplyEditsResult {
  /** Number of edits applied. Always equal to edits.length on success
   *  (partial-apply isn't permitted - failures roll back). */
  readonly appliedCount: number;
  /** Inverse edits, suitable for undo. For each `replace_in_file` we
   *  swap before↔after; for each `binary_replace_text` we swap
   *  before↔after at the same offset. Stored in the op-log entry's
   *  payload so the existing undo machinery reaches our patches via
   *  the `agent_patch_apply` OpKind. */
  readonly reverseEdits: ReadonlyArray<AgentPatchEdit>;
}

interface FileRollbackEntry {
  readonly kind: 'file';
  readonly absPath: string;
  readonly originalContent: string;
}

interface RomRollbackEntry {
  readonly kind: 'rom';
  readonly absPath: string;
  /** Original bytes BEFORE any binary edits in this batch were applied,
   *  used to restore the full ROM on rollback. */
  readonly originalBytes: Buffer;
}

/**
 * Apply a list of edits to disk atomically. Two edit kinds supported:
 *
 *   - replace_in_file:    project-relative source file path; exact
 *                         single-occurrence text find+replace.
 *
 *   - binary_replace_text: in-place Gen-3 text write inside the
 *                         project's .gba (located via shallow scan).
 *                         Same-length-or-shorter only; encoded
 *                         length + terminator must fit inside the
 *                         original string's byte slot.
 *
 * On any per-edit failure: rolls back ALL prior writes in reverse
 * order (text files restored from captured originals; .gba restored
 * from the pre-batch snapshot) before throwing PatchApplyError.
 *
 * For .gba ROM batches: makes a `.bak` copy once per call (mirrors
 * the existing binary-rom-object-event-write pattern). All binary
 * edits in a single call mutate a single in-memory Buffer; the
 * Buffer is written to disk once after all binary edits succeed.
 */
export async function applyEdits(
  projectRoot: string,
  edits: ReadonlyArray<AgentPatchEdit>,
): Promise<ApplyEditsResult> {
  const reverseEdits: AgentPatchEdit[] = [];
  const rollback: Array<FileRollbackEntry | RomRollbackEntry> = [];

  /** Lazily-loaded ROM buffer for binary edits. Null until the first
   *  binary edit in this batch; populated once and mutated in place. */
  let romState: { absPath: string; buffer: Buffer } | null = null;

  async function loadRom(): Promise<{ absPath: string; buffer: Buffer }> {
    if (romState) return romState;
    const romPath = await findFirstGbaFile(projectRoot);
    if (!romPath) {
      throw new PatchApplyError(
        'rom_not_found',
        -1,
        '',
        `No .gba file found under '${projectRoot}'. Binary edits require an opened binary-rom project.`,
      );
    }
    const buffer = await fsp.readFile(romPath);
    romState = { absPath: romPath, buffer };
    rollback.push({ kind: 'rom', absPath: romPath, originalBytes: Buffer.from(buffer) });
    return romState;
  }

  try {
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      switch (edit.kind) {
        case 'replace_in_file': {
          const reverse = await applyReplaceInFile(projectRoot, edit, i, rollback);
          reverseEdits.push(reverse);
          break;
        }
        case 'binary_replace_text': {
          const rom = await loadRom();
          const reverse = applyBinaryReplaceText(edit, i, rom.buffer);
          reverseEdits.push(reverse);
          break;
        }
        case 'binary_write_text': {
          const rom = await loadRom();
          const reverse = applyBinaryWriteText(edit, i, rom.buffer);
          reverseEdits.push(reverse);
          break;
        }
        case 'binary_rewrite_pointer': {
          const rom = await loadRom();
          const reverse = applyBinaryRewritePointer(edit, i, rom.buffer);
          reverseEdits.push(reverse);
          break;
        }
        case 'binary_write_bytes': {
          const rom = await loadRom();
          const reverse = applyBinaryWriteBytes(edit, i, rom.buffer);
          reverseEdits.push(reverse);
          break;
        }
        default: {
          throw new PatchApplyError(
            'unknown_edit_kind',
            i,
            '',
            `Unknown edit kind '${(edit as { kind: string }).kind}'.`,
          );
        }
      }
    }

    // All edits validated + applied to buffers. Now flush the ROM
    // buffer to disk (text edits were already flushed inline above).
    if (romState) {
      const { absPath, buffer } = romState;
      // Back up once per session - matches binary-rom-object-event-write.ts.
      const backupPath = `${absPath}.bak`;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(absPath, backupPath);
      }
      await fsp.writeFile(absPath, buffer);
    }

    return { appliedCount: edits.length, reverseEdits };
  } catch (err) {
    // Roll back in REVERSE order so dependent edits restore cleanly.
    for (let i = rollback.length - 1; i >= 0; i--) {
      const rb = rollback[i]!;
      try {
        if (rb.kind === 'file') {
          await fsp.writeFile(rb.absPath, rb.originalContent, 'utf8');
        } else {
          await fsp.writeFile(rb.absPath, rb.originalBytes);
        }
      } catch {
        // Best-effort rollback; the thrown PatchApplyError still carries
        // the original failure details for the operator.
      }
    }
    throw err;
  }
}

async function applyReplaceInFile(
  projectRoot: string,
  edit: ReplaceInFileEdit,
  editIndex: number,
  rollback: Array<FileRollbackEntry | RomRollbackEntry>,
): Promise<ReplaceInFileEdit> {
  // Agent edits name files relative to the project root, full stop. Check
  // both path flavours: on Linux and macOS 'C:\Windows\...' is otherwise a
  // legal relative filename, and an absolute path that happens to land
  // inside the root would otherwise pass the containment check below.
  if (path.posix.isAbsolute(edit.filePath) || path.win32.isAbsolute(edit.filePath)) {
    throw new PatchApplyError(
      'unsafe_path',
      editIndex,
      edit.filePath,
      `Edit path '${edit.filePath}' is absolute; edits must be relative to the project root.`,
    );
  }
  const absPath = path.resolve(projectRoot, edit.filePath);
  const rel = path.relative(projectRoot, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PatchApplyError(
      'unsafe_path',
      editIndex,
      edit.filePath,
      `Edit path '${edit.filePath}' resolves outside the project root.`,
    );
  }
  // The check above is lexical and cannot see symbolic links. A project on
  // disk (a cloned decomp repo, say) can contain a link whose target lies
  // outside the root; reading and writing through it would edit that file
  // instead. Repeat the containment check on the real paths. A file that
  // does not exist is left for the read below to report.
  const realTarget = await fsp.realpath(absPath).catch(() => undefined);
  if (realTarget !== undefined) {
    const realRoot = await fsp.realpath(projectRoot).catch(() => projectRoot);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new PatchApplyError(
        'unsafe_path',
        editIndex,
        edit.filePath,
        `Edit path '${edit.filePath}' leaves the project root through a symbolic link.`,
      );
    }
  }
  let content: string;
  try {
    content = await fsp.readFile(absPath, 'utf8');
  } catch (e) {
    throw new PatchApplyError(
      'file_not_found',
      editIndex,
      edit.filePath,
      `Could not read '${edit.filePath}': ${(e as Error).message}`,
    );
  }
  const firstIdx = content.indexOf(edit.before);
  if (firstIdx === -1) {
    throw new PatchApplyError(
      'before_not_found',
      editIndex,
      edit.filePath,
      `Before-text not found in '${edit.filePath}'. The file may have changed since the proposal was made.`,
    );
  }
  const secondIdx = content.indexOf(edit.before, firstIdx + edit.before.length);
  if (secondIdx !== -1) {
    throw new PatchApplyError(
      'before_ambiguous',
      editIndex,
      edit.filePath,
      `Before-text appears more than once in '${edit.filePath}'. Edits must match exactly one occurrence; widen the before context to disambiguate.`,
    );
  }
  rollback.push({ kind: 'file', absPath, originalContent: content });
  const next =
    content.slice(0, firstIdx) + edit.after + content.slice(firstIdx + edit.before.length);
  try {
    await fsp.writeFile(absPath, next, 'utf8');
  } catch (e) {
    throw new PatchApplyError(
      'write_failed',
      editIndex,
      edit.filePath,
      `Failed to write '${edit.filePath}': ${(e as Error).message}`,
    );
  }
  return {
    kind: 'replace_in_file',
    filePath: edit.filePath,
    before: edit.after,
    after: edit.before,
    note: edit.note ? `undo of: ${edit.note}` : 'undo',
  };
}

function applyBinaryReplaceText(
  edit: BinaryReplaceTextEdit,
  editIndex: number,
  buffer: Buffer,
): BinaryReplaceTextEdit {
  const maxBytes = edit.maxBytes ?? DEFAULT_MAX_BYTES;
  if (edit.textOffset < 0 || edit.textOffset >= buffer.length) {
    throw new PatchApplyError(
      'rom_offset_out_of_range',
      editIndex,
      'rom.gba',
      `Text offset 0x${edit.textOffset.toString(16)} is outside the ROM (length 0x${buffer.length.toString(16)}).`,
    );
  }
  // Decode the on-disk bytes; validate against the agent's `before`.
  const decoded = text.decodeString(buffer, edit.textOffset, maxBytes);
  if (decoded !== edit.before) {
    throw new PatchApplyError(
      'before_not_found',
      editIndex,
      'rom.gba',
      `At ROM offset 0x${edit.textOffset.toString(16)}, expected "${edit.before}" but found "${decoded}".`,
    );
  }
  // Resolve the slot byte length. When the edit provides `slotBytes`
  // explicitly (e.g. a reverseEdit emitted by a prior forward apply),
  // use it as-is so a shorter-than-original on-disk string can grow
  // back to its original length. Otherwise discover by walking to the
  // first 0xFF terminator (inclusive).
  let slotBytes = edit.slotBytes;
  if (slotBytes === undefined) {
    let walked = 0;
    while (
      walked < maxBytes &&
      edit.textOffset + walked < buffer.length
    ) {
      const b = buffer[edit.textOffset + walked]!;
      walked += 1;
      if (b === STRING_TERMINATOR) break;
    }
    slotBytes = walked;
  } else {
    if (edit.textOffset + slotBytes > buffer.length) {
      throw new PatchApplyError(
        'rom_offset_out_of_range',
        editIndex,
        'rom.gba',
        `Slot at offset 0x${edit.textOffset.toString(16)} length ${slotBytes} runs past end of ROM (length 0x${buffer.length.toString(16)}).`,
      );
    }
  }
  // Encode the replacement.
  let encoded: Uint8Array;
  try {
    encoded = text.encodeString(edit.after);
  } catch (e) {
    throw new PatchApplyError(
      'encode_failed',
      editIndex,
      'rom.gba',
      `Cannot encode "${edit.after}" to Gen-3 text: ${(e as Error).message}`,
    );
  }
  if (encoded.length + 1 > slotBytes) {
    throw new PatchApplyError(
      'after_too_long',
      editIndex,
      'rom.gba',
      `After-text "${edit.after}" encodes to ${encoded.length} + 1 bytes; slot is ${slotBytes} bytes. AI-1.4a supports same-length or shorter only - longer replacements need free-space allocation (AI-1.4b).`,
    );
  }
  // Write encoded bytes + terminator + 0xFF padding for the rest of
  // the slot. The decoder stops at the first terminator, so padding
  // is purely defensive against later misaligned reads.
  for (let j = 0; j < encoded.length; j++) {
    buffer[edit.textOffset + j] = encoded[j]!;
  }
  buffer[edit.textOffset + encoded.length] = STRING_TERMINATOR;
  for (let j = encoded.length + 1; j < slotBytes; j++) {
    buffer[edit.textOffset + j] = STRING_TERMINATOR;
  }
  return {
    kind: 'binary_replace_text',
    textOffset: edit.textOffset,
    before: edit.after,
    after: edit.before,
    maxBytes: edit.maxBytes,
    // Lock the slot size in the reverseEdit so the same physical slot
    // is restored regardless of the now-padded on-disk state.
    slotBytes,
    note: edit.note ? `undo of: ${edit.note}` : 'undo',
  };
}

function applyBinaryWriteText(
  edit: BinaryWriteTextEdit,
  editIndex: number,
  buffer: Buffer,
): BinaryWriteTextEdit {
  // Encode the target text first so we know how many bytes we need.
  let encoded: Uint8Array;
  try {
    encoded = text.encodeString(edit.after);
  } catch (e) {
    throw new PatchApplyError(
      'encode_failed',
      editIndex,
      'rom.gba',
      `Cannot encode "${edit.after}" to Gen-3 text: ${(e as Error).message}`,
    );
  }
  // Resolve slot byte length.
  let slotBytes: number;
  if (edit.slotBytes !== undefined) {
    slotBytes = edit.slotBytes;
  } else if (edit.before === '') {
    slotBytes = encoded.length + 1;
  } else {
    let walked = 0;
    while (walked < DEFAULT_MAX_BYTES && edit.offset + walked < buffer.length) {
      const b = buffer[edit.offset + walked]!;
      walked += 1;
      if (b === STRING_TERMINATOR) break;
    }
    slotBytes = walked;
  }
  if (edit.offset < 0 || edit.offset + slotBytes > buffer.length) {
    throw new PatchApplyError(
      'rom_offset_out_of_range',
      editIndex,
      'rom.gba',
      `Slot at offset 0x${edit.offset.toString(16)} length ${slotBytes} runs past end of ROM (length 0x${buffer.length.toString(16)}).`,
    );
  }
  // Validate the slot's current contents.
  if (edit.before === '') {
    // Free-space mode: every byte in the slot must currently be a fill byte.
    if (edit.requireFreeSlot !== false) {
      for (let j = 0; j < slotBytes; j++) {
        const b = buffer[edit.offset + j]!;
        if (b !== 0xff && b !== 0x00) {
          throw new PatchApplyError(
            'slot_not_free',
            editIndex,
            'rom.gba',
            `Free-space write at offset 0x${edit.offset.toString(16)} found non-fill byte 0x${b.toString(16).padStart(2, '0')} at relative position ${j}. The agent's free-space pick is stale; the slot has been claimed by another change.`,
          );
        }
      }
    }
  } else {
    const decoded = text.decodeString(buffer, edit.offset, slotBytes);
    if (decoded !== edit.before) {
      throw new PatchApplyError(
        'before_not_found',
        editIndex,
        'rom.gba',
        `At ROM offset 0x${edit.offset.toString(16)}, expected "${edit.before}" but found "${decoded}".`,
      );
    }
  }
  if (encoded.length + 1 > slotBytes) {
    throw new PatchApplyError(
      'after_too_long',
      editIndex,
      'rom.gba',
      `After-text "${edit.after}" encodes to ${encoded.length} + 1 bytes; slot at offset 0x${edit.offset.toString(16)} is ${slotBytes} bytes.`,
    );
  }
  // Write the encoded text + terminator + 0xFF padding for the rest.
  for (let j = 0; j < encoded.length; j++) buffer[edit.offset + j] = encoded[j]!;
  buffer[edit.offset + encoded.length] = STRING_TERMINATOR;
  for (let j = encoded.length + 1; j < slotBytes; j++) {
    buffer[edit.offset + j] = STRING_TERMINATOR;
  }
  return {
    kind: 'binary_write_text',
    offset: edit.offset,
    before: edit.after,
    after: edit.before,
    slotBytes,
    // The reverse edit knows the slot was already populated, so don't
    // re-check the "free" guard.
    requireFreeSlot: false,
    note: edit.note ? `undo of: ${edit.note}` : 'undo',
  };
}

function applyBinaryRewritePointer(
  edit: BinaryRewritePointerEdit,
  editIndex: number,
  buffer: Buffer,
): BinaryRewritePointerEdit {
  if (edit.pointerOffset < 0 || edit.pointerOffset + 4 > buffer.length) {
    throw new PatchApplyError(
      'rom_offset_out_of_range',
      editIndex,
      'rom.gba',
      `Pointer at 0x${edit.pointerOffset.toString(16)} runs past end of ROM.`,
    );
  }
  const expected = (edit.beforeTargetOffset + GBA_ROM_BASE) >>> 0;
  const actual =
    (buffer[edit.pointerOffset]! |
      (buffer[edit.pointerOffset + 1]! << 8) |
      (buffer[edit.pointerOffset + 2]! << 16) |
      (buffer[edit.pointerOffset + 3]! << 24)) >>>
    0;
  if (actual !== expected) {
    throw new PatchApplyError(
      'pointer_mismatch',
      editIndex,
      'rom.gba',
      `Pointer at 0x${edit.pointerOffset.toString(16)} = 0x${actual.toString(16).padStart(8, '0')}, expected 0x${expected.toString(16).padStart(8, '0')} (file offset 0x${edit.beforeTargetOffset.toString(16)} + GBA mirror).`,
    );
  }
  const newValue = (edit.afterTargetOffset + GBA_ROM_BASE) >>> 0;
  buffer[edit.pointerOffset] = newValue & 0xff;
  buffer[edit.pointerOffset + 1] = (newValue >>> 8) & 0xff;
  buffer[edit.pointerOffset + 2] = (newValue >>> 16) & 0xff;
  buffer[edit.pointerOffset + 3] = (newValue >>> 24) & 0xff;
  return {
    kind: 'binary_rewrite_pointer',
    pointerOffset: edit.pointerOffset,
    beforeTargetOffset: edit.afterTargetOffset,
    afterTargetOffset: edit.beforeTargetOffset,
    note: edit.note ? `undo of: ${edit.note}` : 'undo',
  };
}

function hexToBytes(hex: string): Uint8Array {
  // Phase 2A-2 - normalize whitespace so agent-generated hex like
  // "08 12 34" or "08\n12\n34" works the same as the canonical "081234".
  // The session-1 transcript wasted two round-trips on this.
  const cleaned = hex.replace(/\s+/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error(`hex string has odd length ${cleaned.length}`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = cleaned.charCodeAt(i * 2);
    const lo = cleaned.charCodeAt(i * 2 + 1);
    const byte = (hexNibble(hi) << 4) | hexNibble(lo);
    out[i] = byte;
  }
  return out;
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0..9
  if (code >= 97 && code <= 102) return code - 87; // a..f
  if (code >= 65 && code <= 70) return code - 55; // A..F
  throw new Error(`non-hex char code ${code}`);
}

function bytesToHex(bytes: Uint8Array | Buffer, start = 0, length?: number): string {
  const end = length === undefined ? bytes.length : start + length;
  let s = '';
  for (let i = start; i < end; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

function applyBinaryWriteBytes(
  edit: BinaryWriteBytesEdit,
  editIndex: number,
  buffer: Buffer,
): BinaryWriteBytesEdit {
  let afterBytes: Uint8Array;
  try {
    afterBytes = hexToBytes(edit.afterBytes);
  } catch (e) {
    throw new PatchApplyError(
      'bad_hex',
      editIndex,
      'rom.gba',
      `afterBytes is not valid hex: ${(e as Error).message}`,
    );
  }
  if (afterBytes.length === 0) {
    throw new PatchApplyError(
      'bad_hex',
      editIndex,
      'rom.gba',
      'afterBytes is empty.',
    );
  }
  if (edit.offset < 0 || edit.offset + afterBytes.length > buffer.length) {
    throw new PatchApplyError(
      'rom_offset_out_of_range',
      editIndex,
      'rom.gba',
      `Write at offset 0x${edit.offset.toString(16)} length ${afterBytes.length} runs past end of ROM (length 0x${buffer.length.toString(16)}).`,
    );
  }

  let originalHex: string;
  if (edit.beforeBytes === '') {
    // Free-space mode - slot must currently be fill bytes.
    if (edit.requireFreeSlot !== false) {
      for (let j = 0; j < afterBytes.length; j++) {
        const b = buffer[edit.offset + j]!;
        if (b !== 0xff && b !== 0x00) {
          throw new PatchApplyError(
            'slot_not_free',
            editIndex,
            'rom.gba',
            `Free-space write at offset 0x${edit.offset.toString(16)} found non-fill byte 0x${b
              .toString(16)
              .padStart(2, '0')} at relative position ${j}. The agent's free-space pick is stale; another change has claimed this slot.`,
          );
        }
      }
    }
    // Capture the original (likely all 0xFF/0x00) for the reverseEdit.
    originalHex = bytesToHex(buffer, edit.offset, afterBytes.length);
  } else {
    let beforeBytes: Uint8Array;
    try {
      beforeBytes = hexToBytes(edit.beforeBytes);
    } catch (e) {
      throw new PatchApplyError(
        'bad_hex',
        editIndex,
        'rom.gba',
        `beforeBytes is not valid hex: ${(e as Error).message}`,
      );
    }
    if (beforeBytes.length !== afterBytes.length) {
      throw new PatchApplyError(
        'length_mismatch',
        editIndex,
        'rom.gba',
        `beforeBytes is ${beforeBytes.length} bytes; afterBytes is ${afterBytes.length} bytes. binary_write_bytes v1 requires equal length (same-size replace).`,
      );
    }
    // Validate current on-disk bytes match expected before-bytes.
    for (let j = 0; j < beforeBytes.length; j++) {
      const actual = buffer[edit.offset + j]!;
      const expected = beforeBytes[j]!;
      if (actual !== expected) {
        throw new PatchApplyError(
          'bytes_mismatch',
          editIndex,
          'rom.gba',
          `At ROM offset 0x${(edit.offset + j).toString(16)}, expected 0x${expected
            .toString(16)
            .padStart(2, '0')} but found 0x${actual
            .toString(16)
            .padStart(2, '0')} (relative position ${j} of ${beforeBytes.length}).`,
        );
      }
    }
    originalHex = edit.beforeBytes.toLowerCase();
  }

  // Write the new bytes in place.
  for (let j = 0; j < afterBytes.length; j++) {
    buffer[edit.offset + j] = afterBytes[j]!;
  }

  return {
    kind: 'binary_write_bytes',
    offset: edit.offset,
    // The new on-disk state is what an undo must validate against.
    beforeBytes: bytesToHex(afterBytes),
    // Restore the original bytes on undo.
    afterBytes: originalHex,
    // Reverse is restoring known bytes into a slot we just populated;
    // skip the "is this slot free?" guard.
    requireFreeSlot: false,
    note: edit.note ? `undo of: ${edit.note}` : 'undo',
  };
}

/** Shallow scan of the project root for a `.gba` file. Mirrors
 *  scan/binary-rom.ts's findFirstGbaFile but is duplicated here so
 *  the agent stack doesn't depend on the scan module. */
async function findFirstGbaFile(projectRoot: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return path.join(projectRoot, e.name);
      }
    }
  } catch {
    return null;
  }
  return null;
}
