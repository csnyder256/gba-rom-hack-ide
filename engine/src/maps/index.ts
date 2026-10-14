export {
  MAP_HEADER_OFFSET_BATTLE_TYPE,
  MAP_HEADER_OFFSET_BIKING_ALLOWED,
  MAP_HEADER_OFFSET_FLAGS,
  MAP_HEADER_OFFSET_FLOOR_NUM,
  MAP_HEADER_SIZE_BYTES,
  MAP_TYPE_MAX,
  parseMapHeader,
  type MapHeader,
  type MapHeaderParseFailure,
  type MapHeaderParseResult,
} from './header.js';

export {
  scanMapHeaders,
  totalMapHeaderBytes,
  type MapHeaderEntry,
  type MapTableCandidate,
  type ScanMapHeadersOptions,
} from './scanner.js';

export {
  BG_EVENT_STRUCT_SIZE_BYTES,
  COORD_EVENT_STRUCT_SIZE_BYTES,
  MAP_EVENTS_STRUCT_SIZE_BYTES,
  OBJECT_EVENT_STRUCT_SIZE_BYTES,
  WARP_EVENT_STRUCT_SIZE_BYTES,
  parseMapEvents,
  type BgEvent,
  type CoordEvent,
  type MapEventsArrayKind,
  type MapEventsParseFailure,
  type MapEventsParseResult,
  type MapEventsParsed,
  type ObjectEvent,
  type WarpEvent,
} from './events.js';

export {
  MAP_CONNECTIONS_HEADER_SIZE_BYTES,
  MAP_CONNECTION_STRUCT_SIZE_BYTES,
  parseMapConnections,
  type MapConnection,
  type MapConnectionsParsed,
  type MapConnectionsParseFailure,
  type MapConnectionsParseResult,
} from './connections.js';

export {
  findMapGroupsOuterTable,
  type MapGroupsInnerTableRange,
  type MapGroupsInnerTableRef,
  type MapGroupsOuterTable,
} from './groups.js';

export {
  MAP_LAYOUT_MAX_DIMENSION,
  MAP_LAYOUT_MIN_DIMENSION,
  MAP_LAYOUT_STRUCT_SIZE_BYTES,
  parseMapLayout,
  type MapLayout,
  type MapLayoutParseFailure,
  type MapLayoutParseResult,
} from './layout.js';

export {
  WILD_ENCOUNTERS_SENTINEL_MAP_GROUP,
  WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES,
  parseWildPokemonHeader,
  type EncounterKind,
  type WildPokemonHeader,
  type WildPokemonHeaderParseFailure,
  type WildPokemonHeaderParseResult,
} from './encounters.js';

export {
  scanWildEncountersTable,
  type ScanWildEncountersOptions,
  type WildEncountersTable,
} from './encounter-scanner.js';

export {
  MAP_SCRIPT_ENTRY_SIZE_BYTES,
  MAP_SCRIPT_TERMINATOR,
  MAP_SCRIPT_TYPE_MAX,
  MAP_SCRIPT_TYPE_NAMES,
  MAP_SCRIPTS_MAX_ENTRIES,
  parseMapScripts,
  type MapScriptEntry,
  type MapScriptTypeName,
  type MapScriptsParsed,
  type MapScriptsParseFailure,
  type MapScriptsParseResult,
} from './scripts.js';

export {
  MAP_BATTLE_TYPE_NAMES,
  MAP_CAVE_OR_TYPE_NAMES,
  MAP_FLAGS_BITS,
  MAP_FLAGS_SHOW_MAP_NAME_NAME,
  MAP_FLAGS_SHOW_MAP_NAME_SHIFT,
  MAP_TYPE_NAMES,
  MAP_WEATHER_NAMES,
  aggregateMapProperties,
  nameFlagsBits,
  nameFromTable,
  type MapPropertiesHistogram,
  type MapPropertiesInput,
} from './map-properties.js';

export {
  TILESET_STRUCT_SIZE_BYTES,
  parseTileset,
  type TilesetParseFailure,
  type TilesetParseResult,
  type TilesetParsed,
  type TilesetSlot,
} from './tileset.js';

export {
  MAP_SCRIPT_STUB_SIZE_BYTES,
  MAP_SCRIPT_STUB_TERMINATOR_SIZE_BYTES,
  MAP_SCRIPT_STUBS_MAX_ENTRIES,
  parseConditionalScriptTable,
  type ConditionalScriptTable,
  type ConditionalScriptTableParseFailure,
  type ConditionalScriptTableParseResult,
  type MapScriptStub,
} from './conditional-scripts.js';

export {
  METATILE_ATTRIBUTES_SIZE_BYTES,
  TILESET_MAX_METATILES,
  TILESET_MAX_TILES,
  TILESET_PALETTES_PER_BLOCK,
  fetchTilesetGraphics,
  type FetchTilesetGraphicsArgs,
  type FetchTilesetGraphicsOptions,
  type TilesetGraphics,
} from './tileset-graphics.js';

export {
  metatileAttributesStride,
  parseMetatileAttributes,
  encodeMetatileAttributes,
  type MetatileAttributes,
  type MetatileAttributesFamily,
} from './metatile-attributes.js';

// Phase 3.1 - map writers.
export {
  encodeMapHeader,
  MapHeaderEncodeError,
  type MapHeaderSpec,
} from './header-writer.js';

export {
  encodeMapLayout,
  encodeBlockGrid,
  encodeBorderBlocks,
  MapLayoutEncodeError,
  type MapLayoutSpec,
} from './layout-writer.js';

export {
  encodeMapConnection,
  encodeMapConnectionsArray,
  encodeMapConnectionsHeader,
  MapConnectionEncodeError,
  type MapConnectionSpec,
} from './connections-writer.js';

export {
  encodeTileset,
  TilesetEncodeError,
  type TilesetSpec,
} from './tileset-writer.js';

export {
  encodeRegionMapSection,
  liftRegionMapSections,
  RegionMapSectionEncodeError,
  type ManifestRegionMapEntry,
  type RegionMapSectionSpec,
} from './region-map-sections-writer.js';
