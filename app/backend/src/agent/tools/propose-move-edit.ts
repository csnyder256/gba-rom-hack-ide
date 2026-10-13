import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  BattleMoveEntry,
  ProjectManifest,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_MOVE_EDIT_TOOL_NAME = 'propose_move_edit';

export const PROPOSE_MOVE_EDIT_DESCRIPTION =
  "Edit a single battle move's 12-byte BattleMove struct - power, " +
  'accuracy, type, PP, priority, effect, secondary-effect chance, target, ' +
  'and flags. The tool reads the current bytes at the move\'s struct ' +
  'offset, applies partial mutation, and emits a binary_write_bytes ' +
  'proposal.\n\n' +
  'Common use:\n' +
  '  - "make TACKLE actually hurt" → propose_move_edit({ moveIndex: 33, ' +
  'fields: { power: 80, accuracy: 100 } })\n' +
  '  - "give EARTHQUAKE +1 priority" → propose_move_edit({ moveIndex: 89, ' +
  'fields: { priority: 1 } })\n' +
  '  - "change THUNDERBOLT type to Fairy" → propose_move_edit({ ' +
  'moveIndex: 85, fields: { type: 18 } }) (vanilla types 0..17; FAIRY ' +
  'usually 18 in modern hacks)\n\n' +
  'Field bounds:\n' +
  '  power, accuracy, pp, secondaryEffectChance, target, type, effect: 0..255\n' +
  '  priority: -7..+7 (s8 - wraps in the encoded byte)\n' +
  "  flags: 0..255 (u8 - a ONE-byte bitfield: bit 0 contact, 1 Protect, " +
  "2 Magic Coat, 3 Snatch, 4 Mirror Move, 5 King's Rock)\n\n" +
  'The 12-byte struct layout is: { u8 effect; u8 power; u8 type; u8 ' +
  'accuracy; u8 pp; u8 secondaryEffectChance; u8 target; s8 priority; ' +
  'u8 flags; u8 padding[3]; } - same across vanilla FRLG, Emerald, and ' +
  'FRLG-based hacks. `flags` occupies exactly ONE byte at 0x08; bytes ' +
  '0x09..0x0B are struct padding that the format requires to be 0x00, so ' +
  'this tool never writes them.';

/** Field offsets within the 12-byte BattleMove struct. Mirrors pret/
 *  pokefirered's include/pokemon.h definition. */
const FIELD_OFFSETS = {
  effect: 0x00,
  power: 0x01,
  type: 0x02,
  accuracy: 0x03,
  pp: 0x04,
  secondaryEffectChance: 0x05,
  target: 0x06,
  priority: 0x07, // s8 - caller passes -128..127; we encode as two's complement byte
  flags: 0x08, // u8 - ONE-byte bitfield (contact / Protect / Magic Coat / Snatch / Mirror Move / King's Rock)
  // 0x09..0x0B: struct padding. The documented Gen-3 move structure
  // requires all three bytes to be 0x00, and the engine's move-table
  // detector relies on that, so nothing here may write them.
} as const;

const MOVE_STRUCT_SIZE = 12;

const u8 = z.number().int().min(0).max(255);
const s8 = z.number().int().min(-128).max(127);

export const proposeMoveEditInputShape = {
  moveIndex: z.number().int().nonnegative(),
  fields: z
    .object({
      effect: u8.optional(),
      power: u8.optional(),
      type: u8.optional(),
      accuracy: u8.optional(),
      pp: u8.optional(),
      secondaryEffectChance: u8.optional(),
      target: u8.optional(),
      priority: s8.optional(),
      flags: u8.optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'At least one field must be provided.',
    }),
  description: z.string().min(1).max(500).optional(),
} as const;

type MoveEditFields = {
  effect?: number; power?: number; type?: number; accuracy?: number;
  pp?: number; secondaryEffectChance?: number; target?: number; priority?: number;
  flags?: number;
};

export interface ProposeMoveEditResult {
  readonly proposal: AgentPatchProposal | null;
  readonly moveIndex: number;
  readonly moveName?: string;
  readonly changedFields: ReadonlyArray<string>;
  readonly message: string;
}

async function findRomBytes(projectRoot: string): Promise<{ absPath: string; bytes: Buffer } | null> {
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

function findMove(manifest: ProjectManifest, moveIndex: number): BattleMoveEntry | null {
  for (const m of manifest.battleMoves ?? []) {
    if (m.moveIndex === moveIndex) return m;
  }
  return null;
}

function bytesToHex(bytes: Uint8Array | Buffer, start: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += bytes[start + i]!.toString(16).padStart(2, '0');
  }
  return s;
}

