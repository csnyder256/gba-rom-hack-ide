import { describe, expect, it } from 'vitest';
import {
  PARTY_FLAG_CUSTOM_MOVESET,
  PARTY_FLAG_HELD_ITEM,
  PARTY_MEMBER_SIZE_BYTES_ITEM_CUSTOM_MOVES,
  PARTY_MEMBER_SIZE_BYTES_ITEM_DEFAULT_MOVES,
  PARTY_MEMBER_SIZE_BYTES_NO_ITEM_CUSTOM_MOVES,
  PARTY_MEMBER_SIZE_BYTES_NO_ITEM_DEFAULT_MOVES,
  parseTrainerPartyArray,
  parseTrainerPartyMember,
  partyMemberStructSize,
} from './index.js';

/**
 * Struct builders for the real pret layout (include/battle.h):
 *   u16 iv @0x00, u8 lvl @0x02, u8 pad @0x03, u16 species @0x04, ...
 * Sizes: flags 0 → 6, flags 2 → 8, flags 1 → 14, flags 3 → 16.
 */
function writeShared(view: DataView, iv: number, level: number, species: number): void {
  view.setUint16(0x00, iv, true);
  view.setUint8(0x02, level); // u8 level
  view.setUint8(0x03, 0); // alignment padding
  view.setUint16(0x04, species, true);
}

/** flags 0 - TrainerMonNoItemDefaultMoves (6 bytes). */
function buildDefaultMoves(iv: number, level: number, species: number): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_NO_ITEM_DEFAULT_MOVES);
  const view = new DataView(buf.buffer);
  writeShared(view, iv, level, species);
  return buf;
}

/** flags 2 - TrainerMonItemDefaultMoves (8 bytes), heldItem @0x06. */
function buildItemDefaultMoves(
  iv: number,
  level: number,
  species: number,
  heldItem: number,
): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_ITEM_DEFAULT_MOVES);
  const view = new DataView(buf.buffer);
  writeShared(view, iv, level, species);
  view.setUint16(0x06, heldItem, true);
  return buf;
}

/** flags 1 - TrainerMonNoItemCustomMoves (14 bytes), moves @0x06. */
function buildCustomMoves(
  iv: number,
  level: number,
  species: number,
  moves: ReadonlyArray<number>,
): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_NO_ITEM_CUSTOM_MOVES);
  const view = new DataView(buf.buffer);
  writeShared(view, iv, level, species);
  for (let i = 0; i < 4; i++) view.setUint16(0x06 + i * 2, moves[i] ?? 0, true);
  return buf;
}

/** flags 3 - TrainerMonItemCustomMoves (16 bytes), heldItem @0x06, moves @0x08. */
function buildItemCustomMoves(
  iv: number,
  level: number,
  species: number,
  heldItem: number,
  moves: ReadonlyArray<number>,
): Uint8Array {
  const buf = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_ITEM_CUSTOM_MOVES);
  const view = new DataView(buf.buffer);
  writeShared(view, iv, level, species);
  view.setUint16(0x06, heldItem, true);
  for (let i = 0; i < 4; i++) view.setUint16(0x08 + i * 2, moves[i] ?? 0, true);
  return buf;
}

describe('partyMemberStructSize', () => {
  it('matches the pret struct sizes (6 / 8 / 14 / 16)', () => {
    expect(partyMemberStructSize(0)).toBe(6);
    expect(partyMemberStructSize(PARTY_FLAG_HELD_ITEM)).toBe(8);
    expect(partyMemberStructSize(PARTY_FLAG_CUSTOM_MOVESET)).toBe(14);
    expect(partyMemberStructSize(PARTY_FLAG_CUSTOM_MOVESET | PARTY_FLAG_HELD_ITEM)).toBe(16);
  });
});

