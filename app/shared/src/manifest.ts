import type {
  Asset,
  DialogueNode,
  EncounterTable,
  Flag,
  MapNode,
  ObjectEvent,
  ScriptStep,
  Trainer,
  Trigger,
  Variable,
  Warp,
} from './vocabulary.js';

export type ProjectKind = 'decomp' | 'patch' | 'hybrid' | 'unknown';

export interface ProjectIdentity {
  readonly kind: ProjectKind;
  /** 0..1 confidence score that this detection is correct. */
  readonly confidence: number;
  /** Human-readable identity (e.g. "pokeemerald (decomp)"). */
  readonly displayName: string;
  /** Detected base game lineage, if any. */
  readonly baseGame: string | null;
  /** Detected fork/framework name, if any. */
  readonly fork: string | null;
  readonly featureFlags: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** Concrete files/folders that drove the classification - surfaced to the user so the
   *  identity is never an opaque verdict (serves Pillar 5: no mystery state). */
  readonly evidence: ReadonlyArray<string>;
  /** When the project is a bare-ROM workspace and the editor was able to
   *  read data tables directly from the .gba binary, this carries what was
   *  read. Absent for decomp projects (which scan source files instead) and
   *  for ROMs whose binary layout couldn't be decoded. */
  readonly romBinary?: RomBinaryStats;
  /** Parsed GBA cartridge header for bare-ROM workspaces (UW-1-T3).
   *  Surfaces the engine's `WorkspaceIdentity.header` fields directly so
   *  the editor's identity card can render the structural picture
   *  without dropping to raw evidence strings. Absent for decomp
   *  projects (no `.gba` binary) and for ROMs whose header couldn't
   *  be parsed (corrupt / non-GBA / too short). */
  readonly romHeader?: RomCartridgeHeader;
  /** Memory-layout + pointer-network + compression-region inventory
   *  for bare-ROM workspaces (UW-1-T4). Mirrors the engine's
   *  `WorkspaceIdentity` substrate fields so the editor's identity
   *  card can render a complete structural picture of the ROM.
   *  Absent for decomp projects + ROMs whose body couldn't be scanned. */
  readonly romStructure?: RomStructure;
  /** Per-subsystem detection summaries from the 5 Cat 2/4 subsystem
   *  detectors that run during project-open (UW-2-T6 iter 72):
   *  save-system, moves, type-chart, items, abilities. Each entry
   *  carries the detection status/confidence + a one-line summary
   *  lifted from the engine's primary evidence. Surfaced by the
   *  IdentityCard's "Detected Subsystems" section so users see the
   *  engine's combat-data findings without having to run the heavy
   *  scanProject pass. Empty array if the bare-ROM scan wasn't run
   *  (e.g. decomp project). */
  readonly detectedSubsystems?: ReadonlyArray<DetectedSubsystem>;
  /** Coverage summary for Cat 15 unknowns-policy surface (UW-2-T14
   *  iter 80). Engine totals + top-5 scored-unknown regions. Absent
   *  for decomp projects (no ROM-side scan). */
  readonly coverageSummary?: CoverageSummary;
  /** Hint that the editor can offer a one-click ROM upgrade. Set to
   *  `'vanilla-frlg-rev0'` when the loaded ROM is the canonical
   *  Pokémon FireRed USA rev 0 baseline AND the editor has a bundled
   *  modernization patch ready to apply. The frontend reads this
   *  single signal to decide whether to render the "Modernize" card;
   *  see [Modernize-and-Ship slice 5]. Absent / null for ROMs that
   *  don't qualify for an upgrade (already modernized, non-FRLG,
   *  unknown variant). */
  readonly upgradeOffer?: 'vanilla-frlg-rev0' | null;
  /** Phase 6.2 - set when the project's op-log records a
   *  `modernize_rom` entry whose post-apply SHA-1 matches the
   *  currently-loaded ROM. Strongest possible evidence that this ROM
   *  is byte-identical to the output of the editor's own modernize
   *  flow on canonical vanilla FRLG. Lets the displayName overlay
   *  layer (Phase 6.5) assert real map / encounter / trainer names
   *  with confidence - every unchanged offset is still vanilla.
   *  Absent for ROMs the user opened without going through Modernize. */
  readonly modernizedBy?: 'CFRU' | 'CFRU+DPE' | null;
  /** Phase 6.2 - true when the vanilla-truth overlay is safe to apply
   *  to this ROM. Derived from `modernizedBy` (op-log proof) OR a
   *  fingerprint match for one of our bundled output SHA-1s. False /
   *  absent when we lack ground-truth basis for asserting vanilla
   *  labels. The displayName layer short-circuits the overlay when
   *  this is false. */
  readonly overlaySafe?: boolean;
}

export interface DetectedSubsystem {
  readonly id: string;
  readonly name: string;
  readonly phase: number;
  readonly status: 'detected' | 'partial' | 'not_detected';
  readonly confidence: number;
  readonly runtimeMs: number;
  readonly summary: string | null;
  /** First N decoded names from the detector's sampleNames (UW-2-T9
   *  iter 75). Surfaced in IdentityCard's DetectedSubsystemsSection as
   *  a chip-list preview when present. Absent for detectors that don't
   *  expose sampleNames (save_system / type_chart_system). */
  readonly sampleNames?: ReadonlyArray<string>;
}

/** Per-scored-unknown-region summary surfaced in the IdentityCard's
 *  UnknownsPolicySection (Cat 15 substrate; UW-2-T14 iter 80). Mirrors
 *  the engine's CoverageRegion shape for entries with
 *  `kind === 'unknown_scored'`. */
export interface CoverageScoredUnknownRegion {
  readonly start: number;
  readonly end: number;
  readonly sizeBytes: number;
  readonly score: number;
  readonly provenance: string;
  readonly note?: string;
}

/** Coverage summary lifted from the engine's IngestReport.coverage - 
 *  totals + top-N largest scored-unknown regions (UW-2-T14 iter 80).
 *  Surfaced in IdentityCard's UnknownsPolicySection to honor PD 12
 *  (no dead zones - every byte either classified or surfaced as a
 *  scored-unknown object with confidence + provenance). */
