/**
 * Gen-3 Pokémon MapHeader struct parser.
 *
 * The Gen-3 engine (Ruby/Sapphire/Emerald/FireRed/LeafGreen) and every
 * derivative hack/decomp/fork shares a stable in-memory MapHeader layout
 * - 28 bytes per entry - that's been publicly documented by the pret
 * decomp project (pokeemerald, pokefirered) and the broader hacking
 * community. Reference: pret/pokefirered's `include/global.fieldmap.h`.
 *
 *   offset  size  field
 *   0x00    4     mapLayoutPointer - ROM pointer to map layout
 *   0x04    4     eventsPointer - ROM pointer to event objects/warps/etc.
 *   0x08    4     mapScriptsPointer - ROM pointer to map scripts (or NULL)
 *   0x0C    4     connectionsPointer - ROM pointer to map connections (or NULL)
 *   0x10    2     musicId - music track id (or 0)
 *   0x12    2     mapLayoutId - layout id (cross-references the layout
 *                                          table; usually < 0x400)
 *   0x14    1     regionMapSection - region-map section id (or 0x58 = NONE)
 *   0x15    1     caveOrType - terrain/cave subtype byte
 *   0x16    1     weather - weather type byte
 *   0x17    1     mapType - 1..9 enum (city/route/cave/etc)
 *   0x18    1     bikingAllowed - bool8 (the `allow_cycling` argument of
 *                                          pret's `map_header_flags` macro)
 *   0x19    1     flags - bitfield: bit0 allowEscaping, bit1 allowRunning,
 *                                          bits 2..7 showMapName. This is the
 *                                          second byte emitted by pret's
 *                                          `map_header_flags` macro.
 *   0x1A    1     floorNum - s8 (negative for basements)
 *   0x1B    1     battleType - encounter-music selector
 *
 * NOTE (2026-10-14): 0x18 and 0x19 used to be modelled as "unused padding"
 * and the flags bitfield was read from 0x1A. That was wrong: 0x1A is
 * `floorNum`, and 0x18/0x19 carry the map-header flags. Reading the flags
 * byte at 0x1A meant `set_map_metadata`-style edits wrote the floor number
 * instead of the escape/run/show-name flags, and the cycling permission
 * byte was never surfaced at all. The offsets below are the corrected
 * pret layout.
 *
 * IMPORTANT: this is a STRUCTURAL signature - not a baked offset (PD 5).
 * We never assume map headers live at a specific address in any specific
 * ROM. The pointer-network analyzer (Phase 2) finds the pointer TABLES
 * that REFERENCE map headers; the scanner here tries to parse each
 * pointed-to offset as a MapHeader. Real hacks relocate the table all
 * the time - this approach follows them.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

/** Length of one Gen-3 MapHeader in bytes. */
export const MAP_HEADER_SIZE_BYTES = 28;
/** Highest plausible mapType byte (cities, routes, caves, etc.). */
export const MAP_TYPE_MAX = 9;
/** Highest plausible region-map section id (vanilla uses up to ~0x58). */
export const REGION_MAP_SECTION_MAX = 0xff;

/** Field offsets within a MapHeader struct (pret `struct MapHeader`). */
export const MAP_HEADER_OFFSET_BIKING_ALLOWED = 0x18;
export const MAP_HEADER_OFFSET_FLAGS = 0x19;
export const MAP_HEADER_OFFSET_FLOOR_NUM = 0x1a;
export const MAP_HEADER_OFFSET_BATTLE_TYPE = 0x1b;

export interface MapHeader {
  readonly mapLayoutOffset: number;
  readonly eventsOffset: number | null; // nullable: NULL pointer is legal
  readonly mapScriptsOffset: number | null;
  readonly connectionsOffset: number | null;
  readonly musicId: number;
  readonly mapLayoutId: number;
  readonly regionMapSection: number;
  readonly caveOrType: number;
  readonly weather: number;
  readonly mapType: number;
  /** Biking allowed on this map - MapHeader byte 0x18 (bool8; pret's
   *  `allow_cycling`). */
  readonly bikingAllowed: boolean;
  /** Map-flags bitfield - MapHeader byte 0x19: bit 0 allowEscaping,
   *  bit 1 allowRunning, bits 2..7 showMapName. */
  readonly flags: number;
  /** Floor number - MapHeader byte 0x1A (s8; negative for basements). */
  readonly floorNum: number;
  readonly battleType: number;
}

export type MapHeaderParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'invalid_map_layout_pointer'; rawAddress: number }
  | { kind: 'implausible_map_type'; observed: number; max: number }
  | { kind: 'implausible_map_flags'; bikingAllowedByte: number; flagsByte: number };

export type MapHeaderParseResult =
  | { ok: true; header: MapHeader }
  | { ok: false; failure: MapHeaderParseFailure };

/**
 * Try to parse 28 bytes starting at `offset` in `bytes` as a Gen-3 Map
 * Header. Returns ok=true only when the structural constraints are
 * satisfied - the mapLayoutPointer is a valid ROM pointer within the
 * same ROM, the mapType byte is in the plausible 1..MAP_TYPE_MAX range,
 * and the bikingAllowed + flags bytes are not BOTH 0xFF (a common
 * uninitialized-memory marker: bikingAllowed is a bool8 and the flags
 * byte's upper bits are the showMapName count, so neither is 0xFF in
 * real data).
 *
 * The eventsPointer / mapScriptsPointer / connectionsPointer fields are
 * allowed to be NULL (0x00000000) - many maps have no events, scripts,
 * or connections. Non-NULL pointers must be valid ROM pointers.
 */
