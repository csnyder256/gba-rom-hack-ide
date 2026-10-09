/**
 * Phase 9A - heap-readers tests.
 *
 * These run without booting mGBA. We construct synthetic byte arrays
 * that look like the WASM heap would after a cart is loaded, then
 * exercise the offset-finder + the memory-read API.
 */

import { describe, expect, it } from 'vitest';
import {
  GBA_REGIONS,
  MemoryUnavailableError,
  buildOffsetTable,
  findRegionForAddr,
  findRomBaseInHeap,
  readGbaMemory,
} from './heap-readers.js';

// The canonical Nintendo-logo prefix lives at ROM+0x04..0x9F. The
// first 32 bytes are enough to anchor the scan.
const NINTENDO_LOGO_PREFIX = [
  0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a, 0x84, 0xe4, 0x09, 0xad,
  0x11, 0x24, 0x8b, 0x98, 0xc0, 0x81, 0x7f, 0x21, 0xa3, 0x52, 0xbe, 0x19, 0x93, 0x09, 0xce, 0x20,
] as const;

/** Build a fake heap containing the logo at offset `romBaseInHeap + 4`. */
function makeFakeHeap(romBaseInHeap: number, romSize: number): Uint8Array {
  const heap = new Uint8Array(romBaseInHeap + romSize + 16);
  // The 4 bytes BEFORE the logo would be the cart entry-point branch
  // (we don't validate them; the finder backs up 4 bytes from the
  // logo hit).
  heap[romBaseInHeap + 0] = 0x00;
  heap[romBaseInHeap + 1] = 0x00;
  heap[romBaseInHeap + 2] = 0x00;
  heap[romBaseInHeap + 3] = 0xea;
  // The logo itself.
  for (let i = 0; i < NINTENDO_LOGO_PREFIX.length; i++) {
    heap[romBaseInHeap + 4 + i] = NINTENDO_LOGO_PREFIX[i];
  }
  // Pad some random pattern after.
  for (let i = romBaseInHeap + 4 + NINTENDO_LOGO_PREFIX.length; i < heap.length; i++) {
    heap[i] = i & 0xff;
  }
  return heap;
}

describe('emulator/heap-readers', () => {
  describe('findRomBaseInHeap', () => {
    it('locates the ROM at the start of the heap when aligned at offset 0', () => {
      const heap = makeFakeHeap(0, 256);
      expect(findRomBaseInHeap(heap)).toBe(0);
    });

    it('locates the ROM at a non-zero offset', () => {
      const heap = makeFakeHeap(1024, 256);
      expect(findRomBaseInHeap(heap)).toBe(1024);
    });

    it('locates the ROM at a 16 MiB-ish offset (realistic mGBA heap layout)', () => {
      const heap = makeFakeHeap(16 * 1024 * 1024, 256);
      expect(findRomBaseInHeap(heap)).toBe(16 * 1024 * 1024);
    });

    it('returns null when the logo is absent', () => {
      const heap = new Uint8Array(1024).fill(0xff);
      expect(findRomBaseInHeap(heap)).toBeNull();
    });

    it('finds the FIRST occurrence when multiple logos exist', () => {
      // (Unlikely in practice, but harmless to verify.)
      const h1 = makeFakeHeap(100, 256);
      const h2 = makeFakeHeap(500, 256);
      const combined = new Uint8Array(h1.length + h2.length);
      combined.set(h1, 0);
      combined.set(h2, h1.length);
      // The first match is at 100.
      expect(findRomBaseInHeap(combined)).toBe(100);
    });
  });

  describe('findRegionForAddr', () => {
    it('resolves canonical region addresses', () => {
      expect(findRegionForAddr(0x08000000)?.name).toBe('rom');
      expect(findRegionForAddr(0x02000000)?.name).toBe('ewram');
      expect(findRegionForAddr(0x03000000)?.name).toBe('iwram');
      expect(findRegionForAddr(0x06000000)?.name).toBe('vram');
    });

    it('resolves offsets WITHIN a region', () => {
      expect(findRegionForAddr(0x08000100)?.name).toBe('rom');
      expect(findRegionForAddr(0x02023be4)?.name).toBe('ewram'); // FRLG gBattleMons
    });

    it('returns null for unmapped addresses', () => {
      expect(findRegionForAddr(0x01000000)).toBeNull(); // gap between BIOS and EWRAM
      expect(findRegionForAddr(0xffffffff)).toBeNull();
    });

    it('correctly bounds-checks the region size', () => {
      // EWRAM is 256 KiB starting at 0x02000000; 0x02040000 is
      // EXACTLY out of bounds.
      expect(findRegionForAddr(0x02040000)).toBeNull();
      // ...and 0x0203ffff is the last valid byte.
      expect(findRegionForAddr(0x0203ffff)?.name).toBe('ewram');
    });
  });

  describe('buildOffsetTable', () => {
    it('passes the rom offset through and leaves others null', () => {
      const t = buildOffsetTable(42);
      expect(t.rom).toBe(42);
      expect(t.ewram).toBeNull();
      expect(t.iwram).toBeNull();
      expect(t.vram).toBeNull();
    });

    it('accepts null for the rom offset', () => {
      const t = buildOffsetTable(null);
      expect(t.rom).toBeNull();
    });
  });

  describe('readGbaMemory', () => {
    it('reads ROM bytes via the resolved offset', () => {
      const heap = makeFakeHeap(1024, 256);
      const offsets = buildOffsetTable(1024);
      // Read the first 4 bytes from ROM (the cart entry-point branch).
      const bytes = readGbaMemory(heap, offsets, 0x08000000, 4);
      expect(bytes).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0xea]));
    });

    it('reads logo bytes at ROM+0x04', () => {
      const heap = makeFakeHeap(1024, 256);
      const offsets = buildOffsetTable(1024);
      const bytes = readGbaMemory(heap, offsets, 0x08000004, 8);
      expect(Array.from(bytes)).toEqual([0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21]);
    });

    it('returns empty array for length=0', () => {
      const heap = new Uint8Array(0);
      const offsets = buildOffsetTable(0);
      expect(readGbaMemory(heap, offsets, 0x08000000, 0)).toEqual(new Uint8Array(0));
    });

    it('throws MemoryUnavailableError when address is unmapped', () => {
      const heap = new Uint8Array(0);
      const offsets = buildOffsetTable(0);
      expect(() => readGbaMemory(heap, offsets, 0x01000000, 4)).toThrow(MemoryUnavailableError);
    });

    it('throws region_not_mapped when reading EWRAM (not yet supported)', () => {
      const heap = new Uint8Array(1024);
      const offsets = buildOffsetTable(0);
      try {
        readGbaMemory(heap, offsets, 0x02000000, 4);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MemoryUnavailableError);
        expect((e as MemoryUnavailableError).reason).toBe('region_not_mapped');
      }
    });

    it('throws out_of_bounds when read escapes the region', () => {
      const heap = makeFakeHeap(0, 256);
      const offsets = buildOffsetTable(0);
      // ROM region is 32 MiB; reading at +(32MiB-1) for 2 bytes
      // escapes the region.
      expect(() =>
        readGbaMemory(heap, offsets, 0x08000000 + GBA_REGIONS.rom.size - 1, 2),
      ).toThrow(MemoryUnavailableError);
    });

    it('rejects sanity-cap-violating lengths', () => {
      const heap = new Uint8Array(0);
      const offsets = buildOffsetTable(0);
      expect(() => readGbaMemory(heap, offsets, 0x08000000, 65 * 1024 * 1024)).toThrow(
        MemoryUnavailableError,
      );
    });
  });
});
