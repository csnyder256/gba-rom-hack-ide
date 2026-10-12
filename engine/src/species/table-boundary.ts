/**
 * Shared structural helper for the Phase-8 species sub-table scanners
 * (gBaseStats, gEvolutionTable, gLevelUpLearnsets, gTMHMLearnsets).
 *
 * Every one of those tables can be preceded by arbitrary zero alignment
 * padding in the ROM. When a scanner has to decide whether a candidate
 * offset is the TRUE first byte of a table - rather than the start of an
 * incidental zero-fill run - it looks at the 16 bytes immediately before
 * the candidate. A real table boundary has at least one non-zero byte
 * there (the preceding ROM data: another table, a pointer, code, the
 * cartridge header). If all 16 bytes are zero, the zero region extends
 * further back, so the candidate is incidental padding rather than the
 * table's true start.
 *
 * `offset <= 0` counts as a real boundary: a table may legitimately begin
 * at file offset 0 in synthetic fixtures / tiny test ROMs.
 */
export function isRealTableBoundary(bytes: Uint8Array, offset: number): boolean {
  if (offset <= 0) return true;
  const checkStart = Math.max(0, offset - 16);
  for (let i = checkStart; i < offset; i++) {
    if (bytes[i] !== 0) return true;
  }
  return false;
}
