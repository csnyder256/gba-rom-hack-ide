/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  BINARY-ROM-LIFTER REGISTRY - THIS FILE GROWS WITH DETECTION     ║
 * ║                                                                  ║
 * ║  Iter 92 / UW-3-T11 - initial registry pattern.                 ║
 * ║  Iter 93 / UW-3-T12 - DEEP LIFTERS using actual detector report ║
 * ║  shapes (iter 92 used speculative field names that didn't match  ║
 * ║  the real outputs; bug fix + real-data population this iter).    ║
 * ║                                                                  ║
 * ║  Per the universal-workspace product master (PD 12 no dead zones ║
 * ║  + PD 13 engine ↔ editor SSOT + PD 16 hack-aware                ║
 * ║  classification): this registry maps engine detector IDs →       ║
 * ║  "lifter" functions that translate the detector's structured     ║
 * ║  output into the standard ProjectManifest collections (maps[],   ║
 * ║  warps[], objectEvents[], trainers[], dialogue[],                ║
 * ║  encounterTables[], assets[], flags[], variables[]).             ║
 * ║                                                                  ║
 * ║  WHEN YOU ADD A NEW DETECTOR TO `buildDefaultDetectorSet()`:    ║
 * ║                                                                  ║
 * ║    1. The detector runs automatically - no wiring needed for it ║
 * ║       to appear in `binaryRom.subsystems[]`. PD 12 honored.      ║
 * ║                                                                  ║
 * ║    2. IF the detector produces structured data that should fill ║
 * ║       a standard manifest collection, register a lifter here     ║
 * ║       AND check the detector's actual Report interface in        ║
 * ║       engine/src/detectors/<detector>-system.ts before writing   ║
 * ║       the lifter - iter 92 lost a day to wrong field names       ║
 * ║       discovered only when iter 93 looked closely.               ║
 * ║                                                                  ║
 * ║    3. IF the detector's data doesn't fit any standard            ║
 * ║       collection, DO NOT FORCE A LIFTER. It still surfaces via   ║
 * ║       subsystems[]. The manifest schema MAY grow new collections ║
 * ║       (species[], items[], moves[], abilities[], menus[],        ║
 * ║       saveBlocks[]) when categories deepen - schemaVersion bump. ║
 * ║                                                                  ║
 * ║  PRINCIPLES:                                                     ║
 * ║    - Lifters are pure functions: (detection, ctx) → entries.    ║
 * ║    - Lifters never throw on missing/malformed data; degrade to  ║
 * ║      empty arrays so the scanner is robust on heavy hacks.       ║
 * ║    - Lifters produce REAL entries when the detector exposes      ║
 * ║      per-entry data (map dimensions, trainer names, encounter   ║
 * ║      slots, warp destinations). Synthetic placeholders are a    ║
 * ║      last resort only when the detector truly returns no per-   ║
 * ║      entry data.                                                 ║
 * ║                                                                  ║
 * ║  THIS FILE IS WHERE "ACCOUNT FOR EVERYTHING DETECTABLE" LIVES.  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import type {
  AbilityEntry,
  Asset,
  BattleMoveEntry,
  DialogueNode,
  EncounterSlot,
  EncounterTable,
  EncounterTableType,
  ExperienceCurveEntry,
  Flag,
  ItemEntry,
  MapGroup,
  MapNode,
  MenuEntry,
  MoveNameEntry,
  ObjectEvent,
  ObjectEventKind,
  ObjectEventPaletteEntry,
  OverworldSpriteEntry,
  TilesetEntry,
  PokedexEntryRecord,
  RegionMapSectionEntry,
  MultichoiceListRecord,
  HealLocationEntry,
  SaveBlockEntry,
  ScriptStep,
  SpeciesEntry,
  SpeciesEvolutionEntry,
  SpeciesEvolutionSlot,
  SpeciesLearnsetEntry,
  SpeciesLearnsetMove,
  SpeciesNameEntry,
  SpeciesTMHMEntry,
  Trainer,
  TrainerClassNameEntry,
  TrainerPartyMember,
  Trigger,
  TypeMatchupEntry,
  TypeNameEntry,
  Variable,
  Warp,
} from '@rom-editor/shared';
import type { ingest} from '@rom-introspection/engine';
import { scripts as engineScripts, text as engineText } from '@rom-introspection/engine';

/** Accumulator passed to each lifter; mutated with the lifted entries.
 *  Iter 94 adds 5 new collections (speciesNames / moveNames / items /
 *  abilities / pokedexEntries). Iter 95 adds triggers + scriptSteps so
 *  liftMapSystem can lift per-map coordEvents + bgEvents + mapScripts
 *  + conditionalScripts data already exposed by the engine. */
export interface LifterContext {
  maps: MapNode[];
  warps: Warp[];
  objectEvents: ObjectEvent[];
  triggers: Trigger[];
  scriptSteps: ScriptStep[];
  dialogue: DialogueNode[];
  flags: Flag[];
  variables: Variable[];
  encounterTables: EncounterTable[];
  trainers: Trainer[];
  assets: Asset[];
  speciesNames: SpeciesNameEntry[];
  moveNames: MoveNameEntry[];
  items: ItemEntry[];
  abilities: AbilityEntry[];
  pokedexEntries: PokedexEntryRecord[];
  trainerClassNames: TrainerClassNameEntry[];
  typeNames: TypeNameEntry[];
  typeMatchups: TypeMatchupEntry[];
  saveBlocks: SaveBlockEntry[];
  menus: MenuEntry[];
  /** Iter 99 - per-move struct data lifted from moves_system detector's
   *  deepened battleMovesTable.moves[] array (the engine scanner now
   *  re-parses on accepted runs to expose every move's
   *  effect/power/type/accuracy/pp/etc.). Cross-ref pass populates
   *  optional name (from moveNames) + typeName (from typeNames). */
  battleMoves: BattleMoveEntry[];
  /** Iter 100 - Gen-3 experience curves from the NEW
   *  experience_curves_system detector (one entry per growth-rate row,
   *  always 6 in vanilla; each carries all 101 xpPerLevel values + the
   *  inferred canonical growth-rate name). */
  experienceCurves: ExperienceCurveEntry[];
  /** Iter 101 - Gen-3 overworld sprite metadata from the NEW
   *  overworld_sprites_system detector (one entry per sprite in the
   *  gObjectEventGraphicsInfoPointers[] array; vanilla FRLG ~239,
   *  heavy hacks 300+). */
  overworldSprites: OverworldSpriteEntry[];
  /** Phase F (semantic-world plan §1.1) - Gen-3 OW palette table
   *  entries from object_event_palettes_system detector. Each entry
   *  carries a 16-color RGBA palette resolved from the
   *  sObjectEventSpritePalettes[] slot. Cross-ref 22 attaches the
   *  resolved palette to each ObjectEvent.metadata so the frontend
   *  can render NPCs in color. */
  objectEventPalettes: ObjectEventPaletteEntry[];
  /** Phase F (semantic-world plan §3.1) - Tileset registry. Lifted
   *  from map_system's tilesets[] array (one entry per unique tileset
   *  struct in ROM) with usedByMapIds[] built incrementally as maps
   *  reference them. Powers the universal tileset browser. */
  tilesets: TilesetEntry[];
  /** Iter 103 - Per-species BaseStats data lifted from species_system
   *  detector's baseStatsTable.records[] (engine already exposes this
   *  since iter 73; the lifter was the missing piece). Vanilla FRLG
   *  411 species × full 22-field structs = largest single per-entry
   *  surface in the manifest. */
  species: SpeciesEntry[];
  /** Iter 105 - Per-species evolution chains (populatedSlots filtered;
   *  vanilla ~80 species evolve). */
  speciesEvolutions: SpeciesEvolutionEntry[];
  /** Iter 105 - Per-species level-up movesets (~5000 entries total
   *  vanilla FRLG). */
  speciesLearnsets: SpeciesLearnsetEntry[];
  /** Iter 105 - Per-species TM/HM compat bitfields. */
  speciesTMHM: SpeciesTMHMEntry[];
  /** Phase UX-B - Region-map area sections lifted from
   *  region_map_sections_system. Drives cross-ref 18 which rewrites
   *  map.name to the real area name. */
  regionMapSections: RegionMapSectionEntry[];
  /** Phase O.3 - gMultichoiceLists table lifted from
   *  multichoice_lists_system. Each entry exposes its choice strings
   *  + per-choice text file offsets for in-place editing. */
  multichoiceLists: MultichoiceListRecord[];
  /** Phase O.42 - sHealLocations[] table lifted from
   *  heal_locations_system. Cross-ref 21 resolves each entry's
   *  (group, mapNum) → destMapId after maps are lifted. */
  healLocations: HealLocationEntry[];
}

/** A lifter receives one detector's full result row + the accumulator.
 *  Returns the manifest-collection name it populated (or comma-separated
 *  list when one lifter writes to multiple collections - e.g. map_system
 *  populates maps + warps + objectEvents). Returns null when nothing was
 *  produced (detector returned not_detected or had no structured data). */
export type ManifestLifter = (
  row: ingest.DetectionRunResult,
  ctx: LifterContext,
) => string | null;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function ifDetected<T>(
  row: ingest.DetectionRunResult,
  fn: (data: T) => string | null,
): string | null {
  if (row.detection.status !== 'detected') return null;
  return fn(row.detection.data as T);
}

/** Stable map id format used by liftMapSystem and referenced by
 *  liftWarps/liftObjectEvents so warp destinations + obj-event parents
 *  cross-reference correctly. */
function mapIdFor(groupIndex: number | null, mapNum: number): string {
  const g = groupIndex === null ? '?' : String(groupIndex);
  return `binary_map_${g}_${String(mapNum)}`;
}

/** Gen-3 mapType byte → universal MapGroup vocabulary.
 *  Per pret/pokefirered include/constants/map_types.h:
 *    0 = NONE, 1 = TOWN, 2 = CITY, 3 = ROUTE, 4 = UNDERGROUND,
 *    5 = UNDERWATER, 6 = OCEAN_ROUTE, 7 = UNKNOWN, 8 = INDOOR, 9 = SECRET_BASE.
 *
 *  Phase 6.1 - conservative mapping. We ONLY recognise vanilla pret
 *  enum values that have a single, unambiguous editor bucket:
 *    1, 2  → 'town'      (TOWN, CITY)
 *    3     → 'route'     (ROUTE)
 *    4     → 'cave'      (UNDERGROUND)
 *    8, 9  → 'interior'  (INDOOR, SECRET_BASE)
 *  Everything else (0/NONE, 5/UNDERWATER, 6/OCEAN_ROUTE, 7/UNKNOWN,
 *  10+ which CFRU+DPE ROMs sometimes write) → 'unknown'.
 *
 *  The vanilla-truth overlay (Phase 6.5) overrides the byte-derived
 *  group with a known-per-(bank,num) mapping on modernised ROMs, so
 *  bucketing aggressively here would only hurt unknown / custom-hack
 *  ROMs without helping the modernised case. Honest 'Unsorted' is
 *  better than confidently-wrong "Caves (57)". */
export function mapTypeToMapGroup(mapType: number): MapGroup {
  switch (mapType) {
    case 1:
    case 2:
      return 'town';
    case 3:
      return 'route';
    case 4:
      return 'cave';
    case 8:
    case 9:
      return 'interior';
    default:
      return 'unknown';
  }
}

/** Decode trainer-name bytes via the engine's Gen-3 text codec.
 *  trainerNameBytes is the raw 12-byte slot; trainerNameLength is the
 *  byte count before the first 0xFF terminator. Returns the decoded
 *  Unicode string trimmed to the meaningful length. */
function decodeTrainerName(bytes: Uint8Array, length: number): string {
  if (length <= 0) return '';
  // Decode up to `length` bytes - terminator + padding excluded.
  return engineText.decodeString(bytes, 0, length);
}

/** Map encounter detector's per-kind key → editor EncounterTableType. */
function encounterKindToType(kind: string): EncounterTableType {
  switch (kind) {
    case 'land':
      return 'grass';
    case 'water':
      return 'water';
    case 'fishing':
      return 'fishing';
    case 'rockSmash':
      return 'rock_smash';
    default:
      return 'custom';
  }
}

// ─────────────────────────────────────────────────────────────────────
// LIFTERS - one per detector that fits a standard manifest collection.
// Cross-reference with the actual detector report shape in
// engine/src/detectors/<detector>-system.ts before editing.
// ─────────────────────────────────────────────────────────────────────

/** map_system → manifest.maps[] + manifest.warps[] + manifest.objectEvents[]
 *  PD 13: reads `MapSystemReport.enrichedMaps[]` which carries fully-
 *  parsed per-map data (layout dimensions, tilesets, warps, object
 *  events, music). Produces REAL MapNode entries with real width/height
 *  + tileset ids + music + warp counts + group classification.
 *  Iter 93 - fixes iter 92's stub that produced 0 maps because it
 *  read non-existent `data.mapCount` field. */
const liftMapSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    totalMapCount?: number;
    tilesets?: ReadonlyArray<{
      isCompressed: boolean;
      isSecondary: boolean;
      tilesOffset: number | null;
      palettesOffset: number | null;
      metatilesOffset: number | null;
      slot10Offset: number | null;
      slot14Offset: number | null;
      fileOffset: number;
    }>;
    enrichedMaps?: ReadonlyArray<{
      groupIndex: number | null;
      mapNum: number;
      mapHeaderOffset: number;
      mapType: number;
      weather: number;
      caveOrType: number;
      battleType: number;
      /** MapHeader byte 0x18 (pret `allow_cycling`). */
      bikingAllowed: boolean;
      /** MapHeader flags byte 0x19 (bit0 allowEscaping, bit1 allowRunning,
       *  bits 2..7 showMapName). */
      flags: number;
      /** MapHeader byte 0x1A (s8 floor number). */
      floorNum: number;
      musicId: number;
      regionMapSection?: number;
      layout: {
        width: number;
        height: number;
        primaryTilesetOffset: number | null;
        secondaryTilesetOffset: number | null;
        primaryBlocksOffset: number | null;
        fileOffset: number;
      } | null;
      events: {
        warpCount: number;
        objectEventCount: number;
        coordEventCount?: number;
        bgEventCount?: number;
        eventsStructOffset?: number;
        objectEventsArrayOffset?: number | null;
        warpsArrayOffset?: number | null;
        coordEventsArrayOffset?: number | null;
        bgEventsArrayOffset?: number | null;
        warps: ReadonlyArray<{
          x: number;
          y: number;
          elevation: number;
          warpId: number;
          destMapNum: number;
          destMapGroup: number;
          fileOffset: number;
        }>;
        objectEvents: ReadonlyArray<{
          localId: number;
          graphicsId: number;
          x: number;
          y: number;
          elevation: number;
          movementType: number;
          movementRangeXY: number;
          trainerType: number;
          trainerSightOrBerryTreeId: number;
          flagId: number;
          scriptOffset: number | null;
          fileOffset: number;
        }>;
        coordEvents?: ReadonlyArray<{
          x: number;
          y: number;
          elevation: number;
          trigger: number;
          index: number;
          scriptOffset: number | null;
          fileOffset: number;
        }>;
        bgEvents?: ReadonlyArray<{
          x: number;
          y: number;
          elevation: number;
          kind: number;
          dataOffset: number | null;
          dataRaw: number;
          fileOffset: number;
        }>;
      } | null;
      mapScripts?: {
        tableFileOffset: number;
        entryCount: number;
        entries: ReadonlyArray<{
          type: number;
          typeName: string;
          scriptOffset: number | null;
          rawScriptAddress: number;
          entryFileOffset: number;
        }>;
      } | null;
      conditionalScripts?: ReadonlyArray<{
        tableFileOffset: number;
        entryCount: number;
        entries: ReadonlyArray<{
          varCheck: number;
          valueCheck: number;
          scriptOffset: number | null;
          rawScriptAddress: number;
          entryFileOffset: number;
        }>;
      }>;
      connections?: {
        count: number;
        connections: ReadonlyArray<{
          direction: number;
          offset: number;
          destMapGroup: number;
          destMapNum: number;
          fileOffset: number;
        }>;
        headerStructOffset: number;
        connectionsArrayOffset: number | null;
        connectionsArrayByteLength: number;
      } | null;
    }>;
  }>(row, (data) => {
    const enriched = data.enrichedMaps ?? [];
    if (enriched.length === 0) return null;
    let mapCount = 0;
    let warpCount = 0;
    let objEventCount = 0;
    let triggerCount = 0;
    let scriptStepCount = 0;
    // Dedup map entries by mapHeaderOffset (some scan candidates can
    // re-detect the same physical map header from different anchors).
    const seenMapHeaders = new Set<number>();
    for (const em of enriched) {
      if (seenMapHeaders.has(em.mapHeaderOffset)) continue;
      seenMapHeaders.add(em.mapHeaderOffset);
      const mapId = mapIdFor(em.groupIndex, em.mapNum);
      const dim = em.layout
        ? { width: em.layout.width, height: em.layout.height }
        : { width: 0, height: 0 };
      const tilesetIds: string[] = [];
      if (em.layout?.primaryTilesetOffset != null) {
        tilesetIds.push(`tileset_0x${em.layout.primaryTilesetOffset.toString(16)}`);
      }
      if (em.layout?.secondaryTilesetOffset != null) {
        tilesetIds.push(`tileset_0x${em.layout.secondaryTilesetOffset.toString(16)}`);
      }
      const warpIds: string[] = [];
      const objectEventIds: string[] = [];
      // Lift warps + objectEvents into manifest.warps/objectEvents
      // ALONGSIDE the map. Cross-reference IDs match those below.
      if (em.events) {
        for (const w of em.events.warps) {
          const warpId = `binary_warp_${String(em.groupIndex ?? '?')}_${String(em.mapNum)}_${String(w.warpId)}`;
          warpIds.push(warpId);
          ctx.warps.push({
            id: warpId,
            name: `Warp ${String(w.warpId)} @ (${String(w.x)},${String(w.y)})`,
            fromMapId: mapId,
            fromCoord: { x: w.x, y: w.y },
            toMapId: mapIdFor(w.destMapGroup, w.destMapNum),
            // Destination coord lives in the destination map's
            // warps[warpId]; surface as (0,0) for now (warps cross-ref
            // resolution is a future map-graph builder step).
            toCoord: { x: 0, y: 0 },
            // Phase K.2 - stash the 8-byte Warp struct file offset so
            // the editor can delete this warp via map-event-table.
            metadata: {
              source: 'BinaryRomScanner#warp',
              structFileOffset: w.fileOffset,
              warpId: w.warpId,
              destMapNum: w.destMapNum,
              destMapGroup: w.destMapGroup,
              elevation: w.elevation,
            },
          });
          warpCount++;
        }
        for (const o of em.events.objectEvents) {
          const objId = `binary_obj_${String(em.groupIndex ?? '?')}_${String(em.mapNum)}_${String(o.localId)}`;
          objectEventIds.push(objId);
          const kind: ObjectEventKind = o.trainerType > 0 ? 'trainer' : 'npc';
          ctx.objectEvents.push({
            id: objId,
            name: `Object ${String(o.localId)} (${kind})`,
            mapId,
            coord: { x: o.x, y: o.y },
            elevation: o.elevation,
            kind,
            graphicsId: `gfx_${String(o.graphicsId)}`,
            // Phase H-RC8: use `movement_N` (not `move_N`) so the
            // displayName resolver doesn't accidentally interpret a
            // movement-type byte as a Pokémon-move id (`move_9` would
            // resolve to KARATE CHOP). `movement_N` has its own
            // resolver that maps to Gen-3 MOVEMENT_TYPE_* enum names.
            movementType: `movement_${String(o.movementType)}`,
            scriptId: o.scriptOffset !== null ? `script_0x${o.scriptOffset.toString(16)}` : null,
            flagId: o.flagId !== 0 ? `flag_0x${o.flagId.toString(16)}` : null,
            trainerType: o.trainerType !== 0 ? `trainer_${String(o.trainerType)}` : null,
            metadata: {
              source: 'BinaryRomScanner',
              binaryFileOffset: o.fileOffset,
              // Phase O.62 - surface the raw movementRangeXY +
              // trainerSightOrBerryTreeId bytes so the frontend can
              // render vision cones for trainer NPCs + wander-bbox
              // outlines for wandering NPCs without re-fetching the
              // struct from ROM.
              movementRangeXY: o.movementRangeXY,
              trainerSightOrBerryTreeId: o.trainerSightOrBerryTreeId,
            },
          });
          objEventCount++;
        }
        // Iter 95 - lift coordEvents → triggers (kind=on_enter for
        // step-trigger tiles).
        const coordEvents = em.events.coordEvents ?? [];
        for (const c of coordEvents) {
          const triggerId = `binary_coord_${String(em.groupIndex ?? '?')}_${String(em.mapNum)}_${String(c.index)}`;
          ctx.triggers.push({
            id: triggerId,
            name: `Coord trigger @ (${String(c.x)},${String(c.y)})`,
            kind: 'on_enter',
            mapId,
            coord: { x: c.x, y: c.y },
            conditionExpression: `trigger == ${String(c.trigger)} && index == ${String(c.index)}`,
            scriptStepIds: c.scriptOffset !== null ? [`binary_script_0x${c.scriptOffset.toString(16)}`] : [],
            // Phase J.1 - stash struct offset + raw bytes so the
            // inspector can edit the trigger var/value in place.
            metadata: {
              source: 'BinaryRomScanner#coordEvent',
              structFileOffset: c.fileOffset,
              elevation: c.elevation,
              coordTriggerVar: c.trigger,
              coordTriggerIndex: c.index,
            },
          });
          triggerCount++;
        }
        // Iter 95 - lift bgEvents → triggers (kind=on_interact for
        // signposts / hidden items at a coordinate).
        const bgEvents = em.events.bgEvents ?? [];
        for (let bi = 0; bi < bgEvents.length; bi++) {
          const b = bgEvents[bi]!;
          const triggerId = `binary_bg_${String(em.groupIndex ?? '?')}_${String(em.mapNum)}_${String(bi)}`;
          // Phase O.33 - for BG_EVENT_HIDDEN_ITEM (kinds 5/7) the 4
          // data bytes are a packed struct, not a script pointer.
          // Unpack u16 itemId / u8 flagOffset / u8 quantity so the
          // inspector can render the hidden-item editor.
          const isHiddenItem = b.kind === 5 || b.kind === 7;
          const triggerMetadata: Record<string, string | number | boolean> = {
            source: 'BinaryRomScanner#bgEvent',
            structFileOffset: b.fileOffset,
            elevation: b.elevation,
            bgEventKind: b.kind,
            bgEventDataRaw: b.dataRaw,
          };
          if (isHiddenItem) {
            triggerMetadata['hiddenItemId'] = b.dataRaw & 0xffff;
            triggerMetadata['hiddenItemFlagOffset'] = (b.dataRaw >>> 16) & 0xff;
            triggerMetadata['hiddenItemQuantity'] = (b.dataRaw >>> 24) & 0xff;
          }
          ctx.triggers.push({
            id: triggerId,
            name: `Sign/hidden @ (${String(b.x)},${String(b.y)})`,
            kind: 'on_interact',
            mapId,
            coord: { x: b.x, y: b.y },
            conditionExpression: `bg_kind == ${String(b.kind)}`,
            scriptStepIds:
              !isHiddenItem && b.dataOffset !== null
                ? [`binary_script_0x${b.dataOffset.toString(16)}`]
                : [],
            // Phase J.1 - stash struct offset + bg-event kind so the
            // inspector can edit the kind byte (sign / hidden item /
            // secret base / etc.) in place.
            metadata: triggerMetadata,
          });
          triggerCount++;
        }
      }
      // Iter 95 - lift mapScripts (per-map MapScripts table) →
      // ScriptStep entries. Each MapScriptEntry points at a script
      // (or a sub-table); we represent each as kind='raw' until full
      // script decoding lands (a future iter).
      if (em.mapScripts) {
        for (let si = 0; si < em.mapScripts.entries.length; si++) {
          const e = em.mapScripts.entries[si]!;
          ctx.scriptSteps.push({
            id: `binary_script_${String(em.groupIndex ?? '?')}_${String(em.mapNum)}_ms_${String(si)}`,
            kind: 'raw',
            params: {
              mapScriptType: e.type,
              mapScriptTypeName: e.typeName,
              scriptOffset: e.scriptOffset ?? -1,
              rawScriptAddress: e.rawScriptAddress,
              entryFileOffset: e.entryFileOffset,
              source: 'BinaryRomScanner#mapScripts',
            },
          });
          scriptStepCount++;
        }
      }
      // Iter 95 - lift conditionalScripts (per-map array of
      // ConditionalScriptTable for type-2 / type-4 map-script entries)
      // → ScriptStep entries with kind='branch' since each carries
      // varCheck/valueCheck conditional gating.
      const condTables = em.conditionalScripts ?? [];
      for (let ti = 0; ti < condTables.length; ti++) {
        const tbl = condTables[ti]!;
        for (let ei = 0; ei < tbl.entries.length; ei++) {
          const stub = tbl.entries[ei]!;
          ctx.scriptSteps.push({
            id: `binary_script_${String(em.groupIndex ?? '?')}_${String(em.mapNum)}_cs${String(ti)}_${String(ei)}`,
            kind: 'branch',
            params: {
              varCheck: stub.varCheck,
              valueCheck: stub.valueCheck,
              scriptOffset: stub.scriptOffset ?? -1,
              rawScriptAddress: stub.rawScriptAddress,
              entryFileOffset: stub.entryFileOffset,
              source: 'BinaryRomScanner#conditionalScripts',
            },
          });
          scriptStepCount++;
        }
      }
      ctx.maps.push({
        id: mapId,
        name: `Map ${String(em.groupIndex ?? '?')}.${String(em.mapNum)}`,
        group: mapTypeToMapGroup(em.mapType),
        dimensions: dim,
        tilesetIds: Object.freeze(tilesetIds),
        warpIds: Object.freeze(warpIds),
        scriptIds: [],
        objectEventIds: Object.freeze(objectEventIds),
        encounterTableIds: [],
        musicId: em.musicId !== 0 ? `song_${String(em.musicId)}` : null,
        metadata: {
          source: 'BinaryRomScanner',
          mapHeaderOffset: em.mapHeaderOffset,
          mapType: em.mapType,
          weather: em.weather,
          caveOrType: em.caveOrType,
          battleType: em.battleType,
          bikingAllowed: em.bikingAllowed,
          flags: em.flags,
          floorNum: em.floorNum,
          groupIndex: em.groupIndex ?? -1,
          mapNum: em.mapNum,
          // Phase UX-B - stash the region-map section id byte so cross-ref
          // 18 can rewrite map.name with the real area name from the
          // region_map_sections_system lifter output.
          regionMapSectionId: em.regionMapSection ?? -1,
          // Phase UX-C.4 - stash binary-rom rendering offsets so the
          // frontend MapEditor can fetch tile graphics + map cell data
          // via /binary-rom-tileset + /binary-rom-map-data routes.
          // Layout fileOffset (the MapLayout struct location) +
          // primary blocks offset (the metatile-ID byte grid) +
          // primary + secondary tileset offsets (already in tilesetIds
          // but stashed redundantly as numbers for direct fetch).
          binaryRomLayoutOffset: em.layout?.fileOffset ?? -1,
          binaryRomPrimaryBlocksOffset: em.layout?.primaryBlocksOffset ?? -1,
          binaryRomPrimaryTilesetOffset: em.layout?.primaryTilesetOffset ?? -1,
          binaryRomSecondaryTilesetOffset: em.layout?.secondaryTilesetOffset ?? -1,
          // Phase J.3 + J.7 + J.8 - stash MapEvents struct + per-array
          // offsets so the editor can add/delete NPCs (need
          // objectEventsArrayOffset + the count byte at
          // eventsStructOffset+0) and resize maps (need layout dims +
          // primaryBlocksOffset). These all flow from
          // `parseMapEvents` already; we just expose them now.
          binaryRomMapEventsStructOffset: em.events?.eventsStructOffset ?? -1,
          binaryRomObjectEventsArrayOffset:
            em.events?.objectEventsArrayOffset ?? -1,
          binaryRomWarpsArrayOffset: em.events?.warpsArrayOffset ?? -1,
          binaryRomCoordEventsArrayOffset:
            em.events?.coordEventsArrayOffset ?? -1,
          binaryRomBgEventsArrayOffset: em.events?.bgEventsArrayOffset ?? -1,
          binaryRomMapWidth: em.layout?.width ?? -1,
          binaryRomMapHeight: em.layout?.height ?? -1,
          binaryRomConnectionsHeaderOffset:
            em.connections?.headerStructOffset ?? -1,
          binaryRomConnectionsArrayOffset:
            em.connections?.connectionsArrayOffset ?? -1,
        },
        // Phase N.1 - surface 4-directional map connections so the
        // map header inspector can show "Goes north to Route 1" etc.
        connections:
          em.connections && em.connections.connections.length > 0
            ? em.connections.connections.map((c) => ({
                direction: c.direction,
                offset: c.offset,
                destMapId: mapIdFor(c.destMapGroup, c.destMapNum),
                destMapGroup: c.destMapGroup,
                destMapNum: c.destMapNum,
                fileOffset: c.fileOffset,
              }))
            : undefined,
      });
      mapCount++;
    }
    if (mapCount === 0) return null;
    // Phase F (semantic-world plan §3.1) - lift the tileset registry.
    // Each tileset struct becomes one TilesetEntry; per-map references
    // accumulate into usedByMapIds[]. usageCount lets the browser sort
    // by popularity.
    const tilesetsRaw = data.tilesets ?? [];
    if (tilesetsRaw.length > 0) {
      const tilesetByOffset = new Map<number, TilesetEntry>();
      for (const ts of tilesetsRaw) {
        const id = `tileset_0x${ts.fileOffset.toString(16)}`;
        tilesetByOffset.set(ts.fileOffset, {
          id,
          structFileOffset: ts.fileOffset,
          isSecondary: ts.isSecondary,
          isCompressed: ts.isCompressed,
          tilesOffset: ts.tilesOffset,
          palettesOffset: ts.palettesOffset,
          metatilesOffset: ts.metatilesOffset,
          usedByMapIds: [],
          usageCount: 0,
        });
      }
      // Walk maps a second time to accumulate the usedByMapIds[] index.
      const usedByMap = new Map<number, string[]>();
      for (const em of enriched) {
        if (em.layout === null) continue;
        const mapId = mapIdFor(em.groupIndex, em.mapNum);
        const offsets: Array<number | null> = [
          em.layout.primaryTilesetOffset,
          em.layout.secondaryTilesetOffset,
        ];
        for (const off of offsets) {
          if (off === null || !tilesetByOffset.has(off)) continue;
          const arr = usedByMap.get(off) ?? [];
          if (!arr.includes(mapId)) arr.push(mapId);
          usedByMap.set(off, arr);
        }
      }
      for (const [off, entry] of tilesetByOffset) {
        const mapIds = usedByMap.get(off) ?? [];
        ctx.tilesets.push({
          ...entry,
          usedByMapIds: Object.freeze(mapIds),
          usageCount: mapIds.length,
        });
      }
    }
    // Compose multi-collection lift label.
    const parts: string[] = ['maps'];
    if (warpCount > 0) parts.push('warps');
    if (objEventCount > 0) parts.push('objectEvents');
    if (triggerCount > 0) parts.push('triggers');
    if (scriptStepCount > 0) parts.push('scriptSteps');
    if (ctx.tilesets.length > 0) parts.push('tilesets');
    return parts.join('+');
  });

