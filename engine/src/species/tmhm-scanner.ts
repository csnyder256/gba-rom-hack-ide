/**
 * Gen-3 gTMHMLearnsets table scanner - Phase 8 P8-T6.
 *
 * Scans the ROM for a run of consecutive 8-byte u64 TM/HM
 * compatibility bitfields. Per-slot signature (see `./tmhm.ts`):
 *
 *   - top 6 bits (bits 58..63) must be 0
 *   - bottom-58 popcount ≤ 100 (Mew's vanilla 58 + generous heavy-
 *     hack headroom)
 *
 * Random match rate per slot is ~1/64 (just the top-6-zero check - 
 * bit-count bound is essentially always satisfied). Over a run of
 * 32 consecutive slots that's (1/64)^32 ≈ 2.6e-58 - effectively
 * impossible for random bytes. But pure zero-fill regions (every
 * byte 0) ALSO trivially satisfy the slot signature (zero is a
 * legitimate "no TMs learnable" species like Magikarp). To defeat
 * zero-fill matching, require:
 *
 *   - ≥ minSlots total slots in the run
 *   - ≥ minPopulatedSlots slots with ≥ 1 bit set
 *   - ≥ 1 slot with at least one HM bit set (bit index ≥
 *     TMHM_TM_COUNT=50). Real gTMHMLearnsets always has species
 *     that learn HMs (Strength/Cut/Surf/Fly). Unrelated tables
 *     (wild-Pokémon slots, song-tables, etc.) confine their
 *     non-zero bytes to low bits and never reach the HM range.
 *

 * Algorithm: 8-byte stride scan. The Gen-3 ABI aligns `u64`
 * globals to 8 bytes (the compiler/linker pad to natural u64
 * alignment), so gTMHMLearnsets is always at an 8-byte aligned
 * offset. Using stride=8 (not 4) defeats bit-shifted false
 * positives - at a 4-byte offset, a real slot's high half can
 * align with the next slot's low half producing a spurious
 * "looks valid" composite slot. Stride 8 anchors only at true
 * slot boundaries.
 *
 * Anchor: FIRST slot must have ≥ 1 bit set. Defeats zero-fill
 * prefix matching that would otherwise anchor the run at the
 * first species-NONE-style entry. Vanilla gTMHMLearnsets
 * [SPECIES_NONE] = 0 means the scan anchors at species 1 (Bulbasaur,
 * which learns ~30 TMs); the leading species-0 slot is re-attached
 * afterwards (see the recovery step in `scanTMHMTable`) so
 * `slots[i]` == species `i`.
 *
 * PD 5: structural-only - no baked offsets; PD 8: every byte of
 * the discovered table is registered in coverage.
 */

import {
  TMHM_STRUCT_SIZE_BYTES,
  TMHM_TM_COUNT,
  parseTMHMCompat,
  type TMHMCompat,
} from './tmhm.js';
import { isRealTableBoundary } from './table-boundary.js';

/** Minimum total slots required to accept a run. Vanilla 411
 *  species clears 32 trivially. */
export const TMHM_SCAN_MIN_SLOTS = 32;
/** Minimum slots with ≥1 bit set. Defeats zero-fill matching
 *  while admitting tables where the first few species have empty
 *  TM/HM compatibility (vanilla SPECIES_NONE = 0). */
export const TMHM_SCAN_MIN_POPULATED_SLOTS = 8;
/** Cap on slots walked per candidate. Vanilla 411; heavy hacks
 *  700+; 4096 generous. */
export const TMHM_SCAN_MAX_SLOTS = 4096;

export interface TMHMTable {
  /** ROM file offset of the first slot (the leading empty
   *  SPECIES_NONE slot when it could be recovered, so `slots[i]` ==
   *  species id `i`). */
  readonly tableStart: number;
  /** Exclusive end offset. */
  readonly tableEndExclusive: number;
  /** Number of slots successfully parsed. */
  readonly slotCount: number;
  /** Each parsed slot in table order. */
  readonly slots: ReadonlyArray<TMHMCompat>;
  /** Count of slots with ≥1 bit set. */
  readonly populatedSlotCount: number;
}

