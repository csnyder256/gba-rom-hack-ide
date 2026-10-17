import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  ProjectManifest,
  SpeciesEntry,
  SpeciesEvolutionEntry,
} from '@rom-editor/shared';
import { species as speciesApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

/** Vanilla Gen-3 FRLG/RS BaseStats struct size. Confirmed by
 *  `SpeciesEntry`'s comment ("28-byte BaseStats struct") in the shared
 *  manifest schema. Holds for all corpus targets (FireRed / Unbound /
 *  Radical Red), which are all Gen-3-format. */
const SPECIES_STRUCT_SIZE = 28;
/** 5 evolution slots × 6 bytes per slot = 30-byte EvolutionBlock
 *  (pret `struct Evolution` is three u16s with no padding word).
 *  Sourced from the engine so the copy window matches the reader. */
const EVOLUTION_BLOCK_SIZE = speciesApi.EVOLUTION_BLOCK_SIZE_BYTES;

export const IMPORT_SPECIES_FROM_LIBRARY_TOOL_NAME = 'import_species_from_library';

export const IMPORT_SPECIES_FROM_LIBRARY_DESCRIPTION =
  "Copy species data from another scanned project's .gba into THIS project's " +
  '.gba. Use after `list_species_libraries` + `get_species_from_library` ' +
  'to identify which species to pull and from where.\n\n' +
  'v1 supports `mode: "replace_slot"` only - for each pair ' +
  '(sourceIds[i], targetIds[i]), the source species\'s 28-byte BaseStats ' +
  'struct + 30-byte EvolutionBlock OVERWRITE the target slot at the same ' +
  'species index in the target ROM. No table expansion; targetIds default ' +
  'to sourceIds when omitted (1:1 mapping). Names + learnsets are NOT ' +
  'imported by v1 - Gen-3 names live in a separate string table reachable ' +
  'via `propose_rename`, and learnsets are variable-length pointer-table ' +
  'entries (deferred to a follow-up tool).\n\n' +
  'Behavior: returns an AgentPatchProposal queued for the user\'s review. ' +
  'Each species pair yields one or two `binary_write_bytes` edits ' +
  '(species struct always; evolution block only when both source and ' +
  'target have an entry). Identical-bytes pairs are skipped (no-ops). ' +
  'The tool reads both ROMs to validate `beforeBytes`, so the proposal ' +
  'won\'t pass route validation unless source + target ROMs are both ' +
  'reachable on disk.';

export const importSpeciesFromLibraryInputShape = {
  sourceProjectRoot: z.string().min(1),
  /** Source species indices to import (must be non-empty). */
  speciesIds: z.array(z.number().int().nonnegative()).min(1).max(200),
  /** Target slot indices to overwrite. Defaults to `speciesIds`
   *  (each source species replaces the same-index slot in the target). */
  targetSpeciesIds: z.array(z.number().int().nonnegative()).min(1).max(200).optional(),
  mode: z.enum(['replace_slot']).optional(),
  description: z.string().min(1).max(500).optional(),
} as const;

export type ImportSpeciesSkipReason =
  | 'source_species_missing'
  | 'target_species_missing'
  | 'source_offset_out_of_range'
  | 'target_offset_out_of_range'
  | 'identical_bytes';

export interface ImportSpeciesSkip {
  readonly sourceIndex: number;
  readonly targetIndex: number;
  readonly part: 'species' | 'evolution';
  readonly reason: ImportSpeciesSkipReason;
}

export interface ImportSpeciesFromLibraryResult {
  /** The submitted proposal, or null when no edits were produced
   *  (every requested pair was skipped or the inputs were unworkable). */
  readonly proposal: AgentPatchProposal | null;
  /** Number of species struct copies in the proposal. */
  readonly speciesEditCount: number;
  /** Number of evolution block copies in the proposal. */
  readonly evolutionEditCount: number;
  readonly skipped: ReadonlyArray<ImportSpeciesSkip>;
  readonly sourceDisplayName: string | null;
  readonly targetDisplayName: string | null;
  readonly message: string;
}

interface RomBytes {
  readonly absPath: string;
  readonly bytes: Buffer;
}

async function findRomBytes(projectRoot: string): Promise<RomBytes | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        const absPath = path.join(projectRoot, e.name);
        const bytes = await fsp.readFile(absPath);
        return { absPath, bytes };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function bytesEqual(a: Uint8Array, aStart: number, b: Uint8Array, bStart: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (a[aStart + i] !== b[bStart + i]) return false;
  }
  return true;
}

function bytesToHex(bytes: Uint8Array | Buffer, start: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += bytes[start + i]!.toString(16).padStart(2, '0');
  }
  return s;
}

function findSpeciesEntry(
  list: ReadonlyArray<SpeciesEntry> | undefined,
  speciesIndex: number,
): SpeciesEntry | null {
  if (!list) return null;
  for (const e of list) {
    if (e.speciesIndex === speciesIndex) return e;
  }
  return null;
}

