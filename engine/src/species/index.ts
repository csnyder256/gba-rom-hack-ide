export {
  BASE_STATS_ABILITY_MAX,
  BASE_STATS_EGG_GROUP_MAX,
  BASE_STATS_GROWTH_RATE_MAX,
  BASE_STATS_STRUCT_SIZE_BYTES,
  BASE_STATS_TYPE_MAX,
  parseBaseStats,
  type BaseStats,
  type BaseStatsParseFailure,
  type BaseStatsParseResult,
} from './base-stats.js';

export {
  BASE_STATS_SCAN_MAX_RECORDS,
  BASE_STATS_SCAN_MIN_RECORDS,
  scanBaseStatsTable,
  type BaseStatsTable,
  type ScanBaseStatsOptions,
} from './base-stats-scanner.js';

export { isRealTableBoundary } from './table-boundary.js';

export {
  EVOLUTION_BLOCK_SIZE_BYTES,
  EVOLUTION_METHOD_MAX,
  EVOLUTION_SLOTS_PER_SPECIES,
  EVOLUTION_SPECIES_MAX,
  EVOLUTION_STRUCT_SIZE_BYTES,
  EVO_NONE,
  parseEvolutionBlock,
  parseEvolutionSlot,
  type Evolution,
  type EvolutionBlock,
  type EvolutionBlockParseFailure,
  type EvolutionBlockParseResult,
  type EvolutionParseFailure,
  type EvolutionParseResult,
} from './evolution.js';

export {
  EVOLUTION_SCAN_MAX_BLOCKS,
  EVOLUTION_SCAN_MIN_BLOCKS,
  EVOLUTION_SCAN_MIN_POPULATED_BLOCKS,
  scanEvolutionTable,
  type EvolutionTable,
  type ScanEvolutionTableOptions,
} from './evolution-scanner.js';

export {
  LEARNSET_LEVEL_MAX,
  LEARNSET_LEVEL_SHIFT,
  LEARNSET_MAX_ENTRIES,
  LEARNSET_MOVE_MASK,
  LEARNSET_MOVE_MAX,
  LEARNSET_TERMINATOR,
  parseLearnsetArray,
  parseLearnsetEntry,
  type Learnset,
  type LearnsetArrayParseFailure,
  type LearnsetArrayParseResult,
  type LearnsetEntry,
  type LearnsetEntryParseFailure,
  type LearnsetEntryParseResult,
  type ParseLearnsetArrayOptions,
} from './learnset.js';

export {
  LEARNSET_TABLE_SCAN_MAX_POINTERS,
  LEARNSET_TABLE_SCAN_MIN_POINTERS,
  scanLearnsetPointerTable,
  type LearnsetPointerTable,
  type LearnsetTableEntry,
  type ScanLearnsetTableOptions,
} from './learnset-scanner.js';

export {
  TMHM_HM_COUNT,
  TMHM_MAX_SET_BITS,
  TMHM_RESERVED_BIT_COUNT,
  TMHM_STRUCT_SIZE_BYTES,
  TMHM_TM_COUNT,
  TMHM_USED_BIT_COUNT,
  parseTMHMCompat,
  type ParseTMHMOptions,
  type TMHMCompat,
  type TMHMParseFailure,
  type TMHMParseResult,
} from './tmhm.js';

export {
  TMHM_SCAN_MAX_SLOTS,
  TMHM_SCAN_MIN_POPULATED_SLOTS,
  TMHM_SCAN_MIN_SLOTS,
  scanTMHMTable,
  type ScanTMHMTableOptions,
  type TMHMTable,
} from './tmhm-scanner.js';

export {
  SPECIES_NAME_SLOT_BYTES,
  SPECIES_NAMES_MIN_VALID_SLOTS,
  SPECIES_NAMES_POINTER_FILE_OFFSET,
  SPECIES_NAMES_READ_CAP,
  SPECIES_PLACEHOLDER_BYTE,
  classifySpeciesNameSlot,
  findSpeciesNamesTable,
  findSpeciesNamesTableViaPointer,
  measureSpeciesNamesTable,
  readSpeciesNamesAt,
  validateSpeciesNames,
  type SpeciesNameSlotKind,
  type SpeciesNamesTableShape,
} from './species-names.js';

export {
  POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
  POKEDEX_CATEGORY_NAME_LENGTH_BYTES,
  POKEDEX_HEIGHT_MAX,
  POKEDEX_WEIGHT_MAX,
  POKEDEX_OFFSET_CATEGORY_NAME,
  POKEDEX_OFFSET_HEIGHT,
  POKEDEX_OFFSET_WEIGHT,
  POKEDEX_OFFSET_DESCRIPTION_PTR,
  POKEDEX_OFFSET_UNUSED_DESCRIPTION_PTR,
  POKEDEX_OFFSET_POKEMON_SCALE,
  POKEDEX_OFFSET_POKEMON_OFFSET,
  POKEDEX_OFFSET_TRAINER_SCALE,
  POKEDEX_OFFSET_TRAINER_OFFSET,
  parsePokedexEntry,
  type PokedexEntry,
  type PokedexEntryParseFailure,
  type PokedexEntryParseResult,
} from './pokedex-entry.js';

export {
  POKEDEX_SCAN_MIN_RECORDS,
  POKEDEX_SCAN_MAX_RECORDS,
  scanPokedexTable,
  type PokedexTable,
  type PokedexScanOptions,
} from './pokedex-scanner.js';

// Phase 3.42 - Pokédex entry writer.
export {
  encodePokedexEntry,
  PokedexEntryEncodeError,
  type PokedexEntrySpec,
} from './pokedex-entry-writer.js';
