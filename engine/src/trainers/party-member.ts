/**
 * Gen-3 TrainerPartyMember struct parser - iter 107 / UW-3-T26.
 *
 * Per pret/pokefirered (`include/battle.h`) and pret/pokeemerald, each
 * trainer's party is a variable-length array of party-member structs.
 * The struct shape depends on the trainer's `partyFlags` byte (bits 0+1):
 *
 *   bit 0 = F_TRAINER_PARTY_CUSTOM_MOVESET (each member has 4 custom moves)
 *   bit 1 = F_TRAINER_PARTY_HELD_ITEM      (each member has a held item)
 *
 * All four variants share the same leading layout. The level is a *single
 * byte* (`u8 lvl`) at +0x02; the byte at +0x03 is compiler padding before
 * the 2-byte-aligned `u16 species` at +0x04. That padding is why the struct
 * sizes are not multiples of four:
 *
 *   flags 0 - TrainerMonNoItemDefaultMoves {        // 6 bytes
 *     u16 iv;       // 0x00
 *     u8  lvl;      // 0x02
 *     u8  _pad;     // 0x03  (alignment)
 *     u16 species;  // 0x04
 *   };
 *
 *   flags 2 - TrainerMonItemDefaultMoves {          // 8 bytes
 *     u16 iv;       // 0x00
 *     u8  lvl;      // 0x02
 *     u8  _pad;     // 0x03
 *     u16 species;  // 0x04
 *     u16 heldItem; // 0x06
 *   };
 *
 *   flags 1 - TrainerMonNoItemCustomMoves {         // 14 bytes
 *     u16 iv;       // 0x00
 *     u8  lvl;      // 0x02
 *     u8  _pad;     // 0x03
 *     u16 species;  // 0x04
 *     u16 moves[4]; // 0x06..0x0D
 *   };
 *
 *   flags 3 - TrainerMonItemCustomMoves {           // 16 bytes
 *     u16 iv;       // 0x00
 *     u8  lvl;      // 0x02
 *     u8  _pad;     // 0x03
 *     u16 species;  // 0x04
 *     u16 heldItem; // 0x06
 *     u16 moves[4]; // 0x08..0x0F
 *   };
 *
 * The sizes above were confirmed with a C compiler against the exact pret
 * declarations (`sizeof` 6 / 8 / 14 / 16; `lvl` at offset 2 as u8). Getting
 * the *stride* right matters as much as the field offsets: the array walk
 * advances by the per-variant size, and flags 0 (the vanilla default) is 6
 * bytes, not 8.
 *
 * PD 5: structural-only - no baked species/move/item counts; works on
 * vanilla + every hack that retains the 4-variant layout.
 *
 * Validation per parsed member:
 *   - level in [1, 100] (engine spec; some Gen-3 hacks raise the cap but
 *     vanilla caps at 100 and trainer parties never exceed it)
 *   - iv ≤ 255 (vanilla spec; IV compaction byte)
 *   - species ≤ 2000 (cap covers Radical Red 800+, Unbound 1000+; rejects
 *     obviously-corrupt random bytes)
 *   - moves[i] ≤ 2000 (same cap reasoning)
 */

/** partyFlags bit 0 - each member carries 4 custom moves. */
export const PARTY_FLAG_CUSTOM_MOVESET = 0x01;
/** partyFlags bit 1 - each member carries a held item. */
export const PARTY_FLAG_HELD_ITEM = 0x02;

/** flags 0 - `struct TrainerMonNoItemDefaultMoves`. */
export const PARTY_MEMBER_SIZE_BYTES_NO_ITEM_DEFAULT_MOVES = 6;
/** flags 2 - `struct TrainerMonItemDefaultMoves`. */
export const PARTY_MEMBER_SIZE_BYTES_ITEM_DEFAULT_MOVES = 8;
/** flags 1 - `struct TrainerMonNoItemCustomMoves`. */
export const PARTY_MEMBER_SIZE_BYTES_NO_ITEM_CUSTOM_MOVES = 14;
/** flags 3 - `struct TrainerMonItemCustomMoves`. */
export const PARTY_MEMBER_SIZE_BYTES_ITEM_CUSTOM_MOVES = 16;

/** Highest plausible species id (covers Radical Red + Unbound; rejects
 *  random garbage). */
export const PARTY_MEMBER_SPECIES_MAX = 2000;

/** Highest plausible level. */
export const PARTY_MEMBER_LEVEL_MAX = 100;

/** Highest plausible IV-compaction byte. */
export const PARTY_MEMBER_IV_MAX = 255;

/** Field offsets shared by every variant (see the module header). */
const OFFSET_IV = 0x00;
const OFFSET_LEVEL = 0x02; // u8
const OFFSET_SPECIES = 0x04; // u16
const OFFSET_HELD_ITEM = 0x06; // u16, present only when PARTY_FLAG_HELD_ITEM
const OFFSET_MOVES_NO_ITEM = 0x06; // u16[4], when moves present without an item
const OFFSET_MOVES_WITH_ITEM = 0x08; // u16[4], when moves present with an item

/** Per the 4 variants. */
export type TrainerPartyMemberKind = 0 | 1 | 2 | 3;

export interface TrainerPartyMemberParsed {
  readonly iv: number;
  readonly level: number;
  readonly species: number;
  /** Held item id (0 when the member's variant has no held-item slot). */
  readonly heldItem: number;
  /** 4 move ids in order (all 0 when no custom moveset). */
  readonly moves: ReadonlyArray<number>;
  /** Absolute file offset of this member struct. */
  readonly fileOffset: number;
  /** Member-struct kind (matches partyFlags 0..3). */
  readonly kind: TrainerPartyMemberKind;
}

