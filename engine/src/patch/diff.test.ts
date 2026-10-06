import { describe, expect, it } from 'vitest';
import { IPS_MAX_OFFSET, IpsFormatError, applyIps, encodeIps, decodeIps } from './ips.js';
import { produceIpsRecords, produceIpsRecordsWithReport } from './diff.js';

describe('produceIpsRecords - happy paths', () => {
  it('emits empty record list when original === modified', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    const records = produceIpsRecords(buf, buf);
    expect(records.length).toBe(0);
  });

  it('emits a single literal record for a short differing run', () => {
    const original = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const modified = new Uint8Array([0, 0, 0xaa, 0xbb, 0xcc, 0, 0, 0]);
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
    if (records[0]?.kind === 'literal') {
      expect(records[0].offset).toBe(2);
      expect(records[0].data).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    }
  });

  it('emits an RLE record for a long run of the same byte', () => {
    const original = new Uint8Array(32);
    const modified = new Uint8Array(32);
    for (let i = 4; i < 20; i++) modified[i] = 0xff;
    const records = produceIpsRecords(modified, modified); // identity = 0
    expect(records.length).toBe(0);
    const records2 = produceIpsRecords(original, modified);
    expect(records2.length).toBe(1);
    if (records2[0]?.kind === 'rle') {
      expect(records2[0].offset).toBe(4);
      expect(records2[0].rleLength).toBe(16);
      expect(records2[0].byte).toBe(0xff);
    }
  });

  it('emits multiple records for non-adjacent diffs', () => {
    const original = new Uint8Array(100);
    const modified = new Uint8Array(100);
    modified[10] = 0xaa;
    modified[11] = 0xab;
    modified[50] = 0xcc;
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(2);
    expect(records[0]?.offset).toBe(10);
    expect(records[1]?.offset).toBe(50);
  });

  it('full diff → encode → decode → apply roundtrip', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const modified = new Uint8Array(original);
    modified[5] = 0xff;
    modified[6] = 0xfe;
    modified[7] = 0xfd;
    // RLE-worthy: 16 consecutive 0x77 bytes
    for (let i = 100; i < 116; i++) modified[i] = 0x77;
    modified[200] = 0xee;
    const records = produceIpsRecords(original, modified);
    const ips = encodeIps(records);
    const decoded = decodeIps(ips);
    const restored = applyIps(original, decoded);
    expect(restored).toEqual(modified);
  });
});

describe('produceIpsRecords - failure modes', () => {
  it('throws when modified shrinks below original (IPS has no erase record)', () => {
    expect(() =>
      produceIpsRecords(new Uint8Array(10), new Uint8Array(5)),
    ).toThrow(IpsFormatError);
  });
});

describe('produceIpsRecords - growing patches (modified > original)', () => {
  it('treats trailing bytes of modified beyond original as diff records', () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const modified = new Uint8Array([1, 2, 3, 4, 0xaa, 0xbb, 0xcc]);
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
    if (records[0]?.kind === 'literal') {
      expect(records[0].offset).toBe(4);
      expect(records[0].data).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    }
  });

  it('roundtrip - growing patch encode → decode → apply restores modified exactly', () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const modified = new Uint8Array([1, 2, 3, 4, 0xaa, 0xbb, 0xcc, 0xdd]);
    const records = produceIpsRecords(original, modified);
    const encoded = encodeIps(records);
    const decoded = decodeIps(encoded);
    const restored = applyIps(original, decoded);
    expect(Array.from(restored)).toEqual(Array.from(modified));
  });

  it('combines middle-of-buffer diff with trailing growth into 2 records', () => {
    const original = new Uint8Array(16);
    const modified = new Uint8Array(20);
    modified[5] = 0xaa;
    modified[16] = 0xbb;
    modified[17] = 0xcc;
    modified[18] = 0xdd;
    modified[19] = 0xee;
    const records = produceIpsRecords(original, modified);
    // record 1: literal @ offset 5, [0xaa]
    // record 2: literal @ offset 16, [0xbb, 0xcc, 0xdd, 0xee] (the trailing growth)
    expect(records.length).toBe(2);
    expect(records[0]?.offset).toBe(5);
    expect(records[1]?.offset).toBe(16);

    // Roundtrip
    const encoded = encodeIps(records);
    const decoded = decodeIps(encoded);
    const restored = applyIps(original, decoded);
    expect(restored.length).toBe(20);
    expect(Array.from(restored)).toEqual(Array.from(modified));
  });

  it('equal-length still works (regression - no behavior change for equal lengths)', () => {
    const original = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const modified = new Uint8Array([0, 0, 0xaa, 0xbb, 0xcc, 0, 0, 0]);
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
  });
});

describe('produceIpsRecords - RLE threshold', () => {
  it('emits literal for short runs (below threshold)', () => {
    const original = new Uint8Array(16);
    const modified = new Uint8Array(16);
    // 3 bytes of 0xab - below default rleThreshold=8 → emit as literal
    modified[2] = 0xab;
    modified[3] = 0xab;
    modified[4] = 0xab;
    const records = produceIpsRecords(original, modified);
    expect(records.length).toBe(1);
    expect(records[0]?.kind).toBe('literal');
  });

  it('honors custom rleThreshold', () => {
    const original = new Uint8Array(16);
    const modified = new Uint8Array(16);
    // 4 bytes of 0xab - above custom rleThreshold=4 → emit as RLE
    modified[2] = 0xab;
    modified[3] = 0xab;
    modified[4] = 0xab;
    modified[5] = 0xab;
    const records = produceIpsRecords(original, modified, { rleThreshold: 4 });
    expect(records.length).toBe(1);
    expect(records[0]?.kind).toBe('rle');
  });
});

