/**
 * propose_edit_evolution - Phase 3.28.
 *
 * Rewrites the evolution block for a species in gEvolutionTable.
 * Each species has 5 slots (EVOS_PER_MON); each slot is the pret
 * `struct Evolution` - 6 bytes: {method u16, param u16, targetSpecies
 * u16} with no padding word - so a block is 30 bytes. The bytes are
 * produced by the engine's `encodeEvolutionBlock`, so the writer and
 * the reader cannot drift apart.
 *
 * Inputs:
 *   - speciesId: u16
 *   - evolutions: array of up to 5 { method, param, targetSpecies }
 *     entries. Slots not in the array are zero-filled (EVO_NONE).
 *
 * Common method codes (pret vanilla):
 *   1=FRIENDSHIP, 2=FRIENDSHIP_DAY, 3=FRIENDSHIP_NIGHT, 4=LEVEL,
 *   5=TRADE, 6=TRADE_ITEM, 7=ITEM, 8=LEVEL_ATK_GT_DEF, 9=LEVEL_ATK_EQ_DEF,
 *   10=LEVEL_ATK_LT_DEF, 11=LEVEL_SILCOON, 12=LEVEL_CASCOON,
 *   13=LEVEL_NINJASK, 14=LEVEL_SHEDINJA, 15=BEAUTY.
 *
 * In-place rewrite - the table doesn't change size.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { species as speciesApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_EDIT_EVOLUTION_TOOL_NAME = 'propose_edit_evolution';

export const PROPOSE_EDIT_EVOLUTION_DESCRIPTION =
  'Rewrite a species\' evolution block (5 slots × 6 bytes = 30 bytes).\n\n' +
  'Inputs:\n' +
  '  - `speciesId`: u16.\n' +
  '  - `evolutions`: array of up to 5 { method, param, targetSpecies }\n' +
  '    entries. Slots not in the array become EVO_NONE (zeroed).\n\n' +
  'Common method codes (vanilla): 1=FRIENDSHIP, 4=LEVEL, 5=TRADE,\n' +
  '6=TRADE_ITEM, 7=ITEM, 8..10=LEVEL_ATK_*_DEF, 11=SILCOON, 12=CASCOON,\n' +
  '13=NINJASK, 14=SHEDINJA, 15=BEAUTY. CFRU expansions use 16..50.';

const u16 = z.number().int().min(0).max(0xffff);

const evolutionSchema = z.object({
  method: u16,
  param: u16,
  targetSpecies: u16,
});

export const proposeEditEvolutionInputShape = {
  speciesId: u16,
  evolutions: z.array(evolutionSchema).max(5),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeEditEvolutionResult {
  readonly proposal: AgentPatchProposal | null;
  readonly speciesId: number;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(speciesId: number, message: string): ProposeEditEvolutionResult {
  return { proposal: null, speciesId, bytesWritten: 0, message };
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

async function findRomFile(root: string): Promise<{ bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return { bytes: await fsp.readFile(path.join(root, e.name)) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function proposeEditEvolution(
  ctx: ToolContext,
  args: {
    speciesId: number;
    evolutions: Array<{ method: number; param: number; targetSpecies: number }>;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeEditEvolutionResult> {
  void await readManifest(ctx.projectRoot);
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(args.speciesId, `No .gba in ${ctx.projectRoot}`);

  const romBytes = new Uint8Array(rom.bytes);
  const table = speciesApi.scanEvolutionTable(romBytes);
  if (!table) return emptyResult(args.speciesId, 'Could not locate gEvolutionTable.');
  if (args.speciesId >= table.blockCount) {
    return emptyResult(
      args.speciesId,
      `speciesId ${String(args.speciesId)} is past the table end (${String(table.blockCount)} species).`,
    );
  }

  const blockOffset = table.tableStart + args.speciesId * speciesApi.EVOLUTION_BLOCK_SIZE_BYTES;
  const oldBytes = new Uint8Array(
    rom.bytes.subarray(blockOffset, blockOffset + speciesApi.EVOLUTION_BLOCK_SIZE_BYTES),
  );

  // Build the new block through the engine encoder (single source of
  // truth for the on-disk slot stride); slots not supplied stay EVO_NONE.
  const newBytes = speciesApi.encodeEvolutionBlock(
    args.evolutions.slice(0, speciesApi.EVOLUTION_SLOTS_PER_SPECIES),
  );

  if (oldBytes.every((b, i) => b === newBytes[i])) {
    return emptyResult(args.speciesId, 'No changes - block already matches requested evolutions.');
  }

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: blockOffset,
      beforeBytes: bytesToHex(oldBytes),
      afterBytes: bytesToHex(newBytes),
      note: `rewrite gEvolutionTable[${String(args.speciesId)}] with ${String(args.evolutions.length)} method(s)`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.description ?? `Edit evolutions for species ${String(args.speciesId)} (${String(args.evolutions.length)} method(s))`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(args.speciesId, `Failed to register proposal: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    speciesId: args.speciesId,
    bytesWritten: speciesApi.EVOLUTION_BLOCK_SIZE_BYTES,
    message: `Rewrote evolution block for species ${String(args.speciesId)}.`,
  };
}
