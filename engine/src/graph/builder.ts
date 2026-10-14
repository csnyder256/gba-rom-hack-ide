/**
 * Build the §15 Phase 4 RelationshipGraph from current detection state.
 *
 * Input: an IngestReport (from Phase 0+) plus an optional FamilyVerdict
 * (from Phase 1's `classifyFamily`). Output: a populated, immutable
 * RelationshipGraph.
 *
 * Skeleton scope for this iteration (P4-T1): populates the nodes / edges
 * that exist NOW, namely:
 *
 *   - `rom_region` nodes for every top-10 pointer-network cross-reference
 *     hotspot (the most-referenced targets in the ROM - they're the
 *     "hot data" Phase 4 needs to expose to later phases).
 *
 *   - `rom_region` nodes for the source-side of each pointer in those
 *     hotspot clusters, with `points_to` edges to the hotspot.
 *
 *   - `signature_match` nodes for every binary-fingerprint signature
 *     match, with edges to the family_verdict node.
 *
 *   - `family_verdict` node carrying the per-ROM family + kind verdict.
 *
 * Phase 5+ detectors will populate map / event / script / NPC / flag /
 * species / encounter_table / music_track / asset nodes via the same
 * `RelationshipGraphBuilder` API - the typed-node-kind enum already
 * includes them.
 *
 * Pure function: deterministic over the input. No I/O.
 */

import { classifyFamily } from '../classify/family.js';
import type { FamilyVerdict } from '../classify/family.js';
import type { IngestReport } from '../ingest/index.js';
import {
  MAP_BATTLE_TYPE_NAMES,
  MAP_CAVE_OR_TYPE_NAMES,
  MAP_TYPE_NAMES,
  MAP_WEATHER_NAMES,
  nameFlagsBits,
  nameFromTable,
} from '../maps/map-properties.js';
import {
  aggregateVariableUsage,
  classifyVariableRole,
  deriveUnlockChains,
  detectVariableAccessSites,
  renderWalkedBody,
  walkScriptBytecode,
  type OpcodeHelperProfile,
  type VariableAccessRecord,
} from '../scripts/index.js';
import { findMapClusters, inferBuildings } from '../world/index.js';
import { RelationshipGraphBuilder, RelationshipGraph } from './graph.js';

/** Cap on hotspot nodes to keep the skeleton graph navigable. */
const TOP_HOTSPOT_NODES = 10;
/** Cap on per-hotspot source nodes (avoid 10k inbound edges per hotspot). */
const MAX_SOURCES_PER_HOTSPOT = 20;

export interface BuildRelationshipGraphArgs {
  readonly report: IngestReport;
  /** Pre-computed family verdict. If omitted, the builder calls
   *  `classifyFamily(report)` internally. */
  readonly verdict?: FamilyVerdict;
  /** Optional raw ROM bytes. When provided, the builder can perform
   *  byte-level analysis (P6-T4 script bytecode walking) that needs
   *  to read past the offsets already in detection.data. Omitted
   *  when callers don't need this. */
  readonly romBytes?: Uint8Array;
}

