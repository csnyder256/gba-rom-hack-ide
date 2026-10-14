/**
 * Phase-5 detector: map system detection (P5-T1).
 *
 * Per §15 Phase 5, the map system covers maps, banks/groups, layouts,
 * tilesets, warps, connections, encounter zones, music regions, etc.
 * This detector is the FIRST step (P5-T1): it identifies map-header
 * pointer tables via their structural signature and registers detected
 * maps in coverage + the relationship graph (via builder extension).
 *
 * Subsequent P5 tasks (P5-T2 etc.) layer warps, connections, encounter
 * tables, etc. on top of the maps discovered here.
 *
 * Coverage contribution: each detected MapHeader struct (28 bytes) is
 * registered as `event_data` class at confidence 0.85 (the structural
 * signature is strong - 4 pointer fields + plausible mapType is hard
 * to hit by accident, especially in runs of ≥3).
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  BG_EVENT_STRUCT_SIZE_BYTES,
  COORD_EVENT_STRUCT_SIZE_BYTES,
  MAP_CONNECTIONS_HEADER_SIZE_BYTES,
  MAP_CONNECTION_STRUCT_SIZE_BYTES,
  MAP_EVENTS_STRUCT_SIZE_BYTES,
  MAP_HEADER_SIZE_BYTES,
  MAP_LAYOUT_STRUCT_SIZE_BYTES,
  OBJECT_EVENT_STRUCT_SIZE_BYTES,
  TILESET_STRUCT_SIZE_BYTES,
  WARP_EVENT_STRUCT_SIZE_BYTES,
  WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES,
  aggregateMapProperties,
  findMapGroupsOuterTable,
  parseMapHeader,
  parseConditionalScriptTable,
  parseMapConnections,
  parseMapEvents,
  parseMapLayout,
  parseMapScripts,
  parseTileset,
  scanMapHeaders,
  scanWildEncountersTable,
  totalMapHeaderBytes,
  type ConditionalScriptTable,
  type MapConnectionsParsed,
  type MapEventsParsed,
  type MapGroupsOuterTable,
  type MapHeaderEntry,
  type MapLayout,
  type MapPropertiesHistogram,
  type MapScriptsParsed,
  type MapTableCandidate,
  type TilesetParsed,
  type WildEncountersTable,
} from '../maps/index.js';

export const MAP_SYSTEM_DETECTOR_ID = 'map_system';

export interface MapSystemReport {
  readonly mapTableCount: number;
  readonly totalMapCount: number;
  readonly totalMapHeaderBytes: number;
  /** All identified map-table candidates, ordered by ROM offset. */
  readonly candidates: ReadonlyArray<MapTableCandidate>;
  /** Outer gMapGroups pointer table (if found). When present, gives the
   *  group index of each inner table; warps + connections become
   *  resolvable to specific (group, num) destinations. */
  readonly outerGroupsTable: MapGroupsOuterTable | null;
  /** Per-map enriched info: events struct + warps array + connections
   *  array. Indexed in the SAME order as `candidates[i].maps[j]`. */
  readonly enrichedMaps: ReadonlyArray<EnrichedMap>;
  /** Cross-iteration aggregates for evidence rendering. */
  readonly totalWarpCount: number;
  readonly totalConnectionCount: number;
  readonly totalObjectEventCount: number;
  readonly totalCoordEventCount: number;
  readonly totalBgEventCount: number;
  /** Total MapScript entries across all maps (sentinels excluded). */
  readonly totalMapScriptCount: number;
  /** Total conditional-script stub entries across all maps (P5-T11). */
  readonly totalConditionalScriptCount: number;
  /** P5-T9: histograms over per-map mapHeader byte fields (mapType,
   *  weather, caveOrType, battleType, flagsBits) - built only from
   *  UNIQUE enriched maps (dedup by mapHeaderOffset) so duplicate-
   *  scan candidates don't inflate the counts. */
  readonly mapPropertiesHistogram: MapPropertiesHistogram;
  /** P5-T10: every UNIQUE tileset whose 24-byte header parsed cleanly.
   *  Indexed in file-offset order; deduped vs. shared-tileset references. */
  readonly tilesets: ReadonlyArray<TilesetParsed>;
  /** P5-T12: number of map-header candidate tables BEYOND the primary
   *  one. 0 = standard single-phase ROM. >0 = the cart hosts additional
   *  map-header pointer tables (alternate-phase / postgame variants).
   *  Computed as `max(0, mapTableCount - 1)` - PD 5 honors no baked
   *  assumption that "second table = postgame" semantically; the FLAG
   *  that >1 candidate exists is itself the postgame-variant indicator. */
  readonly alternateMapTableCount: number;
  /** P5-T12: unique non-NULL borderBlocks pointer targets across all
   *  enriched maps. Borders are a shared asset class - typical Gen-3
   *  carts have a small number of distinct border-block layouts shared
   *  across most maps. */
  readonly borderBlockOffsets: ReadonlyArray<number>;
  /** Wild-encounters table (gWildMonHeaders-class). Null if no run of
   *  ≥3 WildPokemonHeader records was found. */
  readonly wildEncountersTable: WildEncountersTable | null;
}

