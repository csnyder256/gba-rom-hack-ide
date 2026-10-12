import { describe, expect, it } from 'vitest';
import { loadRomFromBytes } from '../rom/loader.js';
import { ingestRom } from '../ingest/orchestrator.js';
import { speciesSystemDetector } from '../detectors/species-system.js';
import { speciesEvolutionsDetector } from '../detectors/species-evolutions.js';
import { speciesLearnsetsDetector } from '../detectors/species-learnsets.js';
import { speciesTMHMDetector } from '../detectors/species-tmhm.js';
import { buildRelationshipGraph } from './builder.js';

/** Plant a real (non-sentinel) BaseStats record. */
function plantBaseStats(buf: Buffer, at: number, type: number): void {
  buf[at + 0x00] = 45; // baseHP
  buf[at + 0x01] = 49; // baseAttack
  buf[at + 0x02] = 49; // baseDefense
  buf[at + 0x03] = 45; // baseSpeed
  buf[at + 0x04] = 65; // baseSpAttack
  buf[at + 0x05] = 65; // baseSpDefense
  buf[at + 0x06] = type; // type1
  buf[at + 0x07] = type; // type2
  buf[at + 0x08] = 45; // catchRate
  buf[at + 0x09] = 64; // expYield
  buf[at + 0x10] = 0x7f; // genderRatio
  buf[at + 0x11] = 20; // eggCycles
  buf[at + 0x12] = 70; // friendship
  buf[at + 0x13] = 3; // growthRate
  buf[at + 0x14] = 1; // eggGroup1
  buf[at + 0x15] = 1; // eggGroup2
  buf[at + 0x16] = 1; // ability1
  buf[at + 0x17] = 1; // ability2
  // 0x1A / 0x1B stay zero (padding invariant)
}

describe('graph builder - species sub-table alignment', () => {
  it('attributes evolutions / learnsets / TM-HM to the correct species id', async () => {
    const buf = Buffer.alloc(64 * 1024);

    // --- BaseStats (species 0 sentinel + species 1..12) at 0x100 ---
    buf[0x0ff] = 0xaa; // real table boundary
    for (let s = 1; s <= 12; s++) plantBaseStats(buf, 0x100 + s * 28, 12);

    // --- Evolution table (species 0 empty + species 1..8 → species i+1) at 0x1000 ---
    buf[0x0fff] = 0xaa;
    for (let s = 1; s <= 8; s++) {
      const at = 0x1000 + s * 40;
      buf.writeUInt16LE(4, at + 0); // EVO_LEVEL
      buf.writeUInt16LE(16, at + 2); // level
      buf.writeUInt16LE(s + 1, at + 4); // target species
    }

    // --- Learnset pointer table (species 0 empty + species 1..8 non-empty) at 0x2000 ---
    buf[0x1fff] = 0xaa;
    let arrayCursor = 0x3000;
    const plantLearnset = (at: number, moves: number[]): number => {
      let c = at;
      for (const m of moves) {
        buf.writeUInt16LE(((1 & 0x7f) << 9) | (m & 0x1ff), c);
        c += 2;
      }
      buf.writeUInt16LE(0xffff, c);
      return c + 2;
    };
    const emptyLearnsetAt = arrayCursor;
    arrayCursor = plantLearnset(arrayCursor, []);
    buf.writeUInt32LE((0x08000000 + emptyLearnsetAt) >>> 0, 0x2000);
    for (let s = 1; s <= 8; s++) {
      const arrAt = arrayCursor;
      arrayCursor = plantLearnset(arrayCursor, [1, 2, 3]);
      buf.writeUInt32LE((0x08000000 + arrAt) >>> 0, 0x2000 + s * 4);
    }

    // --- TM/HM table (species 0 empty + species 1..32 populated) at 0x4000 ---
    buf[0x3fff] = 0xaa;
    for (let s = 1; s <= 32; s++) {
      const at = 0x4000 + s * 8;
      const bit = s % 50;
      let low = 0, high = 0;
      if (bit < 32) low |= 1 << bit; else high |= 1 << (bit - 32);
      high |= 1 << (56 - 32); // HM07 in the discriminator range
      buf.writeUInt32LE(low >>> 0, at + 0);
      buf.writeUInt32LE(high >>> 0, at + 4);
    }

    const rom = loadRomFromBytes({ bytes: buf });
    const report = await ingestRom({
      rom,
      detectors: [
        speciesSystemDetector,
        speciesEvolutionsDetector,
        speciesLearnsetsDetector,
        speciesTMHMDetector,
      ],
    });
    const g = buildRelationshipGraph({ report });

    const edges = g.edgesByKind('evolves_into').map((e) => `${e.from}->${e.to}`);

    // The fix: species 1 (not species 0) is the one that evolves into 2,
    // because the leading SPECIES_NONE slot is now attributed to species 0.
    expect(edges).toContain('species:1->species:2');
    expect(edges.some((e) => e.startsWith('species:0->'))).toBe(false);

    const sp1 = g.getNode('species:1');
    const sp0 = g.getNode('species:0');
    expect(Array.isArray(sp1?.detail?.evolutions)).toBe(true);
    expect((sp1?.detail?.evolutions as unknown[]).length).toBeGreaterThan(0);
    expect((sp0?.detail?.evolutions as unknown[]).length).toBe(0);
    // Learnset + TM/HM land on the right species too (species 0 = none).
    expect((sp0?.detail?.learnset as unknown[]).length).toBe(0);
    expect((sp0?.detail?.tmhmCompat as { setBitCount: number }).setBitCount).toBe(0);
    expect((sp1?.detail?.learnset as unknown[]).length).toBe(3);
    expect((sp1?.detail?.tmhmCompat as { setBitCount: number }).setBitCount).toBe(2);
  });
});
