/**
 * IPS patch format - Phase 13 P13-T1.
 *
 * Per §15 Phase 13 acceptance:
 * > "every corpus ROM round-trips edit→patch→re-ingest with no
 * > destructive in-place mutation as the primary model; all listed
 * > export formats produce valid output."
 *
 * IPS (International Patching System) is the smallest, oldest patch
 * format - a flat byte stream of records targeting a 24-bit offset
 * space (max 0xFFFFFF = 16 MiB ROM). Format:
 *
 *   - 5 bytes ASCII header: "PATCH"
 *   - 0+ records, each:
 *       - 3-byte BE offset (0x000000..0xFFFFFE; 0x454F46 = "EOF"
 *         is reserved for the footer marker)
 *       - 2-byte BE length
 *       - If length > 0: `length` bytes of literal data
 *       - If length == 0: this is an RLE record:
 *           - 2-byte BE RLE length
 *           - 1 byte to repeat `rleLength` times at offset
 *   - 3-byte ASCII footer: "EOF"
 *
 * Edge cases / format quirks:
 *   - Max offset addressable: 0xFFFFFE (the value 0x454F46 = "EOF"
 *     cannot be used as an offset because the parser would treat
 *     it as the terminator).
 *   - Max literal record length: 0xFFFF (65535 bytes).
 *   - Max RLE expansion: 0xFFFF bytes of the same byte.
 *
 * PD 11: ROM editing is patch-first, never destructive in-place
 * mutation as the primary representation. This module is the
 * format-level substrate; the semantic diff producer (`./diff.ts`)
 * builds on it.
 */

/** IPS format header - must be exactly these 5 bytes at offset 0. */
export const IPS_HEADER = new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48]); // "PATCH"
/** IPS format footer - must be exactly these 3 bytes at end. */
export const IPS_FOOTER = new Uint8Array([0x45, 0x4f, 0x46]); // "EOF"
/** The 24-bit offset value matching the "EOF" footer; this offset
 *  CANNOT be used by a record per the format spec. */
export const IPS_RESERVED_EOF_OFFSET = 0x454f46;
/** Maximum offset addressable by a single IPS record. */
export const IPS_MAX_OFFSET = 0xfffffe;
/** Maximum length of a literal record's data field. */
export const IPS_MAX_LITERAL_LENGTH = 0xffff;
/** Maximum length of an RLE expansion. */
export const IPS_MAX_RLE_LENGTH = 0xffff;
/** Minimum RLE-worthy run length. A 4-byte run is the break-even
 *  point: literal cost = 3+2+N bytes; RLE cost = 3+2+2+1 = 8 bytes
 *  fixed, so RLE wins for N >= 8. We use 8 as the threshold. */
export const IPS_RLE_BREAK_EVEN_LENGTH = 8;

/** A typed IPS record. Discriminated on `kind`. */
export type IpsRecord =
  | { readonly kind: 'literal'; readonly offset: number; readonly data: Uint8Array }
  | {
      readonly kind: 'rle';
      readonly offset: number;
      readonly rleLength: number;
      readonly byte: number;
    };

export class IpsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpsFormatError';
  }
}

/** Encode a list of IpsRecords into a complete IPS patch byte stream
 *  (header + records + footer). */
export function encodeIps(records: ReadonlyArray<IpsRecord>): Uint8Array {
  let totalSize = IPS_HEADER.length + IPS_FOOTER.length;
  for (const r of records) {
    if (r.kind === 'literal') {
      totalSize += 3 + 2 + r.data.length;
    } else {
      totalSize += 3 + 2 + 2 + 1;
    }
  }
  const out = new Uint8Array(totalSize);
  let cursor = 0;
  out.set(IPS_HEADER, cursor);
  cursor += IPS_HEADER.length;
  for (const r of records) {
    if (r.offset > IPS_MAX_OFFSET) {
      throw new IpsFormatError(
        `record offset 0x${r.offset.toString(16)} exceeds IPS max 0x${IPS_MAX_OFFSET.toString(16)}`,
      );
    }
    if (r.offset === IPS_RESERVED_EOF_OFFSET) {
      throw new IpsFormatError(
        `record offset 0x454F46 is reserved (collides with EOF footer marker)`,
      );
    }
    // The offset field names where the record STARTS, so a record that
    // begins below the ceiling can still write byte positions the format
    // cannot address. `applyIps` happily grows the output to that end,
    // producing a ROM whose tail no IPS patcher could produce or check -
    // a silent truncation, not an error. Reject it here so the encoder
    // can never emit a patch that decodes to more than IPS can describe.
    const recordEnd = r.kind === 'literal' ? r.offset + r.data.length : r.offset + r.rleLength;
    if (recordEnd > IPS_MAX_OFFSET + 1) {
      throw new IpsFormatError(
        `record at offset 0x${r.offset.toString(16)} ends at 0x${(recordEnd - 1).toString(16)}, past the last addressable IPS byte 0x${IPS_MAX_OFFSET.toString(16)} (record payload ${String(r.kind === 'literal' ? r.data.length : r.rleLength)} byte(s)); use the BPS format for offsets above 0xFFFFFE`,
      );
    }
    out[cursor++] = (r.offset >>> 16) & 0xff;
    out[cursor++] = (r.offset >>> 8) & 0xff;
    out[cursor++] = r.offset & 0xff;
    if (r.kind === 'literal') {
      if (r.data.length === 0) {
        throw new IpsFormatError(`literal record at offset 0x${r.offset.toString(16)} has zero length`);
      }
      if (r.data.length > IPS_MAX_LITERAL_LENGTH) {
        throw new IpsFormatError(
          `literal record at offset 0x${r.offset.toString(16)} has length ${String(r.data.length)} > IPS max ${String(IPS_MAX_LITERAL_LENGTH)}`,
        );
      }
      out[cursor++] = (r.data.length >>> 8) & 0xff;
      out[cursor++] = r.data.length & 0xff;
      out.set(r.data, cursor);
      cursor += r.data.length;
    } else {
      if (r.rleLength === 0) {
        throw new IpsFormatError(`RLE record at offset 0x${r.offset.toString(16)} has zero length`);
      }
      if (r.rleLength > IPS_MAX_RLE_LENGTH) {
        throw new IpsFormatError(
          `RLE record at offset 0x${r.offset.toString(16)} has length ${String(r.rleLength)} > IPS max ${String(IPS_MAX_RLE_LENGTH)}`,
        );
      }
      if ((r.byte & ~0xff) !== 0) {
        throw new IpsFormatError(`RLE byte ${String(r.byte)} is not a u8`);
      }
      // Length=0 marker, then 2-byte RLE length, then 1 byte to repeat.
      out[cursor++] = 0x00;
      out[cursor++] = 0x00;
      out[cursor++] = (r.rleLength >>> 8) & 0xff;
      out[cursor++] = r.rleLength & 0xff;
      out[cursor++] = r.byte & 0xff;
    }
  }
  out.set(IPS_FOOTER, cursor);
  return out;
}

