/**
 * Gen-3 gTrainerClassNames table parser + structural-only scanner - 
 * Phase UW-3 / Category 6 substrate (iter 84 / UW-3-T3).
 *
 * The Gen-3 `gTrainerClassNames` table holds the human-readable trainer
 * class names ("HIKER", "BUG CATCHER", "BIRD KEEPER", "TEAM AQUA",
 * "{PKMN} TRAINER", etc.) referenced by the trainerClass byte in each
 * Trainer struct. Vanilla FRLG has 107 classes; Emerald has 58;
 * RSE-derived hacks vary.
 *
 * Unlike species-names / ability-names / move-names which have universal
 * canonical name PAIRS (BULBASAUR+IVYSAUR / STENCH+DRIZZLE / POUND+KARATE
 * CHOP), trainer-class names DIVERGE substantially between FRLG and RSE
 * - there is no single pair guaranteed at fixed indices across all
 * Gen-3 carts. This scanner uses STRUCTURAL-only signature detection:
 * find a run of 13-byte slots where each slot contains valid Gen-3
 * ALL-CAPS charset bytes + a 0xFF terminator. Anchor confirmation
 * (10 consecutive valid slots) filters stray valid-looking text runs
 * elsewhere in the ROM.
 *
 * Per PD 5: structural - works on any Gen-3 cart whose trainer-class
 * name table retains the canonical 13-byte slot layout. The structural
 * approach is universal across FRLG / Emerald / RSE / all derived
 * hacks.
 *
 * Mirrors ability-names (iter 71) slot layout but uses
 * structural-anchor instead of signature-pair detection.
 */

import { decodeString } from '../text/codec.js';

/** Size of one trainer-class-name slot in bytes. Per pret/pokefirered
 *  TRAINER_CLASS_NAME_LENGTH = 13 (12 chars + terminator). */
export const TRAINER_CLASS_NAME_SLOT_BYTES = 13;

/** Minimum valid slots in a run to consider this the trainer-class
 *  names table. Emerald has 58; FRLG has 107; even reduced hacks
 *  retain ≥40 most of the time. Set to 30 as a defensive floor. */
export const TRAINER_CLASS_NAMES_MIN_VALID_SLOTS = 30;

/** Number of slots required to consecutively validate before treating
 *  the offset as the anchor (filters stray text runs). */
export const TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION = 10;

/** Cap on slots read in a single call. */
export const TRAINER_CLASS_NAMES_READ_CAP = 512;

/** Cartridge-header skip. */
const CARTRIDGE_HEADER_END = 0xc0;

/**
 * Read `count` trainer-class name slots starting at `offset`.
 */
export function readTrainerClassNamesAt(
  romBytes: Uint8Array,
  offset: number,
  count: number,
): string[] {
  const cappedCount = Math.min(count, TRAINER_CLASS_NAMES_READ_CAP);
  const names: string[] = [];
  for (let i = 0; i < cappedCount; i++) {
    const slotStart = offset + i * TRAINER_CLASS_NAME_SLOT_BYTES;
    if (slotStart + TRAINER_CLASS_NAME_SLOT_BYTES > romBytes.length) break;
    names.push(decodeString(romBytes, slotStart, TRAINER_CLASS_NAME_SLOT_BYTES));
  }
  return names;
}

/**
 * Validate that a single 13-byte slot decodes as a trainer-class-shaped
 * name: ≥3 uppercase A-Z chars, no garbage, properly terminated within
 * the slot.
 *
 * The terminator requirement is load-bearing, not cosmetic. Every real
 * Gen-3 trainer-class slot ends in 0xFF, so a slot that runs off the end
 * of its 13 bytes without one is a misaligned read of some *other*
 * structure. Admitting unterminated slots at a fixed 13-byte stride
 * makes the run-walk blind to slot-size drift: two adjacent 12-byte
 * name entries read at a 13-byte stride both look "valid" (each read
 * ends mid-way through the next entry, still inside the A-Z range), so
 * the walk coasts straight through a stride change and can re-anchor on
 * unrelated uppercase data further down the ROM.
 *
 * `readSlot` is handed in so `findTrainerClassNamesTable` can walk
 * candidate strides while `readTrainerClassNamesAt` keeps the fixed one.
 */
function readSlot(
  romBytes: Uint8Array,
  slotOffset: number,
  slotBytes: number,
): { decoded: string; terminated: boolean } | null {
  if (slotOffset < 0 || slotOffset + slotBytes > romBytes.byteLength) return null;
  const decoded = decodeString(romBytes, slotOffset, slotBytes);
  // decodeString stops at the first 0xFF, so a terminator inside the slot
  // means it consumed fewer than slotBytes bytes.
  const terminated = decoded.length < slotBytes;
  return { decoded, terminated };
}

function isShapedClassSlot(decoded: string): boolean {
  if (decoded.length === 0) return false;
  if (decoded.includes('??')) return false;
  if (decoded.split('').every((c) => c === '?')) return false;
  // Accept single-word ALL-CAPS (HIKER) OR multi-word (BUG CATCHER)
  // OR with brace-substitutions like {PKMN} TRAINER (decoded as "?" for
  // the substitution token - so check for ≥3 contiguous A-Z chars
  // ignoring potential leading "?" substitution markers).
  return /[A-Z]{3,}/.test(decoded);
}

