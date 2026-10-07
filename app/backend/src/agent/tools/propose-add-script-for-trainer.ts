/**
 * propose_add_script_for_trainer - bind an ObjectEvent to a Trainer by
 * synthesizing a minimal trainer-battle script and stamping it onto the
 * NPC's struct.
 *
 * Gen-3 NPC-trainer wiring needs THREE struct fields to be set in
 * concert (`engine/src/maps/events.ts` ObjectEventTemplate, 24 bytes):
 *
 *   +0x0C u16  trainerType (1 = single-direction sight, 3 = omnidirectional)
 *   +0x0E u16  trainerSightOrBerryTreeId (sight range in tiles)
 *   +0x10 u32  scriptPointer (engine starts running this when the NPC
 *              sees the player or the player interacts)
 *
 * The scriptPointer points at this tool's synthesized bytecode - a
 * `trainerbattle` opcode (0x5C) type 3 (TRAINER_BATTLE_SINGLE_NO_INTRO_TEXT)
 * with the requested trainerId, plus a 2-byte post-battle stub
 * (`release; end`) the trainer-battle handler runs after the player
 * wins. Layout (type 3 is 10 bytes per the pret `trainerbattle` macro /
 * `sOrdinaryNoIntroBattleParams`: type u8 + trainerId u16 + localId u16 +
 * defeat-speech ptr u32):
 *
 *   ── trainer-battle script (11 bytes) ──
 *   +0  u8  0x5C            (trainerbattle opcode)
 *   +1  u8  0x03            (battle type: single, no intro text)
 *   +2  u16 trainerId
 *   +4  u16 localId         (= 0)
 *   +6  u32 defeatTextPtr   (= postBattlePtr - the script after victory)
 *   +10 u8  0x02            (end opcode)
 *
 *   ── post-battle stub (2 bytes) ──
 *   +0  u8  0x6C            (release opcode)
 *   +1  u8  0x02            (end opcode)
 *
 * Both blocks land in fresh free-ROM space. The ObjectEvent struct's
 * 8-byte window at +0x0C..+0x13 is overwritten in place with the new
 * trainerType / sight / scriptPointer triple - the existing flagId at
 * +0x14 is untouched.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  ObjectEvent,
  ProjectManifest,
} from '@rom-editor/shared';
import { rom as romApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_ADD_SCRIPT_FOR_TRAINER_TOOL_NAME = 'propose_add_script_for_trainer';

export const PROPOSE_ADD_SCRIPT_FOR_TRAINER_DESCRIPTION =
  "Wire an existing ObjectEvent (NPC) to fight as a specific trainer. " +
  "Synthesizes a minimal trainerbattle script (type 3 - no intro text), " +
  "a 2-byte post-battle stub (release + end), and patches the NPC's " +
  "struct so trainerType=1 (single-line sight), sight range is set, and " +
  "scriptPointer targets the new script.\n\n" +
  "Use this immediately after propose_add_object_event when creating a " +
  "fresh trainer NPC. Also valid for upgrading an existing plain NPC " +
  "to a trainer.\n\n" +
  "Inputs:\n" +
  "  - `objectEventId`: the NPC id (e.g. `binary_obj_3_19_5`).\n" +
  "  - `trainerId`: the gTrainers index (u16; from propose_add_trainer\n" +
  "    .newTrainerId or list_entities({ kind: 'trainer' })).\n" +
  "  - `trainerType`: optional u16 (default 1 = single-line sight).\n" +
  "    Use 3 for see-all-directions trainers.\n" +
  "  - `sightRange`: optional u16 (default 5 tiles).";

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeAddScriptForTrainerInputShape = {
  objectEventId: z.string().min(1),
  trainerId: u16,
  trainerType: u8.optional(),
  sightRange: u16.optional(),
  description: z.string().min(1).max(500).optional(),
} as const;

export interface ProposeAddScriptForTrainerResult {
  readonly proposal: AgentPatchProposal | null;
  readonly objectEventId: string;
  readonly trainerId: number;
  readonly trainerScriptOffset: number | null;
  readonly postBattleScriptOffset: number | null;
  readonly objectEventStructOffset: number | null;
  readonly message: string;
}

const TRAINERBATTLE_OPCODE = 0x5c;
const TRAINERBATTLE_TYPE_NO_INTRO = 0x03;
const RELEASE_OPCODE = 0x6c;
const END_OPCODE = 0x02;
const GBA_ROM_BASE = 0x08000000;
const TRAINER_BATTLE_SCRIPT_BYTES = 11; // trainerbattle type 3 (10) + end (1)
const OBJ_EVENT_TRAINER_FIELDS_OFFSET = 0x0c;
/** Length of the contiguous slice we rewrite on the ObjectEvent struct:
 *  trainerType (2) + sight (2) + scriptPointer (4) = 8 bytes. flagId
 *  (at +0x14) is preserved. */
const OBJ_EVENT_TRAINER_FIELDS_LENGTH = 8;

