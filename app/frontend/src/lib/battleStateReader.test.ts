/**
 * Phase 9C - Battle state reader tests.
 *
 * The fixture below is built from the pret `struct BattlePokemon` layout
 * HARD-CODED here (not imported from the module under test), so the test
 * asserts the reader against the real ROM struct rather than against
 * whatever offsets the reader happens to believe. Source of every offset:
 * pret/pokefirered + pret/pokeemerald `include/pokemon.h` `struct
 * BattlePokemon`; the address is from pret/pokefirered
 * `symbols/pokefirered.sym` (`02023be4 g 00000160 gBattleMons`).
 */

import { describe, expect, it } from 'vitest';
import {
  BATTLEMON_OFFSETS,
  BATTLEMON_STRUCT_SIZE,
  FRLG_VANILLA_GBATTLEMONS_ADDR,
  readBattleState,
} from './battleStateReader';
import {
  GBA_SIZE_EWRAM,
  SAVESTATE_EWRAM_OFFSET,
  SAVESTATE_TOTAL_SIZE,
} from './emulatorMemory';
import type { EmulatorMemoryHost } from './emulatorMemory';

/** Field offsets of `struct BattlePokemon`, verbatim from pret. */
const PRET_BATTLEMON = {
  species: 0x00,
  moves: 0x0c,
  ability: 0x20,
  type1: 0x21,
  type2: 0x22,
  type3: 0x23,
  hp: 0x28,
  level: 0x2a,
  maxHp: 0x2c,
  status: 0x4c,
} as const;

/** pret/pokefirered `symbols/pokefirered.sym`. */
const PRET_FRLG_GBATTLEMONS = 0x02023be4;

/** Build a mock host whose `getAutoSaveState()` returns a 0x61000-byte
 *  savestate with the BattlePokemon structs patched at the FRLG vanilla
 *  EWRAM offset, using the pret field offsets above. */
function buildMockHost(opts: {
  playerSpecies?: number;
  playerLevel?: number;
  playerHp?: number;
  playerMaxHp?: number;
  playerAbility?: number;
  playerStatus?: number;
  opponentSpecies?: number;
  opponentLevel?: number;
  opponentHp?: number;
  opponentMaxHp?: number;
}): EmulatorMemoryHost {
  const blob = new Uint8Array(SAVESTATE_TOTAL_SIZE);
  const gBattleMonsAddr = PRET_FRLG_GBATTLEMONS;
  const ewramBase = 0x02000000;
  const offsetInEwram = gBattleMonsAddr - ewramBase;
  const playerBase = SAVESTATE_EWRAM_OFFSET + offsetInEwram;
  const opponentBase = playerBase + BATTLEMON_STRUCT_SIZE;

  function setU16(off: number, val: number): void {
    blob[off] = val & 0xff;
    blob[off + 1] = (val >> 8) & 0xff;
  }
  function setU8(off: number, val: number): void {
    blob[off] = val & 0xff;
  }
  function setU32(off: number, val: number): void {
    blob[off] = val & 0xff;
    blob[off + 1] = (val >>> 8) & 0xff;
    blob[off + 2] = (val >>> 16) & 0xff;
    blob[off + 3] = (val >>> 24) & 0xff;
  }
  // Player.
  setU16(playerBase + PRET_BATTLEMON.species, opts.playerSpecies ?? 25); // Pikachu
  setU8(playerBase + PRET_BATTLEMON.level, opts.playerLevel ?? 50);
  setU16(playerBase + PRET_BATTLEMON.hp, opts.playerHp ?? 80);
  setU16(playerBase + PRET_BATTLEMON.maxHp, opts.playerMaxHp ?? 100);
  setU8(playerBase + PRET_BATTLEMON.type1, 13); // electric
  setU8(playerBase + PRET_BATTLEMON.type2, 255); // none
  setU8(playerBase + PRET_BATTLEMON.ability, opts.playerAbility ?? 9); // Static
  setU32(playerBase + PRET_BATTLEMON.status, opts.playerStatus ?? 0);
  // Opponent.
  setU16(opponentBase + PRET_BATTLEMON.species, opts.opponentSpecies ?? 6); // Charizard
  setU8(opponentBase + PRET_BATTLEMON.level, opts.opponentLevel ?? 55);
  setU16(opponentBase + PRET_BATTLEMON.hp, opts.opponentHp ?? 120);
  setU16(opponentBase + PRET_BATTLEMON.maxHp, opts.opponentMaxHp ?? 150);
  setU8(opponentBase + PRET_BATTLEMON.type1, 10); // fire
  setU8(opponentBase + PRET_BATTLEMON.type2, 2); // flying

  const host: EmulatorMemoryHost = {
    forceAutoSaveState: () => true,
    getAutoSaveState: () => ({
      autoSaveStateName: '/autosave/0',
      data: blob,
    }),
    uploadAutoSaveState: async () => undefined,
    loadAutoSaveState: () => true,
    pauseGame: () => undefined,
    resumeGame: () => undefined,
  };
  return host;
}