describe('produceIpsRecords - the IPS address ceiling', () => {
  // IPS records carry a 3-byte offset, so the last byte position the
  // format can describe is IPS_MAX_OFFSET (0xFFFFFE) - which means a
  // 16 MiB (0x1000000-byte) ROM has exactly one byte, its last, that no
  // IPS patch can ever reach. A record's offset field names where the
  // record STARTS, so a diff that began a record below the ceiling but
  // let its payload run past it used to hand `applyIps` a byte no
  // patcher could produce or verify.
  const ROM_16MIB = 0x1000000;
  // Addressable byte positions are 0..IPS_MAX_OFFSET, i.e. a buffer of
  // IPS_MAX_OFFSET + 1 bytes is the largest fully representable ROM.
  const LAST_ADDRESSABLE_INDEX = IPS_MAX_OFFSET; // 0xFFFFFE
  const ceilBase = (): { original: Uint8Array; modified: Uint8Array } => {
    const original = new Uint8Array(ROM_16MIB);
    return { original, modified: new Uint8Array(original) };
  };

  it('truncates a literal that would run past the ceiling', () => {
    const { original, modified } = ceilBase();
    // Three changed bytes: 0xFFFFFD + 0xFFFFFE are addressable, 0xFFFFFF
    // is one past the last position IPS can name.
    for (let i = 0; i < 3; i++) modified[LAST_ADDRESSABLE_INDEX - 1 + i] = 0xaa + i;
    const report = produceIpsRecordsWithReport(original, modified);
    expect(report.records.length).toBe(1);
    const rec = report.records[0]!;
    expect(rec.kind).toBe('literal');
    expect(rec.offset).toBe(LAST_ADDRESSABLE_INDEX - 1);
    if (rec.kind === 'literal') {
      expect(rec.data.length).toBe(2);
      expect(rec.offset + rec.data.length).toBe(IPS_MAX_OFFSET + 1);
    }
    expect(report.unrepresentableBytes).toBe(1);
    expect(report.unrepresentableRanges).toEqual([[ROM_16MIB - 1, ROM_16MIB]]);
  });

  it('truncates an RLE run that would run past the ceiling', () => {
    const { original } = ceilBase();
    // 32 identical bytes starting at 0xFFFFF0: 15 land inside the
    // addressable window (>= the RLE break-even of 8, so this must stay
    // an RLE record) and 17 fall off the end. The ROM grows by 16 bytes
    // so the run has a tail to fall off with.
    const runStart = LAST_ADDRESSABLE_INDEX - 14;
    const modified = new Uint8Array(ROM_16MIB + 16);
    modified.set(original);
    for (let i = 0; i < 32; i++) modified[runStart + i] = 0x77;
    const report = produceIpsRecordsWithReport(original, modified);
    expect(report.records.length).toBe(1);
    const rec = report.records[0]!;
    expect(rec.kind).toBe('rle');
    if (rec.kind === 'rle') {
      expect(rec.offset).toBe(runStart);
      expect(rec.rleLength).toBe(15);
      expect(rec.offset + rec.rleLength).toBe(IPS_MAX_OFFSET + 1);
    }
    expect(report.unrepresentableBytes).toBe(17);
    // The emitted records must survive the encoder, which now also
    // refuses to write past the ceiling.
    expect(() => encodeIps(report.records)).not.toThrow();
  });

  it('reports whole runs that sit entirely past the ceiling', () => {
    const { original } = ceilBase();
    // A growing patch: 64 new bytes appended past the addressable window.
    const grown = new Uint8Array(ROM_16MIB + 64);
    grown.set(original);
    for (let i = 0; i < 64; i++) grown[ROM_16MIB + i] = 0xee;
    const report = produceIpsRecordsWithReport(original, grown);
    expect(report.records.length).toBe(0);
    expect(report.unrepresentableBytes).toBe(64);
    expect(report.unrepresentableRanges).toEqual([[ROM_16MIB, ROM_16MIB + 64]]);
  });

  it('produceIpsRecords stays a records-only view of the same diff', () => {
    const { original, modified } = ceilBase();
    for (let i = 0; i < 3; i++) modified[LAST_ADDRESSABLE_INDEX - 1 + i] = 0xaa + i;
    const records = produceIpsRecords(original, modified);
    const report = produceIpsRecordsWithReport(original, modified);
    expect(records).toEqual(report.records);
  });

  it('a fully in-range diff round-trips through encode → decode → apply', () => {
    const original = new Uint8Array(1024);
    const modified = new Uint8Array(original);
    modified[100] = 0xde;
    modified[101] = 0xad;
    const report = produceIpsRecordsWithReport(original, modified);
    expect(report.unrepresentableBytes).toBe(0);
    expect(report.unrepresentableRanges).toEqual([]);
    const decoded = decodeIps(encodeIps(report.records));
    expect(applyIps(original, decoded)).toEqual(modified);
  });
});
