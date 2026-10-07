/**
 * Smoke tests for propose_add_script_for_trainer - verify input-validation
 * branches and a happy-path bind that decodes back to a `trainerbattle`
 * step targeting the right trainerId.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest, ObjectEvent } from '@rom-editor/shared';
import { scripts as scriptsApi } from '@rom-introspection/engine';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeAddScriptForTrainer } from './propose-add-script-for-trainer.js';

function emptyManifest(objectEvents: ObjectEvent[] = []): ProjectManifest {
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
    objectEvents,
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
}

function objectEventWith(metadata: Record<string, string | number | boolean>): ObjectEvent {
  return {
    id: 'binary_obj_3_19_2',
    name: 'NPC 2',
    mapId: 'binary_map_3_19',
    coord: { x: 6, y: 31 },
    elevation: 3,
    kind: 'npc',
    graphicsId: 'gfx_5',
    movementType: 'movement_0',
    scriptId: null,
    flagId: null,
    trainerType: null,
    metadata,
  };
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

describe('proposeAddScriptForTrainer', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'propose-add-script-tr-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('reports a friendly error when no manifest is present', async () => {
    const result = await proposeAddScriptForTrainer(
      { projectRoot: root, baseUrl: 'http://x' },
      { objectEventId: 'binary_obj_3_19_2', trainerId: 7 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No manifest/);
  });

  it('reports a friendly error when the objectEvent id is unknown', async () => {
    await writeManifest(root, emptyManifest());
    const result = await proposeAddScriptForTrainer(
      { projectRoot: root, baseUrl: 'http://x' },
      { objectEventId: 'binary_obj_999', trainerId: 7 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/not in manifest\.objectEvents/);
  });

  it('binds an NPC to a trainer and the script decodes as trainerbattle', async () => {
    // Build a ROM with a 24-byte ObjectEvent template at 0x200.
    const buf = Buffer.alloc(0x10000, 0xff);
    const structOffset = 0x200;
    buf.fill(0, structOffset, structOffset + 24);
    buf[structOffset + 0x00] = 2; // localId
    buf[structOffset + 0x01] = 5; // graphicsId
    buf.writeInt16LE(6, structOffset + 0x04); // x
    buf.writeInt16LE(31, structOffset + 0x06); // y
    buf[structOffset + 0x08] = 3; // elevation
    // trainerType, sight, scriptPointer, flagId all zero (NULL/none).
    await fsp.writeFile(path.join(root, 'fake.gba'), buf);
    await writeManifest(
      root,
      emptyManifest([objectEventWith({
        source: 'BinaryRomScanner',
        binaryFileOffset: structOffset,
      })]),
    );

    const { fetchFn, captured } = fakeProposalFetch();
    const result = await proposeAddScriptForTrainer(
      { projectRoot: root, baseUrl: 'http://x' },
      { objectEventId: 'binary_obj_3_19_2', trainerId: 42 },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.trainerScriptOffset).not.toBeNull();
    expect(result.postBattleScriptOffset).not.toBeNull();

    // Three edits: post-battle stub, trainer-battle script, NPC fields slice.
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(3);

    // The synthesized trainerbattle command is byte-exact: type 3 is 10
    // bytes (opcode + type + trainerId + localId + defeat ptr) plus `end`.
    const tbEdit = (body!.edits as Array<{ kind: string; afterBytes?: string }>)[1]!;
    expect(tbEdit.afterBytes).toHaveLength(22); // 11 bytes

    // Apply the edits to a working copy + decode the synthesized script.
    const working = Buffer.from(buf);
    for (const e of body!.edits as Array<{
      kind: string;
      offset?: number;
      afterBytes?: string;
    }>) {
      if (e.kind === 'binary_write_bytes' && e.afterBytes !== undefined && e.offset !== undefined) {
        Buffer.from(e.afterBytes, 'hex').copy(working, e.offset);
      }
    }
    const decoded = scriptsApi.decodeBinaryScript(working, result.trainerScriptOffset!);
    // Byte-exact: exactly [start_battle, end] - the decoder lands cleanly
    // on `end`, with no stray steps from a mis-sized command.
    expect(decoded.steps.map((s) => s.kind)).toEqual(['start_battle', 'raw']);
    const first = decoded.steps[0]!;
    expect(first.kind).toBe('start_battle');
    expect(first.params['trainerId']).toBe(42);
    expect(decoded.steps[1]!.params['opcodeName']).toBe('end');
    expect(decoded.bytesConsumed).toBe(11);
  });
});
