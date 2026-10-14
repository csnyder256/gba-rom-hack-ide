/**
 * propose_set_map_metadata - Phase 3.12.
 *
 * In-place rewrite of a MapHeader's metadata bytes (music, weather,
 * mapType, regionMapSection, flags, battleType). Does NOT touch
 * pointers; just bumps the small-integer fields per the parser's
 * layout.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_SET_MAP_METADATA_TOOL_NAME = 'propose_set_map_metadata';

export const PROPOSE_SET_MAP_METADATA_DESCRIPTION =
  'Set per-map metadata (music, weather, type, region-map section,\n' +
  'biking, flags, floor, battle type) in-place on the MapHeader struct.\n\n' +
  'Inputs (all optional - pass only the fields you want to change):\n' +
  '  - `mapId`: the map id.\n' +
  '  - `musicId`: u16 - music track to play on this map.\n' +
  '  - `weather`: u8 - weather id (0 = clear, 1 = sunny, etc.).\n' +
  '  - `mapType`: 1..9 (1=Town, 2=City, 3=Route, …, 9=Secret).\n' +
  '  - `regionMapSection`: u8 (0x58 = NONE).\n' +
  '  - `caveOrType`: u8 - terrain subtype.\n' +
  '  - `bikingAllowed`: bool - allow cycling on this map (byte 0x18).\n' +
  '  - `flags`: u8 - map-flags bitfield (byte 0x19): bit0 allowEscaping,\n' +
  '    bit1 allowRunning, bits 2..7 showMapName.\n' +
  '  - `floorNum`: s8 - floor number (byte 0x1A; negative for basements).\n' +
  '  - `battleType`: u8 - encounter-music selector (byte 0x1B).';

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeSetMapMetadataInputShape = {
  mapId: z.string().min(1),
  musicId: u16.optional(),
  weather: u8.optional(),
  mapType: z.number().int().min(1).max(9).optional(),
  regionMapSection: u8.optional(),
  caveOrType: u8.optional(),
  bikingAllowed: z.boolean().optional(),
  flags: u8.optional(),
  floorNum: z.number().int().min(-128).max(127).optional(),
  battleType: u8.optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeSetMapMetadataResult {
  readonly proposal: AgentPatchProposal | null;
  readonly mapId: string | null;
  readonly fieldsChanged: ReadonlyArray<string>;
  readonly message: string;
}

function emptyResult(message: string): ProposeSetMapMetadataResult {
  return { proposal: null, mapId: null, fieldsChanged: [], message };
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

async function findRomFile(root: string): Promise<{ bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return { bytes: await fsp.readFile(path.join(root, e.name)) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function proposeSetMapMetadata(
  ctx: ToolContext,
  args: {
    mapId: string;
    musicId?: number;
    weather?: number;
    mapType?: number;
    regionMapSection?: number;
    caveOrType?: number;
    bikingAllowed?: boolean;
    flags?: number;
    floorNum?: number;
    battleType?: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeSetMapMetadataResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) return emptyResult('No manifest.');
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  const map = manifest.maps.find((m) => m.id === args.mapId);
  if (!map) return emptyResult(`Map "${args.mapId}" not found.`);
  const headerOffset = map.metadata?.['mapHeaderOffset'];
  if (typeof headerOffset !== 'number') {
    return emptyResult(`Map "${args.mapId}" missing mapHeaderOffset. Re-scan.`);
  }

  // Read current 28-byte header.
  const oldHeader = new Uint8Array(rom.bytes.subarray(headerOffset, headerOffset + 28));
  if (oldHeader.length !== 28) return emptyResult('Failed to read full map header.');
  const newHeader = new Uint8Array(oldHeader);

  // MapHeader field offsets (pret `struct MapHeader`, matching header.ts):
  //   0x10 musicId u16
  //   0x14 regionMapSection u8
  //   0x15 caveOrType u8
  //   0x16 weather u8
  //   0x17 mapType u8
  //   0x18 bikingAllowed u8 (bool8 - allow_cycling)
  //   0x19 flags u8 (bit0 allowEscaping, bit1 allowRunning, bits 2..7 showMapName)
  //   0x1A floorNum s8
  //   0x1B battleType u8
  const changed: string[] = [];
  if (args.musicId !== undefined) {
    newHeader[0x10] = args.musicId & 0xff;
    newHeader[0x11] = (args.musicId >>> 8) & 0xff;
    changed.push('musicId');
  }
  if (args.regionMapSection !== undefined) {
    newHeader[0x14] = args.regionMapSection;
    changed.push('regionMapSection');
  }
  if (args.caveOrType !== undefined) {
    newHeader[0x15] = args.caveOrType;
    changed.push('caveOrType');
  }
  if (args.weather !== undefined) {
    newHeader[0x16] = args.weather;
    changed.push('weather');
  }
  if (args.mapType !== undefined) {
    newHeader[0x17] = args.mapType;
    changed.push('mapType');
  }
  if (args.bikingAllowed !== undefined) {
    newHeader[0x18] = args.bikingAllowed ? 0x01 : 0x00;
    changed.push('bikingAllowed');
  }
  if (args.flags !== undefined) {
    newHeader[0x19] = args.flags;
    changed.push('flags');
  }
  if (args.floorNum !== undefined) {
    newHeader[0x1a] = args.floorNum & 0xff;
    changed.push('floorNum');
  }
  if (args.battleType !== undefined) {
    newHeader[0x1b] = args.battleType;
    changed.push('battleType');
  }

  if (changed.length === 0) return emptyResult('No fields specified; nothing to change.');

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: headerOffset,
      beforeBytes: bytesToHex(oldHeader),
      afterBytes: bytesToHex(newHeader),
      note: `set ${changed.join(', ')} on ${args.mapId}`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.description ?? `Set ${changed.join(', ')} on ${args.mapId}`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed to register proposal: ${e.message}`);
    throw e;
  }
  return { proposal, mapId: args.mapId, fieldsChanged: changed, message: `Updated ${changed.join(', ')} on ${args.mapId}.` };
}
