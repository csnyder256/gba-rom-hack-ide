/**
 * Gen-3 binary script bytecode decoder - Phase H-RC1 (semantic-world
 * plan §H.1).
 *
 * Walks the bytes at a given script entrypoint in the ROM and emits
 * a typed sequence of decoded steps suitable for direct lift into
 * `manifest.scriptSteps[]`. Each step carries a `ScriptStepKind`
 * (msgbox/setflag/movement/etc.) and a `params` bag with the decoded
 * arguments - including, for msgbox, the actual decoded dialogue
 * text resolved via the existing Gen-3 codec.
 *
 * This is what turns `Script @ 0x16582f` in the inspector into a
 * readable step-list:
 *
 *   Lock player
 *   Face player
 *   Msgbox: "Hello, my name is Mom!"
 *   Release
 *   End
 *
 * Scope (Phase H-RC1):
 *  - Recognizes ~50 most common FRLG/Emerald opcodes (see
 *    `gen3-script-opcodes.ts`). Unknown opcodes emit as `kind: 'raw'`
 *    with their hex name + arg bytes, so the operator sees them
 *    rather than getting silent truncation.
 *  - Detects the `loadword 0, PTR; callstd TYPE` pattern (vanilla
 *    `msgbox` macro expansion) and emits a single `kind: 'dialogue'`
 *    step with the resolved text.
 *  - Decodes applymovement's referenced movement-data block (variable
 *    length, 0xFE-terminated) into a byte sequence stashed on the
 *    step's params.
 *  - Decodes trainerbattle's variable-length encoding per its type
 *    byte (see `getTrainerbattleArgBytes`).
 *  - Does NOT follow goto/call branches - captures the destination
 *    pointer on the step but doesn't recursively walk. (The editor
 *    can offer a "follow goto" navigation affordance separately.)
 *  - Caps at MAX_OPCODES_PER_SCRIPT to avoid runaway walks on
 *    corrupted data.
 */

import { decodeString } from '../text/codec.js';
import {
  MSGBOX_CALLSTD_TYPES,
  MOVEMENT_END_BYTE,
  BRANCH_OPERATOR_SYMBOLS,
  conditionByteToBranchOperator,
  getGen3OpcodeSpec,
  getTrainerbattleArgBytes,
  type BranchOperator,
  type Gen3OpcodeSpec,
  type ScriptStepKind,
} from './gen3-script-opcodes.js';

export type { ScriptStepKind };

/** Maximum opcodes to decode from a single entrypoint. Vanilla
 *  NPC scripts are typically < 50 opcodes; 256 gives slack while
 *  preventing infinite walks into garbage data. */
export const MAX_OPCODES_PER_SCRIPT = 256;

/** GBA ROM mirror range - pointer args must fall in here or be 0. */
const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

/** Max bytes to decode from a msgbox text pointer. Vanilla messages
 *  rarely exceed 250 chars; 512 covers Pokédex-length text too. */
const MSGBOX_TEXT_MAX_BYTES = 512;

/** Max bytes to read in an applymovement data block before bailing. */
const MOVEMENT_MAX_BYTES = 256;

export interface DecodedScriptStep {
  /** Sequence index within the script (0-based). */
  readonly index: number;
  /** File offset of the opcode byte in the ROM. */
  readonly fileOffset: number;
  /** ScriptStepKind for the editor's vocabulary. */
  readonly kind: ScriptStepKind;
  /** Display label ("Lock player", "Msgbox: ...", etc.). */
  readonly label: string;
  /** Decoded parameters (opcode-specific). */
  readonly params: Readonly<Record<string, unknown>>;
}

export type DecodeStopReason =
  | 'terminator'   // hit `end` / `endram` / similar
  | 'max_opcodes'  // hit the cap
  | 'out_of_bounds'// walked off the end of the ROM
  | 'invalid_offset'; // entry offset is bogus

export interface DecodedScript {
  readonly entryFileOffset: number;
  readonly steps: ReadonlyArray<DecodedScriptStep>;
  readonly bytesConsumed: number;
  readonly stoppedReason: DecodeStopReason;
}

