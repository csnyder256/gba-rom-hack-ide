import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_BLOCK_SIZE_BYTES,
  EVOLUTION_METHOD_MAX,
  EVOLUTION_SLOTS_PER_SPECIES,
  EVOLUTION_SPECIES_MAX,
  EVOLUTION_STRUCT_SIZE_BYTES,
  EVO_NONE,
  encodeEvolutionBlock,
  parseEvolutionBlock,
  parseEvolutionSlot,
} from './evolution.js';

function makeBuf(size = 0x1000): Buffer {
  return Buffer.alloc(size);
}

/** Plant a populated evolution slot (method, param, targetSpecies). */
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

describe('parseEvolutionSlot - happy paths', () => {
  it('parses a populated slot (EVO_LEVEL @ 16 → species 1)', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 1);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evolution.method).toBe(4);
      expect(r.evolution.param).toBe(16);
      expect(r.evolution.targetSpecies).toBe(1);
      expect(r.evolution.isEmpty).toBe(false);
      expect(r.evolution.fileOffset).toBe(0x100);
    }
  });

  it('parses an empty EVO_NONE slot (all-zero)', () => {
    const buf = makeBuf();
    // All-zero - should parse as EVO_NONE
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evolution.method).toBe(EVO_NONE);
      expect(r.evolution.isEmpty).toBe(true);
      expect(r.evolution.targetSpecies).toBe(0);
    }
  });

  it('parses high method codes up to MAX', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, EVOLUTION_METHOD_MAX, 100, 50);
    expect(parseEvolutionSlot(buf, 0x100).ok).toBe(true);
  });

  it('result slot is frozen', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 1);
    const r = parseEvolutionSlot(buf, 0x100);
    if (r.ok) expect(Object.isFrozen(r.evolution)).toBe(true);
  });
});

describe('parseEvolutionSlot - failure modes', () => {
  it('fails too_short when buffer < 6 bytes', () => {
    const r = parseEvolutionSlot(new Uint8Array(4), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_method when method > MAX', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, EVOLUTION_METHOD_MAX + 1, 16, 1);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_method');
  });

  it('fails implausible_species when targetSpecies > MAX', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, EVOLUTION_SPECIES_MAX + 1);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_species');
  });

  it('fails malformed_empty_slot when method=EVO_NONE but param or targetSpecies != 0', () => {
    const buf = makeBuf();
    // method=0 (EVO_NONE) but with nonzero param
    plantSlot(buf, 0x100, 0, 5, 0);
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed_empty_slot');
  });

  it('fails malformed_empty_slot when method != EVO_NONE but targetSpecies = 0', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 0); // EVO_LEVEL but no target
    const r = parseEvolutionSlot(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed_empty_slot');
  });
});

describe('parseEvolutionBlock - happy paths', () => {
  it('parses all-empty block (every slot EVO_NONE)', () => {
    const buf = makeBuf();
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.slots.length).toBe(5);
      expect(r.block.populatedSlots.length).toBe(0);
    }
  });

  it('parses single-evolution block (slot 0 populated, rest empty)', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100 + 0 * EVOLUTION_STRUCT_SIZE_BYTES, 4, 16, 1);
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.populatedSlots.length).toBe(1);
      expect(r.block.populatedSlots[0]?.targetSpecies).toBe(1);
    }
  });

  it('parses multi-evolution block (branching, e.g. Wurmple-style 2 slots)', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100 + 0 * EVOLUTION_STRUCT_SIZE_BYTES, 11, 7, 14); // EVO_LEVEL_SILCOON → Silcoon
    plantSlot(buf, 0x100 + 1 * EVOLUTION_STRUCT_SIZE_BYTES, 12, 7, 15); // EVO_LEVEL_CASCOON → Cascoon
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.populatedSlots.length).toBe(2);
      expect(r.block.populatedSlots[0]?.method).toBe(11);
      expect(r.block.populatedSlots[1]?.method).toBe(12);
    }
  });

  it('result block + slots are frozen', () => {
    const buf = makeBuf();
    plantSlot(buf, 0x100, 4, 16, 1);
    const r = parseEvolutionBlock(buf, 0x100);
    if (r.ok) {
      expect(Object.isFrozen(r.block)).toBe(true);
      expect(Object.isFrozen(r.block.slots)).toBe(true);
      expect(Object.isFrozen(r.block.populatedSlots)).toBe(true);
    }
  });
});