export interface CoverageSummary {
  readonly romSize: number;
  readonly classifiedBytes: number;
  readonly unknownScoredBytes: number;
  readonly unaccountedBytes: number;
  readonly classifiedPct: number;
  readonly unknownScoredPct: number;
  readonly unaccountedPct: number;
  readonly regionCount: number;
  readonly topScoredUnknownRegions: ReadonlyArray<CoverageScoredUnknownRegion>;
}

export interface RomStructure {
  readonly memoryLayout: RomMemoryLayout;
  /** Pointer-table inventory (null when the engine returned not_detected
   *  for the pointer-network detector - e.g. ROM too small to scan). */
  readonly pointerTables: RomPointerTableInventory | null;
  /** Compression-region inventory (null when the compression-format
   *  detector returned not_detected). */
  readonly compressionRegions: RomCompressionRegionInventory | null;
}

export interface RomMemoryLayout {
  readonly romSize: number;
  readonly headerOffset: number;
  readonly headerLength: number;
  readonly bodyOffset: number;
  readonly bodyLength: number;
}

export interface RomPointerTableInventory {
  readonly totalPointerCount: number;
  readonly tableCount: number;
  readonly tableBytesCovered: number;
  /** Top-8 largest pointer tables sorted by length desc. */
  readonly largestTables: ReadonlyArray<{
    readonly offset: number;
    readonly length: number;
    readonly stride: 4;
  }>;
  readonly clusterTargetCount: number;
}

export interface RomCompressionRegionInventory {
  readonly confirmedLz77BlockCount: number;
  readonly confirmedLz77BytesCovered: number;
  readonly probableCompressionRegionCount: number;
  readonly probableCompressionBytesScored: number;
  /** Top-8 largest confirmed LZ77 blocks sorted by compressedSize desc. */
  readonly largestLz77Blocks: ReadonlyArray<{
    readonly offset: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
  }>;
}

export interface RomCartridgeHeader {
  /** 12-byte internal game title (trimmed of trailing nulls/spaces). */
  readonly internalTitle: string;
  /** 4-byte game code (e.g. "BPRE" for Pokémon FireRed). */
  readonly gameCode: string;
  /** 2-byte maker code (e.g. "01" for Nintendo). */
  readonly makerCode: string;
  /** 1-byte software version (0 = v1.0, 1 = v1.1, etc.). */
  readonly softwareVersion: number;
  /** Friendly label when `gameCode` matches a known Pokémon game code;
   *  null otherwise (the editor still shows the raw game code in that
   *  case rather than burying it). */
  readonly knownGame: string | null;
  /** Pre-formatted display string (e.g. "Pokémon FireRed - BPRE
   *  (POKEMON FIRE) v0"). */
  readonly displayString: string;
}

export interface RomBinaryStats {
  /** Detected variant id (e.g. "BPRE_1.0") or null when the game code is
   *  recognized but the version doesn't match a seeded entry. */
  readonly variant: string | null;
  readonly variantDisplayName: string | null;
  /** Where the species table was read from. "documented" = matched a
   *  seeded offset for this variant; "signature_scan" = found by scanning
   *  for the BULBASAUR/IVYSAUR signature (used for hacks); "none" = no
   *  table could be located. */
  readonly speciesSource: 'documented' | 'signature_scan' | 'none';
  readonly speciesCount: number;
  /** Truncated preview of the species names list (placeholder slot at
   *  index 0 stripped) for surfacing in the UI. The full list is too
   *  large for an identity payload; the UI requests it lazily when the
   *  user expands the section. */
  readonly speciesPreview: ReadonlyArray<string>;
}

export interface BuildProfile {
  readonly toolchain: string;
  readonly buildCommand: string;
  readonly outputPaths: ReadonlyArray<string>;
  readonly testCommand: string | null;
}