export type TrainerPartyMemberParseFailure =
  | { readonly kind: 'too_short'; readonly bytesAvailable: number; readonly bytesRequired: number }
  | { readonly kind: 'invalid_level'; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_iv'; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_species'; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_move'; readonly slot: number; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_party_flags'; readonly observed: number };

export type TrainerPartyMemberParseResult =
  | { readonly ok: true; readonly member: TrainerPartyMemberParsed }
  | { readonly ok: false; readonly failure: TrainerPartyMemberParseFailure };

/** Compute the per-member struct size given the trainer's partyFlags.
 *  Only bit 0 (custom moveset) changes the size class; bit 1 (held item)
 *  swaps the +0x06 slot between padding and an item id and shifts the
 *  moves block, but never changes the total. */
export function partyMemberStructSize(partyFlags: number): number {
  const hasMoves = (partyFlags & PARTY_FLAG_CUSTOM_MOVESET) !== 0;
  const hasItem = (partyFlags & PARTY_FLAG_HELD_ITEM) !== 0;
  if (hasMoves && hasItem) return PARTY_MEMBER_SIZE_BYTES_ITEM_CUSTOM_MOVES;
  if (hasMoves) return PARTY_MEMBER_SIZE_BYTES_NO_ITEM_CUSTOM_MOVES;
  if (hasItem) return PARTY_MEMBER_SIZE_BYTES_ITEM_DEFAULT_MOVES;
  return PARTY_MEMBER_SIZE_BYTES_NO_ITEM_DEFAULT_MOVES;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** Parse one party-member struct at `bytes[offset..offset + size]`.
 *  `partyFlags` (0..3) selects the struct variant. */
export function parseTrainerPartyMember(
  bytes: Uint8Array,
  offset: number,
  partyFlags: number,
): TrainerPartyMemberParseResult {
  if (partyFlags < 0 || partyFlags > 3) {
    return { ok: false, failure: { kind: 'invalid_party_flags', observed: partyFlags } };
  }
  const structSize = partyMemberStructSize(partyFlags);
  if (offset < 0 || offset + structSize > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: structSize,
      },
    };
  }
  const iv = readU16LE(bytes, offset + OFFSET_IV);
  if (iv > PARTY_MEMBER_IV_MAX) {
    return { ok: false, failure: { kind: 'invalid_iv', observed: iv, max: PARTY_MEMBER_IV_MAX } };
  }
  // Level is a single byte at +0x02; the following byte is alignment padding.
  const level = bytes[offset + OFFSET_LEVEL] ?? 0;
  if (level < 1 || level > PARTY_MEMBER_LEVEL_MAX) {
    return {
      ok: false,
      failure: { kind: 'invalid_level', observed: level, max: PARTY_MEMBER_LEVEL_MAX },
    };
  }
  const species = readU16LE(bytes, offset + OFFSET_SPECIES);
  if (species > PARTY_MEMBER_SPECIES_MAX) {
    return {
      ok: false,
      failure: { kind: 'invalid_species', observed: species, max: PARTY_MEMBER_SPECIES_MAX },
    };
  }
  const hasItem = (partyFlags & PARTY_FLAG_HELD_ITEM) !== 0;
  // The +0x06 slot is a real item id only when bit 1 is set; otherwise it
  // is padding (flags 0) or the first custom move (flags 1).
  const heldItem = hasItem ? readU16LE(bytes, offset + OFFSET_HELD_ITEM) : 0;
  const hasMoves = (partyFlags & PARTY_FLAG_CUSTOM_MOVESET) !== 0;
  const moves: number[] = [];
  if (hasMoves) {
    // Moves sit at +0x06 when there is no item, +0x08 when the item slot
    // occupies +0x06.
    const movesBase = hasItem ? OFFSET_MOVES_WITH_ITEM : OFFSET_MOVES_NO_ITEM;
    for (let i = 0; i < 4; i++) {
      const m = readU16LE(bytes, offset + movesBase + i * 2);
      if (m > PARTY_MEMBER_SPECIES_MAX) {
        return {
          ok: false,
          failure: { kind: 'invalid_move', slot: i, observed: m, max: PARTY_MEMBER_SPECIES_MAX },
        };
      }
      moves.push(m);
    }
  }
  return {
    ok: true,
    member: {
      iv,
      level,
      species,
      heldItem,
      moves: Object.freeze(moves),
      fileOffset: offset,
      kind: partyFlags as TrainerPartyMemberKind,
    },
  };
}

/** Convenience: parse `partySize` consecutive members starting at
 *  `arrayStartOffset`. Bails on first parse failure and returns what was
 *  successfully parsed plus the failure reason. */
export function parseTrainerPartyArray(
  bytes: Uint8Array,
  arrayStartOffset: number,
  partyFlags: number,
  partySize: number,
): {
  readonly members: ReadonlyArray<TrainerPartyMemberParsed>;
  readonly failureAtIndex: number | null;
  readonly failureReason: TrainerPartyMemberParseFailure | null;
} {
  const structSize = partyMemberStructSize(partyFlags);
  const members: TrainerPartyMemberParsed[] = [];
  for (let i = 0; i < partySize; i++) {
    const memberOffset = arrayStartOffset + i * structSize;
    const r = parseTrainerPartyMember(bytes, memberOffset, partyFlags);
    if (!r.ok) {
      return {
        members: Object.freeze(members),
        failureAtIndex: i,
        failureReason: r.failure,
      };
    }
    members.push(r.member);
  }
  return {
    members: Object.freeze(members),
    failureAtIndex: null,
    failureReason: null,
  };
}
