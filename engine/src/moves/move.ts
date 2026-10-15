/**
 * Gen-3 BattleMove struct parser - Phase UW-2 / Category 2+4 substrate.
 *
 * Per pret/pokefirered + pret/pokeemerald `include/pokemon.h`, every move
 * (vanilla 354 + Struggle, heavy-hacks like Radical Red can expand to
 * 800+) has a 12-byte entry in a flat `gBattleMoves` array. Layout:
 *
 *   struct BattleMove {
 *     u8  effect;        // 0x00 - move-effect ID (0..n, 0..213 vanilla)
 *     u8  power;         // 0x01 - base power (0..250 typically; 0=non-damaging)
 *     u8  type;          // 0x02 - 0..17 in vanilla Gen-3 (18 types)
 *     u8  accuracy;      // 0x03 - 0..100 (0 = never miss, e.g. Swift)
 *     u8  pp;            // 0x04 - base PP (1..40)
 *     u8  secondaryEffectChance;  // 0x05 - 0..100
 *     u8  target;        // 0x06 - MOVE_TARGET_* (0..0x80 bitmask)
 *     i8  priority;      // 0x07 - signed (-7..+5 typically)
 *     u8  flags;         // 0x08 - bitmask (FLAG_MAKES_CONTACT etc.)
 *     u8  padding[3];    // 0x09..0x0B - all three MUST be 0x00
 *   };  // 12 bytes
 *
 * The decomp declares only those nine one-byte fields; the retail carts
 * carry a 12-byte record because the structure is padded out to a multiple
 * of 4. Bulbapedia's "Move data structure (Generation III)" documents the
 * same shape (padding = 3 bytes at offset 9, "each one of those bytes
 * should be set to 0x00") and gives the retail POUND fingerprint
 * `00 28 00 64 23 00 00 00 33 00 00 00` - flags at 0x08 = 0x33 followed by
 * three zero bytes at 0x09..0x0B.
 *
 * Gen-3 has NO stored per-move damage class: physical vs special is decided
 * by the move's TYPE (Fire/Water/Grass/Electric/Psychic/Ice/Dragon/Dark are
 * special; Normal/Fighting/Flying/Poison/Ground/Rock/Bug/Ghost/Steel are
 * physical; a 0-power move is a status move). The `split` field exposed
 * below is therefore DERIVED from `type` + `power` via the shared
 * `deriveGen3MoveSplit` helper - it is never read out of the struct, and
 * byte 0x09 is validated as padding instead of being mislabelled as a
 * damage-class byte.
 *
 * Detection signature (per move):
 *   - `type` ≤ 17 (Gen-3 has 18 types; 0=Normal, 17=Dark)
 *   - `accuracy` ≤ 100
 *   - `secondaryEffectChance` ≤ 100
 *   - `pp` in [1, 40] (1=Sketch-like, 40=Sing-equivalent)
 *   - `priority` in [-7, +5] (signed byte; values 0xF9..0xFF or 0x00..0x05)
 *   - `power` ≤ 250 (a few effect-driven moves exceed nominal max; 250 cap
 *      excludes obviously-corrupt bytes)
 *   - `padding[0]` == 0, `padding[1]` == 0 and `padding[2]` == 0 (strongest
 *      signal - random bytes hit three-zero-padding only ~0.00002% of the
 *      time)
 *
 * Combined false-positive rate per random 12-byte slice: < 1 in 10^8
 * thanks to padding + type + accuracy + pp constraints. A run of ≥80
 * consecutive valid moves at the documented 12-byte stride is
 * essentially guaranteed real.
 *
 * Empty-move sentinel: every Gen-3 move table starts with a "MOVE_NONE"
 * entry (all zeros across all 12 bytes). The parser accepts all-zero
 * as valid sentinel; the scanner uses scanner-side logic to handle the
 * sentinel anchor.
 *
 * PD 5: structural-only - no baked move-table offsets; works on any
 * Gen-3 cart whose BattleMove struct retains the published layout.
 */

import { deriveGen3MoveSplit } from '../battle/damage.js';

/** Size of one Gen-3 BattleMove struct in bytes. */
export const BATTLE_MOVE_STRUCT_SIZE_BYTES = 12;

/** Maximum valid type byte (Gen-3 has 18 types: 0..17). */
export const BATTLE_MOVE_TYPE_MAX = 17;

