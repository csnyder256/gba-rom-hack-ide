/**
 * Gen-3 RegionMapSection encoder + manifest lifter (Phase 3.1).
 *
 * The world-region scanner at `engine/src/world/region-map-sections.ts`
 * already finds + parses the gRegionMapEntries table. What's missing:
 *
 *   1. An ENCODER so propose_set_region_map_label (Phase 3.29) can
 *      write a new entry back into the table in place.
 *   2. A LIFTER that adapts the scanner's `RegionMapSection[]` shape
 *      into a manifest-side `ManifestRegionMapEntry[]` shape.
 *
 * The table supports two layouts:
 *   - 12-byte (Emerald-style): { x, y, width, height, nameRomPointer }
 *     with each field at distinct offsets + padding bytes.
 *   - 8-byte (FRLG-style): tighter packing of the same fields.
 *
 * Encoder writes either layout per the caller's `layoutKind`. The
 * scanner records `layoutKind` on the discovered table, so the propose
 * tool reads it once + threads it through to every encode call for a
 * given project.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  REGION_MAP_SECTION_COORD_MAX_S16,
  REGION_MAP_SECTION_COORD_MIN_S16,
  REGION_MAP_SECTION_DIM_MAX_12,
  REGION_MAP_SECTION_SIZE_BYTES_12,
  REGION_MAP_SECTION_SIZE_BYTES_8,
  type RegionMapLayoutKind,
  type RegionMapSection,
} from '../world/region-map-sections.js';

export interface RegionMapSectionSpec {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** File offset of the (encoded Gen-3 charset) name string; null = no
   *  name slot (sentinel entry). */
  readonly nameOffset: number | null;
}

export class RegionMapSectionEncodeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`RegionMapSectionEncodeError: ${field}: ${message}`);
    this.name = 'RegionMapSectionEncodeError';
    this.field = field;
  }
}

/**
 * Encode a single region-map entry. Layout depends on the family, and
 * MUST mirror the scanner's `tryParseEntry12` / `tryParseEntry8`
 * exactly - this encoder is the inverse of that parser, so a field at
 * the wrong offset would be silently misread (or, for the 12-byte
 * layout, put a name-pointer byte into the padding field and make the
 * parser reject the entry entirely).
 *
 *   12-byte (Emerald-style), mirrors `tryParseEntry12`:
 *     0x00 s16 x
 *     0x02 s16 y
 *     0x04 u8  width
 *     0x05 u8  height
 *     0x06 u16 padding (always 0 - the parser requires it)
 *     0x08 u32 name pointer (or 0)
 *
 *   8-byte (FRLG-style), mirrors `tryParseEntry8`:
 *     0x00 u8  x
 *     0x01 u8  y
 *     0x02 u8  width
 *     0x03 u8  height
 *     0x04 u32 name pointer (or 0)
 */
export function encodeRegionMapSection(
  spec: RegionMapSectionSpec,
  layoutKind: RegionMapLayoutKind,
): Uint8Array {
  const size =
    layoutKind === '12byte' ? REGION_MAP_SECTION_SIZE_BYTES_12 : REGION_MAP_SECTION_SIZE_BYTES_8;
  const out = new Uint8Array(size);
  if (layoutKind === '12byte') {
    // s16 x/y: the parser accepts only [COORD_MIN_S16, COORD_MAX_S16].
    validateRange('x', spec.x, REGION_MAP_SECTION_COORD_MIN_S16, REGION_MAP_SECTION_COORD_MAX_S16);
    validateRange('y', spec.y, REGION_MAP_SECTION_COORD_MIN_S16, REGION_MAP_SECTION_COORD_MAX_S16);
    // width/height are u8 but the parser bounds them at DIM_MAX_12.
    validateRange('width', spec.width, 0, REGION_MAP_SECTION_DIM_MAX_12);
    validateRange('height', spec.height, 0, REGION_MAP_SECTION_DIM_MAX_12);
    writeS16LE(out, 0x00, spec.x);
    writeS16LE(out, 0x02, spec.y);
    out[0x04] = spec.width & 0xff;
    out[0x05] = spec.height & 0xff;
    out[0x06] = 0; // padding - parser rejects a non-zero value here
    out[0x07] = 0;
    writeNamePointer(out, 0x08, spec.nameOffset);
  } else {
    // 8-byte FRLG layout - all four coord/size fields are full-range u8.
    validateU8('x', spec.x);
    validateU8('y', spec.y);
    validateU8('width', spec.width);
    validateU8('height', spec.height);
    out[0x00] = spec.x & 0xff;
    out[0x01] = spec.y & 0xff;
    out[0x02] = spec.width & 0xff;
    out[0x03] = spec.height & 0xff;
    writeNamePointer(out, 0x04, spec.nameOffset);
  }
  return out;
}

