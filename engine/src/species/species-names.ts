/**
 * Species name table parser + scanner - Phase UW-3 substrate
 * (Category 3 species content, iter 59).
 *
 * The Pokémon Gen-3 `gSpeciesNames` table is a packed array of fixed
 * 11-byte slots (10 chars max + 0xFF terminator slot). Slot 0 is the
 * "??????????" placeholder; slot 1+ are BULBASAUR, IVYSAUR, VENUSAUR,
 * etc. (vanilla) or "Bulbasaur", "Ivysaur" (CFRU's mixed-case
 * convention, used by every modernized FRLG fork including CFRU
 * itself, Radical Red, Inflamed Red, and the Modernize-and-Ship
 * bundle this editor ships).
 *
 * Per PD 4/PD 5 (universality first; no FireRed/Emerald-only path):
 * detection has three layers, tried in order:
 *
 *   1. **Pointer dereference** - both vanilla FRLG and every CFRU
 *      fork hold a 32-bit LE pointer to the species names table at
 *      file offset 0x144 (CFRU's `gSpeciesNames` macro literally
 *      dereferences `*((u32*)0x8000144)`, and vanilla FRLG happens
 *      to store the same pointer there because its startup code
 *      references the table through that slot too). This is the
 *      cheapest and most reliable path; we try it first.
 *
 *   2. **BULBASAUR/IVYSAUR signature scan** - best-effort byte
 *      search for the canonical first-species pair at the
 *      documented 11-byte stride. Catches hacks that may have
 *      moved the pointer to a non-vanilla offset (rare but the
 *      SSOT path before the pointer trick was discovered).
 *
 *   3. **Bulbasaur/Ivysaur signature scan** - same idea, mixed
 *      case, for CFRU-style hacks whose `gSpeciesNames` got moved
 *      AND whose extended species table omits the all-caps form.
 *
 * Slot counting uses byte-level validation (not regex on decoded
 * strings) so it cleanly rejects the move-names table that
 * immediately follows vanilla FRLG's species table - the existing
 * "filter slot.length > 0" approach over-counted because
 * misaligned reads into gMoveNames happen to decode as
 * letter-containing strings.
 *
 * PD 13: this module is the canonical SSOT for species-name reading.
 */

import { decodeString, encodeString, STRING_TERMINATOR } from '../text/codec.js';

export const SPECIES_NAME_SLOT_BYTES = 11;
/** Minimum number of slots a real species-names table must have for
 *  the validator to accept it. Lower than vanilla 412 to tolerate
 *  hacks that shrink the dex; higher than incidental matches. */
export const SPECIES_NAMES_MIN_VALID_SLOTS = 50;
/** Maximum slots we ever attempt to read in a single call (defensive
 *  cap for hacks claiming an enormous dex). 4096 comfortably covers
 *  every known Gen-3 hack: stock CFRU is 1294, Radical Red 4.10 is
 *  1376, Unbound 2.1.1.1 is 1294. */
export const SPECIES_NAMES_READ_CAP = 4096;
/** Placeholder character byte (Gen-3 codec '?' = 0xAC). */
export const SPECIES_PLACEHOLDER_BYTE = 0xac;
/** Gen-3 codec uppercase A–Z range. */
const UPPER_A = 0xbb;
const UPPER_Z = 0xd4;
/** Gen-3 codec lowercase a–z range. */
const LOWER_A = 0xd5;
const LOWER_Z = 0xee;
/** Gen-3 codec digit 0–9 range. */
const DIGIT_0 = 0xa1;
const DIGIT_9 = 0xaa;
/** Gen-3 codec accented uppercase + lowercase range
 *  (À Á Â Ç È É Ê Ë Ì Î Ï Ò Ó Ô Œ Ù Ú Û Ñ ß à á ç è é ê ë ì î ï ò ó ô œ ù ú û ñ).
 *  Real species names use these - e.g. Unbound 2.1.1.1's "Flabèbè"
 *  encodes `è` as byte 0x1a (the charmap byte for è; the codec's table
 *  had this block shifted by one until it was corrected). */