describe('parseTrainerPartyMember', () => {
  it('parses a flags-0 member (no items, default moves)', () => {
    const bytes = buildDefaultMoves(31, 25, 25); // Pikachu lvl 25
    const r = parseTrainerPartyMember(bytes, 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.iv).toBe(31);
      expect(r.member.level).toBe(25);
      expect(r.member.species).toBe(25);
      expect(r.member.heldItem).toBe(0);
      expect(r.member.moves).toEqual([]);
      expect(r.member.kind).toBe(0);
    }
  });

  it('reads level as a single byte, ignoring the +0x03 padding byte', () => {
    const bytes = buildDefaultMoves(0, 42, 3);
    // Poison the alignment padding byte: a u16 read at +0x02 would fold
    // 0x99 into the level and overflow the 100 cap.
    bytes[0x03] = 0x99;
    const r = parseTrainerPartyMember(bytes, 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.member.level).toBe(42);
  });

  it('parses a flags-2 member (held item, default moves)', () => {
    const bytes = buildItemDefaultMoves(20, 50, 6, 42); // Charizard with item 42
    const r = parseTrainerPartyMember(bytes, 0, PARTY_FLAG_HELD_ITEM);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.heldItem).toBe(42);
      expect(r.member.moves).toEqual([]);
      expect(r.member.kind).toBe(2);
    }
  });

  it('parses a flags-1 member (custom moves, no item) with moves at +0x06', () => {
    // 14-byte struct plus two trailing bytes. A reader that mis-sized the
    // variant as 16 and took moves at +0x08 would read the 0xFFFF sentinel
    // past the struct and fail the move bound; the correct reader uses the
    // 14-byte size and moves at +0x06.
    const bytes = new Uint8Array(PARTY_MEMBER_SIZE_BYTES_NO_ITEM_CUSTOM_MOVES + 2);
    bytes.set(buildCustomMoves(15, 30, 9, [33, 55, 89, 22]), 0); // Blastoise
    bytes[0x0e] = 0xff;
    bytes[0x0f] = 0xff;
    const r = parseTrainerPartyMember(bytes, 0, PARTY_FLAG_CUSTOM_MOVESET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.heldItem).toBe(0);
      expect(r.member.moves).toEqual([33, 55, 89, 22]);
      expect(r.member.kind).toBe(1);
    }
  });

  it('parses a flags-3 member (custom moves + held item)', () => {
    const bytes = buildItemCustomMoves(31, 100, 384, 99, [100, 200, 300, 400]); // Rayquaza
    const r = parseTrainerPartyMember(bytes, 0, PARTY_FLAG_CUSTOM_MOVESET | PARTY_FLAG_HELD_ITEM);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.member.heldItem).toBe(99);
      expect(r.member.moves).toEqual([100, 200, 300, 400]);
      expect(r.member.species).toBe(384);
      expect(r.member.kind).toBe(3);
    }
  });

  it('rejects level 0 and level > 100', () => {
    expect(parseTrainerPartyMember(buildDefaultMoves(0, 0, 1), 0, 0).ok).toBe(false);
    expect(parseTrainerPartyMember(buildDefaultMoves(0, 101, 1), 0, 0).ok).toBe(false);
  });

  it('rejects species > 2000', () => {
    expect(parseTrainerPartyMember(buildDefaultMoves(0, 50, 2001), 0, 0).ok).toBe(false);
  });

  it('rejects invalid partyFlags', () => {
    const r = parseTrainerPartyMember(buildDefaultMoves(0, 50, 1), 0, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_party_flags');
  });

  it('rejects too-short buffers', () => {
    const r = parseTrainerPartyMember(new Uint8Array(4), 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });
});

describe('parseTrainerPartyArray', () => {
  it('walks a flags-0 array at the real 6-byte stride', () => {
    // Six default-moves members packed 6 bytes apart (the vanilla shape).
    const struct = PARTY_MEMBER_SIZE_BYTES_NO_ITEM_DEFAULT_MOVES;
    const bytes = new Uint8Array(struct * 6);
    for (let i = 0; i < 6; i++) {
      bytes.set(buildDefaultMoves(31, 10 + i * 5, 1 + i), i * struct);
    }
    const r = parseTrainerPartyArray(bytes, 0, 0, 6);
    expect(r.failureAtIndex).toBeNull();
    expect(r.members.length).toBe(6);
    expect(r.members.map((m) => m.level)).toEqual([10, 15, 20, 25, 30, 35]);
    expect(r.members.map((m) => m.species)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('bails on the first failed member + reports the index', () => {
    const struct = PARTY_MEMBER_SIZE_BYTES_NO_ITEM_DEFAULT_MOVES;
    const bytes = new Uint8Array(struct * 4);
    bytes.set(buildDefaultMoves(31, 50, 100), 0);
    bytes.set(buildDefaultMoves(31, 50, 100), struct);
    bytes.set(buildDefaultMoves(0, 200, 100), struct * 2); // invalid level
    bytes.set(buildDefaultMoves(31, 50, 100), struct * 3);
    const r = parseTrainerPartyArray(bytes, 0, 0, 4);
    expect(r.failureAtIndex).toBe(2);
    expect(r.members.length).toBe(2);
    expect(r.failureReason?.kind).toBe('invalid_level');
  });

  it('walks a flags-1 array at the real 14-byte stride', () => {
    const struct = PARTY_MEMBER_SIZE_BYTES_NO_ITEM_CUSTOM_MOVES;
    const bytes = new Uint8Array(struct * 3);
    bytes.set(buildCustomMoves(0, 20, 7, [1, 2, 3, 4]), 0);
    bytes.set(buildCustomMoves(0, 25, 8, [5, 6, 7, 8]), struct);
    bytes.set(buildCustomMoves(0, 30, 9, [9, 10, 11, 12]), struct * 2);
    const r = parseTrainerPartyArray(bytes, 0, PARTY_FLAG_CUSTOM_MOVESET, 3);
    expect(r.failureAtIndex).toBeNull();
    expect(r.members.map((m) => m.species)).toEqual([7, 8, 9]);
    expect(r.members[2]?.moves).toEqual([9, 10, 11, 12]);
  });
});
