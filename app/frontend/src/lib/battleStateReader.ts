/**
 * Phase 9C - Battle state reader.
 *
 * Reads the active battle struct from EWRAM via the existing
 * emulatorMemory bridge. Used by the HUD overlay to render HP bars
 * + type chips + status icons in real time on top of the emulator
 * canvas.
 *
 * **What it reads.** Vanilla pret/pokefirered exposes:
 *
 *   `gBattleMons[2]` - the active player + opponent battle structs.
 *   Each is `struct BattlePokemon` (88 bytes / 0x58) with the layout
 *   (pret/pokefirered + pret/pokeemerald `include/pokemon.h`, identical
 *   in both):
 *     +0x00  species   u16
 *     +0x02  attack    u16
 *     +0x04  defense   u16
 *     +0x06  speed     u16
 *     +0x08  spAttack  u16
 *     +0x0A  spDefense u16
 *     +0x0C  moves[4]  u16 ×4
 *     +0x14  IV bitfield u32 (hp/atk/def/spd/spAtk/spDef IVs, isEgg, abilityNum)
 *     +0x18  statStages[8] s8
 *     +0x20  ability   u8
 *     +0x21  type1     u8
 *     +0x22  type2     u8
 *     +0x23  unknown   u8    (vanilla leaves this unused; CFRU/DPE use type3)
 *     +0x24  pp[4]     u8 ×4
 *     +0x28  hp        u16   (← we read this)
 *     +0x2A  level     u8    (← and this)
 *     +0x2B  friendship u8
 *     +0x2C  maxHP     u16   (← and this)
 *     +0x2E  item      u16
 *     +0x30  nickname[11]
 *     +0x3B  ppBonuses u8
 *     +0x3C  otName[8]
 *     +0x44  experience u32
 *     +0x48  personality u32
 *     +0x4C  status1   u32   (← and this; SLP=0..7, PSN=3, BRN=4, FRZ=5, PAR=6)
 *     +0x50  status2   u32
 *     +0x54  otId      u32
 *
 *   Vanilla FRLG keeps `gBattleMons` at EWRAM 0x02023BE4 (pret/pokefirered
 *   `symbols/pokefirered.sym`: `02023be4 g 00000160 gBattleMons`, i.e. four
 *   0x58 structs = 0x160 bytes). CFRU sometimes relocates the table but the
 *   layout is identical.
 *
 * **What it does NOT do.** We don't try to detect whether a battle
 * is actually in progress (vs garbage left over from a prior battle).
 * The HUD overlay only shows when the user explicitly toggles it on;
 * the user is responsible for hiding it outside of battles.
 *
 * **Stability.** The vanilla FRLG offsets are the floor; CFRU /
 * CFRU+DPE may relocate the struct. We expose the offsets as
 * constants so a future Phase 6-style overlay (Phase 9C-1) can
 * carry per-fork addresses.
 */

import { EmulatorMemory, gbaAddressToRegion } from './emulatorMemory';
import type { EmulatorMemoryHost } from './emulatorMemory';

/** Vanilla FRLG-USA gBattleMons[0] address (player monster).
 *  Source: pret/pokefirered `symbols/pokefirered.sym`
 *  (`02023be4 g 00000160 gBattleMons`). */
export const FRLG_VANILLA_GBATTLEMONS_ADDR = 0x02023be4;

/** sizeof(struct BattlePokemon) = 0x58 = 88 bytes. */
export const BATTLEMON_STRUCT_SIZE = 88;

/** Offsets within `struct BattlePokemon` (relative to the struct's start).
 *  Ground truth: pret/pokefirered + pret/pokeemerald `include/pokemon.h`
 *  `struct BattlePokemon`. Every value is the field's real byte offset in
 *  that struct; the earlier table was shifted (ability read from the
 *  stat-stage array) and transposed (hp/maxHP swapped, status read from the
 *  pp array), so a live battle produced garbage HP bars and a level the
 *  sanity check rejected - the HUD stayed on "waiting for an active battle". */
export const BATTLEMON_OFFSETS = {
  species: 0x00, // u16
  moves: 0x0c, // u16 ×4
  abilityId: 0x20, // u8
  type1: 0x21, // u8
  type2: 0x22, // u8
  type3: 0x23, // u8 (vanilla FRLG leaves this byte unused; CFRU/DPE use type3)
  hp: 0x28, // u16
  level: 0x2a, // u8
  maxHp: 0x2c, // u16
  status: 0x4c, // u32 status1
} as const;

/** Per-monster snapshot returned to the HUD overlay. All numeric
 *  fields are u16/u8 as appropriate; the renderer maps them to UI. */
