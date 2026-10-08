/**
 * Gen-3 region-map section scanner - Phase UX-B + RT-1.1.
 *
 * Detects the universal Gen-3 `gRegionMapEntries[]` table that maps each
 * region-map section id byte (carried on every MapHeader at offset
 * 0x14) to a real area name like "PALLET TOWN" / "VIRIDIAN FOREST" /
 * "ROUTE 1" / "MT. MOON".
 *
 * RT-1.1 generalises the scanner to handle **two struct layouts**:
 *
 *   12-byte (Emerald-style):
 *     struct RegionMapLocation {
 *       s16 x;            // 0x00..0x01
 *       s16 y;            // 0x02..0x03
 *       u8  width;        // 0x04
 *       u8  height;       // 0x05
 *       u16 _padding;     // 0x06..0x07 - alignment to 4-byte boundary
 *       const u8 *name;   // 0x08..0x0B
 *     };  // 12 bytes per entry
 *
 *   8-byte (FRLG / LeafGreen):
 *     struct RegionMapLocation {
 *       u8 x;             // 0x00
 *       u8 y;             // 0x01
 *       u8 width;         // 0x02
 *       u8 height;        // 0x03
 *       const u8 *name;   // 0x04..0x07
 *     };  // 8 bytes per entry
 *
 * Both layouts coexist in the wild (per pret/pokefirered and
 * pret/pokeemerald headers). The scanner runs each layout
 * independently and picks the result with the larger valid named
 * count, gated by the coordinate-variety guards introduced by the
 * 2026-05-23 region-map false-positive fix (≥10 distinct (x,y),
 * ≥3 distinct y) which reject "wrong table" matches like FRLG's
 * gAbilityInfo (which has y pegged to 0 across all entries).
 *
 * The 8-byte layout uses unsigned coordinates with FULL u8 range
 * (0..255) because FRLG uses y values like 237/238 to flag entries
 * that render as labels BELOW the on-map area (routes typically).
 * The 12-byte layout uses signed s16 in a tighter (-2..127) range to
 * match Ruby/Sapphire/Emerald data.
 *
 * Per-table validation (both layouts): ≥40 consecutive valid entries
 * AND ≥10 named entries AND ≥10 distinct (x,y) AND ≥3 distinct y.
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart.
 * PD 16: hack-aware - Unbound/Radical Red expand the table with custom
 *   areas; the parser handles arbitrary counts up to a defensive cap.
 */

import { decodeString } from '../text/codec.js';

/** Bytes per RegionMapLocation entry - defaults to the 12-byte layout
 *  for back-compat with callers (the detector's pre-check). The 8-byte
 *  layout is also supported internally; use REGION_MAP_SECTION_SIZE_BYTES_8
 *  when explicitly addressing it. */
export const REGION_MAP_SECTION_SIZE_BYTES = 12;
/** 12-byte (Emerald-style) RegionMapLocation. */
export const REGION_MAP_SECTION_SIZE_BYTES_12 = 12;
/** 8-byte (FRLG-style) RegionMapLocation. */
export const REGION_MAP_SECTION_SIZE_BYTES_8 = 8;

/** Minimum populated entries (with non-zero name ptr) required to
 *  accept a candidate run as the real gRegionMapEntries table. */
export const REGION_MAP_SECTIONS_MIN_NAMED = 10;

/** Minimum total consecutive valid entries (named + sentinel) required. */
export const REGION_MAP_SECTIONS_MIN_ENTRIES = 40;

/** Minimum number of distinct (x, y) coordinate pairs across the named
 *  entries. Real region maps are 2D scatter plots - locations live at
 *  different positions on the map. A false-positive run (another struct
 *  table that happens to have padding=0 and pointers into ROM) typically
 *  pegs y or x to a single value because the bytes are encoding something
 *  else (ability info, item info, etc.). Vanilla FRLG has ~88 named
 *  entries with ~80 distinct (x,y); the wrong-table false positive in
 *  the corpus had all 108 named entries at y=0 with ~30 distinct x - 
 *  fails this check, passes the others. */
