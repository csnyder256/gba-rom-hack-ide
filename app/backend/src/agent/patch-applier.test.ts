import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { text } from '@rom-introspection/engine';
import { applyEdits, PatchApplyError } from './patch-applier.js';

const STRING_TERMINATOR = 0xff;

/** Build a minimal fake .gba-like buffer: writes Gen-3-encoded text
 *  at known offsets so binary_replace_text edits have something
 *  realistic to point at. */
function buildFakeRom(strings: Array<{ offset: number; text: string }>, totalSize = 4096): Buffer {
  const buf = Buffer.alloc(totalSize, 0x00);
  for (const { offset, text: t } of strings) {
    const encoded = text.encodeString(t);
    for (let i = 0; i < encoded.length; i++) buf[offset + i] = encoded[i]!;
    buf[offset + encoded.length] = STRING_TERMINATOR;
  }
  return buf;
}

describe('applyEdits', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'patch-applier-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function seed(rel: string, content: string): Promise<void> {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }

  async function read(rel: string): Promise<string> {
    return fsp.readFile(path.join(root, rel), 'utf8');
  }

  it('applies a single replace_in_file edit and returns the reverse edit', async () => {
    await seed('data/region.h', 'gMapName_Route1 = "Route 1";\n');
    const result = await applyEdits(root, [
      {
        kind: 'replace_in_file',
        filePath: 'data/region.h',
        before: 'Route 1',
        after: 'Electric Avenue',
      },
    ]);
    expect(result.appliedCount).toBe(1);
    expect(await read('data/region.h')).toBe('gMapName_Route1 = "Electric Avenue";\n');
    expect(result.reverseEdits).toEqual([
      {
        kind: 'replace_in_file',
        filePath: 'data/region.h',
        before: 'Electric Avenue',
        after: 'Route 1',
        note: 'undo',
      },
    ]);
  });

  it('applies multiple edits across multiple files', async () => {
    await seed('a.h', 'foo bar baz');
    await seed('nested/b.h', 'qux quux quuz');
    const result = await applyEdits(root, [
      { kind: 'replace_in_file', filePath: 'a.h', before: 'bar', after: 'BAR' },
      { kind: 'replace_in_file', filePath: 'nested/b.h', before: 'quux', after: 'QUUX' },
    ]);
    expect(result.appliedCount).toBe(2);
    expect(await read('a.h')).toBe('foo BAR baz');
    expect(await read('nested/b.h')).toBe('qux QUUX quuz');
  });

  it('rolls back all prior writes when a later edit fails', async () => {
    await seed('a.h', 'before-text');
    await seed('b.h', 'no-match-here');
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'replace_in_file', filePath: 'a.h', before: 'before-text', after: 'after-text' },
        // This one fails: 'will-not-find' isn't in b.h.
        { kind: 'replace_in_file', filePath: 'b.h', before: 'will-not-find', after: 'x' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught).toBeInstanceOf(PatchApplyError);
    expect(caught?.code).toBe('before_not_found');
    expect(caught?.editIndex).toBe(1);
    expect(caught?.filePath).toBe('b.h');
    // a.h must have been rolled back.
    expect(await read('a.h')).toBe('before-text');
  });

  it('rejects edits whose before-text appears multiple times', async () => {
    await seed('multi.txt', 'Route 1\nRoute 1\n');
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'replace_in_file', filePath: 'multi.txt', before: 'Route 1', after: 'Electric Avenue' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('before_ambiguous');
    expect(await read('multi.txt')).toBe('Route 1\nRoute 1\n');
  });

  it('rejects edits to missing files (file_not_found)', async () => {
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'replace_in_file', filePath: 'does/not/exist.h', before: 'x', after: 'y' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('file_not_found');
  });

  it('rejects path traversal even when proposal-create validation was bypassed', async () => {
    // Force the path to escape root after normalization.
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'replace_in_file', filePath: '../../etc/hosts', before: 'x', after: 'y' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('unsafe_path');
  });

  it('rejects an absolute path even when not escaping root', async () => {
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'replace_in_file', filePath: 'C:\\Windows\\System32\\hosts', before: 'x', after: 'y' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('unsafe_path');
  });

  it('rejects an absolute path that points inside the root, and leaves the file alone', async () => {
    await seed('inside.h', 'Route 1\n');
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'replace_in_file', filePath: path.join(root, 'inside.h'), before: 'Route 1', after: 'Route 2' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('unsafe_path');
    expect(await read('inside.h')).toBe('Route 1\n');
  });

  it('rejects an edit that leaves the root through a symbolic link, and leaves the target alone', async (ctx) => {
    const outside = await fsp.mkdtemp(path.join(tmpdir(), 'patch-applier-outside-'));
    const target = path.join(outside, 'not-yours.h');
    await fsp.writeFile(target, 'Route 1\n', 'utf8');
    try {
      await fsp.symlink(target, path.join(root, 'linked.h'));
    } catch {
      // Creating symbolic links needs extra privileges on some Windows setups.
      await fsp.rm(outside, { recursive: true, force: true });
      ctx.skip();
      return;
    }
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'replace_in_file', filePath: 'linked.h', before: 'Route 1', after: 'Route 2' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('unsafe_path');
    expect(await fsp.readFile(target, 'utf8')).toBe('Route 1\n');
    await fsp.rm(outside, { recursive: true, force: true });
  });

  it('still edits through a symbolic link that stays inside the root', async (ctx) => {
    await seed('real.h', 'Route 1\n');
    try {
      await fsp.symlink(path.join(root, 'real.h'), path.join(root, 'alias.h'));
    } catch {
      ctx.skip();
      return;
    }
    await applyEdits(root, [
      { kind: 'replace_in_file', filePath: 'alias.h', before: 'Route 1', after: 'Route 2' },
    ]);
    expect(await read('real.h')).toBe('Route 2\n');
  });

  it('reverse edits round-trip - applying then undoing leaves the file untouched', async () => {
    const original = 'gFlyText[FLY_ROUTE1] = _("Route 1");\nbattle("Route 1 trainer");\n';
    // Make it unique so the test isolates the single-replace logic; we'll do
    // two passes with disambiguated context to exercise round-trip.
    await seed('region.h', original);
    const forward = await applyEdits(root, [
      {
        kind: 'replace_in_file',
        filePath: 'region.h',
        before: 'gFlyText[FLY_ROUTE1] = _("Route 1");',
        after: 'gFlyText[FLY_ROUTE1] = _("Electric Avenue");',
      },
    ]);
    await applyEdits(root, forward.reverseEdits as ReadonlyArray<typeof forward.reverseEdits[number]>);
    expect(await read('region.h')).toBe(original);
  });
});

