/**
 * Gen-3 gTrainerClassNames table parser + structural-only scanner -
 * Phase UW-3 / Category 6 substrate (iter 84 / UW-3-T3).
 *
 * The Gen-3 `gTrainerClassNames` table holds the human-readable trainer
 * class names ("HIKER", "BUG CATCHER", "BIRD KEEPER", "TEAM AQUA",
 * "{PKMN} TRAINER", etc.) referenced by the trainerClass byte in each
 * Trainer struct. Vanilla FRLG has 107 classes; Emerald has 58; RSE-derived
 * hacks vary.
 *
 * Unlike species-names / ability-names / move-names which have universal
 * canonical name PAIRS (BULBASAUR+IVYSAUR / STENCH+DRIZZLE / POUND+KARATE
 * CHOP), trainer-class names DIVERGE substantially between FRLG and RSE
 * - there is no single pair guaranteed at fixed indices across all
 * Gen-3 carts. This scanner uses STRUCTURAL-only signature detection:
 * find a run of slots where each slot contains valid Gen-3 ALL-CAPS
 * charset bytes + a 0xFF terminator that lands inside the slot itself.
 * Anchor confirmation (10 consecutive valid slots) filters stray
 * valid-looking text runs elsewhere in the ROM.
 *
 * ## The stride is part of the answer
 *
 * A slot size is not universal: vanilla FRLG/Emerald use 13 bytes (12
 * chars + 0xFF), and hacks that rewrote the table without the spare
 * byte use 12 (name + 0xFF packed into the same 12 bytes). The scanner
 * therefore resolves the stride and REPORTS it
 * (`TrainerClassNamesTable = { offset, slotBytes }`) instead of
 * returning a bare offset. That matters: an offset without its stride
 * is not usable - decoding a 12-byte table at a 13-byte stride returns
 * merged neighbours, and writing to it corrupts the adjacent class.
 * `readTrainerClassNamesAt` takes the stride as an optional fourth
 * argument defaulting to the canonical 13, so existing 13-byte callers
 * are unchanged.
 *
 * A layout the module cannot represent safely is refused rather than
 * accepted and decoded wrong: every counted slot must terminate inside
 * its own slot BYTE RANGE. Consecutive names packed with no 0xFF at all
 * are rejected, because at any stride they read as one long run.
 *
 * Per PD 5: structural - works on any Gen-3 cart, at the stride the cart
 * actually uses.
 *
 * Mirrors ability-names (iter 71) slot layout but uses
 * structural-anchor instead of signature-pair detection.
 */

import { STRING_TERMINATOR, decodeString } from '../text/codec.js';

/**
 * Size of one trainer-class-name slot in bytes, per pret/pokefirered
 * `TRAINER_CLASS_NAME_LENGTH = 13` (12 chars + terminator). This is the
 * canonical Gen-3 stride and the default for every stride-less caller. */
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
 * Slot sizes a real Gen-3 gTrainerClassNames table is known to use.
 * Vanilla FRLG/Emerald and every hack checked so far use 13 (12 chars +
 * 0xFF); 12 shows up in tables rewritten to pack the name and its
 * terminator into the same 12 bytes. Ordered by convention, so a tie in
 * run length resolves to the canonical layout.
 */
export const TRAINER_CLASS_NAME_SLOT_CANDIDATES: ReadonlyArray<number> = Object.freeze([
  TRAINER_CLASS_NAME_SLOT_BYTES,
  12,
]);

/**
 * A located gTrainerClassNames table. `slotBytes` is the stride the
 * table was validated at and MUST be used to walk it - see the module
 * header.
 */
export interface TrainerClassNamesTable {
  readonly offset: number;
  readonly slotBytes: number;
}

/**
 * Read `count` trainer-class name slots starting at `offset`.
 *
 * `slotBytes` defaults to the canonical 13-byte stride, so existing
 * callers are unaffected. Callers holding a `TrainerClassNamesTable`
 * must pass its `slotBytes`, otherwise a non-canonical table is walked
 * at the wrong stride.
 *
 * A slot only counts as read when its full byte range lies inside the
 * ROM AND ends in 0xFF, so a truncated or stride-misaligned tail is
 * never reported as a name.
 */
