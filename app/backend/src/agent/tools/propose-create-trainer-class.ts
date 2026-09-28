/**
 * propose_create_trainer_class - Phase 3.19.
 *
 * Sets a trainer class name in gTrainerClasses by overwriting a
 * specific slot index. The agent picks the slot (typically the
 * next-free slot determined by reading the scanned table); the tool
 * encodes the name in Gen-3 charset + writes it in place.
 *
 * In-place rewrite (no relocation); gTrainerClasses table doesn't
 * grow. To add a brand-new class beyond the vanilla count, the agent
 * picks an unused slot (vanilla FRLG has ~106 classes 0..105; slots
 * past that are typically zeroed and available).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { text as textApi, trainers as trainersApi } from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_CREATE_TRAINER_CLASS_TOOL_NAME = 'propose_create_trainer_class';

export const PROPOSE_CREATE_TRAINER_CLASS_DESCRIPTION =
  'Set a trainer class name in gTrainerClasses (one fixed-size slot\n' +
  'per class, terminated by 0xFF). Vanilla FRLG has ~106 classes\n' +
  '(LEADER, CHAMPION, RIVAL, etc.); slots past that are typically\n' +
  'zeroed and available.\n\n' +
  'The slot stride is resolved from the ROM: 13 bytes on vanilla\n' +
  'FRLG/Emerald tables (12 chars + terminator), 12 on tables that\n' +
  'pack the name and its 0xFF into the same 12 bytes.\n\n' +
  'Inputs:\n' +
  '  - `classIndex`: u16 - slot in gTrainerClasses to overwrite.\n' +
  '  - `className`: 1-12 chars; must fit the resolved slot minus its\n' +
  '    0xFF terminator (12 bytes in a 13-byte slot, 11 in a 12-byte one).';

const u16 = z.number().int().min(0).max(0xffff);

export const proposeCreateTrainerClassInputShape = {
  classIndex: u16,
  className: z.string().min(1).max(12),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeCreateTrainerClassResult {
  readonly proposal: AgentPatchProposal | null;
  readonly classIndex: number;
  readonly slotOffset: number | null;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(classIndex: number, message: string): ProposeCreateTrainerClassResult {
  return { proposal: null, classIndex, slotOffset: null, bytesWritten: 0, message };
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

export async function proposeCreateTrainerClass(
  ctx: ToolContext,
  args: { classIndex: number; className: string; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeCreateTrainerClassResult> {
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(args.classIndex, `No .gba in ${ctx.projectRoot}`);
  const romBytes = new Uint8Array(rom.bytes);
  const table = trainersApi.findTrainerClassNamesTable(romBytes);
  if (table === null) {
    return emptyResult(args.classIndex, 'Could not locate gTrainerClasses table.');
  }

  // Walk at the stride the scanner validated. A vanilla table is 13
  // bytes/slot; a hack that packs the name and its 0xFF into 12 uses 12.
  // Indexing a 12-byte table at 13 would write into the middle of a
  // neighbouring class and leave the requested class unchanged.
  const slotBytes = table.slotBytes;
  const slotOffset = table.offset + args.classIndex * slotBytes;
  if (slotOffset + slotBytes > rom.bytes.length) {
    return emptyResult(args.classIndex, `classIndex ${String(args.classIndex)} is past ROM end.`);
  }
  const oldBytes = new Uint8Array(rom.bytes.subarray(slotOffset, slotOffset + slotBytes));

  // Encode + pad the rest of the slot with 0xFF terminators.
  const encoded = textApi.encodeString(args.className.toUpperCase());
  if (encoded.length > slotBytes - 1) {
    return emptyResult(
      args.classIndex,
      `encoded class name length ${String(encoded.length)} > ${String(slotBytes - 1)} usable bytes in a ${String(slotBytes)}-byte slot (one byte is the 0xFF terminator)`,
    );
  }
  const newBytes = new Uint8Array(slotBytes);
  newBytes.set(encoded);
  for (let i = encoded.length; i < newBytes.length; i++) newBytes[i] = 0xff;

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: slotOffset,
      beforeBytes: bytesToHex(oldBytes),
      afterBytes: bytesToHex(newBytes),
      note: `Set gTrainerClasses[${String(args.classIndex)}] = "${args.className.toUpperCase()}"`,
    } satisfies BinaryWriteBytesEdit,
  ];
  const description = args.description ?? `Set trainer class ${String(args.classIndex)} = "${args.className}"`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(args.classIndex, `Failed: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    classIndex: args.classIndex,
    slotOffset,
    bytesWritten: slotBytes,
    message: `Trainer class ${String(args.classIndex)} = "${args.className.toUpperCase()}" @ 0x${slotOffset.toString(16)} (${String(slotBytes)}-byte slot).`,
  };
}