describe('applyEdits - binary_replace_text', () => {
  let root: string;
  const ROM_NAME = 'fake.gba';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'patch-applier-bin-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function seedRom(strings: Array<{ offset: number; text: string }>): Promise<void> {
    const buf = buildFakeRom(strings);
    await fsp.writeFile(path.join(root, ROM_NAME), buf);
  }

  async function readRomDecoded(offset: number, maxBytes = 64): Promise<string> {
    const buf = await fsp.readFile(path.join(root, ROM_NAME));
    return text.decodeString(buf, offset, maxBytes);
  }

  it('rewrites a Gen-3 string at the given offset and returns a swapped reverseEdit', async () => {
    await seedRom([{ offset: 0x100, text: 'ROUTE 1' }]);
    const result = await applyEdits(root, [
      {
        kind: 'binary_replace_text',
        textOffset: 0x100,
        before: 'ROUTE 1',
        after: 'LANE 17',
      },
    ]);
    expect(result.appliedCount).toBe(1);
    expect(await readRomDecoded(0x100)).toBe('LANE 17');
    expect(result.reverseEdits[0]).toMatchObject({
      kind: 'binary_replace_text',
      textOffset: 0x100,
      before: 'LANE 17',
      after: 'ROUTE 1',
      slotBytes: 8,
    });
  });

  it('allows shorter replacement and pads the slack with 0xFF terminators', async () => {
    await seedRom([{ offset: 0x500, text: 'ROUTE 1' }]); // 7 chars + 0xFF = 8 bytes
    await applyEdits(root, [
      { kind: 'binary_replace_text', textOffset: 0x500, before: 'ROUTE 1', after: 'R1' },
    ]);
    const buf = await fsp.readFile(path.join(root, ROM_NAME));
    expect(text.decodeString(buf, 0x500, 16)).toBe('R1');
    // Bytes 2..7 should all be 0xFF (the terminator at 2, padding at 3..7).
    for (let i = 2; i < 8; i++) {
      expect(buf[0x500 + i]).toBe(STRING_TERMINATOR);
    }
  });

  it('rejects after-text that encodes longer than the original slot', async () => {
    await seedRom([{ offset: 0x800, text: 'ROUTE 1' }]); // 7 + terminator = 8 bytes
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_replace_text',
          textOffset: 0x800,
          before: 'ROUTE 1',
          after: 'ELECTRIC AVENUE', // 15 chars - definitely too long
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('after_too_long');
    // ROM untouched.
    expect(await readRomDecoded(0x800)).toBe('ROUTE 1');
  });

  it('rejects when on-disk bytes do not decode to before', async () => {
    await seedRom([{ offset: 0x200, text: 'PALLET TOWN' }]);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'binary_replace_text', textOffset: 0x200, before: 'ROUTE 1', after: 'PATH A' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('before_not_found');
    // ROM untouched.
    expect(await readRomDecoded(0x200)).toBe('PALLET TOWN');
  });

  it('rejects offsets outside the ROM', async () => {
    await seedRom([{ offset: 0x100, text: 'X' }]);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'binary_replace_text', textOffset: 0xfffffff, before: 'X', after: 'Y' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('rom_offset_out_of_range');
  });

  it('returns rom_not_found when no .gba exists in the project root', async () => {
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        { kind: 'binary_replace_text', textOffset: 0x100, before: 'X', after: 'Y' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('rom_not_found');
  });

  it('creates a .bak on first apply, reuses it on subsequent applies', async () => {
    await seedRom([{ offset: 0x100, text: 'A' }, { offset: 0x200, text: 'B' }]);
    await applyEdits(root, [
      { kind: 'binary_replace_text', textOffset: 0x100, before: 'A', after: 'C' },
    ]);
    expect(await fsp.access(path.join(root, `${ROM_NAME}.bak`))).toBeUndefined();
    // Re-apply: .bak must not be overwritten (it should still hold the
    // ORIGINAL pre-first-edit state).
    const bak1 = await fsp.readFile(path.join(root, `${ROM_NAME}.bak`));
    await applyEdits(root, [
      { kind: 'binary_replace_text', textOffset: 0x200, before: 'B', after: 'D' },
    ]);
    const bak2 = await fsp.readFile(path.join(root, `${ROM_NAME}.bak`));
    expect(bak1.equals(bak2)).toBe(true);
    expect(text.decodeString(bak1, 0x100, 8)).toBe('A');
    expect(text.decodeString(bak1, 0x200, 8)).toBe('B');
  });

  it('round-trip: apply forward then reverseEdits restores original bytes', async () => {
    await seedRom([{ offset: 0x300, text: 'ROUTE 5' }]); // 7 + 0xFF = 8 bytes
    const originalBuf = await fsp.readFile(path.join(root, ROM_NAME));
    const forward = await applyEdits(root, [
      { kind: 'binary_replace_text', textOffset: 0x300, before: 'ROUTE 5', after: 'R5' },
    ]);
    expect(await readRomDecoded(0x300)).toBe('R5');
    await applyEdits(root, forward.reverseEdits);
    expect(await readRomDecoded(0x300)).toBe('ROUTE 5');
    // Compare the relevant slot bytes (the .bak path is the same so the
    // file should be byte-identical to the pre-edit state).
    const restoredBuf = await fsp.readFile(path.join(root, ROM_NAME));
    for (let i = 0x300; i < 0x308; i++) {
      expect(restoredBuf[i]).toBe(originalBuf[i]);
    }
  });

  it('binary_write_text into free space writes encoded bytes + reverse swaps before/after', async () => {
    // Pre-fill ROM with 0xFF (free space) except for a small region.
    const buf = Buffer.alloc(4096, 0xff);
    await fsp.writeFile(path.join(root, ROM_NAME), buf);
    const result = await applyEdits(root, [
      {
        kind: 'binary_write_text',
        offset: 0x100,
        before: '',
        after: 'ELECTRIC AVENUE',
        slotBytes: 16,
      },
    ]);
    expect(result.appliedCount).toBe(1);
    expect(await readRomDecoded(0x100)).toBe('ELECTRIC AVENUE');
    expect(result.reverseEdits[0]).toMatchObject({
      kind: 'binary_write_text',
      offset: 0x100,
      before: 'ELECTRIC AVENUE',
      after: '',
      slotBytes: 16,
      requireFreeSlot: false,
    });
  });

  it('binary_write_text rejects free-space writes when slot is not actually free', async () => {
    await seedRom([{ offset: 0x100, text: 'X' }]); // 0x100 has 'X' + 0xFF
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_write_text',
          offset: 0x100,
          before: '',
          after: 'NEW',
          slotBytes: 4,
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('slot_not_free');
  });

  it('binary_rewrite_pointer rewrites a 4-byte LE pointer + validates expected value', async () => {
    // Seed a buffer with a pointer at 0x40 pointing at 0x100, plus a string at 0x100.
    const buf = Buffer.alloc(4096, 0xff);
    const oldPtr = (0x100 + 0x08000000) >>> 0;
    buf[0x40] = oldPtr & 0xff;
    buf[0x41] = (oldPtr >>> 8) & 0xff;
    buf[0x42] = (oldPtr >>> 16) & 0xff;
    buf[0x43] = (oldPtr >>> 24) & 0xff;
    await fsp.writeFile(path.join(root, ROM_NAME), buf);

    const result = await applyEdits(root, [
      {
        kind: 'binary_rewrite_pointer',
        pointerOffset: 0x40,
        beforeTargetOffset: 0x100,
        afterTargetOffset: 0x200,
      },
    ]);
    expect(result.appliedCount).toBe(1);
    const finalBuf = await fsp.readFile(path.join(root, ROM_NAME));
    const newPtr =
      (finalBuf[0x40]! |
        (finalBuf[0x41]! << 8) |
        (finalBuf[0x42]! << 16) |
        (finalBuf[0x43]! << 24)) >>>
      0;
    expect(newPtr).toBe((0x200 + 0x08000000) >>> 0);
    expect(result.reverseEdits[0]).toMatchObject({
      kind: 'binary_rewrite_pointer',
      pointerOffset: 0x40,
      beforeTargetOffset: 0x200,
      afterTargetOffset: 0x100,
    });
  });

  it('binary_rewrite_pointer fails when current value doesn\'t match beforeTargetOffset', async () => {
    const buf = Buffer.alloc(4096, 0xff);
    await fsp.writeFile(path.join(root, ROM_NAME), buf);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_rewrite_pointer',
          pointerOffset: 0x40,
          beforeTargetOffset: 0x100,
          afterTargetOffset: 0x200,
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('pointer_mismatch');
  });

  it('repointing pair: binary_write_text + binary_rewrite_pointer end-to-end + round-trip', async () => {
    // ROM setup:
    //   - String "ROUTE 1" at 0x100
    //   - Pointer at 0x40 references 0x100 (via GBA mirror)
    //   - Everything else 0xFF (free space)
    const buf = Buffer.alloc(0x4000, 0xff);
    const oldStr = text.encodeString('ROUTE 1');
    for (let i = 0; i < oldStr.length; i++) buf[0x100 + i] = oldStr[i]!;
    buf[0x100 + oldStr.length] = STRING_TERMINATOR;
    const oldPtr = (0x100 + 0x08000000) >>> 0;
    buf[0x40] = oldPtr & 0xff;
    buf[0x41] = (oldPtr >>> 8) & 0xff;
    buf[0x42] = (oldPtr >>> 16) & 0xff;
    buf[0x43] = (oldPtr >>> 24) & 0xff;
    await fsp.writeFile(path.join(root, ROM_NAME), buf);

    // Write "ELECTRIC AVENUE" (15 chars) at 0x2000 (free) + repoint.
    const forward = await applyEdits(root, [
      {
        kind: 'binary_write_text',
        offset: 0x2000,
        before: '',
        after: 'ELECTRIC AVENUE',
        slotBytes: 16,
      },
      {
        kind: 'binary_rewrite_pointer',
        pointerOffset: 0x40,
        beforeTargetOffset: 0x100,
        afterTargetOffset: 0x2000,
      },
    ]);
    expect(forward.appliedCount).toBe(2);
    expect(await readRomDecoded(0x2000)).toBe('ELECTRIC AVENUE');
    // The pointer now references the new location.
    const final = await fsp.readFile(path.join(root, ROM_NAME));
    const ptrAfter =
      (final[0x40]! | (final[0x41]! << 8) | (final[0x42]! << 16) | (final[0x43]! << 24)) >>> 0;
    expect(ptrAfter).toBe((0x2000 + 0x08000000) >>> 0);
    // The ORIGINAL string at 0x100 is untouched (still "ROUTE 1").
    expect(await readRomDecoded(0x100)).toBe('ROUTE 1');

    // Undo: apply reverseEdits in reverse order.
    await applyEdits(root, [...forward.reverseEdits].reverse());
    const restored = await fsp.readFile(path.join(root, ROM_NAME));
    // Pointer back to 0x100.
    const ptrRestored =
      (restored[0x40]! | (restored[0x41]! << 8) | (restored[0x42]! << 16) | (restored[0x43]! << 24)) >>> 0;
    expect(ptrRestored).toBe((0x100 + 0x08000000) >>> 0);
    // The new slot at 0x2000 is "freed" - encoded(''.length=0) = 0 chars; reverse writes
    // a terminator + padding. The slot bytes are no longer non-fill, so future
    // findFreeRomSpace can reclaim them.
    for (let i = 0; i < 16; i++) {
      expect(restored[0x2000 + i]).toBe(STRING_TERMINATOR);
    }
  });

  it('rolls back ROM bytes when a later binary edit fails', async () => {
    await seedRom([
      { offset: 0x100, text: 'GOOD' },
      { offset: 0x200, text: 'TARGET' },
    ]);
    const originalBuf = await fsp.readFile(path.join(root, ROM_NAME));
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        // First: valid edit at 0x100.
        { kind: 'binary_replace_text', textOffset: 0x100, before: 'GOOD', after: 'BAD' },
        // Second: invalid - wrong before-text at 0x200.
        { kind: 'binary_replace_text', textOffset: 0x200, before: 'WRONG', after: 'X' },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('before_not_found');
    // ROM should be byte-identical to original - both edits rolled back.
    const afterBuf = await fsp.readFile(path.join(root, ROM_NAME));
    expect(afterBuf.equals(originalBuf)).toBe(true);
  });
});

