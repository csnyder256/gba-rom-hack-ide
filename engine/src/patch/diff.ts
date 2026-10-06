/**
 * IPS record diff producer - Phase 13 P13-T1.
 *
 * Given an `original` byte buffer and a `modified` byte buffer of
 * the SAME length, produce a list of IPS records that, when applied
 * to `original`, yield `modified`. Coalesces adjacent differing
 * bytes into single literal records (up to IPS_MAX_LITERAL_LENGTH);
 * detects long runs of the same byte and emits RLE records when
 * they cross the break-even threshold (IPS_RLE_BREAK_EVEN_LENGTH).
 *
 * Growing patches are supported (`modified.length > original.length`):
 * trailing bytes of `modified` beyond `original` are always
 * considered "different" (since `original` has no byte at that offset),
 * so they fall into diff runs and become IPS records. The IPS format
 * supports growing patches directly via per-record offsets exceeding
 * the base ROM size - `applyIps` already grows the output buffer to
 * `max(record.end)`. Shrinking patches (`modified.length <
 * original.length`) are not meaningful in IPS (the spec has no "erase"
 * record) and remain an error.
 *
 * Addressable range: a 3-byte offset field means IPS can only describe
 * byte positions 0..IPS_MAX_OFFSET (0xFFFFFE), and 0x454F46 is reserved
 * for the "EOF" terminator and can never be written. Bytes at or beyond
 * IPS_MAX_OFFSET + 1 exist in a 16-32 MiB ROM but CANNOT be represented
 * in an IPS patch at all. Records are therefore emitted only for
 * differing bytes BELOW IPS_MAX_OFFSET: a literal is truncated to end
 * at IPS_MAX_OFFSET, and an RLE run is truncated to end there too. Any
 * difference covering only out-of-range bytes is skipped. The caller
 * learns how much was dropped via `ProduceIpsRecordsOptions`'s
 * companion `produceIpsRecordsWithReport`, and the remainder is
 * exactly what the BPS format (whose offsets are variable-length) is
 * for. Without this bound the diff could hand the encoder a record
 * whose body runs past IPS_MAX_OFFSET, and `applyIps` would then grow
 * the reconstructed ROM past the range IPS can address - so the patch
 * is accepted, applied, and silently wrong for every byte after the
 * limit.
 *
 * Determinism: records are emitted in ascending offset order, never
 * overlap, and never have zero length.
 */

import {
  IPS_MAX_LITERAL_LENGTH,
  IPS_MAX_OFFSET,
  IPS_MAX_RLE_LENGTH,
  IPS_RESERVED_EOF_OFFSET,
  IPS_RLE_BREAK_EVEN_LENGTH,
  IpsFormatError,
  type IpsRecord,
} from './ips.js';

export interface ProduceIpsRecordsOptions {
  /** Minimum run length to emit as an RLE record instead of literal.
   *  Default: IPS_RLE_BREAK_EVEN_LENGTH (8 bytes). */
  readonly rleThreshold?: number;
}

/** What a diff run produced, plus the bytes IPS could not describe.
 *  `unrepresentableRanges` holds `[start, end)` spans of `modified`
 *  whose bytes differ from `original` but sit at or past
 *  IPS_MAX_OFFSET + 1, where a 3-byte IPS offset cannot reach. A
 *  non-empty list means the emitted records reproduce `modified` only
 *  up to IPS_MAX_OFFSET; the caller must use BPS (variable-length
 *  offsets) to carry the rest. Callers that don't care keep using
 *  `produceIpsRecords`.
 */
export interface IpsDiffReport {
  readonly records: ReadonlyArray<IpsRecord>;
  readonly unrepresentableRanges: ReadonlyArray<readonly [number, number]>;
  /** Total count of differing bytes at or past IPS_MAX_OFFSET + 1. */
  readonly unrepresentableBytes: number;
}

/** Produce IPS records that transform `original` → `modified`, and
 *  report any differing bytes the IPS offset space cannot address. */