export interface EnrichedMap {
  /** Group index from the outer gMapGroups table. Null when the outer
   *  table wasn't found - warps/connections in this map can't resolve
   *  to a destination map node. */
  readonly groupIndex: number | null;
  /** Map number within the group (= inner-table index). */
  readonly mapNum: number;
  readonly mapHeaderOffset: number;
  readonly events: MapEventsParsed | null;
  readonly connections: MapConnectionsParsed | null;
  readonly layout: MapLayout | null;
  /** Music id from the parsed MapHeader (u16 at offset 0x10). 0 means
   *  no music / MUS_DUMMY; resolution into a gSongTable index is the
   *  graph builder's job (P5-T7 `plays_music` edge). */
  readonly musicId: number;
  /** Parsed MapScripts table, or null if mapScriptsPointer was NULL
   *  or the pointed-to data did not parse as a structurally-valid
   *  packed MapScripts array. */
  readonly mapScripts: MapScriptsParsed | null;
  /** P5-T11: parsed conditional-script sub-tables (one per type-2/4
   *  entry in `mapScripts`). Each `ConditionalScriptTable` carries the
   *  walked MapScriptStub entries. Indexed in the same order as
   *  `mapScripts.entries.filter(e => e.type === 2 || 4)`. */
  readonly conditionalScripts: ReadonlyArray<ConditionalScriptTable>;
  /** mapHeader byte fields (P5-T9). Surfaced here so the graph
   *  builder can label them semantically without re-walking
   *  candidates. */
  readonly mapType: number;
  readonly weather: number;
  readonly caveOrType: number;
  readonly battleType: number;
  /** MapHeader byte 0x18 (pret `allow_cycling`). */
  readonly bikingAllowed: boolean;
  /** MapHeader flags byte 0x19: bit0 allowEscaping, bit1 allowRunning,
   *  bits 2..7 showMapName. */
  readonly flags: number;
  /** MapHeader byte 0x1A (s8 floor number; negative for basements). */
  readonly floorNum: number;
  /** Iter UX-B - region-map section id byte (MapHeader offset 0x14).
   *  Indexes into the universal Gen-3 gRegionMapEntries table; the
   *  region_map_sections_system detector + cross-ref resolves this
   *  byte to a real area name like "PALLET TOWN" / "VIRIDIAN FOREST". */
  readonly regionMapSection: number;
}

interface ResolvedMapGroupStart {
  readonly groupIndex: number;
  readonly innerTableStart: number;
}

interface ResolvedMapIdentity {
  readonly groupIndex: number | null;
  readonly mapNum: number;
}

