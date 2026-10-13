import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { BattleMoveEntry, ProjectManifest } from '@rom-editor/shared';
import { moves as movesApi } from '@rom-introspection/engine';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeMoveEdit, proposeMoveEditInputShape } from './propose-move-edit.js';

/** The documented Gen-3 move structure is 12 bytes: nine one-byte fields
 *  followed by THREE bytes of struct padding (offset 0x09..0x0B) that the
 *  format requires to be 0x00. `flags` is the ninth field - a single byte
 *  at 0x08 - not a u32. */
const MOVE_STRUCT_SIZE = 12;
const TABLE_OFFSET = 0x400;
const MOVE_INDEX = 2;
const ENTRY_OFFSET = TABLE_OFFSET + MOVE_INDEX * MOVE_STRUCT_SIZE; // 0x418
const PADDING_OFFSETS = [0x09, 0x0a, 0x0b] as const;

function manifest(battleMoves: BattleMoveEntry[]): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-25T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake binary rom',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
    battleMoves,
  };
}

function makeMove(over: Partial<BattleMoveEntry> = {}): BattleMoveEntry {
  return {
    id: 'binary_move_2',
    moveIndex: MOVE_INDEX,
    effect: 0x0a,
    power: 40,
    type: 0,
    accuracy: 100,
    pp: 35,
    secondaryEffectChance: 0,
    target: 0,
    priority: 0,
    flags: 0,
    split: 0,
    sourceTableOffset: TABLE_OFFSET,
    ...over,
  };
}

/** ROM with one 12-byte BattleMove at ENTRY_OFFSET and a zero padding tail. */
function buildFakeRom(): Buffer {
  const buf = Buffer.alloc(0x1000, 0xff);
  buf[ENTRY_OFFSET + 0x00] = 0x0a; // effect
  buf[ENTRY_OFFSET + 0x01] = 40; // power
  buf[ENTRY_OFFSET + 0x02] = 0; // type
  buf[ENTRY_OFFSET + 0x03] = 100; // accuracy
  buf[ENTRY_OFFSET + 0x04] = 35; // pp
  buf[ENTRY_OFFSET + 0x05] = 0; // secondaryEffectChance
  buf[ENTRY_OFFSET + 0x06] = 0; // target
  buf[ENTRY_OFFSET + 0x07] = 0; // priority
  buf[ENTRY_OFFSET + 0x08] = 0x00; // flags (one byte)
  buf[ENTRY_OFFSET + 0x09] = 0x00; // padding
  buf[ENTRY_OFFSET + 0x0a] = 0x00; // padding
  buf[ENTRY_OFFSET + 0x0b] = 0x00; // padding
  return buf;
}