export const REGION_MAP_SECTIONS_MIN_DISTINCT_XY = 10;

/** Minimum number of distinct y values across the named entries. Even
 *  if (x,y) variety passes by virtue of x sweeping, the wrong table
 *  was uniformly y=0 - this catches that explicitly. Vanilla FRLG has
 *  ~3 distinct y values when including the "below-map label" pseudo-y
 *  values 237/238; ROM hacks have more. */
export const REGION_MAP_SECTIONS_MIN_DISTINCT_Y = 3;

/** Defensive cap on entries walked per candidate. Vanilla 196; heavy
 *  hacks ~400. */
export const REGION_MAP_SECTIONS_MAX_ENTRIES = 1024;

/** 12-byte layout coord bounds (signed). Phase O.4 bumped MAX from 64 to 127. */
const COORD_MIN_S16 = -2;
const COORD_MAX_S16 = 127;

/** 8-byte layout coord bounds (unsigned u8 full range - FRLG uses y=237/238
 *  to mark below-map label entries). */
const COORD_MIN_U8 = 0;
const COORD_MAX_U8 = 255;

/** Width/height bounds (12-byte Emerald-style layout). Bumped to 16 in
 *  Phase O.4 for heavy hacks. */
const DIM_MIN = 0;
const DIM_MAX = 16;

/** Width/height bounds for the 8-byte FRLG layout. FRLG uses the same
 *  struct for on-map entries (small w/h like 1-3) AND for
 *  "label below the map" entries (where w is the LABEL PIXEL WIDTH,
 *  routinely 62 in vanilla). Allow full u8 range here; the printability
 *  + (x,y)-variety + y-variety guards together filter the false
 *  positives that this looser bound would otherwise admit. */
const DIM_MAX_U8 = 255;

/** Public re-exports of the per-layout field bounds. The region-map
 *  ENCODER (`maps/region-map-sections-writer.ts`) validates against
 *  these so it only ever emits entries `tryParseEntry12`/`tryParseEntry8`
 *  will accept - a writer that emits bytes the parser rejects is a
 *  silent corruption of the section table (the entry vanishes from the
 *  scanned table, and for the 12-byte layout a stray name-pointer byte
 *  in the padding field can invalidate the whole run). */
export const REGION_MAP_SECTION_COORD_MIN_S16 = COORD_MIN_S16;
export const REGION_MAP_SECTION_COORD_MAX_S16 = COORD_MAX_S16;
export const REGION_MAP_SECTION_DIM_MAX_12 = DIM_MAX;

/** GBA ROM mirror range - name pointers must fall here OR be 0. */
const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

/** Skip GBA cartridge header (first 192 bytes). */
const SCAN_BODY_OFFSET = 0xc0;

/** Maximum bytes to walk for a name string before bailing - Gen-3 area
 *  names are 10-15 chars typically; 24 is plenty. */
const NAME_READ_CAP = 24;

/** Discriminator for the discovered table's struct layout. */
export type RegionMapLayoutKind = '12byte' | '8byte';

export interface RegionMapSection {
  /** Index in the table (matches the regionMapSection byte on each
   *  MapHeader at offset 0x14). */
  readonly sectionIndex: number;
  /** Top-left region-map tile/pixel x coord. */
  readonly x: number;
  /** Top-left region-map tile/pixel y coord. */
  readonly y: number;
  /** Width in region-map tiles. */
  readonly width: number;
  /** Height in region-map tiles. */
  readonly height: number;
  /** ROM pointer to the name string (0 = unnamed sentinel slot). */
  readonly nameRomPointer: number;
  /** Decoded area name in Gen-3 charset (empty when nameRomPointer=0
   *  or the name failed to decode as printable). */
  readonly name: string;
  /** Absolute file offset of this entry. Entry size differs by layout - 
   *  see `RegionMapSectionsTable.layoutKind` + `entrySize`. */
  readonly fileOffset: number;
}