export async function proposeMoveEdit(
  ctx: ToolContext,
  args: { moveIndex: number; fields: MoveEditFields; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeMoveEditResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      proposal: null,
      moveIndex: args.moveIndex,
      changedFields: [],
      message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'. Scan the project first.`,
    };
  }
  const move = findMove(manifest, args.moveIndex);
  if (!move) {
    return {
      proposal: null,
      moveIndex: args.moveIndex,
      changedFields: [],
      message: `Move index ${args.moveIndex} not in manifest.battleMoves[]. The detector found ${manifest.battleMoves?.length ?? 0} moves; check that the index is in range.`,
    };
  }
  const rom = await findRomBytes(ctx.projectRoot);
  if (!rom) {
    return {
      proposal: null,
      moveIndex: args.moveIndex,
      moveName: move.name,
      changedFields: [],
      message: `No .gba ROM found at '${ctx.projectRoot}'. Move edits need the live ROM bytes.`,
    };
  }

  // Per-move offset: the table starts at sourceTableOffset; each move
  // occupies MOVE_STRUCT_SIZE bytes; the move at index N lives at
  // sourceTableOffset + N * MOVE_STRUCT_SIZE.
  const offset = move.sourceTableOffset + args.moveIndex * MOVE_STRUCT_SIZE;
  if (offset < 0 || offset + MOVE_STRUCT_SIZE > rom.bytes.length) {
    return {
      proposal: null,
      moveIndex: args.moveIndex,
      moveName: move.name,
      changedFields: [],
      message: `Move offset 0x${offset.toString(16)} runs past end of ROM (length 0x${rom.bytes.length.toString(16)}).`,
    };
  }

  const beforeBytes = Buffer.from(rom.bytes.subarray(offset, offset + MOVE_STRUCT_SIZE));
  const afterBytes = Buffer.from(beforeBytes);

  const changedFields: string[] = [];
  const fields = args.fields;
  // `flags` is a ONE-byte bitfield at 0x08. The three bytes after it
  // (0x09..0x0B) are struct padding that the documented Gen-3 move
  // structure requires to be 0x00 - and the engine's move-table detector
  // rejects an entry whose padding is non-zero, which truncates (or loses)
  // the whole detected table. Refuse an out-of-range value here instead of
  // letting it spill into the padding.
  if (
    fields.flags !== undefined &&
    (!Number.isInteger(fields.flags) || fields.flags < 0 || fields.flags > 0xff)
  ) {
    return {
      proposal: null,
      moveIndex: args.moveIndex,
      moveName: move.name,
      changedFields: [],
      message:
        `flags must be a u8 in [0, 255]; got ${String(fields.flags)}. The move ` +
        'flags field is one byte at struct offset 0x08 (bit 0 contact, 1 ' +
        "Protect, 2 Magic Coat, 3 Snatch, 4 Mirror Move, 5 King's Rock); " +
        '0x09..0x0B are padding and must stay 0x00.',
    };
  }
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const fieldOffset = FIELD_OFFSETS[name as keyof typeof FIELD_OFFSETS];
    if (fieldOffset === undefined) continue;
    // Every writable field is exactly one byte wide: the u8 fields store
    // the value directly, and `priority` (s8) stores its two's complement.
    afterBytes[fieldOffset] = value & 0xff;
    changedFields.push(name);
  }

  if (changedFields.length === 0) {
    return {
      proposal: null,
      moveIndex: args.moveIndex,
      moveName: move.name,
      changedFields: [],
      message: 'No fields provided to edit.',
    };
  }

  if (beforeBytes.equals(afterBytes)) {
    return {
      proposal: null,
      moveIndex: args.moveIndex,
      moveName: move.name,
      changedFields: [],
      message: 'All requested values already match the current bytes - no change needed.',
    };
  }

  const edit: BinaryWriteBytesEdit = {
    kind: 'binary_write_bytes',
    offset,
    beforeBytes: bytesToHex(beforeBytes, 0, MOVE_STRUCT_SIZE),
    afterBytes: bytesToHex(afterBytes, 0, MOVE_STRUCT_SIZE),
    note: `edit move #${args.moveIndex} (${move.name ?? 'unnamed'}): ${changedFields.join(', ')}`,
  };
  const edits: AgentPatchEdit[] = [edit];

  const description =
    args.description ??
    `Edit ${move.name ?? `move #${args.moveIndex}`}: ${changedFields.join(', ')}`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        moveIndex: args.moveIndex,
        moveName: move.name,
        changedFields,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    moveIndex: args.moveIndex,
    moveName: move.name,
    changedFields,
    message: `Proposed editing ${move.name ?? `move #${args.moveIndex}`} - ${changedFields.length} field${changedFields.length === 1 ? '' : 's'} changed (${changedFields.join(', ')}). Review the diff and click Apply.`,
  };
}