describe('battleStateReader', () => {
  it('pins the reader to the pret struct layout + address, not to itself', () => {
    // These literals come from pret, so a silent drift in BATTLEMON_OFFSETS
    // or the gBattleMons address fails here instead of shipping garbage.
    expect(BATTLEMON_OFFSETS).toEqual({
      species: PRET_BATTLEMON.species,
      moves: PRET_BATTLEMON.moves,
      abilityId: PRET_BATTLEMON.ability,
      type1: PRET_BATTLEMON.type1,
      type2: PRET_BATTLEMON.type2,
      type3: PRET_BATTLEMON.type3,
      hp: PRET_BATTLEMON.hp,
      level: PRET_BATTLEMON.level,
      maxHp: PRET_BATTLEMON.maxHp,
      status: PRET_BATTLEMON.status,
    });
    expect(BATTLEMON_STRUCT_SIZE).toBe(0x58); // sizeof(struct BattlePokemon)
    expect(FRLG_VANILLA_GBATTLEMONS_ADDR).toBe(PRET_FRLG_GBATTLEMONS);
  });

  it('parses player + opponent BattlePokemon structs from a mock savestate', async () => {
    const host = buildMockHost({});
    const snap = await readBattleState(host);
    expect(snap.looksLikeAnActiveBattle).toBe(true);
    expect(snap.player).not.toBeNull();
    expect(snap.opponent).not.toBeNull();
    expect(snap.player!.speciesId).toBe(25);
    expect(snap.player!.level).toBe(50);
    expect(snap.player!.hp).toBe(80);
    expect(snap.player!.maxHp).toBe(100);
    expect(snap.player!.type1).toBe(13);
    expect(snap.player!.type2).toBe(255);
    expect(snap.player!.abilityId).toBe(9);
    expect(snap.opponent!.speciesId).toBe(6);
    expect(snap.opponent!.level).toBe(55);
    expect(snap.opponent!.hp).toBe(120);
    expect(snap.opponent!.maxHp).toBe(150);
  });

  it('reads the status1 word from its real struct offset (0x4C)', async () => {
    // PSN (bit 3) + PAR (bit 6) set.
    const host = buildMockHost({ playerStatus: (1 << 3) | (1 << 6) });
    const snap = await readBattleState(host);
    expect(snap.player!.statusFlags).toBe((1 << 3) | (1 << 6));
  });

  it('does not confuse hp with maxHP or level', async () => {
    // hp 37, maxHP 210, level 61 - three distinct values that a transposed
    // or shifted layout would report as each other.
    const host = buildMockHost({ playerHp: 37, playerMaxHp: 210, playerLevel: 61 });
    const snap = await readBattleState(host);
    expect(snap.player!.hp).toBe(37);
    expect(snap.player!.maxHp).toBe(210);
    expect(snap.player!.level).toBe(61);
  });

  it('marks the snapshot as not-a-battle when speciesId is 0', async () => {
    const host = buildMockHost({ playerSpecies: 0 });
    const snap = await readBattleState(host);
    expect(snap.player).toBeNull();
    expect(snap.looksLikeAnActiveBattle).toBe(false);
  });

  it('marks the snapshot as not-a-battle when hp > maxHp', async () => {
    const host = buildMockHost({ playerHp: 999, playerMaxHp: 100 });
    const snap = await readBattleState(host);
    expect(snap.player).toBeNull();
  });

  it('marks the snapshot as not-a-battle when level is > 100', async () => {
    const host = buildMockHost({ opponentLevel: 200 });
    const snap = await readBattleState(host);
    expect(snap.opponent).toBeNull();
  });

  it('returns null snapshots when the host does not expose savestate methods', async () => {
    const host: EmulatorMemoryHost = {}; // missing all required methods
    const snap = await readBattleState(host);
    expect(snap.player).toBeNull();
    expect(snap.opponent).toBeNull();
    expect(snap.looksLikeAnActiveBattle).toBe(false);
  });

  it('handles getAutoSaveState() throwing without crashing the caller', async () => {
    const host: EmulatorMemoryHost = {
      forceAutoSaveState: () => true,
      getAutoSaveState: () => {
        throw new Error('boom');
      },
      uploadAutoSaveState: async () => undefined,
      loadAutoSaveState: () => true,
    };
    const snap = await readBattleState(host);
    expect(snap.looksLikeAnActiveBattle).toBe(false);
  });

  it('EWRAM bounds: the BattlePokemon structs sit inside EWRAM', () => {
    const ewramBase = 0x02000000;
    const offset = FRLG_VANILLA_GBATTLEMONS_ADDR - ewramBase;
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset + BATTLEMON_STRUCT_SIZE * 2).toBeLessThanOrEqual(GBA_SIZE_EWRAM);
  });
});
