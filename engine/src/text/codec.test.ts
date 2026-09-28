import { describe, expect, it } from 'vitest';
import { STRING_TERMINATOR, decodeByte, decodeString, encodeString } from './codec.js';

describe('Gen-3 text codec - decodeByte', () => {
  it('decodes uppercase A-Z at 0xBB..0xD4', () => {
    expect(decodeByte(0xbb)).toBe('A');
    expect(decodeByte(0xbc)).toBe('B');
    expect(decodeByte(0xd4)).toBe('Z');
  });

  it('decodes lowercase a-z at 0xD5..0xEE', () => {
    expect(decodeByte(0xd5)).toBe('a');
    expect(decodeByte(0xee)).toBe('z');
  });

  it('decodes digits 0-9 at 0xA1..0xAA', () => {
    expect(decodeByte(0xa1)).toBe('0');
    expect(decodeByte(0xaa)).toBe('9');
  });

  it('decodes space (0x00) and common punctuation', () => {
    expect(decodeByte(0x00)).toBe(' ');
    expect(decodeByte(0xab)).toBe('!');
    expect(decodeByte(0xac)).toBe('?');
    expect(decodeByte(0xad)).toBe('.');
    expect(decodeByte(0xae)).toBe('-');
  });

  it('decodes male/female symbols', () => {
    expect(decodeByte(0xb5)).toBe('♂');
    expect(decodeByte(0xb6)).toBe('♀');
  });

  it('decodes accented letters expanded in G.3', () => {
    expect(decodeByte(0x01)).toBe('À');
    expect(decodeByte(0x1c)).toBe('é');
    expect(decodeByte(0x14)).toBe('Ñ');
    expect(decodeByte(0xf1)).toBe('Ä');
    expect(decodeByte(0xf6)).toBe('ü');
  });

  it('decodes control codes as readable placeholders', () => {
    expect(decodeByte(0xfe)).toBe('\n');
    expect(decodeByte(0xfa)).toBe('\\p');
    expect(decodeByte(0xfb)).toBe('\\l');
    expect(decodeByte(0xfc)).toBe('{CC}');
    expect(decodeByte(0xfd)).toBe('{VAR}');
  });

  it('decodes still-undocumented bytes as "?"', () => {
    // 0x7F is in a sparse zone outside the documented mappings.
    expect(decodeByte(0x7f)).toBe('?');
    // 0x36..0x9F is the "in-game graphics" zone (sprite tiles, PK/MN
    // ligatures, etc.) - most bytes here aren't documented one-to-one.
    expect(decodeByte(0x80)).toBe('?');
  });
});

describe('Gen-3 text codec - decodeString', () => {
  it('stops at the 0xFF terminator', () => {
    // "BULB" then terminator + garbage
    const buf = new Uint8Array([0xbc, 0xcf, 0xc6, 0xbc, 0xff, 0x99, 0x88]);
    expect(decodeString(buf, 0, 16)).toBe('BULB');
  });

  it('reads up to maxLen if no terminator', () => {
    const buf = new Uint8Array([0xbc, 0xcf, 0xc6, 0xbc, 0xbb, 0xcd]);
    expect(decodeString(buf, 0, 4)).toBe('BULB');
  });

  it('reads from a non-zero offset', () => {
    const buf = new Uint8Array([0xff, 0xff, 0xbc, 0xcf, 0xc6, 0xbc, 0xff]);
    expect(decodeString(buf, 2, 11)).toBe('BULB');
  });

  it('returns empty string when offset is past buffer end', () => {
    const buf = new Uint8Array([0xbc, 0xcf]);
    expect(decodeString(buf, 10, 5)).toBe('');
  });

  it('accepts Node Buffer (subclass of Uint8Array)', () => {
    // This sanity-checks the engine API works for Node Buffer consumers too.
    const buf = Buffer.from([0xbc, 0xcf, 0xc6, 0xbc, 0xff]);
    expect(decodeString(buf, 0, 16)).toBe('BULB');
  });
});

