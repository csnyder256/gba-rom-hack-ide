/**
 * Gen-3 gBaseStats table scanner - Phase 8 P8-T1 + RT-1.2.
 *
 * Scans the ROM for a run of consecutive 28-byte BaseStats structs.
 * Each struct has a strong structural signature (type bytes ≤ 17,
 * growth-rate ≤ 5, both padding bytes 0, ≥ 1 non-zero stat) - random
 * ROM data hits the combined filter at < 1e-9 probability per
 * 28-byte slice, so a run of ≥ 10 consecutive parse-successes is
 * essentially certain to be the real table.
 *
 * RT-1.2 - Algorithm: 4-byte stride scan; at every candidate position
 * greedy-walk consecutive BaseStats records (each 28 bytes apart)
 * until a parse fails, then keep the LONGEST run found across the
 * entire ROM. Pre-RT-1.2 the scanner returned the FIRST run that
 * cleared `minSpeciesInTable` - that picked a 21-entry false positive
 * on every corpus ROM (FireRed, Unbound, Radical Red) and never
 * reached the real 412/905-entry gBaseStats further into the ROM.
 *
 * After a successful run, the scanner skips past the run's bytes
 * before continuing (avoids re-discovering the same table at
 * sub-stride offsets) so worst-case runtime stays O(romBytes) not
 * O(romBytes × maxRecords). Parse fails almost always at the first
 * byte check (padding!=0 or type>17) so the per-position cost is
 * tiny - typical full-ROM scan completes in 100-300ms.
 *
 * Optional `hintStart` lets a caller (e.g. a coordinated cross-
 * detector pass that already knows where gLevelUpLearnsets is) point
 * the scanner directly at the table. When the hint produces a run
 * of ≥minSpeciesInTable records the scanner accepts it WITHOUT the
 * full sweep - a 10× speedup. The hint is treated as a fast-path
 * only; if it fails the scanner falls back to the exhaustive longest-
 * run scan.
 *
 * PD 5: structural-only - no baked offsets; PD 8: every byte of the
 * discovered table is registered in coverage.
 */

import {
  BASE_STATS_STRUCT_SIZE_BYTES,
  parseBaseStats,
  type BaseStats,
} from './base-stats.js';
import { isRealTableBoundary } from './table-boundary.js';

/** Recognise a SPECIES_NONE-style sentinel slot - all stats zero,
 *  types ≤ 17, growth rate ≤ 5, all padding bytes zero. Vanilla FRLG
 *  has at least 1 such slot at index 0 (SPECIES_NONE); some hacks
 *  add more between the original Gen-1/2 numbering and Gen-3
 *  expansions. parseBaseStats rejects these on the `all_zero_stats`
 *  guard because random all-zero ROM regions would otherwise produce
 *  huge false-positive runs; this helper relaxes that ONLY for
 *  contiguous extensions of an already-validated forward run. */
function isSentinelBaseStatsSlot(bytes: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + BASE_STATS_STRUCT_SIZE_BYTES > bytes.length) {
    return false;
  }
  // Padding bytes must be 0.
  if (bytes[offset + 0x1a] !== 0 || bytes[offset + 0x1b] !== 0) return false;
  // evYield padding bits (upper 4 of 0x0B) must be 0.
  if (((bytes[offset + 0x0b]! >> 4) & 0x0f) !== 0) return false;
  // All six stat bytes must be 0.
  for (let i = 0; i < 6; i++) {
    if (bytes[offset + i] !== 0) return false;
  }
  // Types must be in range. (Vanilla SPECIES_NONE uses TYPE_MYSTERY=9
  // for both, but accepting any 0..17 covers hack variants that zero
  // these too.)
  if (bytes[offset + 0x06]! > 17) return false;
  if (bytes[offset + 0x07]! > 17) return false;
  // Growth rate ≤ 5.
  if (bytes[offset + 0x13]! > 5) return false;
  // Egg groups ≤ 15.
  if (bytes[offset + 0x14]! > 15) return false;
  if (bytes[offset + 0x15]! > 15) return false;
  return true;
}

