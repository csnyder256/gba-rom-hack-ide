import { describe, it, expect } from 'vitest';
import {
  encodeRegionMapSection,
  liftRegionMapSections,
  RegionMapSectionEncodeError,
} from './region-map-sections-writer.js';
import { encodeString } from '../text/codec.js';
import {
  REGION_MAP_SECTION_SIZE_BYTES_12,
  REGION_MAP_SECTION_SIZE_BYTES_8,
  scanRegionMapSections,
  type RegionMapSection,
} from '../world/region-map-sections.js';

const GBA_ROM_BASE = 0x08000000;

describe('encodeRegionMapSection', () => {
  it('encodes a 12-byte Emerald-style entry at the offsets the parser reads', () => {
    const bytes = encodeRegionMapSection(
      { x: 5, y: 6, width: 2, height: 1, nameOffset: 0x100000 },
      '12byte',
    );
    expect(bytes.length).toBe(12);
    // s16 x @0x00 (5 = 05 00), s16 y @0x02 (6 = 06 00)
    expect(bytes[0x00]).toBe(5);
    expect(bytes[0x01]).toBe(0);
    expect(bytes[0x02]).toBe(6);
    expect(bytes[0x03]).toBe(0);
    // u8 width/height @0x04/0x05
    expect(bytes[0x04]).toBe(2);
    expect(bytes[0x05]).toBe(1);
    // u16 padding @0x06 must be zero (the parser rejects anything else)
    expect(bytes[0x06]).toBe(0);
    expect(bytes[0x07]).toBe(0);
    // namePointer @0x08 - 0x08100000 LE
    expect(bytes[0x08]).toBe(0x00);
    expect(bytes[0x09]).toBe(0x00);
    expect(bytes[0x0a]).toBe(0x10);
    expect(bytes[0x0b]).toBe(0x08);
  });

  it('encodes a negative 12-byte y as s16 LE', () => {
    const bytes = encodeRegionMapSection(
      { x: -2, y: -1, width: 0, height: 0, nameOffset: null },
      '12byte',
    );
    // -2 = FE FF, -1 = FF FF
    expect(bytes[0x00]).toBe(0xfe);
    expect(bytes[0x01]).toBe(0xff);
    expect(bytes[0x02]).toBe(0xff);
    expect(bytes[0x03]).toBe(0xff);
  });

  it('encodes an 8-byte FRLG-style entry at the offsets the parser reads', () => {
    const bytes = encodeRegionMapSection(
      { x: 5, y: 6, width: 2, height: 1, nameOffset: 0x100000 },
      '8byte',
    );
    expect(bytes.length).toBe(8);
    // u8 x/y/w/h @0x00..0x03, then namePointer @0x04
    expect(bytes[0x00]).toBe(5);
    expect(bytes[0x01]).toBe(6);
    expect(bytes[0x02]).toBe(2);
    expect(bytes[0x03]).toBe(1);
    expect(bytes[0x04]).toBe(0x00);
    expect(bytes[0x05]).toBe(0x00);
    expect(bytes[0x06]).toBe(0x10);
    expect(bytes[0x07]).toBe(0x08);
  });

  it('encodes a NULL name pointer for sentinel slots (both layouts)', () => {
    const twelve = encodeRegionMapSection(
      { x: 0, y: 0, width: 0, height: 0, nameOffset: null },
      '12byte',
    );
    expect(twelve[0x08]).toBe(0);
    expect(twelve[0x09]).toBe(0);
    expect(twelve[0x0a]).toBe(0);
    expect(twelve[0x0b]).toBe(0);
    const eight = encodeRegionMapSection(
      { x: 0, y: 0, width: 0, height: 0, nameOffset: null },
      '8byte',
    );
    expect(eight[0x04]).toBe(0);
    expect(eight[0x05]).toBe(0);
    expect(eight[0x06]).toBe(0);
    expect(eight[0x07]).toBe(0);
  });

  it('rejects coordinates/sizes the scanner would reject', () => {
    // 12-byte x/y are s16 in [-2, 127]; 128 is past the parser bound.
    expect(() =>
      encodeRegionMapSection({ x: 128, y: 0, width: 0, height: 0, nameOffset: null }, '12byte'),
    ).toThrow(RegionMapSectionEncodeError);
    // 12-byte width/height are bounded at 16 by the scanner.
    expect(() =>
      encodeRegionMapSection({ x: 0, y: 0, width: 17, height: 0, nameOffset: null }, '12byte'),
    ).toThrow(RegionMapSectionEncodeError);
    // 8-byte uses the full u8 range - 200 is legal there.
    expect(() =>
      encodeRegionMapSection({ x: 200, y: 200, width: 200, height: 200, nameOffset: null }, '8byte'),
    ).not.toThrow();
    // ...but not > 255.
    expect(() =>
      encodeRegionMapSection({ x: 300, y: 0, width: 0, height: 0, nameOffset: null }, '8byte'),
    ).toThrow(RegionMapSectionEncodeError);
  });
});