/** trainer_system → manifest.trainers[]
 *  PD 13: reads `TrainerSystemReport.trainerTable.trainers[]` which
 *  carries full parsed Trainer structs (name bytes + class + AI flags +
 *  party size). Iter 93 deepens: decodes trainer names via Gen-3 text
 *  codec + emits AI-flag breakdown + party-size metadata. Party member
 *  detail (per-Pokémon level/moves) requires per-trainer pointer
 *  follow + parsing - left for a future iter when the detector
 *  exposes that.  */
const liftTrainerSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    trainerCount?: number;
    trainerTable?: {
      trainers?: ReadonlyArray<{
        partyFlags: number;
        trainerClass: number;
        encounterMusic: number;
        isFemale: boolean;
        trainerPic: number;
        trainerNameBytes: Readonly<Uint8Array>;
        trainerNameLength: number;
        items: ReadonlyArray<number>;
        doubleBattle: boolean;
        aiFlags: number;
        partySize: number;
        partyPointer: number;
        fileOffset: number;
      }>;
    };
  }>(row, (data) => {
    const trainers = data.trainerTable?.trainers ?? [];
    if (trainers.length === 0) return null;
    for (let i = 0; i < trainers.length; i++) {
      const t = trainers[i]!;
      const decodedName = decodeTrainerName(t.trainerNameBytes, t.trainerNameLength);
      const displayName = decodedName.length > 0 ? decodedName : `Trainer #${String(i)}`;
      const aiFlagsList: string[] = [];
      // Vanilla Gen-3 AI flag bits per pret/pokefirered:
      //   0x01 = check_bad_move, 0x02 = try_to_faint, 0x04 = check_viability,
      //   0x08 = setup_first_turn, 0x10 = risky, 0x20 = prefer_strongest,
      //   0x40 = prefer_baton_pass, 0x80 = double_battle.
      const AI_LABELS: ReadonlyArray<[number, string]> = [
        [0x01, 'check_bad_move'],
        [0x02, 'try_to_faint'],
        [0x04, 'check_viability'],
        [0x08, 'setup_first_turn'],
        [0x10, 'risky'],
        [0x20, 'prefer_strongest'],
        [0x40, 'prefer_baton_pass'],
        [0x80, 'double_battle'],
      ];
      for (const [bit, label] of AI_LABELS) {
        if ((t.aiFlags & bit) !== 0) aiFlagsList.push(label);
      }
      // Party member detail isn't decoded here (requires per-trainer
      // pointer follow). Surface party size in metadata so the editor
      // can show "Trainer X (3 party members)" without parsing the
      // pointer target.
      const party: ReadonlyArray<TrainerPartyMember> = [];
      ctx.trainers.push({
        id: `binary_trainer_${String(i)}`,
        name: displayName,
        className: `class_${String(t.trainerClass)}`,
        party,
        aiFlags: Object.freeze(aiFlagsList),
        mapId: null,
        // Phase L.3 - stash trainer struct offset + raw bytes so the
        // editor can patch class / name / items / aiFlags / sprite /
        // music in place. trainer_parties_system extends the metadata
        // bag with party offsets in a later cross-ref.
        metadata: {
          source: 'BinaryRomScanner#trainer',
          structFileOffset: t.fileOffset,
          partyFlags: t.partyFlags,
          partySize: t.partySize,
          partyPointer: t.partyPointer,
          trainerClass: t.trainerClass,
          encounterMusic: t.encounterMusic,
          trainerPic: t.trainerPic,
          aiFlagsRaw: t.aiFlags,
          item0: t.items[0] ?? 0,
          item1: t.items[1] ?? 0,
          item2: t.items[2] ?? 0,
          item3: t.items[3] ?? 0,
          isFemale: t.isFemale,
          doubleBattle: t.doubleBattle,
        },
      });
    }
    return 'trainers';
  });

/** encounter_system → manifest.encounterTables[]
 *  PD 13: reads `EncounterSystemReport.entries[]` (one entry per
 *  detected wild-encounters header) with per-kind WildPokemonInfo +
 *  slot arrays. Iter 93 deepens: emits one EncounterTable per
 *  (map, kind) combination - vanilla FireRed has ~111 land-encounter
 *  tables + ~50 water tables + ~50 fishing tables + a few rockSmash. */
const liftEncounterSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tableCount?: number;
    entries?: ReadonlyArray<{
      mapGroup: number;
      mapNum: number;
      headerFileOffset: number;
      kinds: Readonly<
        Record<
          string,
          {
            encounterRate?: number;
            slots?: ReadonlyArray<{
              speciesId: number;
              minLevel: number;
              maxLevel: number;
            }>;
          } | null
        >
      >;
    }>;
  }>(row, (data) => {
    const entries = data.entries ?? [];
    if (entries.length === 0) return null;
    let pushed = 0;
    for (const e of entries) {
      const mapId = mapIdFor(e.mapGroup, e.mapNum);
      for (const [kind, info] of Object.entries(e.kinds)) {
        if (info === null) continue;
        const slots: EncounterSlot[] = [];
        // The engine emits each slot with a `fileOffset` (the 4-byte
        // WildPokemon struct). The lifter's inferred shape doesn't
        // declare it; access via a cast so we keep the offset for the
        // write path while staying compatible with the type def.
        type RawSlot = { speciesId: number; minLevel: number; maxLevel: number; fileOffset?: number };
        type RawInfo = {
          encounterRate?: number;
          fileOffset?: number;
          slotsOffset?: number | null;
          slots?: ReadonlyArray<RawSlot>;
        };
        const rawInfo = info as RawInfo;
        const rawSlots = (rawInfo.slots ?? []) as ReadonlyArray<RawSlot>;
        for (let i = 0; i < rawSlots.length; i++) {
          const s = rawSlots[i]!;
          slots.push({
            speciesId: `species_${String(s.speciesId)}`,
            minLevel: s.minLevel,
            maxLevel: s.maxLevel,
            // Wild slots in Gen-3 have per-slot weights baked into a
            // distribution table; per-slot weight isn't carried on the
            // engine's slot type yet, so default to 1 (uniform-ish).
            weight: 1,
            // Phase K - stash per-slot file offset (4-byte WildPokemon
            // struct) so the editor can patch min/max level + species
            // in place via /binary-rom-edit/encounter-slot.
            ...(typeof s.fileOffset === 'number' ? { fileOffset: s.fileOffset } : {}),
          });
        }
        ctx.encounterTables.push({
          id: `binary_encounter_${String(e.mapGroup)}_${String(e.mapNum)}_${kind}`,
          name: `Encounter table ${String(e.mapGroup)}.${String(e.mapNum)} (${kind})`,
          mapId,
          type: encounterKindToType(kind),
          encounterRate: rawInfo.encounterRate ?? 0,
          slots: Object.freeze(slots),
          // WP-C1 - propagate the WildPokemonInfo offset (for rate
          // edits, writes u8 at +0) and the slot-array base offset
          // (for slot reorder writes).
          ...(typeof rawInfo.fileOffset === 'number'
            ? { infoFileOffset: rawInfo.fileOffset }
            : {}),
          ...(typeof rawInfo.slotsOffset === 'number'
            ? { slotsFileOffset: rawInfo.slotsOffset }
            : {}),
        });
        pushed++;
      }
    }
    return pushed > 0 ? 'encounterTables' : null;
  });

/** text_pointer_tables → manifest.dialogue[]
 *  PD 13: reads `TextPointerTablesReport.tables[]` with per-table
 *  sampleStrings + classification.kind (iter 90 classifier output).
 *  Each table's sampled strings become DialogueNode entries using the
 *  classified kind as the speakerName for editor identification. */
const liftTextPointerTables: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tables?: ReadonlyArray<{
      tableOffset: number;
      entryCount: number;
      sampleStrings?: ReadonlyArray<string>;
      classification?: { kind: string };
    }>;
  }>(row, (data) => {
    const tables = data.tables ?? [];
    if (tables.length === 0) return null;
    // Phase G-RC7 (semantic-world plan §G.7): filter to ACTUAL
    // dialogue. The text-pointer-tables detector finds every
    // text-shaped pointer table in the ROM and classifies them
    // (ability_descriptions, move_descriptions, item_descriptions,
    // trainer_names, species_names, dialogue, unknown). The user's
    // verification screenshots showed ability_descriptions polluting
    // the Dialogue tab - those aren't conversation text, they're
    // static help strings. Only kinds explicitly tagged as
    // "dialogue" or "unknown" (couldn't classify either way) flow
    // into manifest.dialogue[]. Reference tables surface elsewhere
    // once that view exists; for now we just don't pollute.
    const DIALOGUE_KINDS = new Set(['dialogue', 'unknown', 'unknown_text_table']);
    let pushed = 0;
    for (const t of tables) {
      const kind = t.classification?.kind ?? 'unknown_text_table';
      if (!DIALOGUE_KINDS.has(kind)) continue;
      const samples = t.sampleStrings ?? [];
      for (let i = 0; i < samples.length; i++) {
        ctx.dialogue.push({
          id: `binary_text_${kind}_0x${t.tableOffset.toString(16)}_${String(i)}`,
          name: `${kind} #${String(i)}`,
          speakerName: kind === 'dialogue' ? 'Dialogue' : 'Unclassified text',
          portraitAssetId: null,
          text: samples[i] ?? '',
          choices: [],
        });
        pushed++;
      }
    }
    return pushed > 0 ? 'dialogue' : null;
  });

/** lz77_pointer_tables → manifest.assets[]
 *  PD 13: reads `Lz77PointerTablesReport.tables[]` with samplePreview
 *  array containing targetOffset + decompressedSize per entry. */
const liftLz77PointerTables: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tables?: ReadonlyArray<{
      tableOffset: number;
      samplePreview?: ReadonlyArray<{ targetOffset: number; decompressedSize: number }>;
    }>;
  }>(row, (data) => {
    const tables = data.tables ?? [];
    if (tables.length === 0) return null;
    let pushed = 0;
    for (const t of tables) {
      const preview = t.samplePreview ?? [];
      for (let i = 0; i < preview.length; i++) {
        const e = preview[i]!;
        ctx.assets.push({
          id: `binary_lz77_0x${t.tableOffset.toString(16)}_${String(i)}`,
          name: `LZ77 sprite @ 0x${e.targetOffset.toString(16)}`,
          kind: 'battle_sprite',
          relativePath: `<binary-rom:lz77@0x${e.targetOffset.toString(16)}>`,
          metadata: {
            tableOffset: t.tableOffset,
            targetOffset: e.targetOffset,
            decompressedSize: e.decompressedSize,
            entryIndex: i,
          },
        });
        pushed++;
      }
    }
    return pushed > 0 ? 'assets' : null;
  });

/** palette_system → manifest.assets[]
 *  PD 13: reads `PaletteSystemReport.firstRegionOffsets[]` (iter 93
 *  fix - iter 92 read non-existent `regions[]`). The detector caps
 *  the preview list; full per-region enumeration is a future iter when
 *  the detector exposes the full region list. */
const liftPaletteSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    paletteRegionCount?: number;
    firstRegionOffsets?: ReadonlyArray<number>;
  }>(row, (data) => {
    const offsets = data.firstRegionOffsets ?? [];
    if (offsets.length === 0) return null;
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i]!;
      ctx.assets.push({
        id: `binary_palette_0x${off.toString(16)}`,
        name: `Palette @ 0x${off.toString(16)}`,
        kind: 'palette',
        relativePath: `<binary-rom:palette@0x${off.toString(16)}>`,
        metadata: {
          offset: off,
          byteLength: 32,
          entryIndex: i,
          totalRegionsDetected: data.paletteRegionCount ?? 0,
        },
      });
    }
    return 'assets';
  });

/** cry_table_system → manifest.assets[] (kind=sound, one per cry) */
const liftCryTableSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    entryCount?: number;
    samplePreview?: ReadonlyArray<{ wavOffset: number | null; index: number }>;
  }>(row, (data) => {
    const preview = data.samplePreview ?? [];
    if (preview.length === 0) return null;
    for (const e of preview) {
      ctx.assets.push({
        id: `binary_cry_${String(e.index)}`,
        name: `Cry #${String(e.index)}${e.wavOffset === null ? ' (silent)' : ''}`,
        kind: 'sound',
        relativePath:
          e.wavOffset === null
            ? `<binary-rom:cry-silent#${String(e.index)}>`
            : `<binary-rom:cry@0x${e.wavOffset.toString(16)}>`,
        metadata: {
          speciesIndex: e.index,
          wavOffset: e.wavOffset ?? -1,
          totalCriesDetected: data.entryCount ?? 0,
        },
      });
    }
    return 'assets';
  });

/** audio_system → manifest.assets[] (kind=music, one per song) */
const liftAudioSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    songCount?: number;
    songTable?: { tableStart: number; entryCount: number };
  }>(row, (data) => {
    const songTable = data.songTable;
    if (!songTable || songTable.entryCount <= 0) return null;
    // Cap at reasonable preview to avoid manifest blow-up on heavy
    // hacks with thousands of songs - full per-song asset enumeration
    // requires per-song detail (track count, music length) which
    // belongs in a future iter as the audio-system detector deepens.
    const cap = Math.min(songTable.entryCount, 256);
    for (let i = 0; i < cap; i++) {
      ctx.assets.push({
        id: `song_${String(i)}`,
        name: `Song #${String(i)}`,
        kind: 'music',
        relativePath: `<binary-rom:song#${String(i)}>`,
        metadata: {
          tableStart: songTable.tableStart,
          songIndex: i,
          totalSongsDetected: songTable.entryCount,
        },
      });
    }
    return 'assets';
  });

/** script_engine → manifest.flags[] + manifest.variables[]
 *  Placeholder - the script-engine detector doesn't currently enumerate
 *  flag/variable counts. Lifter is wired + ready for detector deepening. */