class InBatchAllocator {
  private readonly working: Uint8Array;
  private readonly fillBytes = new Map<number, number>();
  constructor(romBytes: Uint8Array) {
    this.working = new Uint8Array(romBytes);
  }
  allocate(size: number): number | null {
    if (size <= 0) return null;
    const r = romApi.findFreeRomSpace(this.working, size);
    if (!r) return null;
    for (let i = 0; i < size; i++) this.working[r.offset + i] = 0xaa;
    this.fillBytes.set(r.offset, r.fillByte);
    return r.offset;
  }
  fillByteAt(offset: number): number {
    return this.fillBytes.get(offset) ?? 0xff;
  }
}

async function findRomFile(
  projectRoot: string,
): Promise<{ path: string; bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        const p = path.join(projectRoot, e.name);
        const bytes = await fsp.readFile(p);
        return { path: p, bytes };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function bytesToHex(bytes: Uint8Array | Buffer): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function findObjectEvent(manifest: ProjectManifest, id: string): ObjectEvent | null {
  for (const o of manifest.objectEvents) {
    if (o.id === id) return o;
  }
  return null;
}

/** Recover the ObjectEvent's 24-byte struct file offset from its
 *  metadata. The binary-rom lifter stores it as `binaryFileOffset`; the
 *  older `binaryRomStructFileOffset` key shows up in some test fixtures
 *  and the propose-script-edit cross-ref pass - try both. */
function readStructFileOffset(o: ObjectEvent): number | null {
  const meta = o.metadata ?? {};
  const a = meta['binaryFileOffset'];
  if (typeof a === 'number' && Number.isFinite(a) && a > 0) return a;
  const b = meta['binaryRomStructFileOffset'];
  if (typeof b === 'number' && Number.isFinite(b) && b > 0) return b;
  return null;
}

/** Build the 11-byte trainer-battle script that runs when this NPC
 *  sees / is talked to. */
function buildTrainerBattleScript(trainerId: number, postBattleOffset: number): Uint8Array {
  const out = new Uint8Array(TRAINER_BATTLE_SCRIPT_BYTES);
  out[0] = TRAINERBATTLE_OPCODE;
  out[1] = TRAINERBATTLE_TYPE_NO_INTRO;
  out[2] = trainerId & 0xff;
  out[3] = (trainerId >>> 8) & 0xff;
  out[4] = 0; // localId
  out[5] = 0;
  const ptr = (postBattleOffset + GBA_ROM_BASE) >>> 0;
  out[6] = ptr & 0xff;
  out[7] = (ptr >>> 8) & 0xff;
  out[8] = (ptr >>> 16) & 0xff;
  out[9] = (ptr >>> 24) & 0xff;
  out[10] = END_OPCODE;
  return out;
}

/** Build the 2-byte post-battle stub. */
function buildPostBattleScript(): Uint8Array {
  return new Uint8Array([RELEASE_OPCODE, END_OPCODE]);
}

/** Build the 8-byte ObjectEvent field slice (trainerType + sight + scriptPtr). */
function buildTrainerFieldsSlice(
  trainerType: number,
  sightRange: number,
  scriptOffset: number,
): Uint8Array {
  const out = new Uint8Array(OBJ_EVENT_TRAINER_FIELDS_LENGTH);
  out[0] = trainerType & 0xff;
  out[1] = (trainerType >>> 8) & 0xff;
  out[2] = sightRange & 0xff;
  out[3] = (sightRange >>> 8) & 0xff;
  const ptr = (scriptOffset + GBA_ROM_BASE) >>> 0;
  out[4] = ptr & 0xff;
  out[5] = (ptr >>> 8) & 0xff;
  out[6] = (ptr >>> 16) & 0xff;
  out[7] = (ptr >>> 24) & 0xff;
  return out;
}

export async function proposeAddScriptForTrainer(
  ctx: ToolContext,
  args: {
    objectEventId: string;
    trainerId: number;
    trainerType?: number;
    sightRange?: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeAddScriptForTrainerResult> {
  const empty: Omit<ProposeAddScriptForTrainerResult, 'message'> = {
    proposal: null,
    objectEventId: args.objectEventId,
    trainerId: args.trainerId,
    trainerScriptOffset: null,
    postBattleScriptOffset: null,
    objectEventStructOffset: null,
  };

  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return { ...empty, message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'. Open + scan a project first.` };
  }
  const obj = findObjectEvent(manifest, args.objectEventId);
  if (!obj) {
    return {
      ...empty,
      message: `ObjectEvent '${args.objectEventId}' not in manifest.objectEvents[] (${manifest.objectEvents.length} entries). Use list_entities({ kind: 'objectEvent' }) to discover valid ids.`,
    };
  }
  const structOffset = readStructFileOffset(obj);
  if (structOffset === null) {
    return {
      ...empty,
      message: `ObjectEvent '${args.objectEventId}' has no binary-rom struct offset in metadata - not a binary-rom workspace, or the manifest wasn't fully populated.`,
    };
  }

  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) {
    return { ...empty, objectEventStructOffset: structOffset, message: `No .gba ROM found at '${ctx.projectRoot}'.` };
  }
  if (structOffset + 24 > rom.bytes.length) {
    return {
      ...empty,
      objectEventStructOffset: structOffset,
      message: `ObjectEvent struct offset 0x${structOffset.toString(16)} + 24 runs past end of ROM (length 0x${rom.bytes.length.toString(16)}).`,
    };
  }

  // 1. Allocate the post-battle stub (2 bytes).
  // 2. Allocate the trainer-battle script (11 bytes).
  const allocator = new InBatchAllocator(rom.bytes);
  const postBattleBytes = buildPostBattleScript();
  const postBattleOffset = allocator.allocate(postBattleBytes.length);
  if (postBattleOffset === null) {
    return {
      ...empty,
      objectEventStructOffset: structOffset,
      message: `No free ROM space for ${String(postBattleBytes.length)} bytes (post-battle stub).`,
    };
  }
  const trainerBattleBytes = buildTrainerBattleScript(args.trainerId, postBattleOffset);
  const trainerScriptOffset = allocator.allocate(trainerBattleBytes.length);
  if (trainerScriptOffset === null) {
    return {
      ...empty,
      objectEventStructOffset: structOffset,
      postBattleScriptOffset: postBattleOffset,
      message: `No free ROM space for ${String(trainerBattleBytes.length)} bytes (trainer-battle script).`,
    };
  }

  // 3. Build the new 8-byte ObjectEvent slice at struct +0x0C..+0x13.
  const trainerType = args.trainerType ?? 1;
  const sightRange = args.sightRange ?? 5;
  const newFieldsBytes = buildTrainerFieldsSlice(trainerType, sightRange, trainerScriptOffset);
  const oldFieldsBytes = rom.bytes.subarray(
    structOffset + OBJ_EVENT_TRAINER_FIELDS_OFFSET,
    structOffset + OBJ_EVENT_TRAINER_FIELDS_OFFSET + OBJ_EVENT_TRAINER_FIELDS_LENGTH,
  );

  if (oldFieldsBytes.equals(Buffer.from(newFieldsBytes))) {
    return {
      ...empty,
      objectEventStructOffset: structOffset,
      postBattleScriptOffset: postBattleOffset,
      trainerScriptOffset,
      message: `ObjectEvent '${args.objectEventId}' is already wired to this exact trainer/script - nothing to change.`,
    };
  }

  const edits: AgentPatchEdit[] = [];

  // 1. Write the post-battle stub.
  edits.push({
    kind: 'binary_write_bytes',
    offset: postBattleOffset,
    beforeBytes: bytesToHex(new Uint8Array(postBattleBytes.length).fill(allocator.fillByteAt(postBattleOffset))),
    afterBytes: bytesToHex(postBattleBytes),
    requireFreeSlot: true,
    note: `post-battle stub (release + end) for trainer ${String(args.trainerId)} bound to ${args.objectEventId}`,
  } satisfies BinaryWriteBytesEdit);

  // 2. Write the trainer-battle script.
  edits.push({
    kind: 'binary_write_bytes',
    offset: trainerScriptOffset,
    beforeBytes: bytesToHex(new Uint8Array(trainerBattleBytes.length).fill(allocator.fillByteAt(trainerScriptOffset))),
    afterBytes: bytesToHex(trainerBattleBytes),
    requireFreeSlot: true,
    note: `trainerbattle type-3 script for trainer ${String(args.trainerId)} → ${args.objectEventId}`,
  } satisfies BinaryWriteBytesEdit);

  // 3. Patch the ObjectEvent struct's trainer fields in place.
  edits.push({
    kind: 'binary_write_bytes',
    offset: structOffset + OBJ_EVENT_TRAINER_FIELDS_OFFSET,
    beforeBytes: bytesToHex(oldFieldsBytes),
    afterBytes: bytesToHex(newFieldsBytes),
    note: `set trainerType=${String(trainerType)} / sight=${String(sightRange)} / scriptPtr on ${args.objectEventId}`,
  } satisfies BinaryWriteBytesEdit);

  const description =
    args.description ??
    `Bind ${args.objectEventId} as trainer ${String(args.trainerId)} (type ${String(trainerType)}, sight ${String(sightRange)})`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        ...empty,
        objectEventStructOffset: structOffset,
        postBattleScriptOffset: postBattleOffset,
        trainerScriptOffset,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    objectEventId: args.objectEventId,
    trainerId: args.trainerId,
    trainerScriptOffset,
    postBattleScriptOffset: postBattleOffset,
    objectEventStructOffset: structOffset,
    message:
      `Proposed binding ${args.objectEventId} → trainer ${String(args.trainerId)}. ` +
      `Script @ 0x${trainerScriptOffset.toString(16)}, post-battle stub @ 0x${postBattleOffset.toString(16)}. ` +
      `Review the diff and click Apply.`,
  };
}
