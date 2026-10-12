import { describe, expect, it } from 'vitest';
import { TMHM_STRUCT_SIZE_BYTES } from './tmhm.js';
import { scanTMHMTable } from './tmhm-scanner.js';

function writeU64(buf: Buffer, at: number, low: number, high: number): void {
  buf.writeUInt32LE(low >>> 0, at + 0);
  buf.writeUInt32LE(high >>> 0, at + 4);
}

function packBits(bits: ReadonlyArray<number>): [number, number] {
  let low = 0, high = 0;
  for (const b of bits) {
    if (b < 32) low |= (1 << b) >>> 0;
    else if (b < 64) high |= (1 << (b - 32)) >>> 0;
  }
  return [low >>> 0, high >>> 0];
}

/** Plant N slots, each with a unique TM bit (cycling i % 50) AND
 *  a shared HM bit (HM07 = index 56). HM07 is in the scanner's
 *  discriminator range [56..63] so the anchor that defeats false
 *  positives from low-bit data (wild-Pokémon slot arrays, opcode
 *  handler bytes, etc.) passes. */
function plantN(buf: Buffer, tableAt: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const tmBit = i % 50; // unique TM per slot
    const [low, high] = packBits([tmBit, 56]); // + HM07
    writeU64(buf, tableAt + i * TMHM_STRUCT_SIZE_BYTES, low, high);
  }
}

describe('scanTMHMTable - happy paths', () => {
  it('finds a 32-slot table (default min) - all populated', () => {
    // After planted slots, trailing zero-fill parses as legitimate
    // empty slots so the scanner walks them too. Slot count grows
    // until either parse failure or max-slots cap.
    const buf = Buffer.alloc(0x2000);
    plantN(buf, 0, 32);
    const r = scanTMHMTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(0);
      expect(r.slotCount).toBeGreaterThanOrEqual(32);
      expect(r.populatedSlotCount).toBe(32); // exactly the planted slots
      // Each planted slot has 2 bits: TM (i%50) + HM07 (56).
      expect(r.slots[0]?.setBitIndices).toEqual([0, 56]);
      expect(r.slots[31]?.setBitIndices).toEqual([31, 56]);
    }
  });

  it('finds a 40-slot table with mixed populated + empty species', () => {
    const buf = Buffer.alloc(0x2000);
    // 12 populated + 28 empty
    plantN(buf, 0, 12);
    // Force termination at slot 40 with corrupt top-6-zero invariant
    const [low, high] = packBits([60]); // bit 60 = reserved
    writeU64(buf, 40 * TMHM_STRUCT_SIZE_BYTES, low, high);
    const r = scanTMHMTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.slotCount).toBe(40);
      expect(r.populatedSlotCount).toBe(12);
    }
  });

  it('walks until parse fails (run terminates on first malformed slot)', () => {
    const buf = Buffer.alloc(0x2000);
    plantN(buf, 0, 40);
    // Slot 40 has reserved bit set
    const [low, high] = packBits([58]);
    writeU64(buf, 40 * TMHM_STRUCT_SIZE_BYTES, low, high);
    const r = scanTMHMTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.slotCount).toBe(40);
  });

  it('result + slots are frozen', () => {
    const buf = Buffer.alloc(0x2000);
    plantN(buf, 0, 32);
    const r = scanTMHMTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.slots)).toBe(true);
    }
  });

  it('skips empty first slot (anchor requires bits set)', () => {
    const buf = Buffer.alloc(0x2000);
    // Slot 0: all-zero (empty); slot 1..32: populated
    plantN(buf, TMHM_STRUCT_SIZE_BYTES, 32);
    // Force a clean termination after slot 32 (relative to its anchor)
    const r = scanTMHMTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(TMHM_STRUCT_SIZE_BYTES);
      expect(r.slotCount).toBeGreaterThanOrEqual(32);
    }
  });

  it('re-attaches the leading empty SPECIES_NONE slot at a real table boundary', () => {
    // Vanilla layout: species 0 is an all-zero (no-TM) slot; species 1..
    // are populated. The anchor lands on species 1; the scanner must
    // re-attach the preceding species-0 slot so slots[i] == species i. A
    // non-zero byte just before the table marks a real boundary (vs
    // incidental zero-fill).
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x100;
    buf.writeUInt8(0xaa, tableAt - 1); // preceding ROM data
    plantN(buf, tableAt + TMHM_STRUCT_SIZE_BYTES, 32);
    const r = scanTMHMTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt); // species 0's slot, not tableAt + 8
      expect(r.slots[0]?.setBitCount).toBe(0); // species 0 = learns no TMs
      expect(r.slots[1]?.setBitIndices).toEqual([0, 56]); // species 1
      expect(r.populatedSlotCount).toBe(32);
    }
  });
});

describe('scanTMHMTable - rejection cases', () => {
  it('rejects pure zero-fill (every slot empty)', () => {
    const buf = Buffer.alloc(0x2000);
    expect(scanTMHMTable(buf)).toBeNull();
  });

  it('returns null when run < minSlots', () => {
    const buf = Buffer.alloc(0x2000);
    plantN(buf, 0, 20);
    // Slot 20 has reserved bit set
    const [low, high] = packBits([58]);
    writeU64(buf, 20 * TMHM_STRUCT_SIZE_BYTES, low, high);
    // Run = 20 < default min=32
    expect(scanTMHMTable(buf)).toBeNull();
  });

  it('returns null when populated count < minPopulatedSlots', () => {
    const buf = Buffer.alloc(0x4000);
    // 32+ slots that all parse (top-6 zero), but only 4 populated
    plantN(buf, 0, 4);
    // Slots 4..32 stay zero (legitimate empties). populatedCount=4 <
    // minPopulatedSlots=8 default
    expect(scanTMHMTable(buf)).toBeNull();
  });

  it('honors minSlots=3 + minPopulatedSlots=1 options', () => {
    const buf = Buffer.alloc(0x2000);
    // Plant 4 slots with TM bits + 1 slot with a discriminator-
    // range bit (TM26 = bit 25) so the scanner's anchor passes.
    for (let i = 0; i < 4; i++) {
      const [low, high] = packBits([i]);
      writeU64(buf, i * TMHM_STRUCT_SIZE_BYTES, low, high);
    }
    const [hmLow, hmHigh] = packBits([25]); // TM26 (in [24..31])
    writeU64(buf, 4 * TMHM_STRUCT_SIZE_BYTES, hmLow, hmHigh);
    // Slot 5 fails (reserved bit)
    const [low, high] = packBits([58]);
    writeU64(buf, 5 * TMHM_STRUCT_SIZE_BYTES, low, high);
    const r = scanTMHMTable(buf, { minSlots: 3, minPopulatedSlots: 1 });
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.slotCount).toBe(5);
      expect(r.populatedSlotCount).toBe(5);
    }
  });

  it('throws on invalid minSlots=0', () => {
    expect(() => scanTMHMTable(new Uint8Array(0x1000), { minSlots: 0 })).toThrow();
  });

  it('throws when maxSlots < minSlots', () => {
    expect(() =>
      scanTMHMTable(new Uint8Array(0x1000), { minSlots: 32, maxSlots: 10 }),
    ).toThrow();
  });

  it('throws on invalid minPopulatedSlots=0', () => {
    expect(() =>
      scanTMHMTable(new Uint8Array(0x1000), { minPopulatedSlots: 0 }),
    ).toThrow();
  });
});