const ACCENT_LO = 0x01;
const ACCENT_HI = 0x2a;
/** Gen-3 codec European-localization variant range (Ä Ö Ü ä ö ü). */
const EURO_LO = 0xf1;
const EURO_HI = 0xf6;
/** Punctuation bytes legal inside a species name. CFRU's `gSpeciesNames`
 *  uses `!` and `?` (Unown form variants UNOWN!/UNOWN?), period for
 *  Mr. Mime, hyphen for Ho-Oh / Porygon-Z, apostrophe for Farfetch'd,
 *  and ♂/♀ for the Nidoran forms. The `?` byte (0xAC) is also the
 *  placeholder byte, but `classifySpeciesNameSlot` only routes a slot
 *  to the placeholder path when 0xAC is the FIRST byte - so allowing
 *  it as a legal interior byte for real names is safe. */
const BYTE_SPACE = 0x00;
const BYTE_EXCLAMATION = 0xab; // '!' (UNOWN!)
const BYTE_QUESTION = 0xac; // '?' (UNOWN?) - also the placeholder byte
const BYTE_PERIOD = 0xad; // '.' (MR. MIME, Mime Jr.)
const BYTE_HYPHEN = 0xae; // '-' (Ho-Oh, Porygon-Z)
const BYTE_APOSTROPHE_LEFT = 0xb3; // '‘'
const BYTE_APOSTROPHE_RIGHT = 0xb4; // '’' (Farfetch'd)
const BYTE_MALE = 0xb5; // '♂' (Nidoran♂)
const BYTE_FEMALE = 0xb6; // '♀' (Nidoran♀)
const BYTE_COLON = 0xf0; // ':' (Type: Null)

/**
 * File offset of the 32-bit little-endian pointer to `gSpeciesNames`
 * in every BPRE/BPGE ROM (vanilla FRLG, CFRU, and every CFRU fork).
 * CFRU's `include/new/rom_locs.h` defines `gSpeciesNames` as
 * `(SpeciesNames_t*) *((u32*) 0x8000144)`; vanilla FRLG happens to
 * keep the equivalent reference here too because the startup code
 * loads the species names base through this slot.
 */
export const SPECIES_NAMES_POINTER_FILE_OFFSET = 0x144;

/** Mask GBA bus addresses (`0x08XXXXXX` / `0x09XXXXXX`) down to a
 *  file offset within the ROM image. */
const GBA_ROM_FILE_OFFSET_MASK = 0x01ffffff;

/**
 * Read `count` species name slots starting at `offset`. Decoding stops
 * if a slot extends past the buffer end (returns fewer than `count`
 * entries in that case).
 */
export function readSpeciesNamesAt(
  romBytes: Uint8Array,
  offset: number,
  count: number,
): string[] {
  const cappedCount = Math.min(count, SPECIES_NAMES_READ_CAP);
  const names: string[] = [];
  for (let i = 0; i < cappedCount; i++) {
    const slotStart = offset + i * SPECIES_NAME_SLOT_BYTES;
    if (slotStart + SPECIES_NAME_SLOT_BYTES > romBytes.length) break;
    names.push(decodeString(romBytes, slotStart, SPECIES_NAME_SLOT_BYTES));
  }
  return names;
}

function byteIsLetter(b: number): boolean {
  return (b >= UPPER_A && b <= UPPER_Z) || (b >= LOWER_A && b <= LOWER_Z);
}

function byteIsLegalNameInterior(b: number): boolean {
  return (
    byteIsLetter(b) ||
    (b >= DIGIT_0 && b <= DIGIT_9) ||
    (b >= ACCENT_LO && b <= ACCENT_HI) ||
    (b >= EURO_LO && b <= EURO_HI) ||
    b === BYTE_SPACE ||
    b === BYTE_EXCLAMATION ||
    b === BYTE_QUESTION ||
    b === BYTE_PERIOD ||
    b === BYTE_HYPHEN ||
    b === BYTE_APOSTROPHE_LEFT ||
    b === BYTE_APOSTROPHE_RIGHT ||
    b === BYTE_MALE ||
    b === BYTE_FEMALE ||
    b === BYTE_COLON
  );
}