function fakeProposalFetch(): {
  fetchFn: typeof fetch;
  captured: () => { description: string; edits: unknown[] } | null;
} {
  let body: { description: string; edits: unknown[] } | null = null;
  const fetchFn = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body) as { description: string; edits: unknown[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'patch_fake',
        projectId: 'p',
        description: body!.description,
        edits: body!.edits,
        status: 'pending',
        createdAtUtc: '2026-05-25T00:00:00.000Z',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('proposeMoveEdit - flags is a one-byte field at 0x08', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-move-edit-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function seed(over: Partial<BattleMoveEntry> = {}): Promise<void> {
    await writeManifest(root, manifest([makeMove(over)]));
    await fsp.writeFile(path.join(root, 'test.gba'), buildFakeRom());
  }

  it('writes flags as exactly one byte and leaves the 0x09..0x0B padding alone', async () => {
    await seed();
    const result = await proposeMoveEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { moveIndex: MOVE_INDEX, fields: { flags: 0x33 } },
      { fetchFn: fakeProposalFetch().fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.changedFields).toEqual(['flags']);
    const body = result.proposal!.edits[0] as unknown as {
      kind: string;
      offset: number;
      beforeBytes: string;
      afterBytes: string;
    };
    expect(body.kind).toBe('binary_write_bytes');
    expect(body.offset).toBe(ENTRY_OFFSET);
    expect(body.beforeBytes).toBe('0a2800642300000000000000');
    // Byte 0x08 becomes 0x33; 0x09/0x0A/0x0B stay 0x00.
    expect(body.afterBytes).toBe('0a2800642300000033000000');
  });

  it('keeps the documented padding at 0x09..0x0B across a multi-field edit', async () => {
    await seed();
    const result = await proposeMoveEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { moveIndex: MOVE_INDEX, fields: { power: 80, accuracy: 100, flags: 0x33 } },
      { fetchFn: fakeProposalFetch().fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    const edit = result.proposal!.edits[0] as unknown as { afterBytes: string };
    const after = hexToBytes(edit.afterBytes);
    expect(after[0x01]).toBe(80);
    expect(after[0x08]).toBe(0x33);
    for (const off of PADDING_OFFSETS) expect(after[off]).toBe(0x00);
  });

  it('the edited struct still satisfies the engine move-struct parser', async () => {
    await seed();
    const result = await proposeMoveEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { moveIndex: MOVE_INDEX, fields: { flags: 0x33 } },
      { fetchFn: fakeProposalFetch().fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    const edit = result.proposal!.edits[0] as unknown as { afterBytes: string };
    const parsed = movesApi.parseBattleMove(hexToBytes(edit.afterBytes), 0);
    // The engine rejects any entry whose padding bytes are non-zero; a
    // writer that spilled flags into 0x09..0x0B would make this fail.
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.move.flags).toBe(0x33);
  });

  it('rejects a flags value that cannot fit the one-byte field', async () => {
    await seed();
    const result = await proposeMoveEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { moveIndex: MOVE_INDEX, fields: { flags: 0x0100 } },
      { fetchFn: fakeProposalFetch().fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.changedFields).toEqual([]);
    expect(result.message).toMatch(/flags must be a u8 in \[0, 255\]/);
  });

  it('rejects a 32-bit flags value instead of writing 4 bytes over the padding', async () => {
    await seed();
    const result = await proposeMoveEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { moveIndex: MOVE_INDEX, fields: { flags: 0x0001_0000 } },
      { fetchFn: fakeProposalFetch().fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/flags must be a u8 in \[0, 255\]/);
  });

  it('caps flags at one byte in the agent-facing input schema', () => {
    const schema = z.object(proposeMoveEditInputShape);
    expect(schema.safeParse({ moveIndex: MOVE_INDEX, fields: { flags: 0xff } }).success).toBe(true);
    expect(schema.safeParse({ moveIndex: MOVE_INDEX, fields: { flags: 0x100 } }).success).toBe(false);
    expect(
      schema.safeParse({ moveIndex: MOVE_INDEX, fields: { flags: 0x0001_0000 } }).success,
    ).toBe(false);
  });

  it('no-ops when the requested flags already match the ROM', async () => {
    await seed();
    const result = await proposeMoveEdit(
      { projectRoot: root, baseUrl: 'http://127.0.0.1:8717' },
      { moveIndex: MOVE_INDEX, fields: { flags: 0x00 } },
      { fetchFn: fakeProposalFetch().fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/already match/);
  });

  it('shows why the padding matters: the engine drops an entry whose padding is non-zero', () => {
    // This is what the old u32 write produced for flags = 0x00010000: byte
    // 0x0A (padding) became 0x01. The engine's move-struct parser rejects
    // such an entry, which truncates the detected move table.
    const corruptedByU32Flags = Uint8Array.of(
      0x0a, 0x28, 0x00, 0x64, 0x23, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00,
    );
    expect(movesApi.parseBattleMove(corruptedByU32Flags, 0).ok).toBe(false);
    // The one-byte write the tool now performs keeps every padding byte 0.
    const afterOneByteWrite = Uint8Array.of(
      0x0a, 0x28, 0x00, 0x64, 0x23, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    );
    expect(movesApi.parseBattleMove(afterOneByteWrite, 0).ok).toBe(true);
  });
});