export interface ScanTMHMTableOptions {
  readonly minSlots?: number;
  readonly minPopulatedSlots?: number;
  readonly maxSlots?: number;
  /** Half-open ranges to skip when picking candidate positions. Used
   *  by the Phase-8 detector to avoid false-positive anchoring inside
   *  regions already classified by prior detectors (Thumb opcode
   *  handlers from P6, wild-Pokémon slot arrays from P8-T3, etc.).
   *  Each range is `{start, end}` with `end` exclusive. */
  readonly skipRanges?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

/** Find the gTMHMLearnsets table structurally. Returns null when
 *  no convincing run is found. */
export function scanTMHMTable(
  bytes: Uint8Array,
  opts?: ScanTMHMTableOptions,
): TMHMTable | null {
  const minSlots = opts?.minSlots ?? TMHM_SCAN_MIN_SLOTS;
  const minPopulatedSlots = opts?.minPopulatedSlots ?? TMHM_SCAN_MIN_POPULATED_SLOTS;
  const maxSlots = opts?.maxSlots ?? TMHM_SCAN_MAX_SLOTS;
  if (!Number.isInteger(minSlots) || minSlots < 1) {
    throw new Error(`minSlots must be a positive integer, got ${String(minSlots)}`);
  }
  if (!Number.isInteger(minPopulatedSlots) || minPopulatedSlots < 1) {
    throw new Error(
      `minPopulatedSlots must be a positive integer, got ${String(minPopulatedSlots)}`,
    );
  }
  if (!Number.isInteger(maxSlots) || maxSlots < minSlots) {
    throw new Error(`maxSlots must be >= minSlots, got ${String(maxSlots)}`);
  }

  const stride = 8;
  const limit = bytes.length - TMHM_STRUCT_SIZE_BYTES;
  const skipRanges = opts?.skipRanges ?? [];
  const isInSkipRange = (offset: number): boolean => {
    for (const r of skipRanges) {
      if (offset >= r.start && offset < r.end) return true;
    }
    return false;
  };
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    // Skip candidate positions inside known-classified regions (Thumb
    // opcode handlers, wild-Pokémon slot arrays, etc.) - these can
    // pass the per-slot signature by coincidence but are owned by
    // earlier detectors.
    if (isInSkipRange(candidateStart)) continue;
    // Anchor: first slot must parse AND be populated (≥ 1 bit set).
    // Defeats zero-fill prefix matching - every zero-fill slot
    // parses (top 6 zero + 0 bits set is valid) but is empty.
    const firstSlotResult = parseTMHMCompat(bytes, candidateStart);
    if (!firstSlotResult.ok) continue;
    if (firstSlotResult.tmhm.setBitCount === 0) continue;

    // The vanilla gTMHMLearnsets[SPECIES_NONE] (species 0) slot is an
    // all-zero bitfield (learns no TMs), so the anchor above - which
    // requires ≥1 bit set - skips it and every slot would be attributed
    // one species early. Recover it: when the immediately preceding
    // 8-byte slot is a valid, empty (no-bit) species slot sitting at a
    // real table boundary, include it as species 0 so `slots[i]` lines
    // up with species id `i`. When the preceding bytes are zero-fill (no
    // real boundary), the slot is incidental padding and is NOT included.
    let tableStart = candidateStart;
    let precedingSlot: TMHMCompat | null = null;
    const precedingOffset = candidateStart - TMHM_STRUCT_SIZE_BYTES;
    if (precedingOffset > 0) {
      const preceding = parseTMHMCompat(bytes, precedingOffset);
      if (
        preceding.ok &&
        preceding.tmhm.setBitCount === 0 &&
        isRealTableBoundary(bytes, precedingOffset)
      ) {
        precedingSlot = preceding.tmhm;
        tableStart = precedingOffset;
      }
    }

    const slots: TMHMCompat[] = precedingSlot
      ? [precedingSlot, firstSlotResult.tmhm]
      : [firstSlotResult.tmhm];
    let cursor = candidateStart + TMHM_STRUCT_SIZE_BYTES;
    while (slots.length < maxSlots) {
      if (cursor + TMHM_STRUCT_SIZE_BYTES > bytes.length) break;
      const r = parseTMHMCompat(bytes, cursor);
      if (!r.ok) break;
      slots.push(r.tmhm);
      cursor += TMHM_STRUCT_SIZE_BYTES;
    }
    if (slots.length >= minSlots) {
      const populatedSlotCount = slots.filter((s) => s.setBitCount > 0).length;
      // Discriminator anchor: at least one slot must reference a bit
      // in [24..31] (TM25..TM32) OR [56..63] (HM07..HM08 + reserved).
      // Defeats false positives from tables whose byte patterns
      // satisfy the per-slot signature but confine non-zero bytes
      // to low-order positions. Wild-Pokémon slot arrays, for
      // example, pack {minLevel, maxLevel, species, padding} per 4
      // bytes where species ≤ ~700 fits in the LOW byte and the
      // HIGH byte (bits 24-31) is always 0. Real gTMHMLearnsets
      // tables always have species that learn TMs in the 25-32
      // range (Earthquake/Surf/Strength/etc. - extremely common).
      const anySlotHasHighBit = slots.some((s) =>
        s.setBitIndices.some(
          (b) => (b >= 24 && b <= 31) || (b >= TMHM_TM_COUNT + 6 && b < 64),
        ),
      );
      if (populatedSlotCount >= minPopulatedSlots && anySlotHasHighBit) {
        return Object.freeze({
          tableStart,
          tableEndExclusive: cursor,
          slotCount: slots.length,
          slots: Object.freeze(slots),
          populatedSlotCount,
        });
      }
    }
  }
  return null;
}
