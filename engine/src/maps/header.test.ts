import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { MAP_HEADER_SIZE_BYTES, parseMapHeader } from './header.js';

/** Helper: build a 28-byte MapHeader inside a larger buffer at offset. */
function plantMapHeader(args: {
  bufferSize: number;
  headerAt: number;
  layoutOffset: number;
  eventsOffset?: number | null;
  scriptsOffset?: number | null;
  connectionsOffset?: number | null;
  musicId?: number;
  mapLayoutId?: number;
  mapType?: number;
}): Buffer {
  const buf = Buffer.alloc(args.bufferSize);
  const w = (off: number, addr: number) => {
    buf.writeUInt32LE(addr === 0 ? 0 : (GBA_ROM_BASE_ADDRESS + addr) >>> 0, off);
  };
  w(args.headerAt + 0x00, args.layoutOffset);
  w(args.headerAt + 0x04, args.eventsOffset ?? 0);
  w(args.headerAt + 0x08, args.scriptsOffset ?? 0);
  w(args.headerAt + 0x0c, args.connectionsOffset ?? 0);
  buf.writeUInt16LE(args.musicId ?? 0, args.headerAt + 0x10);
  buf.writeUInt16LE(args.mapLayoutId ?? 0, args.headerAt + 0x12);
  buf[args.headerAt + 0x17] = args.mapType ?? 1;
  // bytes 0x18 (bikingAllowed), 0x19 (flags), 0x1A (floorNum) already zero
  // (Buffer.alloc), which is a valid combination.
  return buf;
}

describe('parseMapHeader - happy paths', () => {
  it('parses a minimal MapHeader with only layout pointer set', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800, mapType: 3 });
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.mapLayoutOffset).toBe(0x800);
      expect(r.header.mapType).toBe(3);
      expect(r.header.eventsOffset).toBeNull();
      expect(r.header.mapScriptsOffset).toBeNull();
      expect(r.header.connectionsOffset).toBeNull();
    }
  });

  it('parses a MapHeader with non-null events/scripts/connections', () => {
    const buf = plantMapHeader({
      bufferSize: 4096,
      headerAt: 0x100,
      layoutOffset: 0x800,
      eventsOffset: 0x900,
      scriptsOffset: 0xa00,
      connectionsOffset: 0xb00,
      mapType: 4,
      musicId: 0x10,
      mapLayoutId: 0x20,
    });
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.eventsOffset).toBe(0x900);
      expect(r.header.mapScriptsOffset).toBe(0xa00);
      expect(r.header.connectionsOffset).toBe(0xb00);
      expect(r.header.musicId).toBe(0x10);
      expect(r.header.mapLayoutId).toBe(0x20);
    }
  });

  it('freezes the returned header', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800 });
    const r = parseMapHeader(buf, 0x100);
    if (r.ok) expect(Object.isFrozen(r.header)).toBe(true);
  });
});

describe('parseMapHeader - failure modes', () => {
  it('fails too_short when bytes-available < 28', () => {
    const r = parseMapHeader(new Uint8Array(20), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails invalid_map_layout_pointer when layout pointer is NULL', () => {
    const buf = Buffer.alloc(4096);
    // layout pointer = 0 → NULL; we require it to be a valid ROM pointer.
    buf[0x100 + 0x17] = 3;
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_map_layout_pointer');
  });

  it('fails invalid_map_layout_pointer when layout pointer is not GBA ROM', () => {
    const buf = Buffer.alloc(4096);
    buf.writeUInt32LE(0x02000000, 0x100); // EWRAM, not ROM
    buf[0x100 + 0x17] = 3;
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_map_layout_pointer');
  });

  it('fails invalid_map_layout_pointer when layout target is past ROM', () => {
    const buf = Buffer.alloc(4096);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x10000) >>> 0, 0x100); // past end
    buf[0x100 + 0x17] = 3;
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_map_layout_pointer');
  });

  it('fails implausible_map_type when mapType > 9', () => {
    const buf = plantMapHeader({
      bufferSize: 4096,
      headerAt: 0x100,
      layoutOffset: 0x800,
      mapType: 200,
    });
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_map_type');
  });

  it('fails implausible_map_type when mapType = 0', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800, mapType: 0 });
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_map_type');
  });

  it('fails implausible_map_flags when the bikingAllowed + flags bytes are both 0xFF', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800, mapType: 3 });
    buf[0x100 + 0x18] = 0xff; // bikingAllowed is a bool8 - never 0xFF
    buf[0x100 + 0x19] = 0xff; // flags byte's upper bits are the showMapName count
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('implausible_map_flags');
      if (r.failure.kind === 'implausible_map_flags') {
        expect(r.failure.bikingAllowedByte).toBe(0xff);
        expect(r.failure.flagsByte).toBe(0xff);
      }
    }
  });
});

describe('parseMapHeader - bytes 0x18..0x1B field layout (pret struct MapHeader)', () => {
  it('reads bikingAllowed@0x18, flags@0x19, floorNum@0x1A, battleType@0x1B', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800, mapType: 3 });
    buf[0x100 + 0x18] = 0x01; // bikingAllowed = true (allow_cycling)
    buf[0x100 + 0x19] = 0x02; // flags: bit1 allowRunning
    buf[0x100 + 0x1a] = 0xff; // floorNum = -1 (B1F)
    buf[0x100 + 0x1b] = 0x04; // battleType
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.bikingAllowed).toBe(true);
      expect(r.header.flags).toBe(0x02);
      expect(r.header.floorNum).toBe(-1);
      expect(r.header.battleType).toBe(0x04);
    }
  });

  it('does NOT read the flags bitfield from 0x1A (the former, wrong offset)', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800, mapType: 3 });
    buf[0x100 + 0x1a] = 0x0f; // this is a floor number, not a flags byte
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.flags).toBe(0);
      expect(r.header.floorNum).toBe(0x0f);
    }
  });

  it('reads a positive floor number from 0x1A', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800, mapType: 3 });
    buf[0x100 + 0x1a] = 0x02; // 2F
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.header.floorNum).toBe(2);
  });

  it('reports bikingAllowed = false when byte 0x18 is 0', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0x100, layoutOffset: 0x800, mapType: 3 });
    const r = parseMapHeader(buf, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.header.bikingAllowed).toBe(false);
  });
});

describe('parseMapHeader - boundary', () => {
  it('accepts MapHeader at offset 0', () => {
    const buf = plantMapHeader({ bufferSize: 4096, headerAt: 0, layoutOffset: 0x800, mapType: 1 });
    const r = parseMapHeader(buf, 0);
    expect(r.ok).toBe(true);
  });

  it('correctly sizes MAP_HEADER_SIZE_BYTES = 28', () => {
    expect(MAP_HEADER_SIZE_BYTES).toBe(28);
  });
});
