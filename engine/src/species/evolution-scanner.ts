/**
 * Gen-3 gEvolutionTable scanner - Phase 8 P8-T4.
 *
 * Scans the ROM for a run of consecutive 30-byte per-species
 * evolution blocks (5 × 6-byte Evolution slots each). Each slot has
 * either method=EVO_NONE+all-zero (legitimate "no evolution") or a
 * valid method/param/targetSpecies combination. A
 * run of ≥ `minBlocks` consecutive valid blocks is the table.
 *
 * Algorithm: walk the ROM at 2-byte stride (the table is u16-aligned
 * because `struct Evolution` is three u16s; a 30-byte block is NOT a
 * multiple of 4, so a 4-byte stride would step over half the legal
 * table alignments). At every candidate position try to parse a
 * per-species block (30 bytes); greedily walk consecutive 30-byte
 * blocks until parse fails. First convincing run wins.
 *
 * Vanilla FireRed has ~411 blocks (411 × 30 = 12330 bytes); CFRU /
 * expansion 700+. Min 8 default avoids accidental matches while
 * allowing tiny test ROMs (only ~12 blocks in the smoke 4th case)
 * to be detected.
 *
 * Performance: ~150 ms on a 16 MiB ROM (cheap per-candidate fast-
 * reject at the very first slot).
 *
 * PD 5: structural-only - no baked offsets; PD 8: every byte of the
 * discovered table is registered in coverage.
 */

import {
  EVOLUTION_BLOCK_SIZE_BYTES,
  EVOLUTION_METHOD_MAX,
  EVOLUTION_SPECIES_MAX,
  EVO_NONE,
  parseEvolutionBlock,
  type EvolutionBlock,
} from './evolution.js';

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

  const stride = 2;
  const limit = bytes.length - EVOLUTION_BLOCK_SIZE_BYTES;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    // OPTIMIZATION + correctness: require SLOT 0 of the first block
    // at this candidate to be populated (method != EVO_NONE).
    // Without this, zero-fill prefixes upstream of the real
    // gEvolutionTable get accepted as the table start - every Gen-3
    // ROM has megabytes of zero-fill, and a candidate just before
    // the real table can have its block 0 overlap the real first
    // populated slot at a non-zero slot index (e.g. slot 4),
    // incorrectly anchoring 24 bytes before the real start. Slot 0
    // populated == "the first 6 bytes at the candidate position are
    // a real Evolution struct, not zero-fill" - the tightest possible
    // anchor that works structurally.
    // Trade-off: in vanilla, gEvolutionTable[0] = SPECIES_NONE
    // (all-zero block) is correctly part of the real table but won't
    // anchor a run - the scanner anchors at species 1 (Bulbasaur, slot
    // 0 = EVO_LEVEL @ 16 → Ivysaur) instead, off-by-one. The reported
    // `blocks[i]` corresponds to species `i+1` in that case. For
    // synthetic fixtures where species 0 itself is populated, the
    // alignment is exact. The graph builder must be aware of this
    // when associating blocks to species ids.
    // Fast pre-reject, inlined. A run can only anchor where slot 0 is a
    // populated, plausible Evolution slot; reading just `method` and
    // `targetSpecies` here skips the block/slot construction inside
    // parseEvolutionBlock for ~99.9% of positions. That is what keeps the
    // u16 stride affordable on a 16 MiB ROM (the inlined filter is exactly
    // the set of slot-0 outcomes that would fail the full parse anyway).
    const slot0Method =
      (bytes[candidateStart] ?? 0) | ((bytes[candidateStart + 1] ?? 0) << 8);
    if (slot0Method === EVO_NONE || slot0Method > EVOLUTION_METHOD_MAX) continue;
    const slot0Target =
      (bytes[candidateStart + 4] ?? 0) | ((bytes[candidateStart + 5] ?? 0) << 8);
    if (slot0Target === 0 || slot0Target > EVOLUTION_SPECIES_MAX) continue;

    const firstBlockResult = parseEvolutionBlock(bytes, candidateStart);
    if (!firstBlockResult.ok) continue;
    if (firstBlockResult.block.slots[0]!.isEmpty) continue;

    const blocks: EvolutionBlock[] = [firstBlockResult.block];
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
          tableStart: candidateStart,
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
