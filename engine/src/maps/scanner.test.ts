import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { scanMapHeaders, totalMapHeaderBytes } from './scanner.js';

/**
 * Plant a fake map-header table inside a buffer.
 *
 * Layout:
 *   `tableStart` holds N consecutive 4-byte pointers, each pointing to a
 *   28-byte MapHeader struct planted at `firstHeaderAt + i * 28`.
 *
 * Each MapHeader has:
 *   layoutPointer = a valid in-buffer offset (= firstHeaderAt + N*28 + i*4)
 *   mapType = (i % 9) + 1 (cycles 1..9, all plausible)
 *   bikingAllowed = 0, flags = 0 (not 0xFF/0xFF, so implausible_map_flags
 *   doesn't trip)
 */
function plantMapTable(args: {
  bufferSize: number;
  tableStart: number;
  numMaps: number;
}): Buffer {
  const buf = Buffer.alloc(args.bufferSize);
  const firstHeaderAt = args.tableStart + args.numMaps * 4;
  // Plant the pointer table.
  for (let i = 0; i < args.numMaps; i++) {
    const headerOffset = firstHeaderAt + i * 28;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + headerOffset) >>> 0, args.tableStart + i * 4);
  }
  // Plant each MapHeader struct.
  for (let i = 0; i < args.numMaps; i++) {
    const headerOffset = firstHeaderAt + i * 28;
    // Layout pointer at offset 0 - points just past the headers.
    const layoutOffset = firstHeaderAt + args.numMaps * 28 + i * 4;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + layoutOffset) >>> 0, headerOffset + 0);
    buf[headerOffset + 0x17] = (i % 9) + 1; // mapType 1..9
  }
  return buf;
}

describe('scanMapHeaders', () => {
  it('returns empty for all-zero buffer', () => {
    expect(scanMapHeaders(new Uint8Array(8192))).toEqual([]);
  });

  it('finds a single planted table with 8 map headers', () => {
    const buf = plantMapTable({ bufferSize: 16 * 1024, tableStart: 0x100, numMaps: 8 });
    const candidates = scanMapHeaders(buf);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.tableStart).toBe(0x100);
    expect(candidates[0]?.mapCount).toBe(8);
    expect(candidates[0]?.maps).toHaveLength(8);
    // First map should be at firstHeaderAt = 0x100 + 8*4 = 0x120.
    expect(candidates[0]?.maps[0]?.mapHeaderOffset).toBe(0x120);
  });

  it('rejects tables with too few valid map headers (default minMapsInTable=3)', () => {
    // Plant only 2 map headers - should be rejected.
    const buf = Buffer.alloc(8192);
    // Plant 3 pointers (above the pointer-table min) but only 2 valid maps.
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x200) >>> 0, 0x100);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x220) >>> 0, 0x104);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x300) >>> 0, 0x108);
    // Map at 0x200: layout valid, mapType 3.
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x500) >>> 0, 0x200);
    buf[0x200 + 0x17] = 3;
    // Map at 0x220: layout valid, mapType 4.
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x500) >>> 0, 0x220);
    buf[0x220 + 0x17] = 4;
    // "Map" at 0x300: layout is 0 → NULL → fails parse.
    expect(scanMapHeaders(buf)).toEqual([]);
  });

  it('honors custom minMapsInTable', () => {
    const buf = plantMapTable({ bufferSize: 16 * 1024, tableStart: 0x100, numMaps: 8 });
    expect(scanMapHeaders(buf, { minMapsInTable: 8 })).toHaveLength(1);
    expect(scanMapHeaders(buf, { minMapsInTable: 9 })).toHaveLength(0);
  });

  it('finds multiple tables in one ROM', () => {
    const buf = Buffer.alloc(32 * 1024);
    const tableA = plantMapTable({ bufferSize: 32 * 1024, tableStart: 0x100, numMaps: 8 });
    const tableB = plantMapTable({ bufferSize: 32 * 1024, tableStart: 0x4000, numMaps: 8 });
    // Copy both planted tables into the shared buffer (their non-overlapping
    // regions don't clash).
    for (let i = 0; i < tableA.length; i++) {
      if (tableA[i] !== 0) buf[i] = tableA[i] ?? 0;
    }
    for (let i = 0; i < tableB.length; i++) {
      if (tableB[i] !== 0) buf[i] = tableB[i] ?? 0;
    }
    const candidates = scanMapHeaders(buf);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const starts = candidates.map((c) => c.tableStart).sort((a, b) => a - b);
    expect(starts).toContain(0x100);
    expect(starts).toContain(0x4000);
  });

  it('truncates a partial map-table after a non-header entry (accepting only the prefix)', () => {
    // With tableStart=0x100 + numMaps=8: firstHeaderAt = 0x100 + 8*4 = 0x120,
    // so header N starts at 0x120 + N*28. Corrupt headers 6 + 7 by writing
    // an out-of-range layout pointer at offset 0 of each (16 KB ROM, so
    // a layout pointing past 0x80000 trips invalid_map_layout_pointer).
    const buf = plantMapTable({ bufferSize: 32 * 1024, tableStart: 0x100, numMaps: 8 });
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x80000) >>> 0, 0x120 + 6 * 28);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x80000) >>> 0, 0x120 + 7 * 28);
    const candidates = scanMapHeaders(buf);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.mapCount).toBe(6);
  });

  it('truncates before a following outer group table that points back into the map table', () => {
    const buf = Buffer.alloc(32 * 1024);
    const tableStart = 0x100;
    const firstHeaderAt = 0x400;
    for (let i = 0; i < 8; i++) {
      const headerOffset = firstHeaderAt + i * 28;
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + headerOffset) >>> 0, tableStart + i * 4);
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x800 + i * 4) >>> 0, headerOffset);
      buf[headerOffset + 0x17] = (i % 9) + 1;
    }
    // Append a FireRed-style gMapGroups run immediately after the flat
    // map-header pointer table. These entries point into the table's own
    // pointer run and must not be parsed as phantom MapHeaders.
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x100) >>> 0, 0x120);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x110) >>> 0, 0x124);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x11c) >>> 0, 0x128);

    const candidates = scanMapHeaders(buf);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.mapCount).toBe(8);
    expect(candidates[0]?.maps.at(-1)?.tableEntryOffset).toBe(0x11c);
  });

  it('rejects invalid minMapsInTable', () => {
    expect(() => scanMapHeaders(new Uint8Array(1024), { minMapsInTable: 0 })).toThrow();
    expect(() => scanMapHeaders(new Uint8Array(1024), { minMapsInTable: -1 })).toThrow();
  });
});

describe('totalMapHeaderBytes', () => {
  it('returns 0 for empty input', () => {
    expect(totalMapHeaderBytes([])).toBe(0);
  });

  it('sums mapCount × 28 across candidates', () => {
    const fake = [
      {
        tableStart: 0,
        mapCount: 8,
        maps: Object.freeze([]) as ReadonlyArray<never>,
      },
      {
        tableStart: 0,
        mapCount: 5,
        maps: Object.freeze([]) as ReadonlyArray<never>,
      },
    ] as Parameters<typeof totalMapHeaderBytes>[0];
    expect(totalMapHeaderBytes(fake)).toBe(13 * 28);
  });
});