const liftScriptEngine: ManifestLifter = (row, ctx) =>
  ifDetected<{ flagCount?: number; variableCount?: number }>(row, (data) => {
    const flagCount = typeof data.flagCount === 'number' ? data.flagCount : 0;
    const varCount = typeof data.variableCount === 'number' ? data.variableCount : 0;
    let pushed = 0;
    for (let i = 0; i < flagCount; i++) {
      ctx.flags.push({
        id: `binary_flag_${String(i)}`,
        name: `FLAG_${String(i).padStart(4, '0')}`,
        scope: 'global',
        defaultValue: false,
        description: null,
        engineValue: `0x${i.toString(16)}`,
      });
      pushed++;
    }
    for (let i = 0; i < varCount; i++) {
      ctx.variables.push({
        id: `binary_var_${String(i)}`,
        name: `VAR_${String(i).padStart(4, '0')}`,
        scope: 'global',
        defaultValue: 0,
        description: null,
        engineValue: `0x${i.toString(16)}`,
      });
      pushed++;
    }
    return pushed > 0 ? 'flags+variables' : null;
  });

// ─────────────────────────────────────────────────────────────────────
// LIFTER_REGISTRY - the runtime table the BinaryRomScanner iterates.
// EXTEND HERE when adding a new detector that maps to a standard
// manifest collection.
// ─────────────────────────────────────────────────────────────────────

/** species_names → manifest.speciesNames[] (iter 94)
 *  Lifts the first-16 species names sampled by the species-names
 *  detector. The detector currently surfaces only a 16-entry preview
 *  (sampleNames[0] = placeholder, [1] = species #1, etc.); future
 *  detector deepening will surface the full ~411-entry list. */
const liftSpeciesNames: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tableOffset?: number;
    validSpeciesCount?: number;
    sampleNames?: ReadonlyArray<string>;
  }>(row, (data) => {
    const samples = data.sampleNames ?? [];
    if (samples.length === 0) return null;
    const tableOffset = data.tableOffset ?? 0;
    // Phase N.5 - Gen-3 species names: 11-byte slot (10 chars + 0xFF
    // terminator). FRLG + Emerald both use this stride.
    const SPECIES_NAME_STRIDE = 11;
    for (let i = 0; i < samples.length; i++) {
      ctx.speciesNames.push({
        id: `binary_species_${String(i)}`,
        speciesIndex: i,
        name: samples[i] ?? '',
        sourceTableOffset: tableOffset,
        nameSlotOffset: tableOffset + i * SPECIES_NAME_STRIDE,
      });
    }
    return 'speciesNames';
  });

/** move_names → manifest.moveNames[] (iter 94) */
const liftMoveNames: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tableOffset?: number;
    validMoveCount?: number;
    sampleNames?: ReadonlyArray<string>;
  }>(row, (data) => {
    const samples = data.sampleNames ?? [];
    if (samples.length === 0) return null;
    const tableOffset = data.tableOffset ?? 0;
    // Phase N.5 - Gen-3 move names: 13-byte slot (12 chars + terminator).
    const MOVE_NAME_STRIDE = 13;
    for (let i = 0; i < samples.length; i++) {
      ctx.moveNames.push({
        id: `binary_move_${String(i)}`,
        moveIndex: i,
        name: samples[i] ?? '',
        sourceTableOffset: tableOffset,
        nameSlotOffset: tableOffset + i * MOVE_NAME_STRIDE,
      });
    }
    return 'moveNames';
  });

/** items_system → manifest.items[] (iter 94, deepened iter 99)
 *  Iter 99 - reads `itemsTable.items[]` (every parsed 44-byte Item record:
 *  vanilla FRLG = 376 items, hacks up to ~1000+) instead of the 24-entry
 *  sampleNames preview. Each entry carries price/holdEffect/holdEffectParam
 *  /importance/pocket/type/descriptionPtr from the struct so the editor
 *  can render full per-item detail (Iter-97 pattern: detector was already
 *  parsing the data but discarding it - engine scanner deepened in this
 *  iter so the lifter can now lift it). Falls back to the old sampleNames
 *  path if the deepened items array isn't present (defensive - keeps the
 *  lifter robust if the engine is rebuilt out of order). */
const liftItemsSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    itemCount?: number;
    itemsTable?: {
      tableStart: number;
      items?: ReadonlyArray<{
        nameBytes: Uint8Array;
        itemId: number;
        price: number;
        holdEffect: number;
        holdEffectParam: number;
        descriptionPtr: number;
        importance: number;
        pocket: number;
        type: number;
      }>;
    };
    sampleNames?: ReadonlyArray<string>;
  }>(row, (data) => {
    const tableOffset = data.itemsTable?.tableStart ?? 0;
    const fullItems = data.itemsTable?.items;
    if (fullItems !== undefined && fullItems.length > 0) {
      for (let i = 0; i < fullItems.length; i++) {
        const it = fullItems[i]!;
        // Decode the inline 14-byte name field via the Gen-3 codec. Item
        // names use 0xFF terminator; the codec handles that natively when
        // the bytes carry one. Decoded names may be empty for the
        // ITEM_NONE placeholder (i==0) which is expected.
        const decodedName = engineText.decodeString(
          it.nameBytes,
          0,
          it.nameBytes.length,
        );
        ctx.items.push({
          id: `binary_item_${String(it.itemId)}`,
          itemIndex: it.itemId,
          name: decodedName,
          sourceTableOffset: tableOffset,
          price: it.price,
          holdEffect: it.holdEffect,
          holdEffectParam: it.holdEffectParam,
          descriptionPtr: it.descriptionPtr,
          importance: it.importance,
          pocket: it.pocket,
          type: it.type,
        });
      }
      return 'items';
    }
    // Fallback: legacy sampleNames-only path (only fires if engine
    // hasn't been rebuilt with iter-99 item-scanner deepening).
    const samples = data.sampleNames ?? [];
    if (samples.length === 0) return null;
    for (let i = 0; i < samples.length; i++) {
      ctx.items.push({
        id: `binary_item_${String(i)}`,
        itemIndex: i,
        name: samples[i] ?? '',
        sourceTableOffset: tableOffset,
      });
    }
    return 'items';
  });

/** species_system → manifest.species[] (iter 103 NEW lifter)
 *  The engine's species_system detector already exposes
 *  `baseStatsTable.records[]` (full 22-field BaseStats per species - 
 *  iter-99 deepening pattern was already applied in iter 73's scanner).
 *  This iter wires the FIRST lifter for that data: reads each
 *  BaseStats record and produces one SpeciesEntry per species.
 *  Largest single surface in the manifest: vanilla FRLG 411 species ×
 *  22 fields per record = ~9,000 new per-entry data points per scan.
 *  Cross-refs 8+9 (iter 103) populate name (from speciesNames) +
 *  type1Name + type2Name (from typeNames via the type bytes). */
const liftSpeciesSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    speciesCount?: number;
    baseStatsTable?: {
      tableStart: number;
      records?: ReadonlyArray<{
        baseHP: number;
        baseAttack: number;
        baseDefense: number;
        baseSpeed: number;
        baseSpAttack: number;
        baseSpDefense: number;
        type1: number;
        type2: number;
        catchRate: number;
        expYield: number;
        item1: number;
        item2: number;
        genderRatio: number;
        eggCycles: number;
        friendship: number;
        growthRate: number;
        eggGroup1: number;
        eggGroup2: number;
        ability1: number;
        ability2: number;
        safariZoneFleeRate: number;
        fileOffset: number;
      }>;
    };
  }>(row, (data) => {
    const records = data.baseStatsTable?.records ?? [];
    if (records.length === 0) return null;
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      ctx.species.push({
        id: `binary_species_data_${String(i)}`,
        speciesIndex: i,
        baseHP: r.baseHP,
        baseAttack: r.baseAttack,
        baseDefense: r.baseDefense,
        baseSpeed: r.baseSpeed,
        baseSpAttack: r.baseSpAttack,
        baseSpDefense: r.baseSpDefense,
        type1: r.type1,
        type2: r.type2,
        catchRate: r.catchRate,
        expYield: r.expYield,
        item1: r.item1,
        item2: r.item2,
        genderRatio: r.genderRatio,
        eggCycles: r.eggCycles,
        friendship: r.friendship,
        growthRate: r.growthRate,
        eggGroup1: r.eggGroup1,
        eggGroup2: r.eggGroup2,
        ability1: r.ability1,
        ability2: r.ability2,
        safariZoneFleeRate: r.safariZoneFleeRate,
        sourceFileOffset: r.fileOffset,
      });
    }
    return 'species';
  });

/** region_map_sections_system → manifest.regionMapSections[] (Phase UX-B NEW lifter)
 *  Co-shipped with the NEW region_map_sections_system detector per
 *  UW-D-0015. Reads RegionMapSectionsSystemReport.sectionTable.sections[]
 *  and writes one RegionMapSectionEntry per detected entry. Cross-ref
 *  18 (added below) then walks ctx.maps, reads each map's
 *  metadata.regionMapSectionId byte, looks up the matching section's
 *  name, and rewrites map.name from iter-95's synthetic `Map ?.202`
 *  to the real in-game area name like "PALLET TOWN". */
/** heal_locations_system → manifest.healLocations[] (Phase O.42 NEW lifter).
 *  Co-shipped with the NEW heal_locations_system detector per
 *  UW-D-0015. Reads HealLocationsSystemReport.table.entries[] and
 *  writes one HealLocationEntry per detected entry. Cross-ref 21
 *  (added later in this commit) resolves (group, mapNum) → mapId
 *  by looking up each entry in ctx.maps. */
const liftHealLocationsSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    entryCount?: number;
    table?: {
      tableStart: number;
      entries?: ReadonlyArray<{
        slotIndex: number;
        group: number;
        mapNum: number;
        x: number;
        y: number;
        fileOffset: number;
      }>;
    };
  }>(row, (data) => {
    const entries = data.table?.entries ?? [];
    if (entries.length === 0) return null;
    for (const e of entries) {
      ctx.healLocations.push({
        id: `binary_heal_location_${String(e.slotIndex)}`,
        slotIndex: e.slotIndex,
        group: e.group,
        mapNum: e.mapNum,
        x: e.x,
        y: e.y,
        destMapId: null, // cross-ref 21 fills this after maps lift
        sourceFileOffset: e.fileOffset,
      });
    }
    return 'healLocations';
  });

const liftRegionMapSectionsSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    entryCount?: number;
    namedCount?: number;
    sectionTable?: {
      tableStart: number;
      sections?: ReadonlyArray<{
        sectionIndex: number;
        x: number;
        y: number;
        width: number;
        height: number;
        nameRomPointer: number;
        name: string;
        fileOffset: number;
      }>;
    };
  }>(row, (data) => {
    const sections = data.sectionTable?.sections ?? [];
    if (sections.length === 0) return null;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!;
      ctx.regionMapSections.push({
        id: `binary_region_map_section_${String(s.sectionIndex)}`,
        sectionIndex: s.sectionIndex,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        nameRomPointer: s.nameRomPointer,
        name: s.name,
        sourceFileOffset: s.fileOffset,
      });
    }
    return 'regionMapSections';
  });

/** trainer_parties_system → ctx.trainers[].party enrichment (iter 107 NEW lifter)
 *  Co-shipped with the NEW trainer_parties_system detector per UW-D-0015.
 *  Reads TrainerPartiesSystemReport.parties[] - each entry has
 *  trainerIndex + members[] {species, level, heldItem, moves, iv}.
 *  Enriches matching ctx.trainers[i].party (originally [] from iter-95
 *  liftTrainerSystem) with parsed party members.
 *  Per FRLG: 743 trainers, ~3000 party members across vanilla.
 *  Cross-detector ordering: trainer_system (iter 67, phase 8) +
 *  trainer_class_names (phase 8) run BEFORE this detector at phase 9 +
 *  before cross-ref pass - so ctx.trainers entries are already
 *  populated and ready to enrich. */
const liftTrainerPartiesSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    trainerCount?: number;
    fullyParsedPartyCount?: number;
    totalMemberCount?: number;
    parties?: ReadonlyArray<{
      trainerIndex: number;
      partyFlags: number;
      declaredPartySize: number;
      arrayFileOffset: number;
      members: ReadonlyArray<{
        iv: number;
        level: number;
        species: number;
        heldItem: number;
        moves: ReadonlyArray<number>;
        fileOffset: number;
        kind: number;
      }>;
      arrayByteLength: number;
    }>;
  }>(row, (data) => {
    const parties = data.parties ?? [];
    if (parties.length === 0) return null;
    // Build a map: trainerIndex → parsed party members.
    const partyByTrainerIndex = new Map<number, typeof parties[number]>();
    for (const p of parties) partyByTrainerIndex.set(p.trainerIndex, p);
    let enriched = 0;
    for (let i = 0; i < ctx.trainers.length; i++) {
      const t = ctx.trainers[i]!;
      // ctx.trainers ids are `binary_trainer_${i}` (iter-95 convention);
      // index === position in array, so we can match directly.
      const party = partyByTrainerIndex.get(i);
      if (party === undefined) continue;
      if (t.party.length > 0) continue; // skip already-enriched
      const newParty = party.members.map((m) => ({
        speciesId: `species_${String(m.species)}`,
        level: m.level,
        moveIds: m.moves.filter((mv) => mv !== 0).map((mv) => `move_${String(mv)}`),
        heldItemId: m.heldItem !== 0 ? `item_${String(m.heldItem)}` : null,
        // Phase K.4 - stash file offset of each party member's struct
        // so the inspector can patch species/level/moves/heldItem in
        // place via /binary-rom-edit/trainer-party-member.
        fileOffset: m.fileOffset,
      }));
      ctx.trainers[i] = {
        ...t,
        party: Object.freeze(newParty),
        // Phase L.3 - merge with whatever trainer_system already
        // stashed (struct offset, class, ai flags, items, etc.) so the
        // editor has both surfaces in one place.
        metadata: {
          ...(t.metadata ?? {}),
          partyFlags: party.partyFlags,
          declaredPartySize: party.declaredPartySize,
          arrayFileOffset: party.arrayFileOffset,
          arrayByteLength: party.arrayByteLength,
        },
      };
      enriched++;
    }
    return enriched > 0 ? 'trainers (parties enriched)' : null;
  });

/** species_evolutions → manifest.speciesEvolutions[] (iter 105 NEW lifter)
 *  Sibling lifter to liftSpeciesSystem (iter 103). Reads
 *  SpeciesEvolutionsReport.evolutionTable.blocks[].populatedSlots[] - 
 *  the engine already filters out EVO_NONE slots so each populatedSlots
 *  entry is a real evolution. Produces one SpeciesEvolutionEntry per
 *  species (only when block has ≥1 populated slot). Vanilla FRLG: ~80
 *  species evolve (the rest are stage-3 finals or non-evolving). Cross-ref
 *  via targetSpeciesName (from speciesNames) wired in cross-ref pass. */
const liftSpeciesEvolutions: ManifestLifter = (row, ctx) =>
  ifDetected<{
    evolutionTable?: {
      tableStart: number;
      blocks?: ReadonlyArray<{
        fileOffset: number;
        populatedSlots?: ReadonlyArray<{
          method: number;
          param: number;
          targetSpecies: number;
          fileOffset: number;
        }>;
      }>;
    };
  }>(row, (data) => {
    const blocks = data.evolutionTable?.blocks ?? [];
    if (blocks.length === 0) return null;
    let pushed = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const populated = block.populatedSlots ?? [];
      // Phase O.14 - surface ALL species even with 0 populated evolutions
      // so the operator can ADD an evolution to a previously non-evolving
      // species (Mew, Mewtwo, all stage-3 finals, etc.). sourceFileOffset
      // is still meaningful and points to the 40-byte 5-slot window.
      const slots: SpeciesEvolutionSlot[] = populated.map((s) => ({
        method: s.method,
        param: s.param,
        targetSpecies: s.targetSpecies,
        fileOffset: s.fileOffset,
      }));
      ctx.speciesEvolutions.push({
        id: `binary_species_evo_${String(i)}`,
        speciesIndex: i,
        slots: Object.freeze(slots),
        sourceFileOffset: block.fileOffset,
      });
      pushed++;
    }
    return pushed > 0 ? 'speciesEvolutions' : null;
  });

