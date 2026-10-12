import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  LEARNSET_LEVEL_SHIFT,
  LEARNSET_MOVE_MASK,
  LEARNSET_TERMINATOR,
} from './learnset.js';
import { scanLearnsetPointerTable } from './learnset-scanner.js';

const pack = (level: number, move: number): number =>
  ((level & 0x7f) << LEARNSET_LEVEL_SHIFT) | (move & LEARNSET_MOVE_MASK);

/** Plant a learnset array at `at` with the given entries. Returns
 *  the next free byte offset for chaining. */
function plantLearnset(
  buf: Buffer,
  at: number,
  entries: ReadonlyArray<[number, number]>,
): number {
  let cursor = at;
  for (const [lv, mv] of entries) {
    buf.writeUInt16LE(pack(lv, mv), cursor);
    cursor += 2;
  }
  buf.writeUInt16LE(LEARNSET_TERMINATOR, cursor);
  cursor += 2;
  return cursor;
}

describe('scanLearnsetPointerTable - happy paths', () => {
  it('finds an 8-pointer table where each pointer derefs to a valid learnset', () => {
    const buf = Buffer.alloc(0x4000);
    // Pointer table at 0x100. Arrays start at 0x200, packed.
    const tableAt = 0x100;
    let arrayCursor = 0x200;
    const arrayOffsets: number[] = [];
    // 8 learnsets; first must be non-empty (anchor requirement).
    const plans: Array<Array<[number, number]>> = [
      [[1, 33], [7, 73]],
      [[1, 33]],
      [[1, 16], [5, 19]],
      [[1, 10]],
      [[1, 33], [4, 39]],
      [[1, 16]],
      [[1, 1]],
      [[1, 14]],
    ];
    for (const plan of plans) {
      arrayOffsets.push(arrayCursor);
      arrayCursor = plantLearnset(buf, arrayCursor, plan);
    }
    // Plant the pointer table.
    for (let i = 0; i < arrayOffsets.length; i++) {
      buf.writeUInt32LE(
        (GBA_ROM_BASE_ADDRESS + arrayOffsets[i]) >>> 0,
        tableAt + i * 4,
      );
    }
    const r = scanLearnsetPointerTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt);
      expect(r.pointerCount).toBe(8);
      expect(r.populatedEntryCount).toBe(8);
      expect(r.entries[0]?.learnset.entries.length).toBe(2);
      expect(r.entries[0]?.learnset.entries[0]?.move).toBe(33);
    }
  });

  it('table walk terminates on NULL pointer', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x100;
    let arrayCursor = 0x200;
    const arrayOffsets: number[] = [];
    for (let i = 0; i < 8; i++) {
      arrayOffsets.push(arrayCursor);
      arrayCursor = plantLearnset(buf, arrayCursor, [[1, 1 + i]]);
    }
    for (let i = 0; i < 8; i++) {
      buf.writeUInt32LE(
        (GBA_ROM_BASE_ADDRESS + arrayOffsets[i]) >>> 0,
        tableAt + i * 4,
      );
    }
    // Slot 8 is NULL - terminator for the run.
    buf.writeUInt32LE(0, tableAt + 8 * 4);
    const r = scanLearnsetPointerTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.pointerCount).toBe(8);
  });

  it('result + entries are frozen', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0;
    let arrayCursor = 0x200;
    const arrayOffsets: number[] = [];
    for (let i = 0; i < 8; i++) {
      arrayOffsets.push(arrayCursor);
      arrayCursor = plantLearnset(buf, arrayCursor, [[1, 1]]);
    }
    for (let i = 0; i < 8; i++) {
      buf.writeUInt32LE(
        (GBA_ROM_BASE_ADDRESS + arrayOffsets[i]) >>> 0,
        tableAt + i * 4,
      );
    }
    const r = scanLearnsetPointerTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.entries)).toBe(true);
    }
  });

  it('skips empty first-pointer (anchor requires non-empty)', () => {
    // Pointer table with first pointer → empty learnset; second
    // pointer → non-empty learnset. Scanner should anchor at the
    // SECOND pointer, not the first.
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x100;
    const emptyArrayAt = 0x200;
    plantLearnset(buf, emptyArrayAt, []);
    let arrayCursor = 0x300;
    const arrayOffsets: number[] = [];
    for (let i = 0; i < 8; i++) {
      arrayOffsets.push(arrayCursor);
      arrayCursor = plantLearnset(buf, arrayCursor, [[1, 1 + i]]);
    }
    // First entry (empty)
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + emptyArrayAt) >>> 0, tableAt + 0 * 4);
    // Subsequent entries (non-empty)
    for (let i = 0; i < 8; i++) {
      buf.writeUInt32LE(
        (GBA_ROM_BASE_ADDRESS + arrayOffsets[i]) >>> 0,
        tableAt + (i + 1) * 4,
      );
    }
    const r = scanLearnsetPointerTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      // Scanner skipped the first entry → tableStart should be
      // 4 bytes AFTER 0x100 = 0x104, pointing at the first non-empty.
      expect(r.tableStart).toBe(0x104);
      expect(r.pointerCount).toBe(8);
    }
  });

  it('re-attaches the leading empty SPECIES_NONE learnset at a real table boundary', () => {
    // Vanilla layout: species 0 points at an EMPTY learnset; species 1..
    // point at non-empty ones. The anchor lands on species 1; the scanner
    // must re-attach the preceding species-0 slot so entries[i] ==
    // species i. A non-zero byte just before the table marks a real
    // boundary (vs incidental zero-fill).
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x100;
    buf.writeUInt8(0xaa, tableAt - 1); // preceding ROM data
    const emptyArrayAt = 0x200;
    plantLearnset(buf, emptyArrayAt, []); // species 0 → {0xFFFF}
    let arrayCursor = 0x300;
    const arrayOffsets: number[] = [];
    for (let i = 0; i < 8; i++) {
      arrayOffsets.push(arrayCursor);
      arrayCursor = plantLearnset(buf, arrayCursor, [[1, 1 + i]]);
    }
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + emptyArrayAt) >>> 0, tableAt + 0 * 4);
    for (let i = 0; i < 8; i++) {
      buf.writeUInt32LE(
        (GBA_ROM_BASE_ADDRESS + arrayOffsets[i]) >>> 0,
        tableAt + (i + 1) * 4,
      );
    }
    const r = scanLearnsetPointerTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt); // species 0's pointer, not tableAt + 4
      expect(r.entries[0]?.learnset.entries.length).toBe(0); // species 0 = empty
      expect(r.entries[1]?.learnset.entries[0]?.move).toBe(1); // species 1
      expect(r.pointerCount).toBe(9);
      expect(r.populatedEntryCount).toBe(8);
    }
  });
});