describe('applyEdits - binary_write_bytes', () => {
  let root: string;
  const ROM_NAME = 'fake.gba';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'patch-applier-bin-bytes-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function seedRomBytes(
    bytes: Array<{ offset: number; data: number[] }>,
    totalSize = 4096,
    fill = 0xff,
  ): Promise<Buffer> {
    const buf = Buffer.alloc(totalSize, fill);
    for (const { offset, data } of bytes) {
      for (let i = 0; i < data.length; i++) buf[offset + i] = data[i]!;
    }
    await fsp.writeFile(path.join(root, ROM_NAME), buf);
    return buf;
  }

  it('writes raw bytes at offset and returns reverseEdit with swapped before/after', async () => {
    await seedRomBytes([{ offset: 0x100, data: [0x01, 0x02, 0x03, 0x04] }]);
    const result = await applyEdits(root, [
      {
        kind: 'binary_write_bytes',
        offset: 0x100,
        beforeBytes: '01020304',
        afterBytes: 'aabbccdd',
      },
    ]);
    expect(result.appliedCount).toBe(1);
    const after = await fsp.readFile(path.join(root, ROM_NAME));
    expect(after[0x100]).toBe(0xaa);
    expect(after[0x101]).toBe(0xbb);
    expect(after[0x102]).toBe(0xcc);
    expect(after[0x103]).toBe(0xdd);
    expect(result.reverseEdits[0]).toMatchObject({
      kind: 'binary_write_bytes',
      offset: 0x100,
      beforeBytes: 'aabbccdd',
      afterBytes: '01020304',
      requireFreeSlot: false,
    });
  });

  it('accepts uppercase hex on input (applier normalizes to lowercase internally)', async () => {
    await seedRomBytes([{ offset: 0x100, data: [0x0a, 0x0b] }]);
    const result = await applyEdits(root, [
      {
        kind: 'binary_write_bytes',
        offset: 0x100,
        beforeBytes: '0A0B',
        afterBytes: 'CAFE',
      },
    ]);
    const after = await fsp.readFile(path.join(root, ROM_NAME));
    expect(after[0x100]).toBe(0xca);
    expect(after[0x101]).toBe(0xfe);
    // reverseEdit emits lowercase regardless of input casing.
    expect(result.reverseEdits[0]).toMatchObject({
      kind: 'binary_write_bytes',
      beforeBytes: 'cafe',
      afterBytes: '0a0b',
    });
  });

  // Phase 2A-2 - the session-1 transcript wasted two round-trips on
  // stray whitespace in agent-generated hex. The applier now strips
  // all whitespace before parsing.
  it('accepts hex with internal whitespace (spaces, tabs, newlines)', async () => {
    await seedRomBytes([{ offset: 0x100, data: [0x01, 0x02, 0x03, 0x04] }]);
    const result = await applyEdits(root, [
      {
        kind: 'binary_write_bytes',
        offset: 0x100,
        beforeBytes: '01 02 03 04',
        afterBytes: 'aa\tbb\ncc dd',
      },
    ]);
    expect(result.appliedCount).toBe(1);
    const after = await fsp.readFile(path.join(root, ROM_NAME));
    expect(after[0x100]).toBe(0xaa);
    expect(after[0x101]).toBe(0xbb);
    expect(after[0x102]).toBe(0xcc);
    expect(after[0x103]).toBe(0xdd);
  });

  it('free-space mode: writes when the slot is fill bytes', async () => {
    await seedRomBytes([], 4096, 0xff);
    const result = await applyEdits(root, [
      {
        kind: 'binary_write_bytes',
        offset: 0x200,
        beforeBytes: '',
        afterBytes: 'cafebabe',
      },
    ]);
    const after = await fsp.readFile(path.join(root, ROM_NAME));
    expect(after[0x200]).toBe(0xca);
    expect(after[0x201]).toBe(0xfe);
    expect(after[0x202]).toBe(0xba);
    expect(after[0x203]).toBe(0xbe);
    expect(result.reverseEdits[0]).toMatchObject({
      kind: 'binary_write_bytes',
      offset: 0x200,
      beforeBytes: 'cafebabe',
      // Original was 0xFF fill; reverse restores fill.
      afterBytes: 'ffffffff',
    });
  });

  it('rejects when on-disk bytes do not match beforeBytes', async () => {
    await seedRomBytes([{ offset: 0x100, data: [0xde, 0xad, 0xbe, 0xef] }]);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_write_bytes',
          offset: 0x100,
          beforeBytes: '01020304',
          afterBytes: 'aabbccdd',
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('bytes_mismatch');
  });

  it('rejects when beforeBytes and afterBytes have different lengths', async () => {
    await seedRomBytes([{ offset: 0x100, data: [0x01, 0x02] }]);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_write_bytes',
          offset: 0x100,
          beforeBytes: '0102',
          afterBytes: 'aabbccdd',
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('length_mismatch');
  });

  it('rejects free-space write into a non-fill slot', async () => {
    // Slot at 0x100 has a non-fill byte at position 2.
    await seedRomBytes([{ offset: 0x100, data: [0xff, 0xff, 0x42, 0xff] }]);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_write_bytes',
          offset: 0x100,
          beforeBytes: '',
          afterBytes: 'cafebabe',
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('slot_not_free');
  });

  it('rejects offsets that run past end of ROM', async () => {
    await seedRomBytes([{ offset: 0x100, data: [0x01] }]);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_write_bytes',
          offset: 0xfffffff,
          beforeBytes: '',
          afterBytes: 'aa',
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('rom_offset_out_of_range');
  });

  it('rejects bad_hex when afterBytes contains non-hex chars', async () => {
    // Note: zod gates the schema at the route boundary, but the applier
    // defends in depth because reverseEdits (and tests, and any future
    // non-route call path) can still hand it edits directly.
    await seedRomBytes([], 4096, 0xff);
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_write_bytes',
          offset: 0x100,
          beforeBytes: '',
          afterBytes: 'zzzz',
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('bad_hex');
  });

  it('round-trip: apply forward then reverseEdits restores original bytes', async () => {
    const original = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80];
    await seedRomBytes([{ offset: 0x300, data: original }]);
    const originalBuf = await fsp.readFile(path.join(root, ROM_NAME));
    const forward = await applyEdits(root, [
      {
        kind: 'binary_write_bytes',
        offset: 0x300,
        beforeBytes: '1020304050607080',
        afterBytes: 'deadbeefcafef00d',
      },
    ]);
    // Slot now holds new bytes.
    const mid = await fsp.readFile(path.join(root, ROM_NAME));
    expect(mid[0x300]).toBe(0xde);
    expect(mid[0x307]).toBe(0x0d);
    // Undo.
    await applyEdits(root, forward.reverseEdits);
    const restored = await fsp.readFile(path.join(root, ROM_NAME));
    for (let i = 0x300; i < 0x308; i++) {
      expect(restored[i]).toBe(originalBuf[i]);
    }
  });

  it('rolls back ROM bytes when a later binary_write_bytes fails', async () => {
    await seedRomBytes([
      { offset: 0x100, data: [0xaa, 0xbb] },
      { offset: 0x200, data: [0x11, 0x22] },
    ]);
    const originalBuf = await fsp.readFile(path.join(root, ROM_NAME));
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        // First: valid edit at 0x100.
        {
          kind: 'binary_write_bytes',
          offset: 0x100,
          beforeBytes: 'aabb',
          afterBytes: 'ccdd',
        },
        // Second: invalid - wrong beforeBytes at 0x200.
        {
          kind: 'binary_write_bytes',
          offset: 0x200,
          beforeBytes: '9999',
          afterBytes: 'ffff',
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('bytes_mismatch');
    // ROM should be byte-identical to original - both edits rolled back.
    const afterBuf = await fsp.readFile(path.join(root, ROM_NAME));
    expect(afterBuf.equals(originalBuf)).toBe(true);
  });

  it('returns rom_not_found when no .gba exists in the project root', async () => {
    let caught: PatchApplyError | undefined;
    try {
      await applyEdits(root, [
        {
          kind: 'binary_write_bytes',
          offset: 0x100,
          beforeBytes: '00',
          afterBytes: 'aa',
        },
      ]);
    } catch (e) {
      caught = e as PatchApplyError;
    }
    expect(caught?.code).toBe('rom_not_found');
  });

  it('co-applies with other binary edit kinds in one batch', async () => {
    // Set up: text at 0x100 ("ROUTE 1"), raw bytes at 0x200 ([0x01, 0x02, 0x03]).
    const buf = Buffer.alloc(4096, 0xff);
    const encoded = text.encodeString('ROUTE 1');
    for (let i = 0; i < encoded.length; i++) buf[0x100 + i] = encoded[i]!;
    buf[0x100 + encoded.length] = STRING_TERMINATOR;
    buf[0x200] = 0x01;
    buf[0x201] = 0x02;
    buf[0x202] = 0x03;
    await fsp.writeFile(path.join(root, ROM_NAME), buf);

    const result = await applyEdits(root, [
      // Mix all edit kinds - make sure binary_write_bytes plays nicely.
      { kind: 'binary_replace_text', textOffset: 0x100, before: 'ROUTE 1', after: 'LANE 17' },
      { kind: 'binary_write_bytes', offset: 0x200, beforeBytes: '010203', afterBytes: 'aabbcc' },
    ]);
    expect(result.appliedCount).toBe(2);
    const after = await fsp.readFile(path.join(root, ROM_NAME));
    expect(text.decodeString(after, 0x100, 16)).toBe('LANE 17');
    expect(after[0x200]).toBe(0xaa);
    expect(after[0x201]).toBe(0xbb);
    expect(after[0x202]).toBe(0xcc);
  });
});