/** Build a placeholder BaseStats record for a sentinel slot. */
function sentinelBaseStatsRecord(bytes: Uint8Array, offset: number): BaseStats {
  return Object.freeze({
    baseHP: 0, baseAttack: 0, baseDefense: 0, baseSpeed: 0,
    baseSpAttack: 0, baseSpDefense: 0,
    type1: bytes[offset + 0x06]!,
    type2: bytes[offset + 0x07]!,
    catchRate: bytes[offset + 0x08]!,
    expYield: bytes[offset + 0x09]!,
    item1: bytes[offset + 0x0c]! | (bytes[offset + 0x0d]! << 8),
    item2: bytes[offset + 0x0e]! | (bytes[offset + 0x0f]! << 8),
    genderRatio: bytes[offset + 0x10]!,
    eggCycles: bytes[offset + 0x11]!,
    friendship: bytes[offset + 0x12]!,
    growthRate: bytes[offset + 0x13]!,
    eggGroup1: bytes[offset + 0x14]!,
    eggGroup2: bytes[offset + 0x15]!,
    ability1: bytes[offset + 0x16]!,
    ability2: bytes[offset + 0x17]!,
    safariZoneFleeRate: bytes[offset + 0x18]!,
    fileOffset: offset,
  });
}

/** Minimum records required to accept a run as the gBaseStats table.
 *  Vanilla has 411; absurdly-stripped engines might have ~250; 10 is
 *  enough to make accidental matches essentially impossible. */
export const BASE_STATS_SCAN_MIN_RECORDS = 10;
/** Cap on records walked per candidate. Vanilla maxes 411; heavy
 *  hacks (Radical Red, Saiph, Crystal) reach 900+. 2048 is generous
 *  for any plausible Gen-3 hack. */
export const BASE_STATS_SCAN_MAX_RECORDS = 2048;

export interface BaseStatsTable {
  /** ROM file offset of the table's first byte (= record 0). */
  readonly tableStart: number;
  /** Exclusive end offset. */
  readonly tableEndExclusive: number;
  /** Number of valid records parsed. */
  readonly speciesCount: number;
  /** Each parsed record, in table order. Index = species id. */
  readonly records: ReadonlyArray<BaseStats>;
}

export interface ScanBaseStatsOptions {
  readonly minSpeciesInTable?: number;
  readonly maxSpeciesInTable?: number;
  /** Optional fast-path: a file offset suspected to be the start of
   *  the gBaseStats table. The scanner tries this offset first; if it
   *  produces ≥minSpeciesInTable records it returns immediately
   *  without the full longest-run sweep. Useful when a coordinated
   *  cross-detector pass has already established where the table
   *  should live. Set to `undefined` (default) to disable the
   *  fast-path - equivalent to exhaustive scan. */
  readonly hintStart?: number;
}

/** Find the gBaseStats table structurally. Returns the LONGEST
 *  convincing run, or null when no run clears `minSpeciesInTable`. */
export function scanBaseStatsTable(
  bytes: Uint8Array,
  opts?: ScanBaseStatsOptions,
): BaseStatsTable | null {
  const minSpeciesInTable = opts?.minSpeciesInTable ?? BASE_STATS_SCAN_MIN_RECORDS;
  const maxSpeciesInTable = opts?.maxSpeciesInTable ?? BASE_STATS_SCAN_MAX_RECORDS;
  if (!Number.isInteger(minSpeciesInTable) || minSpeciesInTable < 1) {
    throw new Error(
      `minSpeciesInTable must be a positive integer, got ${String(minSpeciesInTable)}`,
    );
  }
  if (
    !Number.isInteger(maxSpeciesInTable) ||
    maxSpeciesInTable < minSpeciesInTable
  ) {
    throw new Error(
      `maxSpeciesInTable must be >= minSpeciesInTable, got ${String(maxSpeciesInTable)}`,
    );
  }

  // Fast-path: caller passed a hint. Try it directly.
  if (opts?.hintStart !== undefined && opts.hintStart >= 0) {
    const hint = tryParseRun(bytes, opts.hintStart, maxSpeciesInTable);
    if (hint.realCount >= minSpeciesInTable) {
      return makeTable(hint.firstRealOffset, hint.records);
    }
  }

  // Exhaustive scan: walk every 4-byte aligned position, keep the
  // longest convincing run. Skip past accepted runs so we don't
  // re-discover the same table at sub-stride offsets.
  let best: { start: number; records: BaseStats[] } | null = null;
  const stride = 4;
  const limit = bytes.length - BASE_STATS_STRUCT_SIZE_BYTES;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    // Fast pre-check: the strongest single signal for a real BaseStats
    // is `bytes[start + 0x1A] === 0 && bytes[start + 0x1B] === 0`.
    // Bail immediately if either is non-zero before the full parse.
    if (
      bytes[candidateStart + 0x1a] !== 0 ||
      bytes[candidateStart + 0x1b] !== 0
    ) {
      continue;
    }
    const run = tryParseRun(bytes, candidateStart, maxSpeciesInTable);
    // Reject pure-sentinel runs: require minSpeciesInTable REAL
    // (parseBaseStats-valid) records, not just placeholders.
    if (run.realCount >= minSpeciesInTable) {
      if (best === null || run.records.length > best.records.length) {
        best = { start: run.firstRealOffset, records: run.records };
      }
      // Skip past this run so we don't re-discover at offset+4, +8, ...
      // The next legitimate table can't start until after this one ends.
      const runEnd = run.firstRealOffset + run.records.length * BASE_STATS_STRUCT_SIZE_BYTES;
      candidateStart = runEnd - stride; // -stride because the for loop adds stride
    }
  }
  return best ? makeTable(best.start, best.records) : null;
}

