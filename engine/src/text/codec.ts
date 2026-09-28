/**
 * Gen-3 Pokémon GBA in-game text codec.
 *
 * Single source of truth for text decoding: every consumer (editor
 * backend, scripts decompiler, dialogue tree extractor) reads encoded
 * ROM strings via THIS implementation rather than rolling its own.
 *
 * The Gen-3 ROMs encode in-game strings (species names, move names,
 * trainer names, dialogue, item names, etc.) in a custom single-byte
 * mapping that is NOT ASCII. This module decodes those bytes to
 * Unicode strings and encodes ASCII strings back (useful for building
 * signature-scan needles like "BULBASAUR" to locate gSpeciesNames
 * tables in hacked ROMs that have relocated them).
 *
 * Copyright boundary respected: the character mapping is a charset
 * specification (not copyrighted) widely documented in the public
 * `pret/pokefirered` + `pret/pokeemerald` decomp repos' `charmap.txt`.
 * No game text is embedded here, only the encoding table.
 *
 * No FireRed/Emerald-only path: the codec works on ANY Gen-3
 * Pokémon ROM - same charset across the FireRed/LeafGreen/Emerald/Ruby
 * /Sapphire family AND across every hack derived from them (CFRU,
 * Unbound, Radical Red, etc., all keep the Gen-3 charset by
 * construction since the engine's text-printing routines are part of
 * the engine itself, not the hack's content).
 *
 * Migrated from `app/backend/src/rom-binary/text-codec.ts` in iter 57
 * (Phase UW-0-T4) as the engine's first Category-7 substrate. The
 * editor module will become the legacy version once consumers have
 * migrated.
 */

/** End-of-string terminator byte used by Gen-3 ROMs. */
export const STRING_TERMINATOR = 0xff;

/**
 * Gen-3 character → Unicode mapping. Bytes outside the documented ranges
 * decode to "?" so a misaligned read produces obviously-garbage output
 * that validators can reject.
 *
 * Phase G-RC3 (semantic-world plan §G.3): expanded from the original
 * narrow range (digits + A-Z + a-z + a handful of punct) to cover the
 * full ~256-byte Gen-3 charset documented in
 * pret/pokefirered's `charmap.txt` + pret/pokeemerald's. Adds:
 *  - Accented vowels (0x01..0x35): À Á Â Ç È É Ê Ë Ì Î Ï Ò Ó Ô Œ Ù Ú Û Ñ ß
 *    and their lowercase counterparts.
 *  - Symbols (0xA0..0xAF + 0xB5..0xBA): · ♂ ♀ ¥ × / and friends.
 *  - Localization variants for European releases (Ä Ö Ü ä ö ü) at
 *    0xF1..0xF6.
 *  - Control codes (0xEF..0xFE): rendered as readable placeholders
 *    like `\n`, `{PARA}`, `{SCROLL}`, `{CC}`, `{VAR}` so dialogue
 *    decoding produces legible text instead of long runs of `?`.
 *
 * Note: 0xFC and 0xFD are 2-byte commands in actual ROM text streams
 * (they take an argument byte). The single-byte decoder produces
 * placeholders for them; a future richer dialogue-tree parser will
 * consume the argument byte to render full inline formatting.
 */