export const mapSystemDetector: RomDetector<MapSystemReport> = {
  id: MAP_SYSTEM_DETECTOR_ID,
  name: 'Map System (Gen-3 MapHeader scanner)',
  phase: 5,
  detect(rom: RomImage, coverage: CoverageMap): Detection<MapSystemReport> {
    if (rom.byteLength < MAP_HEADER_SIZE_BYTES + 4) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a 28-byte MapHeader + pointer`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 map-header tables',
      });
    }

    const initialCandidates = scanMapHeaders(rom.bytes);

    if (initialCandidates.length === 0) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for Gen-3 MapHeader-shaped pointer tables (structural signature: pointer+pointer+pointer+pointer+u16+u16+u8×4 with mapType ∈ 1..9) - none found`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength, mapHeaderSize: MAP_HEADER_SIZE_BYTES },
          }),
        ],
        reason:
          'No Gen-3 map-header pointer table found - either the ROM is non-Gen-3, the body is synthetic / zero-fill, or it uses a heavily customized engine that has rewritten the MapHeader struct',
      });
    }

    let candidates: ReadonlyArray<MapTableCandidate> = initialCandidates;

    // Register every detected MapHeader struct in coverage as `event_data`.
    for (const candidate of candidates) {
      for (const m of candidate.maps) {
        try {
          coverage.addClassified({
            start: m.mapHeaderOffset,
            end: m.mapHeaderOffset + MAP_HEADER_SIZE_BYTES,
            probableClass: 'event_data',
            score: 0.85,
            provenance: `${MAP_SYSTEM_DETECTOR_ID}#mapHeader-mapLayoutId${String(m.header.mapLayoutId)}`,
            note: `Gen-3 MapHeader (mapType=${String(m.header.mapType)}, layoutId=${String(m.header.mapLayoutId)})`,
          });
        } catch {
          // Overlap with an earlier detector or another map header
          // pointed-at-the-same-offset - both fine, skip.
        }
      }
    }

    // Find the outer gMapGroups table (resolves group index → inner table).
    const outerGroupsTable = findMapGroupsOuterTable(
      rom.bytes,
      initialCandidates.map((c) => ({
        tableStart: c.tableStart,
        tableEndExclusive: c.tableStart + c.mapCount * 4,
      })),
    );
    candidates = supplementMapCandidatesFromOuterGroups(
      rom.bytes,
      initialCandidates,
      outerGroupsTable,
    );
    const totalMapCount = candidates.reduce((acc, c) => acc + c.mapCount, 0);
    const totalBytes = totalMapHeaderBytes(candidates);
    const resolvedGroupStarts = resolveMapGroupStarts(candidates, outerGroupsTable);
    if (outerGroupsTable !== null) {
      // Register the outer table itself as a pointer-network coverage region.
      try {
        coverage.addClassified({
          start: outerGroupsTable.tableStart,
          end:
            outerGroupsTable.tableStart + outerGroupsTable.groups.length * 4,
          probableClass: 'pointer_network',
          score: 0.9,
          provenance: `${MAP_SYSTEM_DETECTOR_ID}#mapGroupsOuterTable`,
          note: `gMapGroups outer pointer table (${String(outerGroupsTable.groups.length)} groups)`,
        });
      } catch {
        // Overlap with another detector - skip silently.
      }
    }

    // Enrich each map with its events + connections structs.
    const enrichedMaps: EnrichedMap[] = [];
    let totalWarpCount = 0;
    let totalConnectionCount = 0;
    let totalObjectEventCount = 0;
    let totalCoordEventCount = 0;
    let totalBgEventCount = 0;
    let totalMapScriptCount = 0;
    let totalConditionalScriptCount = 0;

    for (const candidate of candidates) {
      for (let fallbackMapNum = 0; fallbackMapNum < candidate.maps.length; fallbackMapNum++) {
        const m = candidate.maps[fallbackMapNum]!;
        const resolvedMapIdentity = resolveMapIdentity(
          candidate,
          m.tableEntryOffset,
          fallbackMapNum,
          resolvedGroupStarts,
        );
        const groupIndex = resolvedMapIdentity.groupIndex;
        const mapNum = resolvedMapIdentity.mapNum;
        const header = m.header;
        let events: MapEventsParsed | null = null;
        if (header.eventsOffset !== null) {
          const r = parseMapEvents(rom.bytes, header.eventsOffset);
          if (r.ok) {
            events = r.events;
            totalWarpCount += events.warpCount;
            // Coverage: events struct + warps array.
            try {
              coverage.addClassified({
                start: events.eventsStructOffset,
                end: events.eventsStructOffset + MAP_EVENTS_STRUCT_SIZE_BYTES,
                probableClass: 'event_data',
                score: 0.85,
                provenance: `${MAP_SYSTEM_DETECTOR_ID}#mapEvents-map${String(groupIndex ?? '?')}.${String(mapNum)}`,
                note: `Gen-3 MapEvents (warpCount=${String(events.warpCount)}, objects=${String(events.objectEventCount)})`,
              });
            } catch {
              /* overlap */
            }
            if (events.warpsArrayOffset !== null && events.warpsArrayByteLength > 0) {
              try {
                coverage.addClassified({
                  start: events.warpsArrayOffset,
                  end: events.warpsArrayOffset + events.warpsArrayByteLength,
                  probableClass: 'event_data',
                  score: 0.85,
                  provenance: `${MAP_SYSTEM_DETECTOR_ID}#warpsArray-map${String(groupIndex ?? '?')}.${String(mapNum)}`,
                  note: `Gen-3 WarpEvent[] (${String(events.warpCount)} × ${String(WARP_EVENT_STRUCT_SIZE_BYTES)} bytes)`,
                });
              } catch {
                /* overlap */
              }
            }
            // Register the 3 additional event arrays + count totals.
            totalObjectEventCount += events.objectEventCount;
            totalCoordEventCount += events.coordEventCount;
            totalBgEventCount += events.bgEventCount;
            for (const [arrOff, arrLen, count, elemSize, kindLabel] of [
              [events.objectEventsArrayOffset, events.objectEventsArrayByteLength, events.objectEventCount, OBJECT_EVENT_STRUCT_SIZE_BYTES, 'ObjectEvent'],
              [events.coordEventsArrayOffset, events.coordEventsArrayByteLength, events.coordEventCount, COORD_EVENT_STRUCT_SIZE_BYTES, 'CoordEvent'],
              [events.bgEventsArrayOffset, events.bgEventsArrayByteLength, events.bgEventCount, BG_EVENT_STRUCT_SIZE_BYTES, 'BgEvent'],
            ] as const) {
              if (arrOff !== null && arrLen > 0) {
                try {
                  coverage.addClassified({
                    start: arrOff,
                    end: arrOff + arrLen,
                    probableClass: 'event_data',
                    score: 0.85,
                    provenance: `${MAP_SYSTEM_DETECTOR_ID}#${kindLabel.toLowerCase()}Array-map${String(groupIndex ?? '?')}.${String(mapNum)}`,
                    note: `Gen-3 ${kindLabel}[] (${String(count)} × ${String(elemSize)} bytes)`,
                  });
                } catch {
                  /* overlap */
                }
              }
            }
          }
        }

        let connections: MapConnectionsParsed | null = null;
        if (header.connectionsOffset !== null) {
          const r = parseMapConnections(rom.bytes, header.connectionsOffset);
          if (r.ok) {
            connections = r.connections;
            totalConnectionCount += connections.count;
            try {
              coverage.addClassified({
                start: connections.headerStructOffset,
                end:
                  connections.headerStructOffset + MAP_CONNECTIONS_HEADER_SIZE_BYTES,
                probableClass: 'event_data',
                score: 0.85,
                provenance: `${MAP_SYSTEM_DETECTOR_ID}#mapConnectionsHeader-map${String(groupIndex ?? '?')}.${String(mapNum)}`,
                note: `Gen-3 MapConnections envelope (count=${String(connections.count)})`,
              });
            } catch {
              /* overlap */
            }
            if (connections.connectionsArrayOffset !== null && connections.connectionsArrayByteLength > 0) {
              try {
                coverage.addClassified({
                  start: connections.connectionsArrayOffset,
                  end:
                    connections.connectionsArrayOffset + connections.connectionsArrayByteLength,
                  probableClass: 'event_data',
                  score: 0.85,
                  provenance: `${MAP_SYSTEM_DETECTOR_ID}#mapConnectionsArray-map${String(groupIndex ?? '?')}.${String(mapNum)}`,
                  note: `Gen-3 MapConnection[] (${String(connections.count)} × ${String(MAP_CONNECTION_STRUCT_SIZE_BYTES)} bytes)`,
                });
              } catch {
                /* overlap */
              }
            }
          }
        }

        // Parse the MapLayout struct at header.mapLayoutOffset.
        let layout: MapLayout | null = null;
        if (header.mapLayoutOffset < rom.byteLength) {
          const r = parseMapLayout(rom.bytes, header.mapLayoutOffset);
          if (r.ok) {
            layout = r.layout;
            try {
              coverage.addClassified({
                start: layout.fileOffset,
                end: layout.fileOffset + MAP_LAYOUT_STRUCT_SIZE_BYTES,
                probableClass: 'event_data',
                score: 0.85,
                provenance: `${MAP_SYSTEM_DETECTOR_ID}#mapLayout-map${String(groupIndex ?? '?')}.${String(mapNum)}`,
                note: `Gen-3 MapLayout struct (${String(layout.width)}×${String(layout.height)})`,
              });
            } catch {
              /* overlap */
            }
          }
        }

        // Parse the MapScripts table at header.mapScriptsOffset (if any).
        let mapScripts: MapScriptsParsed | null = null;
        const conditionalScripts: ConditionalScriptTable[] = [];
        if (
          header.mapScriptsOffset !== null &&
          header.mapScriptsOffset < rom.byteLength
        ) {
          const r = parseMapScripts(rom.bytes, header.mapScriptsOffset);
          if (r.ok) {
            mapScripts = r.scripts;
            totalMapScriptCount += r.scripts.entryCount;
            try {
              coverage.addClassified({
                start: r.scripts.tableFileOffset,
                end: r.scripts.tableEndExclusive,
                probableClass: 'event_data',
                score: 0.85,
                provenance: `${MAP_SYSTEM_DETECTOR_ID}#mapScripts-map${String(groupIndex ?? '?')}.${String(mapNum)}`,
                note: `Gen-3 MapScripts (${String(r.scripts.entryCount)} entries + terminator)`,
              });
            } catch {
              /* overlap */
            }
            // P5-T11: for each type-2 (ON_FRAME_TABLE) / type-4
            // (ON_WARP_INTO_MAP_TABLE) entry, walk the conditional-
            // script sub-table at scriptOffset.
            for (const entry of r.scripts.entries) {
              if (entry.type !== 2 && entry.type !== 4) continue;
              if (entry.scriptOffset === null) continue;
              const sub = parseConditionalScriptTable(rom.bytes, entry.scriptOffset);
              if (!sub.ok) continue;
              conditionalScripts.push(sub.table);
              totalConditionalScriptCount += sub.table.entryCount;
              try {
                coverage.addClassified({
                  start: sub.table.tableFileOffset,
                  end: sub.table.tableEndExclusive,
                  probableClass: 'event_data',
                  score: 0.85,
                  provenance: `${MAP_SYSTEM_DETECTOR_ID}#conditionalScripts-map${String(groupIndex ?? '?')}.${String(mapNum)}-${entry.typeName}`,
                  note: `Gen-3 MapScriptStub[] (${String(sub.table.entryCount)} gated scripts + terminator)`,
                });
              } catch {
                /* overlap */
              }
            }
          }
        }

        enrichedMaps.push(
          Object.freeze({
            groupIndex,
            mapNum,
            mapHeaderOffset: m.mapHeaderOffset,
            events,
            connections,
            layout,
            musicId: header.musicId,
            mapScripts,
            conditionalScripts: Object.freeze(conditionalScripts),
            mapType: header.mapType,
            weather: header.weather,
            caveOrType: header.caveOrType,
            battleType: header.battleType,
            bikingAllowed: header.bikingAllowed,
            flags: header.flags,
            floorNum: header.floorNum,
            regionMapSection: header.regionMapSection,
          }),
        );
      }
    }

    // Scan for the wild-encounters table (gWildMonHeaders-class).
    const wildEncountersTable = scanWildEncountersTable(rom.bytes);
    if (wildEncountersTable !== null) {
      // Register each WildPokemonHeader record as event_data coverage.
      for (const h of wildEncountersTable.headers) {
        try {
          coverage.addClassified({
            start: h.fileOffset,
            end: h.fileOffset + WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES,
            probableClass: 'event_data',
            score: 0.85,
            provenance: `${MAP_SYSTEM_DETECTOR_ID}#wildEncounters-${String(h.mapGroup)}.${String(h.mapNum)}`,
            note: `Gen-3 WildPokemonHeader (${[
              h.landMonsOffset !== null ? 'land' : null,
              h.waterMonsOffset !== null ? 'water' : null,
              h.rockSmashMonsOffset !== null ? 'rockSmash' : null,
              h.fishingMonsOffset !== null ? 'fishing' : null,
            ].filter((s) => s !== null).join('+')})`,
          });
        } catch {
          /* overlap */
        }
      }
      // Register the sentinel bytes (if any) as a 20-byte event_data region.
      if (wildEncountersTable.sentinelTerminated) {
        const sentinelStart =
          wildEncountersTable.tableEndExclusive - WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES;
        try {
          coverage.addClassified({
            start: sentinelStart,
            end: wildEncountersTable.tableEndExclusive,
            probableClass: 'event_data',
            score: 0.85,
            provenance: `${MAP_SYSTEM_DETECTOR_ID}#wildEncountersSentinel`,
            note: `Gen-3 WildPokemonHeader sentinel (mapGroup=0xFF terminator)`,
          });
        } catch {
          /* overlap */
        }
      }
    }

    // P5-T9: build mapPropertiesHistogram from UNIQUE enriched maps
    // (dedup by mapHeaderOffset - duplicate scan candidates pointing
    // at the same physical mapHeader would otherwise inflate counts).
    const seenHeaders = new Set<number>();
    const uniqueMapsForHist: Array<{
      mapType: number;
      weather: number;
      caveOrType: number;
      battleType: number;
      flags: number;
      bikingAllowed: boolean;
    }> = [];
    for (const em of enrichedMaps) {
      if (seenHeaders.has(em.mapHeaderOffset)) continue;
      seenHeaders.add(em.mapHeaderOffset);
      uniqueMapsForHist.push({
        mapType: em.mapType,
        weather: em.weather,
        caveOrType: em.caveOrType,
        battleType: em.battleType,
        flags: em.flags,
        bikingAllowed: em.bikingAllowed,
      });
    }
    const mapPropertiesHistogram = aggregateMapProperties(uniqueMapsForHist);

    // P5-T10: parse each unique tileset header. Dedup by file offset
    // - multiple maps share primary tilesets, and primary + secondary
    // may overlap across maps.
    const tilesetOffsets = new Set<number>();
    for (const em of enrichedMaps) {
      if (em.layout === null) continue;
      if (em.layout.primaryTilesetOffset !== null) {
        tilesetOffsets.add(em.layout.primaryTilesetOffset);
      }
      if (em.layout.secondaryTilesetOffset !== null) {
        tilesetOffsets.add(em.layout.secondaryTilesetOffset);
      }
    }
    const tilesets: TilesetParsed[] = [];
    for (const tsOff of Array.from(tilesetOffsets).sort((a, b) => a - b)) {
      const r = parseTileset(rom.bytes, tsOff);
      if (!r.ok) continue;
      tilesets.push(r.tileset);
      try {
        coverage.addClassified({
          start: r.tileset.fileOffset,
          end: r.tileset.fileOffset + TILESET_STRUCT_SIZE_BYTES,
          probableClass: 'graphics',
          score: 0.85,
          provenance: `${MAP_SYSTEM_DETECTOR_ID}#tileset@0x${tsOff.toString(16)}`,
          note: `Gen-3 Tileset header (${r.tileset.isCompressed ? 'compressed' : 'raw'}, ${r.tileset.isSecondary ? 'secondary' : 'primary'})`,
        });
      } catch {
        /* overlap (the existing 16-byte dummy tileset region might overlap) */
      }
    }

    const summary: MapSystemReport = Object.freeze({
      mapTableCount: candidates.length,
      totalMapCount,
      totalMapHeaderBytes: totalBytes,
      candidates: Object.freeze([...candidates]),
      outerGroupsTable,
      enrichedMaps: Object.freeze(enrichedMaps),
      totalWarpCount,
      totalConnectionCount,
      totalObjectEventCount,
      totalCoordEventCount,
      totalBgEventCount,
      totalMapScriptCount,
      totalConditionalScriptCount,
      mapPropertiesHistogram,
      tilesets: Object.freeze(tilesets),
      alternateMapTableCount: Math.max(0, candidates.length - 1),
      borderBlockOffsets: Object.freeze(
        Array.from(
          new Set(
            enrichedMaps
              .map((em) => em.layout?.borderBlocksOffset)
              .filter((o): o is number => o !== null && o !== undefined),
          ),
        ).sort((a, b) => a - b),
      ),
      wildEncountersTable,
    });

    return makeDetected<MapSystemReport>({
      confidence: totalMapCount >= 100 ? 0.95 : totalMapCount >= 10 ? 0.85 : 0.7,
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `identified ${String(candidates.length)} map-header pointer table(s) yielding ${String(totalMapCount)} maps (${String(totalBytes)} bytes of MapHeader structs classified)`,
          weight: 0.7,
          detail: {
            mapTableCount: candidates.length,
            totalMapCount,
            totalMapHeaderBytes: totalBytes,
            topTables: candidates.slice(0, 5).map((c) => ({
              tableStart: c.tableStart,
              mapCount: c.mapCount,
            })),
          },
        }),
        makeEvidence({
          kind: 'pointer_graph',
          summary: `each detected map header verified by structural signature: 4 GBA ROM pointers + 2 u16 ids + mapType ∈ 1..9 + non-0xFFFF padding (false-positive probability per random 28-byte window ≪ 0.01%)`,
          weight: 0.3,
        }),
      ],
      data: summary,
    });
  },
};