export interface BattleMonSnapshot {
  readonly speciesId: number;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly type1: number;
  readonly type2: number; // u8 (255 = none)
  readonly type3: number; // u8 (CFRU; 255 = none)
  readonly abilityId: number;
  readonly statusFlags: number; // raw u32
  readonly moves: readonly [number, number, number, number]; // u16 each
}

export interface BattleStateSnapshot {
  readonly player: BattleMonSnapshot | null;
  readonly opponent: BattleMonSnapshot | null;
  readonly looksLikeAnActiveBattle: boolean;
}

function parseBattleMon(bytes: Uint8Array, offset: number): BattleMonSnapshot {
  const u16 = (off: number): number => bytes[offset + off]! | (bytes[offset + off + 1]! << 8);
  const u8 = (off: number): number => bytes[offset + off]!;
  const u32 = (off: number): number =>
    (bytes[offset + off]! |
      (bytes[offset + off + 1]! << 8) |
      (bytes[offset + off + 2]! << 16) |
      (bytes[offset + off + 3]! << 24)) >>>
    0;
  return {
    speciesId: u16(BATTLEMON_OFFSETS.species),
    level: u8(BATTLEMON_OFFSETS.level),
    hp: u16(BATTLEMON_OFFSETS.hp),
    maxHp: u16(BATTLEMON_OFFSETS.maxHp),
    type1: u8(BATTLEMON_OFFSETS.type1),
    type2: u8(BATTLEMON_OFFSETS.type2),
    type3: u8(BATTLEMON_OFFSETS.type3),
    abilityId: u8(BATTLEMON_OFFSETS.abilityId),
    statusFlags: u32(BATTLEMON_OFFSETS.status),
    moves: [
      u16(BATTLEMON_OFFSETS.moves + 0),
      u16(BATTLEMON_OFFSETS.moves + 2),
      u16(BATTLEMON_OFFSETS.moves + 4),
      u16(BATTLEMON_OFFSETS.moves + 6),
    ],
  };
}

/** Heuristic: does this struct LOOK like a live battle? Two checks:
 *  - speciesId is 1..1535 (vanilla cap is 1023; CFRU+DPE extends to
 *    ~1290; we allow slack).
 *  - hp <= maxHp.
 *  - level is 1..100.
 *
 * Returning false doesn't mean it's CERTAIN there's no battle - just
 * that the byte pattern doesn't match a sensible BattleMon. The HUD
 * uses this to suppress noisy "battle ended but bytes still show
 * yesterday's match" snapshots. */
function looksLikeBattleMon(snap: BattleMonSnapshot): boolean {
  if (snap.speciesId === 0 || snap.speciesId > 1535) return false;
  if (snap.maxHp === 0) return false;
  if (snap.hp > snap.maxHp + 1) return false; // +1 slack for cosmetic
  if (snap.level === 0 || snap.level > 100) return false;
  return true;
}

/**
 * Reads the player + opponent battle structs from the running
 * emulator's WRAM.
 *
 * @param host - the active mGBA-WASM emulator module (from
 *   `getActiveEmulatorModule()` in EmulatorHost).
 * @param gBattleMonsAddr - defaults to the vanilla FRLG address.
 *   CFRU + DPE callers can pass a custom value if their identity
 *   overlay reports a different gBattleMons location.
 */
export async function readBattleState(
  host: EmulatorMemoryHost,
  gBattleMonsAddr: number = FRLG_VANILLA_GBATTLEMONS_ADDR,
): Promise<BattleStateSnapshot> {
  const playerAddr = gBattleMonsAddr;
  const opponentAddr = gBattleMonsAddr + BATTLEMON_STRUCT_SIZE;
  // Single contiguous read for both structs (saves one savestate
  // round-trip).
  const playerRegion = gbaAddressToRegion(playerAddr);
  const opponentRegion = gbaAddressToRegion(opponentAddr);
  // Both should be in EWRAM; if not, surface as "no battle".
  if (playerRegion.region !== 'ewram' || opponentRegion.region !== 'ewram') {
    return { player: null, opponent: null, looksLikeAnActiveBattle: false };
  }
  let bytes: Uint8Array;
  try {
    const mem = new EmulatorMemory(host);
    if (!mem.isSupported()) {
      return { player: null, opponent: null, looksLikeAnActiveBattle: false };
    }
    bytes = await mem.readBytes(playerAddr, BATTLEMON_STRUCT_SIZE * 2);
  } catch {
    return { player: null, opponent: null, looksLikeAnActiveBattle: false };
  }
  const player = parseBattleMon(bytes, 0);
  const opponent = parseBattleMon(bytes, BATTLEMON_STRUCT_SIZE);
  const playerValid = looksLikeBattleMon(player);
  const opponentValid = looksLikeBattleMon(opponent);
  return {
    player: playerValid ? player : null,
    opponent: opponentValid ? opponent : null,
    looksLikeAnActiveBattle: playerValid && opponentValid,
  };
}
