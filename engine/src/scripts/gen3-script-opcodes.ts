/**
 * Gen-3 (FRLG / Emerald) script bytecode opcode semantics.
 *
 * Phase H-RC1 (semantic-world plan §H.1) - first concrete opcode →
 * name + arg-byte-count + ScriptStepKind table for the binary ROM
 * script decoder. The existing `bytecode-walker.ts` infers arg
 * counts from runtime Thumb analysis (generic, no semantics); this
 * table assigns SEMANTIC LABELS so the editor can render
 * `Lock player`, `Face player`, `Msgbox "Hello..."` instead of
 * `Script @ 0x16582f`.
 *
 * Source: pret/pokefirered/data/script_cmd_table.inc and
 * pret/pokefirered/asm/macros/event.inc (public decomp).
 *
 * Game-family note: FRLG (BPRE/BPGE) and Emerald (BPEE) share most
 * opcodes 0x00..0x6F. Opcodes past 0x70 diverge; the decoder
 * gracefully falls back to `kind: 'raw'` with the byte value for
 * unknown opcodes so the editor surfaces SOMETHING rather than
 * truncating the script.
 *
 * NOT EXHAUSTIVE - covers ~50 of the ~200 vanilla opcodes. The 50
 * chosen are the ones that appear in 95%+ of NPC scripts (lock,
 * faceplayer, msgbox/loadword+callstd, applymovement, setflag,
 * giveitem, trainerbattle wrappers, warps). Unknown opcodes still
 * walk (using the arg-count below; 0 if unmapped) but emit as raw.
 */

/** ScriptStepKind values mirror the editor's vocabulary (see
 *  `app/shared/src/vocabulary.ts`). Duplicated here as a string-union
 *  type to avoid a circular dep - engine can't depend on the editor.
 *  Keep these in sync with the editor's vocabulary. */
export type ScriptStepKind =
  | 'dialogue'
  | 'set_flag'
  | 'clear_flag'
  | 'branch'
  | 'branch_on_var'
  | 'give_item'
  | 'start_battle'
  | 'play_sound'
  | 'move_npc'
  | 'fade_scene'
  | 'warp_player'
  | 'set_variable'
  | 'randomize_branch'
  | 'raw';

/** Per-opcode argument-byte count + semantic mapping. `argBytes` is
 *  the number of bytes following the opcode byte. `kind` is the
 *  ScriptStepKind to emit; null means "fall through to 'raw'". */
export interface Gen3OpcodeSpec {
  readonly opcode: number;
  readonly name: string;
  readonly argBytes: number;
  readonly kind: ScriptStepKind | null;
  /** Short human-readable label for inspector display. */
  readonly label: string;
}