function readU16LE(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

function readU32LE(b: Uint8Array, off: number): number {
  return (
    (b[off]! |
      (b[off + 1]! << 8) |
      (b[off + 2]! << 16) |
      (b[off + 3]! << 24)) >>> 0
  );
}

function ptrToFileOffset(ptr: number, romLen: number): number {
  if (ptr === 0 || ptr < GBA_ROM_BASE || ptr >= GBA_ROM_END_EXCLUSIVE) return -1;
  const off = ptr - GBA_ROM_BASE;
  return off < romLen ? off : -1;
}

/** Decode the movement-data block at `ptr`. Returns an array of
 *  movement-command bytes, terminated by 0xFE (the end marker - 
 *  not included in the output). Returns empty when the pointer is
 *  invalid or the block runs past EOF. */
function decodeMovementBlock(bytes: Uint8Array, ptr: number): ReadonlyArray<number> {
  const off = ptrToFileOffset(ptr, bytes.length);
  if (off < 0) return [];
  const cmds: number[] = [];
  for (let i = 0; i < MOVEMENT_MAX_BYTES; i++) {
    if (off + i >= bytes.length) break;
    const b = bytes[off + i]!;
    if (b === MOVEMENT_END_BYTE) break;
    cmds.push(b);
  }
  return Object.freeze(cmds);
}

/** Decode the Gen-3 string at `ptr` via the engine codec. Returns
 *  null if the pointer is invalid. */
function decodeMsgboxText(bytes: Uint8Array, ptr: number): string | null {
  const off = ptrToFileOffset(ptr, bytes.length);
  if (off < 0) return null;
  return decodeString(bytes, off, MSGBOX_TEXT_MAX_BYTES);
}

/**
 * Build params for a recognized opcode + its arg bytes.
 */
function buildKnownParams(
  bytes: Uint8Array,
  spec: Gen3OpcodeSpec,
  argStart: number,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    opcode: spec.opcode,
    opcodeName: spec.name,
  };
  switch (spec.name) {
    case 'setflag':
    case 'clearflag':
    case 'checkflag':
      params.flagId = readU16LE(bytes, argStart);
      params.flagIdHex = `0x${(params.flagId as number).toString(16)}`;
      break;
    case 'setvar':
    case 'addvar':
    case 'subvar':
      params.varId = readU16LE(bytes, argStart);
      params.value = readU16LE(bytes, argStart + 2);
      break;
    case 'copyvar':
    case 'copyvarifnotzero':
      params.destVar = readU16LE(bytes, argStart);
      params.srcVar = readU16LE(bytes, argStart + 2);
      break;
    case 'compare':
      params.varId = readU16LE(bytes, argStart);
      params.value = readU16LE(bytes, argStart + 2);
      break;
    case 'call':
    case 'goto': {
      const ptr = readU32LE(bytes, argStart);
      params.targetRomPtr = ptr;
      params.targetFileOffset = ptrToFileOffset(ptr, bytes.length);
      break;
    }
    case 'goto_if':
    case 'call_if': {
      params.condition = bytes[argStart]!;
      const ptr = readU32LE(bytes, argStart + 1);
      params.targetRomPtr = ptr;
      params.targetFileOffset = ptrToFileOffset(ptr, bytes.length);
      break;
    }
    case 'gotostd':
    case 'callstd':
      params.stdScript = bytes[argStart]!;
      break;
    case 'playse':
    case 'playfanfare':
    case 'fadenewbgm':
      params.songId = readU16LE(bytes, argStart);
      break;
    case 'warp':
    case 'warpsilent':
    case 'warpdoor':
    case 'warpteleport':
      params.destMapBank = bytes[argStart]!;
      params.destMapNum = bytes[argStart + 1]!;
      params.warpId = bytes[argStart + 2]!;
      params.x = readU16LE(bytes, argStart + 3);
      params.y = readU16LE(bytes, argStart + 5);
      break;
    case 'giveitem':
      params.itemId = readU16LE(bytes, argStart);
      params.quantity = readU16LE(bytes, argStart + 2);
      params.callbackType = bytes[argStart + 4]!;
      break;
    case 'takeitem':
      params.itemId = readU16LE(bytes, argStart);
      params.quantity = readU16LE(bytes, argStart + 2);
      break;
    case 'checkitem':
      params.itemId = readU16LE(bytes, argStart);
      params.quantity = readU16LE(bytes, argStart + 2);
      break;
    case 'applymovement': {
      params.objectId = readU16LE(bytes, argStart);
      const movePtr = readU32LE(bytes, argStart + 2);
      params.movementPtr = movePtr;
      params.movementSequence = decodeMovementBlock(bytes, movePtr);
      break;
    }
    case 'waitmovement':
      params.objectId = readU16LE(bytes, argStart);
      break;
    case 'message': {
      // Standalone message opcode (rare in FRLG; usually msgbox macro
      // is used instead). Treat as dialogue with empty text - the
      // macro pattern (loadword + callstd) is detected separately.
      const ptr = readU32LE(bytes, argStart);
      params.textPtr = ptr;
      params.dialogueText = decodeMsgboxText(bytes, ptr) ?? '';
      break;
    }
    case 'fadescreen':
      params.fadeType = bytes[argStart]!;
      break;
    case 'random':
      params.range = readU16LE(bytes, argStart);
      break;
    case 'loadword':
      params.bank = bytes[argStart]!;
      params.value = readU32LE(bytes, argStart + 1);
      break;
    default:
      // Generic - stash raw arg bytes for inspection.
      if (spec.argBytes > 0) {
        const args: number[] = [];
        for (let i = 0; i < spec.argBytes; i++) {
          if (argStart + i >= bytes.length) break;
          args.push(bytes[argStart + i]!);
        }
        params.argBytes = Object.freeze(args);
      }
      break;
  }
  return params;
}