export interface ProjectManifest {
  readonly schemaVersion: 1;
  readonly generatedAtUtc: string;
  readonly projectRoot: string;
  readonly identity: ProjectIdentity;
  readonly buildProfile: BuildProfile | null;
  readonly maps: ReadonlyArray<MapNode>;
  readonly warps: ReadonlyArray<Warp>;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly objectEvents: ReadonlyArray<ObjectEvent>;
  readonly dialogue: ReadonlyArray<DialogueNode>;
  readonly flags: ReadonlyArray<Flag>;
  readonly variables: ReadonlyArray<Variable>;
  readonly encounterTables: ReadonlyArray<EncounterTable>;
  readonly trainers: ReadonlyArray<Trainer>;
  readonly scriptSteps: ReadonlyArray<ScriptStep>;
  readonly assets: ReadonlyArray<Asset>;
  /** Iter 92 (UW-3-T11) - when the project was scanned by the
   *  BinaryRomScanner (i.e. a `.gba` file rather than a decomp source
   *  tree), this carries the full engine ingest report summary +
   *  per-subsystem detection results. Absent when scanned by
   *  decompScanner. PD 12: every detector's output is accounted for
   *  here (detected, partial, not_detected, scored-unknown); editor
   *  surfaces consume `subsystems[]` to render the full engine state
   *  without re-deriving it. */
  readonly binaryRom?: BinaryRomScanReport;
  /** Iter 94 (UW-3-T13) - manifest schema expansion for engine
   *  detectors that don't fit the standard decomp-shaped collections.
   *  Each entry is minimal (id + name + index + sourceOffset) for
   *  v1; future iters deepen as detectors expose more per-entry data.
   *  All optional - populated only by BinaryRomScanner via the
   *  binary-rom-registry lifters. PD 13: lifted directly from
   *  engine detector outputs, no parallel derivation. */
  readonly speciesNames?: ReadonlyArray<SpeciesNameEntry>;
  readonly moveNames?: ReadonlyArray<MoveNameEntry>;
  readonly items?: ReadonlyArray<ItemEntry>;
  readonly abilities?: ReadonlyArray<AbilityEntry>;
  readonly pokedexEntries?: ReadonlyArray<PokedexEntryRecord>;
  /** Iter 96 (UW-3-T15) - cross-reference target for resolving
   *  trainer.className from `class_N` to the real string. Populated
   *  by liftTrainerClassNames; consumed by the binary-rom cross-ref
   *  pass that updates Trainer entries' className field. */
  readonly trainerClassNames?: ReadonlyArray<TrainerClassNameEntry>;
  /** Iter 97 (UW-3-T16) - type system schema expansion. */
  readonly typeNames?: ReadonlyArray<TypeNameEntry>;
  readonly typeMatchups?: ReadonlyArray<TypeMatchupEntry>;
  /** Iter 98 (UW-3-T17) - save/menu schema expansion. */
  readonly saveBlocks?: ReadonlyArray<SaveBlockEntry>;
  readonly menus?: ReadonlyArray<MenuEntry>;
  /** Iter 99 (UW-3-T18) - battle moves with per-move struct data
   *  (power/accuracy/pp/type/effect/etc.) from moves_system detector. */
  readonly battleMoves?: ReadonlyArray<BattleMoveEntry>;
  /** Iter 100 (UW-3-T19) - Gen-3 experience curves (6 growth-rate
   *  rows × 101 levels) from the experience_curves_system detector
   *  (NEW DETECTOR + co-shipped lifter per UW-D-0015 invariant). */
  readonly experienceCurves?: ReadonlyArray<ExperienceCurveEntry>;
  /** Iter 101 (UW-3-T20) - Gen-3 overworld sprite metadata from the
   *  overworld_sprites_system detector (NEW DETECTOR + co-shipped
   *  lifter per UW-D-0015 invariant). Bridges map-system object events
   *  (which carry graphicsId integers) to the sprite library that
   *  renders them. */
  readonly overworldSprites?: ReadonlyArray<OverworldSpriteEntry>;
  /** Phase F (semantic-world plan §1.1) - Gen-3 OW sprite palette table
   *  from object_event_palettes_system detector. One entry per slot in
   *  the universal `sObjectEventSpritePalettes[]` array (vanilla FRLG
   *  ~25 entries; Emerald ~30; hacks may add more). Each entry carries
   *  a palette tag + the 16-color BGR555→RGBA palette block. Cross-ref
   *  resolves each OverworldSpriteEntry.paletteTag to its actual
   *  palette, turning grayscale NPCs into colored sprites. */
  readonly objectEventPalettes?: ReadonlyArray<ObjectEventPaletteEntry>;
  /** Phase F (semantic-world plan §3.1) - Tileset registry lifted from
   *  the map_system detector's `tilesets[]` field. Every unique tileset
   *  pointer referenced by any map header (deduplicated by file offset)
   *  becomes one entry, with the list of mapIds that use it surfaced
   *  as `usedByMapIds[]`. Powers the universal tileset browser by
   *  letting the frontend offer ALL tilesets in the ROM as paint
   *  sources, not just the primary+secondary of the currently-loaded
   *  map (semantic-world plan §3.2). */
  readonly tilesets?: ReadonlyArray<TilesetEntry>;
  /** Iter 103 (UW-3-T22) - Gen-3 per-species BaseStats data lifted
   *  from species_system detector's `baseStatsTable.records[]` (already
   *  exposed by the engine since iter 73 - was the most prominent
   *  parse-and-discard gap; one of the largest editor surfaces).
   *  Vanilla FRLG has 411 species × 22 stat/type/item/ability fields
   *  each = ~9000 new per-entry data points per scan. Cross-refs 8+9
   *  resolve name (from speciesNames) + type1Name/type2Name (from
   *  typeNames). */
  readonly species?: ReadonlyArray<SpeciesEntry>;
  /** Iter 105 (UW-3-T24) - Gen-3 evolution chains from
   *  species_evolutions detector's evolutionTable.blocks[] (engine
   *  exposes per-block populatedSlots since iter 75; lifter was the
   *  missing piece). One entry per species; each carries the
   *  populated evolution slots (method/param/targetSpecies). */
  readonly speciesEvolutions?: ReadonlyArray<SpeciesEvolutionEntry>;
  /** Iter 105 - Gen-3 level-up movesets from species_learnsets
   *  detector's learnsetPointerTable.entries[]. One entry per species;
   *  each carries the full level-up moveset (level, moveId pairs
   *  through the 0xFFFF terminator). */
  readonly speciesLearnsets?: ReadonlyArray<SpeciesLearnsetEntry>;
  /** Iter 105 - Gen-3 TM/HM compatibility from species_tmhm
   *  detector's tmhmTable.slots[]. One entry per species; each carries
   *  the 64-bit compatibility bitfield split into TM + HM index lists. */
  readonly speciesTMHM?: ReadonlyArray<SpeciesTMHMEntry>;
  /** Phase UX-B - Gen-3 region-map area sections from the universal
   *  gRegionMapEntries table. Maps each regionMapSection byte (carried
   *  on every MapHeader) to a real in-game area name like "PALLET
   *  TOWN" / "VIRIDIAN FOREST" / "ROUTE 1". Cross-ref 18 rewrites
   *  each MapNode.name with the resolved area name when present. */
  readonly regionMapSections?: ReadonlyArray<RegionMapSectionEntry>;
  /** Phase O.3 - Gen-3 gMultichoiceLists table from the
   *  multichoice_lists_system detector. Each entry holds the choice
   *  strings (YES/NO, starter picker, store menu, etc.) the player
   *  sees when the script `multichoice` opcode fires. Edited via the
   *  existing dialogue-string write route - each choice text bytes
   *  have their own file offset. */
  readonly multichoiceLists?: ReadonlyArray<MultichoiceListRecord>;
  /** Phase O.42 - Gen-3 sHealLocations[] table from the
   *  heal_locations_system detector. Each entry maps a SPAWN_* slot
   *  to a (map group, map num, x, y) destination - the warps the
   *  game uses on white-out, after Fly / Teleport, and for mom's
   *  house initial spawn. */
  readonly healLocations?: ReadonlyArray<HealLocationEntry>;
  /** #2 Story-order navigation - ordered list of `MAPSEC_*` region-map
   *  section constants in their `include/constants/region_map_sections.h`
   *  enum order. The enum position is the canonical in-game section index,
   *  which for Gen-3 follows the geographic / story progression (Pallet →
   *  Viridian → Pewter → …, Routes numerically). The Navigator groups
   *  decomp maps by `metadata.region_map_section` and orders those groups
   *  by their index here, turning the flat alphabetical map list into a
   *  natural play-order tree. Decomp-only (binary maps use
   *  `regionMapSections` byte indices instead). */
  readonly mapSectionOrder?: ReadonlyArray<string>;
}