describe('Gen-3 text codec - encodeString', () => {
  it('round-trips through decodeString for ASCII names', () => {
    const enc = encodeString('BULBASAUR');
    const decoded = decodeString(enc, 0, 11);
    expect(decoded).toBe('BULBASAUR');
    expect(enc.length).toBe(9);
    expect(enc[0]).toBe(0xbc); // B
    expect(enc[1]).toBe(0xcf); // U
  });

  it('handles digits + spaces', () => {
    const enc = encodeString('AB 12');
    const dec = decodeString(enc, 0, 10);
    expect(dec).toBe('AB 12');
  });

  it('handles lowercase letters', () => {
    const enc = encodeString('abc');
    const dec = decodeString(enc, 0, 10);
    expect(dec).toBe('abc');
    expect(enc[0]).toBe(0xd5); // a
  });

  it('throws on a character with no mapping', () => {
    // Phase I.3 - encoder now round-trips through the full TABLE so
    // it accepts everything decodeString produces (accented vowels,
    // common punctuation, etc.). Only characters that have no entry
    // in the Gen-3 charmap (e.g. @, #, ASCII tab) still throw.
    expect(() => encodeString('@')).toThrow(/Cannot encode/);
    expect(() => encodeString('#')).toThrow(/Cannot encode/);
    expect(() => encodeString('\t')).toThrow(/Cannot encode/);
  });

  it('round-trips dialogue text containing accented vowels + punctuation', () => {
    const original = 'POKéMON!?,.';
    const enc = encodeString(original);
    const dec = decodeString(enc, 0, 32);
    expect(dec).toBe(original);
  });

  it('encodes the multi-character control-code placeholders the decoder emits', () => {
    // The app's own help text tells users to type \p / \l / {CC} / {VAR}
    // straight into a dialogue box, so the encoder has to accept exactly
    // what the decoder produces. Before this, `{` and `\` had no mapping
    // and every write of a string carrying a control code threw.
    expect(Array.from(encodeString('\\p'))).toEqual([0xfa]);
    expect(Array.from(encodeString('\\l'))).toEqual([0xfb]);
    expect(Array.from(encodeString('{CC}'))).toEqual([0xfc]);
    expect(Array.from(encodeString('{VAR}'))).toEqual([0xfd]);
  });

  it('encodes a realistic dialogue line mixing text, newline and control codes', () => {
    const line = 'Hello!\nWelcome to the {VAR} region.\\pEnjoy!';
    const enc = encodeString(line);
    expect(enc[0]).toBe(0xc2); // H (0xbb + 7)
    expect(enc[6]).toBe(0xfe); // newline
    // The \p sits in the middle, right before "Enjoy!" - find it and check
    // that exactly one byte stands in for the two-glyph placeholder.
    const markerIdx = Array.from(enc).indexOf(0xfa);
    expect(markerIdx).toBeGreaterThan(0);
    expect(decodeString(enc, markerIdx + 1, 6)).toBe('Enjoy!');
    expect(decodeString(enc, 0, enc.length)).toBe(line);
  });

  it('is the exact inverse of decodeString for every byte the decoder can emit', () => {
    // The strongest statement of the contract: for every byte that has a
    // real mapping, encodeString(decodeByte(b)) must give back b. Bytes
    // outside the charmap decode to the shared placeholder '?' and are
    // lossy by design, so they are checked separately.
    const roundTrippable: string[] = [];
    for (let b = 0x00; b < 0xff; b++) {
      const ch = decodeByte(b);
      if (ch === '?') continue;
      expect(Array.from(encodeString(ch))).toEqual([b]);
      roundTrippable.push(ch);
    }
    // And the whole alphabet concatenated still round-trips byte-for-byte,
    // which catches any greedy-placeholder mis-splitting across a boundary.
    const encodedWhole = Array.from(encodeString(roundTrippable.join('')));
    expect(encodedWhole.length).toBe(roundTrippable.length);
    expect(decodeString(new Uint8Array(encodedWhole), 0, encodedWhole.length)).toBe(
      roundTrippable.join(''),
    );
  });

  it('collapses every unmapped byte to the same lossy ? placeholder', () => {
    // The inverse contract has a stated limit, so pin it. TABLE is
    // many-to-one: several bytes with no mapping all decode to '?', and
    // '?' is also a real character (0xAC). Encoding a decoded '?'
    // therefore always produces 0xAC and can never recover the original
    // byte - a write path must not assume byte-exact round-tripping for
    // a slot that contains '?'.
    const unmapped: number[] = [];
    for (let b = 0x00; b < 0xff; b++) {
      if (decodeByte(b) === '?') unmapped.push(b);
    }
    // Sanity: the lossy set is non-empty, and it CONTAINS 0xac - the
    // real question mark - because it decodes to the same '?' glyph as
    // every unmapped byte. That is precisely the ambiguity: a decoded
    // '?' may be the character or an unmapped byte, and nothing in the
    // string says which.
    expect(unmapped.length).toBeGreaterThan(50);
    expect(unmapped).toContain(0xac);
    // Every unmapped byte collapses to the same string...
    for (const b of unmapped) {
      expect(decodeByte(b)).toBe('?');
    }
    // ...and re-encoding gives 0xAC for all of them, never the original.
    expect(Array.from(encodeString('?'))).toEqual([0xac]);
    for (const b of unmapped) {
      expect(Array.from(encodeString(decodeByte(b)))).toEqual([0xac]);
    }
    // 0xac round-trips only because it IS the byte the encoder picks.
    expect(Array.from(encodeString(decodeByte(0xac)))).toEqual([0xac]);
  });
});

describe('Gen-3 text codec - STRING_TERMINATOR constant', () => {
  it('exports the canonical 0xFF terminator', () => {
    expect(STRING_TERMINATOR).toBe(0xff);
  });
});
