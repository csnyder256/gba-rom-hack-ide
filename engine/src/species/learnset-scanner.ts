/**
 * Gen-3 gLevelUpLearnsets pointer table scanner - Phase 8 P8-T5.
 *
 * The Gen-3 level-up learnsets are organized as a flat ROM-pointer
 * table - one `u32` per species, each pointing at a per-species
 * terminator-delimited u16 array (see `./learnset.ts`):
 *
 *   const u16 *const gLevelUpLearnsets[NUM_SPECIES] = {
 *     [SPECIES_NONE]      = sNoneLevelUpLearnset,       // → {0xFFFF}
 *     [SPECIES_BULBASAUR] = sBulbasaurLevelUpLearnset,  // → {LM(1,TACKLE), LM(1,GROWL), ..., 0xFFFF}
 *     ...
 *   };
 *
 * Scan strategy: walk the ROM at 4-byte stride; at each candidate
 * position try to interpret the next N × 4 bytes as a run of ROM
 * pointers, each successfully dereferencing to a valid learnset
 * array. A run of ≥ `minPointers` consecutive valid pointers is the
 * table.
 *
 * Per-pointer validation:
 *   1. The u32 must be a ROM pointer (0x08000000..0x09FFFFFF).
 *   2. The dereferenced bytes must parse as a valid learnset (either
 *      empty `{0xFFFF}` OR ≥ 1 entry + 0xFFFF terminator).
 *
 * The "first pointer must point at a NON-EMPTY learnset" anchor
 * defeats zero-fill matching: in zero-fill regions every u32 = 0
 * (not a valid pointer) so we never anchor in zero-fill at all.
 * The anchor still admits the vanilla case where `gLevelUpLearnsets
 * [SPECIES_NONE]` points at `{0xFFFF}` (empty) - the scan then anchors
 * at species 1 = Bulbasaur (always non-empty in vanilla). The leading
 * species-0 slot is re-attached afterwards (see the recovery step in
 * `scanLearnsetPointerTable`) so `entries[i]` == species `i`.
 *
 * Performance: ~100 ms on a 16 MiB ROM (4-byte-stride scan with
 * cheap fast-reject at the "is u32 a ROM pointer" check).
 *
 * PD 5: structural-only - no baked offsets; PD 8: every byte of
 * the discovered pointer table AND every byte of each pointed-at
 * learnset array is registered in coverage.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  parseLearnsetArray,
  type Learnset,
} from './learnset.js';
import { isRealTableBoundary } from './table-boundary.js';

/** Minimum pointers required to accept a run as gLevelUpLearnsets.
 *  Vanilla has 411; even hyper-stripped test ROMs clear 8. */
export const LEARNSET_TABLE_SCAN_MIN_POINTERS = 8;
/** Cap on pointers walked per candidate. Vanilla maxes 411; heavy
 *  hacks 700+; 2048 generous. */
export const LEARNSET_TABLE_SCAN_MAX_POINTERS = 2048;

const GBA_ROM_POINTER_UPPER = 0x09ffffff;

export interface LearnsetTableEntry {
  /** ROM file offset of the u32 pointer (in the pointer table). */
  readonly pointerFileOffset: number;
  /** Raw u32 pointer value. */
  readonly pointerRaw: number;
  /** Parsed learnset array (always Object.frozen). */
  readonly learnset: Learnset;
}

export interface LearnsetPointerTable {
  /** Start offset of the pointer table (= first pointer). */
  readonly tableStart: number;
  /** Exclusive end offset of the pointer table. */
  readonly tableEndExclusive: number;
  /** Number of valid pointer/learnset pairs. */
  readonly pointerCount: number;
  /** Each parsed (pointer, learnset) pair, in table order. Index
   *  = species id (the leading empty SPECIES_NONE slot is included). */
  readonly entries: ReadonlyArray<LearnsetTableEntry>;
  /** Count of entries whose learnset has ≥1 non-terminator entry. */
  readonly populatedEntryCount: number;
}

export interface ScanLearnsetTableOptions {
  readonly minPointers?: number;
  readonly maxPointers?: number;
}

