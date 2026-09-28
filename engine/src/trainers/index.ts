export {
  TRAINER_AI_FLAGS_MAX,
  TRAINER_CLASS_MAX,
  TRAINER_NAME_BYTES,
  TRAINER_NAME_PRINTABLE_MAX,
  TRAINER_NAME_TERMINATOR,
  TRAINER_PARTY_FLAGS_MAX,
  TRAINER_PARTY_SIZE_MAX,
  TRAINER_PARTY_SIZE_MIN,
  TRAINER_STRUCT_SIZE_BYTES,
  parseTrainer,
  type Trainer,
  type TrainerParseFailure,
  type TrainerParseResult,
} from './trainer.js';

export {
  TRAINER_SCAN_MAX_RECORDS,
  TRAINER_SCAN_MIN_RECORDS,
  scanTrainerTable,
  type ScanTrainersOptions,
  type TrainerTable,
} from './trainer-scanner.js';

export {
  TRAINER_CLASS_NAME_SLOT_BYTES,
  TRAINER_CLASS_NAME_SLOT_CANDIDATES,
  TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION,
  TRAINER_CLASS_NAMES_MIN_VALID_SLOTS,
  TRAINER_CLASS_NAMES_READ_CAP,
  findTrainerClassNamesTable,
  readTrainerClassNamesAt,
  validateTrainerClassNames,
  type TrainerClassNamesTable,
} from './trainer-class-names.js';

export {
  PARTY_MEMBER_IV_MAX,
  PARTY_MEMBER_LEVEL_MAX,
  PARTY_MEMBER_SIZE_BYTES_NO_MOVES,
  PARTY_MEMBER_SIZE_BYTES_WITH_MOVES,
  PARTY_MEMBER_SPECIES_MAX,
  parseTrainerPartyArray,
  parseTrainerPartyMember,
  partyMemberStructSize,
  type TrainerPartyMemberKind,
  type TrainerPartyMemberParseFailure,
  type TrainerPartyMemberParseResult,
  type TrainerPartyMemberParsed,
} from './party-member.js';

// Phase 3.4 - named AI flag decoder + presets.
export {
  AI_FLAG_BIT_INDICES,
  ELITE_FOUR_AI_FLAGS,
  GYM_LEADER_AI_FLAGS,
  SMART_TRAINER_AI_FLAGS,
  decodeAiFlags,
  encodeAiFlags,
  type AiFlagSet,
} from './ai-flags.js';