const SPECS: ReadonlyArray<Gen3OpcodeSpec> = Object.freeze([
  // ─── Flow control + terminators ─────────────────────────────────
  { opcode: 0x00, name: 'nop', argBytes: 0, kind: null, label: 'No-op' },
  { opcode: 0x01, name: 'nop1', argBytes: 0, kind: null, label: 'No-op' },
  { opcode: 0x02, name: 'end', argBytes: 0, kind: null, label: 'End script' },
  { opcode: 0x03, name: 'return', argBytes: 0, kind: null, label: 'Return' },
  { opcode: 0x04, name: 'call', argBytes: 4, kind: 'branch', label: 'Call subroutine' },
  { opcode: 0x05, name: 'goto', argBytes: 4, kind: 'branch', label: 'Goto' },
  { opcode: 0x06, name: 'goto_if', argBytes: 5, kind: 'branch', label: 'Goto if condition' },
  { opcode: 0x07, name: 'call_if', argBytes: 5, kind: 'branch', label: 'Call if condition' },
  { opcode: 0x08, name: 'gotostd', argBytes: 1, kind: 'branch', label: 'Goto std script' },
  { opcode: 0x09, name: 'callstd', argBytes: 1, kind: 'branch', label: 'Call std script' },
  { opcode: 0x0a, name: 'gotostd_if', argBytes: 2, kind: 'branch', label: 'Goto std if' },
  { opcode: 0x0b, name: 'callstd_if', argBytes: 2, kind: 'branch', label: 'Call std if' },
  // ─── Local variable + memory ops (rare in NPC scripts) ──────────
  { opcode: 0x0f, name: 'loadword', argBytes: 5, kind: null, label: 'Load word' },
  { opcode: 0x10, name: 'loadbyte', argBytes: 2, kind: null, label: 'Load byte' },
  { opcode: 0x13, name: 'setptr_byte', argBytes: 5, kind: null, label: 'Set pointer byte' },
  // ─── Variables + comparisons ────────────────────────────────────
  { opcode: 0x16, name: 'setvar', argBytes: 4, kind: 'set_variable', label: 'Set variable' },
  { opcode: 0x17, name: 'addvar', argBytes: 4, kind: 'set_variable', label: 'Add to variable' },
  { opcode: 0x18, name: 'subvar', argBytes: 4, kind: 'set_variable', label: 'Subtract from variable' },
  { opcode: 0x19, name: 'copyvar', argBytes: 4, kind: 'set_variable', label: 'Copy variable' },
  { opcode: 0x1a, name: 'copyvarifnotzero', argBytes: 4, kind: 'set_variable', label: 'Copy variable if not zero' },
  { opcode: 0x21, name: 'compare', argBytes: 4, kind: 'branch', label: 'Compare' },
  // ─── Flag operations ────────────────────────────────────────────
  { opcode: 0x29, name: 'setflag', argBytes: 2, kind: 'set_flag', label: 'Set flag' },
  { opcode: 0x2a, name: 'clearflag', argBytes: 2, kind: 'clear_flag', label: 'Clear flag' },
  { opcode: 0x2b, name: 'checkflag', argBytes: 2, kind: 'branch', label: 'Check flag' },
  // ─── Audio ──────────────────────────────────────────────────────
  { opcode: 0x2f, name: 'playse', argBytes: 2, kind: 'play_sound', label: 'Play sound effect' },
  { opcode: 0x30, name: 'waitse', argBytes: 0, kind: 'play_sound', label: 'Wait for sound' },
  { opcode: 0x31, name: 'playfanfare', argBytes: 2, kind: 'play_sound', label: 'Play fanfare' },
  { opcode: 0x32, name: 'waitfanfare', argBytes: 0, kind: 'play_sound', label: 'Wait for fanfare' },
  { opcode: 0x33, name: 'playbgm', argBytes: 3, kind: 'play_sound', label: 'Play background music' },
  { opcode: 0x35, name: 'fadedefaultbgm', argBytes: 0, kind: 'play_sound', label: 'Fade default BGM' },
  { opcode: 0x36, name: 'fadenewbgm', argBytes: 2, kind: 'play_sound', label: 'Fade in new BGM' },
  // ─── Warps ──────────────────────────────────────────────────────
  { opcode: 0x39, name: 'warp', argBytes: 7, kind: 'warp_player', label: 'Warp player' },
  { opcode: 0x3a, name: 'warpsilent', argBytes: 7, kind: 'warp_player', label: 'Silent warp' },
  { opcode: 0x3b, name: 'warpdoor', argBytes: 7, kind: 'warp_player', label: 'Warp through door' },
  { opcode: 0x3c, name: 'warphole', argBytes: 2, kind: 'warp_player', label: 'Warp through hole' },
  { opcode: 0x3d, name: 'warpteleport', argBytes: 7, kind: 'warp_player', label: 'Warp by teleport' },
  // ─── Items ──────────────────────────────────────────────────────
  { opcode: 0x44, name: 'giveitem', argBytes: 5, kind: 'give_item', label: 'Give item' },
  { opcode: 0x45, name: 'takeitem', argBytes: 4, kind: 'give_item', label: 'Take item' },
  { opcode: 0x47, name: 'checkitem', argBytes: 4, kind: 'branch', label: 'Check item in bag' },
  // ─── Object events / movement ───────────────────────────────────
  { opcode: 0x4f, name: 'applymovement', argBytes: 6, kind: 'move_npc', label: 'Apply movement' },
  { opcode: 0x50, name: 'waitmovement', argBytes: 2, kind: 'move_npc', label: 'Wait for movement' },
  { opcode: 0x55, name: 'removeobject', argBytes: 2, kind: 'move_npc', label: 'Remove object' },
  { opcode: 0x57, name: 'addobject', argBytes: 2, kind: 'move_npc', label: 'Add object' },
  { opcode: 0x5d, name: 'faceplayer', argBytes: 0, kind: null, label: 'Face player' },
  { opcode: 0x5e, name: 'turnobject', argBytes: 3, kind: 'move_npc', label: 'Turn object' },
  // ─── Trainer battles ────────────────────────────────────────────
  { opcode: 0x5c, name: 'trainerbattle', argBytes: -1, kind: 'start_battle', label: 'Trainer battle' },
  // ^ -1 = variable encoding (first arg byte selects shape; see decoder)
  { opcode: 0x60, name: 'checktrainerflag', argBytes: 2, kind: 'branch', label: 'Check trainer beaten' },
  { opcode: 0x61, name: 'settrainerflag', argBytes: 2, kind: 'set_flag', label: 'Set trainer beaten' },
  { opcode: 0x62, name: 'cleartrainerflag', argBytes: 2, kind: 'clear_flag', label: 'Clear trainer beaten' },
  // ─── Messages ───────────────────────────────────────────────────
  { opcode: 0x67, name: 'message', argBytes: 4, kind: 'dialogue', label: 'Show message' },
  // (msgbox macro = `loadword 0, PTR; callstd TYPE`; decoder detects
  //  the pattern and emits a unified `dialogue` step)
  { opcode: 0x68, name: 'closemessage', argBytes: 0, kind: null, label: 'Close message' },
  { opcode: 0x69, name: 'lockall', argBytes: 0, kind: null, label: 'Lock all NPCs' },
  { opcode: 0x6a, name: 'lock', argBytes: 0, kind: null, label: 'Lock player' },
  { opcode: 0x6b, name: 'releaseall', argBytes: 0, kind: null, label: 'Release all NPCs' },
  { opcode: 0x6c, name: 'release', argBytes: 0, kind: null, label: 'Release player' },
  { opcode: 0x6d, name: 'waitbuttonpress', argBytes: 0, kind: null, label: 'Wait for button press' },
  { opcode: 0x6e, name: 'yesnobox', argBytes: 2, kind: 'dialogue', label: 'Yes/no prompt' },
  // ─── Fade / camera ──────────────────────────────────────────────
  { opcode: 0x70, name: 'multichoice', argBytes: 5, kind: 'dialogue', label: 'Multi-choice menu' },
  { opcode: 0x9a, name: 'fadescreen', argBytes: 1, kind: 'fade_scene', label: 'Fade screen' },
  { opcode: 0x9b, name: 'fadescreenspeed', argBytes: 2, kind: 'fade_scene', label: 'Fade screen at speed' },
  // ─── givemon (long) ─────────────────────────────────────────────
  { opcode: 0xb3, name: 'givemon', argBytes: 14, kind: 'give_item', label: 'Give Pokémon' },
  // ─── Random / RNG ───────────────────────────────────────────────
  { opcode: 0x42, name: 'random', argBytes: 2, kind: 'randomize_branch', label: 'Random number' },
]);