function isValidTrainerClassSlot(
  romBytes: Uint8Array,
  slotOffset: number,
  slotBytes: number = TRAINER_CLASS_NAME_SLOT_BYTES,
): boolean {
  const slot = readSlot(romBytes, slotOffset, slotBytes);
  if (slot === null || !slot.terminated) return false;
  return isShapedClassSlot(slot.decoded);
}

/** Slot sizes a real Gen-3 gTrainerClassNames table is known to use.
 *  Vanilla FRLG/Emerald and every hack checked so far use 13 (12 chars +
 *  0xFF); 12 shows up in tables that were rewritten without the
 *  terminator slot. Ordered by how likely they are to be the true
 *  stride, so ties in run length resolve to the conventional layout. */
export const TRAINER_CLASS_NAME_SLOT_CANDIDATES: ReadonlyArray<number> = Object.freeze([
  TRAINER_CLASS_NAME_SLOT_BYTES,
  12,
]);

/**
 * Validate that `names` look like a real Gen-3 trainer-class-names
 * table: enough entries + ≥60% of sampled entries are class-name-shaped.
 */
export function validateTrainerClassNames(names: ReadonlyArray<string>): boolean {
  if (names.length < TRAINER_CLASS_NAMES_MIN_VALID_SLOTS) return false;
  let goodCount = 0;
  let checkedCount = 0;
  const sampleEnd = Math.min(20, names.length);
  for (let i = 0; i < sampleEnd; i++) {
    checkedCount++;
    const name = names[i]!;
    if (name.length === 0) continue;
    if (name.length > 12) continue;
    if (name.includes('??')) continue;
    if (name.split('').every((c) => c === '?')) continue;
    if (/[A-Z]{3,}/.test(name) || /[A-Z]+ [A-Z]+/.test(name)) goodCount++;
  }
  return checkedCount > 0 && goodCount >= Math.ceil(checkedCount * 0.6);
}

/**
 * Find the gTrainerClassNames table using structural-only validation.
 * Scans 4-byte-aligned offsets past the cartridge header for a run of
 * `TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION` consecutive valid slots,
 * then walks forward counting the full run length.
 *
 * Returns the offset of the first valid slot if a run of ≥
 * `TRAINER_CLASS_NAMES_MIN_VALID_SLOTS` slots is found; null otherwise.
 *
 * Two details keep the reported run from overshooting into unrelated
 * data further down the ROM:
 *
 *  - Every counted slot must terminate (0xFF) inside its own slot, so a
 *    stride change ends the run instead of being read straight through.
 *  - The walk stops at the first unterminated slot rather than skipping
 *    it and resuming, which is what previously let the cursor coast past
 *    a 12-byte region onto an unrelated uppercase string run.
 *
 * Ties are resolved by candidate order (13 first), so a genuine 13-byte
 * table always wins over the 12-byte reading of itself.
 *
 * PD 5: structural - works on any Gen-3 cart.
 */
export function findTrainerClassNamesTable(romBytes: Uint8Array): number | null {
  const maxSlotBytes = Math.max(...TRAINER_CLASS_NAME_SLOT_CANDIDATES);
  if (
    romBytes.byteLength <
    CARTRIDGE_HEADER_END +
      TRAINER_CLASS_NAMES_MIN_VALID_SLOTS * maxSlotBytes
  ) {
    return null;
  }
  const limit = romBytes.byteLength - maxSlotBytes;
  let best: { offset: number; count: number } | null = null;

  for (let p = CARTRIDGE_HEADER_END; p <= limit; p += 4) {
    for (const slotBytes of TRAINER_CLASS_NAME_SLOT_CANDIDATES) {
      // Anchor confirmation: require 10 consecutive valid slots from p
      // at THIS stride.
      let confirmed = true;
      for (let i = 0; i < TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION; i++) {
        const slotOff = p + i * slotBytes;
        if (!isValidTrainerClassSlot(romBytes, slotOff, slotBytes)) {
          confirmed = false;
          break;
        }
      }
      if (!confirmed) continue;

      // Walk forward at the same stride to find the run length.
      let count = TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION;
      let cursor = p + TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION * slotBytes;
      while (
        cursor + slotBytes <= romBytes.byteLength &&
        count < TRAINER_CLASS_NAMES_READ_CAP
      ) {
        if (!isValidTrainerClassSlot(romBytes, cursor, slotBytes)) break;
        count++;
        cursor += slotBytes;
      }

      // Longer run wins; on a tie the earlier candidate (13-byte) keeps
      // the table, matching the canonical Gen-3 layout.
      if (
        count >= TRAINER_CLASS_NAMES_MIN_VALID_SLOTS &&
        (best === null ||
          count > best.count ||
          (count === best.count && p < best.offset))
      ) {
        best = { offset: p, count };
      }
    }
  }

  return best?.offset ?? null;
}