/** Iter 94 - Minimal binary-ROM species-name entry surfaced from the
 *  species_names detector's first-16 sample. Future iters deepen with
 *  base stats / typings / abilities / evolutions when detectors fan out. */
export interface SpeciesNameEntry {
  readonly id: string;
  readonly speciesIndex: number;
  readonly name: string;
  readonly sourceTableOffset: number;
  /** Phase N.5 - file offset of this entry's 11-byte name slot
   *  (Gen-3 species: 10 chars + 0xFF terminator). Editable via
   *  /binary-rom-edit/dialogue-string. */
  readonly nameSlotOffset?: number;
}

/** Iter 94 - Minimal move-name entry from move_names detector's sample. */
export interface MoveNameEntry {
  readonly id: string;
  readonly moveIndex: number;
  readonly name: string;
  readonly sourceTableOffset: number;
  /** Phase N.5 - file offset of this entry's 13-byte name slot
   *  (Gen-3 moves: 12 chars + 0xFF terminator). */
  readonly nameSlotOffset?: number;
}

/** Iter 94 - Item entry from items_system detector's sample. The Items
 *  detector (iter 70) parses 44-byte structs with name + 13 other fields.
 *  Iter 99 deepens the scanner to expose all parsed items + the lifter
 *  now reads per-item price/holdEffect/holdEffectParam/importance/pocket/
 *  type/descriptionPtr from the deepened ItemsTable.items[] array. The
 *  per-item detail fields are optional so the schema remains backward
 *  compat with iter-94 minimal entries. */
export interface ItemEntry {
  readonly id: string;
  readonly itemIndex: number;
  readonly name: string;
  readonly sourceTableOffset: number;
  /** Iter 99 - buy price (u16 from struct offset 0x10). */
  readonly price?: number;
  /** Iter 99 - hold-effect enum (u8 from struct offset 0x12). */
  readonly holdEffect?: number;
  /** Iter 99 - hold-effect parameter (u8 from struct offset 0x13). */
  readonly holdEffectParam?: number;
  /** Iter 99 - description text ROM pointer (u32 from struct offset 0x14). */
  readonly descriptionPtr?: number;
  /** Iter 99 - key-item importance flag (0 or 1). */
  readonly importance?: number;
  /** Iter 99 - pocket enum (0..9 vanilla - items/key items/poké balls/TMs/berries). */
  readonly pocket?: number;
  /** Iter 99 - usage-type byte. */
  readonly type?: number;
}

/** Iter 99 - BattleMove entry from moves_system detector's deepened
 *  scanner output. Each move's mechanic data (effect/power/type/accuracy
 *  /pp/etc.) from the 12-byte BattleMove struct. The cross-ref pass
 *  populates `name` (from moveNames lifter when index ≤ 15) and
 *  `typeName` (from typeNames lifter via the type byte). */
export interface BattleMoveEntry {
  readonly id: string;
  readonly moveIndex: number;
  readonly effect: number;
  readonly power: number;
  /** Type byte (0..N) - cross-ref populates typeName. */
  readonly type: number;
  readonly accuracy: number;
  readonly pp: number;
  readonly secondaryEffectChance: number;
  readonly target: number;
  readonly priority: number;
  readonly flags: number;
  /** Gen-3 damage class - DERIVED from the move's type + power
   *  (0 = status, 1 = physical, 2 = special). Gen-3 has no stored
   *  split byte; the struct's 0x09 byte is padding. */
  readonly split: number;
  readonly sourceTableOffset: number;
  /** Iter 99 cross-ref outputs (populated when complementary lifters ran). */
  readonly name?: string;
  readonly typeName?: string;
}

/** Iter 103 - Per-species BaseStats data lifted from species_system
 *  detector. Mirrors the engine's 28-byte BaseStats struct fields per
 *  pret/pokefirered. Cross-ref pass populates optional name (from
 *  speciesNames lifter when index ≤ ~16 sample) and type1Name/type2Name
 *  (from typeNames lifter via the type bytes). Per vanilla FRLG: 411
 *  species × full stat/type/item/ability data = the largest single
 *  per-entry surface in the editor manifest. */