/** species_learnsets → manifest.speciesLearnsets[] (iter 105 NEW lifter)
 *  Sibling to liftSpeciesSystem. Reads
 *  SpeciesLearnsetsReport.learnsetPointerTable.entries[] - each entry
 *  carries a parsed Learnset with entries[] (level + move pairs through
 *  the 0xFFFF terminator). One SpeciesLearnsetEntry per species; cross-ref
 *  via moveName (from moveNames) wired in cross-ref pass. */
const liftSpeciesLearnsets: ManifestLifter = (row, ctx) =>
  ifDetected<{
    learnsetPointerTable?: {
      tableStart: number;
      entries?: ReadonlyArray<{
        pointerFileOffset: number;
        pointerRaw: number;
        learnset: {
          fileOffset: number;
          entries: ReadonlyArray<{
            level: number;
            move: number;
            raw: number;
          }>;
        };
      }>;
    };
  }>(row, (data) => {
    const entries = data.learnsetPointerTable?.entries ?? [];
    if (entries.length === 0) return null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const moves: SpeciesLearnsetMove[] = e.learnset.entries.map((le) => ({
        level: le.level,
        move: le.move,
      }));
      ctx.speciesLearnsets.push({
        id: `binary_species_learnset_${String(i)}`,
        speciesIndex: i,
        arrayFileOffset: e.learnset.fileOffset,
        pointerRaw: e.pointerRaw,
        pointerFileOffset: e.pointerFileOffset,
        moves: Object.freeze(moves),
      });
    }
    return 'speciesLearnsets';
  });

/** species_tmhm → manifest.speciesTMHM[] (iter 105 NEW lifter)
 *  Sibling to liftSpeciesSystem. Reads SpeciesTMHMReport.tmhmTable.slots[]
 * - each slot carries a TMHMCompat with the full 64-bit bitfield + the
 *  already-split TM (0..49) and HM (0..7) compat index lists. One
 *  SpeciesTMHMEntry per species. */
const liftSpeciesTMHM: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tmhmTable?: {
      tableStart: number;
      slots?: ReadonlyArray<{
        low: number;
        high: number;
        setBitIndices: ReadonlyArray<number>;
        compatibleTmIndices: ReadonlyArray<number>;
        compatibleHmIndices: ReadonlyArray<number>;
        fileOffset: number;
      }>;
    };
  }>(row, (data) => {
    const slots = data.tmhmTable?.slots ?? [];
    if (slots.length === 0) return null;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      ctx.speciesTMHM.push({
        id: `binary_species_tmhm_${String(i)}`,
        speciesIndex: i,
        low: s.low,
        high: s.high,
        setBitIndices: s.setBitIndices,
        compatibleTmIndices: s.compatibleTmIndices,
        compatibleHmIndices: s.compatibleHmIndices,
        sourceFileOffset: s.fileOffset,
      });
    }
    return 'speciesTMHM';
  });

/** overworld_sprites_system → manifest.overworldSprites[] (iter 101 NEW lifter)
 *  Co-shipped with the NEW overworld_sprites_system detector per the
 *  UW-D-0015 invariant (every new detector ships with its lifter so
 *  the editor surface is wired the same iter).
 *  Reads OverworldSpritesSystemReport.spriteTable.sprites[] - every
 *  per-sprite OverworldSpriteInfo entry becomes an OverworldSpriteEntry
 *  in the manifest with full struct fields (tileTag, paletteTag,
 *  reflectionPaletteTag, size, width, height, paletteSlotBits, tracks)
 *  + the per-entry pointer/struct offsets for raw-view inspection. */
const liftOverworldSpritesSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    entryCount?: number;
    validCount?: number;
    spriteTable?: {
      tableStart: number;
      sprites?: ReadonlyArray<{
        spriteIndex: number;
        pointerTableEntryOffset: number;
        structFileOffset: number;
        tileTag: number;
        paletteTag: number;
        reflectionPaletteTag: number;
        size: number;
        width: number;
        height: number;
        paletteSlotBits: number;
        tracks: number;
      }>;
    };
  }>(row, (data) => {
    const sprites = data.spriteTable?.sprites ?? [];
    if (sprites.length === 0) return null;
    for (let i = 0; i < sprites.length; i++) {
      const s = sprites[i]!;
      ctx.overworldSprites.push({
        id: `binary_owsprite_${String(s.spriteIndex)}`,
        spriteIndex: s.spriteIndex,
        structFileOffset: s.structFileOffset,
        tileTag: s.tileTag,
        paletteTag: s.paletteTag,
        reflectionPaletteTag: s.reflectionPaletteTag,
        size: s.size,
        width: s.width,
        height: s.height,
        paletteSlotBits: s.paletteSlotBits,
        tracks: s.tracks,
        pointerTableEntryOffset: s.pointerTableEntryOffset,
      });
    }
    return 'overworldSprites';
  });

/** object_event_palettes_system → manifest.objectEventPalettes[]
 *  (Phase F / semantic-world plan §1.1 NEW lifter).
 *  Co-shipped with the NEW object_event_palettes_system detector per
 *  the UW-D-0015 invariant. Reads
 *  ObjectEventPalettesSystemReport.paletteTable.entries[] - every entry
 *  becomes an ObjectEventPaletteEntry carrying the palette tag + 16-color
 *  RGBA palette block. Cross-ref 22 attaches the matching palette to
 *  each ObjectEvent.metadata so the frontend renders NPCs in color. */
const liftObjectEventPalettesSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    entryCount?: number;
    paletteTable?: {
      tableStart: number;
      entries?: ReadonlyArray<{
        entryIndex: number;
        entryFileOffset: number;
        tag: number;
        paletteFileOffset: number;
        paletteRgba: ReadonlyArray<number>;
      }>;
    };
  }>(row, (data) => {
    const entries = data.paletteTable?.entries ?? [];
    if (entries.length === 0) return null;
    for (const e of entries) {
      ctx.objectEventPalettes.push({
        id: `binary_owpal_${String(e.entryIndex)}`,
        entryIndex: e.entryIndex,
        tag: e.tag,
        entryFileOffset: e.entryFileOffset,
        paletteFileOffset: e.paletteFileOffset,
        paletteRgba: Object.freeze(Array.from(e.paletteRgba)),
      });
    }
    return 'objectEventPalettes';
  });

/** experience_curves_system → manifest.experienceCurves[] (iter 100 NEW lifter)
 *  Co-shipped with the NEW experience_curves_system detector per the
 *  UW-D-0015 invariant (every new detector ships with its lifter so
 *  the editor surface is wired the same iter, no follow-up gap).
 *  Reads ExperienceCurvesSystemReport.experienceTable.curves[] (always
 *  6 in vanilla; each carries xpPerLevel[101] + the inferred
 *  growthRateName from the level-100 magnitude). */
const liftExperienceCurvesSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    curveCount?: number;
    canonicallyNamedCount?: number;
    experienceTable?: {
      tableStart: number;
      curves?: ReadonlyArray<{
        curveIndex: number;
        subTableOffset: number;
        xpAtLevel100: number;
        growthRateName: string | null;
        xpPerLevel: ReadonlyArray<number>;
      }>;
    };
  }>(row, (data) => {
    const curves = data.experienceTable?.curves ?? [];
    if (curves.length === 0) return null;
    for (let i = 0; i < curves.length; i++) {
      const c = curves[i]!;
      ctx.experienceCurves.push({
        id: `binary_xpcurve_${String(c.curveIndex)}_${
          c.growthRateName ?? 'unnamed'
        }`,
        curveIndex: c.curveIndex,
        growthRateName: c.growthRateName,
        xpAtLevel100: c.xpAtLevel100,
        subTableOffset: c.subTableOffset,
        xpPerLevel: c.xpPerLevel,
      });
    }
    return 'experienceCurves';
  });

/** moves_system → manifest.battleMoves[] (iter 99 NEW lifter)
 *  Reads `battleMovesTable.moves[]` exposing each move's full 12-byte
 *  BattleMove struct (effect, power, type, accuracy, pp,
 *  secondaryEffectChance, target, priority, flags, split).
 *  Iter-97 pattern: scanner now exposes per-record data; this lifter
 *  consumes it. Name + typeName are resolved by the cross-ref pass
 *  (cross-refs 5+6 - moveNames + typeNames lookups). */
const liftMovesSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    moveCount?: number;
    battleMovesTable?: {
      tableStart: number;
      moves?: ReadonlyArray<{
        effect: number;
        power: number;
        type: number;
        accuracy: number;
        pp: number;
        secondaryEffectChance: number;
        target: number;
        priority: number;
        flags: number;
        split: number;
      }>;
    };
  }>(row, (data) => {
    const moves = data.battleMovesTable?.moves ?? [];
    if (moves.length === 0) return null;
    const tableOffset = data.battleMovesTable?.tableStart ?? 0;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]!;
      ctx.battleMoves.push({
        id: `binary_battlemove_${String(i)}`,
        moveIndex: i,
        effect: m.effect,
        power: m.power,
        type: m.type,
        accuracy: m.accuracy,
        pp: m.pp,
        secondaryEffectChance: m.secondaryEffectChance,
        target: m.target,
        priority: m.priority,
        flags: m.flags,
        split: m.split,
        sourceTableOffset: tableOffset,
      });
    }
    return 'battleMoves';
  });

/** abilities_system → manifest.abilities[] (iter 94) */
const liftAbilitiesSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tableOffset?: number;
    validAbilityCount?: number;
    sampleNames?: ReadonlyArray<string>;
  }>(row, (data) => {
    const samples = data.sampleNames ?? [];
    if (samples.length === 0) return null;
    const tableOffset = data.tableOffset ?? 0;
    // Phase N.5 - Gen-3 ability names: 13-byte slot.
    const ABILITY_NAME_STRIDE = 13;
    for (let i = 0; i < samples.length; i++) {
      ctx.abilities.push({
        id: `binary_ability_${String(i)}`,
        abilityIndex: i,
        name: samples[i] ?? '',
        sourceTableOffset: tableOffset,
        nameSlotOffset: tableOffset + i * ABILITY_NAME_STRIDE,
      });
    }
    return 'abilities';
  });

/** type_names → manifest.typeNames[] (iter 97) */
const liftTypeNames: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tableOffset?: number;
    validTypeCount?: number;
    sampleNames?: ReadonlyArray<string>;
  }>(row, (data) => {
    const samples = data.sampleNames ?? [];
    if (samples.length === 0) return null;
    const tableOffset = data.tableOffset ?? 0;
    for (let i = 0; i < samples.length; i++) {
      ctx.typeNames.push({
        id: `binary_type_${String(i)}`,
        typeIndex: i,
        name: samples[i] ?? '',
        sourceTableOffset: tableOffset,
      });
    }
    return 'typeNames';
  });

/** type_chart_system → manifest.typeMatchups[] (iter 97)
 *  Reads `TypeChartSystemReport.typeChart.matchups[]` which iter 97
 *  added to the type-chart-scanner (previously matchups were parsed
 *  but discarded, only the count was exposed). Each matchup becomes
 *  a TypeMatchupEntry with attackerType/defenderType numeric indices;
 *  the cross-ref pass populates attackerTypeName/defenderTypeName
 *  from ctx.typeNames. */
const liftTypeChartSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    matchupCount?: number;
    typeChart?: {
      tableStart: number;
      matchups?: ReadonlyArray<{
        attackerType: number;
        defenderType: number;
        effectiveness: number;
      }>;
    };
  }>(row, (data) => {
    const matchups = data.typeChart?.matchups ?? [];
    if (matchups.length === 0) return null;
    const tableOffset = data.typeChart?.tableStart ?? 0;
    for (let i = 0; i < matchups.length; i++) {
      const m = matchups[i]!;
      ctx.typeMatchups.push({
        id: `binary_typematchup_${String(i)}`,
        attackerType: m.attackerType,
        defenderType: m.defenderType,
        effectiveness: m.effectiveness,
        sourceTableOffset: tableOffset,
        // Phase N - compute per-entry file offset so the editor can
        // patch effectiveness in place (3 bytes per matchup entry).
        entryFileOffset: tableOffset + i * 3,
      });
    }
    return 'typeMatchups';
  });

/** save_system → manifest.saveBlocks[] (iter 98)
 *  Lifts the SDK identifier string match + each additional match
 *  (PD 12: every occurrence surfaced) as SaveBlockEntry(kind=sdk_identifier). */
const liftSaveSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    identifier?: string;
    family?: string;
    declaredSizeBytes?: number;
    stringOffset?: number;
    additionalMatches?: ReadonlyArray<{
      identifier: string;
      family: string;
      stringOffset: number;
    }>;
  }>(row, (data) => {
    const identifier = data.identifier ?? '';
    if (identifier.length === 0) return null;
    ctx.saveBlocks.push({
      id: `binary_save_sdk_${String(data.stringOffset ?? 0).padStart(8, '0')}`,
      kind: 'sdk_identifier',
      label: identifier,
      offset: data.stringOffset ?? 0,
      family: data.family,
      sizeBytes: data.declaredSizeBytes,
    });
    const additional = data.additionalMatches ?? [];
    for (let i = 0; i < additional.length; i++) {
      const m = additional[i]!;
      ctx.saveBlocks.push({
        id: `binary_save_sdk_alt_${String(i)}_${String(m.stringOffset).padStart(8, '0')}`,
        kind: 'sdk_identifier',
        label: m.identifier,
        offset: m.stringOffset,
        family: m.family,
      });
    }
    return 'saveBlocks';
  });

/** save_data_system → manifest.saveBlocks[] (iter 98)
 *  Lifts the SECTOR_FOOTER_MAGIC primary occurrence + each additional
 *  offset as SaveBlockEntry(kind=sector_magic) with inferred sector
 *  index from offset modulo sectorSizeBytes. */
const liftSaveDataSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    magicOffset?: number;
    magicOccurrenceCount?: number;
    additionalOffsets?: ReadonlyArray<number>;
    sectorCount?: number;
    sectorSizeBytes?: number;
    totalSaveSizeBytes?: number;
  }>(row, (data) => {
    const offsets: number[] = [
      data.magicOffset ?? 0,
      ...(data.additionalOffsets ?? []),
    ];
    if (offsets.length === 0) return null;
    const sectorSize = data.sectorSizeBytes ?? 4096;
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i]!;
      // Sector index inferred from absolute offset modulo sector size.
      // Hack ROMs that relocate the save block may produce non-aligned
      // offsets - sectorIndex is best-effort.
      const sectorIndex = sectorSize > 0 ? Math.floor(off / sectorSize) % (data.sectorCount ?? 14) : 0;
      ctx.saveBlocks.push({
        id: `binary_save_sector_${String(i)}_${String(off).padStart(8, '0')}`,
        kind: 'sector_magic',
        label: `Save sector #${String(sectorIndex)} magic`,
        offset: off,
        sizeBytes: data.totalSaveSizeBytes,
        sectorIndex,
      });
    }
    return 'saveBlocks';
  });

