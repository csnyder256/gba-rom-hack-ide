/**
 * Gen-3 binary script bytecode encoder - WP-A1 (overhaul plan).
 *
 * The reverse of `binary-script-decoder.ts`. Takes a sequence of
 * `EncodableStep` (kind + params, the shape the decoder emits) and
 * serialises it back to bytecode the engine can execute.
 *
 * This is what makes `propose_script_edit` possible: insert / delete /
 * modify steps in the visual scripter, encode the modified list, write
 * the bytes back to the ROM.
 *
 * Design contract - mirrors the decoder one-for-one:
 *
 *   decode(bytes, offset) ─→ DecodedScriptStep[]
 *   encode(steps)         ─→ bytes
 *   decode(encode(steps)) ≡ steps   (round-trip invariant, asserted by tests)
 *
 * Variable-length data (movement blocks, dialogue text) lives outside
 * the bytecode itself. The encoder doesn't allocate ROM space for those
 * - that's the caller's job. We expose an `EncodeContext.allocate(data)`
 * callback so propose_script_edit can route allocations through its
 * `InBatchAllocator` (mirrors propose-rename.ts's pattern) and feed back
 * a ROM file offset to embed as a pointer.
 *
 * When a step's `params` carry an existing `movementPtr` / `textPtr`
 * AND the data is unchanged (params don't carry new bytes), we PRESERVE
 * the original pointer - no allocation needed. This is the common case
 * for "I'm just adding a new step, the old dialogue lines stay put".
 *
 * Branch targets (goto / call) preserve their original `targetRomPtr`
 * - they only change if the destination script itself was relocated,
 * which is handled by propose-script-edit's pointer-rewrite pass via
 * the manifest's `scriptReferences` index, not here.
 */

import { encodeString } from '../text/codec.js';
import {
  MOVEMENT_END_BYTE,
  branchOperatorToConditionByte,
  getGen3OpcodeSpec,
  getTrainerbattleArgBytes,
  type BranchOperator,
  type Gen3OpcodeSpec,
  type ScriptStepKind,
} from './gen3-script-opcodes.js';

/** GBA ROM base - file offsets become GBA pointers as `offset + GBA_ROM_BASE`. */
export const GBA_ROM_BASE = 0x08000000;

/** Standard msgbox callstd type - defaults to 4 (auto-close) when the
 *  step's params don't carry an explicit `stdType`. Matches the most
 *  common vanilla pattern (used by NPC dialogue lines that close after
 *  the player presses A). */
const DEFAULT_MSGBOX_STD_TYPE = 4;

