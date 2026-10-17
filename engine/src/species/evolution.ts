/**
 * Gen-3 Evolution + per-species evolution block parsers - Phase 8 P8-T4.
 *
 * Per pret/pokefirered (`include/pokemon.h`), pret/pokeemerald and
 * pret/pokeruby (all three byte-identical), each `Evolution` slot is
 * SIX bytes - three u16 fields and nothing else:
 *
 *   struct Evolution {
 *     u16 method;          // 0x00 - EVO_* method code
 *     u16 param;           // 0x02 - method-dependent (level, item, etc.)
 *     u16 targetSpecies;   // 0x04 - species index post-evolution
 *   };  // 6 bytes
 *
 * There is no padding field: every member is a u16, so the struct's
 * alignment is 2 and its size is 6 with no tail padding. The table is
 *
 *   const struct Evolution gEvolutionTable[NUM_SPECIES][EVOS_PER_MON];
 *
 * with `EVOS_PER_MON = 5` (`include/constants/pokemon.h`, both games), so
 * each per-species block is 5 × 6 = 30 bytes and the array stride is 30.
 *
 * The previous revision of this module modelled a phantom `u16 _padding`
 * at 0x06 (8-byte slot / 40-byte block). That field does not exist in any
 * Gen-3 family, so on a real ROM the reader consumed the next slot's
 * `method` as "padding" and rejected every populated block; the scanner
 * therefore never found gEvolutionTable. Verified against the three pret
 * headers above and against pret's `evolution.h` table data.
 *
 * EVO_NONE (method == 0) marks an empty slot - vanilla species like
 * Tauros or the legendaries have ALL 5 slots EVO_NONE (block is all-zero
 * = legitimate "no evolutions").
 *
 * Vanilla method codes (FireRed/Emerald, include/constants/pokemon.h):
 *   EVO_NONE                = 0
 *   EVO_FRIENDSHIP          = 1
 *   EVO_FRIENDSHIP_DAY      = 2
 *   EVO_FRIENDSHIP_NIGHT    = 3
 *   EVO_LEVEL               = 4
 *   EVO_TRADE               = 5
 *   EVO_TRADE_ITEM          = 6
 *   EVO_ITEM                = 7
 *   EVO_LEVEL_ATK_GT_DEF    = 8
 *   EVO_LEVEL_ATK_EQ_DEF    = 9
 *   EVO_LEVEL_ATK_LT_DEF    = 10
 *   EVO_LEVEL_SILCOON       = 11
 *   EVO_LEVEL_CASCOON       = 12
 *   EVO_LEVEL_NINJASK       = 13
 *   EVO_LEVEL_SHEDINJA      = 14
 *   EVO_BEAUTY              = 15
 *
 * CFRU + expansion frameworks add Mega-stone / item-hold / move-known
 * / map-based methods extending the range. Cap at 50 to tolerate
 * heavy hacks while still rejecting random 0xFFFF garbage as method.
 *
 * Detection signature for a single Evolution slot:
 *   - method ≤ EVOLUTION_METHOD_MAX (50)
 *   - targetSpecies ≤ EVOLUTION_SPECIES_MAX (2048)
 *   - if method == 0 (EVO_NONE), the entire 6 bytes MUST be 0
 *     (this catches garbage that happens to have method=0)
 *   - if method != 0, targetSpecies must be ≥ 1
 *
 * Per-species block (30 bytes) accepts a block iff every one of the
 * 5 slots passes the slot signature. An all-zero block (every slot
 * EVO_NONE) is the most common case in vanilla - legitimate.
 *
 * False-positive rate per random 30-byte slice: combined slot
 * signature + per-block 5×6 alignment + species-id bounds yields
 * <1e-15 per slice. A run of ≥ 8 consecutive valid blocks is
 * essentially certain to be the real gEvolutionTable.
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart
 * whose Evolution struct retains the published layout.
 */

export const EVOLUTION_STRUCT_SIZE_BYTES = 6;
export const EVOLUTION_SLOTS_PER_SPECIES = 5;
export const EVOLUTION_BLOCK_SIZE_BYTES =
  EVOLUTION_SLOTS_PER_SPECIES * EVOLUTION_STRUCT_SIZE_BYTES; // 30
/** Highest plausible method code. Vanilla maxes 15; expansion
 *  frameworks add Mega / item-hold / move-known / map-based methods
 *  but rarely exceed ~30. 50 caps random 0xFFFF as method. */
export const EVOLUTION_METHOD_MAX = 50;
/** Highest plausible target species index. Vanilla 411; CFRU /
 *  expansion 700+; 2048 captures known heavy hacks. */
export const EVOLUTION_SPECIES_MAX = 2048;

/** Code 0 = EVO_NONE - the empty-slot marker. */
export const EVO_NONE = 0;

export interface Evolution {
  readonly method: number;
  readonly param: number;
  readonly targetSpecies: number;
  /** True iff method == 0 AND the rest of the slot is zero. */
  readonly isEmpty: boolean;
  /** ROM file offset of this 6-byte slot. */
  readonly fileOffset: number;
}