describe('scanLearnsetPointerTable - rejection cases', () => {
  it('returns null on pure zero-fill (every u32=0, no valid pointer)', () => {
    expect(scanLearnsetPointerTable(new Uint8Array(0x4000))).toBeNull();
  });

  it('returns null when pointer table run < minPointers', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0;
    let arrayCursor = 0x200;
    const arrayOffsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      arrayOffsets.push(arrayCursor);
      arrayCursor = plantLearnset(buf, arrayCursor, [[1, 1]]);
    }
    for (let i = 0; i < 5; i++) {
      buf.writeUInt32LE(
        (GBA_ROM_BASE_ADDRESS + arrayOffsets[i]) >>> 0,
        tableAt + i * 4,
      );
    }
    // Pointer 5 = NULL terminator. Run = 5 < default min=8.
    buf.writeUInt32LE(0, tableAt + 5 * 4);
    expect(scanLearnsetPointerTable(buf)).toBeNull();
  });

  it('honors minPointers=3 option', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0;
    let arrayCursor = 0x200;
    const arrayOffsets: number[] = [];
    for (let i = 0; i < 3; i++) {
      arrayOffsets.push(arrayCursor);
      arrayCursor = plantLearnset(buf, arrayCursor, [[1, 1 + i]]);
    }
    for (let i = 0; i < 3; i++) {
      buf.writeUInt32LE(
        (GBA_ROM_BASE_ADDRESS + arrayOffsets[i]) >>> 0,
        tableAt + i * 4,
      );
    }
    buf.writeUInt32LE(0, tableAt + 3 * 4);
    const r = scanLearnsetPointerTable(buf, { minPointers: 3 });
    expect(r).not.toBeNull();
    if (r !== null) expect(r.pointerCount).toBe(3);
  });

  it('throws on invalid minPointers=0', () => {
    expect(() =>
      scanLearnsetPointerTable(new Uint8Array(0x1000), { minPointers: 0 }),
    ).toThrow();
  });

  it('throws when maxPointers < minPointers', () => {
    expect(() =>
      scanLearnsetPointerTable(new Uint8Array(0x1000), {
        minPointers: 10,
        maxPointers: 5,
      }),
    ).toThrow();
  });
});