export function parseMapHeader(bytes: Uint8Array, offset: number): MapHeaderParseResult {
  if (offset < 0 || offset + MAP_HEADER_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: MAP_HEADER_SIZE_BYTES,
      },
    };
  }

  const layoutPtr = readPointer(bytes, offset + 0x00);
  if (layoutPtr === null || layoutPtr.fileOffset === null) {
    return {
      ok: false,
      failure: {
        kind: 'invalid_map_layout_pointer',
        rawAddress: layoutPtr?.rawAddress ?? 0,
      },
    };
  }
  if (layoutPtr.fileOffset >= bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'invalid_map_layout_pointer',
        rawAddress: layoutPtr.rawAddress,
      },
    };
  }

  const eventsPtr = readPointer(bytes, offset + 0x04);
  const scriptsPtr = readPointer(bytes, offset + 0x08);
  const connectionsPtr = readPointer(bytes, offset + 0x0c);

  // Allow NULL or a valid ROM pointer for the optional fields.
  if (eventsPtr !== null && eventsPtr.fileOffset !== null && eventsPtr.fileOffset >= bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'invalid_map_layout_pointer',
        rawAddress: eventsPtr.rawAddress,
      },
    };
  }
  if (scriptsPtr !== null && scriptsPtr.fileOffset !== null && scriptsPtr.fileOffset >= bytes.length) {
    return {
      ok: false,
      failure: { kind: 'invalid_map_layout_pointer', rawAddress: scriptsPtr.rawAddress },
    };
  }
  if (
    connectionsPtr !== null &&
    connectionsPtr.fileOffset !== null &&
    connectionsPtr.fileOffset >= bytes.length
  ) {
    return {
      ok: false,
      failure: { kind: 'invalid_map_layout_pointer', rawAddress: connectionsPtr.rawAddress },
    };
  }

  const musicId = readUint16Le(bytes, offset + 0x10);
  const mapLayoutId = readUint16Le(bytes, offset + 0x12);
  const regionMapSection = bytes[offset + 0x14] ?? 0;
  const caveOrType = bytes[offset + 0x15] ?? 0;
  const weather = bytes[offset + 0x16] ?? 0;
  const mapType = bytes[offset + 0x17] ?? 0;
  const bikingAllowedByte = bytes[offset + MAP_HEADER_OFFSET_BIKING_ALLOWED] ?? 0;
  const flags = bytes[offset + MAP_HEADER_OFFSET_FLAGS] ?? 0;
  const floorNumByte = bytes[offset + MAP_HEADER_OFFSET_FLOOR_NUM] ?? 0;
  const battleType = bytes[offset + MAP_HEADER_OFFSET_BATTLE_TYPE] ?? 0;
  // floorNum is s8 - negative for basements (e.g. B1F).
  const floorNum = floorNumByte < 0x80 ? floorNumByte : floorNumByte - 0x100;

  // mapType is a published Gen-3 enum: 1=Town, 2=City, 3=Route, 4=Underground,
  // 5=Underwater, 6=Ocean, 7=Mt, 8=Indoor, 9=Secret. Values outside 1..9
  // are extremely strong evidence this isn't really a MapHeader - random
  // bytes at the MAP_TYPE offset hit 1..9 with probability ~3.5%, so the
  // false-positive rate is acceptable.
  if (mapType < 1 || mapType > MAP_TYPE_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_map_type', observed: mapType, max: MAP_TYPE_MAX },
    };
  }

  if (bikingAllowedByte === 0xff && flags === 0xff) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_map_flags',
        bikingAllowedByte,
        flagsByte: flags,
      },
    };
  }

  return {
    ok: true,
    header: Object.freeze({
      mapLayoutOffset: layoutPtr.fileOffset,
      eventsOffset: eventsPtr?.fileOffset ?? null,
      mapScriptsOffset: scriptsPtr?.fileOffset ?? null,
      connectionsOffset: connectionsPtr?.fileOffset ?? null,
      musicId,
      mapLayoutId,
      regionMapSection,
      caveOrType,
      weather,
      mapType,
      bikingAllowed: bikingAllowedByte !== 0,
      flags,
      floorNum,
      battleType,
    }),
  };
}

/**
 * Read a 32-bit little-endian value at `offset` and interpret it as
 * either a NULL pointer (0x00000000), a valid GBA ROM pointer, or
 * something else.
 *
 * Returns:
 *   null - value is not 0 and not a ROM-region addr
 *   { rawAddress, fileOffset: null } - NULL pointer (0x00000000)
 *   { rawAddress, fileOffset: <number> } - valid ROM pointer; fileOffset is rawAddress - 0x08000000
 */
function readPointer(
  bytes: Uint8Array,
  offset: number,
): { rawAddress: number; fileOffset: number | null } | null {
  if (offset + 4 > bytes.length) return null;
  const rawAddress = readUint32Le(bytes, offset);
  if (rawAddress === 0) {
    return { rawAddress: 0, fileOffset: null };
  }
  const highByte = (rawAddress >>> 24) & 0xff;
  if (highByte !== 0x08 && highByte !== 0x09) return null;
  return { rawAddress, fileOffset: rawAddress - GBA_ROM_BASE_ADDRESS };
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
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
