import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_BLOCK_SIZE_BYTES as BLOCK,
  EVOLUTION_STRUCT_SIZE_BYTES as SLOT,
} from './evolution.js';
import { scanEvolutionTable } from './evolution-scanner.js';
import { speciesEvolutionsDetector } from '../detectors/species-evolutions.js';

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

// ─────────────────────────────────────────────────────────────────────
// Real-ROM layout regression (2026-10-17).
//
// pret/pokefirered + pret/pokeemerald + pret/pokeruby all define
//
//   struct Evolution { u16 method; u16 param; u16 targetSpecies; };
//
// - three u16s, alignment 2, so sizeof == 6 with no tail padding, and
// `gEvolutionTable[NUM_SPECIES][EVOS_PER_MON]` with EVOS_PER_MON == 5
// makes every per-species block exactly 30 bytes.
//
// The fixture below is built BY HAND from pret's own evolution.h values
// (u16 LE written at a 6-byte stride), deliberately not via any engine
// constant or encoder, so it stays an independent oracle: if the reader
// ever drifts back to the phantom 0x06 padding field / 8-byte slot /
// 40-byte block, these tests fail on data that is byte-for-byte what a
// retail cart contains.
// ─────────────────────────────────────────────────────────────────────

/** Real vanilla FireRed/LeafGreen level-up evolution chains, keyed by
 *  the source species id (0 = SPECIES_NONE sentinel, all-zero block).
 *  Values copied from pret/pokefirered src/data/pokemon/evolution.h. */
const VANILLA_FRLG_CHAINS: ReadonlyArray<
  ReadonlyArray<{ method: number; param: number; targetSpecies: number }>
> = [
  [], // 0  SPECIES_NONE - all-zero sentinel block
  [{ method: 4, param: 16, targetSpecies: 2 }], // 1  Bulbasaur  → Ivysaur
  [{ method: 4, param: 32, targetSpecies: 3 }], // 2  Ivysaur    → Venusaur
  [], // 3  Venusaur
  [{ method: 4, param: 16, targetSpecies: 5 }], // 4  Charmander → Charmeleon
  [{ method: 4, param: 36, targetSpecies: 6 }], // 5  Charmeleon → Charizard
  [], // 6  Charizard
  [{ method: 4, param: 16, targetSpecies: 8 }], // 7  Squirtle   → Wartortle
  [{ method: 4, param: 36, targetSpecies: 9 }], // 8  Wartortle  → Blastoise
  [], // 9  Blastoise
  [{ method: 4, param: 7, targetSpecies: 11 }], // 10 Caterpie   → Metapod
  [{ method: 4, param: 10, targetSpecies: 12 }], // 11 Metapod   → Butterfree
  [], // 12 Butterfree
  [{ method: 4, param: 7, targetSpecies: 14 }], // 13 Weedle     → Kakuna
  [{ method: 4, param: 10, targetSpecies: 15 }], // 14 Kakuna     → Beedrill
  [], // 15 Beedrill
  [{ method: 4, param: 18, targetSpecies: 17 }], // 16 Pidgey     → Pidgeotto
  [{ method: 4, param: 36, targetSpecies: 18 }], // 17 Pidgeotto  → Pidgeot
  [], // 18 Pidgeot
  [{ method: 4, param: 20, targetSpecies: 20 }], // 19 Rattata    → Raticate
  [], // 20 Raticate
  [{ method: 4, param: 20, targetSpecies: 22 }], // 21 Spearow    → Fearow
  [], // 22 Fearow
  [{ method: 4, param: 22, targetSpecies: 24 }], // 23 Ekans      → Arbok
  [], // 24 Arbok
  // 25 Pikachu → Raichu is EVO_ITEM (Thunder Stone) in pret; encoded
  // with its real method 7 and a placeholder stone param (the reader
  // treats param as method-dependent and does not validate it).
  [{ method: 7, param: 1, targetSpecies: 26 }],
  [], // 26 Raichu
  [{ method: 4, param: 22, targetSpecies: 28 }], // 27 Sandshrew  → Sandslash
  [], // 28 Sandslash
  [{ method: 4, param: 16, targetSpecies: 30 }], // 29 Nidoran-F  → Nidorina
  [{ method: 7, param: 1, targetSpecies: 31 }], // 30 Nidorina   → Nidoqueen (Moon Stone)
  [], // 31 Nidoqueen
  [{ method: 4, param: 16, targetSpecies: 33 }], // 32 Nidoran-M  → Nidorino
  [{ method: 7, param: 1, targetSpecies: 34 }], // 33 Nidorino   → Nidoking (Moon Stone)
  [], // 34 Nidoking
];

/** Build the gEvolutionTable byte image at the REAL 6-byte slot /
 *  30-byte block stride. Hand-rolled on purpose (see header comment). */