function findEvolutionEntry(
  list: ReadonlyArray<SpeciesEvolutionEntry> | undefined,
  speciesIndex: number,
): SpeciesEvolutionEntry | null {
  if (!list) return null;
  for (const e of list) {
    if (e.speciesIndex === speciesIndex) return e;
  }
  return null;
}

export async function importSpeciesFromLibrary(
  ctx: ToolContext,
  args: {
    sourceProjectRoot: string;
    speciesIds: number[];
    targetSpeciesIds?: number[];
    mode?: 'replace_slot';
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ImportSpeciesFromLibraryResult> {
  const mode = args.mode ?? 'replace_slot';
  if (mode !== 'replace_slot') {
    return {
      proposal: null,
      speciesEditCount: 0,
      evolutionEditCount: 0,
      skipped: [],
      sourceDisplayName: null,
      targetDisplayName: null,
      message: `Mode '${mode}' is not yet supported. v1 supports 'replace_slot' only.`,
    };
  }

  const targetIds = args.targetSpeciesIds ?? args.speciesIds;
  if (targetIds.length !== args.speciesIds.length) {
    return {
      proposal: null,
      speciesEditCount: 0,
      evolutionEditCount: 0,
      skipped: [],
      sourceDisplayName: null,
      targetDisplayName: null,
      message: `targetSpeciesIds length (${targetIds.length}) must match speciesIds length (${args.speciesIds.length}).`,
    };
  }

  const sourceRoot = path.resolve(args.sourceProjectRoot);

  // 1. Load source artifacts.
  let sourceManifest: ProjectManifest | null;
  try {
    sourceManifest = await readManifest(sourceRoot);
  } catch {
    sourceManifest = null;
  }
  if (!sourceManifest) {
    return {
      proposal: null,
      speciesEditCount: 0,
      evolutionEditCount: 0,
      skipped: [],
      sourceDisplayName: null,
      targetDisplayName: null,
      message: `No manifest at '${sourceRoot}/.editor/manifest.json'. Use list_species_libraries to find valid sources.`,
    };
  }
  const sourceRom = await findRomBytes(sourceRoot);
  if (!sourceRom) {
    return {
      proposal: null,
      speciesEditCount: 0,
      evolutionEditCount: 0,
      skipped: [],
      sourceDisplayName: sourceManifest.identity.displayName ?? null,
      targetDisplayName: null,
      message: `No .gba at '${sourceRoot}'. Source ROM bytes are required to copy species data.`,
    };
  }

  // 2. Load target artifacts.
  const targetManifest = await readManifest(ctx.projectRoot);
  if (!targetManifest) {
    return {
      proposal: null,
      speciesEditCount: 0,
      evolutionEditCount: 0,
      skipped: [],
      sourceDisplayName: sourceManifest.identity.displayName ?? null,
      targetDisplayName: null,
      message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'. Open + scan the current project first.`,
    };
  }
  const targetRom = await findRomBytes(ctx.projectRoot);
  if (!targetRom) {
    return {
      proposal: null,
      speciesEditCount: 0,
      evolutionEditCount: 0,
      skipped: [],
      sourceDisplayName: sourceManifest.identity.displayName ?? null,
      targetDisplayName: targetManifest.identity.displayName ?? null,
      message: `No .gba at '${ctx.projectRoot}'. Target ROM is required so the importer can record beforeBytes for each slot.`,
    };
  }

  // 3. Walk pairs, build edits.
  const edits: AgentPatchEdit[] = [];
  const skipped: ImportSpeciesSkip[] = [];
  let speciesEditCount = 0;
  let evolutionEditCount = 0;

  for (let i = 0; i < args.speciesIds.length; i++) {
    const srcId = args.speciesIds[i]!;
    const tgtId = targetIds[i]!;

    // Species struct (28 bytes).
    const srcSpecies = findSpeciesEntry(sourceManifest.species, srcId);
    const tgtSpecies = findSpeciesEntry(targetManifest.species, tgtId);
    if (!srcSpecies) {
      skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'species', reason: 'source_species_missing' });
    } else if (!tgtSpecies) {
      skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'species', reason: 'target_species_missing' });
    } else {
      const srcOff = srcSpecies.sourceFileOffset;
      const tgtOff = tgtSpecies.sourceFileOffset;
      if (srcOff < 0 || srcOff + SPECIES_STRUCT_SIZE > sourceRom.bytes.length) {
        skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'species', reason: 'source_offset_out_of_range' });
      } else if (tgtOff < 0 || tgtOff + SPECIES_STRUCT_SIZE > targetRom.bytes.length) {
        skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'species', reason: 'target_offset_out_of_range' });
      } else if (bytesEqual(sourceRom.bytes, srcOff, targetRom.bytes, tgtOff, SPECIES_STRUCT_SIZE)) {
        // No-op - the target slot is already byte-identical to the source.
        skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'species', reason: 'identical_bytes' });
      } else {
        const edit: BinaryWriteBytesEdit = {
          kind: 'binary_write_bytes',
          offset: tgtOff,
          beforeBytes: bytesToHex(targetRom.bytes, tgtOff, SPECIES_STRUCT_SIZE),
          afterBytes: bytesToHex(sourceRom.bytes, srcOff, SPECIES_STRUCT_SIZE),
          note: `import species #${srcId} → slot #${tgtId} (28-byte struct)`,
        };
        edits.push(edit);
        speciesEditCount += 1;
      }
    }

    // Evolution block (30 bytes). Optional - many species have no entry
    // in the evolution table; skip silently in that case.
    const srcEvo = findEvolutionEntry(sourceManifest.speciesEvolutions, srcId);
    const tgtEvo = findEvolutionEntry(targetManifest.speciesEvolutions, tgtId);
    if (!srcEvo || !tgtEvo) {
      // Neither side has evolution data for this index - silently skip.
      // Asymmetric cases (src has, tgt doesn't or vice versa) get recorded
      // because the user probably expected those to roundtrip.
      if (srcEvo && !tgtEvo) {
        skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'evolution', reason: 'target_species_missing' });
      } else if (!srcEvo && tgtEvo) {
        skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'evolution', reason: 'source_species_missing' });
      }
      continue;
    }
    const srcEvoOff = srcEvo.sourceFileOffset;
    const tgtEvoOff = tgtEvo.sourceFileOffset;
    if (srcEvoOff < 0 || srcEvoOff + EVOLUTION_BLOCK_SIZE > sourceRom.bytes.length) {
      skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'evolution', reason: 'source_offset_out_of_range' });
      continue;
    }
    if (tgtEvoOff < 0 || tgtEvoOff + EVOLUTION_BLOCK_SIZE > targetRom.bytes.length) {
      skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'evolution', reason: 'target_offset_out_of_range' });
      continue;
    }
    if (bytesEqual(sourceRom.bytes, srcEvoOff, targetRom.bytes, tgtEvoOff, EVOLUTION_BLOCK_SIZE)) {
      skipped.push({ sourceIndex: srcId, targetIndex: tgtId, part: 'evolution', reason: 'identical_bytes' });
      continue;
    }
    edits.push({
      kind: 'binary_write_bytes',
      offset: tgtEvoOff,
      beforeBytes: bytesToHex(targetRom.bytes, tgtEvoOff, EVOLUTION_BLOCK_SIZE),
      afterBytes: bytesToHex(sourceRom.bytes, srcEvoOff, EVOLUTION_BLOCK_SIZE),
      note: `import species #${srcId} → slot #${tgtId} (30-byte evolution block)`,
    });
    evolutionEditCount += 1;
  }

  const sourceDisplayName = sourceManifest.identity.displayName ?? null;
  const targetDisplayName = targetManifest.identity.displayName ?? null;

  if (edits.length === 0) {
    const reasonsByPart = new Map<string, number>();
    for (const s of skipped) {
      const key = `${s.part}:${s.reason}`;
      reasonsByPart.set(key, (reasonsByPart.get(key) ?? 0) + 1);
    }
    const breakdown =
      reasonsByPart.size === 0
        ? 'no edits to apply'
        : Array.from(reasonsByPart.entries())
            .map(([k, n]) => `${n} ${k}`)
            .join(', ');
    return {
      proposal: null,
      speciesEditCount: 0,
      evolutionEditCount: 0,
      skipped,
      sourceDisplayName,
      targetDisplayName,
      message: `Nothing to import (${breakdown}).`,
    };
  }

  const totalPairs = args.speciesIds.length;
  const description =
    args.description ??
    `Import ${speciesEditCount} species from "${sourceDisplayName ?? sourceRoot}"` +
      (evolutionEditCount > 0 ? ` + ${evolutionEditCount} evolution row${evolutionEditCount === 1 ? '' : 's'}` : '');

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        speciesEditCount,
        evolutionEditCount,
        skipped,
        sourceDisplayName,
        targetDisplayName,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  const messageParts: string[] = [
    `Proposed importing ${speciesEditCount} of ${totalPairs} species from "${sourceDisplayName ?? sourceRoot}" into "${targetDisplayName ?? ctx.projectRoot}"`,
  ];
  if (evolutionEditCount > 0) {
    messageParts.push(`(+${evolutionEditCount} evolution row${evolutionEditCount === 1 ? '' : 's'}).`);
  } else {
    messageParts.push('.');
  }
  if (skipped.length > 0) {
    messageParts.push(`${skipped.length} edit${skipped.length === 1 ? '' : 's'} skipped (see skipped[] for reasons).`);
  }
  messageParts.push(`Review the diff and click Apply in the agent panel.`);

  return {
    proposal,
    speciesEditCount,
    evolutionEditCount,
    skipped,
    sourceDisplayName,
    targetDisplayName,
    message: messageParts.join(' '),
  };
}