const SPEC_BY_OPCODE: Map<number, Gen3OpcodeSpec> = (() => {
  const m = new Map<number, Gen3OpcodeSpec>();
  for (const s of SPECS) m.set(s.opcode, s);
  return m;
})();

export function getGen3OpcodeSpec(opcode: number): Gen3OpcodeSpec | null {
  return SPEC_BY_OPCODE.get(opcode) ?? null;
}

export function listGen3OpcodeSpecs(): ReadonlyArray<Gen3OpcodeSpec> {
  return SPECS;
}

/**
 * Gen-3 `trainerbattle` (opcode 0x5C) has a variable encoding selected by
 * its first arg byte (the "battle type"). Returns the number of bytes that
 * FOLLOW the opcode byte - the type byte plus its type-specific arguments -
 * so a decoder advances `cursor = opcodeOffset + 1 + n`.
 *
 * Ground truth, verified 2026-10-07 against BOTH halves of the format:
 *   - the assembler macro `asm/macros/event.inc` `.macro trainerbattle`
 *   - the runtime reader `src/battle_setup.c`
 *     `BattleSetup_ConfigureTrainerBattle` and its `s*BattleParams` spec
 *     tables (`TRAINER_PARAM_LOAD_VAL_{8,16,32}BIT` consume 1/2/4 bytes;
 *     `TRAINER_PARAM_CLEAR_VAL_*` consume none; the walk stops at
 *     `TRAINER_PARAM_LOAD_SCRIPT_RET_ADDR`).
 *
 * Common prefix: type u8 + opponent u16 + local_id u16 = 5 bytes. Every
 * further argument is a 4-byte pointer.
 *   type 0 SINGLE                          : 5 + 2 ptr = 13
 *   type 1 CONTINUE_SCRIPT_NO_MUSIC        : 5 + 3 ptr = 17
 *   type 2 CONTINUE_SCRIPT                 : 5 + 3 ptr = 17
 *   type 3 SINGLE_NO_INTRO_TEXT            : 5 + 1 ptr =  9
 *   type 4 DOUBLE                          : 5 + 3 ptr = 17
 *   type 5 REMATCH                         : 5 + 2 ptr = 13
 *   type 6 CONTINUE_SCRIPT_DOUBLE          : 5 + 4 ptr = 21
 *   type 7 REMATCH_DOUBLE                  : 5 + 3 ptr = 17
 *   type 8 CONTINUE_SCRIPT_DOUBLE_NO_MUSIC : 5 + 4 ptr = 21
 *   type 9 EARLY_RIVAL                     : 5 + 2 ptr = 13
 *
 * Unknown types bail to 1 (just the type byte) so the decoder still makes
 * forward progress instead of walking off into garbage.
 */