export function readTrainerClassNamesAt(
  romBytes: Uint8Array,
  offset: number,
  count: number,
  slotBytes: number = TRAINER_CLASS_NAME_SLOT_BYTES,
): string[] {
  const cappedCount = Math.min(count, TRAINER_CLASS_NAMES_READ_CAP);
  const names: string[] = [];
  for (let i = 0; i < cappedCount; i++) {
    const slotStart = offset + i * slotBytes;
    if (slotStart + slotBytes > romBytes.length) break;
    if (!probeSlotTerminator(romBytes, slotStart, slotBytes)) break;
    names.push(decodeString(romBytes, slotStart, slotBytes));
  }
  return names;
}

/**
 * Does a 0xFF terminator actually land inside this slot's byte range?
 *
 * This asks the raw bytes, never the decoded text. The decoder renders
 * Gen-3 control codes as multi-character placeholders (`\p`, `{CC}`, the
 * 0xFE newline), so a slot's decoded length is not its byte consumption:
 * decoded length can be less than, equal to, or greater than the bytes
 * consumed. `decoded.length < slotBytes` used to be the test, and it
 * both admitted 12-byte slots read at 13 (the 13th byte is ASCII 'A')
 * and rejected legitimate 13-byte slots whose control codes inflate the
 * decoded string.
 */
function probeSlotTerminator(romBytes: Uint8Array, slotOffset: number, slotBytes: number): boolean {
  for (let i = 0; i < slotBytes; i++) {
    if (romBytes[slotOffset + i] === STRING_TERMINATOR) return true;
  }
  return false;
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

/**
 * Validate that a single slot decodes as a trainer-class-shaped name
 * with its 0xFF terminator inside the slot's own byte range.
 *
 * The terminator requirement is load-bearing, not cosmetic: a slot with
 * no terminator is a misaligned read of some other structure. Without
 * it, a run of 12-byte names packed back-to-back reads as a flawless run
 * of 13-byte slots (each read ends one byte into the next entry, still
 * inside the A-Z range), and the scan anchors on a table that does not
 * exist.
 */
function isValidTrainerClassSlot(
  romBytes: Uint8Array,
  slotOffset: number,
  slotBytes: number = TRAINER_CLASS_NAME_SLOT_BYTES,
): boolean {
  if (slotOffset < 0 || slotOffset + slotBytes > romBytes.byteLength) return false;
  if (!probeSlotTerminator(romBytes, slotOffset, slotBytes)) return false;
  return isShapedClassSlot(decodeString(romBytes, slotOffset, slotBytes));
}

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
 * `TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION` consecutive valid slots at
 * a known stride, then walks forward at that same stride counting the
 * full run length.
 *
 * Returns `{ offset, slotBytes }` for the longest run of ≥
 * `TRAINER_CLASS_NAMES_MIN_VALID_SLOTS` slots, or null if none is found.
 * The stride is part of the result - pass it to
 * `readTrainerClassNamesAt`.
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
 * Ties in run length resolve to candidate order (13 first), so a genuine
 * 13-byte table always wins over the 12-byte reading of itself.
 *
 * PD 5: structural - works on any Gen-3 cart.
 */
export function findTrainerClassNamesTable(romBytes: Uint8Array): TrainerClassNamesTable | null {
  const maxSlotBytes = Math.max(...TRAINER_CLASS_NAME_SLOT_CANDIDATES);
  if (
    romBytes.byteLength <
    CARTRIDGE_HEADER_END +
      TRAINER_CLASS_NAMES_MIN_VALID_SLOTS * maxSlotBytes
  ) {
    return null;
  }
  const limit = romBytes.byteLength - maxSlotBytes;
  let best: { offset: number; slotBytes: number; count: number } | null = null;

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

      // Longer run wins; on a tie keep the earlier offset, and between
      // candidates at the same offset the earlier (13-byte) one wins.
      if (
        count >= TRAINER_CLASS_NAMES_MIN_VALID_SLOTS &&
        (best === null ||
          count > best.count ||
          (count === best.count && p < best.offset))
      ) {
        best = { offset: p, slotBytes, count };
      }
    }
  }

  return best === null ? null : { offset: best.offset, slotBytes: best.slotBytes };
}