function buildRealEvolutionTableBytes(
  chains: ReadonlyArray<ReadonlyArray<{ method: number; param: number; targetSpecies: number }>>,
): Buffer {
  const SLOT = 6;
  const BLOCK = 30;
  const out = Buffer.alloc(chains.length * BLOCK);
  for (let species = 0; species < chains.length; species++) {
    const slots = chains[species]!;
    for (let i = 0; i < slots.length; i++) {
      const at = species * BLOCK + i * SLOT;
      const s = slots[i]!;
      out.writeUInt16LE(s.method, at + 0x00);
      out.writeUInt16LE(s.param, at + 0x02);
      out.writeUInt16LE(s.targetSpecies, at + 0x04);
    }
  }
  return out;
}

describe('scanEvolutionTable - real 6-byte-slot / 30-byte-block ROM layout', () => {
  it('finds a table laid out exactly like pret gEvolutionTable', () => {
    const buf = Buffer.alloc(0x4000);
    const tableAt = 0x200;
    buildRealEvolutionTableBytes(VANILLA_FRLG_CHAINS).copy(buf, tableAt);

    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r === null) return;

    // The scanner's anchor requires a POPULATED slot 0, so it lands on
    // species 1 (Bulbasaur) - one 30-byte block past the all-zero
    // SPECIES_NONE sentinel.
    expect(r.tableStart).toBe(tableAt + 30);

    // Species 1's block must carry Bulbasaur's real evolution.
    const bulbasaur = r.blocks[0];
    expect(bulbasaur?.fileOffset).toBe(tableAt + 30);
    expect(bulbasaur?.populatedSlots.map((s) => [s.method, s.param, s.targetSpecies])).toEqual([
      [4, 16, 2],
    ]);

    // Every planted chain must be readable at its real 30-byte stride,
    // addressed from the table start - this is the assertion that fails
    // outright when the reader assumes an 8-byte slot (a phantom 0x06
    // padding word makes every populated block unparseable, and the
    // scanner returns null).
    const byOffset = new Map(r.blocks.map((b) => [b.fileOffset, b]));
    for (let species = 1; species < VANILLA_FRLG_CHAINS.length; species++) {
      const expected = VANILLA_FRLG_CHAINS[species]!;
      const block = byOffset.get(tableAt + species * 30);
      expect(block, `species ${String(species)} block`).toBeDefined();
      expect(
        block?.populatedSlots.map((s) => [s.method, s.param, s.targetSpecies]),
        `species ${String(species)} chains`,
      ).toEqual(expected.map((e) => [e.method, e.param, e.targetSpecies]));
    }

    // 21 of the 35 planted species carry at least one evolution.
    expect(r.populatedBlockCount).toBe(
      VANILLA_FRLG_CHAINS.filter((c) => c.length > 0).length,
    );
  });

  it('does not read a phantom padding word between slots', () => {
    // Two adjacent populated species at the real stride: if the reader
    // consumed a u16 at 0x06 it would read species 2's method as
    // "padding" and reject species 1's block. Assert species 1's slot 1
    // is the EVO_NONE terminator (i.e. it starts at +0x06, not +0x08).
    const buf = Buffer.alloc(0x1000);
    buildRealEvolutionTableBytes(VANILLA_FRLG_CHAINS).copy(buf, 0x100);
    const r = scanEvolutionTable(buf);
    expect(r).not.toBeNull();
    if (r === null) return;
    const bulbasaur = r.blocks.find((b) => b.fileOffset === 0x100 + 30);
    expect(bulbasaur?.slots.length).toBe(5);
    expect(bulbasaur?.slots[1]?.fileOffset).toBe(0x100 + 30 + 6);
    expect(bulbasaur?.slots[1]?.isEmpty).toBe(true);
  });

  it('is detected end-to-end by the species_evolutions detector', () => {
    const buf = Buffer.alloc(0x4000);
    buildRealEvolutionTableBytes(VANILLA_FRLG_CHAINS).copy(buf, 0x200);
    const rom = {
      bytes: new Uint8Array(buf),
      byteLength: buf.length,
      path: 'fixture.gba',
    } as unknown as Parameters<typeof speciesEvolutionsDetector.detect>[0];
    const coverage = { addClassified: () => undefined } as unknown as Parameters<
      typeof speciesEvolutionsDetector.detect
    >[1];
    const detection = speciesEvolutionsDetector.detect(rom, coverage);
    expect(detection.status).toBe('detected');
    if (detection.status === 'detected') {
      expect(detection.data.populatedBlockCount).toBe(
        VANILLA_FRLG_CHAINS.filter((c) => c.length > 0).length,
      );
    }
  });
});