/** menu_system → manifest.menus[] (iter 98)
 *  Lifts each matched prompt as a MenuEntry. */
const liftMenuSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    matchedPromptCount?: number;
    matches?: ReadonlyArray<{
      text: string;
      firstOffset: number;
      occurrenceCount: number;
    }>;
  }>(row, (data) => {
    const matches = data.matches ?? [];
    if (matches.length === 0) return null;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      ctx.menus.push({
        id: `binary_menu_${String(i)}_${m.text.replace(/[^A-Za-z0-9]/g, '_')}`,
        prompt: m.text,
        firstOffset: m.firstOffset,
        occurrenceCount: m.occurrenceCount,
      });
    }
    return 'menus';
  });

/** trainer_class_names → manifest.trainerClassNames[] (iter 96)
 *  Mirror of liftSpeciesNames pattern but for trainer-class names.
 *  Feeds the iter-96 cross-ref pass that resolves Trainer.className. */
const liftTrainerClassNames: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tableOffset?: number;
    validClassCount?: number;
    sampleNames?: ReadonlyArray<string>;
  }>(row, (data) => {
    const samples = data.sampleNames ?? [];
    if (samples.length === 0) return null;
    const tableOffset = data.tableOffset ?? 0;
    // Phase N.5 - Gen-3 trainer class names: 13-byte slot.
    const TRAINER_CLASS_NAME_STRIDE = 13;
    for (let i = 0; i < samples.length; i++) {
      ctx.trainerClassNames.push({
        id: `binary_trainerclass_${String(i)}`,
        classIndex: i,
        name: samples[i] ?? '',
        sourceTableOffset: tableOffset,
        nameSlotOffset: tableOffset + i * TRAINER_CLASS_NAME_STRIDE,
      });
    }
    return 'trainerClassNames';
  });

/** pokedex_system → manifest.pokedexEntries[] (iter 94)
 *  Richer than the other 4 name lifters because pokedex_system exposes
 *  per-entry category (decoded from PokedexEntry struct) + flavor text
 *  (decoded via descriptionPtr chase from iter 91). Limited to the
 *  16-entry preview the detector currently exposes. */
const liftPokedexSystem: ManifestLifter = (row, ctx) =>
  ifDetected<{
    pokedexTable?: { tableStart: number };
    sampleCategoryNames?: ReadonlyArray<string>;
    sampleFlavorTexts?: ReadonlyArray<string>;
    sampleEntryFileOffsets?: ReadonlyArray<number>;
    sampleDescriptionFileOffsets?: ReadonlyArray<number>;
  }>(row, (data) => {
    const categories = data.sampleCategoryNames ?? [];
    const flavors = data.sampleFlavorTexts ?? [];
    const entryOffsets = data.sampleEntryFileOffsets ?? [];
    const descOffsets = data.sampleDescriptionFileOffsets ?? [];
    const count = Math.max(categories.length, flavors.length);
    if (count === 0) return null;
    const tableOffset = data.pokedexTable?.tableStart ?? 0;
    for (let i = 0; i < count; i++) {
      const descOff = descOffsets[i];
      ctx.pokedexEntries.push({
        id: `binary_pokedex_${String(i)}`,
        speciesIndex: i,
        category: categories[i] ?? '',
        flavorText: flavors[i] ?? '',
        sourceTableOffset: tableOffset,
        ...(typeof entryOffsets[i] === 'number'
          ? { entryFileOffset: entryOffsets[i] }
          : {}),
        ...(typeof descOff === 'number' && descOff >= 0
          ? { descriptionFileOffset: descOff }
          : {}),
      });
    }
    return 'pokedexEntries';
  });

/** multichoice_lists_system → manifest.multichoiceLists[] (Phase O.3).
 *  Each detected gMultichoiceLists entry surfaces as one record carrying
 *  the per-choice text file offsets - the editor uses those to patch
 *  each choice string in place via the dialogue-string write route. */
const liftMultichoiceLists: ManifestLifter = (row, ctx) =>
  ifDetected<{
    tableStart?: number;
    entryCount?: number;
    sampleLists?: ReadonlyArray<{
      listIndex: number;
      entryFileOffset: number;
      count: number;
      choices: ReadonlyArray<{
        choiceIndex: number;
        text: string;
        textFileOffset: number;
      }>;
    }>;
  }>(row, (data) => {
    const lists = data.sampleLists ?? [];
    if (lists.length === 0) return null;
    for (const l of lists) {
      ctx.multichoiceLists.push({
        id: `binary_multichoice_${String(l.listIndex)}`,
        listIndex: l.listIndex,
        entryFileOffset: l.entryFileOffset,
        count: l.count,
        choices: l.choices.map((c) => ({
          choiceIndex: c.choiceIndex,
          text: c.text,
          textFileOffset: c.textFileOffset,
        })),
      });
    }
    return 'multichoiceLists';
  });

export const LIFTER_REGISTRY: Readonly<Record<string, ManifestLifter>> = Object.freeze({
  map_system: liftMapSystem,
  trainer_system: liftTrainerSystem,
  encounter_system: liftEncounterSystem,
  text_pointer_tables: liftTextPointerTables,
  lz77_pointer_tables: liftLz77PointerTables,
  palette_system: liftPaletteSystem,
  cry_table_system: liftCryTableSystem,
  audio_system: liftAudioSystem,
  script_engine: liftScriptEngine,
  // Iter 94 (UW-3-T13) - manifest schema expansion lifters.
  species_names: liftSpeciesNames,
  move_names: liftMoveNames,
  items_system: liftItemsSystem,
  abilities_system: liftAbilitiesSystem,
  pokedex_system: liftPokedexSystem,
  // Iter 96 (UW-3-T15) - trainer-class-names lifter feeds the
  // cross-reference pass that resolves Trainer.className.
  trainer_class_names: liftTrainerClassNames,
  // Iter 97 (UW-3-T16) - type system lifters.
  type_names: liftTypeNames,
  type_chart_system: liftTypeChartSystem,
  // Iter 98 (UW-3-T17) - save/menu lifters.
  save_system: liftSaveSystem,
  save_data_system: liftSaveDataSystem,
  menu_system: liftMenuSystem,
  // Iter 99 (UW-3-T18) - per-move BattleMove struct lift (deepens
  // moves_system from "moveCount only" to full per-move data).
  moves_system: liftMovesSystem,
  // Iter 100 (UW-3-T19) - NEW DETECTOR + lifter pair per UW-D-0015
  // (every new engine detector ships with its lifter same iter).
  experience_curves_system: liftExperienceCurvesSystem,
  // Iter 101 (UW-3-T20) - NEW DETECTOR + lifter pair per UW-D-0015.
  overworld_sprites_system: liftOverworldSpritesSystem,
  // Phase F (semantic-world plan §1.1) - NEW DETECTOR + lifter pair
  // per UW-D-0015. Surfaces the universal Gen-3
  // sObjectEventSpritePalettes[] table; cross-ref 22 attaches each
  // palette to its matching OverworldSpriteEntry by tag so the frontend
  // can render NPCs in color instead of grayscale.
  object_event_palettes_system: liftObjectEventPalettesSystem,
  // Iter 103 (UW-3-T22) - species_system lifter (engine already
  // exposed BaseStats records since iter 73; this is the FIRST lifter
  // for that data - largest single per-entry surface in the manifest).
  species_system: liftSpeciesSystem,
  // Iter 105 (UW-3-T24) - 3 sibling species detector lifters (same
  // 30-iter-latency closure pattern as iter 103; all three engine
  // scanners have been exposing per-species data since iters 75-78).
  species_evolutions: liftSpeciesEvolutions,
  species_learnsets: liftSpeciesLearnsets,
  species_tmhm: liftSpeciesTMHM,
  // Iter 107 (UW-3-T26) - NEW DETECTOR + lifter pair per UW-D-0015
  // (trainer party-member parser that follows partyPointer per trainer
  // and parses 4 struct variants based on partyFlags; enriches
  // existing ctx.trainers[].party array which iter-95 wrote as empty).
  trainer_parties_system: liftTrainerPartiesSystem,
  // Phase UX-B - NEW DETECTOR + lifter pair per UW-D-0015. Surfaces
  // the universal Gen-3 gRegionMapEntries table; cross-ref 18 rewrites
  // each map.name from iter-95's synthetic `Map ?.202` to the real
  // area name like "PALLET TOWN" using the regionMapSectionId byte
  // stashed on each map's metadata.
  region_map_sections_system: liftRegionMapSectionsSystem,
  // Phase O.3 (semantic-world plan §M2 / inline) - NEW DETECTOR + lifter
  // pair. Surfaces the gMultichoiceLists table so the operator can edit
  // every multichoice prompt's choices (YES/NO, starter picker, etc.)
  // via the existing dialogue-string write route.
  multichoice_lists_system: liftMultichoiceLists,
  // Phase O.42 - NEW DETECTOR + lifter pair. Surfaces sHealLocations[],
  // the universal Gen-3 spawn table that drives white-out / Fly /
  // Teleport / mom's-house destinations. Cross-ref 21 resolves each
  // entry's (group, mapNum) → mapId.
  heal_locations_system: liftHealLocationsSystem,
  // ────────────────────────────────────────────────────────────────
  // STILL UNLIFTED (flowing through subsystems[] only):
  //   - species_system / species_evolutions / species_learnsets /
  //     species_tmhm → would extend manifest.speciesNames[] entries
  //     with base stats / typings / abilities / evolutions when
  //     detectors expose per-species detail. Cross-lifter merge
  //     pattern needed (future iter).
  //   - moves_system → would extend manifest.moveNames[] entries with
  //     power / accuracy / pp / type / effect (the engine moves
  //     scanner exposes this per-move; lifter just needs to read it).
  //   - type_chart_system / type_names → no current manifest
  //     collection. Add typeMatchups[] + typeNames[] in a future iter.
  //   - trainer_class_names → use as cross-ref for trainer.className
  //     resolution rather than a separate collection (iter 95 candidate).
  //   - save_system / save_data_system / menu_system → need
  //     manifest.saveBlocks[] + manifest.menus[] (future iter).
  // PD 12 invariant: every detector still appears in subsystems[].
  // ────────────────────────────────────────────────────────────────
});

/** Returns true iff a lifter is registered for the given detector id. */
export function hasLifter(detectorId: string): boolean {
  return Object.prototype.hasOwnProperty.call(LIFTER_REGISTRY, detectorId);
}