/** Decode an IPS patch byte stream into typed records. */
export function decodeIps(bytes: Uint8Array): ReadonlyArray<IpsRecord> {
  if (bytes.length < IPS_HEADER.length + IPS_FOOTER.length) {
    throw new IpsFormatError(`patch too short (${String(bytes.length)} bytes) to even contain header+footer`);
  }
  for (let i = 0; i < IPS_HEADER.length; i++) {
    if (bytes[i] !== IPS_HEADER[i]) {
      throw new IpsFormatError(`patch missing "PATCH" header at offset 0`);
    }
  }
  const records: IpsRecord[] = [];
  let cursor = IPS_HEADER.length;
  while (cursor < bytes.length) {
    if (cursor + 3 > bytes.length) {
      throw new IpsFormatError(`patch truncated reading offset at cursor ${String(cursor)}`);
    }
    const offset = ((bytes[cursor]! << 16) | (bytes[cursor + 1]! << 8) | bytes[cursor + 2]!) >>> 0;
    cursor += 3;
    if (offset === IPS_RESERVED_EOF_OFFSET) {
      // Treat as terminator. Anything after is ignored per the format.
      return Object.freeze(records);
    }
    if (cursor + 2 > bytes.length) {
      throw new IpsFormatError(`patch truncated reading length at cursor ${String(cursor)}`);
    }
    const length = ((bytes[cursor]! << 8) | bytes[cursor + 1]!) >>> 0;
    cursor += 2;
    if (length === 0) {
      // RLE record.
      if (cursor + 3 > bytes.length) {
        throw new IpsFormatError(`patch truncated reading RLE fields at cursor ${String(cursor)}`);
      }
      const rleLength = ((bytes[cursor]! << 8) | bytes[cursor + 1]!) >>> 0;
      cursor += 2;
      const byte = bytes[cursor]!;
      cursor += 1;
      records.push(
        Object.freeze({
          kind: 'rle' as const,
          offset,
          rleLength,
          byte,
        }),
      );
    } else {
      // Literal record.
      if (cursor + length > bytes.length) {
        throw new IpsFormatError(
          `patch truncated reading ${String(length)} literal bytes at cursor ${String(cursor)}`,
        );
      }
      const data = bytes.slice(cursor, cursor + length);
      cursor += length;
      records.push(
        Object.freeze({
          kind: 'literal' as const,
          offset,
          data,
        }),
      );
    }
  }
  throw new IpsFormatError(
    `patch ended without EOF footer (cursor reached end of buffer at ${String(cursor)})`,
  );
}

/** Apply an IPS patch (decoded records) to a base byte array,
 *  returning a NEW byte array (PD 11: non-destructive). The output
 *  is at least as large as the base; records past base.length grow
 *  the output (padding intermediate bytes with 0x00 per IPS
 *  convention for "expanding" patches). */
export function applyIps(
  base: Uint8Array,
  records: ReadonlyArray<IpsRecord>,
): Uint8Array {
  // Determine final size: max(base.length, max-record-end-offset).
  let maxEnd = base.length;
  for (const r of records) {
    const end = r.kind === 'literal' ? r.offset + r.data.length : r.offset + r.rleLength;
    if (end > maxEnd) maxEnd = end;
  }
  const out = new Uint8Array(maxEnd);
  out.set(base, 0);
  for (const r of records) {
    if (r.kind === 'literal') {
      out.set(r.data, r.offset);
    } else {
      for (let i = 0; i < r.rleLength; i++) {
        out[r.offset + i] = r.byte;
      }
    }
  }
  return out;
}
