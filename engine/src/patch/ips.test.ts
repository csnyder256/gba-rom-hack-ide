import { describe, expect, it } from 'vitest';
import {
  IPS_FOOTER,
  IPS_HEADER,
  IPS_MAX_OFFSET,
  IPS_RESERVED_EOF_OFFSET,
  IpsFormatError,
  applyIps,
  decodeIps,
  encodeIps,
} from './ips.js';

describe('encodeIps', () => {
  it('emits header + footer for an empty record list', () => {
    const bytes = encodeIps([]);
    expect(bytes.length).toBe(IPS_HEADER.length + IPS_FOOTER.length);
    expect(bytes.slice(0, 5)).toEqual(IPS_HEADER);
    expect(bytes.slice(5)).toEqual(IPS_FOOTER);
  });

  it('emits a single literal record', () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const bytes = encodeIps([{ kind: 'literal', offset: 0x100, data }]);
    // 5 (header) + 3 (offset) + 2 (length) + 4 (data) + 3 (footer)
    expect(bytes.length).toBe(17);
    expect(bytes[5]).toBe(0x00); // offset hi
    expect(bytes[6]).toBe(0x01);
    expect(bytes[7]).toBe(0x00);
    expect(bytes[8]).toBe(0x00); // length hi
    expect(bytes[9]).toBe(0x04); // length lo
    expect(bytes.slice(10, 14)).toEqual(data);
  });

  it('emits a single RLE record', () => {
    const bytes = encodeIps([
      { kind: 'rle', offset: 0x200, rleLength: 16, byte: 0xab },
    ]);
    // 5 (header) + 3 (offset) + 2 (length=0) + 2 (rleLen) + 1 (byte) + 3 (footer)
    expect(bytes.length).toBe(16);
    expect(bytes[5]).toBe(0x00); // offset hi
    expect(bytes[6]).toBe(0x02);
    expect(bytes[7]).toBe(0x00);
    expect(bytes[8]).toBe(0x00); // length=0 marker
    expect(bytes[9]).toBe(0x00);
    expect(bytes[10]).toBe(0x00); // rleLen hi
    expect(bytes[11]).toBe(0x10); // rleLen lo (16)
    expect(bytes[12]).toBe(0xab);
  });

  it('throws on offset exceeding IPS max', () => {
    expect(() =>
      encodeIps([
        { kind: 'literal', offset: IPS_MAX_OFFSET + 1, data: new Uint8Array([0]) },
      ]),
    ).toThrow(IpsFormatError);
  });

  it('throws on reserved EOF offset', () => {
    expect(() =>
      encodeIps([
        { kind: 'literal', offset: IPS_RESERVED_EOF_OFFSET, data: new Uint8Array([0]) },
      ]),
    ).toThrow(IpsFormatError);
  });

  it('throws on zero-length literal record', () => {
    expect(() =>
      encodeIps([{ kind: 'literal', offset: 0x100, data: new Uint8Array(0) }]),
    ).toThrow(IpsFormatError);
  });
});

describe('decodeIps', () => {
  it('decodes empty patch (header + footer only)', () => {
    const bytes = encodeIps([]);
    const records = decodeIps(bytes);
    expect(records.length).toBe(0);
  });

  it('roundtrips a literal record', () => {
    const data = new Uint8Array([0x11, 0x22, 0x33]);
    const records = [{ kind: 'literal' as const, offset: 0x500, data }];
    const decoded = decodeIps(encodeIps(records));
    expect(decoded.length).toBe(1);
    expect(decoded[0]?.kind).toBe('literal');
    if (decoded[0]?.kind === 'literal') {
      expect(decoded[0].offset).toBe(0x500);
      expect(decoded[0].data).toEqual(data);
    }
  });

  it('roundtrips an RLE record', () => {
    const records = [
      { kind: 'rle' as const, offset: 0xa00, rleLength: 100, byte: 0xcd },
    ];
    const decoded = decodeIps(encodeIps(records));
    expect(decoded.length).toBe(1);
    expect(decoded[0]?.kind).toBe('rle');
    if (decoded[0]?.kind === 'rle') {
      expect(decoded[0].offset).toBe(0xa00);
      expect(decoded[0].rleLength).toBe(100);
      expect(decoded[0].byte).toBe(0xcd);
    }
  });

  it('roundtrips mixed records in order', () => {
    const records = [
      { kind: 'literal' as const, offset: 0x100, data: new Uint8Array([1, 2]) },
      { kind: 'rle' as const, offset: 0x200, rleLength: 50, byte: 0xff },
      { kind: 'literal' as const, offset: 0x300, data: new Uint8Array([3, 4, 5]) },
    ];
    const decoded = decodeIps(encodeIps(records));
    expect(decoded.length).toBe(3);
    expect(decoded[0]?.offset).toBe(0x100);
    expect(decoded[1]?.offset).toBe(0x200);
    expect(decoded[2]?.offset).toBe(0x300);
  });

  it('throws on missing header', () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x45, 0x4f, 0x46]);
    expect(() => decodeIps(bad)).toThrow(IpsFormatError);
  });

  it('throws on truncated record', () => {
    const bad = new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0x00, 0x01]);
    expect(() => decodeIps(bad)).toThrow(IpsFormatError);
  });

  it('throws on missing EOF footer', () => {
    // header + a 1-byte literal record that doesn't terminate with EOF
    const bad = new Uint8Array([
      0x50, 0x41, 0x54, 0x43, 0x48, // PATCH
      0x00, 0x01, 0x00, // offset 0x000100
      0x00, 0x01, // length=1
      0xde, // data
      // no EOF - buffer ends here
    ]);
    expect(() => decodeIps(bad)).toThrow(IpsFormatError);
  });
});