/** Slot classification used by the table-length walker. */
export type SpeciesNameSlotKind = 'name' | 'placeholder' | 'garbage' | 'eof';

/**
 * Classify a single 11-byte slot at `slotStart` as a real species
 * name, a placeholder (`??????…`), end-of-buffer, or garbage (table
 * end / wrong location).
 *
 * Works on raw bytes rather than decoded strings so it cleanly
 * rejects misaligned reads into adjacent ROM tables (the vanilla
 * FRLG species table sits ~adjacent to `gMoveNames`; an 11-byte
 * stride into `gMoveNames`'s 13-byte slots produces letter-rich
 * garbage that the old "filter slot.length > 0" approach happily
 * counted as species).
 */
export function classifySpeciesNameSlot(
  romBytes: Uint8Array,
  slotStart: number,
): SpeciesNameSlotKind {
  if (slotStart + SPECIES_NAME_SLOT_BYTES > romBytes.length) return 'eof';
  const first = romBytes[slotStart]!;

  // Placeholder: 1+ '?' bytes followed by terminator (or running to
  // the end of the slot - '?'s with no terminator are still a
  // placeholder shape).
  if (first === SPECIES_PLACEHOLDER_BYTE) {
    let i = 0;
    while (i < SPECIES_NAME_SLOT_BYTES && romBytes[slotStart + i] === SPECIES_PLACEHOLDER_BYTE) {
      i++;
    }
    if (i === SPECIES_NAME_SLOT_BYTES) return 'placeholder';
    if (romBytes[slotStart + i] === STRING_TERMINATOR) return 'placeholder';
    return 'garbage';
  }

  // Real species name: starts with a letter, contains only legal
  // name bytes, terminated by 0xFF within the slot. Length 2..10
  // (canonical Gen-3 species names; the slot's 11th byte is the
  // terminator for max-length names).
  if (!byteIsLetter(first)) return 'garbage';
  let nameLen = -1;
  for (let i = 0; i < SPECIES_NAME_SLOT_BYTES; i++) {
    const b = romBytes[slotStart + i]!;
    if (b === STRING_TERMINATOR) {
      nameLen = i;
      break;
    }
    if (!byteIsLegalNameInterior(b)) return 'garbage';
  }
  if (nameLen < 2 || nameLen > 10) return 'garbage';
  return 'name';
}

/** Result of walking the species-names table from a candidate start. */
export interface SpeciesNamesTableShape {
  /** Total table length in slots - i.e. (lastAcceptedSlotIndex + 1).
   *  Equivalent to "max species ID + 1" for the ROM, which matches
   *  CFRU's `NUM_SPECIES` macro. */
  readonly totalSlotCount: number;
  /** Count of slots classified as real names (excludes placeholder
   *  at slot 0 and any embedded placeholder slots). */
  readonly nameSlotCount: number;
  /** Count of slots classified as placeholders (typically slot 0
   *  plus the FRLG-style "Hoenn species placeholder" range between
   *  Celebi and Treecko in vanilla FRLG). */
  readonly placeholderSlotCount: number;
}

/**
 * Walk forward from `tableOffset` and return the table's slot count
 * + classification breakdown. Defaults to strict stop-on-first-garbage
 * - the byte-level validator already covers vanilla's `’`-apostrophe
 * FARFETCH'D + Unbound's `è`-accented Flabèbè etc., so legitimate
 * names never decode as garbage; the first garbage slot is the table
 * end. Walks at most `SPECIES_NAMES_READ_CAP` slots.
 *
 * Callers may pass a higher `garbageTolerance` for diagnostic
 * inspection of a damaged table, but the default keeps the walker
 * from walking off the end of `gSpeciesNames` into the adjacent
 * `gMoveNames` table (vanilla FRLG's species table is followed
 * immediately by move names, and the 11-byte stride into 13-byte
 * move-name slots produces byte sequences that happen to satisfy the
 * "starts with a letter" check for several slots in a row).
 */