export function getTrainerbattleArgBytes(typeByte: number): number {
  switch (typeByte) {
    case 0: // TRAINER_BATTLE_SINGLE
    case 5: // TRAINER_BATTLE_REMATCH
    case 9: // TRAINER_BATTLE_EARLY_RIVAL
      return 13;
    case 1: // TRAINER_BATTLE_CONTINUE_SCRIPT_NO_MUSIC
    case 2: // TRAINER_BATTLE_CONTINUE_SCRIPT
    case 4: // TRAINER_BATTLE_DOUBLE
    case 7: // TRAINER_BATTLE_REMATCH_DOUBLE
      return 17;
    case 3: // TRAINER_BATTLE_SINGLE_NO_INTRO_TEXT
      return 9;
    case 6: // TRAINER_BATTLE_CONTINUE_SCRIPT_DOUBLE
    case 8: // TRAINER_BATTLE_CONTINUE_SCRIPT_DOUBLE_NO_MUSIC
      return 21;
    default:
      // Unknown type - bail conservatively (just the type byte).
      return 1;
  }
}

/** Standard-script ids commonly used by `callstd` after `loadword 0, TEXT_PTR`.
 *  These are the macro types passed to `msgbox`:
 *    1 = msg_keep_open (NPC dialogue with portrait)
 *    2 = msg_npc       (NPC dialogue)
 *    3 = msg_sign      (sign event)
 *    4 = msg_default   (default - closes after press)
 *    5 = msg_yes_no    (yes/no prompt)
 *    6 = msg_auto_close
 *    7 = msg_get_point (got item)
 *  Any callstd with type in this set is treated as a msgbox completer.
 */
export const MSGBOX_CALLSTD_TYPES: ReadonlyArray<number> = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

/** Movement command bytes used inside an `applymovement` data block.
 *  Subset of pret/pokefirered/include/constants/event_object_movement.h.
 *  0xFE = end of movement sequence. */
export const MOVEMENT_END_BYTE = 0xfe;

/**
 * Compare operator used by the `goto_if` / `call_if` condition byte.
 * The engine compares a stored `compare` result against this code. Source:
 * pret/pokefirered/include/constants/script_cmd_table.h (CompareValueToVal
 * codes). These are the six operators used by Gen-3 "branch on variable"
 * patterns - `compare varId, value; goto_if OPERATOR, target`.
 */
export type BranchOperator =
  | 'less'
  | 'equal'
  | 'greater'
  | 'lessorequal'
  | 'greaterorequal'
  | 'notequal';

/** Plain-English label for each operator, used by the visual scripter
 *  + the proposed-edit summary. Symbolic comparison form ("var ≥ 3"). */
export const BRANCH_OPERATOR_SYMBOLS: Readonly<Record<BranchOperator, string>> =
  Object.freeze({
    less: '<',
    equal: '=',
    greater: '>',
    lessorequal: '≤',
    greaterorequal: '≥',
    notequal: '≠',
  });

const OPERATOR_TO_CONDITION: Readonly<Record<BranchOperator, number>> = Object.freeze({
  less: 0,
  equal: 1,
  greater: 2,
  lessorequal: 3,
  greaterorequal: 4,
  notequal: 5,
});

const CONDITION_TO_OPERATOR: ReadonlyArray<BranchOperator | null> = Object.freeze([
  'less',
  'equal',
  'greater',
  'lessorequal',
  'greaterorequal',
  'notequal',
]);

/** Convert a symbolic operator into the goto_if condition byte. */
export function branchOperatorToConditionByte(op: BranchOperator): number {
  return OPERATOR_TO_CONDITION[op];
}

/** Convert a condition byte (0..5) back to a symbolic operator. Returns
 *  null for unrecognized bytes (the decoder should preserve those as a
 *  raw `branch` step rather than collapsing). */
export function conditionByteToBranchOperator(b: number): BranchOperator | null {
  if (b < 0 || b >= CONDITION_TO_OPERATOR.length) return null;
  return CONDITION_TO_OPERATOR[b] ?? null;
}