export interface SpeciesEntry {
  readonly id: string;
  readonly speciesIndex: number;
  /** Base HP stat (0..255). */
  readonly baseHP: number;
  /** Base Attack stat. */
  readonly baseAttack: number;
  /** Base Defense stat. */
  readonly baseDefense: number;
  /** Base Speed stat. */
  readonly baseSpeed: number;
  /** Base Special Attack stat. */
  readonly baseSpAttack: number;
  /** Base Special Defense stat. */
  readonly baseSpDefense: number;
  /** Primary type byte (0..17 vanilla Gen-3). */
  readonly type1: number;
  /** Secondary type byte (0..17; equals type1 for single-type Pokémon). */
  readonly type2: number;
  /** Catch rate (0..255). */
  readonly catchRate: number;
  /** Experience yield (0..255). */
  readonly expYield: number;
  /** Held item slot 1 (u16). */
  readonly item1: number;
  /** Held item slot 2 (u16). */
  readonly item2: number;
  /** Gender ratio byte (0..255; 0 = always male, 254 = always female, etc.). */
  readonly genderRatio: number;
  /** Egg-hatching step cycles. */
  readonly eggCycles: number;
  /** Base friendship at capture. */
  readonly friendship: number;
  /** Growth-rate enum (0..5 - index into gExperienceTables). */
  readonly growthRate: number;
  /** Egg group 1 (0..14 vanilla). */
  readonly eggGroup1: number;
  /** Egg group 2. */
  readonly eggGroup2: number;
  /** Ability slot 1 (0..200 hack-capped). */
  readonly ability1: number;
  /** Ability slot 2. */
  readonly ability2: number;
  /** Safari Zone flee rate. */
  readonly safariZoneFleeRate: number;
  /** Absolute file offset of this entry's BaseStats struct (28 bytes). */
  readonly sourceFileOffset: number;
  /** Iter 103 cross-ref outputs (populated when complementary lifters ran). */
  readonly name?: string;
  readonly type1Name?: string;
  readonly type2Name?: string;
  /** Iter 104 cross-ref - canonical growth-rate name resolved by looking
   *  up `growthRate` byte against the iter-100 experienceCurves[]
   *  collection (curveIndex == growthRate). Same value as
   *  ExperienceCurveEntry.growthRateName for the matching curve. */
  readonly growthRateName?: string;
  /** Iter 104 cross-ref - XP needed to reach level 100 in this species'
   *  growth curve (also lifted from the matching ExperienceCurveEntry).
   *  Surfaces "how much XP to max" inline without manifest lookup. */
  readonly growthRateXpAtLevel100?: number;
  /** Iter 106 cross-ref - decoded primary ability name from
   *  ctx.abilities lookup via the ability1 byte. */
  readonly ability1Name?: string;
  /** Iter 106 cross-ref - decoded secondary ability name from
   *  ctx.abilities lookup via the ability2 byte. */
  readonly ability2Name?: string;
  /** Iter 110 cross-ref - decoded held-item slot 1 name from
   *  ctx.items lookup via the item1 byte (held-item drop chance 1). */
  readonly item1Name?: string;
  /** Iter 110 cross-ref - decoded held-item slot 2 name from
   *  ctx.items lookup via the item2 byte (held-item drop chance 2). */
  readonly item2Name?: string;
}

/** Phase UX-B - Region-map area entry from the universal Gen-3
 *  gRegionMapEntries table. Each entry corresponds to one position on
 *  the world map (Pallet Town, Route 1, Mt. Moon, etc.). The
 *  `sectionIndex` matches the regionMapSection byte stored on every
 *  MapHeader (at offset 0x14), so cross-ref 18 can look up a map's
 *  real area name by that byte. */
export interface RegionMapSectionEntry {
  readonly id: string;
  /** Index in the gRegionMapEntries table - matches every MapHeader's
   *  regionMapSection byte. */
  readonly sectionIndex: number;
  /** Top-left region-map tile x coord. */
  readonly x: number;
  /** Top-left region-map tile y coord. */
  readonly y: number;
  /** Width in region-map tiles. */
  readonly width: number;
  /** Height in region-map tiles. */
  readonly height: number;
  /** ROM pointer to the name string (0 = unnamed sentinel slot). */
  readonly nameRomPointer: number;
  /** Decoded area name (empty when nameRomPointer=0). */
  readonly name: string;
  /** Absolute file offset of the 12-byte struct. */
  readonly sourceFileOffset: number;
}

/** Phase O.42 - One spawn destination from the Gen-3 sHealLocations[]
 *  table. The game warps the player to (group, mapNum, x, y) on
 *  white-out, after Fly / Teleport, and for mom's house initial spawn.
 *  Slots are SPAWN_* indices: 0 = first spawn (PALLET_TOWN in FRLG),
 *  1 = second, etc. */
export interface HealLocationEntry {
  readonly id: string;
  /** SPAWN_* index - slot 0 corresponds to SPAWN_PALLET_TOWN in vanilla FRLG. */
  readonly slotIndex: number;
  /** Map group byte. */
  readonly group: number;
  /** Map num byte. */
  readonly mapNum: number;
  /** Destination tile x. */
  readonly x: number;
  /** Destination tile y. */
  readonly y: number;
  /** Cross-ref 21 - resolved destination map id matching the
   *  `binary_map_<group>_<num>` synthetic id when the (group, mapNum)
   *  pair points at a known map; null when out of range. */
  readonly destMapId: string | null;
  /** Absolute file offset of this 6-byte struct. */
  readonly sourceFileOffset: number;
}

/** Phase O.3 - One choice within a MultichoiceListRecord. */
export interface MultichoiceChoiceRecord {
  /** Index within the parent list (0-based). */
  readonly choiceIndex: number;
  /** Decoded choice text (e.g. "YES", "NO", "PIKACHU"). */
  readonly text: string;
  /** File offset of the text bytes - write path for renaming this choice. */
  readonly textFileOffset: number;
}

/** Phase O.3 - One entry in gMultichoiceLists[]. The script `multichoice`
 *  opcode's listId arg indexes into this table; each entry points at a
 *  MenuAction[] whose strings are the visible choice labels. */
export interface MultichoiceListRecord {
  readonly id: string;
  /** Index within gMultichoiceLists[] = the script opcode's listId arg. */
  readonly listIndex: number;
  /** File offset of this list's 8-byte gMultichoiceLists entry. */
  readonly entryFileOffset: number;
  /** Choice count from the entry's count byte. */
  readonly count: number;
  /** Decoded choices (text + per-choice write offset). */
  readonly choices: ReadonlyArray<MultichoiceChoiceRecord>;
}

/** Iter 105 - Single evolution slot within an EvolutionBlock.
 *  Mirrors the engine's `Evolution` struct (method enum, condition
 *  param, target species index). targetSpeciesName populated by
 *  iter-105 cross-ref against ctx.speciesNames lookup. */
export interface SpeciesEvolutionSlot {
  /** Evolution method enum (0..N - level, item, friendship, trade, etc.). */
  readonly method: number;
  /** Method parameter (level number, item index, friendship threshold, etc.). */
  readonly param: number;
  /** Target species index. */
  readonly targetSpecies: number;
  /** Absolute file offset of this 8-byte slot. */
  readonly fileOffset: number;
  /** Iter 105 cross-ref output - decoded target species name. */
  readonly targetSpeciesName?: string;
}

/** Iter 105 - Per-species evolution chain entry from species_evolutions
 *  detector. Carries only the POPULATED slots (engine filters EVO_NONE
 *  via EvolutionBlock.populatedSlots). Vanilla FRLG: ~80 species have
 *  ≥1 populated evolution (the rest are stage-3 final forms or
 *  unevolving). */
