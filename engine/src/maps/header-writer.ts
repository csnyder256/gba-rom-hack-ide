/**
 * Gen-3 MapHeader struct encoder (Phase 3.1).
 *
 * Inverse of `parseMapHeader` - takes a typed MapHeader (or a `MapHeader`-
 * shaped spec) and returns the 28 bytes the parser will accept.
 *
 * Pointers are file-offset based (the caller owns allocation); the encoder
 * converts to GBA pointers via `+ GBA_ROM_BASE_ADDRESS`. NULL is encoded
 * as 0x00000000 (the parser accepts NULL for events / scripts /
 * connections - only mapLayoutPointer must be non-NULL).
 *
 * Pure function: no allocation, no validation beyond range checks. The
 * propose-tool layer is responsible for picking offsets via the free-
 * space registry (Phase 3.2) and validating the caller's intent.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { MAP_HEADER_SIZE_BYTES, MAP_TYPE_MAX, REGION_MAP_SECTION_MAX } from './header.js';

export interface MapHeaderSpec {
  /** File offset of the MapLayout struct this header points at (required;
   *  the parser rejects NULL here). The encoder converts to GBA pointer. */
  readonly mapLayoutOffset: number;
  /** File offset of the events table; null encodes a NULL pointer. */
  readonly eventsOffset: number | null;
  /** File offset of the map scripts table; null encodes a NULL pointer. */
  readonly mapScriptsOffset: number | null;
  /** File offset of the connections envelope; null encodes a NULL pointer. */
  readonly connectionsOffset: number | null;
  /** u16 - music track id (0 = silent map music slot). */
  readonly musicId: number;
  /** u16 - layout id (cross-references the layout table). */
  readonly mapLayoutId: number;
  /** u8 - region map section id (0x58 = NONE in vanilla FRLG). */
  readonly regionMapSection: number;
  /** u8 - terrain/cave subtype. */
  readonly caveOrType: number;
  /** u8 - weather id. */
  readonly weather: number;
  /** u8 - map type enum (1..9 per pret docs: 1=Town … 9=Secret). */
  readonly mapType: number;
  /** Biking allowed (bool8 at 0x18; pret's `allow_cycling`). Optional -
   *  defaults to false. */
  readonly bikingAllowed?: boolean;
  /** u8 - map-flags bitfield at 0x19 (bit0 allowEscaping, bit1
   *  allowRunning, bits 2..7 showMapName). */
  readonly flags: number;
  /** s8 - floor number at 0x1A (negative for basements). Optional -
   *  defaults to 0. */
  readonly floorNum?: number;
  /** u8 - encounter-music selector. */
  readonly battleType: number;
}

export class MapHeaderEncodeError extends Error {
  readonly field: string;
  readonly value: number;
  constructor(field: string, value: number, reason: string) {
    super(`MapHeaderEncodeError: ${field}=${String(value)}: ${reason}`);
    this.name = 'MapHeaderEncodeError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Encode a MapHeaderSpec into the 28-byte ROM-ready buffer. Throws
 * MapHeaderEncodeError on out-of-range values; emits one allocation-free
 * Uint8Array per call. `parseMapHeader(encodeMapHeader(spec), 0)` round-
 * trips for any spec the parser would accept.
 */
export function encodeMapHeader(spec: MapHeaderSpec): Uint8Array {
  validateU16('musicId', spec.musicId);
  validateU16('mapLayoutId', spec.mapLayoutId);
  validateU8('regionMapSection', spec.regionMapSection, REGION_MAP_SECTION_MAX);
  validateU8('caveOrType', spec.caveOrType);
  validateU8('weather', spec.weather);
  // mapType: parser only accepts 1..MAP_TYPE_MAX (9). Reject other values
  // up-front so the encoder produces only round-trippable bytes.
  if (!Number.isInteger(spec.mapType) || spec.mapType < 1 || spec.mapType > MAP_TYPE_MAX) {
    throw new MapHeaderEncodeError(
      'mapType',
      spec.mapType,
      `must be an integer in [1, ${String(MAP_TYPE_MAX)}] - parser would reject anything else`,
    );
  }
  validateU8('flags', spec.flags);
  validateU8('battleType', spec.battleType);
  const floorNum = spec.floorNum ?? 0;
  if (!Number.isInteger(floorNum) || floorNum < -128 || floorNum > 127) {
    throw new MapHeaderEncodeError(
      'floorNum',
      floorNum,
      'must be an integer in [-128, 127] (s8 - negative for basements)',
    );
  }

  const out = new Uint8Array(MAP_HEADER_SIZE_BYTES);
  writePointer(out, 0x00, spec.mapLayoutOffset, 'mapLayoutOffset', /* allowNull */ false);
  writePointer(out, 0x04, spec.eventsOffset, 'eventsOffset', true);
  writePointer(out, 0x08, spec.mapScriptsOffset, 'mapScriptsOffset', true);
  writePointer(out, 0x0c, spec.connectionsOffset, 'connectionsOffset', true);
  writeU16Le(out, 0x10, spec.musicId);
  writeU16Le(out, 0x12, spec.mapLayoutId);
  out[0x14] = spec.regionMapSection & 0xff;
  out[0x15] = spec.caveOrType & 0xff;
  out[0x16] = spec.weather & 0xff;
  out[0x17] = spec.mapType & 0xff;
  out[0x18] = spec.bikingAllowed === true ? 0x01 : 0x00; // bikingAllowed (bool8)
  out[0x19] = spec.flags & 0xff; // map-flags bitfield
  out[0x1a] = floorNum & 0xff; // floorNum (s8)
  out[0x1b] = spec.battleType & 0xff;
  return out;
}

function validateU16(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new MapHeaderEncodeError(field, value, 'must be a u16 in [0, 0xFFFF]');
  }
}

function validateU8(field: string, value: number, maxValue = 0xff): void {
  if (!Number.isInteger(value) || value < 0 || value > maxValue) {
    throw new MapHeaderEncodeError(field, value, `must be a u8 in [0, 0x${maxValue.toString(16).toUpperCase()}]`);
  }
}

function writePointer(
  out: Uint8Array,
  byteOffset: number,
  fileOffset: number | null,
  field: string,
  allowNull: boolean,
): void {
  if (fileOffset === null) {
    if (!allowNull) {
      throw new MapHeaderEncodeError(field, 0, 'NULL not allowed - must point at a valid struct');
    }
    out[byteOffset + 0] = 0;
    out[byteOffset + 1] = 0;
    out[byteOffset + 2] = 0;
    out[byteOffset + 3] = 0;
    return;
  }
  if (!Number.isInteger(fileOffset) || fileOffset < 0 || fileOffset > 0x01ffffff) {
    throw new MapHeaderEncodeError(field, fileOffset, 'file offset must fit in 25 bits (GBA ROM is ≤ 32 MiB)');
  }
  const ptr = (fileOffset + GBA_ROM_BASE_ADDRESS) >>> 0;
  out[byteOffset + 0] = ptr & 0xff;
  out[byteOffset + 1] = (ptr >>> 8) & 0xff;
  out[byteOffset + 2] = (ptr >>> 16) & 0xff;
  out[byteOffset + 3] = (ptr >>> 24) & 0xff;
}

function writeU16Le(out: Uint8Array, byteOffset: number, value: number): void {
  out[byteOffset + 0] = value & 0xff;
  out[byteOffset + 1] = (value >>> 8) & 0xff;
}