/** Returns the registered lifter for the detector id, or null. */
export function getLifter(detectorId: string): ManifestLifter | null {
  return LIFTER_REGISTRY[detectorId] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// CROSS-REFERENCE PASS (iter 96 / UW-3-T15)
//
// Runs AFTER all lifters have populated ctx. Reads cross-lifter lookup
// tables (speciesNames + trainerClassNames) and back-patches entries
// in ctx.trainers / ctx.encounterTables / ctx.pokedexEntries to
// resolve synthetic ids like `class_3` / `species_1` into the real
// decoded strings the engine pulled off the cart.
//
// THE CROSS-REFERENCE PASS MUST RUN AFTER LIFTERS. The lifter loop
// in `app/backend/src/scan/binary-rom.ts` calls this function once at
// the end. Add new cross-references here when wiring new lifters that
// depend on other lifters' output (e.g. type-names cross-ref into
// future moves[] effect-type field, etc.).
// ─────────────────────────────────────────────────────────────────────

export interface CrossReferenceStats {
  readonly trainerClassResolved: number;
  readonly encounterSpeciesResolved: number;
  readonly pokedexSpeciesNamed: number;
  readonly typeMatchupsNamed: number;
  /** Iter 99 - count of BattleMoveEntry rows where the name field was
   *  populated from a moveNames lookup. */
  readonly battleMovesNamed: number;
  /** Iter 99 - count of BattleMoveEntry rows where typeName was populated
   *  from a typeNames lookup (using the move's type byte). */
  readonly battleMovesTyped: number;
  /** Iter 102 - count of ObjectEvent rows where iter-95's `gfx_N`
   *  graphicsId resolved against iter-101's OverworldSpriteEntry roster,
   *  enriching metadata with sprite dimensions/palette tag/tracks. */
  readonly objectEventSpritesResolved: number;
  /** Phase F (semantic-world plan §1.1) - count of ObjectEvent rows
   *  where the sprite's paletteTag additionally resolved to a concrete
   *  16-color RGBA palette via iter-Phase-F's objectEventPalettes
   *  lookup. Always ≤ objectEventSpritesResolved. When this is 0 the
   *  frontend will render NPCs in grayscale (palette table not detected
   *  or no sprite matched a known tag). */
  readonly objectEventSpritesPaletteResolved: number;
  /** Iter 103 - count of SpeciesEntry rows where the name field was
   *  populated from a speciesNames lookup. */
  readonly speciesNamed: number;
  /** Iter 103 - count of SpeciesEntry rows where type1Name was populated
   *  from a typeNames lookup. */
  readonly speciesType1Named: number;
  /** Iter 103 - count of SpeciesEntry rows where type2Name was populated
   *  from a typeNames lookup. */
  readonly speciesType2Named: number;
  /** Iter 104 - count of SpeciesEntry rows where growthRateName +
   *  growthRateXpAtLevel100 were populated from iter-100's
   *  experienceCurves lookup via the species' growthRate byte. */
  readonly speciesGrowthRateResolved: number;
  /** Iter 106 - count of SpeciesEvolutionSlot entries where
   *  targetSpeciesName was populated from speciesNames lookup. */
  readonly speciesEvolutionTargetsNamed: number;
  /** Iter 106 - count of SpeciesLearnsetMove entries where moveName was
   *  populated from moveNames lookup. */
  readonly speciesLearnsetMovesNamed: number;
  /** Iter 106 - count of SpeciesEntry rows where ability1Name was
   *  populated from abilities lookup. */
  readonly speciesAbility1Named: number;
  /** Iter 106 - count of SpeciesEntry rows where ability2Name was
   *  populated from abilities lookup. */
  readonly speciesAbility2Named: number;
  /** Iter 108 - count of TrainerPartyMember entries (across all
   *  trainers) where speciesId resolved from `species_N` to the real
   *  decoded species name via speciesNames lookup. */
  readonly trainerPartySpeciesNamed: number;
  /** Iter 108 - count of TrainerPartyMember.moveIds entries (across
   *  all trainers + all members) where moveIds[k] resolved from
   *  `move_M` to the real decoded move name via moveNames lookup. */
  readonly trainerPartyMovesNamed: number;
  /** Iter 108 - count of TrainerPartyMember.heldItemId entries
   *  (across all trainers) where heldItemId resolved from `item_K`
   *  to the real decoded item name via items lookup. */
  readonly trainerPartyHeldItemsNamed: number;
  /** Phase UX-B - count of MapNode rows where `name` was rewritten
   *  from iter-95's synthetic `Map ?.202` to the real area name
   *  (e.g. "PALLET TOWN") via the region-map sections lookup. */
  readonly mapsRegionNamed: number;
  readonly mapsEncounterTablesResolved: number;
  /** Iter 110 - count of SpeciesEntry rows where item1Name was
   *  populated from the items lookup via the item1 byte (the
   *  high-rarity wild-catch held item slot). */
  readonly speciesItem1Named: number;
  /** Iter 110 - count of SpeciesEntry rows where item2Name was
   *  populated from the items lookup via the item2 byte. */
  readonly speciesItem2Named: number;
  /** Phase O.42 - count of HealLocationEntry rows where destMapId
   *  resolved from the (group, mapNum) pair to a lifted map. */
  readonly healLocationsResolved: number;
}

export function crossReferenceLiftedEntries(ctx: LifterContext): CrossReferenceStats {
  const stats: {
    trainerClassResolved: number;
    encounterSpeciesResolved: number;
    pokedexSpeciesNamed: number;
    typeMatchupsNamed: number;
    battleMovesNamed: number;
    battleMovesTyped: number;
    objectEventSpritesResolved: number;
    objectEventSpritesPaletteResolved: number;
    speciesNamed: number;
    speciesType1Named: number;
    speciesType2Named: number;
    speciesGrowthRateResolved: number;
    speciesEvolutionTargetsNamed: number;
    speciesLearnsetMovesNamed: number;
    speciesAbility1Named: number;
    speciesAbility2Named: number;
    trainerPartySpeciesNamed: number;
    trainerPartyMovesNamed: number;
    trainerPartyHeldItemsNamed: number;
    mapsRegionNamed: number;
    mapsEncounterTablesResolved: number;
    speciesItem1Named: number;
    speciesItem2Named: number;
    healLocationsResolved: number;
  } = {
    trainerClassResolved: 0,
    encounterSpeciesResolved: 0,
    pokedexSpeciesNamed: 0,
    typeMatchupsNamed: 0,
    battleMovesNamed: 0,
    battleMovesTyped: 0,
    objectEventSpritesResolved: 0,
    objectEventSpritesPaletteResolved: 0,
    speciesNamed: 0,
    speciesType1Named: 0,
    speciesType2Named: 0,
    speciesGrowthRateResolved: 0,
    speciesEvolutionTargetsNamed: 0,
    speciesLearnsetMovesNamed: 0,
    speciesAbility1Named: 0,
    speciesAbility2Named: 0,
    trainerPartySpeciesNamed: 0,
    trainerPartyMovesNamed: 0,
    trainerPartyHeldItemsNamed: 0,
    mapsRegionNamed: 0,
    mapsEncounterTablesResolved: 0,
    speciesItem1Named: 0,
    speciesItem2Named: 0,
    healLocationsResolved: 0,
  };

  // Build lookup tables - only populated when the source lifter ran.
  const classNameByIndex = new Map<number, string>();
  for (const tc of ctx.trainerClassNames) {
    if (tc.name.length > 0) classNameByIndex.set(tc.classIndex, tc.name);
  }
  const speciesNameByIndex = new Map<number, string>();
  for (const s of ctx.speciesNames) {
    if (s.name.length > 0) speciesNameByIndex.set(s.speciesIndex, s.name);
  }

  // Cross-ref 1: trainer className `class_N` → real class name.
  if (classNameByIndex.size > 0) {
    for (let i = 0; i < ctx.trainers.length; i++) {
      const t = ctx.trainers[i]!;
      const m = /^class_(\d+)$/.exec(t.className);
      if (!m) continue;
      const idx = parseInt(m[1]!, 10);
      const real = classNameByIndex.get(idx);
      if (real !== undefined) {
        ctx.trainers[i] = { ...t, className: real };
        stats.trainerClassResolved++;
      }
    }
  }

  // Cross-ref 2: encounter slot speciesId `species_N` → real species name.
  // EncounterTable.slots is readonly so rebuild the table when any slot
  // gets a name resolution.
  if (speciesNameByIndex.size > 0) {
    for (let i = 0; i < ctx.encounterTables.length; i++) {
      const et = ctx.encounterTables[i]!;
      let anyResolved = false;
      const newSlots: EncounterSlot[] = [];
      for (const slot of et.slots) {
        const m = /^species_(\d+)$/.exec(slot.speciesId);
        if (!m) {
          newSlots.push(slot);
          continue;
        }
        const idx = parseInt(m[1]!, 10);
        const real = speciesNameByIndex.get(idx);
        if (real !== undefined) {
          newSlots.push({ ...slot, speciesId: real });
          anyResolved = true;
          stats.encounterSpeciesResolved++;
        } else {
          newSlots.push(slot);
        }
      }
      if (anyResolved) {
        ctx.encounterTables[i] = { ...et, slots: Object.freeze(newSlots) };
      }
    }
  }

  // Cross-ref 3: PokedexEntryRecord.speciesName from speciesIndex.
  if (speciesNameByIndex.size > 0) {
    for (let i = 0; i < ctx.pokedexEntries.length; i++) {
      const p = ctx.pokedexEntries[i]!;
      const real = speciesNameByIndex.get(p.speciesIndex);
      if (real !== undefined && p.speciesName === undefined) {
        ctx.pokedexEntries[i] = { ...p, speciesName: real };
        stats.pokedexSpeciesNamed++;
      }
    }
  }

  // Cross-ref 4 (iter 97): TypeMatchupEntry attacker/defender names
  // from type_names detector lookup. Each matchup carries numeric
  // attackerType + defenderType byte indices; populate the optional
  // attackerTypeName + defenderTypeName fields when type_names ran.
  const typeNameByIndex = new Map<number, string>();
  for (const tn of ctx.typeNames) {
    if (tn.name.length > 0) typeNameByIndex.set(tn.typeIndex, tn.name);
  }
  if (typeNameByIndex.size > 0) {
    for (let i = 0; i < ctx.typeMatchups.length; i++) {
      const m = ctx.typeMatchups[i]!;
      const attacker = typeNameByIndex.get(m.attackerType);
      const defender = typeNameByIndex.get(m.defenderType);
      if (attacker !== undefined || defender !== undefined) {
        ctx.typeMatchups[i] = {
          ...m,
          ...(attacker !== undefined ? { attackerTypeName: attacker } : {}),
          ...(defender !== undefined ? { defenderTypeName: defender } : {}),
        };
        stats.typeMatchupsNamed++;
      }
    }
  }

  // Cross-ref 5 (iter 99): BattleMoveEntry.name from move_names lookup
  // (move_names detector currently exposes 16-entry preview, so only
  // the first ~16 moves get named - the rest carry index-only ids).
  const moveNameByIndex = new Map<number, string>();
  for (const mn of ctx.moveNames) {
    if (mn.name.length > 0) moveNameByIndex.set(mn.moveIndex, mn.name);
  }
  if (moveNameByIndex.size > 0) {
    for (let i = 0; i < ctx.battleMoves.length; i++) {
      const bm = ctx.battleMoves[i]!;
      const real = moveNameByIndex.get(bm.moveIndex);
      if (real !== undefined && bm.name === undefined) {
        ctx.battleMoves[i] = { ...bm, name: real };
        stats.battleMovesNamed++;
      }
    }
  }

  // Cross-ref 6 (iter 99): BattleMoveEntry.typeName from type_names
  // lookup via the move's type byte (0..17 in vanilla Gen-3). This
  // resolves to "NORMAL"/"FIRE"/"WATER"/etc. when type_names ran.
  if (typeNameByIndex.size > 0) {
    for (let i = 0; i < ctx.battleMoves.length; i++) {
      const bm = ctx.battleMoves[i]!;
      const typeName = typeNameByIndex.get(bm.type);
      if (typeName !== undefined && bm.typeName === undefined) {
        ctx.battleMoves[i] = { ...bm, typeName };
        stats.battleMovesTyped++;
      }
    }
  }

  // Cross-ref 7 (iter 102): ObjectEvent.graphicsId `gfx_N` → enrich
  // metadata with iter-101's OverworldSpriteEntry data (sprite width/
  // height/size/paletteTag/tracks). Iter 95's map-system lifter writes
  // graphicsId as `gfx_${rawByteIndex}`, which is the same spriteIndex
  // iter 101's overworld_sprites_system detector indexes its table by.
  // The lookup ties every map's NPC/decoration to a renderable sprite
  // record - substrate for PD 14 visual-first map editor preview.
  //
  // Phase F (semantic-world plan §1.1) - extended to also attach the
  // resolved RGBA palette (from iter-Phase-F's objectEventPalettes by
  // tag) so the frontend can render NPCs in color instead of grayscale.
  const spriteByIndex = new Map<number, (typeof ctx.overworldSprites)[number]>();
  for (const s of ctx.overworldSprites) {
    spriteByIndex.set(s.spriteIndex, s);
  }
  const paletteByTag = new Map<number, (typeof ctx.objectEventPalettes)[number]>();
  for (const p of ctx.objectEventPalettes) {
    paletteByTag.set(p.tag, p);
  }
  if (spriteByIndex.size > 0) {
    for (let i = 0; i < ctx.objectEvents.length; i++) {
      const oe = ctx.objectEvents[i]!;
      if (oe.graphicsId === null) continue;
      const m = /^gfx_(\d+)$/.exec(oe.graphicsId);
      if (!m) continue;
      const idx = parseInt(m[1]!, 10);
      const sprite = spriteByIndex.get(idx);
      if (sprite === undefined) continue;
      // Skip if metadata already has spriteWidth - idempotent guard
      // against double-application (cross-ref pass runs once but be
      // safe in case future iters re-enter).
      if (Object.prototype.hasOwnProperty.call(oe.metadata, 'spriteWidth')) continue;
      // Cross-ref 22 (Phase F): resolve the palette tag to a concrete
      // 16 × u32 RGBA palette. When the OBJ palette table detector
      // didn't fire (e.g. non-vanilla layout), spritePaletteRgbaHex is
      // omitted and the route falls back to grayscale.
      //
      // Encoded as a 128-char lowercase-hex string (16 × u32 × 8 chars
      // each) because ObjectEvent.metadata is constrained to scalar
      // values per the universal vocabulary. The frontend decodes it
      // before passing to /binary-rom-ow-sprite.
      const resolved = paletteByTag.get(sprite.paletteTag);
      const paletteHex = resolved
        ? Array.from(resolved.paletteRgba)
            .map((u32) => (u32 >>> 0).toString(16).padStart(8, '0'))
            .join('')
        : null;
      ctx.objectEvents[i] = {
        ...oe,
        metadata: {
          ...oe.metadata,
          spriteWidth: sprite.width,
          spriteHeight: sprite.height,
          spriteSize: sprite.size,
          spritePaletteTag: sprite.paletteTag,
          spriteTracks: sprite.tracks,
          spriteStructFileOffset: sprite.structFileOffset,
          ...(paletteHex !== null ? { spritePaletteRgbaHex: paletteHex } : {}),
        },
      };
      stats.objectEventSpritesResolved++;
      if (resolved) stats.objectEventSpritesPaletteResolved++;
    }
  }

  // Cross-ref 8 (iter 103): SpeciesEntry.name from speciesNames lookup.
  // species_names detector currently exposes 16-entry preview, so only
  // the first ~16 species get named - the rest carry index-only ids.
  if (speciesNameByIndex.size > 0) {
    for (let i = 0; i < ctx.species.length; i++) {
      const sp = ctx.species[i]!;
      const real = speciesNameByIndex.get(sp.speciesIndex);
      if (real !== undefined && sp.name === undefined) {
        ctx.species[i] = { ...sp, name: real };
        stats.speciesNamed++;
      }
    }
  }

  // Cross-ref 9 (iter 103): SpeciesEntry.type1Name + type2Name from
  // typeNames lookup via the per-species type bytes (0..17 vanilla
  // Gen-3). Resolves to NORMAL/FIRE/WATER/etc. when type_names ran.
  if (typeNameByIndex.size > 0) {
    for (let i = 0; i < ctx.species.length; i++) {
      const sp = ctx.species[i]!;
      const type1Name = typeNameByIndex.get(sp.type1);
      const type2Name = typeNameByIndex.get(sp.type2);
      const needsType1 = type1Name !== undefined && sp.type1Name === undefined;
      const needsType2 = type2Name !== undefined && sp.type2Name === undefined;
      if (needsType1 || needsType2) {
        ctx.species[i] = {
          ...sp,
          ...(needsType1 ? { type1Name } : {}),
          ...(needsType2 ? { type2Name } : {}),
        };
        if (needsType1) stats.speciesType1Named++;
        if (needsType2) stats.speciesType2Named++;
      }
    }
  }

  // Cross-ref 10 (iter 104): SpeciesEntry.growthRateName +
  // growthRateXpAtLevel100 from iter-100's experienceCurves lookup
  // via the species' growthRate byte (0..5 vanilla). Each species
  // references its level-up XP curve by an index into gExperienceTables;
  // the matching ExperienceCurveEntry carries the canonical curve name
  // (MEDIUM_FAST/ERRATIC/FLUCTUATING/MEDIUM_SLOW/FAST/SLOW) + the
  // level-100 XP magnitude. Surfaces "BULBASAUR: MEDIUM_SLOW (1,059,860
  // XP to lv100)" inline on each species instead of requiring
  // experienceCurves[i].growthRateName secondary lookup.
  const curveByIndex = new Map<number, (typeof ctx.experienceCurves)[number]>();
  for (const c of ctx.experienceCurves) {
    curveByIndex.set(c.curveIndex, c);
  }
  if (curveByIndex.size > 0) {
    for (let i = 0; i < ctx.species.length; i++) {
      const sp = ctx.species[i]!;
      const curve = curveByIndex.get(sp.growthRate);
      if (curve === undefined) continue;
      const needsName = sp.growthRateName === undefined && curve.growthRateName !== null;
      const needsXp = sp.growthRateXpAtLevel100 === undefined;
      if (needsName || needsXp) {
        ctx.species[i] = {
          ...sp,
          ...(needsName ? { growthRateName: curve.growthRateName ?? undefined } : {}),
          ...(needsXp ? { growthRateXpAtLevel100: curve.xpAtLevel100 } : {}),
        };
        stats.speciesGrowthRateResolved++;
      }
    }
  }

  // Cross-ref 11 (iter 106): SpeciesEvolutionSlot.targetSpeciesName
  // from speciesNames lookup via slot.targetSpecies. Resolves
  // "evolves into species_24" → "evolves into RAICHU". For each
  // SpeciesEvolutionEntry, walk its slots[]; per slot, look up the
  // targetSpecies name; if found AND not already populated, rebuild the
  // slot with targetSpeciesName set. Rebuilds the entry's frozen slots
  // array when any slot was enriched.
  if (speciesNameByIndex.size > 0) {
    for (let i = 0; i < ctx.speciesEvolutions.length; i++) {
      const evo = ctx.speciesEvolutions[i]!;
      let anyResolved = false;
      const newSlots: typeof evo.slots[number][] = [];
      for (const slot of evo.slots) {
        const real = speciesNameByIndex.get(slot.targetSpecies);
        if (real !== undefined && slot.targetSpeciesName === undefined) {
          newSlots.push({ ...slot, targetSpeciesName: real });
          anyResolved = true;
          stats.speciesEvolutionTargetsNamed++;
        } else {
          newSlots.push(slot);
        }
      }
      if (anyResolved) {
        ctx.speciesEvolutions[i] = { ...evo, slots: Object.freeze(newSlots) };
      }
    }
  }

  // Cross-ref 12 (iter 106): SpeciesLearnsetMove.moveName from
  // moveNames lookup via move.move byte. Resolves
  // "lvl 5 learns move_45" → "lvl 5 learns VINE WHIP" (when
  // moveNames sample-15 includes that index). For each learnset entry,
  // walk its moves[]; rebuild when any move resolved.
  if (moveNameByIndex.size > 0) {
    for (let i = 0; i < ctx.speciesLearnsets.length; i++) {
      const ls = ctx.speciesLearnsets[i]!;
      let anyResolved = false;
      const newMoves: typeof ls.moves[number][] = [];
      for (const m of ls.moves) {
        const real = moveNameByIndex.get(m.move);
        if (real !== undefined && m.moveName === undefined) {
          newMoves.push({ ...m, moveName: real });
          anyResolved = true;
          stats.speciesLearnsetMovesNamed++;
        } else {
          newMoves.push(m);
        }
      }
      if (anyResolved) {
        ctx.speciesLearnsets[i] = { ...ls, moves: Object.freeze(newMoves) };
      }
    }
  }

  // Cross-refs 13+14 (iter 106): SpeciesEntry.ability1Name/ability2Name
  // from abilities lookup via the per-species ability bytes. iter-94's
  // abilities collection has byte-indexed names (first 16 sample only
  // currently, so resolution rate is low for the full 411-species
  // roster but the substrate is wired for future detector deepening).
  const abilityNameByIndex = new Map<number, string>();
  for (const a of ctx.abilities) {
    if (a.name.length > 0) abilityNameByIndex.set(a.abilityIndex, a.name);
  }
  if (abilityNameByIndex.size > 0) {
    for (let i = 0; i < ctx.species.length; i++) {
      const sp = ctx.species[i]!;
      const ability1Name = abilityNameByIndex.get(sp.ability1);
      const ability2Name = abilityNameByIndex.get(sp.ability2);
      const needs1 = ability1Name !== undefined && sp.ability1Name === undefined;
      const needs2 = ability2Name !== undefined && sp.ability2Name === undefined;
      if (needs1 || needs2) {
        ctx.species[i] = {
          ...sp,
          ...(needs1 ? { ability1Name } : {}),
          ...(needs2 ? { ability2Name } : {}),
        };
        if (needs1) stats.speciesAbility1Named++;
        if (needs2) stats.speciesAbility2Named++;
      }
    }
  }

  // Cross-refs 15+16+17 (iter 108): amplify iter-107's trainer-parties
  // lifter output. iter-107 wrote ctx.trainers[].party members with
  // synthetic ids (speciesId=`species_N`, moveIds=[`move_M`,…],
  // heldItemId=`item_K`). Resolve each to the real decoded name via
  // the corresponding sample-collection lookups (built earlier).
  // Rebuilds the trainer.party array via spread when any member resolved.
  const itemNameByIndex = new Map<number, string>();
  for (const it of ctx.items) {
    if (it.name.length > 0) itemNameByIndex.set(it.itemIndex, it.name);
  }
  if (
    speciesNameByIndex.size > 0 ||
    moveNameByIndex.size > 0 ||
    itemNameByIndex.size > 0
  ) {
    for (let ti = 0; ti < ctx.trainers.length; ti++) {
      const trainer = ctx.trainers[ti]!;
      if (trainer.party.length === 0) continue;
      let trainerChanged = false;
      const newParty: typeof trainer.party[number][] = [];
      for (const member of trainer.party) {
        let memberChanged = false;
        let newSpeciesId = member.speciesId;
        let newHeldItemId = member.heldItemId;
        let newMoveIds: typeof member.moveIds = member.moveIds;

        // Cross-ref 15: speciesId `species_N` → real species name.
        const speciesMatch = /^species_(\d+)$/.exec(member.speciesId);
        if (speciesMatch !== null) {
          const idx = parseInt(speciesMatch[1]!, 10);
          const real = speciesNameByIndex.get(idx);
          if (real !== undefined) {
            newSpeciesId = real;
            memberChanged = true;
            stats.trainerPartySpeciesNamed++;
          }
        }
        // Cross-ref 17: heldItemId `item_K` → real item name.
        if (member.heldItemId !== null) {
          const itemMatch = /^item_(\d+)$/.exec(member.heldItemId);
          if (itemMatch !== null) {
            const idx = parseInt(itemMatch[1]!, 10);
            const real = itemNameByIndex.get(idx);
            if (real !== undefined) {
              newHeldItemId = real;
              memberChanged = true;
              stats.trainerPartyHeldItemsNamed++;
            }
          }
        }
        // Cross-ref 16: moveIds[k] `move_M` → real move name. Rebuild
        // the moveIds array whenever any element resolved.
        let anyMoveResolved = false;
        const rebuiltMoves: string[] = [];
        for (const moveId of member.moveIds) {
          const moveMatch = /^move_(\d+)$/.exec(moveId);
          if (moveMatch === null) {
            rebuiltMoves.push(moveId);
            continue;
          }
          const idx = parseInt(moveMatch[1]!, 10);
          const real = moveNameByIndex.get(idx);
          if (real !== undefined) {
            rebuiltMoves.push(real);
            anyMoveResolved = true;
            stats.trainerPartyMovesNamed++;
          } else {
            rebuiltMoves.push(moveId);
          }
        }
        if (anyMoveResolved) {
          newMoveIds = Object.freeze(rebuiltMoves);
          memberChanged = true;
        }

        if (memberChanged) {
          newParty.push({
            ...member,
            speciesId: newSpeciesId,
            heldItemId: newHeldItemId,
            moveIds: newMoveIds,
          });
          trainerChanged = true;
        } else {
          newParty.push(member);
        }
      }
      if (trainerChanged) {
        ctx.trainers[ti] = { ...trainer, party: Object.freeze(newParty) };
      }
    }
  }

  // Cross-ref 18 (Phase UX-B): MapNode.name rewrite from iter-95's
  // synthetic `Map ?.202` to the real area name like "PALLET TOWN"
  // resolved via the region_map_sections_system lookup. Each map's
  // regionMapSectionId byte was stashed on metadata by iter-95;
  // ctx.regionMapSections is indexed by sectionIndex.
  //
  // Phase G-RC4 (semantic-world plan §G.4): the original code filtered
  // `regionByIndex` to entries with `name.length > 0`, which meant
  // maps pointing at empty-decoded MAPSEC slots fell through to the
  // synthetic `Map ?.N` name. Now we surface a friendly fallback - 
  // "Area #N" - for sectionIds that are known to the detector but
  // decode to empty, so every map gets a readable name instead of
  // leaking the synthetic format.
  const regionByIndex = new Map<number, string>();
  const regionKnownIndex = new Set<number>();
  for (const rm of ctx.regionMapSections) {
    regionKnownIndex.add(rm.sectionIndex);
    if (rm.name.length > 0) regionByIndex.set(rm.sectionIndex, rm.name);
  }
  if (regionKnownIndex.size > 0) {
    for (let i = 0; i < ctx.maps.length; i++) {
      const map = ctx.maps[i]!;
      const rawId = map.metadata['regionMapSectionId'];
      const sectionId = typeof rawId === 'number' ? rawId : -1;
      if (sectionId < 0) continue;
      // Don't double-rename - skip when name no longer matches the
      // synthetic iter-95 format (operator may have manually renamed).
      if (!/^Map (\?|\d+)\.\d+$/.test(map.name)) continue;
      const realName = regionByIndex.get(sectionId);
      let friendlyName: string;
      if (realName !== undefined) {
        // Title-case the all-caps Gen-3 area name for nicer display.
        friendlyName = titleCaseAreaName(realName);
      } else if (regionKnownIndex.has(sectionId)) {
        // Detector saw this section index but it decoded to empty
        // (codec gap or genuinely blank entry). Surface a friendlier
        // placeholder than `Map ?.N`.
        friendlyName = `Area #${String(sectionId)}`;
      } else {
        continue;
      }
      ctx.maps[i] = { ...map, name: friendlyName };
      stats.mapsRegionNamed++;
    }
  }

  if (ctx.encounterTables.length > 0 && ctx.maps.length > 0) {
    const encounterIdsByMap = new Map<string, string[]>();
    for (const table of ctx.encounterTables) {
      if (table.mapId === null) continue;
      const arr = encounterIdsByMap.get(table.mapId) ?? [];
      arr.push(table.id);
      encounterIdsByMap.set(table.mapId, arr);
    }
    for (let i = 0; i < ctx.maps.length; i++) {
      const map = ctx.maps[i]!;
      const ids = encounterIdsByMap.get(map.id);
      if (ids === undefined || ids.length === 0) continue;
      const merged = Array.from(new Set([...map.encounterTableIds, ...ids]));
      if (merged.length === map.encounterTableIds.length) continue;
      ctx.maps[i] = { ...map, encounterTableIds: Object.freeze(merged) };
      stats.mapsEncounterTablesResolved++;
    }
  }

  // Cross-refs 19+20 (iter 110): SpeciesEntry.item1Name + item2Name
  // from the items lookup via the per-species item1/item2 bytes
  // (held-item drop slots - rare wild Pokémon hold these). Reuses
  // itemNameByIndex Map built in cross-ref 17 above. Skips when the
  // item byte is 0 (no held item).
  if (itemNameByIndex.size > 0) {
    for (let i = 0; i < ctx.species.length; i++) {
      const sp = ctx.species[i]!;
      const item1Name = sp.item1 !== 0 ? itemNameByIndex.get(sp.item1) : undefined;
      const item2Name = sp.item2 !== 0 ? itemNameByIndex.get(sp.item2) : undefined;
      const needs1 = item1Name !== undefined && sp.item1Name === undefined;
      const needs2 = item2Name !== undefined && sp.item2Name === undefined;
      if (needs1 || needs2) {
        ctx.species[i] = {
          ...sp,
          ...(needs1 ? { item1Name } : {}),
          ...(needs2 ? { item2Name } : {}),
        };
        if (needs1) stats.speciesItem1Named++;
        if (needs2) stats.speciesItem2Named++;
      }
    }
  }

  // Cross-ref 21 (Phase O.42): HealLocationEntry.destMapId from the
  // per-entry (group, mapNum) bytes, resolved via the maps lookup
  // built once per pass. The lifter wrote null placeholders for every
  // entry; this pass fills them in when the (group, mapNum) pair
  // matches a known binary-rom map. Unmatched entries stay null - 
  // some heal locations target maps that didn't get lifted (hack ROMs
  // with sparse map tables, or the special "no map" sentinel slot).
  if (ctx.healLocations.length > 0 && ctx.maps.length > 0) {
    const mapByGroupNum = new Map<number, string>();
    for (const m of ctx.maps) {
      const g = m.metadata['groupIndex'];
      const n = m.metadata['mapNum'];
      if (typeof g === 'number' && g >= 0 && typeof n === 'number') {
        mapByGroupNum.set((g << 8) | n, m.id);
      }
    }
    for (let i = 0; i < ctx.healLocations.length; i++) {
      const h = ctx.healLocations[i]!;
      const mapId = mapByGroupNum.get((h.group << 8) | h.mapNum);
      if (mapId !== undefined) {
        ctx.healLocations[i] = { ...h, destMapId: mapId };
        stats.healLocationsResolved++;
      }
    }
  }

  return Object.freeze(stats);
}

/** Convert Gen-3 all-caps area names to nicer Title Case display while
 *  preserving common abbreviations (MT. / S.S. / etc.). */
function titleCaseAreaName(name: string): string {
  const lower = name.toLowerCase();
  // Preserve initial-caps for first letter of every word + after a
  // period or dash.
  return lower.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────
// Phase H-RC1 (semantic-world plan §H.1) - binary script decoder.
//
// Decode the bytecode at each ObjectEvent / Trigger / Map-script's
// ROM offset into a typed sequence of ScriptSteps. Runs AFTER lifters
// (so ctx.objectEvents and ctx.triggers are populated) and AFTER
// cross-ref (so the steps replace any stub raw scripts). Requires
// ROM bytes - invoked from binary-rom.ts which has them.
//
// Each ObjectEvent.scriptId stays as `script_0x<offset>` (the existing
// synthetic id format). Decoded steps get pushed to ctx.scriptSteps
// with ids `script_0x<offset>__<index>` so the frontend can look them
// up by prefix.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryScriptDecodeStats {
  /** Number of unique scriptOffsets encountered + decoded. */
  readonly scriptsDecoded: number;
  /** Number of decoded ScriptSteps pushed to ctx.scriptSteps. */
  readonly stepsEmitted: number;
  /** Number of ObjectEvents that had a script + got decoded steps. */
  readonly objectEventsWithDecodedScript: number;
}

export function decodeBinaryScriptsForLiftedEntities(
  ctx: LifterContext,
  romBytes: Uint8Array,
): BinaryScriptDecodeStats {
  // Build the set of unique script file offsets to decode. We dedup
  // because many NPCs share the same script - and pulling out
  // `_0xN` from the scriptId synthetic format does that for us.
  //
  // Phase I.3.1 - also walk Triggers (coord triggers + signs/hidden
  // items lifted from bgEvents). Both stash `binary_script_0xN` in
  // their `scriptStepIds[]` and need the same decoder, otherwise the
  // sign inspector says "No decoded steps" forever - exactly what the
  // user reported after Phase I.2.1.
  const offsetByScriptId = new Map<string, number>();
  for (const oe of ctx.objectEvents) {
    if (!oe.scriptId) continue;
    const m = /^script_0x([0-9a-fA-F]+)$/.exec(oe.scriptId);
    if (!m) continue;
    const off = parseInt(m[1]!, 16);
    if (Number.isFinite(off) && off > 0 && off < romBytes.length) {
      offsetByScriptId.set(oe.scriptId, off);
    }
  }
  for (const tr of ctx.triggers) {
    for (const sid of tr.scriptStepIds) {
      // Triggers stash `binary_script_0xN` (not `script_0xN` - distinct
      // namespace from ObjectEvent.scriptId). Recognize both prefixes.
      const m = /^(?:binary_)?script_0x([0-9a-fA-F]+)$/.exec(sid);
      if (!m) continue;
      const off = parseInt(m[1]!, 16);
      if (Number.isFinite(off) && off > 0 && off < romBytes.length) {
        offsetByScriptId.set(sid, off);
      }
    }
  }

  // Decode each unique script + push steps.
  let stepsEmitted = 0;
  let objectEventsWithDecodedScript = 0;
  const seenScriptIds = new Set<string>();
  for (const [scriptId, off] of offsetByScriptId) {
    if (seenScriptIds.has(scriptId)) continue;
    seenScriptIds.add(scriptId);
    let decoded;
    try {
      decoded = engineScripts.decodeBinaryScript(romBytes, off);
    } catch {
      continue;
    }
    if (decoded.steps.length === 0) continue;
    for (const step of decoded.steps) {
      ctx.scriptSteps.push({
        id: `${scriptId}__${String(step.index)}`,
        kind: step.kind,
        params: Object.freeze({
          ...step.params,
          label: step.label,
          fileOffset: step.fileOffset,
        }),
      });
      stepsEmitted++;
    }
  }

  // Count object events that got decoded scripts.
  const decodedScriptIds = new Set<string>();
  for (const step of ctx.scriptSteps) {
    // Step ids are `<scriptId>__<index>`. Split once on '__'.
    const idx = step.id.indexOf('__');
    if (idx > 0) decodedScriptIds.add(step.id.slice(0, idx));
  }
  for (const oe of ctx.objectEvents) {
    if (oe.scriptId && decodedScriptIds.has(oe.scriptId)) {
      objectEventsWithDecodedScript++;
    }
  }

  return Object.freeze({
    scriptsDecoded: seenScriptIds.size,
    stepsEmitted,
    objectEventsWithDecodedScript,
  });
}