export interface SpeciesEvolutionEntry {
  readonly id: string;
  readonly speciesIndex: number;
  readonly slots: ReadonlyArray<SpeciesEvolutionSlot>;
  /** Absolute file offset of the 40-byte EvolutionBlock. */
  readonly sourceFileOffset: number;
}

/** Iter 105 - Single level-up moveset entry: at level N, learns move M.
 *  moveName populated by iter-105 cross-ref against ctx.moveNames lookup. */
export interface SpeciesLearnsetMove {
  /** Level the move is learned at (1..100). */
  readonly level: number;
  /** Move index (0..N - same indexing as moves_system / battleMoves). */
  readonly move: number;
  /** Iter 105 cross-ref output - decoded move name. */
  readonly moveName?: string;
}

/** Iter 105 - Per-species level-up learnset from species_learnsets
 *  detector. Vanilla FRLG: 411 species, each with ~10-20 entries
 *  through the 0xFFFF terminator. ~5,000 entries total per scan. */
export interface SpeciesLearnsetEntry {
  readonly id: string;
  readonly speciesIndex: number;
  /** Absolute file offset of the per-species learnset array. */
  readonly arrayFileOffset: number;
  /** ROM pointer to the array (u32) from the gLevelUpLearnsets table. */
  readonly pointerRaw: number;
  /** Phase O.10 - file offset of the u32 pointer slot in
   *  gLevelUpLearnsets[] (= tableStart + speciesIndex × 4). Needed
   *  for "append a move" relocation: the new larger learnset gets
   *  allocated in free ROM space, and this slot's u32 is rewritten
   *  to point at the new location. */
  readonly pointerFileOffset?: number;
  readonly moves: ReadonlyArray<SpeciesLearnsetMove>;
}

/** Iter 105 - Per-species TM/HM compatibility from species_tmhm
 *  detector. The 64-bit bitfield (low + high u32) determines which TMs
 *  and HMs each species can learn. Vanilla FRLG: 411 species × 8-byte
 *  TMHMCompat each. compatibleTmIndices + compatibleHmIndices split the
 *  raw bit indices (0..49) into the TM (0..49) and HM (50..57) ranges
 *  per the gTMHMLearnsets convention. */
export interface SpeciesTMHMEntry {
  readonly id: string;
  readonly speciesIndex: number;
  /** Low u32 of the 64-bit compat bitfield. */
  readonly low: number;
  /** High u32. */
  readonly high: number;
  /** All set bit indices (0..63). */
  readonly setBitIndices: ReadonlyArray<number>;
  /** TM indices (0..49) the species is compatible with. */
  readonly compatibleTmIndices: ReadonlyArray<number>;
  /** HM indices (0..7) the species is compatible with. */
  readonly compatibleHmIndices: ReadonlyArray<number>;
  /** Absolute file offset of this 8-byte slot. */
  readonly sourceFileOffset: number;
}

/** Iter 101 - Overworld sprite metadata from overworld_sprites_system
 *  detector (NEW DETECTOR + co-shipped lifter per UW-D-0015 invariant).
 *  Each entry corresponds to a row in the universal Gen-3
 *  `gObjectEventGraphicsInfoPointers[]` table - vanilla FRLG has ~239
 *  sprites; heavy hacks (Unbound) add 100+. Per-sprite fields decoded
 *  from the 36-byte ObjectEventGraphicsInfo struct: tileTag, paletteTag,
 *  reflectionPaletteTag, size enum, width/height in pixels, packed
 *  bitfield byte (paletteSlot+shadowSize+inanimate+disableReflPalLoad),
 *  movement tracks enum, struct file offset for raw-view inspection. */
export interface OverworldSpriteEntry {
  readonly id: string;
  /** Index in the pointer table (matches the `graphicsId` byte used by
   *  map-system ObjectEvent entries). */
  readonly spriteIndex: number;
  /** Absolute file offset of the 36-byte struct this entry's pointer
   *  targets. */
  readonly structFileOffset: number;
  /** tileTag from struct offset 0x00 (often 0xFFFF for non-tile-cached
   *  sprites). */
  readonly tileTag: number;
  /** Sprite palette tag from struct offset 0x02. */
  readonly paletteTag: number;
  /** Reflection palette tag from struct offset 0x04 (often 0x11FF in
   *  vanilla). */
  readonly reflectionPaletteTag: number;
  /** OAM size enum from struct offset 0x06 (0..31). */
  readonly size: number;
  /** Sprite width in pixels from struct offset 0x08 (8..256). */
  readonly width: number;
  /** Sprite height in pixels from struct offset 0x0A. */
  readonly height: number;
  /** Packed bitfield byte from struct offset 0x0C - bits 0-3 paletteSlot,
   *  4-5 shadowSize, 6 inanimate, 7 disableReflectionPaletteLoad. */
  readonly paletteSlotBits: number;
  /** Movement tracks enum from struct offset 0x0D (0..6). */
  readonly tracks: number;
  /** Absolute file offset of this entry's slot in the pointer table. */
  readonly pointerTableEntryOffset: number;
}

/** Phase F (semantic-world plan §3.1) - One detected tileset in the
 *  ROM, lifted from the map_system detector. Each entry represents a
 *  unique 24-byte Tileset struct in ROM (deduplicated by file offset;
 *  one tileset can be referenced as the primary on some maps and the
 *  secondary on others). The `usedByMapIds[]` cross-ref lets the
 *  tileset browser show "where is this used" and helps surface
 *  unused/orphan tilesets. */