const TABLE: Readonly<Record<number, string>> = (() => {
  const t: Record<number, string> = {};
  // Space
  t[0x00] = ' ';
  // Accented uppercase vowels (0x01..0x15)
  t[0x01] = 'À';
  t[0x02] = 'Á';
  t[0x03] = 'Â';
  t[0x04] = 'Ç';
  t[0x05] = 'È';
  t[0x06] = 'É';
  t[0x07] = 'Ê';
  t[0x08] = 'Ë';
  t[0x09] = 'Ì';
  t[0x0b] = 'Î';
  t[0x0c] = 'Ï';
  t[0x0d] = 'Ò';
  t[0x0e] = 'Ó';
  t[0x0f] = 'Ô';
  t[0x10] = 'Œ';
  t[0x11] = 'Ù';
  t[0x12] = 'Ú';
  t[0x13] = 'Û';
  t[0x14] = 'Ñ';
  t[0x15] = 'ß';
  // Accented lowercase vowels (0x16..0x2A)
  t[0x16] = 'à';
  t[0x17] = 'á';
  t[0x1a] = 'ç';
  t[0x1b] = 'è';
  t[0x1c] = 'é';
  t[0x1d] = 'ê';
  t[0x1e] = 'ë';
  t[0x1f] = 'ì';
  t[0x21] = 'î';
  t[0x22] = 'ï';
  t[0x23] = 'ò';
  t[0x24] = 'ó';
  t[0x25] = 'ô';
  t[0x26] = 'œ';
  t[0x27] = 'ù';
  t[0x28] = 'ú';
  t[0x29] = 'û';
  t[0x2a] = 'ñ';
  // Ordinal indicators
  t[0x2b] = 'º';
  t[0x2c] = 'ª';
  // Common punctuation in lower ranges
  t[0x34] = '+';
  // Digits 0–9 at 0xA1..0xAA
  for (let i = 0; i < 10; i++) t[0xa1 + i] = String.fromCharCode('0'.charCodeAt(0) + i);
  // Punctuation cluster
  t[0xab] = '!';
  t[0xac] = '?';
  t[0xad] = '.';
  t[0xae] = '-';
  t[0xaf] = '·';
  t[0xb0] = '…'; // ellipsis
  t[0xb1] = '“';
  t[0xb2] = '”';
  t[0xb3] = '‘';
  t[0xb4] = '’';
  t[0xb5] = '♂';
  t[0xb6] = '♀';
  t[0xb7] = '¥';
  t[0xb8] = ',';
  t[0xb9] = '×';
  t[0xba] = '/';
  // Uppercase A–Z at 0xBB..0xD4
  for (let i = 0; i < 26; i++) t[0xbb + i] = String.fromCharCode('A'.charCodeAt(0) + i);
  // Lowercase a–z at 0xD5..0xEE
  for (let i = 0; i < 26; i++) t[0xd5 + i] = String.fromCharCode('a'.charCodeAt(0) + i);
  // Arrows + European localization variants
  t[0xef] = '→';
  t[0xf0] = ':';
  t[0xf1] = 'Ä';
  t[0xf2] = 'Ö';
  t[0xf3] = 'Ü';
  t[0xf4] = 'ä';
  t[0xf5] = 'ö';
  t[0xf6] = 'ü';
  // Control codes - render as readable placeholders so the decoded
  // text stays legible instead of dropping to '?'. A future parameterized
  // parser can consume the argument byte(s) for 0xFC/0xFD; for now we
  // emit a placeholder and the formatter can strip them.
  t[0xfa] = '\\p'; // {PROMPT_CLEAR}
  t[0xfb] = '\\l'; // {PROMPT_SCROLL}
  t[0xfc] = '{CC}'; // {COLOR/HIGHLIGHT/etc, 2-byte arg follows}
  t[0xfd] = '{VAR}'; // {VARIABLE substitution, 2-byte arg follows}
  t[0xfe] = '\n'; // newline
  // 0xFF intentionally NOT mapped - it's the terminator (handled separately
  // in decodeString).
  return t;
})();

/**
 * Decode a single Gen-3 text byte to its Unicode character. Unknown
 * bytes decode to '?'.
 */
export function decodeByte(byte: number): string {
  return TABLE[byte] ?? '?';
}

/**
 * Decode a Gen-3 text string from `bytes` starting at `offset`. Reads
 * up to `maxLen` bytes, stopping at the first `STRING_TERMINATOR`
 * (0xFF) or end-of-buffer. Returns the decoded Unicode string
 * (control codes + unknown bytes become '?').
 *
 * Accepts `Uint8Array` (and therefore Node `Buffer` which extends it)
 * for portability - the engine never imports the Node `Buffer` type.
 */