export function measureSpeciesNamesTable(
  romBytes: Uint8Array,
  tableOffset: number,
  garbageTolerance: number = 0,
): SpeciesNamesTableShape {
  let lastAccepted = -1;
  let nameSlots = 0;
  let placeholderSlots = 0;
  let consecutiveGarbage = 0;
  for (let i = 0; i < SPECIES_NAMES_READ_CAP; i++) {
    const slotStart = tableOffset + i * SPECIES_NAME_SLOT_BYTES;
    const kind = classifySpeciesNameSlot(romBytes, slotStart);
    if (kind === 'eof') break;
    if (kind === 'garbage') {
      consecutiveGarbage++;
      if (consecutiveGarbage > garbageTolerance) break;
      continue;
    }
    lastAccepted = i;
    consecutiveGarbage = 0;
    if (kind === 'name') nameSlots++;
    else placeholderSlots++;
  }
  return Object.freeze({
    totalSlotCount: lastAccepted + 1,
    nameSlotCount: nameSlots,
    placeholderSlotCount: placeholderSlots,
  });
}

/**
 * Validate that the decoded `names` look like a real Gen-3 species
 * table: enough entries, and ≥ 60% of the first 20 real species
 * (skipping the placeholder at idx 0) decode as plausible names - 
 * 2+ consecutive letters (case-insensitive, so CFRU's mixed-case
 * "Bulbasaur" passes alongside vanilla's "BULBASAUR"). Empty /
 * overly-long / all-? entries are rejected.
 */
export function validateSpeciesNames(names: ReadonlyArray<string>): boolean {
  if (names.length < SPECIES_NAMES_MIN_VALID_SLOTS) return false;
  let goodCount = 0;
  let checkedCount = 0;
  const sampleEnd = Math.min(21, names.length);
  for (let i = 1; i < sampleEnd; i++) {
    checkedCount++;
    const name = names[i]!;
    if (name.length === 0) continue;
    if (name.length > 10) continue;
    if (name.includes('??')) continue;
    if (name.split('').every((c) => c === '?')) continue;
    // Accept BOTH all-uppercase (vanilla) and mixed-case (CFRU) names.
    if (/[A-Za-z]{2,}/.test(name)) goodCount++;
  }
  return checkedCount > 0 && goodCount >= Math.ceil(checkedCount * 0.6);
}

/**
 * Try to locate the species names table by dereferencing the canonical
 * pointer at `SPECIES_NAMES_POINTER_FILE_OFFSET` (0x144). Returns the
 * resolved file offset if it points to a plausible table (placeholder
 * slot 0 + at least one valid name slot following), else `null`.
 *
 * This works on:
 *   - Vanilla FRLG (pointer → 0x245EE0, vanilla species names table)
 *   - CFRU and every CFRU fork (pointer → relocated extended table)
 *   - Unbound (which independently relocates the table via the same
 *     pointer convention)
 */
export function findSpeciesNamesTableViaPointer(romBytes: Uint8Array): number | null {
  if (romBytes.length < SPECIES_NAMES_POINTER_FILE_OFFSET + 4) return null;
  const off = SPECIES_NAMES_POINTER_FILE_OFFSET;
  const ptr =
    (romBytes[off]! |
      (romBytes[off + 1]! << 8) |
      (romBytes[off + 2]! << 16) |
      (romBytes[off + 3]! << 24)) >>>
    0;
  // GBA ROM bus addresses live at 0x08000000..0x09FFFFFF. Reject
  // pointers that don't look like ROM-space.
  if (ptr < 0x08000000 || ptr > 0x09ffffff) return null;
  const fileOff = ptr & GBA_ROM_FILE_OFFSET_MASK;
  if (fileOff + SPECIES_NAME_SLOT_BYTES * 2 > romBytes.length) return null;
  // Slot 0 must be a placeholder; slot 1 must be a real name.
  if (classifySpeciesNameSlot(romBytes, fileOff) !== 'placeholder') return null;
  if (classifySpeciesNameSlot(romBytes, fileOff + SPECIES_NAME_SLOT_BYTES) !== 'name') {
    return null;
  }
  return fileOff;
}