/** Maximum nominal power byte (some effect-driven moves exceed this in
 *  practice; the parser caps at this for false-positive rejection). */
export const BATTLE_MOVE_POWER_MAX = 250;

/** Maximum accuracy byte (0 = never miss / always-hits sentinel). */
export const BATTLE_MOVE_ACCURACY_MAX = 100;

/** Maximum secondary-effect chance byte. */
export const BATTLE_MOVE_EFFECT_CHANCE_MAX = 100;

/** Maximum PP value (vanilla cap is 40 for Sing-equivalent). */
export const BATTLE_MOVE_PP_MAX = 40;

/** Priority is signed; valid range is [-7, +5] across all known Gen-3
 *  moves (Spite/Trick at -7..-3, Quick Attack/Mach Punch at +1..+2,
 *  Helping Hand/Protect at +3..+5). */
export const BATTLE_MOVE_PRIORITY_MIN = -7;
export const BATTLE_MOVE_PRIORITY_MAX = 5;

/** Offset of the first of the three mandatory zero padding bytes. */
export const BATTLE_MOVE_PADDING_OFFSET = 0x09;
/** Number of trailing padding bytes in the 12-byte record (0x09..0x0B). */
export const BATTLE_MOVE_PADDING_BYTES = 3;

/** Gen-3 damage-class codes (the numeric convention the manifest uses). */
export const MOVE_SPLIT_STATUS = 0;
export const MOVE_SPLIT_PHYSICAL = 1;
export const MOVE_SPLIT_SPECIAL = 2;

/**
 * Map a move's `type` + `power` to the numeric Gen-3 damage class used by
 * the manifest/UI: 0 = status, 1 = physical, 2 = special. Thin numeric
 * wrapper over `deriveGen3MoveSplit` so callers never re-derive the
 * physical-type set.
 */
export function gen3DamageClassCode(type: number, power: number): number {
  switch (deriveGen3MoveSplit(type, power)) {
    case 'status':
      return MOVE_SPLIT_STATUS;
    case 'physical':
      return MOVE_SPLIT_PHYSICAL;
    default:
      return MOVE_SPLIT_SPECIAL;
  }
}

export interface BattleMove {
  readonly effect: number;
  readonly power: number;
  readonly type: number;
  readonly accuracy: number;
  readonly pp: number;
  readonly secondaryEffectChance: number;
  readonly target: number;
  readonly priority: number;
  readonly flags: number;
  /**
   * Gen-3 damage class, DERIVED from `type` + `power` (0 = status,
   * 1 = physical, 2 = special). Gen-3 decides the class by type, so there
   * is no byte to read; the struct's 0x09 byte is padding, not a split.
   */
  readonly split: number;
}

export type BattleMoveParseFailure =
  | { readonly kind: 'too_short'; readonly bytesAvailable: number; readonly bytesRequired: number }
  | { readonly kind: 'type_out_of_range'; readonly observedType: number; readonly maxAllowed: number }
  | { readonly kind: 'accuracy_out_of_range'; readonly observedAccuracy: number; readonly maxAllowed: number }
  | { readonly kind: 'effect_chance_out_of_range'; readonly observedChance: number; readonly maxAllowed: number }
  | { readonly kind: 'pp_out_of_range'; readonly observedPp: number; readonly maxAllowed: number }
  | { readonly kind: 'priority_out_of_range'; readonly observedPriority: number; readonly minAllowed: number; readonly maxAllowed: number }
  | { readonly kind: 'power_out_of_range'; readonly observedPower: number; readonly maxAllowed: number }
  | { readonly kind: 'padding_nonzero'; readonly paddingOffset: number; readonly observedByte: number };

export type BattleMoveParseResult =
  | { readonly ok: true; readonly move: BattleMove; readonly isEmptySentinel: boolean }
  | { readonly ok: false; readonly failure: BattleMoveParseFailure };

/**
 * Parse a 12-byte BattleMove struct at `bytes[offset..offset+12]`.
 * Returns ok=true with the parsed struct OR ok=false with a specific
 * failure reason (PD 1 - never empty-success / never typed-bare-null).
 *
 * All-zero entries are accepted as the canonical MOVE_NONE sentinel
 * (`isEmptySentinel: true`); the scanner uses this for table anchor.
 *
 * `move.split` is derived from `type` + `power`; the struct's 0x09..0x0B
 * bytes are validated as zero padding and never surfaced.
 */