// ── Round-trip: the encoder must be the inverse of the scanner's parser ──

const NAMES = [
  'PALLET TOWN',
  'VIRIDIAN CITY',
  'PEWTER CITY',
  'CERULEAN CITY',
  'VERMILION CITY',
  'CELADON CITY',
  'FUCHSIA CITY',
  'SAFFRON CITY',
  'LAVENDER TOWN',
  'CINNABAR ISLAND',
  'INDIGO PLATEAU',
  'ROUTE 1',
];

/** Plant a 12-byte-layout table the scanner accepts. Returns the buffer
 *  plus the file offsets of each name string. */
function plant12(): { bytes: Uint8Array; nameOffsets: number[] } {
  const bytes = new Uint8Array(256 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
  const view = new DataView(bytes.buffer);
  const nameOffsets: number[] = [];
  let cursorName = 0x10000;
  for (const name of NAMES) {
    const encoded = encodeString(name);
    bytes.set(encoded, cursorName);
    bytes[cursorName + encoded.length] = 0xff;
    nameOffsets.push(cursorName);
    cursorName += encoded.length + 1;
  }
  const tableOffset = 0x4000;
  let cursor = tableOffset;
  for (let i = 0; i < NAMES.length; i++) {
    view.setInt16(cursor + 0x00, (i % 30) - 1, true); // x
    view.setInt16(cursor + 0x02, (i % 20), true); // y
    bytes[cursor + 0x04] = 2; // width
    bytes[cursor + 0x05] = 2; // height
    view.setUint16(cursor + 0x06, 0, true); // padding
    view.setUint32(cursor + 0x08, GBA_ROM_BASE + nameOffsets[i]!, true);
    cursor += REGION_MAP_SECTION_SIZE_BYTES_12;
  }
  for (let i = 0; i < 30; i++) {
    view.setInt16(cursor + 0x00, 0, true);
    view.setInt16(cursor + 0x02, 0, true);
    bytes[cursor + 0x04] = 0;
    bytes[cursor + 0x05] = 0;
    view.setUint16(cursor + 0x06, 0, true);
    view.setUint32(cursor + 0x08, 0, true);
    cursor += REGION_MAP_SECTION_SIZE_BYTES_12;
  }
  bytes[cursor + 0x06] = 0xff; // invalid entry terminates the run cleanly
  return { bytes, nameOffsets };
}

/** Plant an 8-byte-layout table the scanner accepts. */
function plant8(): { bytes: Uint8Array; nameOffsets: number[] } {
  const bytes = new Uint8Array(256 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
  const view = new DataView(bytes.buffer);
  const nameOffsets: number[] = [];
  let cursorName = 0x10000;
  for (const name of NAMES) {
    const encoded = encodeString(name);
    bytes.set(encoded, cursorName);
    bytes[cursorName + encoded.length] = 0xff;
    nameOffsets.push(cursorName);
    cursorName += encoded.length + 1;
  }
  const tableOffset = 0x4000;
  let cursor = tableOffset;
  for (let i = 0; i < NAMES.length; i++) {
    bytes[cursor + 0x00] = (i % 30) + 1; // x
    bytes[cursor + 0x01] = (i % 16) + 1; // y
    bytes[cursor + 0x02] = 2; // width
    bytes[cursor + 0x03] = 2; // height
    view.setUint32(cursor + 0x04, GBA_ROM_BASE + nameOffsets[i]!, true);
    cursor += REGION_MAP_SECTION_SIZE_BYTES_8;
  }
  for (let i = 0; i < 30; i++) {
    bytes[cursor + 0x00] = 0;
    bytes[cursor + 0x01] = 0;
    bytes[cursor + 0x02] = 0;
    bytes[cursor + 0x03] = 0;
    view.setUint32(cursor + 0x04, 0, true);
    cursor += REGION_MAP_SECTION_SIZE_BYTES_8;
  }
  bytes[cursor + 0x02] = 0xff; // width=255 -> invalid, terminates the run
  bytes[cursor + 0x03] = 0xff;
  return { bytes, nameOffsets };
}

describe('encodeRegionMapSection round-trips through the scanner', () => {
  it('12-byte: rewriting an entry in place is read back unchanged', () => {
    const { bytes } = plant12();
    const before = scanRegionMapSections(bytes);
    expect(before?.layoutKind).toBe('12byte');

    const sectionIndex = 3;
    const entry = before!.sections[sectionIndex]!;
    const entryOffset = before!.tableStart + sectionIndex * REGION_MAP_SECTION_SIZE_BYTES_12;
    const newEntry = encodeRegionMapSection(
      { x: 10, y: 11, width: 3, height: 4, nameOffset: entry.nameRomPointer - GBA_ROM_BASE },
      '12byte',
    );
    bytes.set(newEntry, entryOffset);

    const after = scanRegionMapSections(bytes);
    expect(after?.layoutKind).toBe('12byte');
    const parsed = after!.sections[sectionIndex]!;
    expect(parsed.x).toBe(10);
    expect(parsed.y).toBe(11);
    expect(parsed.width).toBe(3);
    expect(parsed.height).toBe(4);
    expect(parsed.name).toBe(entry.name); // name pointer preserved
  });

  it('8-byte: rewriting an entry in place is read back unchanged', () => {
    const { bytes } = plant8();
    const before = scanRegionMapSections(bytes);
    expect(before?.layoutKind).toBe('8byte');

    const sectionIndex = 5;
    const entry = before!.sections[sectionIndex]!;
    const entryOffset = before!.tableStart + sectionIndex * REGION_MAP_SECTION_SIZE_BYTES_8;
    const newEntry = encodeRegionMapSection(
      { x: 30, y: 237, width: 8, height: 8, nameOffset: entry.nameRomPointer - GBA_ROM_BASE },
      '8byte',
    );
    bytes.set(newEntry, entryOffset);

    const after = scanRegionMapSections(bytes);
    expect(after?.layoutKind).toBe('8byte');
    const parsed = after!.sections[sectionIndex]!;
    expect(parsed.x).toBe(30);
    expect(parsed.y).toBe(237);
    expect(parsed.width).toBe(8);
    expect(parsed.height).toBe(8);
    expect(parsed.name).toBe(entry.name);
  });
});

describe('liftRegionMapSections', () => {
  it('lifts scanner sections into manifest entries', () => {
    const sections: RegionMapSection[] = [
      {
        sectionIndex: 0,
        x: 5,
        y: 6,
        width: 2,
        height: 1,
        nameRomPointer: 0x08100000,
        name: 'PALLET TOWN',
        fileOffset: 0x200000,
      },
      {
        sectionIndex: 1,
        x: 6,
        y: 6,
        width: 4,
        height: 1,
        nameRomPointer: 0x08100100,
        name: 'ROUTE 1',
        fileOffset: 0x200008,
      },
    ];
    const lifted = liftRegionMapSections(sections);
    expect(lifted).toHaveLength(2);
    expect(lifted[0]!.id).toBe('region_map_section_0');
    expect(lifted[0]!.name).toBe('PALLET TOWN');
    expect(lifted[1]!.id).toBe('region_map_section_1');
    expect(lifted[1]!.x).toBe(6);
    expect(lifted[1]!.width).toBe(4);
  });
});