/** Find the gLevelUpLearnsets pointer table structurally. */
export function scanLearnsetPointerTable(
  bytes: Uint8Array,
  opts?: ScanLearnsetTableOptions,
): LearnsetPointerTable | null {
  const minPointers = opts?.minPointers ?? LEARNSET_TABLE_SCAN_MIN_POINTERS;
  const maxPointers = opts?.maxPointers ?? LEARNSET_TABLE_SCAN_MAX_POINTERS;
  if (!Number.isInteger(minPointers) || minPointers < 1) {
    throw new Error(`minPointers must be a positive integer, got ${String(minPointers)}`);
  }
  if (!Number.isInteger(maxPointers) || maxPointers < minPointers) {
    throw new Error(`maxPointers must be >= minPointers, got ${String(maxPointers)}`);
  }

  const stride = 4;
  const limit = bytes.length - 4;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    // Anchor: first pointer must be a valid ROM pointer AND deref
    // to a non-empty learnset. Without the non-empty anchor, any
    // sequence of NULL-or-valid pointers would match - including
    // pure zero-fill (every u32=0 deref skipped) which is wrong.
    const firstPtr = readUint32Le(bytes, candidateStart);
    if (firstPtr < GBA_ROM_BASE_ADDRESS || firstPtr > GBA_ROM_POINTER_UPPER) continue;
    const firstTargetOffset = firstPtr - GBA_ROM_BASE_ADDRESS;
    if (firstTargetOffset < 0 || firstTargetOffset >= bytes.length) continue;
    const firstParse = parseLearnsetArray(bytes, firstTargetOffset);
    if (!firstParse.ok) continue;
    if (firstParse.learnset.entries.length === 0) continue; // empty learnset = poor anchor

    // The vanilla gLevelUpLearnsets[SPECIES_NONE] (species 0) slot points
    // at an EMPTY learnset ({LEVEL_UP_END}), so the anchor above - which
    // requires a NON-empty learnset - skips it and every entry would be
    // attributed one species early. Recover it: when the immediately
    // preceding u32 is a valid ROM pointer to a valid learnset sitting at
    // a real table boundary, include it as species 0 so `entries[i]`
    // lines up with species id `i`. (The preceding pointer can only be
    // empty or invalid here - a non-empty one would already have anchored
    // the scan 4 bytes earlier.) When the preceding bytes are zero-fill
    // (no real boundary), the slot is incidental padding and is NOT
    // included.
    let tableStart = candidateStart;
    let precedingEntry: LearnsetTableEntry | null = null;
    const precedingPtrOffset = candidateStart - 4;
    if (precedingPtrOffset > 0 && isRealTableBoundary(bytes, precedingPtrOffset)) {
      const prePtr = readUint32Le(bytes, precedingPtrOffset);
      if (prePtr >= GBA_ROM_BASE_ADDRESS && prePtr <= GBA_ROM_POINTER_UPPER) {
        const preTargetOffset = prePtr - GBA_ROM_BASE_ADDRESS;
        if (preTargetOffset >= 0 && preTargetOffset < bytes.length) {
          const preParse = parseLearnsetArray(bytes, preTargetOffset);
          if (preParse.ok) {
            precedingEntry = {
              pointerFileOffset: precedingPtrOffset,
              pointerRaw: prePtr,
              learnset: preParse.learnset,
            };
            tableStart = precedingPtrOffset;
          }
        }
      }
    }

    const entries: LearnsetTableEntry[] = [];
    if (precedingEntry !== null) entries.push(precedingEntry);
    entries.push({
      pointerFileOffset: candidateStart,
      pointerRaw: firstPtr,
      learnset: firstParse.learnset,
    });
    let cursor = candidateStart + 4;
    while (entries.length < maxPointers) {
      if (cursor + 4 > bytes.length) break;
      const ptr = readUint32Le(bytes, cursor);
      // NULL pointer ends the table (no Gen-3 species has a NULL learnset
      // pointer in vanilla - every species has at least sNoneLevelUpLearnset
      // = {0xFFFF}).
      if (ptr === 0) break;
      if (ptr < GBA_ROM_BASE_ADDRESS || ptr > GBA_ROM_POINTER_UPPER) break;
      const targetOffset = ptr - GBA_ROM_BASE_ADDRESS;
      if (targetOffset < 0 || targetOffset >= bytes.length) break;
      const parse = parseLearnsetArray(bytes, targetOffset);
      if (!parse.ok) break;
      entries.push({
        pointerFileOffset: cursor,
        pointerRaw: ptr,
        learnset: parse.learnset,
      });
      cursor += 4;
    }

    if (entries.length >= minPointers) {
      const populatedEntryCount = entries.filter(
        (e) => e.learnset.entries.length > 0,
      ).length;
      return Object.freeze({
        tableStart,
        tableEndExclusive: cursor,
        pointerCount: entries.length,
        entries: Object.freeze(entries),
        populatedEntryCount,
      });
    }
  }
  return null;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
