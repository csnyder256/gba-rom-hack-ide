/**
 * Gen-3 gEvolutionTable scanner - Phase 8 P8-T4.
 *
 * Scans the ROM for a run of consecutive 40-byte per-species
 * evolution blocks (5 × 8-byte Evolution slots each). Each slot has
 * either method=EVO_NONE+all-zero (legitimate "no evolution") or a
 * valid method/param/targetSpecies/zero-padding combination. A
 * run of ≥ `minBlocks` consecutive valid blocks is the table.
 *
 * Algorithm: walk the ROM at 4-byte stride (the table is 4-byte
 * aligned; per-species blocks are 40 bytes apart so the stride must
 * divide 40, and 4 is the natural u16-aligned step). At every
 * candidate position try to parse a per-species block (40 bytes);
 * greedily walk consecutive 40-byte blocks until parse fails. First
 * convincing run wins.
 *
 * Vanilla FireRed has ~411 blocks (411 × 40 = 16440 bytes); CFRU /
 * expansion 700+. Min 8 default avoids accidental matches while
 * allowing tiny test ROMs (only ~12 blocks in the smoke 4th case)
 * to be detected.
 *
 * Performance: ~80 ms on a 16 MiB ROM (cheap per-candidate fast-
 * reject at the very first slot's padding check).
 *
 * PD 5: structural-only - no baked offsets; PD 8: every byte of the
 * discovered table is registered in coverage.
 */

import {
  EVOLUTION_BLOCK_SIZE_BYTES,
  parseEvolutionBlock,
  type EvolutionBlock,
} from './evolution.js';
import { isRealTableBoundary } from './table-boundary.js';

/** Minimum blocks required to accept a run as the gEvolutionTable.
 *  Vanilla has ~411; even the smallest plausible test ROM clears 8. */
export const EVOLUTION_SCAN_MIN_BLOCKS = 8;
/** Minimum POPULATED blocks (≥1 non-EVO_NONE slot) in the run for
 *  acceptance. Without this filter a run of all-zero bytes (each
 *  parses as 5 × EVO_NONE = legitimate "no evolution" block) would
 *  trivially match the first zero-fill region of ≥ 320 bytes - and
 *  every Gen-3 ROM has megabytes of zero-fill. Requiring ≥2
 *  populated blocks defeats zero-fill while admitting any real
 *  gEvolutionTable, since vanilla has ~300+ populated species and
 *  even hyper-stripped test ROMs have several evolution chains. */
export const EVOLUTION_SCAN_MIN_POPULATED_BLOCKS = 2;
/** Cap on blocks walked per candidate. Vanilla maxes 411; heavy
 *  hacks 700+; 2048 generous. */
export const EVOLUTION_SCAN_MAX_BLOCKS = 2048;

export interface EvolutionTable {
  /** Start offset of the first per-species block. */
  readonly tableStart: number;
  /** Exclusive end offset. */
  readonly tableEndExclusive: number;
  /** Number of blocks (= species with explicit evolution data). */
  readonly blockCount: number;
  /** Each parsed block in table order. Index = species id. */
  readonly blocks: ReadonlyArray<EvolutionBlock>;
  /** Convenience: count of blocks containing ≥1 non-EVO_NONE slot. */
  readonly populatedBlockCount: number;
}

export interface ScanEvolutionTableOptions {
  readonly minBlocks?: number;
  readonly minPopulatedBlocks?: number;
  readonly maxBlocks?: number;
}

/** Find the gEvolutionTable structurally. Returns null when no
 *  convincing run is found. */