/** Max sentinel slots that can appear consecutively before the run
 *  bails. Vanilla FRLG has 1 (SPECIES_NONE). Hacks that insert
 *  SPECIES_OLD_UNOWN_B..Z placeholders between Gen-2 and Gen-3 can
 *  have up to ~25 consecutive sentinels. 40 is generous; beyond that
 *  we're almost certainly walking an all-zero padding region. */
const CONSECUTIVE_SENTINEL_CAP = 40;

/** Walk consecutive 28-byte BaseStats records from `start`, stopping
 *  at the first parse failure or after `max` records. Sentinel slots
 *  (SPECIES_NONE-style all-zero records) are accepted as part of a
 *  run but treated as placeholder records - the run keeps growing
 *  through them so the scanner can land on the table's true first
 *  byte. A consecutive-sentinel cap prevents walking through all-
 *  zero padding regions. Returns the records + a count of how many
 *  are REAL (non-sentinel) so the caller can reject pure-sentinel
 *  runs against `minSpeciesInTable`. */
function tryParseRun(
  bytes: Uint8Array,
  start: number,
  max: number,
): { records: BaseStats[]; realCount: number; firstRealOffset: number } {
  const records: BaseStats[] = [];
  let realCount = 0;
  let consecutiveSentinels = 0;
  let cursor = start;
  while (records.length < max) {
    if (cursor + BASE_STATS_STRUCT_SIZE_BYTES > bytes.length) break;
    const r = parseBaseStats(bytes, cursor);
    if (r.ok) {
      records.push(r.baseStats);
      realCount++;
      consecutiveSentinels = 0;
    } else if (
      r.failure.kind === 'all_zero_stats' &&
      isSentinelBaseStatsSlot(bytes, cursor)
    ) {
      consecutiveSentinels++;
      if (consecutiveSentinels > CONSECUTIVE_SENTINEL_CAP) break;
      records.push(sentinelBaseStatsRecord(bytes, cursor));
    } else {
      break;
    }
    cursor += BASE_STATS_STRUCT_SIZE_BYTES;
  }
  // Trim trailing sentinels - a real gBaseStats run ends with a real
  // species, not with placeholder padding.
  while (
    records.length > 0 &&
    isAllZeroRecord(records[records.length - 1]!)
  ) {
    records.pop();
  }
  // Decide whether to keep leading sentinels. Vanilla FRLG keeps
  // SPECIES_NONE (all-zero) at index 0; that's a REAL leading
  // sentinel - the canonical table-start offset includes it. But the
  // scanner can also START its walk in an all-zero ROM region (or in
  // a test fixture's all-zero prefix) and walk INTO the real records
  // - in that case the leading sentinels are incidental and trimming
  // them gives the right `tableStart`.
  //
  // Discriminator: look at the 16 bytes immediately before the first
  // walked record. If any of those bytes is non-zero, the table TRULY
  // starts there (the leading sentinel is the canonical SPECIES_NONE).
  // If all 16 are zero, the all-zero region extends further back and
  // the leading sentinels are incidental - trim them.
  if (records.length > 0 && isAllZeroRecord(records[0]!)) {
    const firstWalkedOffset = records[0]!.fileOffset;
    if (!isRealTableBoundary(bytes, firstWalkedOffset)) {
      // Incidental zero prefix - trim all leading sentinels.
      while (records.length > 0 && isAllZeroRecord(records[0]!)) {
        records.shift();
      }
    }
    // else: keep leading sentinels (real SPECIES_NONE).
  }
  const firstRealOffset =
    records.length > 0 ? records[0]!.fileOffset : start;
  return { records, realCount, firstRealOffset };
}

function isAllZeroRecord(r: BaseStats): boolean {
  return (
    r.baseHP === 0 &&
    r.baseAttack === 0 &&
    r.baseDefense === 0 &&
    r.baseSpeed === 0 &&
    r.baseSpAttack === 0 &&
    r.baseSpDefense === 0
  );
}

function makeTable(start: number, records: BaseStats[]): BaseStatsTable {
  return Object.freeze({
    tableStart: start,
    tableEndExclusive: start + records.length * BASE_STATS_STRUCT_SIZE_BYTES,
    speciesCount: records.length,
    records: Object.freeze(records),
  });
}