export interface EvolutionBlock {
  /** All 5 slots (some/all may be empty per `isEmpty`). */
  readonly slots: ReadonlyArray<Evolution>;
  /** Slots filtered to method != EVO_NONE. */
  readonly populatedSlots: ReadonlyArray<Evolution>;
  /** ROM file offset of this 30-byte per-species block. */
  readonly fileOffset: number;
}

export type EvolutionParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_method'; observed: number; max: number }
  | { kind: 'implausible_species'; observed: number; max: number }
  | { kind: 'malformed_empty_slot'; method: number; param: number; targetSpecies: number };

export type EvolutionParseResult =
  | { ok: true; evolution: Evolution }
  | { ok: false; failure: EvolutionParseFailure };

export type EvolutionBlockParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | {
      kind: 'slot_failure';
      slotIndex: number;
      slotFailure: EvolutionParseFailure;
    };

export type EvolutionBlockParseResult =
  | { ok: true; block: EvolutionBlock }
  | { ok: false; failure: EvolutionBlockParseFailure };

/** Parse a single 6-byte Evolution slot. */
export function parseEvolutionSlot(
  bytes: Uint8Array,
  offset: number,
): EvolutionParseResult {
  if (offset < 0 || offset + EVOLUTION_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: EVOLUTION_STRUCT_SIZE_BYTES,
      },
    };
  }

  const method = readUint16Le(bytes, offset + 0x00);
  const param = readUint16Le(bytes, offset + 0x02);
  const targetSpecies = readUint16Le(bytes, offset + 0x04);

  // 1. method bound.
  if (method > EVOLUTION_METHOD_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_method', observed: method, max: EVOLUTION_METHOD_MAX },
    };
  }
  // 2. species bound (0 = SPECIES_NONE = legitimate for EVO_NONE slots).
  if (targetSpecies > EVOLUTION_SPECIES_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_species', observed: targetSpecies, max: EVOLUTION_SPECIES_MAX },
    };
  }
  // 3. EVO_NONE → param and targetSpecies must also be 0.
  if (method === EVO_NONE) {
    if (param !== 0 || targetSpecies !== 0) {
      return {
        ok: false,
        failure: { kind: 'malformed_empty_slot', method, param, targetSpecies },
      };
    }
  } else {
    // Non-empty slot - must have a valid post-evolution species (≥ 1).
    if (targetSpecies === 0) {
      return {
        ok: false,
        failure: { kind: 'malformed_empty_slot', method, param, targetSpecies },
      };
    }
  }

  return {
    ok: true,
    evolution: Object.freeze({
      method,
      param,
      targetSpecies,
      isEmpty: method === EVO_NONE,
      fileOffset: offset,
    }),
  };
}

/** Parse a per-species evolution block (5 × Evolution = 30 bytes). */
export function parseEvolutionBlock(
  bytes: Uint8Array,
  offset: number,
): EvolutionBlockParseResult {
  if (offset < 0 || offset + EVOLUTION_BLOCK_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: EVOLUTION_BLOCK_SIZE_BYTES,
      },
    };
  }

  const slots: Evolution[] = [];
  for (let i = 0; i < EVOLUTION_SLOTS_PER_SPECIES; i++) {
    const slotOffset = offset + i * EVOLUTION_STRUCT_SIZE_BYTES;
    const r = parseEvolutionSlot(bytes, slotOffset);
    if (!r.ok) {
      return { ok: false, failure: { kind: 'slot_failure', slotIndex: i, slotFailure: r.failure } };
    }
    slots.push(r.evolution);
  }

  const populatedSlots = slots.filter((s) => !s.isEmpty);
  return {
    ok: true,
    block: Object.freeze({
      slots: Object.freeze(slots),
      populatedSlots: Object.freeze(populatedSlots),
      fileOffset: offset,
    }),
  };
}

/** Encode a 30-byte per-species evolution block from up to 5 slots.
 *
 *  The inverse of `parseEvolutionBlock` for the on-disk layout: writes
 *  each slot's three u16 fields at a 6-byte stride and leaves the
 *  remaining slots as all-zero EVO_NONE terminators. Callers that need
 *  to write evolution data (the binary-ROM writers) use this instead of
 *  hand-rolling offsets, so the writer can never drift from the reader.
 */
export function encodeEvolutionBlock(
  slots: ReadonlyArray<{ method: number; param: number; targetSpecies: number }>,
): Uint8Array {
  if (slots.length > EVOLUTION_SLOTS_PER_SPECIES) {
    throw new Error(
      `at most ${String(EVOLUTION_SLOTS_PER_SPECIES)} evolution slots per species, got ${String(slots.length)}`,
    );
  }
  const out = new Uint8Array(EVOLUTION_BLOCK_SIZE_BYTES);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const at = i * EVOLUTION_STRUCT_SIZE_BYTES;
    writeUint16Le(out, at + 0x00, s.method);
    writeUint16Le(out, at + 0x02, s.param);
    writeUint16Le(out, at + 0x04, s.targetSpecies);
  }
  return out;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function writeUint16Le(out: Uint8Array, offset: number, value: number): void {
  out[offset + 0] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}