function supplementMapCandidatesFromOuterGroups(
  bytes: Uint8Array,
  candidates: ReadonlyArray<MapTableCandidate>,
  outerGroupsTable: MapGroupsOuterTable | null,
): ReadonlyArray<MapTableCandidate> {
  if (outerGroupsTable === null) return candidates;

  const existingTableEntries = new Set<number>();
  for (const candidate of candidates) {
    for (const map of candidate.maps) existingTableEntries.add(map.tableEntryOffset);
  }

  const uniqueStarts = Array.from(
    new Set(
      outerGroupsTable.groups
        .map((group) => group.innerTableStart)
        .filter((start) => start >= 0 && start + 4 <= bytes.length),
    ),
  ).sort((a, b) => a - b);

  const supplemental: MapTableCandidate[] = [];
  for (let i = 0; i < uniqueStarts.length; i++) {
    const tableStart = uniqueStarts[i]!;
    if (candidateContainsTableEntry(candidates, tableStart)) continue;

    const nextStart = uniqueStarts.find((start) => start > tableStart);
    const naturalEnd = nextStart ?? bytes.length;
    const outerBound =
      outerGroupsTable.tableStart > tableStart ? outerGroupsTable.tableStart : naturalEnd;
    const tableEndExclusive = Math.min(naturalEnd, outerBound);
    const maps = parseMapPointerSlice(bytes, tableStart, tableEndExclusive, existingTableEntries);
    if (maps.length === 0) continue;
    for (const map of maps) existingTableEntries.add(map.tableEntryOffset);
    supplemental.push(
      Object.freeze({
        tableStart,
        mapCount: maps.length,
        maps: Object.freeze(maps),
      }),
    );
  }

  if (supplemental.length === 0) return candidates;
  return Object.freeze([...supplemental, ...candidates].sort((a, b) => a.tableStart - b.tableStart));
}

