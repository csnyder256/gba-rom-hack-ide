import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_BLOCK_SIZE_BYTES as BLOCK,
  EVOLUTION_STRUCT_SIZE_BYTES as SLOT,
} from './evolution.js';
import { scanEvolutionTable } from './evolution-scanner.js';

/** Plant a populated evolution slot. */
function plantSlot(
  buf: Buffer,
  at: number,
  method: number,
  param: number,
  targetSpecies: number,
): void {
  buf.writeUInt16LE(method, at + 0x00);
  buf.writeUInt16LE(param, at + 0x02);
  buf.writeUInt16LE(targetSpecies, at + 0x04);
}

/** Plant a per-species evolution block. `evolutions` is the list of
 *  populated slots; remaining slots stay EVO_NONE (all-zero). */
function plantBlock(
  buf: Buffer,
  at: number,
  evolutions: ReadonlyArray<{ method: number; param: number; targetSpecies: number }>,
): void {
  for (let i = 0; i < evolutions.length; i++) {
    const slotAt = at + i * SLOT;
    const e = evolutions[i]!;
    plantSlot(buf, slotAt, e.method, e.param, e.targetSpecies);
  }
}

describe('scanEvolutionTable - happy paths', () => {
  it('finds an 8-block table (default min) with 8 populated species', () => {
    // Note: scanner requires the FIRST block at the candidate to be
    // populated (defeats zero-fill-prefix matching), so plant at
    // offset 0 (no zero-fill prefix can confuse anchoring).
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0;
    for (let i = 0; i < 8; i++) {
      plantBlock(buf, tableAt + i * BLOCK, [
        { method: 4, param: 10 + i, targetSpecies: 100 + i },
      ]);
    }
    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt);
      expect(r.blockCount).toBeGreaterThanOrEqual(8);
      expect(r.populatedBlockCount).toBe(8);
      expect(r.blocks[0]?.populatedSlots[0]?.targetSpecies).toBe(100);
    }
  });

  it('finds a 12-block table with mixed populated + empty species', () => {
    // Plant at offset 0; force termination after block 12 with a
    // malformed block at index 12 (corrupt padding).
    const buf = Buffer.alloc(0x2000);
    for (let i = 0; i < 9; i++) {
      plantBlock(buf, i * BLOCK, [{ method: 4, param: 16, targetSpecies: i + 1 }]);
    }
    // Blocks 9, 10, 11 are all-zero (terminal forms) - within the table.
    // Block 12 has bad padding → scanner stops there.
    buf.writeUInt16LE(0xabcd, 12 * BLOCK + 0x06);
    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.blockCount).toBe(12);
      expect(r.populatedBlockCount).toBe(9);
    }
  });

  it('walks until parse fails (run terminates on first malformed block)', () => {
    const buf = Buffer.alloc(0x2000);
    for (let i = 0; i < 10; i++) {
      plantBlock(buf, i * BLOCK, [{ method: 4, param: 16, targetSpecies: i + 1 }]);
    }
    // Block 10 has bad method
    plantSlot(buf, 10 * BLOCK + 0, 99, 16, 5);
    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.blockCount).toBe(10);
  });

  it('result + blocks are frozen', () => {
    const buf = Buffer.alloc(0x2000);
    for (let i = 0; i < 8; i++) {
      plantBlock(buf, i * BLOCK, [{ method: 4, param: 16, targetSpecies: i + 1 }]);
    }
    const r = scanEvolutionTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.blocks)).toBe(true);
    }
  });

  it('correctly skips zero-fill prefix and anchors at first populated block', () => {
    // Zero-fill at 0..0x100; populated table at 0x100. Without the
    // first-block-must-be-populated filter, scanner would accept
    // tableStart=0 (zero-fill prefix interpreted as empty species
    // blocks). With the filter, it anchors at 0x100.
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x100;
    for (let i = 0; i < 8; i++) {
      plantBlock(buf, tableAt + i * BLOCK, [
        { method: 4, param: 16, targetSpecies: i + 50 },
      ]);
    }
    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt); // not 0
      expect(r.blocks[0]?.populatedSlots[0]?.targetSpecies).toBe(50);
    }
  });

  it('re-attaches the leading SPECIES_NONE (species 0) block at a real table boundary', () => {
    // Vanilla layout: species 0 is an all-zero (no-evolution) block,
    // species 1.. are populated. The anchor lands on species 1; the
    // scanner must re-attach the preceding species-0 block so
    // blocks[i] == species i. A non-zero byte just before the table
    // marks a real table boundary (vs incidental zero-fill).
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x100;
    buf.writeUInt8(0xaa, tableAt - 1); // preceding ROM data
    for (let i = 1; i <= 8; i++) {
      plantBlock(buf, tableAt + i * BLOCK, [
        { method: 4, param: 16, targetSpecies: i + 1 },
      ]);
    }
    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt); // species 0's offset, not tableAt + BLOCK
      expect(r.blocks[0]?.populatedSlots).toEqual([]); // species 0 = no evolutions
      expect(r.blocks[1]?.populatedSlots[0]?.targetSpecies).toBe(2); // species 1 → 2
      expect(r.populatedBlockCount).toBe(8);
    }
  });

  it('does NOT re-attach a leading empty block when it sits in incidental zero-fill', () => {
    // Same as above but the block before the anchor is zero-fill (no
    // real boundary) - it is padding, not a species-0 slot.
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x100;
    for (let i = 1; i <= 8; i++) {
      plantBlock(buf, tableAt + i * BLOCK, [
        { method: 4, param: 16, targetSpecies: i + 1 },
      ]);
    }
    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt + BLOCK);
      expect(r.blocks[0]?.populatedSlots[0]?.targetSpecies).toBe(2);
    }
  });
});

