import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectManifest, MapNode } from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import { proposeSetMapMetadata } from './propose-set-map-metadata.js';

function manifest(maps: MapNode[]): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-27T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps,
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
  };
}

/** Build a fake ROM with a valid 28-byte MapHeader at `headerOffset`. */
function makeFakeRom(headerOffset: number, totalSize = 0x10000): Buffer {
  const buf = Buffer.alloc(totalSize, 0xff);
  // Minimal valid MapHeader pointing layout at 0x100 (also in the buf).
  // Layout pointer @ +0x00 = 0x08000100
  buf[headerOffset + 0x00] = 0x00;
  buf[headerOffset + 0x01] = 0x01;
  buf[headerOffset + 0x02] = 0x00;
  buf[headerOffset + 0x03] = 0x08;
  // events / scripts / connections at +0x04..0x0F: NULL
  for (let i = 0x04; i < 0x10; i++) buf[headerOffset + i] = 0;
  // music u16 at 0x10
  buf[headerOffset + 0x10] = 0;
  buf[headerOffset + 0x11] = 0;
  // mapLayoutId u16 at 0x12
  buf[headerOffset + 0x12] = 0;
  buf[headerOffset + 0x13] = 0;
  // regionMapSection at 0x14
  buf[headerOffset + 0x14] = 0x58;
  // caveOrType / weather / mapType
  buf[headerOffset + 0x15] = 0;
  buf[headerOffset + 0x16] = 0;
  buf[headerOffset + 0x17] = 1; // Town
  // bikingAllowed @ 0x18, flags @ 0x19, floorNum @ 0x1A
  buf[headerOffset + 0x18] = 0;
  buf[headerOffset + 0x19] = 0;
  // floorNum + battleType
  buf[headerOffset + 0x1a] = 0;
  buf[headerOffset + 0x1b] = 0;
  return buf;
}

function fakeFetch(): {
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
        createdAtUtc: '2026-05-27T00:00:00.000Z',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

describe('proposeSetMapMetadata', () => {
  let root: string;
  const headerOffset = 0x1000;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'set-map-meta-'));
    await fsp.writeFile(path.join(root, 'test.gba'), makeFakeRom(headerOffset));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baseMap: MapNode = {
    id: 'binary_map_3_19',
    name: 'Route 1',
    group: 'route',
    dimensions: { width: 30, height: 20 },
    tilesetIds: [],
    warpIds: [],
    scriptIds: [],
    objectEventIds: [],
    encounterTableIds: [],
    musicId: null,
    metadata: { mapHeaderOffset: headerOffset },
  };

  it('rewrites music + weather in-place', async () => {
    await writeManifest(root, manifest([baseMap]));
    const { fetchFn, captured } = fakeFetch();
    const result = await proposeSetMapMetadata(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19', musicId: 0x100, weather: 5 },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.fieldsChanged).toEqual(['musicId', 'weather']);
    const body = captured();
    expect(body).not.toBeNull();
    expect(body!.edits).toHaveLength(1);
    const edit = body!.edits[0] as { offset: number; afterBytes: string };
    expect(edit.offset).toBe(headerOffset);
    // afterBytes hex string - musicId LE at byte 0x10 = 00 01; weather at 0x16 = 05
    expect(edit.afterBytes.substring(0x10 * 2, 0x12 * 2)).toBe('0001');
    expect(edit.afterBytes.substring(0x16 * 2, 0x17 * 2)).toBe('05');
  });

  it('writes flags to 0x19 (the map-flags byte), not 0x1A (floorNum)', async () => {
    await writeManifest(root, manifest([baseMap]));
    const { fetchFn, captured } = fakeFetch();
    const result = await proposeSetMapMetadata(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19', bikingAllowed: true, flags: 0x03, floorNum: -1 },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.fieldsChanged).toEqual(['bikingAllowed', 'flags', 'floorNum']);
    const edit = captured()!.edits[0] as { afterBytes: string };
    expect(edit.afterBytes.substring(0x18 * 2, 0x19 * 2)).toBe('01'); // bikingAllowed
    expect(edit.afterBytes.substring(0x19 * 2, 0x1a * 2)).toBe('03'); // flags (was wrongly 0x1A)
    expect(edit.afterBytes.substring(0x1a * 2, 0x1b * 2)).toBe('ff'); // floorNum -1
  });

  it('rejects missing mapHeaderOffset', async () => {
    const noMeta: MapNode = { ...baseMap, metadata: {} };
    await writeManifest(root, manifest([noMeta]));
    const result = await proposeSetMapMetadata(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19', musicId: 0x100 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/missing mapHeaderOffset/);
  });

  it('rejects unknown mapId', async () => {
    await writeManifest(root, manifest([baseMap]));
    const result = await proposeSetMapMetadata(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_99_99', musicId: 0x100 },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/not found/);
  });

  it('returns no-op when no fields specified', async () => {
    await writeManifest(root, manifest([baseMap]));
    const result = await proposeSetMapMetadata(
      { projectRoot: root, baseUrl: 'http://x' },
      { mapId: 'binary_map_3_19' },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No fields specified/);
  });
});