function parseMapPointerSlice(
  bytes: Uint8Array,
  tableStart: number,
  tableEndExclusive: number,
  existingTableEntries: ReadonlySet<number>,
): MapHeaderEntry[] {
  const maps: MapHeaderEntry[] = [];
  const end = Math.min(tableEndExclusive, bytes.length);
  for (let sourceOffset = tableStart; sourceOffset + 4 <= end; sourceOffset += 4) {
    if (existingTableEntries.has(sourceOffset)) continue;
    const targetOffset = readRomPointerTargetOffset(bytes, sourceOffset);
    if (targetOffset === null) break;
    const parsed = parseMapHeader(bytes, targetOffset);
    if (!parsed.ok) break;
    maps.push(
      Object.freeze({
        tableEntryOffset: sourceOffset,
        mapHeaderOffset: targetOffset,
        header: parsed.header,
      }),
    );
  }
  return maps;
}

function resolveMapGroupStarts(
  candidates: ReadonlyArray<MapTableCandidate>,
  outerGroupsTable: MapGroupsOuterTable | null,
): ReadonlyArray<ResolvedMapGroupStart> {
  if (outerGroupsTable === null) return Object.freeze([]);

  const firstGroupForInnerStart = new Map<number, number>();
  for (const group of outerGroupsTable.groups) {
    if (!candidateContainsTableEntry(candidates, group.innerTableStart)) continue;
    if (!firstGroupForInnerStart.has(group.innerTableStart)) {
      firstGroupForInnerStart.set(group.innerTableStart, group.groupIndex);
    }
  }

  return Object.freeze(
    Array.from(firstGroupForInnerStart.entries())
      .map(([innerTableStart, groupIndex]) => ({ groupIndex, innerTableStart }))
      .sort((a, b) => a.innerTableStart - b.innerTableStart),
  );
}

