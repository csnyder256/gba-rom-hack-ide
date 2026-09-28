import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import { TRAINER_CLASS_NAME_SLOT_BYTES } from '../trainers/trainer-class-names.js';
import {
  TRAINER_CLASS_NAMES_DETECTOR_ID,
  trainerClassNamesDetector,
} from './trainer-class-names-system.js';

const VANILLA_FRLG_CLASSES = [
  'YOUNGSTER',
  'BUG CATCHER',
  'HIKER',
  'CAMPER',
  'PICNICKER',
  'ENGINEER',
  'TAMER',
  'FISHERMAN',
  'CYCLIST',
  'CYCLIST',
  'GENTLEMAN',
  'TEACHER',
  'PSYCHIC',
  'BIRD KEEPER',
  'CHANNELER',
  'BLACK BELT',
  'JUGGLER',
  'TUBER',
  'BOSS',
  'SAGE',
  'GAMBLER',
  'BURGLAR',
  'SUPER NERD',
  'SCIENTIST',
  'SAILOR',
  'ROCKER',
  'TRIATHLETE',
  'PAINTER',
  'BIKER',
  'BEAUTY',
];

function plantClassNamesTable(buf: Uint8Array, offset: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const slotStart = offset + i * TRAINER_CLASS_NAME_SLOT_BYTES;
    const name = VANILLA_FRLG_CLASSES[i] ?? `CLASS${String(i).padStart(2, '0')}`;
    const encoded = encodeString(name);
    const slot = new Uint8Array(TRAINER_CLASS_NAME_SLOT_BYTES);
    slot.set(encoded.subarray(0, Math.min(encoded.length, TRAINER_CLASS_NAME_SLOT_BYTES - 1)), 0);
    const termPos = Math.min(encoded.length, TRAINER_CLASS_NAME_SLOT_BYTES - 1);
    slot[termPos] = STRING_TERMINATOR;
    buf.set(slot, slotStart);
  }
}

function fillNonClassBytes(buf: Uint8Array, fromOffset: number): void {
  for (let i = fromOffset; i < buf.length; i++) {
    buf[i] = 100 + ((i * 13) % 50);
  }
}

describe('trainerClassNamesDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(trainerClassNamesDetector.id).toBe(TRAINER_CLASS_NAMES_DETECTOR_ID);
    expect(typeof trainerClassNamesDetector.name).toBe('string');
    expect(trainerClassNamesDetector.phase).toBe(8);
    expect(typeof trainerClassNamesDetector.detect).toBe('function');
  });

  it('returns not_detected when no anchor matches', () => {
    const bytes = new Uint8Array(8 * 1024);
    bytes[0xb2] = 0x96;
    fillNonClassBytes(bytes, 0xc0);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-classes', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = trainerClassNamesDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('No Gen-3 gTrainerClassNames');
    }
  });

  it('detects a planted vanilla 40-class FRLG-shaped table + registers coverage', () => {
    const bytes = new Uint8Array(8 * 1024);
    bytes[0xb2] = 0x96;
    fillNonClassBytes(bytes, 0xc0);
    plantClassNamesTable(bytes, 0x400, 40);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://classes', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = trainerClassNamesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.validClassCount).toBeGreaterThanOrEqual(30);
      expect(r.data.tableOffset).toBe(0x400);
      expect(r.data.sampleNames[0]).toBe('YOUNGSTER');
      expect(r.data.sampleNames[1]).toBe('BUG CATCHER');
      expect(r.data.sampleNames[2]).toBe('HIKER');
    }
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(TRAINER_CLASS_NAMES_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.start).toBe(0x400);
  });

  it('reports the real class names for a 12-byte-stride table it accepts', () => {
    // The detector is the user-visible surface: its sampleNames are what
    // the workspace shows. Accepting a 12-byte table and then reading it
    // at 13 bytes yields merged neighbours, so the promise "we detected
    // your table" has to come with names that are actually the classes.
    const bytes = new Uint8Array(8 * 1024);
    bytes[0xb2] = 0x96;
    fillNonClassBytes(bytes, 0xc0);
    // Space-padded to exactly 11 bytes so the 0xFF lands on each slot's
    // last byte. Short names leave filler that decodes as `????` after
    // the terminator; letter-padding would manufacture a false anchor
    // from the repeated tail.
    const names = Array.from({ length: 40 }, (_, i) =>
      `CLASS${String(i).padStart(2, '0')}`.slice(0, 11).padEnd(11, ' '),
    );
    for (let i = 0; i < names.length; i++) {
      const name = encodeString(names[i]!);
      const start = 0x400 + i * 12;
      bytes.set(name.subarray(0, 11), start);
      bytes[start + 11] = STRING_TERMINATOR;
    }
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://classes-12', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = trainerClassNamesDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableOffset).toBe(0x400);
      expect(r.data.sampleNames[0]).toBe('CLASS00    ');
      expect(r.data.sampleNames[1]).toBe('CLASS01    ');
      expect(r.data.sampleNames[2]).toBe('CLASS02    ');
      expect(r.data.validClassCount).toBeGreaterThanOrEqual(30);
    }
  });

  it('result.data is frozen', () => {
    const bytes = new Uint8Array(8 * 1024);
    bytes[0xb2] = 0x96;
    fillNonClassBytes(bytes, 0xc0);
    plantClassNamesTable(bytes, 0x400, 40);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = trainerClassNamesDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.sampleNames)).toBe(true);
    }
  });
});
