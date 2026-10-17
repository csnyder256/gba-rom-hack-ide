import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AgentPatchEdit,
  ProjectManifest,
  SpeciesEntry,
  SpeciesEvolutionEntry,
  SpeciesEvolutionSlot,
} from '@rom-editor/shared';
import { writeManifest } from '../../scan/manifest-io.js';
import { importSpeciesFromLibrary } from './import-species-from-library.js';

const SPECIES_STRUCT_SIZE = 28;
const EVOLUTION_BLOCK_SIZE = 30;

/** Tiny manifest builder that pins species[] + speciesEvolutions[]
 *  to specific offsets so we can drive the importer through every
 *  branch (matching slot / missing slot / out-of-range / identical). */
function buildManifest(
  projectRoot: string,
  displayName: string,
  speciesAt: ReadonlyArray<{ speciesIndex: number; sourceFileOffset: number }>,
  evolutionsAt: ReadonlyArray<{ speciesIndex: number; sourceFileOffset: number }> = [],
): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-22T00:00:00.000Z',
    projectRoot,
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName,
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
    species: speciesAt.map((s) => makeSpeciesEntry(s.speciesIndex, s.sourceFileOffset)),
    speciesEvolutions: evolutionsAt.map((e) => makeEvolutionEntry(e.speciesIndex, e.sourceFileOffset)),
  };
}

function makeSpeciesEntry(speciesIndex: number, sourceFileOffset: number): SpeciesEntry {
  // The importer only reads `.speciesIndex` and `.sourceFileOffset` - 
  // every other field gets dummy zero values just to satisfy the
  // (non-Partial) interface.
  return {
    id: `binary_species_data_${speciesIndex}`,
    speciesIndex,
    baseHP: 0,
    baseAttack: 0,
    baseDefense: 0,
    baseSpeed: 0,
    baseSpAttack: 0,
    baseSpDefense: 0,
    type1: 0,
    type2: 0,
    catchRate: 0,
    expYield: 0,
    item1: 0,
    item2: 0,
    genderRatio: 0,
    eggCycles: 0,
    friendship: 0,
    growthRate: 0,
    eggGroup1: 0,
    eggGroup2: 0,
    ability1: 0,
    ability2: 0,
    safariZoneFleeRate: 0,
    sourceFileOffset,
  };
}

function makeEvolutionEntry(speciesIndex: number, sourceFileOffset: number): SpeciesEvolutionEntry {
  const slots: SpeciesEvolutionSlot[] = [];
  return {
    id: `binary_species_evo_${speciesIndex}`,
    speciesIndex,
    slots,
    sourceFileOffset,
  };
}

/** Build a fake .gba buffer with specific byte patterns at specific
 *  offsets so the importer's "copy 28 bytes from src to tgt" produces
 *  edits we can assert against. Fill is 0xFF (free space). */
function buildRom(
  blocks: Array<{ offset: number; bytes: number[] }>,
  size = 0x4000,
  fill = 0xff,
): Buffer {
  const buf = Buffer.alloc(size, fill);
  for (const { offset, bytes } of blocks) {
    for (let i = 0; i < bytes.length; i++) buf[offset + i] = bytes[i]!;
  }
  return buf;
}

/** Fill a 28-byte species struct with a recognizable pattern keyed on
 *  speciesIndex, so the importer can distinguish "source slot N's bytes"
 *  from "target slot N's bytes". */
function speciesStruct(speciesIndex: number, marker: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < SPECIES_STRUCT_SIZE; i++) {
    out.push((speciesIndex + marker + i) & 0xff);
  }
  return out;
}

function evolutionBlock(speciesIndex: number, marker: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < EVOLUTION_BLOCK_SIZE; i++) {
    out.push((speciesIndex * 2 + marker + i) & 0xff);
  }
  return out;
}

function fakeProposalFetch() {
  let body: { description: string; edits: AgentPatchEdit[] } | null = null;
  const fetchFn = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body) as { description: string; edits: AgentPatchEdit[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'patch_import',
        projectId: 'p',
        description: body!.description,
        edits: body!.edits,
        status: 'pending',
        createdAtUtc: '2026-05-22T00:00:00.000Z',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchFn, captured: () => body };
}