function resolveMapIdentity(
  candidate: MapTableCandidate,
  tableEntryOffset: number,
  fallbackMapNum: number,
  groupStarts: ReadonlyArray<ResolvedMapGroupStart>,
): ResolvedMapIdentity {
  let bestGroup: ResolvedMapGroupStart | null = null;
  const candidateEndExclusive = candidate.tableStart + candidate.mapCount * 4;
  for (const group of groupStarts) {
    if (
      group.innerTableStart < candidate.tableStart ||
      group.innerTableStart >= candidateEndExclusive
    ) {
      continue;
    }
    if (group.innerTableStart > tableEntryOffset) break;
    bestGroup = group;
  }

  if (bestGroup === null) {
    return { groupIndex: null, mapNum: fallbackMapNum };
  }

  const mapNum = (tableEntryOffset - bestGroup.innerTableStart) / 4;
  if (!Number.isInteger(mapNum) || mapNum < 0) {
    return { groupIndex: bestGroup.groupIndex, mapNum: fallbackMapNum };
  }

  return { groupIndex: bestGroup.groupIndex, mapNum };
}

function readRomPointerTargetOffset(bytes: Uint8Array, offset: number): number | null {
  const rawAddress =
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0;
  const targetOffset = rawAddress - 0x08000000;
  if (targetOffset < 0 || targetOffset >= bytes.length) return null;
  return targetOffset;
}

function candidateContainsTableEntry(
  candidates: ReadonlyArray<MapTableCandidate>,
  tableEntryOffset: number,
): boolean {
  return candidates.some(
    (candidate) =>
      tableEntryOffset >= candidate.tableStart &&
      tableEntryOffset < candidate.tableStart + candidate.mapCount * 4,
  );
}
