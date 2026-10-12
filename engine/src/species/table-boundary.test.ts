import { describe, expect, it } from 'vitest';
import { isRealTableBoundary } from './table-boundary.js';

describe('isRealTableBoundary', () => {
  it('treats file offset 0 as a real boundary', () => {
    expect(isRealTableBoundary(new Uint8Array(0x100), 0)).toBe(true);
    expect(isRealTableBoundary(new Uint8Array(0x100), -8)).toBe(true);
  });

  it('is a real boundary when a non-zero byte sits in the 16 bytes before it', () => {
    const buf = new Uint8Array(0x100);
    buf[0x40 - 1] = 0xaa;
    expect(isRealTableBoundary(buf, 0x40)).toBe(true);
  });

  it('is NOT a real boundary when the preceding 16 bytes are all zero', () => {
    const buf = new Uint8Array(0x100);
    expect(isRealTableBoundary(buf, 0x40)).toBe(false);
  });

  it('only inspects the 16 bytes immediately before the offset', () => {
    const buf = new Uint8Array(0x100);
    buf[0x40 - 17] = 0xaa; // just outside the 16-byte window
    expect(isRealTableBoundary(buf, 0x40)).toBe(false);
    buf[0x40 - 16] = 0xaa; // inside the window
    expect(isRealTableBoundary(buf, 0x40)).toBe(true);
  });
});