/** Format a friendly label for a step, given its decoded params. */
function formatLabel(spec: Gen3OpcodeSpec, params: Record<string, unknown>): string {
  switch (spec.name) {
    case 'setflag':
      return `Set flag ${params.flagIdHex ?? ''}`;
    case 'clearflag':
      return `Clear flag ${params.flagIdHex ?? ''}`;
    case 'checkflag':
      return `Check flag ${params.flagIdHex ?? ''}`;
    case 'setvar':
      return `Set var 0x${((params.varId as number) ?? 0).toString(16)} = ${String(params.value)}`;
    case 'compare':
      return `Compare var 0x${((params.varId as number) ?? 0).toString(16)} to ${String(params.value)}`;
    case 'giveitem':
      return `Give item #${String(params.itemId)} × ${String(params.quantity)}`;
    case 'applymovement': {
      const obj = String(params.objectId ?? '?');
      const seq = params.movementSequence as ReadonlyArray<number> | undefined;
      return `Move object ${obj} (${seq?.length ?? 0} steps)`;
    }
    case 'waitmovement':
      return `Wait for object ${String(params.objectId ?? '?')} movement`;
    case 'warp':
    case 'warpsilent':
    case 'warpdoor':
    case 'warpteleport':
      return `${spec.label} → map ${String(params.destMapBank)}.${String(params.destMapNum)} warp #${String(params.warpId)}`;
    case 'playse':
    case 'playfanfare':
      return `${spec.label} #${String(params.songId)}`;
    case 'message':
      return params.dialogueText
        ? `Msgbox: "${String(params.dialogueText).slice(0, 60)}${String(params.dialogueText).length > 60 ? '…' : ''}"`
        : spec.label;
    default:
      return spec.label;
  }
}

/**
 * Decode a script's bytecode starting at `entryFileOffset`. Returns
 * the decoded step list + the bytes consumed + why decoding stopped.
 */