describe('importSpeciesFromLibrary', () => {
  let sourceRoot: string;
  let targetRoot: string;

  beforeEach(async () => {
    sourceRoot = await fsp.mkdtemp(path.join(tmpdir(), 'import-src-'));
    targetRoot = await fsp.mkdtemp(path.join(tmpdir(), 'import-tgt-'));
  });
  afterEach(async () => {
    await fsp.rm(sourceRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });

  async function seedSource(
    speciesAt: ReadonlyArray<{ speciesIndex: number; sourceFileOffset: number }>,
    romBlocks: Array<{ offset: number; bytes: number[] }>,
    evolutionsAt: ReadonlyArray<{ speciesIndex: number; sourceFileOffset: number }> = [],
  ): Promise<void> {
    await writeManifest(sourceRoot, buildManifest(sourceRoot, 'Source Game', speciesAt, evolutionsAt));
    await fsp.writeFile(path.join(sourceRoot, 'rom.gba'), buildRom(romBlocks));
  }
  async function seedTarget(
    speciesAt: ReadonlyArray<{ speciesIndex: number; sourceFileOffset: number }>,
    romBlocks: Array<{ offset: number; bytes: number[] }>,
    evolutionsAt: ReadonlyArray<{ speciesIndex: number; sourceFileOffset: number }> = [],
  ): Promise<void> {
    await writeManifest(targetRoot, buildManifest(targetRoot, 'Target Game', speciesAt, evolutionsAt));
    await fsp.writeFile(path.join(targetRoot, 'rom.gba'), buildRom(romBlocks));
  }

  it('returns missing-source when no source manifest exists', async () => {
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }],
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1] },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/No manifest at/);
  });

  it('returns missing-source-rom when source manifest exists but no .gba', async () => {
    // Source: manifest only, no .gba
    await writeManifest(sourceRoot, buildManifest(sourceRoot, 'src', [{ speciesIndex: 1, sourceFileOffset: 0x100 }]));
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }],
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1] },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.sourceDisplayName).toBe('src');
    expect(result.message).toMatch(/No .gba at/);
  });

  it('returns missing-target when target manifest is absent', async () => {
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 100) }],
    );
    // Target has a .gba but no manifest
    await fsp.writeFile(path.join(targetRoot, 'rom.gba'), buildRom([]));
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1] },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/Open \+ scan the current project first/);
  });

  it('builds a single-species edit when source and target both have the slot', async () => {
    const SRC_OFF = 0x100;
    const TGT_OFF = 0x300;
    await seedSource(
      [{ speciesIndex: 7, sourceFileOffset: SRC_OFF }],
      [{ offset: SRC_OFF, bytes: speciesStruct(7, 200) }],
    );
    await seedTarget(
      [{ speciesIndex: 7, sourceFileOffset: TGT_OFF }],
      [{ offset: TGT_OFF, bytes: speciesStruct(7, 0) }], // different from source
    );
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [7] },
      { fetchFn },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.speciesEditCount).toBe(1);
    expect(result.evolutionEditCount).toBe(0);
    expect(result.skipped).toEqual([]);

    const body = captured()!;
    expect(body.edits).toHaveLength(1);
    const edit = body.edits[0]!;
    expect(edit.kind).toBe('binary_write_bytes');
    if (edit.kind !== 'binary_write_bytes') throw new Error('unreachable');
    expect(edit.offset).toBe(TGT_OFF);
    // beforeBytes must be the target's current 28 bytes; afterBytes the source's.
    expect(edit.beforeBytes.length).toBe(SPECIES_STRUCT_SIZE * 2);
    expect(edit.afterBytes.length).toBe(SPECIES_STRUCT_SIZE * 2);
    expect(edit.beforeBytes).not.toBe(edit.afterBytes);
    // First byte of after-bytes should match source's pattern; first of before-bytes the target's.
    const srcExpected = (7 + 200) & 0xff;
    const tgtExpected = (7 + 0) & 0xff;
    expect(parseInt(edit.afterBytes.slice(0, 2), 16)).toBe(srcExpected);
    expect(parseInt(edit.beforeBytes.slice(0, 2), 16)).toBe(tgtExpected);
  });

  it('skips identical-bytes pairs as no-ops', async () => {
    const OFF = 0x100;
    const sameBytes = speciesStruct(3, 0);
    await seedSource(
      [{ speciesIndex: 3, sourceFileOffset: OFF }],
      [{ offset: OFF, bytes: sameBytes }],
    );
    await seedTarget(
      [{ speciesIndex: 3, sourceFileOffset: OFF }],
      [{ offset: OFF, bytes: sameBytes }],
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [3] },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.speciesEditCount).toBe(0);
    expect(result.skipped).toContainEqual({
      sourceIndex: 3,
      targetIndex: 3,
      part: 'species',
      reason: 'identical_bytes',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips source-missing pair without polluting other pairs', async () => {
    await seedSource(
      [{ speciesIndex: 7, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(7, 100) }],
    );
    await seedTarget(
      [{ speciesIndex: 7, sourceFileOffset: 0x300 }],
      [{ offset: 0x300, bytes: speciesStruct(7, 0) }],
    );
    const { fetchFn, captured } = fakeProposalFetch();
    // species 99 doesn't exist in source; 7 does.
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [99, 7] },
      { fetchFn },
    );
    expect(result.speciesEditCount).toBe(1);
    expect(result.skipped).toContainEqual({
      sourceIndex: 99,
      targetIndex: 99,
      part: 'species',
      reason: 'source_species_missing',
    });
    expect(captured()!.edits).toHaveLength(1);
  });

  it('respects an explicit targetSpeciesIds mapping (different src → tgt slots)', async () => {
    await seedSource(
      [{ speciesIndex: 50, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(50, 99) }],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x500 }],
      [{ offset: 0x500, bytes: speciesStruct(1, 0) }],
    );
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [50], targetSpeciesIds: [1] },
      { fetchFn },
    );
    expect(result.speciesEditCount).toBe(1);
    const edit = captured()!.edits[0]!;
    if (edit.kind !== 'binary_write_bytes') throw new Error('unreachable');
    expect(edit.offset).toBe(0x500); // target slot 1's offset
    expect(edit.note).toMatch(/species #50.*slot #1/);
  });

  it('rejects mismatched speciesIds / targetSpeciesIds lengths', async () => {
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }],
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1, 2], targetSpeciesIds: [1] },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/length .* must match/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects unsupported mode values', async () => {
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }],
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      // 'append' is reserved for v2 but not yet implemented.
      { sourceProjectRoot: sourceRoot, speciesIds: [1], mode: 'append' as 'replace_slot' },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/Mode 'append' is not yet supported/);
  });

  it('imports evolution row alongside species struct when both sides have one', async () => {
    const SRC_SP_OFF = 0x100;
    const SRC_EVO_OFF = 0x200;
    const TGT_SP_OFF = 0x500;
    const TGT_EVO_OFF = 0x600;
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: SRC_SP_OFF }],
      [
        { offset: SRC_SP_OFF, bytes: speciesStruct(1, 50) },
        { offset: SRC_EVO_OFF, bytes: evolutionBlock(1, 50) },
      ],
      [{ speciesIndex: 1, sourceFileOffset: SRC_EVO_OFF }],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: TGT_SP_OFF }],
      [
        { offset: TGT_SP_OFF, bytes: speciesStruct(1, 0) },
        { offset: TGT_EVO_OFF, bytes: evolutionBlock(1, 0) },
      ],
      [{ speciesIndex: 1, sourceFileOffset: TGT_EVO_OFF }],
    );
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1] },
      { fetchFn },
    );
    expect(result.speciesEditCount).toBe(1);
    expect(result.evolutionEditCount).toBe(1);
    const edits = captured()!.edits;
    expect(edits).toHaveLength(2);
    // Order: species first, then evolution.
    if (edits[0]!.kind !== 'binary_write_bytes') throw new Error('unreachable');
    if (edits[1]!.kind !== 'binary_write_bytes') throw new Error('unreachable');
    expect(edits[0]!.offset).toBe(TGT_SP_OFF);
    expect(edits[0]!.beforeBytes.length).toBe(SPECIES_STRUCT_SIZE * 2);
    expect(edits[1]!.offset).toBe(TGT_EVO_OFF);
    expect(edits[1]!.beforeBytes.length).toBe(EVOLUTION_BLOCK_SIZE * 2);
  });

  it('records asymmetric evolution missing (src has, tgt doesn\'t) as a skipped entry', async () => {
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [
        { offset: 0x100, bytes: speciesStruct(1, 100) },
        { offset: 0x200, bytes: evolutionBlock(1, 100) },
      ],
      [{ speciesIndex: 1, sourceFileOffset: 0x200 }],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x500 }],
      [{ offset: 0x500, bytes: speciesStruct(1, 0) }],
      [], // no evolution data
    );
    const { fetchFn, captured } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1] },
      { fetchFn },
    );
    expect(result.speciesEditCount).toBe(1);
    expect(result.evolutionEditCount).toBe(0);
    expect(result.skipped).toContainEqual({
      sourceIndex: 1,
      targetIndex: 1,
      part: 'evolution',
      reason: 'target_species_missing',
    });
    // Proposal still goes through with the one species edit.
    expect(captured()!.edits).toHaveLength(1);
  });

  it('silently ignores symmetric no-evolution pairs (neither side has one)', async () => {
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 100) }],
      [],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x500 }],
      [{ offset: 0x500, bytes: speciesStruct(1, 0) }],
      [],
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1] },
      { fetchFn },
    );
    expect(result.speciesEditCount).toBe(1);
    expect(result.evolutionEditCount).toBe(0);
    // No 'evolution'-part skips for a clean no-evo pair on both sides.
    expect(result.skipped.filter((s) => s.part === 'evolution')).toHaveLength(0);
  });

  it('returns proposal-null when every pair is skipped', async () => {
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 0) }], // identical to source
    );
    const { fetchFn } = fakeProposalFetch();
    const result = await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      { sourceProjectRoot: sourceRoot, speciesIds: [1] },
      { fetchFn },
    );
    expect(result.proposal).toBeNull();
    expect(result.message).toMatch(/Nothing to import/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses a custom description when provided', async () => {
    await seedSource(
      [{ speciesIndex: 1, sourceFileOffset: 0x100 }],
      [{ offset: 0x100, bytes: speciesStruct(1, 99) }],
    );
    await seedTarget(
      [{ speciesIndex: 1, sourceFileOffset: 0x500 }],
      [{ offset: 0x500, bytes: speciesStruct(1, 0) }],
    );
    const { fetchFn, captured } = fakeProposalFetch();
    await importSpeciesFromLibrary(
      { projectRoot: targetRoot, baseUrl: 'http://fake' },
      {
        sourceProjectRoot: sourceRoot,
        speciesIds: [1],
        description: 'Bring Bulbasaur from Radical Red',
      },
      { fetchFn },
    );
    expect(captured()!.description).toBe('Bring Bulbasaur from Radical Red');
  });
});
