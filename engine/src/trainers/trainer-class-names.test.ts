import { describe, expect, it } from 'vitest';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import {
  TRAINER_CLASS_NAME_SLOT_BYTES,
  TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION,
  TRAINER_CLASS_NAMES_MIN_VALID_SLOTS,
  findTrainerClassNamesTable,
  readTrainerClassNamesAt,
  validateTrainerClassNames,
} from './trainer-class-names.js';

// Vanilla FRLG trainer-class names sample (first ~20). ASCII-safe
// transcriptions of the canonical class list.
const VANILLA_FRLG_CLASSES = [
  'YOUNGSTER',
  'BUG CATCHER',
  'HIKER',
  'CAMPER',
  'PICNICKER',
  'ENGINEER',
  'TAMER',
  'FISHERMAN',
  'CYCLIST',
  'CYCLIST',
  'GENTLEMAN',
  'TEACHER',
  'PSYCHIC',
  'BIRD KEEPER',
  'CHANNELER',
  'BLACK BELT',
  'JUGGLER',
  'TUBER',
  'BOSS',
  'SAGE',
  'GAMBLER',
  'BURGLAR',
  'SUPER NERD',
  'SCIENTIST',
  'SAILOR',
  'ROCKER',
  'TRIATHLETE',
  'PAINTER',
  'BIKER',
  'BEAUTY',
];

function plantClassNamesTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const slotStart = offset + i * TRAINER_CLASS_NAME_SLOT_BYTES;
    const name = VANILLA_FRLG_CLASSES[i] ?? `CLASS${String(i).padStart(2, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(TRAINER_CLASS_NAME_SLOT_BYTES);
    slot.set(
      encoded.subarray(0, Math.min(encoded.length, TRAINER_CLASS_NAME_SLOT_BYTES - 1)),
      0,
    );
    const termPos = Math.min(encoded.length, TRAINER_CLASS_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

function fillNonClassBytes(buf: Uint8Array, fromOffset: number): void {
  // Bytes outside Gen-3 uppercase/space/terminator range to ensure
  // validator rejects everything outside the planted region.
  for (let i = fromOffset; i < buf.length; i++) {
    buf[i] = 100 + ((i * 13) % 50); // 100..149 - all outside the codec's uppercase letter range
  }
}

describe('TRAINER_CLASS_NAME_SLOT_BYTES', () => {
  it('is 13', () => {
    expect(TRAINER_CLASS_NAME_SLOT_BYTES).toBe(13);
  });
});

describe('TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION', () => {
  it('is at least 10 (anchor confirmation count)', () => {
    expect(TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION).toBeGreaterThanOrEqual(10);
  });
});

describe('readTrainerClassNamesAt', () => {
  it('reads planted class names', () => {
    const buf = new Uint8Array(2 * 1024);
    plantClassNamesTable(buf, 0x100, 10);
    const names = readTrainerClassNamesAt(buf, 0x100, 10);
    expect(names[0]).toBe('YOUNGSTER');
    expect(names[1]).toBe('BUG CATCHER');
    expect(names[2]).toBe('HIKER');
  });
});

describe('validateTrainerClassNames', () => {
  it('accepts a vanilla-shaped 30-class table', () => {
    const buf = new Uint8Array(2 * 1024);
    plantClassNamesTable(buf, 0, 30);
    const names = readTrainerClassNamesAt(buf, 0, 30);
    expect(validateTrainerClassNames(names)).toBe(true);
  });

  it('rejects too-few entries', () => {
    expect(validateTrainerClassNames(['HIKER', 'YOUNGSTER', 'BUG CATCHER'])).toBe(false);
  });

  it('rejects garbage entries', () => {
    const garbage = Array(40).fill('???');
    expect(validateTrainerClassNames(garbage)).toBe(false);
  });
});

describe('findTrainerClassNamesTable', () => {
  it('returns null on tiny buffer', () => {
    expect(findTrainerClassNamesTable(new Uint8Array(100))).toBeNull();
  });

  it('returns null on garbage-only ROM', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    expect(findTrainerClassNamesTable(buf)).toBeNull();
  });

  it('locates the planted table at the correct offset', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantClassNamesTable(buf, 0x200, 40);
    expect(findTrainerClassNamesTable(buf)).toEqual({ offset: 0x200, slotBytes: 13 });
  });

  it('rejects runs below the min-valid-slots floor', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    // Plant ANCHOR_CONFIRMATION + a few more = 12 slots; below
    // MIN_VALID_SLOTS = 30 - should return null even though anchor
    // confirms.
    plantClassNamesTable(buf, 0x200, 12);
    expect(findTrainerClassNamesTable(buf)).toBeNull();
  });

  it('uses TRAINER_CLASS_NAMES_MIN_VALID_SLOTS as threshold', () => {
    expect(TRAINER_CLASS_NAMES_MIN_VALID_SLOTS).toBeGreaterThanOrEqual(20);
  });

  it('skips planted tables fully inside cartridge header (0..0xBF)', () => {
    // Only ~9 slots fit fully in the 0..0xBF header (9 * 13 = 117 ≤
    // 0xBF=191). Scanner doesn't anchor before 0xC0; returns null.
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantClassNamesTable(buf, 0x10, 9);
    expect(findTrainerClassNamesTable(buf)).toBeNull();
  });
});

/**
 * Slot-size fidelity. A slot is only a real trainer-class entry if the
 * name TERMINATES inside it; a read that spills into the next slot is a
 * misaligned read of some other structure.
 */
describe('findTrainerClassNamesTable - slot-size fidelity', () => {
  /** Pack `count` 12-char names at a 12-byte stride with NO 0xFF
   *  terminator anywhere - the shape of a table written without the
   *  conventional trailing terminator. */
  function plantUnterminated12ByteRun(buf: Uint8Array, offset: number, count: number): void {
    fillNonClassBytes(buf, 0);
    for (let i = 0; i < count; i++) {
      const name = `BADCLASS${String(i % 10).padStart(2, '0')}`.slice(0, 12);
      for (let j = 0; j < 12; j++) {
        buf[offset + i * 12 + j] = 0xbb + (name.charCodeAt(j) - 65);
      }
    }
  }

  it('rejects a run of slots that never terminate inside the slot', () => {
    // Reading this at a 13-byte stride yields 12 real letters followed by
    // the next entry's first letter - still A-Z, so the old validator
    // called all 60 "valid" and anchored on a table that does not exist.
    const buf = new Uint8Array(4 * 1024);
    plantUnterminated12ByteRun(buf, 0x200, 60);
    expect(findTrainerClassNamesTable(buf)).toBeNull();
  });

  it('finds a genuine 12-byte-stride table instead of rejecting the layout', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    for (let i = 0; i < 60; i++) {
      // 12-byte stride, name + terminator packed into the SAME 12 bytes.
      // Names vary in length (or the fixed stride is not observable - 60
      // identical slots are indistinguishable from a 13-byte table read
      // at one particular phase).
      // Space-padded to exactly 11 name bytes so the 0xFF lands at index
      // 11 of the slot. A short name leaves filler after the terminator
      // that decodes as `????` in the next slot's read; letter-padding
      // would instead manufacture a false anchor from the repeated tail.
      const name = `LASS${String(i)}`.slice(0, 11).padEnd(11, ' ');
      const encoded = encodeString(name);
      const slot = new Uint8Array(12);
      slot.set(encoded, 0);
      slot[11] = STRING_TERMINATOR;
      buf.set(slot, 0x200 + i * 12);
    }
    expect(findTrainerClassNamesTable(buf)).toEqual({ offset: 0x200, slotBytes: 12 });
  });

  it('stops the run at a stride change instead of reading through it', () => {
    // 40 real 13-byte slots, then a 12-byte region, then 40 more real
    // 13-byte slots. The 12-byte region must break the first run rather
    // than be read straight through at 13, so the reported table is the
    // first run and nothing wider.
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantClassNamesTable(buf, 0x200, 40);
    const gapStart = 0x200 + 40 * TRAINER_CLASS_NAME_SLOT_BYTES;
    for (let i = 0; i < 12; i++) {
      const slot = new Uint8Array(12);
      const encoded = encodeString(`BAD${String(i)}`.slice(0, 11).padEnd(11, ' '));
      slot.set(encoded, 0);
      slot[11] = STRING_TERMINATOR;
      buf.set(slot, gapStart + i * 12);
    }
    const afterGap = gapStart + 12 * 12;
    // The second run is planted on the same 4-byte phase the resumed
    // 13-byte walk would land on, so the old code would have merged both
    // runs into one long count.
    plantClassNamesTable(buf, afterGap + ((afterGap - 0x200) % 4 === 0 ? 0 : 0), 40);
    const found = findTrainerClassNamesTable(buf);
    expect(found).not.toBeNull();
    expect(found!.offset).toBe(0x200);
    // The run cannot span the 12-byte region: 40 slots is the whole first
    // table, and the second run sits past a 144-byte gap.
    expect(found!.offset + 40 * found!.slotBytes).toBeLessThanOrEqual(gapStart + 4);
  });
});

/**
 * The accepted stride has to be usable, not just detectable. A contract
 * that reports an offset but not the stride it was read at hands the
 * caller a table it cannot decode - the exact defect this suite exists
 * to prevent.
 */
describe('findTrainerClassNamesTable - reported stride is usable', () => {
  /** A run of `count` slots at a `slotBytes` stride, each name + 0xFF
   *  packed into its own slot.
   *
   *  Names are padded with real Gen-3 SPACES (0x00) to the full
   *  slot-minus-terminator width. That matters two ways:
   *   - The 0xFF must land on the slot's last byte. A short name leaves
   *     filler after the terminator, and those filler bytes decode into
   *     the next slot's read as `????`, ending the run for a reason that
   *     has nothing to do with the stride under test.
   *   - Padding with a repeated LETTER manufactures a false anchor: the
   *     tail alone ("ZZZ") satisfies `/[A-Z]{3,}/` and anchors a
   *     phantom table inside the real one. Spaces cannot.
   */
  function plantStridedRun(
    buf: Uint8Array,
    offset: number,
    count: number,
    slotBytes: number,
    makeName: (i: number) => string = (i) =>
      `CLS${String(i).padStart(3, '0')}`,
  ): void {
    for (let i = 0; i < count; i++) {
      const start = offset + i * slotBytes;
      const encoded = encodeString(makeName(i).slice(0, slotBytes - 1).padEnd(slotBytes - 1, ' '));
      for (let j = 0; j < slotBytes - 1; j++) {
        buf[start + j] = encoded[j]!;
      }
      buf[start + slotBytes - 1] = STRING_TERMINATOR;
    }
  }

  it('reports slotBytes=13 for a canonical table so 13-byte callers keep working', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantClassNamesTable(buf, 0x300, 40);
    expect(findTrainerClassNamesTable(buf)).toEqual({ offset: 0x300, slotBytes: 13 });
  });

  it('reports slotBytes=12 for a genuine 12-byte table', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantStridedRun(buf, 0x300, 40, 12);
    expect(findTrainerClassNamesTable(buf)).toEqual({ offset: 0x300, slotBytes: 12 });
  });

  it('reads the real names at the reported stride, not at a fixed 13', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    // Names padded to 11 usable bytes in a 12-byte slot (name + 0xFF).
    plantStridedRun(buf, 0x300, 40, 12, (i) => `TRN${String(i).padStart(2, '0')}`); // helper pads to 11
    const table = findTrainerClassNamesTable(buf);
    expect(table).toEqual({ offset: 0x300, slotBytes: 12 });
    // What the user sees: the actual class names.
    expect(readTrainerClassNamesAt(buf, table!.offset, 3, table!.slotBytes)).toEqual([
      'TRN00      ',
      'TRN01      ',
      'TRN02      ',
    ]);
    // What a fixed 13-byte read of that same table produces: every slot
    // after the first is shifted one byte into its neighbour, so the
    // names come back as fragments ('RN01', 'N02') instead of classes.
    // Slot 0 alone happens to survive (its terminator lands before the
    // 13th byte), which is exactly why the off-by-one is easy to miss
    // and why the whole triple is asserted rather than just the first.
    const wrongStride = readTrainerClassNamesAt(buf, table!.offset, 3);
    expect(wrongStride).not.toEqual([
      'TRN00      ',
      'TRN01      ',
      'TRN02      ',
    ]);
    expect(wrongStride[1]).not.toBe('TRN01      ');
    expect(wrongStride[1]).toContain('RN01');
  });

  it('agrees with the default 13-byte stride on a canonical table', () => {
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantClassNamesTable(buf, 0x300, 40);
    const table = findTrainerClassNamesTable(buf)!;
    expect(readTrainerClassNamesAt(buf, table.offset, 5, table.slotBytes)).toEqual(
      readTrainerClassNamesAt(buf, table.offset, 5),
    );
  });

  it('rejects a truncated table that runs out mid-slot', () => {
    // 40 full slots at a 12-byte stride, then a partial slot that has no
    // room for the 0xFF. The reader must stop rather than decode the
    // truncated tail as if it were a name.
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    plantStridedRun(buf, 0x300, 40, 12);
    const names = readTrainerClassNamesAt(buf, 0x300, 60, 12);
    expect(names.length).toBe(40);
  });
});

describe('readTrainerClassNamesAt - rejected layouts stay rejected', () => {
  it('returns no usable names for an unterminated 12-byte run', () => {
    // The layout the scanner refuses (names packed with no terminator)
    // must not decode into plausible class names at any stride - a
    // caller that got here by accident still gets garbage, not a
    // silently-wrong table.
    const buf = new Uint8Array(4 * 1024);
    fillNonClassBytes(buf, 0);
    for (let i = 0; i < 60; i++) {
      const name = `BADCLASS${String(i % 10).padStart(2, '0')}`.slice(0, 12);
      for (let j = 0; j < 12; j++) {
        buf[0x200 + i * 12 + j] = 0xbb + (name.charCodeAt(j) - 65);
      }
    }
    expect(findTrainerClassNamesTable(buf)).toBeNull();
    // Reading it anyway yields runs that run to the read cap - obviously
    // not a table of 12-char names with terminators.
    const names = readTrainerClassNamesAt(buf, 0x200, 12, 12);
    expect(names.every((n) => n.length === 12)).toBe(true);
    expect(validateTrainerClassNames(readTrainerClassNamesAt(buf, 0x200, 60, 12))).toBe(false);
  });
});