export function decodeBinaryScript(
  bytes: Uint8Array,
  entryFileOffset: number,
): DecodedScript {
  if (entryFileOffset < 0 || entryFileOffset >= bytes.length) {
    return {
      entryFileOffset,
      steps: Object.freeze([]),
      bytesConsumed: 0,
      stoppedReason: 'invalid_offset',
    };
  }

  const steps: DecodedScriptStep[] = [];
  let cursor = entryFileOffset;
  let stoppedReason: DecodeStopReason = 'max_opcodes';

  while (steps.length < MAX_OPCODES_PER_SCRIPT) {
    if (cursor >= bytes.length) {
      stoppedReason = 'out_of_bounds';
      break;
    }
    const opcode = bytes[cursor]!;
    const spec = getGen3OpcodeSpec(opcode);

    if (spec === null) {
      // Unknown opcode - emit as raw with a single byte consumed.
      // We don't know how many args follow, so conservatively skip
      // just the opcode byte and continue. This may produce a noisy
      // step list past the true script end but won't crash.
      steps.push({
        index: steps.length,
        fileOffset: cursor,
        kind: 'raw',
        label: `Unknown opcode 0x${opcode.toString(16).padStart(2, '0')}`,
        params: Object.freeze({ opcode, opcodeName: 'unknown' }),
      });
      cursor += 1;
      continue;
    }

    const argStart = cursor + 1;

    // Variable-encoding opcodes first.
    if (spec.name === 'trainerbattle') {
      if (argStart >= bytes.length) {
        stoppedReason = 'out_of_bounds';
        break;
      }
      const typeByte = bytes[argStart]!;
      const totalBytes = getTrainerbattleArgBytes(typeByte);
      const params: Record<string, unknown> = {
        opcode,
        opcodeName: spec.name,
        battleType: typeByte,
      };
      if (totalBytes >= 3) {
        params.trainerId = readU16LE(bytes, argStart + 1);
        // Preserve the type-specific argument bytes verbatim (the intro /
        // defeat / victory speech pointers etc.) so re-encoding this step
        // writes the original bytes back instead of zero-filling the
        // pointers. The encoder consumes this as `trainerbattleRemainder`.
        const remainderEnd = Math.min(argStart + totalBytes, bytes.length);
        params.trainerbattleRemainder = Array.from(
          bytes.subarray(argStart + 3, remainderEnd),
        );
      }
      steps.push({
        index: steps.length,
        fileOffset: cursor,
        kind: 'start_battle',
        label: `Trainer battle (type ${typeByte}, trainer #${String(params.trainerId ?? '?')})`,
        params: Object.freeze(params),
      });
      cursor = argStart + totalBytes;
      continue;
    }

    // Bounds check arg bytes.
    const argBytes = spec.argBytes < 0 ? 0 : spec.argBytes;
    if (argStart + argBytes > bytes.length) {
      stoppedReason = 'out_of_bounds';
      break;
    }

    // Detect "branch_on_var" pattern: compare varId, value; goto_if cond, target.
    // 11 bytes total - `compare` (5) + `goto_if` (6). Collapsed into one
    // step the editor can render as "If VAR ≥ N → 0x12345" rather than
    // two opaque `branch` cards. The encoder reverses this for round-trip.
    //
    // We only collapse when:
    //   - the goto_if's condition byte maps to a known operator (0..5),
    //   - both arg ranges fit inside the byte stream.
    // Anything else falls through to the per-opcode emission below.
    if (
      spec.name === 'compare' &&
      argBytes >= 4 &&
      argStart + 4 < bytes.length
    ) {
      const afterCompare = argStart + 4;
      const nextOpcode = bytes[afterCompare]!;
      const nextSpec = getGen3OpcodeSpec(nextOpcode);
      if (
        nextSpec !== null &&
        nextSpec.name === 'goto_if' &&
        afterCompare + 5 < bytes.length
      ) {
        const condition = bytes[afterCompare + 1]!;
        const operator: BranchOperator | null = conditionByteToBranchOperator(condition);
        if (operator !== null) {
          const varId = readU16LE(bytes, argStart);
          const value = readU16LE(bytes, argStart + 2);
          const targetRomPtr = readU32LE(bytes, afterCompare + 2);
          const targetFileOffset = ptrToFileOffset(targetRomPtr, bytes.length);
          const sym = BRANCH_OPERATOR_SYMBOLS[operator];
          steps.push({
            index: steps.length,
            fileOffset: cursor,
            kind: 'branch_on_var',
            label: `If var 0x${varId.toString(16)} ${sym} ${String(value)} → 0x${targetRomPtr.toString(16)}`,
            params: Object.freeze({
              varId,
              value,
              operator,
              condition,
              targetRomPtr,
              targetFileOffset,
            }),
          });
          cursor = afterCompare + 6;
          continue;
        }
      }
    }

    // Detect msgbox pattern: loadword 0, PTR; callstd TYPE.
    if (
      spec.name === 'loadword' &&
      argBytes >= 5 &&
      bytes[argStart] === 0 // bank 0 = string-data slot used by msgbox
    ) {
      const textPtr = readU32LE(bytes, argStart + 1);
      const afterLoadword = argStart + 5;
      // Peek at the next opcode.
      if (afterLoadword < bytes.length) {
        const nextOpcode = bytes[afterLoadword]!;
        const nextSpec = getGen3OpcodeSpec(nextOpcode);
        if (
          nextSpec !== null &&
          (nextSpec.name === 'callstd' || nextSpec.name === 'gotostd') &&
          afterLoadword + 1 < bytes.length
        ) {
          const stdType = bytes[afterLoadword + 1]!;
          if (MSGBOX_CALLSTD_TYPES.includes(stdType)) {
            const text = decodeMsgboxText(bytes, textPtr) ?? '';
            steps.push({
              index: steps.length,
              fileOffset: cursor,
              kind: 'dialogue',
              label: text
                ? `Msgbox: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`
                : 'Msgbox (empty)',
              params: Object.freeze({
                opcode,
                opcodeName: 'msgbox',
                textPtr,
                textFileOffset: ptrToFileOffset(textPtr, bytes.length),
                dialogueText: text,
                stdType,
              }),
            });
            cursor = afterLoadword + 2;
            continue;
          }
        }
      }
    }

    // Standard case.
    const params = buildKnownParams(bytes, spec, argStart);
    const kind: ScriptStepKind = spec.kind ?? 'raw';
    steps.push({
      index: steps.length,
      fileOffset: cursor,
      kind,
      label: formatLabel(spec, params),
      params: Object.freeze(params),
    });
    cursor = argStart + argBytes;

    // Stop on terminators.
    if (spec.name === 'end' || spec.name === 'endram' || spec.name === 'return') {
      stoppedReason = 'terminator';
      break;
    }
  }

  return {
    entryFileOffset,
    steps: Object.freeze(steps),
    bytesConsumed: cursor - entryFileOffset,
    stoppedReason,
  };
}
