import { describe, it, expect } from 'vitest';
import { parseMapHeader } from './header.js';
import { encodeMapHeader, MapHeaderEncodeError } from './header-writer.js';

describe('encodeMapHeader', () => {
  it('round-trips the parser for a typical layout', () => {
    const spec = {
      mapLayoutOffset: 0x100000,
      eventsOffset: 0x100100,
      mapScriptsOffset: 0x100200,
      connectionsOffset: 0x100300,
      musicId: 0x1f3,
      mapLayoutId: 0x14,
      regionMapSection: 0x58,
      caveOrType: 0,
      weather: 0,
      mapType: 1, // Town
      bikingAllowed: true,
      flags: 0x06,
      floorNum: -1,
      battleType: 0,
    } as const;
    const bytes = encodeMapHeader(spec);
    expect(bytes.length).toBe(28);
    // Pad in a buffer big enough that the parser's pointer-target-in-ROM
    // checks pass.
    const buf = new Uint8Array(0x200000);
    buf.set(bytes, 0);
    const parsed = parseMapHeader(buf, 0);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.header.mapLayoutOffset).toBe(0x100000);
      expect(parsed.header.eventsOffset).toBe(0x100100);
      expect(parsed.header.mapScriptsOffset).toBe(0x100200);
      expect(parsed.header.connectionsOffset).toBe(0x100300);
      expect(parsed.header.musicId).toBe(0x1f3);
      expect(parsed.header.mapLayoutId).toBe(0x14);
      expect(parsed.header.regionMapSection).toBe(0x58);
      expect(parsed.header.mapType).toBe(1);
      expect(parsed.header.bikingAllowed).toBe(true);
      expect(parsed.header.flags).toBe(0x06);
      expect(parsed.header.floorNum).toBe(-1);
    }
  });

  it('writes bikingAllowed to 0x18 and the flags byte to 0x19', () => {
    const bytes = encodeMapHeader({
      mapLayoutOffset: 0x100000,
      eventsOffset: null,
      mapScriptsOffset: null,
      connectionsOffset: null,
      musicId: 0,
      mapLayoutId: 0,
      regionMapSection: 0,
      caveOrType: 0,
      weather: 0,
      mapType: 1,
      bikingAllowed: true,
      flags: 0x02,
      floorNum: -2,
      battleType: 0,
    });
    expect(bytes[0x18]).toBe(0x01); // bikingAllowed
    expect(bytes[0x19]).toBe(0x02); // flags
    expect(bytes[0x1a]).toBe(0xfe); // floorNum -2 as s8
  });

  it('encodes NULL pointers for absent events/scripts/connections', () => {
    const spec = {
      mapLayoutOffset: 0x100000,
      eventsOffset: null,
      mapScriptsOffset: null,
      connectionsOffset: null,
      musicId: 0,
      mapLayoutId: 0,
      regionMapSection: 0,
      caveOrType: 0,
      weather: 0,
      mapType: 1,
      flags: 0,
      battleType: 0,
    } as const;
    const bytes = encodeMapHeader(spec);
    expect(bytes.slice(0x04, 0x10)).toEqual(new Uint8Array(12));
    const buf = new Uint8Array(0x200000);
    buf.set(bytes, 0);
    const parsed = parseMapHeader(buf, 0);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.header.eventsOffset).toBeNull();
      expect(parsed.header.mapScriptsOffset).toBeNull();
      expect(parsed.header.connectionsOffset).toBeNull();
    }
  });

  it('rejects NULL mapLayoutOffset', () => {
    expect(() =>
      encodeMapHeader({
        mapLayoutOffset: null as unknown as number,
        eventsOffset: null,
        mapScriptsOffset: null,
        connectionsOffset: null,
        musicId: 0,
        mapLayoutId: 0,
        regionMapSection: 0,
        caveOrType: 0,
        weather: 0,
        mapType: 1,
        flags: 0,
        battleType: 0,
      }),
    ).toThrow(MapHeaderEncodeError);
  });

  it('rejects out-of-range mapType', () => {
    expect(() =>
      encodeMapHeader({
        mapLayoutOffset: 0x100000,
        eventsOffset: null,
        mapScriptsOffset: null,
        connectionsOffset: null,
        musicId: 0,
        mapLayoutId: 0,
        regionMapSection: 0,
        caveOrType: 0,
        weather: 0,
        mapType: 99,
        flags: 0,
        battleType: 0,
      }),
    ).toThrow(/mapType=99/);
  });

  it('rejects out-of-range u16 musicId', () => {
    expect(() =>
      encodeMapHeader({
        mapLayoutOffset: 0x100000,
        eventsOffset: null,
        mapScriptsOffset: null,
        connectionsOffset: null,
        musicId: 0x10000,
        mapLayoutId: 0,
        regionMapSection: 0,
        caveOrType: 0,
        weather: 0,
        mapType: 1,
        flags: 0,
        battleType: 0,
      }),
    ).toThrow(/musicId/);
  });
});