describe('parseEvolutionBlock - failure modes', () => {
  it('fails too_short when buffer < 30 bytes from offset', () => {
    const r = parseEvolutionBlock(new Uint8Array(20), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails slot_failure with slot index when any slot is malformed', () => {
    const buf = makeBuf();
    // Slot 0 valid, slot 2 has bad method
    plantSlot(buf, 0x100 + 0 * EVOLUTION_STRUCT_SIZE_BYTES, 4, 16, 1);
    plantSlot(buf, 0x100 + 2 * EVOLUTION_STRUCT_SIZE_BYTES, 99, 16, 2); // bad method
    const r = parseEvolutionBlock(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('slot_failure');
      if (r.failure.kind === 'slot_failure') {
        expect(r.failure.slotIndex).toBe(2);
        expect(r.failure.slotFailure.kind).toBe('implausible_method');
      }
    }
  });
});

describe('constants', () => {
  it('struct size = 6, block size = 30, slots per block = 5 (pret layout)', () => {
    // struct Evolution { u16 method; u16 param; u16 targetSpecies; } -
    // three u16s, alignment 2, so 6 bytes with no tail padding, and
    // EVOS_PER_MON = 5 gives a 30-byte per-species block. There is no
    // 0x06 padding field in any Gen-3 family (pokefirered, pokeemerald,
    // pokeruby all agree).
    expect(EVOLUTION_STRUCT_SIZE_BYTES).toBe(6);
    expect(EVOLUTION_SLOTS_PER_SPECIES).toBe(5);
    expect(EVOLUTION_BLOCK_SIZE_BYTES).toBe(30);
  });
  it('METHOD_MAX = 50, SPECIES_MAX = 2048, EVO_NONE = 0', () => {
    expect(EVOLUTION_METHOD_MAX).toBe(50);
    expect(EVOLUTION_SPECIES_MAX).toBe(2048);
    expect(EVO_NONE).toBe(0);
  });
});

describe('encodeEvolutionBlock - writer agrees with the reader', () => {
  it('encodes a 30-byte block with 6-byte slots and round-trips', () => {
    const encoded = encodeEvolutionBlock([
      { method: 4, param: 16, targetSpecies: 2 },
      { method: 7, param: 91, targetSpecies: 3 },
    ]);
    expect(encoded.length).toBe(30);
    // Slot 0 fields land at 0x00/0x02/0x04; slot 1 starts at 0x06.
    expect(Array.from(encoded.slice(0, 6))).toEqual([4, 0, 16, 0, 2, 0]);
    expect(Array.from(encoded.slice(6, 12))).toEqual([7, 0, 91, 0, 3, 0]);
    // Remaining three slots are all-zero EVO_NONE terminators.
    expect(Array.from(encoded.slice(12))).toEqual(new Array(18).fill(0));

    const parsed = parseEvolutionBlock(encoded, 0);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.block.populatedSlots.map((s) => [s.method, s.param, s.targetSpecies])).toEqual([
        [4, 16, 2],
        [7, 91, 3],
      ]);
      expect(parsed.block.slots[2]?.isEmpty).toBe(true);
      expect(parsed.block.fileOffset).toBe(0);
    }
  });

  it('rejects more than EVOS_PER_MON slots', () => {
    expect(() =>
      encodeEvolutionBlock(new Array(6).fill({ method: 4, param: 1, targetSpecies: 2 })),
    ).toThrow();
  });
});