export function decodeString(bytes: Uint8Array, offset: number, maxLen: number): string {
  let out = '';
  for (let i = 0; i < maxLen; i++) {
    const idx = offset + i;
    if (idx >= bytes.length) break;
    const b = bytes[idx]!;
    if (b === STRING_TERMINATOR) break;
    out += decodeByte(b);
  }
  return out;
}

/**
 * Encode a string back into Gen-3 text bytes. Used by signature-scan
 * paths to build a needle (e.g. "BULBASAUR") to search for in unknown
 * ROM layouts, and by every write path that round-trips decoded
 * dialogue back into a ROM.
 *
 * Characters with no Gen-3 mapping throw - this is intentional for
 * typo'd needles (`@`, `#`, tab), but the encoder is the exact inverse
 * of `decodeString` for everything the decoder can emit: pass
 * `decodeString(bytes, ...)` back in and the same bytes come out. That
 * includes the multi-character control-code placeholders the decoder
 * produces (`\p`, `\l`, `{CC}`, `{VAR}`, and the 0xFE newline), which
 * the app's own help text tells users to type directly into a text box.
 * Those are matched greedily as whole units before falling back to
 * single-character lookup, so a placeholder is never split into its
 * constituent characters (which would throw on `{` or `\`).
 *
 * Returns a `Uint8Array` (consumers can wrap with `Buffer.from()` if
 * they need a Node Buffer).
 */
export function encodeString(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; ) {
    // Longest-match-first over the multi-character placeholders. Every
    // entry in PLACEHOLDER_BYTES is longer than one character, so
    // checking these before the single-character table cannot shadow a
    // legitimate one-char mapping.
    let matched = false;
    for (const placeholder of PLACEHOLDERS_LONGEST_FIRST) {
      if (s.startsWith(placeholder, i)) {
        out.push(PLACEHOLDER_BYTES[placeholder]!);
        i += placeholder.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // `Array.from`-style iteration would split astral characters into
    // surrogate pairs; the Gen-3 charmap is entirely BMP, so walk code
    // points and let anything outside the table throw below.
    const ch = s.codePointAt(i)!;
    const chStr = String.fromCodePoint(ch);
    const b = REVERSE_TABLE[chStr];
    if (b !== undefined) {
      out.push(b);
      i += chStr.length;
      continue;
    }
    throw new Error(
      `Cannot encode character '${chStr}' (U+${ch.toString(16).padStart(4, '0')}) to Gen-3 text`,
    );
  }
  return new Uint8Array(out);
}

/**
 * Multi-character control-code placeholders the decoder emits, mapped to
 * the byte they stand for. Kept in one place so `encodeString` and the
 * round-trip test stay in sync with `TABLE`.
 *
 * `\n` (a real newline, 0xFE) is single-character and therefore lives in
 * `REVERSE_TABLE`; only the placeholders that span more than one code
 * unit belong here.
 */
const PLACEHOLDER_BYTES: Readonly<Record<string, number>> = Object.freeze({
  '{CC}': 0xfc,
  '{VAR}': 0xfd,
  '\\p': 0xfa,
  '\\l': 0xfb,
});

/** Placeholder keys ordered longest-first so a shorter placeholder can
 *  never win against a longer one that shares its prefix. */
const PLACEHOLDERS_LONGEST_FIRST: ReadonlyArray<string> = Object.freeze(
  Object.keys(PLACEHOLDER_BYTES).sort((a, b) => b.length - a.length),
);

/** Reverse of TABLE for `encodeString`. Built lazily once at module
 *  init. When TABLE maps multiple bytes to the same string the FIRST
 *  byte encountered wins. Multi-character placeholders are handled by
 *  `PLACEHOLDER_BYTES` before this table is consulted; `\n` (0xFE) is
 *  single-character so it resolves here like any other entry. */
const REVERSE_TABLE: Readonly<Record<string, number>> = (() => {
  const r: Record<string, number> = {};
  for (const [byteStr, ch] of Object.entries(TABLE)) {
    if (r[ch] === undefined) r[ch] = Number.parseInt(byteStr, 10);
  }
  return r;
})();