export function buildRelationshipGraph(args: BuildRelationshipGraphArgs): RelationshipGraph {
  const builder = new RelationshipGraphBuilder();
  const verdict = args.verdict ?? classifyFamily(args.report);
  const provenance = `graph_builder#iter${String(Date.now())}`;

  // 1) Family verdict node.
  const verdictId = `family_verdict:${args.report.rom.sha1}`;
  builder.addNode({
    id: verdictId,
    kind: 'family_verdict',
    label: verdict.displayName,
    provenance,
    detail: {
      family: verdict.family,
      kind: verdict.kind,
      confidence: verdict.confidence,
      primarySignal: verdict.primarySignal,
      rationale: verdict.rationale,
    },
  });

  // 2) Signature_match nodes + classifies_as edges.
  const binaryFingerprintRow = args.report.detections.find(
    (d) => d.detectorId === 'binary_fingerprint',
  );
  if (
    binaryFingerprintRow !== undefined &&
    (binaryFingerprintRow.detection.status === 'detected' ||
      binaryFingerprintRow.detection.status === 'partial')
  ) {
    const data = binaryFingerprintRow.detection.data as
      | { signatureMatches?: ReadonlyArray<{ entry: { id: string; family: string; displayName: string; kind: string; opcodeNames?: ReadonlyArray<string> }; confidence: number }> }
      | undefined;
    const matches = data?.signatureMatches ?? [];
    for (const m of matches) {
      const sigId = `signature_match:${m.entry.id}`;
      builder.addNode({
        id: sigId,
        kind: 'signature_match',
        label: m.entry.displayName,
        provenance,
        detail: {
          signatureId: m.entry.id,
          family: m.entry.family,
          signatureKind: m.entry.kind,
          scaledConfidence: m.confidence,
        },
      });
      builder.addEdge({
        id: `classifies_as:${sigId}->${verdictId}`,
        from: sigId,
        to: verdictId,
        kind: 'classifies_as',
        confidence: m.confidence,
        provenance,
        detail: { matchedSignatureId: m.entry.id },
      });
    }
  }

  // 2.5) Map nodes + warp/connection edges from the Phase-5 map-system detector.
  const mapSystemRow = args.report.detections.find((d) => d.detectorId === 'map_system');
  if (mapSystemRow !== undefined && mapSystemRow.detection.status === 'detected') {
    type EnrichedMap = {
      groupIndex: number | null;
      mapNum: number;
      mapHeaderOffset: number;
      events: {
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
          trainerType: number;
          flagId: number;
          scriptOffset: number | null;
          fileOffset: number;
        }>;
      } | null;
      connections: {
        connections: ReadonlyArray<{
          direction: number;
          destMapGroup: number;
          destMapNum: number;
        }>;
      } | null;
      layout: {
        width: number;
        height: number;
        borderBlocksOffset: number | null;
        primaryTilesetOffset: number | null;
        secondaryTilesetOffset: number | null;
        fileOffset: number;
      } | null;
      mapScripts: {
        tableFileOffset: number;
        tableEndExclusive: number;
        entryCount: number;
        entries: ReadonlyArray<{
          type: number;
          typeName: string;
          scriptOffset: number | null;
          rawScriptAddress: number;
          entryFileOffset: number;
        }>;
      } | null;
      conditionalScripts: ReadonlyArray<{
        tableFileOffset: number;
        tableEndExclusive: number;
        entryCount: number;
        entries: ReadonlyArray<{
          varCheck: number;
          valueCheck: number;
          scriptOffset: number | null;
          rawScriptAddress: number;
          entryFileOffset: number;
        }>;
      }>;
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
    };
    const data = mapSystemRow.detection.data as
      | {
          candidates: ReadonlyArray<{
            tableStart: number;
            mapCount: number;
            maps: ReadonlyArray<{
              tableEntryOffset: number;
              mapHeaderOffset: number;
              header: { mapType: number; mapLayoutId: number; musicId: number };
            }>;
          }>;
          enrichedMaps: ReadonlyArray<EnrichedMap>;
          wildEncountersTable: {
            tableStart: number;
            tableEndExclusive: number;
            headerCount: number;
            headers: ReadonlyArray<{
              mapGroup: number;
              mapNum: number;
              landMonsOffset: number | null;
              waterMonsOffset: number | null;
              rockSmashMonsOffset: number | null;
              fishingMonsOffset: number | null;
              fileOffset: number;
            }>;
          } | null;
          tilesets: ReadonlyArray<{
            isCompressed: boolean;
            isSecondary: boolean;
            tilesOffset: number | null;
            palettesOffset: number | null;
            metatilesOffset: number | null;
            slot10Offset: number | null;
            slot14Offset: number | null;
            fileOffset: number;
          }>;
        }
      | undefined;
    const candidates = data?.candidates ?? [];
    const enrichedMaps = data?.enrichedMaps ?? [];
    const tilesetByOffset = new Map<number, NonNullable<typeof data>['tilesets'][number]>();
    for (const t of data?.tilesets ?? []) tilesetByOffset.set(t.fileOffset, t);

    // (groupIndex, mapNum) → mapHeaderOffset, for resolving warp/connection destinations.
    const destinationIndex = new Map<string, number>();
    for (const em of enrichedMaps) {
      if (em.groupIndex !== null) {
        destinationIndex.set(`${String(em.groupIndex)}.${String(em.mapNum)}`, em.mapHeaderOffset);
      }
    }
    // mapHeaderOffset → EnrichedMap, for surfacing P5-T9 byte-field
    // semantics on map nodes. Multiple enriched maps can share the
    // same mapHeaderOffset (outer-table-with-dups) - first occurrence
    // wins; they all carry identical mapHeader bytes anyway.
    const enrichedByHeader = new Map<number, (typeof enrichedMaps)[number]>();
    for (const em of enrichedMaps) {
      if (!enrichedByHeader.has(em.mapHeaderOffset)) {
        enrichedByHeader.set(em.mapHeaderOffset, em);
      }
    }
    const mapIdFor = (mapHeaderOffset: number): string =>
      `map:0x${mapHeaderOffset.toString(16).toUpperCase().padStart(8, '0')}`;

    // Add all map nodes first so subsequent edges have endpoints.
    for (const c of candidates) {
      for (const m of c.maps) {
        const mapId = mapIdFor(m.mapHeaderOffset);
        const enriched = enrichedByHeader.get(m.mapHeaderOffset);
        const weather = enriched?.weather ?? 0;
        const caveOrType = enriched?.caveOrType ?? 0;
        const battleType = enriched?.battleType ?? 0;
        const bikingAllowed = enriched?.bikingAllowed ?? false;
        const flags = enriched?.flags ?? 0;
        const floorNum = enriched?.floorNum ?? 0;
        builder.addNode({
          id: mapId,
          kind: 'map',
          label: `map@${mapId.slice('map:'.length)} (type=${nameFromTable(MAP_TYPE_NAMES, m.header.mapType)}, weather=${nameFromTable(MAP_WEATHER_NAMES, weather)}, layoutId=${String(m.header.mapLayoutId)})`,
          provenance,
          detail: {
            mapHeaderOffset: m.mapHeaderOffset,
            mapType: m.header.mapType,
            mapTypeName: nameFromTable(MAP_TYPE_NAMES, m.header.mapType),
            mapLayoutId: m.header.mapLayoutId,
            musicId: m.header.musicId,
            weather,
            weatherName: nameFromTable(MAP_WEATHER_NAMES, weather),
            caveOrType,
            caveOrTypeName: nameFromTable(MAP_CAVE_OR_TYPE_NAMES, caveOrType),
            battleType,
            battleTypeName: nameFromTable(MAP_BATTLE_TYPE_NAMES, battleType),
            bikingAllowed,
            flags,
            flagsBitsSet: nameFlagsBits(flags),
            floorNum,
            tableStart: c.tableStart,
          },
        });
      }
    }

    // Now add warp + connection edges for each enriched map.
    for (const em of enrichedMaps) {
      const sourceMapId = mapIdFor(em.mapHeaderOffset);

      if (em.events !== null) {
        for (const w of em.events.warps) {
          // Add a `warp` typed node carrying the warp's (x,y, destGroup,
          // destNum, warpId) - useful for the Phase 12 UI to render
          // every warp point on the map canvas.
          const warpId = `warp:0x${w.fileOffset.toString(16).toUpperCase().padStart(8, '0')}`;
          builder.addNode({
            id: warpId,
            kind: 'warp',
            label: `warp@${warpId.slice('warp:'.length)} (${String(w.x)},${String(w.y)} → group ${String(w.destMapGroup)}, num ${String(w.destMapNum)})`,
            provenance,
            detail: {
              x: w.x,
              y: w.y,
              elevation: w.elevation,
              warpId: w.warpId,
              destMapGroup: w.destMapGroup,
              destMapNum: w.destMapNum,
            },
          });
          // Source map → warp node (has_event-style - reuse 'has_event'
          // typed edge for any in-map interactive element).
          builder.addEdge({
            id: `has_event:${sourceMapId}->${warpId}`,
            from: sourceMapId,
            to: warpId,
            kind: 'has_event',
            confidence: 0.9,
            provenance,
            detail: { eventType: 'warp', x: w.x, y: w.y },
          });
          // Warp → destination map IF resolvable via the outer-table index.
          const destKey = `${String(w.destMapGroup)}.${String(w.destMapNum)}`;
          const destOffset = destinationIndex.get(destKey);
          if (destOffset !== undefined) {
            const destMapId = mapIdFor(destOffset);
            builder.addEdge({
              id: `warp_to:${warpId}->${destMapId}`,
              from: warpId,
              to: destMapId,
              kind: 'warp_to',
              confidence: 0.85,
              provenance,
              detail: { destMapGroup: w.destMapGroup, destMapNum: w.destMapNum },
            });
          }
        }

        // Object events → `npc` typed nodes + has_event edges. Each ObjectEvent
        // is a script/sprite carrying movement type, trainer info, flag id.
        for (const obj of em.events.objectEvents) {
          const npcId = `npc:0x${obj.fileOffset.toString(16).toUpperCase().padStart(8, '0')}`;
          builder.addNode({
            id: npcId,
            kind: 'npc',
            label: `npc@${npcId.slice('npc:'.length)} (gfx=${String(obj.graphicsId)}, mov=${String(obj.movementType)}, ${String(obj.x)},${String(obj.y)})`,
            provenance,
            detail: {
              localId: obj.localId,
              graphicsId: obj.graphicsId,
              x: obj.x,
              y: obj.y,
              elevation: obj.elevation,
              movementType: obj.movementType,
              trainerType: obj.trainerType,
              flagId: obj.flagId,
              scriptOffset: obj.scriptOffset,
            },
          });
          builder.addEdge({
            id: `has_event:${sourceMapId}->${npcId}`,
            from: sourceMapId,
            to: npcId,
            kind: 'has_event',
            confidence: 0.9,
            provenance,
            detail: { eventType: 'object', graphicsId: obj.graphicsId },
          });
        }
      }

      if (em.connections !== null) {
        for (const c of em.connections.connections) {
          const destKey = `${String(c.destMapGroup)}.${String(c.destMapNum)}`;
          const destOffset = destinationIndex.get(destKey);
          if (destOffset !== undefined) {
            const destMapId = mapIdFor(destOffset);
            builder.addEdge({
              id: `connects_to:${sourceMapId}->${destMapId}.dir${String(c.direction)}`,
              from: sourceMapId,
              to: destMapId,
              kind: 'connects_to',
              confidence: 0.9,
              provenance,
              detail: { direction: c.direction, destMapGroup: c.destMapGroup, destMapNum: c.destMapNum },
            });
          }
        }
      }

      // Tilesets → asset nodes + uses_asset edges. Deduped by tileset
      // offset (multiple maps share the same primary tileset). Tileset
      // header detail (isCompressed/isSecondary + 5 pointer slots) is
      // enriched from the map-system detector's tilesets[] (P5-T10).
      if (em.layout !== null) {
        for (const [role, offset] of [
          ['primary', em.layout.primaryTilesetOffset],
          ['secondary', em.layout.secondaryTilesetOffset],
        ] as const) {
          if (offset === null) continue;
          const assetId = `asset:tileset:0x${offset.toString(16).toUpperCase().padStart(8, '0')}`;
          const ts = tilesetByOffset.get(offset);
          const labelTags: string[] = [];
          if (ts) {
            if (ts.isCompressed) labelTags.push('compressed');
            labelTags.push(ts.isSecondary ? 'secondary' : 'primary');
          } else {
            labelTags.push('unparsed');
          }
          builder.addNode({
            id: assetId,
            kind: 'asset',
            label: `tileset@${assetId.slice('asset:tileset:'.length)} [${labelTags.join(',')}]`,
            provenance,
            detail: {
              assetType: 'tileset',
              role,
              offset,
              ...(ts
                ? {
                    isCompressed: ts.isCompressed,
                    isSecondary: ts.isSecondary,
                    tilesOffset: ts.tilesOffset,
                    palettesOffset: ts.palettesOffset,
                    metatilesOffset: ts.metatilesOffset,
                    slot10Offset: ts.slot10Offset,
                    slot14Offset: ts.slot14Offset,
                  }
                : {}),
            },
          });
          builder.addEdge({
            id: `uses_asset:${sourceMapId}->${assetId}.${role}`,
            from: sourceMapId,
            to: assetId,
            kind: 'uses_asset',
            confidence: 0.9,
            provenance,
            detail: { role, assetType: 'tileset' },
          });
        }

        // P5-T12: borderBlocks → asset node + uses_asset edge.
        // Borders are a shared asset class (multiple maps reference the
        // same border layout); dedup by offset via addNode idempotence.
        if (em.layout.borderBlocksOffset !== null) {
          const borderOffset = em.layout.borderBlocksOffset;
          const borderAssetId = `asset:borderBlocks:0x${borderOffset.toString(16).toUpperCase().padStart(8, '0')}`;
          builder.addNode({
            id: borderAssetId,
            kind: 'asset',
            label: `borderBlocks@${borderAssetId.slice('asset:borderBlocks:'.length)}`,
            provenance,
            detail: { assetType: 'borderBlocks', offset: borderOffset },
          });
          builder.addEdge({
            id: `uses_asset:${sourceMapId}->${borderAssetId}.border`,
            from: sourceMapId,
            to: borderAssetId,
            kind: 'uses_asset',
            confidence: 0.9,
            provenance,
            detail: { role: 'border', assetType: 'borderBlocks' },
          });
        }
      }

      // P5-T8: MapScripts entries → `script` typed nodes + `script_triggers`
      // edges from the map to each script. NULL script pointers (legal in
      // some hacks / placeholder entries) get a node anchored at their
      // entryFileOffset (the entry exists structurally even if its target
      // is unset); typical hacks always populate.
      if (em.mapScripts !== null) {
        for (const entry of em.mapScripts.entries) {
          const scriptKey =
            entry.scriptOffset !== null
              ? entry.scriptOffset
              : entry.entryFileOffset; // anchor NULL-target entries by location
          const scriptId = `script:0x${scriptKey.toString(16).toUpperCase().padStart(8, '0')}`;
          builder.addNode({
            id: scriptId,
            kind: 'script',
            label: `script@${scriptId.slice('script:'.length)} (${entry.typeName})`,
            provenance,
            detail: {
              type: entry.type,
              typeName: entry.typeName,
              scriptOffset: entry.scriptOffset,
              rawScriptAddress: entry.rawScriptAddress,
              entryFileOffset: entry.entryFileOffset,
            },
          });
          builder.addEdge({
            id: `script_triggers:${sourceMapId}->${scriptId}.${entry.typeName}.${String(entry.entryFileOffset)}`,
            from: sourceMapId,
            to: scriptId,
            kind: 'script_triggers',
            confidence: 0.9,
            provenance,
            detail: {
              type: entry.type,
              typeName: entry.typeName,
              entryFileOffset: entry.entryFileOffset,
            },
          });
        }
      }

      // P5-T11: conditional-script sub-table stubs → `script` typed
      // nodes (gated) + `script_triggers` edge from map (with varCheck/
      // valueCheck on the edge detail so consumers can tell which gate
      // applies) + `variable` typed node per unique varCheck + `gates_on`
      // edge from script → variable. `variable` is §15 Phase 7 scope
      // semantically (naming) but the STRUCTURAL variable shape exists
      // now; emitting nodes here lays the foundation Phase 7 names.
      for (const subTable of em.conditionalScripts) {
        for (const stub of subTable.entries) {
          const scriptKey =
            stub.scriptOffset !== null ? stub.scriptOffset : stub.entryFileOffset;
          const scriptId = `script:0x${scriptKey.toString(16).toUpperCase().padStart(8, '0')}.gated`;
          builder.addNode({
            id: scriptId,
            kind: 'script',
            label: `script@${scriptId.slice('script:'.length, scriptId.lastIndexOf('.'))} (gated var=0x${stub.varCheck.toString(16)}==${String(stub.valueCheck)})`,
            provenance,
            detail: {
              gated: true,
              varCheck: stub.varCheck,
              valueCheck: stub.valueCheck,
              scriptOffset: stub.scriptOffset,
              rawScriptAddress: stub.rawScriptAddress,
              entryFileOffset: stub.entryFileOffset,
            },
          });
          builder.addEdge({
            id: `script_triggers:${sourceMapId}->${scriptId}.gated.${String(stub.entryFileOffset)}`,
            from: sourceMapId,
            to: scriptId,
            kind: 'script_triggers',
            confidence: 0.85,
            provenance,
            detail: {
              gated: true,
              varCheck: stub.varCheck,
              valueCheck: stub.valueCheck,
              entryFileOffset: stub.entryFileOffset,
            },
          });
          // `variable` node - anchored by the varCheck u16. Multiple
          // gates on the same var share the node (addNode is idempotent).
          const variableId = `variable:0x${stub.varCheck.toString(16).toUpperCase().padStart(4, '0')}`;
          builder.addNode({
            id: variableId,
            kind: 'variable',
            label: `variable@var=0x${stub.varCheck.toString(16)} (structural)`,
            provenance,
            detail: { varId: stub.varCheck },
          });
          builder.addEdge({
            id: `gates_on:${scriptId}->${variableId}.${String(stub.valueCheck)}`,
            from: scriptId,
            to: variableId,
            kind: 'gates_on',
            confidence: 0.9,
            provenance,
            detail: { valueCheck: stub.valueCheck },
          });
        }
      }
    }
  }

  // 3) Pointer-network hotspot rom_region nodes + points_to edges.
  const pointerRow = args.report.detections.find((d) => d.detectorId === 'pointer_network');
  if (pointerRow !== undefined && pointerRow.detection.status === 'detected') {
    const data = pointerRow.detection.data as
      | {
          topHotspots: ReadonlyArray<{
            targetOffset: number;
            referenceCount: number;
            sources: ReadonlyArray<{ sourceOffset: number; targetOffset: number; rawAddress: number }>;
          }>;
        }
      | undefined;
    const hotspots = (data?.topHotspots ?? []).slice(0, TOP_HOTSPOT_NODES);
    for (const h of hotspots) {
      const targetId = `rom_region:0x${h.targetOffset.toString(16).toUpperCase().padStart(8, '0')}`;
      builder.addNode({
        id: targetId,
        kind: 'rom_region',
        label: `pointer-target @ ${targetId.slice('rom_region:'.length)} (refs=${String(h.referenceCount)})`,
        provenance,
        detail: { targetOffset: h.targetOffset, referenceCount: h.referenceCount },
      });

      const sourceSlice = h.sources.slice(0, MAX_SOURCES_PER_HOTSPOT);
      for (const s of sourceSlice) {
        const sourceId = `rom_region:0x${s.sourceOffset.toString(16).toUpperCase().padStart(8, '0')}`;
        // addNode is idempotent on collision - multiple pointers from the
        // same source offset get a single node.
        builder.addNode({
          id: sourceId,
          kind: 'rom_region',
          label: `pointer-source @ ${sourceId.slice('rom_region:'.length)}`,
          provenance,
          detail: { sourceOffset: s.sourceOffset },
        });
        builder.addEdge({
          id: `points_to:${sourceId}->${targetId}`,
          from: sourceId,
          to: targetId,
          kind: 'points_to',
          confidence: 0.95, // pointer was structurally verified by Phase 2
          provenance,
          detail: { rawAddress: s.rawAddress },
        });
      }
    }
  }

  // 3.25) Phase-6 P6-T1: script-engine opcode table. The detector
  // structurally discovered `gScriptCmdTable`; emit one `rom_region`
  // node anchoring the table location + carrying opcodeCount in detail.
  // Per-handler nodes are deferred to later P6 tasks (handler-function
  // classification + bytecode argument-pattern inference).
  const scriptEngineRow = args.report.detections.find(
    (d) => d.detectorId === 'script_engine',
  );
  if (scriptEngineRow !== undefined && scriptEngineRow.detection.status === 'detected') {
    const data = scriptEngineRow.detection.data as
      | {
          opcodeTable: {
            tableStart: number;
            tableEndExclusive: number;
            opcodeCount: number;
            anyThumbTaggedPointer: boolean;
            handlerOffsets: ReadonlyArray<number>;
          };
          commonHelperFunctions: ReadonlyArray<{
            offset: number;
            callCount: number;
            callerCount: number;
          }>;
          helperCallHistogram: Readonly<Record<string, number>>;
          opcodeHelperCallProfiles: ReadonlyArray<OpcodeHelperProfile>;
        }
      | undefined;
    const opcodeTable = data?.opcodeTable;
    if (opcodeTable !== undefined) {
      const tableId = `rom_region:script_opcode_table:0x${opcodeTable.tableStart.toString(16).toUpperCase().padStart(8, '0')}`;
      builder.addNode({
        id: tableId,
        kind: 'rom_region',
        label: `gScriptCmdTable@${tableId.slice('rom_region:script_opcode_table:'.length)} (${String(opcodeTable.opcodeCount)} opcodes)`,
        provenance,
        detail: {
          regionKind: 'script_opcode_table',
          tableStart: opcodeTable.tableStart,
          tableEndExclusive: opcodeTable.tableEndExclusive,
          opcodeCount: opcodeTable.opcodeCount,
          anyThumbTaggedPointer: opcodeTable.anyThumbTaggedPointer,
          helperCallHistogram: data?.helperCallHistogram ?? {},
        },
      });
    }
    // P6-T2: emit top-3 common helper functions as rom_region nodes.
    // These are very likely ScriptReadByte/Halfword/Word (the engine's
    // argument-reading helpers) - naming them in subsequent P6 tasks
    // will let us infer per-opcode argcounts.
    const topHelpers = (data?.commonHelperFunctions ?? []).slice(0, 3);
    for (const h of topHelpers) {
      const helperId = `rom_region:script_helper:0x${h.offset.toString(16).toUpperCase().padStart(8, '0')}`;
      builder.addNode({
        id: helperId,
        kind: 'rom_region',
        label: `script_helper@${helperId.slice('rom_region:script_helper:'.length)} (${String(h.callCount)} calls from ${String(h.callerCount)} handlers)`,
        provenance,
        detail: {
          regionKind: 'script_helper',
          offset: h.offset,
          callCount: h.callCount,
          callerCount: h.callerCount,
        },
      });
    }

    // P6-T4: walk script bytecode bodies from every entrypoint
    // discovered in Phase 5. Currently uses conditional-script stub
    // targets (P5-T11) as entrypoints - the most reliably-pointed-to
    // script bodies in the smoke fixture. Each walked body becomes
    // a `rom_region:script_body:0x<offset>` node carrying the opcode
    // sequence in detail; subsequent P6 tasks (decompile rendering /
    // AST) consume this. Only walks when raw ROM bytes are supplied
    // (the walker needs to read past detection.data offsets).
    const profiles = data?.opcodeHelperCallProfiles as
      | ReadonlyArray<OpcodeHelperProfile>
      | undefined;
    if (
      profiles !== undefined &&
      profiles.length > 0 &&
      args.romBytes !== undefined &&
      mapSystemRow !== undefined &&
      mapSystemRow.detection.status === 'detected'
    ) {
      const mapData = mapSystemRow.detection.data as
        | {
            enrichedMaps: ReadonlyArray<{
              conditionalScripts: ReadonlyArray<{
                entries: ReadonlyArray<{
                  scriptOffset: number | null;
                  varCheck: number;
                  valueCheck: number;
                }>;
              }>;
            }>;
          }
        | undefined;
      // Collect every unique non-null conditional-script stub target.
      const entrypoints = new Set<number>();
      for (const em of mapData?.enrichedMaps ?? []) {
        for (const sub of em.conditionalScripts) {
          for (const entry of sub.entries) {
            if (entry.scriptOffset !== null) entrypoints.add(entry.scriptOffset);
          }
        }
      }
      // P6-T6: find the highest-confidence binary-fingerprint signature
      // that carries opcodeNames; use those for semantic decompile names.
      // Falls back to op_<index> when no signature provides names.
      let opcodeNames: ReadonlyArray<string | undefined> | undefined;
      let opcodeNamesSource: string | null = null;
      if (
        binaryFingerprintRow !== undefined &&
        (binaryFingerprintRow.detection.status === 'detected' ||
          binaryFingerprintRow.detection.status === 'partial')
      ) {
        const bfData = binaryFingerprintRow.detection.data as
          | { signatureMatches?: ReadonlyArray<{ entry: { id: string; opcodeNames?: ReadonlyArray<string> }; confidence: number }> }
          | undefined;
        const matchesWithNames = (bfData?.signatureMatches ?? [])
          .filter((m) => m.entry.opcodeNames !== undefined && m.entry.opcodeNames.length > 0)
          .slice()
          .sort((a, b) => b.confidence - a.confidence);
        if (matchesWithNames.length > 0) {
          opcodeNames = matchesWithNames[0]!.entry.opcodeNames;
          opcodeNamesSource = matchesWithNames[0]!.entry.id;
        }
      }
      const sortedEntrypoints = Array.from(entrypoints).sort((a, b) => a - b);
      for (const entrypoint of sortedEntrypoints) {
        const walked = walkScriptBytecode(args.romBytes, entrypoint, profiles);
        const bodyId = `rom_region:script_body:0x${entrypoint.toString(16).toUpperCase().padStart(8, '0')}`;
        const decompile = renderWalkedBody(
          walked,
          opcodeNames !== undefined ? { opcodeNames } : undefined,
        );
        builder.addNode({
          id: bodyId,
          kind: 'rom_region',
          label: `script_body@${bodyId.slice('rom_region:script_body:'.length)} (${String(walked.opcodes.length)} opcodes, stopped: ${walked.stoppedReason})`,
          provenance,
          detail: {
            regionKind: 'script_body',
            startOffset: walked.startOffset,
            endOffset: walked.endOffset,
            opcodeCount: walked.opcodes.length,
            stoppedReason: walked.stoppedReason,
            opcodeIndices: walked.opcodes.map((o) => o.opcodeIndex),
            decompile,
            opcodeNamesSource,
          },
        });
        // P7-T1: detect variable read/write sites within this body.
        // Requires opcodeNames (without semantic names we can't
        // classify); skip cleanly when names absent.
        if (opcodeNames !== undefined) {
          const accessSites = detectVariableAccessSites(walked, opcodeNames);
          for (const site of accessSites) {
            if (site.variableId === null) continue; // skip when argbytes missing
            const variableId = `variable:0x${site.variableId.toString(16).toUpperCase().padStart(4, '0')}`;
            // Ensure variable node exists (may already from P5-T11 gating).
            builder.addNode({
              id: variableId,
              kind: 'variable',
              label: `variable@var=0x${site.variableId.toString(16)} (structural)`,
              provenance,
              detail: { varId: site.variableId },
            });
            builder.addEdge({
              id: `${site.accessKind}:${bodyId}->${variableId}.${String(site.opcodeOffset)}`,
              from: bodyId,
              to: variableId,
              kind: site.accessKind,
              confidence: 0.9,
              provenance,
              detail: {
                opcodeOffset: site.opcodeOffset,
                opcodeName: site.opcodeName,
                opcodeIndex: site.opcodeIndex,
              },
            });
          }
        }
      }
    }
  }

  // 3.5) Phase-5 P5-T6: wild-encounter zones. The map-system detector
  // walks `gWildMonHeaders` (a flat WildPokemonHeader[] terminated by
  // a sentinel). Each header carries (mapGroup, mapNum) - resolve to
  // a `map` node via the existing destinationIndex; emit an
  // `encounter_table` typed node + `encounters_in` edge into the map.
  if (mapSystemRow !== undefined && mapSystemRow.detection.status === 'detected') {
    const data2 = mapSystemRow.detection.data as
      | {
          enrichedMaps: ReadonlyArray<{
            groupIndex: number | null;
            mapNum: number;
            mapHeaderOffset: number;
          }>;
          wildEncountersTable: {
            headers: ReadonlyArray<{
              mapGroup: number;
              mapNum: number;
              landMonsOffset: number | null;
              waterMonsOffset: number | null;
              rockSmashMonsOffset: number | null;
              fishingMonsOffset: number | null;
              fileOffset: number;
            }>;
          } | null;
        }
      | undefined;
    const wildEncountersTable = data2?.wildEncountersTable ?? null;
    const enrichedMapsLocal = data2?.enrichedMaps ?? [];
    if (wildEncountersTable !== null) {
      // Re-derive destinationIndex from the report's enrichedMaps.
      const destIndexLocal = new Map<string, number>();
      for (const em of enrichedMapsLocal) {
        if (em.groupIndex !== null) {
          destIndexLocal.set(`${String(em.groupIndex)}.${String(em.mapNum)}`, em.mapHeaderOffset);
        }
      }
      const mapIdForLocal = (mapHeaderOffset: number): string =>
        `map:0x${mapHeaderOffset.toString(16).toUpperCase().padStart(8, '0')}`;
      for (const h of wildEncountersTable.headers) {
        const encounterId = `encounter_table:0x${h.fileOffset.toString(16).toUpperCase().padStart(8, '0')}`;
        const populatedKinds = [
          h.landMonsOffset !== null ? 'land' : null,
          h.waterMonsOffset !== null ? 'water' : null,
          h.rockSmashMonsOffset !== null ? 'rockSmash' : null,
          h.fishingMonsOffset !== null ? 'fishing' : null,
        ].filter((s): s is string => s !== null);
        builder.addNode({
          id: encounterId,
          kind: 'encounter_table',
          label: `encounters@${encounterId.slice('encounter_table:'.length)} (group ${String(h.mapGroup)}, num ${String(h.mapNum)}, kinds=${populatedKinds.join('+')})`,
          provenance,
          detail: {
            mapGroup: h.mapGroup,
            mapNum: h.mapNum,
            populatedKinds,
            landMonsOffset: h.landMonsOffset,
            waterMonsOffset: h.waterMonsOffset,
            rockSmashMonsOffset: h.rockSmashMonsOffset,
            fishingMonsOffset: h.fishingMonsOffset,
          },
        });
        const destKey = `${String(h.mapGroup)}.${String(h.mapNum)}`;
        const destOffset = destIndexLocal.get(destKey);
        if (destOffset !== undefined) {
          const destMapId = mapIdForLocal(destOffset);
          builder.addEdge({
            id: `encounters_in:${encounterId}->${destMapId}`,
            from: encounterId,
            to: destMapId,
            kind: 'encounters_in',
            confidence: 0.9,
            provenance,
            detail: { mapGroup: h.mapGroup, mapNum: h.mapNum, populatedKinds },
          });
        }
      }
    }
  }

  // 3.6) Phase-5 P5-T7: audio system / music regions. The audio-system
  // detector finds the gSongTable structurally; the map-system detector
  // surfaces each map's mapHeader.musicId. We emit a `music_track` node
  // per song-table entry index and a `plays_music` edge from each map
  // whose musicId references that entry.
  const audioSystemRow = args.report.detections.find(
    (d) => d.detectorId === 'audio_system',
  );
  if (
    audioSystemRow !== undefined &&
    audioSystemRow.detection.status === 'detected' &&
    mapSystemRow !== undefined &&
    mapSystemRow.detection.status === 'detected'
  ) {
    const audioData = audioSystemRow.detection.data as
      | {
          songTable: {
            tableStart: number;
            entries: ReadonlyArray<{
              index: number;
              entryFileOffset: number;
              ms: number;
              me: number;
              header: {
                fileOffset: number;
                trackCount: number;
                blockCount: number;
                priority: number;
                reverb: number;
                voiceGroupOffset: number;
                trackOffsets: ReadonlyArray<number>;
                byteLength: number;
              };
            }>;
          };
        }
      | undefined;
    const mapData = mapSystemRow.detection.data as
      | {
          enrichedMaps: ReadonlyArray<{
            groupIndex: number | null;
            mapNum: number;
            mapHeaderOffset: number;
            musicId: number;
          }>;
        }
      | undefined;
    const songTable = audioData?.songTable;
    const enrichedMapsAudio = mapData?.enrichedMaps ?? [];
    if (songTable !== undefined) {
      const songIdByIndex = new Map<number, string>();
      // Phase-9 P9-T1: dedup voice-group assets across songs. In real
      // Gen-3 ROMs (and the smoke fixture) multiple songs share the
      // same voice group (instrument bank), so the asset node should
      // be a single shared graph node with N incoming `uses_asset`
      // edges - naturally reflecting the dependency relationship.
      const voiceGroupAssetIds = new Set<string>();
      for (const entry of songTable.entries) {
        const songId = `music_track:song_${String(entry.index)}@0x${entry.header.fileOffset.toString(16).toUpperCase().padStart(8, '0')}`;
        songIdByIndex.set(entry.index, songId);
        builder.addNode({
          id: songId,
          kind: 'music_track',
          label: `song[${String(entry.index)}] (trackCount=${String(entry.header.trackCount)}, ms=${String(entry.ms)})`,
          provenance,
          detail: {
            songIndex: entry.index,
            tableEntryFileOffset: entry.entryFileOffset,
            headerFileOffset: entry.header.fileOffset,
            // Phase-9 P9-T1: full SongHeader detail surfaced for the
            // Phase-12 music editor (was just trackCount/voiceGroup
            // /ms/me before). blockCount/priority/reverb let the
            // editor render envelope + reverb visuals; trackOffsets
            // gives per-channel track navigation.
            trackCount: entry.header.trackCount,
            blockCount: entry.header.blockCount,
            priority: entry.header.priority,
            reverb: entry.header.reverb,
            voiceGroupOffset: entry.header.voiceGroupOffset,
            trackOffsets: Array.from(entry.header.trackOffsets),
            ms: entry.ms,
            me: entry.me,
          },
        });

        // Phase-9 P9-T1: emit `asset:voiceGroup:0x...` node + a
        // `uses_asset` edge from the music_track to the voice group.
        // First song using a given voice group creates the asset
        // node; subsequent songs just add their `uses_asset` edge.
        const voiceGroupAssetId = `asset:voiceGroup:0x${entry.header.voiceGroupOffset.toString(16).toUpperCase().padStart(8, '0')}`;
        if (!voiceGroupAssetIds.has(voiceGroupAssetId)) {
          voiceGroupAssetIds.add(voiceGroupAssetId);
          builder.addNode({
            id: voiceGroupAssetId,
            kind: 'asset',
            label: `voiceGroup@${voiceGroupAssetId.slice('asset:voiceGroup:'.length)}`,
            provenance,
            detail: {
              assetKind: 'voiceGroup',
              fileOffset: entry.header.voiceGroupOffset,
            },
          });
        }
        // Per (music_track, voiceGroup) edge - emit always (each song
        // declares its dependency even if the asset is shared).
        builder.addEdge({
          id: `uses_asset:${songId}->${voiceGroupAssetId}`,
          from: songId,
          to: voiceGroupAssetId,
          kind: 'uses_asset',
          confidence: 0.9,
          provenance,
          detail: { assetKind: 'voiceGroup', songIndex: entry.index },
        });
      }
      const mapIdForAudio = (mapHeaderOffset: number): string =>
        `map:0x${mapHeaderOffset.toString(16).toUpperCase().padStart(8, '0')}`;
      for (const em of enrichedMapsAudio) {
        if (em.musicId <= 0) continue;
        const songId = songIdByIndex.get(em.musicId);
        if (songId === undefined) continue;
        const mapId = mapIdForAudio(em.mapHeaderOffset);
        builder.addEdge({
          id: `plays_music:${mapId}->${songId}`,
          from: mapId,
          to: songId,
          kind: 'plays_music',
          confidence: 0.9,
          provenance,
          detail: { musicId: em.musicId },
        });
      }
    }
  }

  // 3.6b) Phase-9 P9-T2: graphics asset detection (compressed graphics).
  // The compression-format detector (P2-T2) classifies LZ77 streams as
  // `compressed` coverage. P9-T2 surfaces each verified LZ77 block as
  // an `asset:compressedGraphic:0x{start}` node with detail
  // {compressedLength, uncompressedSize, fileOffset}. Then for every
  // map tileset whose tilesOffset (or palettesOffset) equals an LZ77
  // block's start offset, emit a `uses_asset` edge tileset →
  // compressedGraphic - mirroring the P9-T1 audio voice-group pattern.
  //
  // Real Gen-3 ROMs use this exact relationship: a tileset header
  // points at a compressed graphic stream; multiple tilesets can
  // share one stream (deduped by id); the graph models the dependency
  // structurally.
  const compressionRow = args.report.detections.find(
    (d) => d.detectorId === 'compression_format',
  );
  if (
    compressionRow !== undefined &&
    compressionRow.detection.status === 'detected'
  ) {
    const compData = compressionRow.detection.data as
      | {
          lz77Blocks: ReadonlyArray<{
            start: number;
            compressedLength: number;
            uncompressedSize: number;
            endExclusive: number;
          }>;
        }
      | undefined;
    const lz77Blocks = compData?.lz77Blocks ?? [];
    const lz77StartSet = new Set<number>();
    for (const block of lz77Blocks) {
      const assetId = `asset:compressedGraphic:0x${block.start.toString(16).toUpperCase().padStart(8, '0')}`;
      lz77StartSet.add(block.start);
      builder.addNode({
        id: assetId,
        kind: 'asset',
        label: `compressedGraphic@${assetId.slice('asset:compressedGraphic:'.length)} (${String(block.compressedLength)}→${String(block.uncompressedSize)} bytes)`,
        provenance,
        detail: {
          assetKind: 'compressedGraphic',
          compressionFormat: 'lz77',
          fileOffset: block.start,
          compressedLength: block.compressedLength,
          uncompressedSize: block.uncompressedSize,
          endExclusive: block.endExclusive,
        },
      });
    }

    // Cross-reference tilesets → compressedGraphic. Re-read the map
    // system's tilesets array (it's still in scope from the earlier
    // block, but the type-cast was local - re-derive here).
    const mapSystemRowForCompr = args.report.detections.find(
      (d) => d.detectorId === 'map_system',
    );
    if (mapSystemRowForCompr?.detection.status === 'detected') {
      const mapDataLocal = mapSystemRowForCompr.detection.data as
        | {
            tilesets: ReadonlyArray<{
              fileOffset: number;
              tilesOffset: number | null;
              palettesOffset: number | null;
            }>;
          }
        | undefined;
      const tilesets = mapDataLocal?.tilesets ?? [];
      for (const ts of tilesets) {
        const tilesetAssetId = `asset:tileset:0x${ts.fileOffset.toString(16).toUpperCase().padStart(8, '0')}`;
        // tilesOffset → compressedGraphic
        if (ts.tilesOffset !== null && lz77StartSet.has(ts.tilesOffset)) {
          const cgAssetId = `asset:compressedGraphic:0x${ts.tilesOffset.toString(16).toUpperCase().padStart(8, '0')}`;
          try {
            builder.addEdge({
              id: `uses_asset:${tilesetAssetId}->${cgAssetId}.tiles`,
              from: tilesetAssetId,
              to: cgAssetId,
              kind: 'uses_asset',
              confidence: 0.9,
              provenance,
              detail: { assetKind: 'compressedGraphic', role: 'tiles' },
            });
          } catch {
            // Tileset asset not in graph (no map referenced it) - skip.
          }
        }
        // palettesOffset → compressedGraphic (palettes are sometimes
        // LZ77-packed in heavy hacks; in vanilla they're usually raw).
        if (ts.palettesOffset !== null && lz77StartSet.has(ts.palettesOffset)) {
          const cgAssetId = `asset:compressedGraphic:0x${ts.palettesOffset.toString(16).toUpperCase().padStart(8, '0')}`;
          try {
            builder.addEdge({
              id: `uses_asset:${tilesetAssetId}->${cgAssetId}.palettes`,
              from: tilesetAssetId,
              to: cgAssetId,
              kind: 'uses_asset',
              confidence: 0.9,
              provenance,
              detail: { assetKind: 'compressedGraphic', role: 'palettes' },
            });
          } catch {
            // Skip.
          }
        }
      }
    }
  }

  // 3.6c) Phase-9 P9-T3: palette asset detection. Each tileset
  // header (P5-T10) surfaces a `palettesOffset` pointing at the
  // tileset's color palette region (16 colors × u16 BGR15 = 32 bytes
  // for vanilla map tilesets, 13 sub-palettes per tileset). Multiple
  // tilesets commonly share the same palette region (especially
  // secondary tilesets that pull from a shared palette pool), so we
  // dedup by offset - first reference creates the `asset:palette:0x{
  // offset}` node; subsequent tilesets add `uses_asset` edges only.
  // Mirrors the compressedGraphic pattern from P9-T2 and the
  // voiceGroup pattern from P9-T1: tileset → asset:palette is the
  // structural dependency the Phase-12 palette editor needs to
  // surface "which tilesets does this palette belong to?".
  const mapSystemRowForPalette = args.report.detections.find(
    (d) => d.detectorId === 'map_system',
  );
  if (mapSystemRowForPalette?.detection.status === 'detected') {
    const mapDataPalette = mapSystemRowForPalette.detection.data as
      | {
          tilesets: ReadonlyArray<{
            fileOffset: number;
            palettesOffset: number | null;
            isCompressed: boolean;
            isSecondary: boolean;
          }>;
        }
      | undefined;
    const tilesetsForPalette = mapDataPalette?.tilesets ?? [];
    const paletteAssetIds = new Set<string>();
    for (const ts of tilesetsForPalette) {
      if (ts.palettesOffset === null) continue;
      const paletteAssetId = `asset:palette:0x${ts.palettesOffset.toString(16).toUpperCase().padStart(8, '0')}`;
      if (!paletteAssetIds.has(paletteAssetId)) {
        paletteAssetIds.add(paletteAssetId);
        builder.addNode({
          id: paletteAssetId,
          kind: 'asset',
          label: `palette@${paletteAssetId.slice('asset:palette:'.length)}`,
          provenance,
          detail: {
            assetKind: 'palette',
            fileOffset: ts.palettesOffset,
          },
        });
      }
      const tilesetAssetId = `asset:tileset:0x${ts.fileOffset.toString(16).toUpperCase().padStart(8, '0')}`;
      try {
        builder.addEdge({
          id: `uses_asset:${tilesetAssetId}->${paletteAssetId}.palette`,
          from: tilesetAssetId,
          to: paletteAssetId,
          kind: 'uses_asset',
          confidence: 0.9,
          provenance,
          detail: {
            assetKind: 'palette',
            role: 'palette',
            tilesetIsSecondary: ts.isSecondary,
          },
        });
      } catch {
        // tileset asset not in graph (no map referenced it) - skip.
      }
    }
  }

  // 3.7) Phase-8 P8-T1: species system. Emit one `species:N` typed
  // node per detected BaseStats record with stats/types/abilities/
  // growth-rate in detail. The previously-empty `species` NodeKind
  // (declared since Phase 4) is finally populated - directly
  // addressing the §15 P8 anti-empty-success acceptance.
  const speciesSystemRow = args.report.detections.find(
    (d) => d.detectorId === 'species_system',
  );
  if (
    speciesSystemRow !== undefined &&
    speciesSystemRow.detection.status === 'detected'
  ) {
    const data = speciesSystemRow.detection.data as
      | {
          baseStatsTable: {
            tableStart: number;
            records: ReadonlyArray<{
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
              growthRate: number;
              eggGroup1: number;
              eggGroup2: number;
              ability1: number;
              ability2: number;
              friendship: number;
              fileOffset: number;
            }>;
          };
        }
      | undefined;
    const records = data?.baseStatsTable.records ?? [];
    for (let speciesIndex = 0; speciesIndex < records.length; speciesIndex++) {
      const r = records[speciesIndex]!;
      const speciesId = `species:${String(speciesIndex)}`;
      const typeStr =
        r.type1 === r.type2
          ? `type=${String(r.type1)}`
          : `types=${String(r.type1)}/${String(r.type2)}`;
      builder.addNode({
        id: speciesId,
        kind: 'species',
        label: `species[${String(speciesIndex)}] (${typeStr}, BST=${String(r.baseHP + r.baseAttack + r.baseDefense + r.baseSpeed + r.baseSpAttack + r.baseSpDefense)})`,
        provenance,
        detail: {
          speciesIndex,
          fileOffset: r.fileOffset,
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
          growthRate: r.growthRate,
          eggGroup1: r.eggGroup1,
          eggGroup2: r.eggGroup2,
          ability1: r.ability1,
          ability2: r.ability2,
          friendship: r.friendship,
        },
      });
    }
  }

  // 3.8) Phase-8 P8-T2: trainer system. Emit one `trainer:N` typed
  // node per detected Trainer record with class/pic/aiFlags/party
  // metadata in detail. After P8-T1 surfaced species, this populates
  // the previously-empty `trainer` NodeKind (declared since Phase 4) - 
  // species + trainer now coexist as the §15 P8 anti-empty-success
  // acceptance requires.
  const trainerSystemRow = args.report.detections.find(
    (d) => d.detectorId === 'trainer_system',
  );
  if (
    trainerSystemRow !== undefined &&
    trainerSystemRow.detection.status === 'detected'
  ) {
    const data = trainerSystemRow.detection.data as
      | {
          trainerTable: {
            tableStart: number;
            trainers: ReadonlyArray<{
              partyFlags: number;
              trainerClass: number;
              encounterMusic: number;
              isFemale: boolean;
              trainerPic: number;
              trainerNameBytes: Uint8Array;
              trainerNameLength: number;
              items: ReadonlyArray<number>;
              doubleBattle: boolean;
              aiFlags: number;
              partySize: number;
              partyPointer: number;
              fileOffset: number;
            }>;
          };
        }
      | undefined;
    const trainers = data?.trainerTable.trainers ?? [];
    for (let trainerIndex = 0; trainerIndex < trainers.length; trainerIndex++) {
      const t = trainers[trainerIndex]!;
      const trainerId = `trainer:${String(trainerIndex)}`;
      // Reconstruct printable name as ASCII slice (bytes < 0x80 only).
      const nameBytes = t.trainerNameBytes.subarray(0, t.trainerNameLength);
      let printableName = '';
      for (let k = 0; k < nameBytes.length; k++) {
        const b = nameBytes[k] ?? 0;
        printableName += b >= 0x20 && b < 0x80 ? String.fromCharCode(b) : '?';
      }
      const dblTag = t.doubleBattle ? ' [2v2]' : '';
      builder.addNode({
        id: trainerId,
        kind: 'trainer',
        label: `trainer[${String(trainerIndex)}] ${printableName} (class=${String(t.trainerClass)}, party=${String(t.partySize)})${dblTag}`,
        provenance,
        detail: {
          trainerIndex,
          fileOffset: t.fileOffset,
          partyFlags: t.partyFlags,
          trainerClass: t.trainerClass,
          encounterMusic: t.encounterMusic,
          isFemale: t.isFemale,
          trainerPic: t.trainerPic,
          trainerName: printableName,
          trainerNameLength: t.trainerNameLength,
          items: Array.from(t.items),
          doubleBattle: t.doubleBattle,
          aiFlags: t.aiFlags,
          partySize: t.partySize,
          partyPointer: t.partyPointer,
        },
      });
    }
  }

  // 3.9) Phase-8 P8-T3: encounter system depth. The encounter-system
  // detector dereferenced every non-NULL kind-pointer in the P5-T6
  // wild-encounters table into a WildPokemonInfo struct + slot
  // array. For every slot's species id, emit an `encounters_species`
  // edge from the existing `encounter_table:N` node (P5-T6) → the
  // `species:S` node (P8-T1). Deduplicated per (table, species) to
  // avoid N parallel edges when a species appears in multiple slots.
  // Also enriches each encounter_table node's detail with per-kind
  // slot counts + level ranges + species lists so the Phase-12 UI
  // can render the rich encounter view.
  const encounterSystemRow = args.report.detections.find(
    (d) => d.detectorId === 'encounter_system',
  );
  if (
    encounterSystemRow !== undefined &&
    encounterSystemRow.detection.status === 'detected'
  ) {
    const encData = encounterSystemRow.detection.data as
      | {
          entries: ReadonlyArray<{
            mapGroup: number;
            mapNum: number;
            headerFileOffset: number;
            kinds: Readonly<Record<
              'land' | 'water' | 'rockSmash' | 'fishing',
              {
                encounterRate: number;
                slotsOffset: number | null;
                slotCount: number;
                slots: ReadonlyArray<{ minLevel: number; maxLevel: number; species: number; fileOffset: number }>;
              } | null
            >>;
          }>;
        }
      | undefined;
    const entries = encData?.entries ?? [];
    for (const entry of entries) {
      const encounterId = `encounter_table:0x${entry.headerFileOffset.toString(16).toUpperCase().padStart(8, '0')}`;
      // Collect per-kind summary detail + deduplicated species set.
      const speciesForTable = new Set<number>();
      const perKindDetail: Record<string, unknown> = {};
      const kindNames: Array<'land' | 'water' | 'rockSmash' | 'fishing'> = [
        'land',
        'water',
        'rockSmash',
        'fishing',
      ];
      for (const kind of kindNames) {
        const info = entry.kinds[kind];
        if (info === null) continue;
        const speciesIds: number[] = [];
        let minLevel = Infinity;
        let maxLevel = -Infinity;
        for (const slot of info.slots) {
          speciesIds.push(slot.species);
          speciesForTable.add(slot.species);
          if (slot.minLevel < minLevel) minLevel = slot.minLevel;
          if (slot.maxLevel > maxLevel) maxLevel = slot.maxLevel;
        }
        perKindDetail[kind] = {
          encounterRate: info.encounterRate,
          slotCount: info.slotCount,
          minLevel: Number.isFinite(minLevel) ? minLevel : null,
          maxLevel: Number.isFinite(maxLevel) ? maxLevel : null,
          speciesIds,
        };
      }
      // Enrich the existing P5-T6 encounter_table node with P8-T3
      // depth: updateNodeDetail merges without replacing the P5-T6
      // populatedKinds / mapGroup / mapNum / *MonsOffset detail.
      try {
        builder.updateNodeDetail(encounterId, {
          encountersDeep: perKindDetail,
          distinctSpeciesCount: speciesForTable.size,
        });
      } catch {
        // Node not present (e.g. P5-T6 didn't emit it) - skip silently.
      }
      // Emit one encounters_species edge per (encounter_table, species).
      // Wrapped: if the species:S node doesn't exist (e.g. a wild slot
      // references an id beyond the detected gBaseStats count, possible
      // in broken/test hacks), skip rather than crash. The detector's
      // OWN report still carries the species id for the operator.
      for (const speciesIdNum of speciesForTable) {
        const speciesNodeId = `species:${String(speciesIdNum)}`;
        try {
          builder.addEdge({
            id: `encounters_species:${encounterId}->${speciesNodeId}`,
            from: encounterId,
            to: speciesNodeId,
            kind: 'encounters_species',
            confidence: 0.9,
            provenance,
            detail: { speciesId: speciesIdNum },
          });
        } catch {
          // Target species node not in graph - wild slot references an
          // id outside the detected species table. Skip silently.
        }
      }
    }
  }

  // 3.10) Phase-8 P8-T4: species evolutions. The species-evolutions
  // detector found `gEvolutionTable` (5-slot blocks × 40 bytes per
  // species). For every species:N node from P8-T1 we (a) enrich its
  // detail with the evolution chain, and (b) emit one typed
  // `evolves_into` edge per populated slot from species:N → species:T
  // (the target species). After P8-T3's `encounters_species` edges
  // these are the SECOND cross-species typed edges in the build - 
  // species are no longer leaf nodes; they form the typed evolution
  // graph the §15 P8 species view + Phase 12 species editor consume.
  const speciesEvolutionsRow = args.report.detections.find(
    (d) => d.detectorId === 'species_evolutions',
  );
  if (
    speciesEvolutionsRow !== undefined &&
    speciesEvolutionsRow.detection.status === 'detected'
  ) {
    const evoData = speciesEvolutionsRow.detection.data as
      | {
          evolutionTable: {
            tableStart: number;
            blocks: ReadonlyArray<{
              fileOffset: number;
              populatedSlots: ReadonlyArray<{
                method: number;
                param: number;
                targetSpecies: number;
                fileOffset: number;
              }>;
            }>;
          };
        }
      | undefined;
    const blocks = evoData?.evolutionTable.blocks ?? [];
    for (let speciesIndex = 0; speciesIndex < blocks.length; speciesIndex++) {
      const block = blocks[speciesIndex]!;
      const sourceNodeId = `species:${String(speciesIndex)}`;
      // Per-slot summary for node detail.
      const evolutionsDetail = block.populatedSlots.map((s) => ({
        method: s.method,
        param: s.param,
        targetSpecies: s.targetSpecies,
      }));
      // Enrich the species:N node detail (cross-detector enrichment
      // via the updateNodeDetail extension established in P7-T2).
      try {
        builder.updateNodeDetail(sourceNodeId, {
          evolutions: evolutionsDetail,
          evolutionsBlockFileOffset: block.fileOffset,
        });
      } catch {
        // species:N node not present (e.g. P8-T1 didn't emit it
        // because the evolution table reports a larger species count
        // than the BaseStats detector found). Skip silently.
      }
      // Emit one evolves_into edge per populated slot. Try/catch so
      // an evolution targeting a species index outside the detected
      // species count doesn't crash the graph.
      for (const slot of block.populatedSlots) {
        const targetNodeId = `species:${String(slot.targetSpecies)}`;
        try {
          builder.addEdge({
            id: `evolves_into:${sourceNodeId}->${targetNodeId}#${String(slot.fileOffset)}`,
            from: sourceNodeId,
            to: targetNodeId,
            kind: 'evolves_into',
            confidence: 0.9,
            provenance,
            detail: {
              method: slot.method,
              param: slot.param,
              targetSpecies: slot.targetSpecies,
              sourceSpecies: speciesIndex,
            },
          });
        } catch {
          // Either source or target species node not in graph - 
          // evolution references an id outside the detected species
          // table. Skip silently.
        }
      }
    }
  }

  // 3.11) Phase-8 P8-T5: species learnsets. The species-learnsets
  // detector found the gLevelUpLearnsets pointer table + parsed each
  // pointed-at terminator-delimited u16 array into typed (level, move)
  // entries. Enrich each species:N node's detail with its learnset
  // array via `updateNodeDetail` (merged with the existing
  // P8-T1 baseStats + P8-T4 evolutions detail). No new EdgeKind - 
  // learnsets are intra-species data; cross-NodeKind move edges await
  // a future move-table detector.
  const speciesLearnsetsRow = args.report.detections.find(
    (d) => d.detectorId === 'species_learnsets',
  );
  if (
    speciesLearnsetsRow !== undefined &&
    speciesLearnsetsRow.detection.status === 'detected'
  ) {
    const lsData = speciesLearnsetsRow.detection.data as
      | {
          learnsetPointerTable: {
            tableStart: number;
            entries: ReadonlyArray<{
              pointerFileOffset: number;
              pointerRaw: number;
              learnset: {
                entries: ReadonlyArray<{ level: number; move: number; raw: number }>;
                fileOffset: number;
                terminatorOffset: number;
                byteLength: number;
              };
            }>;
          };
        }
      | undefined;
    const tableEntries = lsData?.learnsetPointerTable.entries ?? [];
    for (let speciesIndex = 0; speciesIndex < tableEntries.length; speciesIndex++) {
      const tableEntry = tableEntries[speciesIndex]!;
      const sourceNodeId = `species:${String(speciesIndex)}`;
      const learnsetDetail = tableEntry.learnset.entries.map((e) => ({
        level: e.level,
        move: e.move,
      }));
      try {
        builder.updateNodeDetail(sourceNodeId, {
          learnset: learnsetDetail,
          learnsetArrayFileOffset: tableEntry.learnset.fileOffset,
          learnsetEntryCount: learnsetDetail.length,
        });
      } catch {
        // species:N node not present - pointer table reports more
        // entries than the gBaseStats detector found. Skip silently.
      }
    }
  }

  // 3.12) Phase-8 P8-T6: species TM/HM compatibility. Layer the
  // gTMHMLearnsets bitfield into each species:N node's detail (with
  // baseStats from P8-T1, evolutions from P8-T4, learnset from
  // P8-T5). Each species now has four merged P8 detection layers in
  // a single graph node - the Phase-12 species editor renders the
  // complete species view from one lookup. No new EdgeKind required
  // (TM/HM bits are intra-species; cross-species `species_learns_tm`
  // edges would require TM-name detection first).
  const speciesTMHMRow = args.report.detections.find(
    (d) => d.detectorId === 'species_tmhm',
  );
  if (
    speciesTMHMRow !== undefined &&
    speciesTMHMRow.detection.status === 'detected'
  ) {
    const tmhmData = speciesTMHMRow.detection.data as
      | {
          tmhmTable: {
            tableStart: number;
            slots: ReadonlyArray<{
              low: number;
              high: number;
              setBitIndices: ReadonlyArray<number>;
              setBitCount: number;
              compatibleTmIndices: ReadonlyArray<number>;
              compatibleHmIndices: ReadonlyArray<number>;
              fileOffset: number;
            }>;
          };
        }
      | undefined;
    const slots = tmhmData?.tmhmTable.slots ?? [];
    for (let speciesIndex = 0; speciesIndex < slots.length; speciesIndex++) {
      const slot = slots[speciesIndex]!;
      const sourceNodeId = `species:${String(speciesIndex)}`;
      try {
        builder.updateNodeDetail(sourceNodeId, {
          tmhmCompat: {
            // Encode the u64 as a hex string for diff-friendly display
            // ("0xHHHHHHHHLLLLLLLL").
            bitfieldHex: `0x${slot.high.toString(16).padStart(8, '0')}${slot.low.toString(16).padStart(8, '0')}`,
            setBitCount: slot.setBitCount,
            compatibleTmIndices: Array.from(slot.compatibleTmIndices),
            compatibleHmIndices: Array.from(slot.compatibleHmIndices),
          },
          tmhmSlotFileOffset: slot.fileOffset,
        });
      } catch {
        // species:N node not present - TMHM slot index beyond
        // detected species count. Skip silently.
      }
    }
  }

  // 4) Phase-5 P5-T5 post-pass: world-hierarchy reconstruction.
  // Build an intermediate snapshot of what's been added so far, run
  // connected-components on the warp graph, identify multi-floor
  // buildings (clusters with no exterior `connects_to` edges), then
  // emit `building` nodes + `contains` edges to the SAME builder. The
  // final `builder.build()` returns the enriched graph.
  const intermediate = builder.build();
  const clusters = findMapClusters(intermediate);
  const buildings = inferBuildings(intermediate, clusters);
  for (const b of buildings) {
    builder.addNode({
      id: b.id,
      kind: 'building',
      label: `building (${String(b.floorCount)} floor${b.floorCount === 1 ? '' : 's'}, ${String(b.internalWarpCount)} internal warps)`,
      provenance,
      detail: {
        floorCount: b.floorCount,
        floorMapIds: [...b.floorMapIds],
        internalWarpCount: b.internalWarpCount,
      },
    });
    for (const floorMapId of b.floorMapIds) {
      builder.addEdge({
        id: `contains:${b.id}->${floorMapId}`,
        from: b.id,
        to: floorMapId,
        kind: 'contains',
        confidence: 0.9,
        provenance,
        detail: { role: 'floor' },
      });
    }
  }

  // 5) P7-T2 post-pass: variable role inference. Take a fresh
  // intermediate snapshot (after the building post-pass added its
  // edges) and walk each `variable` node's incoming edges to derive
  // its usage profile + role; merge into the variable's detail via
  // updateNodeDetail.
  const intermediate2 = builder.build();
  for (const node of intermediate2.allNodes()) {
    if (node.kind !== 'variable') continue;
    const incoming = intermediate2.incoming(node.id);
    const records: VariableAccessRecord[] = [];
    for (const edge of incoming) {
      if (
        edge.kind !== 'sets_flag' &&
        edge.kind !== 'reads_flag' &&
        edge.kind !== 'gates_on'
      ) {
        continue;
      }
      const opcodeName =
        typeof edge.detail?.opcodeName === 'string'
          ? edge.detail.opcodeName
          : undefined;
      const record: VariableAccessRecord =
        opcodeName !== undefined
          ? { edgeKind: edge.kind, opcodeName }
          : { edgeKind: edge.kind };
      records.push(record);
    }
    const usageProfile = aggregateVariableUsage(records);
    const role = classifyVariableRole(usageProfile);
    builder.updateNodeDetail(node.id, {
      usageProfile: {
        setsCount: usageProfile.setsCount,
        readsCount: usageProfile.readsCount,
        gatesCount: usageProfile.gatesCount,
        flagBitOpCount: usageProfile.flagBitOpCount,
        multiValueOpCount: usageProfile.multiValueOpCount,
        opcodeNames: [...usageProfile.opcodeNames],
      },
      role,
    });
  }

  // 6) P7-T3 post-pass: cross-script `unlocks` chain derivation. For
  // every variable, find writer (sets_flag source) × reader
  // (reads_flag / gates_on source) pairs and emit `unlocks` edges
  // (writer → reader) via the shared variable. Excludes self-loops.
  const unlockChains = deriveUnlockChains(intermediate2);
  for (const chain of unlockChains) {
    builder.addEdge({
      id: `unlocks:${chain.writerNodeId}->${chain.readerNodeId}.via:${chain.viaVariableNodeId}`,
      from: chain.writerNodeId,
      to: chain.readerNodeId,
      kind: 'unlocks',
      confidence: 0.85,
      provenance,
      detail: {
        viaVariableId: chain.viaVariableId,
        viaVariableNodeId: chain.viaVariableNodeId,
        readerEdgeKind: chain.readerEdgeKind,
      },
    });
  }

  return builder.build();
}