export function produceIpsRecordsWithReport(
  original: Uint8Array,
  modified: Uint8Array,
  opts?: ProduceIpsRecordsOptions,
): IpsDiffReport {
  if (modified.length < original.length) {
    throw new IpsFormatError(
      `produceIpsRecords cannot shrink ROMs (IPS has no erase record); got original=${String(original.length)} modified=${String(modified.length)}`,
    );
  }
  // Bytes with an index >= original.length have no counterpart in the
  // base ROM, so they always enter a diff run (growing patch).
  //
  // The upper bound is the real limit and it is deliberate: a record's
  // 3-byte offset only names where it STARTS, and the format has no way
  // to say "and stop before the end of the address space". A record
  // starting at 0xFFFFFC with four bytes of data is encodable, decodable
  // and silently truncating - `applyIps` grows the output to
  // 0x1000000, so the reconstructed ROM carries bytes in a region no IPS
  // patcher can express or verify. Guarding only the start offset (which
  // is what `encodeIps` does) is not enough; the diff must never emit a
  // byte past IPS_MAX_OFFSET in the first place.
  const diffLimit = Math.min(modified.length, IPS_MAX_OFFSET + 1);
  const rleThreshold = Math.max(2, opts?.rleThreshold ?? IPS_RLE_BREAK_EVEN_LENGTH);
  const records: IpsRecord[] = [];
  const unrepresentableRanges: Array<readonly [number, number]> = [];
  let unrepresentableBytes = 0;
  const noteUnrepresentable = (start: number, end: number): void => {
    if (end <= start) return;
    unrepresentableRanges.push(Object.freeze([start, end] as const));
    unrepresentableBytes += end - start;
  };
  // Helper: read original[i] safely. Past `original.length` (growing
  // patch case), return a sentinel that ALWAYS differs from any
  // possible `modified[i]` so the byte enters a diff run.
  const NOT_PRESENT = -1;
  const origByte = (i: number): number => (i < original.length ? original[i]! : NOT_PRESENT);

  let i = 0;
  while (i < modified.length) {
    if (modified[i] === origByte(i)) {
      i++;
      continue;
    }
    // Difference begins at i. Find the extent of the differing run.
    let runEnd = i;
    while (runEnd < modified.length && modified[runEnd] !== origByte(runEnd)) {
      runEnd++;
    }
    // Everything at or past the IPS ceiling is reported, never emitted.
    if (runEnd > diffLimit) {
      noteUnrepresentable(Math.max(i, diffLimit), runEnd);
    }
    // Now process [i, min(runEnd, diffLimit)) - could be one literal,
    // possibly with RLE sub-runs inside.
    const emitEnd = Math.min(runEnd, diffLimit);
    let cursor = i;
    while (cursor < emitEnd) {
      // Skip "EOF"-collision offsets by splitting the record. If the
      // record would start at the reserved 0x454F46 offset, emit a
      // 1-byte literal that ends at 0x454F46+1 instead.
      if (cursor === IPS_RESERVED_EOF_OFFSET) {
        records.push(
          Object.freeze({
            kind: 'literal' as const,
            offset: cursor,
            data: modified.slice(cursor, cursor + 1),
          }),
        );
        cursor += 1;
        continue;
      }
      // Detect an RLE-worthy run starting at `cursor`.
      const rleByte = modified[cursor]!;
      let rleEnd = cursor;
      while (
        rleEnd < emitEnd &&
        modified[rleEnd] === rleByte &&
        rleEnd - cursor < IPS_MAX_RLE_LENGTH
      ) {
        rleEnd++;
      }
      const rleLength = rleEnd - cursor;
      if (rleLength >= rleThreshold) {
        records.push(
          Object.freeze({
            kind: 'rle' as const,
            offset: cursor,
            rleLength,
            byte: rleByte,
          }),
        );
        cursor = rleEnd;
        continue;
      }
      // Else, emit a literal record up to the next RLE-worthy run OR
      // the end of the differing run OR IPS_MAX_LITERAL_LENGTH.
      let literalEnd = cursor;
      while (
        literalEnd < emitEnd &&
        literalEnd - cursor < IPS_MAX_LITERAL_LENGTH
      ) {
        // Stop if we hit a long enough run of identical bytes
        // (RLE candidate ahead - let the next loop iteration handle it).
        const nextByte = modified[literalEnd]!;
        let runFwd = literalEnd;
        while (
          runFwd < emitEnd &&
          modified[runFwd] === nextByte &&
          runFwd - literalEnd < rleThreshold
        ) {
          runFwd++;
        }
        if (runFwd - literalEnd >= rleThreshold) break;
        literalEnd++;
      }
      // Ensure the literal record doesn't include the reserved EOF
      // offset position INSIDE its span - split it if so.
      if (
        cursor < IPS_RESERVED_EOF_OFFSET &&
        literalEnd > IPS_RESERVED_EOF_OFFSET
      ) {
        literalEnd = IPS_RESERVED_EOF_OFFSET;
      }
      records.push(
        Object.freeze({
          kind: 'literal' as const,
          offset: cursor,
          data: modified.slice(cursor, literalEnd),
        }),
      );
      cursor = literalEnd;
    }
    i = runEnd;
  }
  return Object.freeze({
    records: Object.freeze(records),
    unrepresentableRanges: Object.freeze(unrepresentableRanges),
    unrepresentableBytes,
  });
}

/** Produce IPS records that transform `original` → `modified`.
 *
 *  Convenience wrapper over `produceIpsRecordsWithReport` for callers
 *  whose buffers are known to fit the IPS offset space. It returns the
 *  same records as before; it does not silently drop anything the
 *  report would have flagged, because bytes at or past IPS_MAX_OFFSET + 1
 *  were never emittable in the first place. Callers that need to know
 *  whether a diff was complete should use the reporting variant.
 */
export function produceIpsRecords(
  original: Uint8Array,
  modified: Uint8Array,
  opts?: ProduceIpsRecordsOptions,
): ReadonlyArray<IpsRecord> {
  return produceIpsRecordsWithReport(original, modified, opts).records;
}
