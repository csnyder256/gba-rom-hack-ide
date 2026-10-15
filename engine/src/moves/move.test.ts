import { describe, expect, it } from 'vitest';
import {
  BATTLE_MOVE_STRUCT_SIZE_BYTES,
  MOVE_SPLIT_PHYSICAL,
  MOVE_SPLIT_SPECIAL,
  MOVE_SPLIT_STATUS,
  parseBattleMove,
} from './move.js';

/** Build a 12-byte BattleMove struct as a Uint8Array. */
function buildMoveBytes(opts: {
  effect?: number;
  power?: number;
  type?: number;
  accuracy?: number;
  pp?: number;
  secondaryEffectChance?: number;
  target?: number;
  priority?: number;
  flags?: number;
  /** First of the three mandatory zero padding bytes at 0x09..0x0B. */
  pad0?: number;
  padA?: number;
  padB?: number;
}): Uint8Array {
  const b = new Uint8Array(BATTLE_MOVE_STRUCT_SIZE_BYTES);
  b[0] = opts.effect ?? 0;
  b[1] = opts.power ?? 0;
  b[2] = opts.type ?? 0;
  b[3] = opts.accuracy ?? 0;
  b[4] = opts.pp ?? 0;
  b[5] = opts.secondaryEffectChance ?? 0;
  b[6] = opts.target ?? 0;
  // priority is signed i8; convert to unsigned byte representation.
  b[7] = (opts.priority ?? 0) & 0xff;
  b[8] = opts.flags ?? 0;
  b[9] = opts.pad0 ?? 0; // padding byte 0x09 (NOT a damage-class byte)
  b[10] = opts.padA ?? 0;
  b[11] = opts.padB ?? 0;
  return b;
}

describe('parseBattleMove - happy paths', () => {
  it('parses Tackle-shaped move (power=35, type=Normal, accuracy=95, PP=35)', () => {
    const bytes = buildMoveBytes({
      effect: 0,
      power: 35,
      type: 0,
      accuracy: 95,
      pp: 35,
      priority: 0,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.move.power).toBe(35);
      expect(r.move.type).toBe(0);
      expect(r.move.accuracy).toBe(95);
      expect(r.move.pp).toBe(35);
      expect(r.move.priority).toBe(0);
      expect(r.isEmptySentinel).toBe(false);
    }
  });

  it('parses Quick Attack (priority +1, type Normal, accuracy 100)', () => {
    const bytes = buildMoveBytes({
      power: 40,
      type: 0,
      accuracy: 100,
      pp: 30,
      priority: 1,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.move.priority).toBe(1);
  });

  it('parses Trick (priority -7, type Psychic=14)', () => {
    const bytes = buildMoveBytes({
      power: 0,
      type: 14,
      accuracy: 100,
      pp: 10,
      priority: -7,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.move.priority).toBe(-7);
      expect(r.move.type).toBe(14);
    }
  });

  it('accepts MOVE_NONE all-zero sentinel as valid (isEmptySentinel=true)', () => {
    const bytes = new Uint8Array(12);
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.isEmptySentinel).toBe(true);
  });
});

describe('parseBattleMove - Gen-3 damage class is derived, never read from ROM', () => {
  it('classifies a Normal-type damaging move as Physical (1)', () => {
    // Tackle: Normal (type 0), 40 power.
    const r = parseBattleMove(
      buildMoveBytes({ power: 40, type: 0, accuracy: 100, pp: 35 }),
      0,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.move.split).toBe(MOVE_SPLIT_PHYSICAL);
  });

  it('classifies an Electric-type damaging move as Special (2)', () => {
    // Thunder: Electric (type 13), 110 power.
    const r = parseBattleMove(
      buildMoveBytes({ power: 110, type: 13, accuracy: 70, pp: 10 }),
      0,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.move.split).toBe(MOVE_SPLIT_SPECIAL);
  });

  it('classifies a 0-power move as Status (0) regardless of type', () => {
    // Thunder Wave: Electric type but 0 power.
    const r = parseBattleMove(
      buildMoveBytes({ power: 0, type: 13, accuracy: 100, pp: 20 }),
      0,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.move.split).toBe(MOVE_SPLIT_STATUS);
  });
});

describe('parseBattleMove - failure modes', () => {
  it('rejects too_short when offset + 12 > buffer length', () => {
    const bytes = new Uint8Array(8);
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('rejects type > 17', () => {
    const bytes = buildMoveBytes({ type: 18, accuracy: 100, pp: 10 });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('type_out_of_range');
  });

  it('rejects accuracy > 100', () => {
    const bytes = buildMoveBytes({ type: 0, accuracy: 200, pp: 10 });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('accuracy_out_of_range');
  });

  it('rejects effect chance > 100', () => {
    const bytes = buildMoveBytes({
      type: 0,
      accuracy: 100,
      pp: 10,
      secondaryEffectChance: 150,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('effect_chance_out_of_range');
  });

  it('rejects pp out of [1, 40]', () => {
    const bytes = buildMoveBytes({ type: 0, accuracy: 100, pp: 50 });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('pp_out_of_range');
  });

  it('rejects priority out of [-7, +5]', () => {
    const bytes = buildMoveBytes({
      type: 0,
      accuracy: 100,
      pp: 10,
      priority: 10,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('priority_out_of_range');
  });

  it('rejects power > 250', () => {
    const bytes = buildMoveBytes({
      type: 0,
      accuracy: 100,
      pp: 10,
      power: 251,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('power_out_of_range');
  });

  it('rejects nonzero padding byte 9 (0x09 is padding, not a damage class)', () => {
    const bytes = buildMoveBytes({
      type: 0,
      accuracy: 100,
      pp: 10,
      pad0: 1,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('padding_nonzero');
      if (r.failure.kind === 'padding_nonzero') {
        expect(r.failure.paddingOffset).toBe(9);
        expect(r.failure.observedByte).toBe(1);
      }
    }
  });

  it('rejects nonzero padding byte 10 (three-byte zero-padding signal)', () => {
    const bytes = buildMoveBytes({
      type: 0,
      accuracy: 100,
      pp: 10,
      padA: 0xff,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('padding_nonzero');
      if (r.failure.kind === 'padding_nonzero') {
        expect(r.failure.paddingOffset).toBe(10);
        expect(r.failure.observedByte).toBe(0xff);
      }
    }
  });

  it('rejects nonzero padding byte 11', () => {
    const bytes = buildMoveBytes({
      type: 0,
      accuracy: 100,
      pp: 10,
      padB: 0x42,
    });
    const r = parseBattleMove(bytes, 0);
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'padding_nonzero') {
      expect(r.failure.paddingOffset).toBe(11);
    }
  });
});