/**
 * Best-effort signature scan for `gSpeciesNames` in any Gen-3-shaped
 * ROM. Searches for the encoded `BULBASAUR`/`IVYSAUR` (uppercase,
 * vanilla style) AND `Bulbasaur`/`Ivysaur` (mixed case, CFRU style)
 * at the documented 11-byte stride. Returns the table START offset
 * (placeholder slot 0) or `null` if not found.
 *
 * Tries pointer-dereference first via
 * `findSpeciesNamesTableViaPointer` - that's the canonical path on
 * BPRE/BPGE ROMs. Falls back to byte-pattern search for ROMs where
 * the pointer at 0x144 has been damaged or moved.
 *
 * PD 5: the only Pokémon-specific assumption is the literal byte
 * strings "BULBASAUR"/"Bulbasaur" + "IVYSAUR"/"Ivysaur". Both are
 * universally present in every Gen-3 game (and every hack that keeps
 * Gen-1 Pokémon - i.e. essentially all of them, since Bulbasaur is
 * species #1 by Pokédex order). For ROMs without these species, scan
 * returns null.
 */
export function findSpeciesNamesTable(romBytes: Uint8Array): number | null {
  // Layer 1: pointer dereference. Fast, exact, and works for vanilla
  // + every CFRU-family fork. ~99% of real-world ROMs hit this path.
  const viaPointer = findSpeciesNamesTableViaPointer(romBytes);
  if (viaPointer !== null) return viaPointer;

  // Layer 2/3: signature scan, case-by-case.
  const variants: ReadonlyArray<{ bulb: string; ivy: string }> = [
    { bulb: 'BULBASAUR', ivy: 'IVYSAUR' },
    { bulb: 'Bulbasaur', ivy: 'Ivysaur' },
  ];
  for (const { bulb, ivy } of variants) {
    const found = scanForBulbasaurPair(romBytes, bulb, ivy);
    if (found !== null) return found;
  }
  return null;
}

function scanForBulbasaurPair(
  romBytes: Uint8Array,
  bulbasaur: string,
  ivysaur: string,
): number | null {
  const needle = encodeString(bulbasaur);
  const ivyBytes = encodeString(ivysaur);
  const search = Buffer.isBuffer(romBytes) ? romBytes : Buffer.from(romBytes);

  let searchStart = 0;
  while (searchStart < romBytes.length - 32) {
    const found = search.indexOf(Buffer.from(needle), searchStart);
    if (found < 0) return null;
    // BULBASAUR slot starts at `found` (= species index 1 slot start).
    // Table start is therefore `found - 11`.
    const tableStart = found - SPECIES_NAME_SLOT_BYTES;
    if (tableStart < 0) {
      searchStart = found + 1;
      continue;
    }
    // IVYSAUR slot should start at `tableStart + 22`.
    const ivyStart = tableStart + 2 * SPECIES_NAME_SLOT_BYTES;
    if (
      ivyStart + ivyBytes.length <= romBytes.length &&
      bytesEqual(romBytes, ivyStart, ivyBytes)
    ) {
      // Validate placeholder slot shape at tableStart.
      if (classifySpeciesNameSlot(romBytes, tableStart) === 'placeholder') {
        return tableStart;
      }
    }
    searchStart = found + 1;
  }
  return null;
}

function bytesEqual(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}