describe('applyIps', () => {
  it('applies a literal record (overwrites bytes at offset)', () => {
    const base = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const records = [
      { kind: 'literal' as const, offset: 2, data: new Uint8Array([0xaa, 0xbb]) },
    ];
    const out = applyIps(base, records);
    expect(out).toEqual(new Uint8Array([0x00, 0x00, 0xaa, 0xbb, 0x00, 0x00, 0x00, 0x00]));
    expect(base[2]).toBe(0); // non-destructive: original untouched
  });

  it('applies an RLE record (fills span with the byte)', () => {
    const base = new Uint8Array(10);
    const records = [
      { kind: 'rle' as const, offset: 3, rleLength: 4, byte: 0x42 },
    ];
    const out = applyIps(base, records);
    expect(out.slice(3, 7)).toEqual(new Uint8Array([0x42, 0x42, 0x42, 0x42]));
  });

  it('grows output when record extends past base.length', () => {
    const base = new Uint8Array(4);
    const records = [
      { kind: 'literal' as const, offset: 6, data: new Uint8Array([0x11, 0x22]) },
    ];
    const out = applyIps(base, records);
    expect(out.length).toBe(8);
    expect(out[6]).toBe(0x11);
    expect(out[7]).toBe(0x22);
  });

  it('full encode→decode→apply roundtrip', () => {
    const base = new Uint8Array(32).fill(0xcc);
    const records = [
      { kind: 'literal' as const, offset: 0, data: new Uint8Array([0x00, 0x01, 0x02]) },
      { kind: 'rle' as const, offset: 16, rleLength: 8, byte: 0xff },
    ];
    const ips = encodeIps(records);
    const decoded = decodeIps(ips);
    const out = applyIps(base, decoded);
    expect(out[0]).toBe(0x00);
    expect(out[1]).toBe(0x01);
    expect(out[2]).toBe(0x02);
    expect(out[16]).toBe(0xff);
    expect(out[23]).toBe(0xff);
    expect(out[24]).toBe(0xcc); // untouched
  });
});

describe('encodeIps - record ends past the addressable ceiling', () => {
  it('rejects a literal record whose payload runs past IPS_MAX_OFFSET', () => {
    // Offset is legal (below the ceiling) but the record's bytes are not:
    // 0xFFFFFD..0x1000000 are past the last byte IPS can name.
    expect(() =>
      encodeIps([
        {
          kind: 'literal',
          offset: IPS_MAX_OFFSET - 1,
          data: new Uint8Array([1, 2, 3, 4]),
        },
      ]),
    ).toThrow(IpsFormatError);
  });

  it('rejects an RLE record whose expansion runs past IPS_MAX_OFFSET', () => {
    expect(() =>
      encodeIps([
        { kind: 'rle', offset: IPS_MAX_OFFSET - 1, rleLength: 16, byte: 0xaa },
      ]),
    ).toThrow(/past the last addressable IPS byte/);
  });

  it('accepts a record that ends exactly on the last addressable byte', () => {
    const bytes = encodeIps([
      { kind: 'literal', offset: IPS_MAX_OFFSET - 1, data: new Uint8Array([1, 2]) },
    ]);
    const decoded = decodeIps(bytes);
    expect(decoded.length).toBe(1);
    expect(decoded[0]?.offset).toBe(IPS_MAX_OFFSET - 1);
  });
});