export function parseBattleMove(bytes: Uint8Array, offset: number): BattleMoveParseResult {
  if (offset + BATTLE_MOVE_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: BATTLE_MOVE_STRUCT_SIZE_BYTES,
      },
    };
  }

  const effect = bytes[offset + 0]!;
  const power = bytes[offset + 1]!;
  const type = bytes[offset + 2]!;
  const accuracy = bytes[offset + 3]!;
  const pp = bytes[offset + 4]!;
  const secondaryEffectChance = bytes[offset + 5]!;
  const target = bytes[offset + 6]!;
  // priority is i8 (signed) - convert via `<<24 >>24` trick.
  const priorityUnsigned = bytes[offset + 7]!;
  const priority = (priorityUnsigned << 24) >> 24;
  const flags = bytes[offset + 8]!;
  const pad0 = bytes[offset + 9]!;
  const pad1 = bytes[offset + 10]!;
  const pad2 = bytes[offset + 11]!;

  const move: BattleMove = {
    effect,
    power,
    type,
    accuracy,
    pp,
    secondaryEffectChance,
    target,
    priority,
    flags,
    split: gen3DamageClassCode(type, power),
  };

  // All-zero entry = MOVE_NONE sentinel - accept it as valid.
  const isEmptySentinel =
    effect === 0 &&
    power === 0 &&
    type === 0 &&
    accuracy === 0 &&
    pp === 0 &&
    secondaryEffectChance === 0 &&
    target === 0 &&
    priorityUnsigned === 0 &&
    flags === 0 &&
    pad0 === 0 &&
    pad1 === 0 &&
    pad2 === 0;

  if (isEmptySentinel) {
    return { ok: true, move, isEmptySentinel: true };
  }

  // Strongest check: all three padding bytes zero.
  if (pad0 !== 0) {
    return { ok: false, failure: { kind: 'padding_nonzero', paddingOffset: 9, observedByte: pad0 } };
  }
  if (pad1 !== 0) {
    return { ok: false, failure: { kind: 'padding_nonzero', paddingOffset: 10, observedByte: pad1 } };
  }
  if (pad2 !== 0) {
    return { ok: false, failure: { kind: 'padding_nonzero', paddingOffset: 11, observedByte: pad2 } };
  }
  // Type ≤ 17.
  if (type > BATTLE_MOVE_TYPE_MAX) {
    return {
      ok: false,
      failure: { kind: 'type_out_of_range', observedType: type, maxAllowed: BATTLE_MOVE_TYPE_MAX },
    };
  }
  // Accuracy ≤ 100.
  if (accuracy > BATTLE_MOVE_ACCURACY_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'accuracy_out_of_range',
        observedAccuracy: accuracy,
        maxAllowed: BATTLE_MOVE_ACCURACY_MAX,
      },
    };
  }
  // Effect chance ≤ 100.
  if (secondaryEffectChance > BATTLE_MOVE_EFFECT_CHANCE_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'effect_chance_out_of_range',
        observedChance: secondaryEffectChance,
        maxAllowed: BATTLE_MOVE_EFFECT_CHANCE_MAX,
      },
    };
  }
  // PP in [1, 40] (0 PP is impossible for a usable move).
  if (pp < 1 || pp > BATTLE_MOVE_PP_MAX) {
    return {
      ok: false,
      failure: { kind: 'pp_out_of_range', observedPp: pp, maxAllowed: BATTLE_MOVE_PP_MAX },
    };
  }
  // Priority in [-7, +5].
  if (priority < BATTLE_MOVE_PRIORITY_MIN || priority > BATTLE_MOVE_PRIORITY_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'priority_out_of_range',
        observedPriority: priority,
        minAllowed: BATTLE_MOVE_PRIORITY_MIN,
        maxAllowed: BATTLE_MOVE_PRIORITY_MAX,
      },
    };
  }
  // Power ≤ 250.
  if (power > BATTLE_MOVE_POWER_MAX) {
    return {
      ok: false,
      failure: { kind: 'power_out_of_range', observedPower: power, maxAllowed: BATTLE_MOVE_POWER_MAX },
    };
  }

  return { ok: true, move, isEmptySentinel: false };
}