export interface RegionMapSectionsTable {
  /** Absolute file offset of the first entry. */
  readonly tableStart: number;
  /** Exclusive end. */
  readonly tableEndExclusive: number;
  /** Number of entries walked + accepted. */
  readonly entryCount: number;
  /** Per-entry parsed data. */
  readonly sections: ReadonlyArray<RegionMapSection>;
  /** Count of entries with a non-zero name pointer AND a non-empty
   *  decoded name. Vanilla FRLG: ~88. */
  readonly namedCount: number;
  /** Which struct layout was accepted. FRLG/LeafGreen and FRLG-based
   *  hacks use '8byte'; Ruby/Sapphire/Emerald use '12byte'. */
  readonly layoutKind: RegionMapLayoutKind;
  /** Bytes per entry - 8 or 12. */
  readonly entrySize: number;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readS16LE(bytes: Uint8Array, offset: number): number {
  const v = readU16LE(bytes, offset);
  return v < 0x8000 ? v : v - 0x10000;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function isRomPointerOrZero(ptr: number): boolean {
  if (ptr === 0) return true;
  return ptr >= GBA_ROM_BASE && ptr < GBA_ROM_END_EXCLUSIVE;
}

function ptrToFileOffset(ptr: number, romByteLength: number): number {
  if (ptr === 0) return -1;
  const off = ptr - GBA_ROM_BASE;
  if (off < 0 || off >= romByteLength) return -1;
  return off;
}

/** Decode the Gen-3 name string at `bytes[offset..]` up to NAME_READ_CAP
 *  bytes or the 0xFF terminator. Returns the decoded printable string
 *  or empty when nothing valid decoded. */
function decodeAreaName(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= bytes.length) return '';
  let end = offset;
  const limit = Math.min(bytes.length, offset + NAME_READ_CAP);
  while (end < limit && bytes[end] !== 0xff) end++;
  const length = end - offset;
  if (length < 1) return '';
  return decodeString(bytes, offset, length);
}

/** Decide whether a decoded name LOOKS like a real Pokémon area name.
 *  Real names are short uppercase strings of letters, digits, spaces,
 *  periods, apostrophes, and hyphens (e.g. "PALLET TOWN", "MT. MOON",
 *  "ROUTE 1", "S.S. ANNE"). A name with ANY '?' from the codec means
 *  the underlying bytes contained Gen-3-unmappable codes - almost
 *  certainly NOT an area-name table.
 *
 *  Empirically: the corpus FRLG ROM has a 880-entry false-positive
 *  table at file offset 0x237310 whose 8-byte structs have valid (x,y)
 *  variety (4 distinct y values), but 879 of 880 decoded names contain
 *  '?'. The real region map at 0x3F1CA8 has zero. This printability
 *  check is the single most decisive discriminator. */
// Accepts ASCII letters (upper + lower), digits, spaces, and common
// punctuation used in real Pokémon area names. Vanilla FRLG/RSE use
// all-caps ("PALLET TOWN", "MT. MOON"); modern hacks (Radical Red,
// Saiph, etc.) routinely use mixed case ("Pallet Town", "Mt. Moon").
const PRINTABLE_AREA_NAME_RE = /^[A-Za-z0-9 .'-]+$/;
function isPrintableAreaName(s: string): boolean {
  if (s.length < 3 || s.length > 20) return false;
  if (s.includes('?')) return false;
  return PRINTABLE_AREA_NAME_RE.test(s);
}

/** Try to parse one 12-byte RegionMapLocation at the given offset. */
function tryParseEntry12(
  bytes: Uint8Array,
  offset: number,
  sectionIndex: number,
): RegionMapSection | null {
  if (offset + REGION_MAP_SECTION_SIZE_BYTES_12 > bytes.length) return null;
  const x = readS16LE(bytes, offset + 0x00);
  if (x < COORD_MIN_S16 || x > COORD_MAX_S16) return null;
  const y = readS16LE(bytes, offset + 0x02);
  if (y < COORD_MIN_S16 || y > COORD_MAX_S16) return null;
  const width = bytes[offset + 0x04]!;
  if (width < DIM_MIN || width > DIM_MAX) return null;
  const height = bytes[offset + 0x05]!;
  if (height < DIM_MIN || height > DIM_MAX) return null;
  const padding = readU16LE(bytes, offset + 0x06);
  if (padding !== 0) return null;
  const nameRomPointer = readU32LE(bytes, offset + 0x08);
  if (!isRomPointerOrZero(nameRomPointer)) return null;
  let name = '';
  if (nameRomPointer !== 0) {
    const nameFileOffset = ptrToFileOffset(nameRomPointer, bytes.length);
    if (nameFileOffset >= 0) {
      name = decodeAreaName(bytes, nameFileOffset);
    }
  }
  return {
    sectionIndex,
    x,
    y,
    width,
    height,
    nameRomPointer,
    name,
    fileOffset: offset,
  };
}

/** Try to parse one 8-byte RegionMapLocation (FRLG-style) at the given
 *  offset. Layout: `{u8 x; u8 y; u8 w; u8 h; u32 name_ptr}`. All u8
 *  fields take the FULL 0..255 range - FRLG uses y values like 237/238
 *  to mark entries that render as labels BELOW the on-map area, and
 *  w=62 routinely for "label pixel width" on those entries. The
 *  printability + (x,y)-variety guards in the calling scanner do the
 *  semantic filtering. */
function tryParseEntry8(
  bytes: Uint8Array,
  offset: number,
  sectionIndex: number,
): RegionMapSection | null {
  if (offset + REGION_MAP_SECTION_SIZE_BYTES_8 > bytes.length) return null;
  const x = bytes[offset + 0x00]!;
  if (x < COORD_MIN_U8 || x > COORD_MAX_U8) return null; // always true, kept for symmetry
  const y = bytes[offset + 0x01]!;
  if (y < COORD_MIN_U8 || y > COORD_MAX_U8) return null;
  const width = bytes[offset + 0x02]!;
  if (width < DIM_MIN || width > DIM_MAX_U8) return null;
  const height = bytes[offset + 0x03]!;
  if (height < DIM_MIN || height > DIM_MAX_U8) return null;
  const nameRomPointer = readU32LE(bytes, offset + 0x04);
  if (!isRomPointerOrZero(nameRomPointer)) return null;
  let name = '';
  if (nameRomPointer !== 0) {
    const nameFileOffset = ptrToFileOffset(nameRomPointer, bytes.length);
    if (nameFileOffset >= 0) {
      name = decodeAreaName(bytes, nameFileOffset);
    }
  }
  return {
    sectionIndex,
    x,
    y,
    width,
    height,
    nameRomPointer,
    name,
    fileOffset: offset,
  };
}

export interface ScanRegionMapSectionsOptions {
  readonly minEntries?: number;
  readonly minNamed?: number;
  readonly maxEntries?: number;
  readonly minDistinctXY?: number;
  readonly minDistinctY?: number;
  /** Restrict the scan to a single layout for tests / debug. When omitted
   *  (default), both layouts are scanned and the larger named-count wins. */
  readonly layoutKind?: RegionMapLayoutKind;
}

/** Parameterised internal scanner: walk 4-byte-aligned offsets, greedily
 *  parse consecutive entries via `parseEntry`, accept the longest run
 *  whose named-count + variety guards pass. */
function scanWithLayout(
  bytes: Uint8Array,
  layoutKind: RegionMapLayoutKind,
  entrySize: number,
  parseEntry: (b: Uint8Array, off: number, idx: number) => RegionMapSection | null,
  fastPreCheck: (b: Uint8Array, off: number) => boolean,
  opts: Required<Pick<ScanRegionMapSectionsOptions,
    'minEntries' | 'minNamed' | 'maxEntries' | 'minDistinctXY' | 'minDistinctY'>>,
): RegionMapSectionsTable | null {
  if (bytes.length < SCAN_BODY_OFFSET + opts.minEntries * entrySize) {
    return null;
  }
  let best: RegionMapSectionsTable | null = null;
  const lastStart = bytes.length - opts.minEntries * entrySize;

  for (let p = SCAN_BODY_OFFSET; p <= lastStart; p += 4) {
    if (!fastPreCheck(bytes, p)) continue;

    const sections: RegionMapSection[] = [];
    let entryCount = 0;
    let namedCount = 0;
    const namedXY = new Set<number>();
    const namedY = new Set<number>();

    // Track consecutive "list-of-strings false-positive" entries: a
    // run of entries with all-zero coords (x=y=w=h=0) but a non-zero
    // printable name pointer. The 8-byte FRLG layout's loose bounds
    // (we permit any w/h ≤ 255) means a packed name-pointer table - 
    // think gMenuStrings or similar - can otherwise greedily extend
    // forever. Real region maps have at most a handful of all-zero
    // sentinel slots between named entries; menu-string tables have
    // long uninterrupted runs of them.
    let consecutiveAllZeroNamed = 0;
    const MAX_CONSECUTIVE_ALL_ZERO_NAMED = 8;
    // Track unique printable names. Real region maps have mostly
    // unique area names (PALLET TOWN appears once, PEWTER CITY once,
    // etc.). False-positive tables tend to be label-tables-shared-
    // across-maps where the same string is referenced from many
    // entries (e.g. "RESEARCH LAB" 3× for sub-maps of Oak's lab).
    // We use uniqueName count instead of total named count for the
    // picker so a small unique table beats a large duplicate-laden one.
    const uniqueNames = new Set<string>();
    while (entryCount < opts.maxEntries) {
      const entryOff = p + entryCount * entrySize;
      const parsed = parseEntry(bytes, entryOff, entryCount);
      if (parsed === null) break;
      const isAllZeroCoords =
        parsed.x === 0 && parsed.y === 0 && parsed.width === 0 && parsed.height === 0;
      const isPrintable =
        parsed.nameRomPointer !== 0 &&
        parsed.name.length > 0 &&
        isPrintableAreaName(parsed.name);
      if (isAllZeroCoords && isPrintable) {
        consecutiveAllZeroNamed++;
        if (consecutiveAllZeroNamed > MAX_CONSECUTIVE_ALL_ZERO_NAMED) {
          break;
        }
      } else {
        consecutiveAllZeroNamed = 0;
      }
      sections.push(parsed);
      // RT-1.1: only count an entry as "named" when its decoded name
      // is printable Pokémon-style text (no '?' from unmappable codec
      // bytes). This is the single most decisive discriminator
      // against false-positive 8-byte and 12-byte tables that happen
      // to have ROM-space pointers at the expected offset.
      if (isPrintable) {
        namedCount++;
        namedXY.add(((parsed.x & 0xffff) << 16) | (parsed.y & 0xffff));
        namedY.add(parsed.y);
        uniqueNames.add(parsed.name);
      }
      entryCount++;
    }
    const uniqueNamedCount = uniqueNames.size;

    if (entryCount < opts.minEntries) continue;
    if (namedCount < opts.minNamed) continue;
    if (namedXY.size < opts.minDistinctXY) continue;
    if (namedY.size < opts.minDistinctY) continue;
    // Unique-name guard: a real region map has mostly distinct
    // location names. False-positive 8-byte tables that look like
    // "map label" arrays (multiple sub-maps sharing an area label) or
    // pop-up text tables tend to have many duplicates. Require unique
    // names ≥ 80% of named entries.
    if (uniqueNamedCount < Math.ceil(namedCount * 0.8)) continue;
    // Multi-word-name guard: real region map entries are place names
    // like "Pallet Town" / "Mt. Moon" / "Route 1" / "S.S. Anne" - 
    // they almost always contain a space (multi-word) OR a period
    // (abbreviated multi-word). Single-word printable-name tables
    // like trainer first-name pools ("Emma", "Ava", "Sophia", ...)
    // or simple item-name pools fail this. Require ≥40% of named
    // entries to contain a space or period.
    let multiWordCount = 0;
    for (const s of sections) {
      if (
        s.nameRomPointer !== 0 &&
        s.name.length > 0 &&
        isPrintableAreaName(s.name) &&
        (s.name.includes(' ') || s.name.includes('.'))
      ) {
        multiWordCount++;
      }
    }
    if (multiWordCount < Math.ceil(namedCount * 0.4)) continue;

    const candidate: RegionMapSectionsTable = {
      tableStart: p,
      tableEndExclusive: p + entryCount * entrySize,
      entryCount,
      sections: Object.freeze(sections),
      namedCount,
      layoutKind,
      entrySize,
    };
    // Picker: prefer EARLIER addresses when both candidates clear ALL
    // the guards. The real gRegionMapEntries on Gen-3 ROMs is
    // canonically at a lower address than auxiliary string tables
    // (map labels, trainer name pools, music ambiance pools, etc.)
    // that the structural validators alone can't distinguish from a
    // real region map. Once a candidate clears the guards, we trust
    // it as authoritative - overriding later would routinely cause
    // larger-but-wrong tables (e.g. an Unbound ambiance pool with 102
    // named tracks vs the real 55-entry region map) to displace the
    // truth.
    if (best === null) {
      best = candidate;
    }
    // (else: keep `best` - earlier address wins.)
    // Skip past this run to avoid duplicate detection on overlapping windows.
    p += (entryCount - 1) * 4;
  }
  return best;
}

/** Fast pre-check for 12-byte entries: padding u16 at +0x06 must be 0,
 *  name pointer at +0x08 must be ROM-space or zero. */
function preCheck12(bytes: Uint8Array, p: number): boolean {
  if (p + 12 > bytes.length) return false;
  if (bytes[p + 0x06] !== 0 || bytes[p + 0x07] !== 0) return false;
  const firstPtr = readU32LE(bytes, p + 0x08);
  return isRomPointerOrZero(firstPtr);
}

/** Fast pre-check for 8-byte entries: name pointer at +0x04 must be
 *  ROM-space or zero. (No padding field to check.) */
function preCheck8(bytes: Uint8Array, p: number): boolean {
  if (p + 8 > bytes.length) return false;
  const firstPtr = readU32LE(bytes, p + 0x04);
  return isRomPointerOrZero(firstPtr);
}

/**
 * Find the longest valid `gRegionMapEntries[]` in `bytes`. Tries both
 * 8-byte (FRLG) and 12-byte (Emerald) layouts in parallel; returns
 * whichever produces the larger valid named count. Returns `null` when
 * no run clears the min-entries × min-named × variety thresholds in
 * either layout.
 */
export function scanRegionMapSections(
  bytes: Uint8Array,
  opts?: ScanRegionMapSectionsOptions,
): RegionMapSectionsTable | null {
  const resolved = {
    minEntries: opts?.minEntries ?? REGION_MAP_SECTIONS_MIN_ENTRIES,
    minNamed: opts?.minNamed ?? REGION_MAP_SECTIONS_MIN_NAMED,
    maxEntries: opts?.maxEntries ?? REGION_MAP_SECTIONS_MAX_ENTRIES,
    minDistinctXY: opts?.minDistinctXY ?? REGION_MAP_SECTIONS_MIN_DISTINCT_XY,
    minDistinctY: opts?.minDistinctY ?? REGION_MAP_SECTIONS_MIN_DISTINCT_Y,
  };

  let best12: RegionMapSectionsTable | null = null;
  let best8: RegionMapSectionsTable | null = null;

  if (opts?.layoutKind === undefined || opts.layoutKind === '12byte') {
    best12 = scanWithLayout(
      bytes,
      '12byte',
      REGION_MAP_SECTION_SIZE_BYTES_12,
      tryParseEntry12,
      preCheck12,
      resolved,
    );
  }
  if (opts?.layoutKind === undefined || opts.layoutKind === '8byte') {
    best8 = scanWithLayout(
      bytes,
      '8byte',
      REGION_MAP_SECTION_SIZE_BYTES_8,
      tryParseEntry8,
      preCheck8,
      resolved,
    );
  }

  if (best12 && best8) {
    return best8.namedCount > best12.namedCount ? best8 : best12;
  }
  return best8 ?? best12;
}