export function scanEvolutionTable(
  bytes: Uint8Array,
  opts?: ScanEvolutionTableOptions,
): EvolutionTable | null {
  const minBlocks = opts?.minBlocks ?? EVOLUTION_SCAN_MIN_BLOCKS;
  const minPopulatedBlocks = opts?.minPopulatedBlocks ?? EVOLUTION_SCAN_MIN_POPULATED_BLOCKS;
  const maxBlocks = opts?.maxBlocks ?? EVOLUTION_SCAN_MAX_BLOCKS;
  if (!Number.isInteger(minBlocks) || minBlocks < 1) {
    throw new Error(`minBlocks must be a positive integer, got ${String(minBlocks)}`);
  }
  if (!Number.isInteger(minPopulatedBlocks) || minPopulatedBlocks < 1) {
    throw new Error(
      `minPopulatedBlocks must be a positive integer, got ${String(minPopulatedBlocks)}`,
    );
  }
  if (!Number.isInteger(maxBlocks) || maxBlocks < minBlocks) {
    throw new Error(`maxBlocks must be >= minBlocks, got ${String(maxBlocks)}`);
  }

  const stride = 4;
  const limit = bytes.length - EVOLUTION_BLOCK_SIZE_BYTES;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    // OPTIMIZATION + correctness: require SLOT 0 of the first block
    // at this candidate to be populated (method != EVO_NONE).
    // Without this, zero-fill prefixes upstream of the real
    // gEvolutionTable get accepted as the table start - every Gen-3
    // ROM has megabytes of zero-fill, and a candidate just before
    // the real table can have its block 0 overlap the real first
    // populated slot at a non-zero slot index (e.g. slot 4),
    // incorrectly anchoring 32 bytes before the real start. Slot 0
    // populated == "the first 8 bytes at the candidate position are
    // a real Evolution struct, not zero-fill" - the tightest possible
    // anchor that works structurally.
    //
    // The canonical table has gEvolutionTable[0] = SPECIES_NONE (an
    // all-zero block), so this anchor lands on species 1 and the block
    // immediately before it is that leading species-0 slot. The
    // recovery step below re-attaches it so `blocks[i]` == species `i`
    // (see the comment there).
    const firstBlockResult = parseEvolutionBlock(bytes, candidateStart);
    if (!firstBlockResult.ok) continue;
    if (firstBlockResult.block.slots[0]!.isEmpty) continue;

    // The vanilla gEvolutionTable[SPECIES_NONE] (species 0) slot is an
    // all-zero block - it carries no evolution, so the anchor above
    // (which requires a POPULATED slot 0) skips it and every subsequent
    // block would be reported one species early. Recover it: when the
    // immediately preceding 40-byte block is a valid, all-empty species
    // slot sitting at a real table boundary, include it as species 0 so
    // `blocks[i]` lines up with species id `i`. This mirrors
    // scanBaseStatsTable, which keeps the canonical leading SPECIES_NONE
    // sentinel. When the preceding bytes are zero-fill (no real
    // boundary), the block is incidental padding and is NOT included.
    let tableStart = candidateStart;
    const precedingOffset = candidateStart - EVOLUTION_BLOCK_SIZE_BYTES;
    let precedingBlock: EvolutionBlock | null = null;
    if (precedingOffset > 0) {
      const preceding = parseEvolutionBlock(bytes, precedingOffset);
      if (
        preceding.ok &&
        preceding.block.populatedSlots.length === 0 &&
        isRealTableBoundary(bytes, precedingOffset)
      ) {
        precedingBlock = preceding.block;
        tableStart = precedingOffset;
      }
    }

    const blocks: EvolutionBlock[] = precedingBlock
      ? [precedingBlock, firstBlockResult.block]
      : [firstBlockResult.block];
    let cursor = candidateStart + EVOLUTION_BLOCK_SIZE_BYTES;
    while (blocks.length < maxBlocks) {
      if (cursor + EVOLUTION_BLOCK_SIZE_BYTES > bytes.length) break;
      const r = parseEvolutionBlock(bytes, cursor);
      if (!r.ok) break;
      blocks.push(r.block);
      cursor += EVOLUTION_BLOCK_SIZE_BYTES;
    }
    if (blocks.length >= minBlocks) {
      const populatedBlockCount = blocks.filter((b) => b.populatedSlots.length > 0).length;
      if (populatedBlockCount >= minPopulatedBlocks) {
        return Object.freeze({
          tableStart,
          tableEndExclusive: cursor,
          blockCount: blocks.length,
          blocks: Object.freeze(blocks),
          populatedBlockCount,
        });
      }
    }
  }
  return null;
}