function writeNamePointer(out: Uint8Array, byteOffset: number, fileOffset: number | null): void {
  if (fileOffset === null) {
    out[byteOffset + 0] = 0;
    out[byteOffset + 1] = 0;
    out[byteOffset + 2] = 0;
    out[byteOffset + 3] = 0;
    return;
  }
  if (!Number.isInteger(fileOffset) || fileOffset < 0 || fileOffset > 0x01ffffff) {
    throw new RegionMapSectionEncodeError(
      'nameOffset',
      `must fit in 25 bits; got ${String(fileOffset)}`,
    );
  }
  const ptr = (fileOffset + GBA_ROM_BASE_ADDRESS) >>> 0;
  out[byteOffset + 0] = ptr & 0xff;
  out[byteOffset + 1] = (ptr >>> 8) & 0xff;
  out[byteOffset + 2] = (ptr >>> 16) & 0xff;
  out[byteOffset + 3] = (ptr >>> 24) & 0xff;
}

function validateU8(field: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) {
    throw new RegionMapSectionEncodeError(field, `must be u8; got ${String(v)}`);
  }
}

function validateRange(field: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RegionMapSectionEncodeError(
      field,
      `must be an integer in [${String(min)}, ${String(max)}] (the scanner would reject anything else); got ${String(v)}`,
    );
  }
}

function writeS16LE(out: Uint8Array, byteOffset: number, value: number): void {
  const u = value & 0xffff;
  out[byteOffset + 0] = u & 0xff;
  out[byteOffset + 1] = (u >>> 8) & 0xff;
}

/**
 * Manifest-side shape for one region-map entry, derived from the
 * scanner's RegionMapSection. The lifter at the bottom of the file
 * builds these from a parsed table.
 */
export interface ManifestRegionMapEntry {
  /** Stable id used in cross-refs (e.g. `region_map_section_3`). */
  readonly id: string;
  /** Section index byte (matches MapHeader.regionMapSection). */
  readonly sectionIndex: number;
  /** Top-left tile x. */
  readonly x: number;
  /** Top-left tile y. */
  readonly y: number;
  /** Width in tiles. */
  readonly width: number;
  /** Height in tiles. */
  readonly height: number;
  /** Decoded area name; empty when this is a sentinel/blank slot. */
  readonly name: string;
  /** Absolute file offset of the entry's first byte. */
  readonly fileOffset: number;
}

/**
 * Lift the scanner's RegionMapSection[] into a manifest-side
 * ManifestRegionMapEntry[]. Filters out only sentinel entries whose
 * sectionIndex < 0 (defensive - shouldn't happen but guards against
 * malformed scans).
 */
export function liftRegionMapSections(
  sections: ReadonlyArray<RegionMapSection>,
): ReadonlyArray<ManifestRegionMapEntry> {
  const out: ManifestRegionMapEntry[] = [];
  for (const s of sections) {
    if (s.sectionIndex < 0) continue;
    out.push(
      Object.freeze({
        id: `region_map_section_${String(s.sectionIndex)}`,
        sectionIndex: s.sectionIndex,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        name: s.name,
        fileOffset: s.fileOffset,
      }),
    );
  }
  return Object.freeze(out);
}
