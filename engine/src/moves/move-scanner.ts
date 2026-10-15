/**
 * Gen-3 gBattleMoves table scanner.
 *
 * Scans a ROM buffer for runs of consecutive valid `BattleMove`
 * entries at the documented 12-byte stride. Returns the LONGEST run
 * found that exceeds the minimum-records threshold.
 *
 * PD 5: signature-driven, no baked offsets. Works on any Gen-3 cart
 * (vanilla + every hack that retains the BattleMove struct layout).
 *
 * PD 1: returns `null` (and the detector wraps as `not_detected` with
 * reason) when no run clears the threshold. The orchestrator never
 * sees a fake-positive.
 */

import {
  BATTLE_MOVE_STRUCT_SIZE_BYTES,
  parseBattleMove,
  type BattleMove,
} from './move.js';

/** Minimum consecutive move-table records to accept as a real table.
 *  Lower than vanilla 354 to tolerate hacks that shrink the table;
 *  higher than incidental matches to avoid false positives. */
export const BATTLE_MOVES_SCAN_MIN_RECORDS = 80;

/** Minimum NON-SENTINEL (populated) moves the run must contain.
 *  Without this guard, a zero-filled buffer region would be accepted as
 *  a giant run of MOVE_NONE sentinels (every 12-byte slice of zeros
 *  parses as valid sentinel). Real move tables have the leading
 *  sentinel + many populated entries; this floor rejects all-zero
 *  false-positive regions. */
export const BATTLE_MOVES_SCAN_MIN_POPULATED = 50;

/** Maximum records ever read in a single scan (defensive cap; a hack
 *  claiming 100k moves is corrupt). */
export const BATTLE_MOVES_SCAN_MAX_RECORDS = 4096;

/** Scan stride - we only check 4-byte-aligned offsets since GBA structs
 *  align on 4-byte boundaries by convention. */
const SCAN_STRIDE_BYTES = 4;

export interface BattleMovesTable {
  /** First-byte offset of the table in the ROM. */
  readonly tableStart: number;
  /** Exclusive end offset (= tableStart + recordCount × 12). */
  readonly tableEndExclusive: number;
  /** Number of consecutive valid move entries (includes the leading
   *  MOVE_NONE sentinel if present). */
  readonly moveCount: number;
  /** Iter 99 (UW-3-T18) - parsed BattleMove records in table-index
   *  order (MOVE_NONE sentinel at index 0). Each entry carries
   *  effect/power/type/accuracy/pp/secondaryEffectChance/target/
   *  priority/flags for the binary-rom lifter, plus the Gen-3 damage
   *  class derived from type + power. */
  readonly moves: ReadonlyArray<BattleMove>;
}

export interface ScanBattleMovesOptions {
  readonly minRecords?: number;
  readonly minPopulated?: number;
  readonly maxRecords?: number;
}

/**
 * Find the largest run of consecutive valid BattleMove entries in
 * `bytes`. Returns the run's metadata or `null` if no run clears the
 * minimum-records threshold.
 *
 * Algorithm: walk byte-by-byte at 4-byte stride; at each offset try
 * to parse a BattleMove; if valid, count how many consecutive valid
 * entries follow; remember the longest run.
 */
export function scanBattleMovesTable(
  bytes: Uint8Array,
  opts?: ScanBattleMovesOptions,
): BattleMovesTable | null {
  const minRecords = opts?.minRecords ?? BATTLE_MOVES_SCAN_MIN_RECORDS;
  const minPopulated = opts?.minPopulated ?? BATTLE_MOVES_SCAN_MIN_POPULATED;
  const maxRecords = opts?.maxRecords ?? BATTLE_MOVES_SCAN_MAX_RECORDS;
  if (bytes.length < minRecords * BATTLE_MOVE_STRUCT_SIZE_BYTES) {
    return null;
  }

  let bestStart = -1;
  let bestCount = 0;
  let bestPopulated = 0;

  // Skip the GBA cartridge header (first 192 bytes) - never a move
  // table per the platform's hardware spec.
  const SCAN_BODY_OFFSET = 0xc0;
  // Last possible start offset for a `minRecords`-long table:
  const maxScanOffset =
    bytes.length - minRecords * BATTLE_MOVE_STRUCT_SIZE_BYTES;

  for (let offset = SCAN_BODY_OFFSET; offset <= maxScanOffset; offset += SCAN_STRIDE_BYTES) {
    // Try to parse the first entry. Anchor on a POPULATED move (not a
    // sentinel) so zero-filled buffer regions don't trigger false-
    // positive long sentinel runs. Real move tables have the leading
    // MOVE_NONE sentinel followed immediately by populated moves; we
    // anchor on the first populated entry then count forward AND
    // backward to find the full run extent.
    const first = parseBattleMove(bytes, offset);
    if (!first.ok || first.isEmptySentinel) continue;
    // Count consecutive valid entries forward (including non-sentinels
    // AND any trailing sentinels within the same run).
    let forwardCount = 1;
    let populated = 1;
    while (forwardCount < maxRecords) {
      const next = parseBattleMove(
        bytes,
        offset + forwardCount * BATTLE_MOVE_STRUCT_SIZE_BYTES,
      );
      if (!next.ok) break;
      forwardCount++;
      if (!next.isEmptySentinel) populated++;
    }
    // Count BACKWARD through at most ONE sentinel - real move tables
    // include exactly one leading sentinel at index 0 (MOVE_NONE).
    // Walking further backward through a zero-filled buffer would
    // produce false-positive huge moveCounts.
    let backwardCount = 0;
    const backOffset = offset - BATTLE_MOVE_STRUCT_SIZE_BYTES;
    if (backOffset >= SCAN_BODY_OFFSET) {
      const prev = parseBattleMove(bytes, backOffset);
      if (prev.ok && prev.isEmptySentinel) {
        backwardCount = 1;
      }
    }
    const totalCount = forwardCount + backwardCount;
    if (totalCount > bestCount && populated >= minPopulated) {
      bestCount = totalCount;
      bestPopulated = populated;
      bestStart = offset - backwardCount * BATTLE_MOVE_STRUCT_SIZE_BYTES;
      // Optimization: skip past this run before continuing the outer
      // scan.
      offset += (forwardCount - 1) * BATTLE_MOVE_STRUCT_SIZE_BYTES;
    }
  }

  if (bestCount < minRecords || bestPopulated < minPopulated) return null;
  // Iter 99 - re-parse the accepted run to expose the full per-move
  // data. Lifter consumes battleMovesTable.moves[] for per-move power/
  // accuracy/pp/type/effect/etc. instead of just summary counts.
  const moves: BattleMove[] = [];
  for (let i = 0; i < bestCount; i++) {
    const r = parseBattleMove(
      bytes,
      bestStart + i * BATTLE_MOVE_STRUCT_SIZE_BYTES,
    );
    if (!r.ok) break;
    moves.push(r.move);
  }
  return {
    tableStart: bestStart,
    tableEndExclusive: bestStart + bestCount * BATTLE_MOVE_STRUCT_SIZE_BYTES,
    moveCount: bestCount,
    moves: Object.freeze(moves),
  };
}