export interface EncodableStep {
  readonly kind: ScriptStepKind;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AllocateRequest {
  /** What flavour of data this is. Lets the caller route different
   *  allocations to different free-space pools if desired (currently
   *  all flavours share one pool, but the hook makes future
   *  per-pool policies trivial). */
  readonly kind: 'movement' | 'text' | 'raw';
  /** The bytes to write. The allocator returns the ROM file offset
   *  where these bytes will live; the encoder embeds the corresponding
   *  GBA pointer in the bytecode. */
  readonly bytes: Uint8Array;
}

export interface EncodeContext {
  /** Allocator for variable-length data referenced from the bytecode.
   *  Returns a ROM file offset. The encoder converts to a GBA pointer
   *  via `+ GBA_ROM_BASE`. */
  readonly allocate: (req: AllocateRequest) => number;
}

export class ScriptEncodeError extends Error {
  readonly stepIndex: number;
  readonly kind: ScriptStepKind;
  constructor(stepIndex: number, kind: ScriptStepKind, message: string) {
    super(`step ${stepIndex} (${kind}): ${message}`);
    this.name = 'ScriptEncodeError';
    this.stepIndex = stepIndex;
    this.kind = kind;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Low-level writers.
// ──────────────────────────────────────────────────────────────────────

function writeU8(out: number[], v: number): void {
  out.push(v & 0xff);
}
function writeU16LE(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}
function writeU32LE(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function paramU16(step: EncodableStep, key: string, fallback?: number): number {
  const v = step.params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v & 0xffff;
  if (fallback !== undefined) return fallback;
  throw new ScriptEncodeError(-1, step.kind, `missing or invalid u16 param "${key}"`);
}
function paramU8(step: EncodableStep, key: string, fallback?: number): number {
  const v = step.params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v & 0xff;
  if (fallback !== undefined) return fallback;
  throw new ScriptEncodeError(-1, step.kind, `missing or invalid u8 param "${key}"`);
}
function paramU32(step: EncodableStep, key: string, fallback?: number): number {
  const v = step.params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0;
  if (fallback !== undefined) return fallback >>> 0;
  throw new ScriptEncodeError(-1, step.kind, `missing or invalid u32 param "${key}"`);
}

/** Look up an opcode spec by its `name` (the inverse of decode's
 *  `getGen3OpcodeSpec(byte)`). Cached at module load. */
const SPEC_BY_NAME: ReadonlyMap<string, Gen3OpcodeSpec> = (() => {
  const m = new Map<string, Gen3OpcodeSpec>();
  // SPECS is private to gen3-script-opcodes; iterate via the public list.
  for (let opcode = 0; opcode <= 0xff; opcode++) {
    const spec = getGen3OpcodeSpec(opcode);
    if (spec) m.set(spec.name, spec);
  }
  return m;
})();

function specByName(name: string): Gen3OpcodeSpec {
  const s = SPEC_BY_NAME.get(name);
  if (!s) throw new Error(`encoder: no opcode spec for "${name}"`);
  return s;
}

// ──────────────────────────────────────────────────────────────────────
// Per-kind encoders. Each takes (step, ctx) and pushes bytes onto out.
//
// The decoder collapses some multi-opcode patterns (notably msgbox =
// `loadword 0, textPtr; callstd type`) into a single step. The encoder
// must reverse that. Tests round-trip every supported pattern.
// ──────────────────────────────────────────────────────────────────────

function encodeDialogue(out: number[], step: EncodableStep, ctx: EncodeContext): void {
  // msgbox macro = `loadword 0, textPtr` + `callstd stdType`.
  // Round-trip behaviour mirrors applymovement: the decoder populates
  // BOTH `textPtr` and `dialogueText`, so by default we preserve the
  // pointer. The caller signals "I changed the text, allocate fresh"
  // by setting `dialogueDirty: true` OR stripping `textPtr` from
  // params.
  const params = step.params;
  const dialogueText = typeof params['dialogueText'] === 'string' ? (params['dialogueText'] as string) : null;
  const existingTextPtr = typeof params['textPtr'] === 'number' ? (params['textPtr'] as number) : null;
  const dirty = params['dialogueDirty'] === true;
  const stdType = typeof params['stdType'] === 'number' ? (params['stdType'] as number) : DEFAULT_MSGBOX_STD_TYPE;

  let textPtr: number;
  if (existingTextPtr !== null && !dirty) {
    // Common case: preserve original pointer (round-trip + edits to
    // OTHER params only).
    textPtr = existingTextPtr;
  } else if (dialogueText !== null) {
    // User changed the text (dirty=true) OR added a brand-new step
    // (no existingTextPtr). Allocate fresh space.
    const encoded = encodeString(dialogueText);
    const offset = ctx.allocate({ kind: 'text', bytes: encoded });
    textPtr = (offset + GBA_ROM_BASE) >>> 0;
  } else {
    throw new ScriptEncodeError(-1, 'dialogue', 'dialogue step missing both dialogueText and textPtr');
  }

  // loadword 0, textPtr
  writeU8(out, specByName('loadword').opcode); // 0x0f
  writeU8(out, 0); // bank arg
  writeU32LE(out, textPtr);
  // callstd stdType
  writeU8(out, specByName('callstd').opcode); // 0x09
  writeU8(out, stdType & 0xff);
}

function encodeSetFlag(out: number[], step: EncodableStep): void {
  writeU8(out, specByName('setflag').opcode);
  writeU16LE(out, paramU16(step, 'flagId'));
}
function encodeClearFlag(out: number[], step: EncodableStep): void {
  writeU8(out, specByName('clearflag').opcode);
  writeU16LE(out, paramU16(step, 'flagId'));
}

function encodeSetVariable(out: number[], step: EncodableStep): void {
  const opcodeName = typeof step.params['opcodeName'] === 'string' ? (step.params['opcodeName'] as string) : 'setvar';
  const spec = specByName(opcodeName);
  writeU8(out, spec.opcode);
  if (spec.name === 'copyvar' || spec.name === 'copyvarifnotzero') {
    writeU16LE(out, paramU16(step, 'destVar'));
    writeU16LE(out, paramU16(step, 'srcVar'));
  } else {
    writeU16LE(out, paramU16(step, 'varId'));
    writeU16LE(out, paramU16(step, 'value'));
  }
}

function encodeBranch(out: number[], step: EncodableStep): void {
  const opcodeName = typeof step.params['opcodeName'] === 'string' ? (step.params['opcodeName'] as string) : 'goto';
  const spec = specByName(opcodeName);
  writeU8(out, spec.opcode);
  switch (spec.name) {
    case 'call':
    case 'goto':
      writeU32LE(out, paramU32(step, 'targetRomPtr'));
      return;
    case 'goto_if':
    case 'call_if':
      writeU8(out, paramU8(step, 'condition'));
      writeU32LE(out, paramU32(step, 'targetRomPtr'));
      return;
    case 'gotostd':
    case 'callstd':
      writeU8(out, paramU8(step, 'stdScript'));
      return;
    case 'compare':
      writeU16LE(out, paramU16(step, 'varId'));
      writeU16LE(out, paramU16(step, 'value'));
      return;
    case 'checkflag':
      writeU16LE(out, paramU16(step, 'flagId'));
      return;
    case 'checkitem':
      writeU16LE(out, paramU16(step, 'itemId'));
      writeU16LE(out, paramU16(step, 'quantity'));
      return;
    case 'checktrainerflag':
      writeU16LE(out, paramU16(step, 'flagId', paramU16(step, 'trainerId', 0)));
      return;
    default:
      throw new ScriptEncodeError(-1, 'branch', `unknown branch opcode "${spec.name}"`);
  }
}

function encodeGiveItem(out: number[], step: EncodableStep): void {
  const opcodeName = typeof step.params['opcodeName'] === 'string' ? (step.params['opcodeName'] as string) : 'giveitem';
  const spec = specByName(opcodeName);
  writeU8(out, spec.opcode);
  switch (spec.name) {
    case 'giveitem':
      writeU16LE(out, paramU16(step, 'itemId'));
      writeU16LE(out, paramU16(step, 'quantity', 1));
      writeU8(out, paramU8(step, 'callbackType', 0));
      return;
    case 'takeitem':
      writeU16LE(out, paramU16(step, 'itemId'));
      writeU16LE(out, paramU16(step, 'quantity', 1));
      return;
    case 'givemon': {
      // 14-byte struct - preserve raw arg bytes if present, otherwise
      // synth from species/level/item plus zeros. Tests cover both.
      const argBytes = step.params['argBytes'];
      if (Array.isArray(argBytes) && argBytes.length === 14) {
        for (const b of argBytes as number[]) writeU8(out, b & 0xff);
        return;
      }
      const species = paramU16(step, 'speciesId', paramU16(step, 'species', 0));
      const level = paramU8(step, 'level', 5);
      const item = paramU16(step, 'itemId', 0);
      writeU16LE(out, species);
      writeU8(out, level);
      writeU16LE(out, item);
      // Pad the remaining 9 bytes with zeros (unused engine slots).
      for (let i = 0; i < 9; i++) writeU8(out, 0);
      return;
    }
    default:
      throw new ScriptEncodeError(-1, 'give_item', `unknown give_item opcode "${spec.name}"`);
  }
}

function encodeStartBattle(out: number[], step: EncodableStep): void {
  const spec = specByName('trainerbattle');
  writeU8(out, spec.opcode);
  const battleType = paramU8(step, 'battleType', 0);
  writeU8(out, battleType);
  // Variable encoding - preserve trainer + remaining bytes from
  // decoder's params. trainerbattle's full layout is complex and we
  // don't fully model every type byte's args. The decoder stashes the
  // trainerId and (for now) leaves the rest as raw bytes if needed.
  // For typical "battle this trainer" edits where only the trainerId
  // changes, this is sufficient.
  writeU16LE(out, paramU16(step, 'trainerId', 0));
  // Remaining type-specific bytes preserved from original if present.
  // The decoder stashes them as `trainerbattleRemainder`, so a decoded
  // step round-trips byte-for-byte (the intro/defeat/victory pointers are
  // not zero-filled). When absent we pad to the format's true length using
  // the single shared source of truth.
  const remainder = step.params['trainerbattleRemainder'];
  if (Array.isArray(remainder)) {
    for (const b of remainder as number[]) writeU8(out, b & 0xff);
  } else {
    // Fall back: pad with zeros per the type byte's known arg count.
    // `getTrainerbattleArgBytes` is the byte count AFTER the opcode, and
    // we've already written the type byte (1) + trainerId (2).
    const total = getTrainerbattleArgBytes(battleType);
    const remainingArgBytes = Math.max(0, total - 3);
    for (let i = 0; i < remainingArgBytes; i++) writeU8(out, 0);
  }
}

function encodePlaySound(out: number[], step: EncodableStep): void {
  const opcodeName = typeof step.params['opcodeName'] === 'string' ? (step.params['opcodeName'] as string) : 'playse';
  const spec = specByName(opcodeName);
  writeU8(out, spec.opcode);
  switch (spec.name) {
    case 'playse':
    case 'playfanfare':
      writeU16LE(out, paramU16(step, 'songId'));
      return;
    case 'fadenewbgm':
      writeU16LE(out, paramU16(step, 'songId'));
      return;
    case 'playbgm':
      writeU16LE(out, paramU16(step, 'songId'));
      writeU8(out, paramU8(step, 'unknown', 0));
      return;
    case 'waitse':
    case 'waitfanfare':
    case 'fadedefaultbgm':
      return; // 0-arg
    default:
      throw new ScriptEncodeError(-1, 'play_sound', `unknown audio opcode "${spec.name}"`);
  }
}

function encodeMoveNpc(out: number[], step: EncodableStep, ctx: EncodeContext): void {
  const opcodeName = typeof step.params['opcodeName'] === 'string' ? (step.params['opcodeName'] as string) : 'applymovement';
  const spec = specByName(opcodeName);
  writeU8(out, spec.opcode);
  switch (spec.name) {
    case 'applymovement': {
      writeU16LE(out, paramU16(step, 'objectId'));
      // Movement block: the decoder always populates BOTH `movementPtr`
      // (the original ROM pointer) AND `movementSequence` (the decoded
      // bytes). Round-trip behaviour: prefer the existing pointer so
      // re-encoding a decoded script doesn't re-allocate. The caller
      // signals "I changed the movement, allocate fresh" by either
      // stripping `movementPtr` from params OR setting `movementDirty:
      // true`.
      const newSeq = step.params['movementSequence'];
      const existingPtr = typeof step.params['movementPtr'] === 'number' ? (step.params['movementPtr'] as number) : null;
      const dirty = step.params['movementDirty'] === true;
      let movePtr: number;
      if (existingPtr !== null && !dirty) {
        movePtr = existingPtr;
      } else if (Array.isArray(newSeq) && newSeq.length > 0) {
        const seq = newSeq as ReadonlyArray<number>;
        const block = new Uint8Array(seq.length + 1);
        for (let i = 0; i < seq.length; i++) block[i] = seq[i]! & 0xff;
        block[seq.length] = MOVEMENT_END_BYTE;
        const offset = ctx.allocate({ kind: 'movement', bytes: block });
        movePtr = (offset + GBA_ROM_BASE) >>> 0;
      } else if (existingPtr !== null) {
        movePtr = existingPtr;
      } else {
        throw new ScriptEncodeError(-1, 'move_npc', 'applymovement step missing both movementPtr and movementSequence');
      }
      writeU32LE(out, movePtr);
      return;
    }
    case 'waitmovement':
      writeU16LE(out, paramU16(step, 'objectId'));
      return;
    case 'removeobject':
    case 'addobject':
      writeU16LE(out, paramU16(step, 'objectId'));
      return;
    case 'turnobject':
      writeU16LE(out, paramU16(step, 'objectId'));
      writeU8(out, paramU8(step, 'direction', 0));
      return;
    default:
      throw new ScriptEncodeError(-1, 'move_npc', `unknown move_npc opcode "${spec.name}"`);
  }
}

function encodeFadeScene(out: number[], step: EncodableStep): void {
  const opcodeName = typeof step.params['opcodeName'] === 'string' ? (step.params['opcodeName'] as string) : 'fadescreen';
  const spec = specByName(opcodeName);
  writeU8(out, spec.opcode);
  switch (spec.name) {
    case 'fadescreen':
      writeU8(out, paramU8(step, 'fadeType'));
      return;
    case 'fadescreenspeed':
      writeU8(out, paramU8(step, 'fadeType'));
      writeU8(out, paramU8(step, 'speed', 0));
      return;
    default:
      throw new ScriptEncodeError(-1, 'fade_scene', `unknown fade opcode "${spec.name}"`);
  }
}

function encodeWarpPlayer(out: number[], step: EncodableStep): void {
  const opcodeName = typeof step.params['opcodeName'] === 'string' ? (step.params['opcodeName'] as string) : 'warp';
  const spec = specByName(opcodeName);
  writeU8(out, spec.opcode);
  switch (spec.name) {
    case 'warp':
    case 'warpsilent':
    case 'warpdoor':
    case 'warpteleport':
      writeU8(out, paramU8(step, 'destMapBank'));
      writeU8(out, paramU8(step, 'destMapNum'));
      writeU8(out, paramU8(step, 'warpId', 0));
      writeU16LE(out, paramU16(step, 'x'));
      writeU16LE(out, paramU16(step, 'y'));
      return;
    case 'warphole':
      writeU8(out, paramU8(step, 'destMapBank'));
      writeU8(out, paramU8(step, 'destMapNum'));
      return;
    default:
      throw new ScriptEncodeError(-1, 'warp_player', `unknown warp opcode "${spec.name}"`);
  }
}

function encodeRandomizeBranch(out: number[], step: EncodableStep): void {
  writeU8(out, specByName('random').opcode);
  writeU16LE(out, paramU16(step, 'range'));
}

/**
 * Encode a `branch_on_var` step - the editor's "if VAR ≥ N → jump" primitive.
 * Emits the 11-byte vanilla bytecode pattern:
 *   compare  varId, value     (5 bytes)
 *   goto_if  condition, target (6 bytes)
 *
 * The decoder recognises the pattern and reifies it back into a single
 * branch_on_var step - round-trip is byte-stable.
 *
 * Params (Object-keyed; trusted shape; the propose tool validates):
 *  - `varId`: u16 - the variable to read (e.g. 0x40D0 for VAR_RA_EMO_LOG)
 *  - `value`: u16 - the value to compare against
 *  - `operator`: BranchOperator - 'less' | 'equal' | 'greater' |
 *      'lessorequal' | 'greaterorequal' | 'notequal'
 *  - `targetRomPtr`: u32 - the GBA pointer the jump targets when the
 *      condition is satisfied. The propose tool resolves a target step id
 *      to a ROM pointer before calling the encoder.
 */
function encodeBranchOnVar(out: number[], step: EncodableStep): void {
  const varId = paramU16(step, 'varId');
  const value = paramU16(step, 'value');
  const operatorRaw = step.params['operator'];
  if (typeof operatorRaw !== 'string') {
    throw new ScriptEncodeError(-1, 'branch_on_var', 'missing or invalid string param "operator"');
  }
  const condition = branchOperatorToConditionByte(operatorRaw as BranchOperator);
  if (typeof condition !== 'number') {
    throw new ScriptEncodeError(
      -1,
      'branch_on_var',
      `unknown operator "${operatorRaw}" (expected one of less | equal | greater | lessorequal | greaterorequal | notequal)`,
    );
  }
  const targetRomPtr = paramU32(step, 'targetRomPtr');

  // compare varId, value
  writeU8(out, specByName('compare').opcode); // 0x21
  writeU16LE(out, varId);
  writeU16LE(out, value);
  // goto_if condition, targetRomPtr
  writeU8(out, specByName('goto_if').opcode); // 0x06
  writeU8(out, condition & 0xff);
  writeU32LE(out, targetRomPtr);
}

/** Raw / unrecognised opcode - preserve original bytes verbatim. Used
 *  for opcodes the decoder didn't categorise (kind = 'raw'). */
function encodeRaw(out: number[], step: EncodableStep): void {
  const opcode = paramU8(step, 'opcode', NaN);
  if (!Number.isFinite(opcode)) {
    throw new ScriptEncodeError(-1, 'raw', 'raw step missing opcode byte');
  }
  writeU8(out, opcode);
  const argBytes = step.params['argBytes'];
  if (Array.isArray(argBytes)) {
    for (const b of argBytes as number[]) writeU8(out, b & 0xff);
  }
  // Some raw opcodes might be zero-arg control flow (lock, release, etc.)
  // - the decoder doesn't add argBytes in that case.
}

// ──────────────────────────────────────────────────────────────────────
// Top-level dispatch.
// ──────────────────────────────────────────────────────────────────────

/** Encode a single step. */
export function encodeStep(step: EncodableStep, ctx: EncodeContext): Uint8Array {
  const out: number[] = [];
  try {
    switch (step.kind) {
      case 'dialogue':
        encodeDialogue(out, step, ctx);
        break;
      case 'set_flag':
        encodeSetFlag(out, step);
        break;
      case 'clear_flag':
        encodeClearFlag(out, step);
        break;
      case 'set_variable':
        encodeSetVariable(out, step);
        break;
      case 'branch':
        encodeBranch(out, step);
        break;
      case 'give_item':
        encodeGiveItem(out, step);
        break;
      case 'start_battle':
        encodeStartBattle(out, step);
        break;
      case 'play_sound':
        encodePlaySound(out, step);
        break;
      case 'move_npc':
        encodeMoveNpc(out, step, ctx);
        break;
      case 'fade_scene':
        encodeFadeScene(out, step);
        break;
      case 'warp_player':
        encodeWarpPlayer(out, step);
        break;
      case 'randomize_branch':
        encodeRandomizeBranch(out, step);
        break;
      case 'branch_on_var':
        encodeBranchOnVar(out, step);
        break;
      case 'raw':
        encodeRaw(out, step);
        break;
      default: {
        // Unreachable - exhaust all ScriptStepKind variants.
        const _exhaustive: never = step.kind;
        throw new ScriptEncodeError(-1, step.kind as ScriptStepKind, `unknown step kind ${String(_exhaustive)}`);
      }
    }
  } catch (e) {
    if (e instanceof ScriptEncodeError) throw e;
    throw new ScriptEncodeError(-1, step.kind, e instanceof Error ? e.message : String(e));
  }
  return new Uint8Array(out);
}

/** Encode a full script. Concatenates per-step encodings + emits a
 *  final `end` opcode unless the last step is already a terminator. */
export function encodeScript(
  steps: ReadonlyArray<EncodableStep>,
  ctx: EncodeContext,
): Uint8Array {
  const out: number[] = [];
  let lastEndedTerminator = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    try {
      const stepBytes = encodeStep(step, ctx);
      for (const b of stepBytes) out.push(b);
      lastEndedTerminator = isTerminator(step);
    } catch (e) {
      if (e instanceof ScriptEncodeError) {
        // Re-throw with the real stepIndex.
        throw new ScriptEncodeError(i, e.kind, e.message);
      }
      throw e;
    }
  }
  if (!lastEndedTerminator) {
    // Append `end` (0x02) so the engine doesn't run off into garbage.
    writeU8(out, specByName('end').opcode);
  }
  return new Uint8Array(out);
}

function isTerminator(step: EncodableStep): boolean {
  if (step.kind === 'raw') {
    const opcode = step.params['opcode'];
    if (typeof opcode === 'number') {
      const spec = getGen3OpcodeSpec(opcode);
      if (spec && (spec.name === 'end' || spec.name === 'return')) return true;
    }
    return false;
  }
  // Branch steps that are unconditional `goto` don't return; `end` /
  // `return` are encoded as raw kind by the decoder. So no other kind
  // is a terminator.
  return false;
}

/** Convenience adapter: take a DecodedScriptStep[] from the decoder
 *  and feed it to encodeScript without copying. */
export function encodeDecodedSteps(
  decodedSteps: ReadonlyArray<{ readonly kind: ScriptStepKind; readonly params: Readonly<Record<string, unknown>> }>,
  ctx: EncodeContext,
): Uint8Array {
  return encodeScript(decodedSteps, ctx);
}