export interface TilesetEntry {
  readonly id: string;
  /** Absolute file offset of the 24-byte Tileset struct. */
  readonly structFileOffset: number;
  /** `isSecondary` flag from struct offset 0x01. A given tileset slot
   *  is either always primary (0) or always secondary (1) - the role
   *  is fixed at compile time. Primary tilesets contribute palettes
   *  0..numPalsInPrimary-1 and tiles 0..numTilesInPrimary-1; secondary
   *  contributes the rest. */
  readonly isSecondary: boolean;
  /** `isCompressed` flag from struct offset 0x00 - drives whether the
   *  tile sheet at `tilesOffset` is LZ77-encoded. */
  readonly isCompressed: boolean;
  /** Pointer slot at struct offset 0x04 - tile graphics. */
  readonly tilesOffset: number | null;
  /** Pointer slot at struct offset 0x08 - 16-palette block. */
  readonly palettesOffset: number | null;
  /** Pointer slot at struct offset 0x0C - metatiles array. */
  readonly metatilesOffset: number | null;
  /** Map ids that reference this tileset as their primary or secondary.
   *  Multi-tenancy is normal: vanilla "general" tileset is the primary
   *  for every outdoor map. */
  readonly usedByMapIds: ReadonlyArray<string>;
  /** Count of maps using this tileset (== usedByMapIds.length). */
  readonly usageCount: number;
}

/** Phase F (semantic-world plan §1.1) - One slot in the Gen-3
 *  `sObjectEventSpritePalettes[]` table. Each slot maps a palette tag
 *  (matching `OverworldSpriteEntry.paletteTag`) to a fully decoded
 *  16-color RGBA palette so the frontend can render OW sprites in
 *  color instead of grayscale. The `paletteRgba` array is a snapshot
 *  of the engine's bgr555ToRgba output (16 × u32, index 0 transparent
 *  per the Gen-3 4bpp convention). */
export interface ObjectEventPaletteEntry {
  readonly id: string;
  /** Entry index in the table (0-based, before NULL sentinel). */
  readonly entryIndex: number;
  /** Palette tag matching OverworldSpriteEntry.paletteTag. Vanilla
   *  FRLG uses tags 0x1100..0x111F + the 0x11FF sentinel. */
  readonly tag: number;
  /** Absolute file offset of the 8-byte SpritePalette entry slot. */
  readonly entryFileOffset: number;
  /** Absolute file offset of the 32-byte BGR555 palette block this
   *  entry points to. */
  readonly paletteFileOffset: number;
  /** Decoded 16-color palette as u32 RGBA values (length 16). Index 0
   *  is 0x00000000 (transparent) per the GBA 4bpp sprite convention. */
  readonly paletteRgba: ReadonlyArray<number>;
}

/** Iter 100 - Experience growth-curve entry from experience_curves_system
 *  detector (NEW DETECTOR + co-shipped lifter per UW-D-0015 invariant).
 *  One entry per Gen-3 growth-rate row (Erratic / Fast / Medium-Fast /
 *  Medium-Slow / Slow / Fluctuating). The `xpPerLevel` array carries
 *  all 101 u32 values [level 0..100] in table order so the editor can
 *  render the full XP-to-next-level curve. `growthRateName` is inferred
 *  from the level-100 XP magnitude (vanilla profiles match within
 *  ±0.5%); null when a hack rewrote curves with non-canonical
 *  magnitudes (PD 16). */
export interface ExperienceCurveEntry {
  readonly id: string;
  /** Index in the discovered table (0..5). */
  readonly curveIndex: number;
  /** Canonical growth-rate name (MEDIUM_FAST / ERRATIC / FLUCTUATING /
   *  MEDIUM_SLOW / FAST / SLOW) inferred from xpAtLevel100, or null if
   *  the curve's magnitude doesn't match any known profile. */
  readonly growthRateName: string | null;
  /** XP needed to reach level 100 (largest entry in the curve). */
  readonly xpAtLevel100: number;
  /** Absolute file offset of this curve's u32[101] sub-array. */
  readonly subTableOffset: number;
  /** All 101 XP values in [level 0..100] order. */
  readonly xpPerLevel: ReadonlyArray<number>;
}

/** Iter 94 - Ability entry from abilities_system detector's sample. */
export interface AbilityEntry {
  readonly id: string;
  readonly abilityIndex: number;
  readonly name: string;
  readonly sourceTableOffset: number;
  /** Phase N.5 - 13-byte name slot file offset. */
  readonly nameSlotOffset?: number;
}

/** Iter 94 - Pokédex entry from pokedex_system detector's sample
 *  (iters 82 + 91 add category + flavor text). Richer than the other
 *  4 because the pokedex detector exposes per-entry category + decoded
 *  flavor text via descriptionPtr. Iter 96 adds speciesName (optional,
 *  populated by the cross-ref pass when species_names lifter has run). */
export interface PokedexEntryRecord {
  readonly id: string;
  readonly speciesIndex: number;
  readonly category: string;
  readonly flavorText: string;
  readonly sourceTableOffset: number;
  /** Iter 96 cross-ref - decoded species name from species_names
   *  detector when available; absent if the cross-ref couldn't
   *  resolve (out-of-bounds index or species_names didn't run). */
  readonly speciesName?: string;
  /** Phase O.2 - per-entry struct file offset (start of this entry's
   *  32-byte PokedexEntry block). categoryNameFileOffset = this. */
  readonly entryFileOffset?: number;
  /** Phase O.2 - file offset of the flavor-text bytes (descriptionPtr
   *  − GBA_ROM_BASE_ADDRESS). Absent when the pointer is null /
   *  out-of-ROM. When present, an editor can patch the bytes in place
   *  via the existing `editBinaryRomDialogueString` route. */
  readonly descriptionFileOffset?: number;
}

/** Iter 96 - Trainer-class name entry from trainer_class_names
 *  detector's sample. Used as the cross-reference target for
 *  Trainer.className resolution. */
export interface TrainerClassNameEntry {
  readonly id: string;
  readonly classIndex: number;
  readonly name: string;
  readonly sourceTableOffset: number;
  /** Phase N.5 - 13-byte name slot file offset. */
  readonly nameSlotOffset?: number;
}

/** Iter 97 - Type name entry from type_names detector's sample.
 *  Used as the cross-reference target for type matchup entries (so
 *  attackerType=10 resolves to "FIRE", defenderType=11 to "WATER", etc.). */
export interface TypeNameEntry {
  readonly id: string;
  readonly typeIndex: number;
  readonly name: string;
  readonly sourceTableOffset: number;
}

