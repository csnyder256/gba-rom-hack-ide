/**
 * Phase-8 detector: species evolutions (P8-T4).
 *
 * Per §15 Phase 8, the species system covers - beyond P8-T1's base
 * stats - evolutions, learnsets, TM/HM compat, abilities, hidden
 * abilities, forms, mega/regional/custom forms, etc. P8-T4 adds
 * EVOLUTIONS: the Gen-3 gEvolutionTable is a flat array of 30-byte
 * per-species blocks (5 × 6-byte Evolution slots each).
 *
 * Coverage contribution: every byte of the discovered gEvolutionTable
 * is registered as `table` class at confidence 0.9.
 *
 * PD 5: structural-only - `scanEvolutionTable` finds the table by
 * validating the per-slot Evolution struct shape; no baked offsets.
 *
 * PD 1 / §15 P8 acceptance: this detector enriches species:N nodes
 * with their evolution chains AND emits typed `evolves_into` edges
 * between species - adding the SECOND cross-species typed edge kind
 * after P8-T3's `encounters_species`. The species view in Phase 12
 * can now render real evolution chains (Bulbasaur→Ivysaur→Venusaur,
 * etc.) directly from the relationship graph.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  EVOLUTION_BLOCK_SIZE_BYTES,
  EVOLUTION_SCAN_MIN_BLOCKS,
  scanEvolutionTable,
  type EvolutionTable,
} from '../species/index.js';

export const SPECIES_EVOLUTIONS_DETECTOR_ID = 'species_evolutions';

export interface SpeciesEvolutionsReport {
  /** Discovered gEvolutionTable. */
  readonly evolutionTable: EvolutionTable;
  /** Mirror: total blocks (= species rows with explicit evolution data). */
  readonly blockCount: number;
  /** Mirror: blocks containing ≥1 non-EVO_NONE slot. */
  readonly populatedBlockCount: number;
  /** Total number of populated (non-EVO_NONE) slots across all blocks
   * - the count of typed `evolves_into` edges this detector implies. */
  readonly totalEvolutionEdgeCount: number;
}

export const speciesEvolutionsDetector: RomDetector<SpeciesEvolutionsReport> = {
  id: SPECIES_EVOLUTIONS_DETECTOR_ID,
  name: 'Species Evolutions (Gen-3 gEvolutionTable scanner)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<SpeciesEvolutionsReport> {
    if (rom.byteLength < EVOLUTION_SCAN_MIN_BLOCKS * EVOLUTION_BLOCK_SIZE_BYTES) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a ≥${String(EVOLUTION_SCAN_MIN_BLOCKS)}-block gEvolutionTable`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gEvolutionTable',
      });
    }

    const evolutionTable = scanEvolutionTable(rom.bytes);
    if (evolutionTable === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥${String(EVOLUTION_SCAN_MIN_BLOCKS)} 30-byte evolution blocks with ≥2 populated (non-EVO_NONE) blocks - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              blockSize: EVOLUTION_BLOCK_SIZE_BYTES,
              minBlocks: EVOLUTION_SCAN_MIN_BLOCKS,
            },
          }),
        ],
        reason:
          'No Gen-3 gEvolutionTable found - either the ROM has no species evolutions, the evolution engine has been rewritten with a non-flat layout, or the table is too small to clear the min-blocks threshold',
      });
    }

    try {
      coverage.addClassified({
        start: evolutionTable.tableStart,
        end: evolutionTable.tableEndExclusive,
        probableClass: 'table',
        score: 0.9,
        provenance: `${SPECIES_EVOLUTIONS_DETECTOR_ID}#gEvolutionTable`,
        note: `Gen-3 gEvolutionTable (${String(evolutionTable.blockCount)} species blocks, ${String(evolutionTable.populatedBlockCount)} populated)`,
      });
    } catch {
      // Overlap with another detector - skip.
    }

    // Count populated slots across all blocks - this equals the number
    // of evolves_into edges the graph will emit.
    let totalEvolutionEdgeCount = 0;
    for (const b of evolutionTable.blocks) {
      totalEvolutionEdgeCount += b.populatedSlots.length;
    }

    // Confidence: vanilla FireRed/Emerald have ~411 blocks with ~200
    // populated; heavy hacks expand. ≥100 populated blocks is
    // essentially certainly the real table.
    const confidence =
      evolutionTable.populatedBlockCount >= 100
        ? 0.95
        : evolutionTable.populatedBlockCount >= 20
          ? 0.9
          : 0.85;

    return makeDetected({
      confidence,
      data: Object.freeze({
        evolutionTable,
        blockCount: evolutionTable.blockCount,
        populatedBlockCount: evolutionTable.populatedBlockCount,
        totalEvolutionEdgeCount,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gEvolutionTable at offset 0x${evolutionTable.tableStart.toString(16)} (${String(evolutionTable.blockCount)} species blocks, ${String(evolutionTable.populatedBlockCount)} populated, ${String(totalEvolutionEdgeCount)} total evolution edges)`,
          weight: 1.0,
          detail: {
            tableStart: evolutionTable.tableStart,
            tableEndExclusive: evolutionTable.tableEndExclusive,
            blockCount: evolutionTable.blockCount,
            populatedBlockCount: evolutionTable.populatedBlockCount,
            totalEvolutionEdgeCount,
          },
        }),
      ],
    });
  },
};