describe('scanEvolutionTable - rejection cases', () => {
  it('rejects pure zero-fill (≥8 blocks parse but populatedBlockCount=0)', () => {
    // 16 KiB of zeros - every 40-byte slice parses as 5 EVO_NONE
    // slots, but no populated species. Scanner must reject.
    const buf = Buffer.alloc(0x4000);
    const r = scanEvolutionTable(buf);
    expect(r).toBeNull();
  });

  it('rejects single-populated run (default min populated = 2)', () => {
    const buf = Buffer.alloc(0x2000);
    // Only 1 populated block among many - should be rejected as
    // "could just be coincidence in noisy ROM bytes."
    plantBlock(buf, 0x100, [{ method: 4, param: 16, targetSpecies: 1 }]);
    // Remaining 8+ blocks all zero
    const r = scanEvolutionTable(buf);
    expect(r).toBeNull();
  });

  it('returns null when run < minBlocks', () => {
    const buf = Buffer.alloc(0x2000);
    for (let i = 0; i < 5; i++) {
      plantBlock(buf, i * BLOCK, [{ method: 4, param: 16, targetSpecies: i + 1 }]);
    }
    // Block 5 has bad method
    plantSlot(buf, 5 * BLOCK + 0, 99, 16, 5);
    expect(scanEvolutionTable(buf)).toBeNull();
  });

  it('honors minBlocks=3 option', () => {
    const buf = Buffer.alloc(0x2000);
    for (let i = 0; i < 3; i++) {
      plantBlock(buf, i * BLOCK, [{ method: 4, param: 16, targetSpecies: i + 1 }]);
    }
    plantSlot(buf, 3 * BLOCK + 0, 99, 16, 5);
    const r = scanEvolutionTable(buf, { minBlocks: 3 });
    expect(r).not.toBeNull();
    if (r !== null) expect(r.blockCount).toBe(3);
  });

  it('honors minPopulatedBlocks=1 option', () => {
    const buf = Buffer.alloc(0x2000);
    // First block populated, 7 more empty, then force termination.
    plantBlock(buf, 0, [{ method: 4, param: 16, targetSpecies: 1 }]);
    plantSlot(buf, 8 * BLOCK + 0x06, 0xff, 0, 0); // corrupt padding at block 8
    // Actually just write garbage to block 8 to force termination
    buf.writeUInt16LE(0xabcd, 8 * BLOCK + 0x06); // bad padding
    const r = scanEvolutionTable(buf, { minPopulatedBlocks: 1 });
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.populatedBlockCount).toBe(1);
      expect(r.blockCount).toBe(8);
    }
  });

  it('throws on invalid minBlocks=0', () => {
    expect(() => scanEvolutionTable(new Uint8Array(0x1000), { minBlocks: 0 })).toThrow();
  });

  it('throws when maxBlocks < minBlocks', () => {
    expect(() =>
      scanEvolutionTable(new Uint8Array(0x1000), {
        minBlocks: 10,
        maxBlocks: 5,
      }),
    ).toThrow();
  });

  it('throws on invalid minPopulatedBlocks=0', () => {
    expect(() =>
      scanEvolutionTable(new Uint8Array(0x1000), { minPopulatedBlocks: 0 }),
    ).toThrow();
  });
});