/** Iter 97 - Type matchup entry from type_chart_system detector's
 *  parsed matchup table (gTypeEffectiveness). Each entry records one
 *  attacker→defender effectiveness rule. The iter-97 cross-ref pass
 *  populates attackerTypeName + defenderTypeName by looking up
 *  typeIndex in ctx.typeNames; absent until cross-ref runs. */
export interface TypeMatchupEntry {
  readonly id: string;
  readonly attackerType: number;
  readonly defenderType: number;
  /** Multiplier × 10 (e.g. 20 = 2× super-effective, 5 = 0.5× resistance,
   *  0 = no effect) per the Gen-3 engine convention. */
  readonly effectiveness: number;
  readonly sourceTableOffset: number;
  /** Phase N - file offset of this 3-byte matchup entry (parent table
   *  offset + entryIndex * 3). Editable via /binary-rom-edit/type-matchup. */
  readonly entryFileOffset?: number;
  /** Iter 97 cross-ref outputs (populated when type_names detector ran). */
  readonly attackerTypeName?: string;
  readonly defenderTypeName?: string;
}

/** Iter 98 - Save-block entry from save_system + save_data_system
 *  detectors. `kind` distinguishes between Nintendo SDK identifier
 *  strings ("FLASH1M_V103", "SRAM_V112", etc.) and Gen-3 save-sector
 *  footer magic occurrences (0x08012025 at 0xFF0 within each sector). */
export interface SaveBlockEntry {
  readonly id: string;
  readonly kind: 'sdk_identifier' | 'sector_magic';
  /** SDK identifier string OR a label like "Save sector #N magic" for
   *  the sector_magic kind. */
  readonly label: string;
  /** Byte offset in the ROM where the identifier/magic was found. */
  readonly offset: number;
  /** kind=sdk_identifier: backend family ("SRAM" / "FLASH" / "EEPROM").
   *  kind=sector_magic: undefined. */
  readonly family?: string;
  /** kind=sdk_identifier: declared backup size (per SDK convention).
   *  kind=sector_magic: total save size (sectorCount × sectorSize). */
  readonly sizeBytes?: number;
  /** kind=sector_magic: 1-based sector index inferred from offset.
   *  kind=sdk_identifier: undefined. */
  readonly sectorIndex?: number;
}

/** Iter 98 - Menu prompt match from menu_system detector. */
export interface MenuEntry {
  readonly id: string;
  readonly prompt: string;
  readonly firstOffset: number;
  readonly occurrenceCount: number;
}

/** Per-subsystem result captured by the BinaryRomScanner - one entry
 *  per engine detector that ran (every detector in
 *  `buildDefaultDetectorSet()`). PD 13: this IS the editor's view of
 *  detector output; no parallel derivation. */
export interface BinaryRomScanSubsystem {
  readonly id: string;
  readonly name: string;
  readonly phase: number;
  readonly status: 'detected' | 'partial' | 'not_detected';
  readonly confidence: number;
  readonly runtimeMs: number;
  /** Lifted from the primary evidence (e.g. "Found gTrainers at
   *  offset 0x..."). */
  readonly summary: string | null;
  /** Lifted from `data.sampleNames` when the detector exposes them
   *  (chip-list preview for the editor's DetectedSubsystemsSection). */
  readonly sampleNames?: ReadonlyArray<string>;
  /** Whether this detector's structured output was lifted into one of
   *  the standard manifest collections (maps[], trainers[], etc.) via
   *  the binary-rom-registry. If false, the subsystem is still
   *  surfaced via this entry but no standard-collection lift exists
   *  yet (the registry will grow). */
  readonly liftedToManifest: boolean;
  /** Name of the manifest collection this subsystem was lifted into
   *  ('maps' / 'trainers' / 'dialogue' / 'encounterTables' / 'assets'
   *  / 'flags' / 'variables' / etc.) when `liftedToManifest === true`.
   *  Null otherwise. */
  readonly liftedCollection: string | null;
}

/** Full report from the BinaryRomScanner - surfaced via
 *  `ProjectManifest.binaryRom`. PD 12: per-byte accounting (coverage
 *  totals + scored-unknown regions); per-subsystem accounting
 *  (every detector's status). PD 16: the `subsystems[]` array
 *  surfaces hack-detected systems via the same channel as known
 *  systems - no silent "unrecognized" bucket. */
export interface BinaryRomScanReport {
  /** SHA-1 of the scanned ROM bytes. */
  readonly romSha1: string;
  /** Byte length of the ROM. */
  readonly romByteLength: number;
  /** Source path of the ROM file. */
  readonly sourcePath: string;
  /** Total detectors that ran (= buildDefaultDetectorSet() length). */
  readonly detectorCount: number;
  /** Number of detectors that returned 'detected'. */
  readonly detectedCount: number;
  /** Number of detectors that returned 'partial'. */
  readonly partialCount: number;
  /** Number of detectors that returned 'not_detected' (graceful
   *  per PD 1; not an error). */
  readonly notDetectedCount: number;
  /** Number of detectors that were lifted to a standard manifest
   *  collection (maps/trainers/dialogue/etc.). The remainder are
   *  surfaced via `subsystems[]` only. THE BINARY ROM SCANNER GROWS
   *  WITH DETECTION CAPABILITY: when a new detector lands, register
   *  a lifter in `binary-rom-registry.ts` to lift its structured
   *  output here. */
  readonly liftedCount: number;
  /** Coverage summary lifted from the engine's IngestReport. */
  readonly coverageSummary: CoverageSummary;
  /** Every detector that ran, with status + confidence + summary +
   *  sampleNames + lift status. Sorted by phase then id. */
  readonly subsystems: ReadonlyArray<BinaryRomScanSubsystem>;
  /** Total wall-clock duration of the full ingest pipeline (ms). */
  readonly ingestDurationMs: number;
}

export function emptyManifest(projectRoot: string, generatedAtUtc: string): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc,
    projectRoot,
    identity: {
      kind: 'unknown',
      confidence: 0,
      displayName: 'Unknown project',
      baseGame: null,
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
}
