import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import {
  PARTY_FLAG_CUSTOM_MOVESET,
  TRAINER_NAME_TERMINATOR,
  TRAINER_STRUCT_SIZE_BYTES as REC,
} from '../trainers/index.js';
import { TRAINER_PARTIES_SYSTEM_DETECTOR_ID, trainerPartiesSystemDetector } from './trainer-parties-system.js';

const GBA_ROM_BASE = 0x08000000;

/** Plant a minimal valid Trainer record. */
function plantTrainer(
  buf: Uint8Array,
  at: number,
  opts: { trainerClass: number; partySize: number; partyPointer: number; name: string },
): void {
  buf[at + 0x00] = 0; // partyFlags (set separately when needed)
  buf[at + 0x01] = opts.trainerClass;
  buf[at + 0x02] = 5; // encounterMusic
  buf[at + 0x03] = 0; // trainerPic
  for (let k = 0; k < 12; k++) {
    if (k < opts.name.length) buf[at + 0x04 + k] = opts.name.charCodeAt(k);
    else if (k === opts.name.length) buf[at + 0x04 + k] = TRAINER_NAME_TERMINATOR;
    else buf[at + 0x04 + k] = 0;
  }
  for (let k = 0; k < 8; k++) buf[at + 0x10 + k] = 0; // items[4]
  buf[at + 0x18] = 0; // doubleBattle
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(at + 0x1c, 1, true); // aiFlags
  buf[at + 0x20] = opts.partySize;
  view.setUint32(at + 0x24, opts.partyPointer >>> 0, true);
}

/** flags-0 member (6 bytes): iv u16 @0x00, lvl u8 @0x02, pad, species u16 @0x04. */
function plantDefaultMember(buf: Uint8Array, at: number, iv: number, lvl: number, species: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint16(at + 0x00, iv, true);
  view.setUint8(at + 0x02, lvl);
  view.setUint8(at + 0x03, 0);
  view.setUint16(at + 0x04, species, true);
}

describe('trainerPartiesSystemDetector', () => {
  it('parses a real 6-byte-stride flags-0 party (all members, not just the first)', () => {
    const bytes = new Uint8Array(64 * 1024);
    const tableAt = 0x200;
    const partyOff = 0x400;
    // 8 records so the table clears the scanner's default minimum. Only
    // trainer 0 carries a real party pointer; the rest have NULL parties.
    for (let i = 0; i < 8; i++) {
      plantTrainer(bytes, tableAt + i * REC, {
        trainerClass: i + 1,
        partySize: 3,
        partyPointer: i === 0 ? GBA_ROM_BASE + partyOff : 0,
        name: `T${String(i)}`,
      });
    }
    // Real-layout party: 3 members packed 6 bytes apart.
    plantDefaultMember(bytes, partyOff + 0, 31, 11, 19); // Rattata lvl 11
    plantDefaultMember(bytes, partyOff + 6, 0, 11, 23); // Ekans lvl 11
    plantDefaultMember(bytes, partyOff + 12, 0, 15, 25); // Pikachu lvl 15

    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://trainers-party', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = trainerPartiesSystemDetector.detect(rom, cov);

    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.trainerTableStart).toBe(tableAt);
      expect(r.data.parties.length).toBe(1);
      const party = r.data.parties[0]!;
      expect(party.declaredPartySize).toBe(3);
      expect(party.arrayFileOffset).toBe(partyOff);
      expect(party.members.map((m) => m.level)).toEqual([11, 11, 15]);
      expect(party.members.map((m) => m.species)).toEqual([19, 23, 25]);
      // Per-member offsets advance by the real 6-byte stride so the editor
      // patches the right struct.
      expect(party.members.map((m) => m.fileOffset)).toEqual([partyOff, partyOff + 6, partyOff + 12]);
    }
  });

  it('parses a flags-1 (custom moves, no item) party with moves at +0x06', () => {
    const bytes = new Uint8Array(64 * 1024);
    const tableAt = 0x200;
    const partyOff = 0x800;
    for (let i = 0; i < 8; i++) {
      plantTrainer(bytes, tableAt + i * REC, {
        trainerClass: i + 1,
        partySize: 1,
        partyPointer: i === 0 ? GBA_ROM_BASE + partyOff : 0,
        name: `T${String(i)}`,
      });
    }
    // Trainer 0 uses the custom-moveset flag; flip bit 0 of its partyFlags.
    bytes[tableAt + 0x00] = PARTY_FLAG_CUSTOM_MOVESET;
    // 14-byte member: shared head + moves at +0x06.
    plantDefaultMember(bytes, partyOff + 0, 15, 30, 9);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i++) view.setUint16(partyOff + 0x06 + i * 2, [33, 55, 89, 22][i]!, true);

    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://trainers-party-moves', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = trainerPartiesSystemDetector.detect(rom, cov);

    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      const party = r.data.parties[0]!;
      expect(party.partyFlags).toBe(PARTY_FLAG_CUSTOM_MOVESET);
      expect(party.members[0]?.species).toBe(9);
      expect(party.members[0]?.level).toBe(30);
      expect(party.members[0]?.moves).toEqual([33, 55, 89, 22]);
    }
  });

  it('exposes the detector contract', () => {
    expect(trainerPartiesSystemDetector.id).toBe(TRAINER_PARTIES_SYSTEM_DETECTOR_ID);
    expect(trainerPartiesSystemDetector.phase).toBe(9);
  });
});
