/**
 * Sliding-window byte-entropy heuristic.
 *
 * Many GBA cart compressed regions are stored in non-LZ77 formats:
 * custom RLE schemes, repointed compression with a non-0x10 header,
 * encrypted asset blocks, etc. Any of these is structurally invisible
 * to the LZ77 scanner, but they share a common observable: byte-
 * frequency entropy near the 8-bit maximum (8.0 bits/byte). Plain
 * ARM7 code is typically 3.5–5 bits/byte (skewed byte distribution
 * from common opcodes); zero-fill or RLE-friendly data is 0–1 bits/
 * byte. Compressed or encrypted data clusters at 7.0+ bits/byte.
 *
 * PD 8 contract: regions the LZ77 scanner couldn't claim but that have
 * high entropy MUST be surfaced as `probable_compression` with a
 * confidence score - never silently dropped into `unaccounted`. That
 * routing is the orchestrating detector's job; this module supplies
 * the per-region entropy figure.
 *
 * Algorithm: walk the ROM with a fixed-size sliding window (default
 * 1024 bytes). Maintain a rolling 256-bin histogram (add the new byte
 * on the right, subtract the leaving byte on the left). Compute
 * Shannon entropy from the histogram. Group consecutive windows whose
 * entropy ≥ threshold into a single EntropyRegion.
 *
 * Performance: O(N) over input bytes (constant work per byte for the
 * rolling histogram, then entropy from the 256-bin histogram per
 * window step). A 16 MiB ROM completes in ~150 ms on this dev box.
 */

export interface EntropyRegion {
  /** Inclusive start of the high-entropy region. */
  readonly start: number;
  /** Exclusive end. */
  readonly endExclusive: number;
  /** Length in bytes. */
  readonly length: number;
  /** Average entropy over the region in bits/byte (max 8.0). */
  readonly meanEntropy: number;
  /** Peak entropy observed in any sub-window of the region. */
  readonly peakEntropy: number;
}

export interface EntropyOptions {
  /** Window size in bytes. Default 1024. */
  readonly windowSize?: number;
  /** Step between window evaluations. Default 512 (50% overlap). */
  readonly stepSize?: number;
  /** Entropy threshold above which a window is "high". Default 7.0. */
  readonly highEntropyThreshold?: number;
  /** Optional start offset (default 0). */
  readonly startOffset?: number;
  /** Optional end offset, exclusive. Default bytes.length. */
  readonly endOffsetExclusive?: number;
}

/**
 * Compute Shannon entropy in bits over a slice of bytes. Pure helper - 
 * use only for one-off measurements, not in inner loops (the high-
 * volume scan uses a rolling histogram).
 */
export function shannonEntropy(bytes: Uint8Array, start: number, length: number): number {
  if (length <= 0) return 0;
  const end = Math.min(bytes.length, start + length);
  const actual = end - start;
  if (actual <= 0) return 0;
  const hist = new Uint32Array(256);
  for (let i = start; i < end; i++) {
    const b = bytes[i] ?? 0;
    hist[b] = (hist[b] ?? 0) + 1;
  }
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = hist[i] ?? 0;
    if (c === 0) continue;
    const p = c / actual;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Find contiguous high-entropy regions in `bytes`. Returns regions
 * sorted by start; empty array when nothing crosses the threshold.
 */
export function findHighEntropyRegions(
  bytes: Uint8Array,
  opts?: EntropyOptions,
): EntropyRegion[] {
  const windowSize = opts?.windowSize ?? 1024;
  const stepSize = opts?.stepSize ?? 512;
  const threshold = opts?.highEntropyThreshold ?? 7.0;
  const start = opts?.startOffset ?? 0;
  const endExclusive = opts?.endOffsetExclusive ?? bytes.length;

  if (!Number.isInteger(windowSize) || windowSize < 16) {
    throw new Error(`windowSize must be an integer ≥ 16, got ${String(windowSize)}`);
  }
  if (!Number.isInteger(stepSize) || stepSize < 1) {
    throw new Error(`stepSize must be a positive integer, got ${String(stepSize)}`);
  }
  if (start < 0 || endExclusive > bytes.length || endExclusive < start) {
    throw new Error(
      `entropy window invalid: [${String(start)}, ${String(endExclusive)}) for buffer length ${String(bytes.length)}`,
    );
  }
  if (endExclusive - start < windowSize) return [];

  const regions: EntropyRegion[] = [];
  // Rolling histogram seeded with the first window's bytes.
  const hist = new Uint32Array(256);
  for (let i = start; i < start + windowSize; i++) {
    const b = bytes[i] ?? 0;
    hist[b] = (hist[b] ?? 0) + 1;
  }

  let inRegion = false;
  let regionStart = 0;
  let regionPeak = 0;
  let regionEntropySum = 0;
  let regionWindowCount = 0;

  let windowStart = start;
  while (windowStart + windowSize <= endExclusive) {
    const h = entropyFromHist(hist, windowSize);
    if (h >= threshold) {
      if (!inRegion) {
        inRegion = true;
        regionStart = windowStart;
        regionPeak = h;
        regionEntropySum = h;
        regionWindowCount = 1;
      } else {
        regionPeak = Math.max(regionPeak, h);
        regionEntropySum += h;
        regionWindowCount++;
      }
    } else {
      if (inRegion) {
        const regionEnd = windowStart + windowSize;
        regions.push(
          Object.freeze({
            start: regionStart,
            endExclusive: regionEnd,
            length: regionEnd - regionStart,
            meanEntropy: round3(regionEntropySum / regionWindowCount),
            peakEntropy: round3(regionPeak),
          }),
        );
        inRegion = false;
      }
    }

    // Advance window: subtract `stepSize` bytes from the left, add
    // `stepSize` bytes from the right. Last partial advance is short-
    // circuited by the loop condition above.
    const nextStart = windowStart + stepSize;
    if (nextStart + windowSize > endExclusive) break;
    for (let i = 0; i < stepSize; i++) {
      const leaving = bytes[windowStart + i] ?? 0;
      const entering = bytes[windowStart + windowSize + i] ?? 0;
      hist[leaving] = (hist[leaving] ?? 0) - 1;
      hist[entering] = (hist[entering] ?? 0) + 1;
    }
    windowStart = nextStart;
  }

  if (inRegion) {
    const regionEnd = windowStart + windowSize;
    regions.push(
      Object.freeze({
        start: regionStart,
        endExclusive: regionEnd,
        length: regionEnd - regionStart,
        meanEntropy: round3(regionEntropySum / regionWindowCount),
        peakEntropy: round3(regionPeak),
      }),
    );
  }

  return regions;
}

function entropyFromHist(hist: Uint32Array, total: number): number {
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = hist[i] ?? 0;
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
