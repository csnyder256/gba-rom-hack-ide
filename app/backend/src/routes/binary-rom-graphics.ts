/**
 * Backend routes for serving binary-ROM tile graphics + map cells.
 *
 * Phase UX-C.3 (per reactive-hatching-bee.md). These routes let the
 * frontend MapEditor render REAL Pokémon-game tiles for binary-rom
 * projects (where there's no decomp source tree to read `layout.bin`
 * / tileset PNGs from). Decomp projects keep using
 * `/api/projects/:id/layout` which reads from `data/layouts/<dir>/`.
 *
 * Two routes:
 *
 *   POST /api/projects/:id/binary-rom-tileset
 *     body: { tilesetOffset: number, isCompressed: boolean,
 *             palettesOffset: number, metatilesOffset: number,
 *             maxMetatiles?: number, maxTiles?: number }
 *     → returns { tileCount, palettes: number[][], metatileCount,
 *                 tileSheetRgba: base64, metatileSpecs: ... }
 *     The frontend caches per (tilesetOffset, palettesOffset,
 *     metatilesOffset) tuple.
 *
 *   POST /api/projects/:id/binary-rom-map-data
 *     body: { layoutOffset: number, width: number, height: number }
 *     → returns { cells: Array<{ metatileId, collision, elevation }> }
 *     The frontend uses this in combination with the tileset response
 *     to render the real map (cell.metatileId indexes into the
 *     tileset's metatileSpecs array; the frontend composes the 16×16
 *     metatile texture per Phase C.1's composeMetatile in the browser).
 *
 * Both routes require the session's project to be a bare-ROM workspace
 * with a `.gba` file in the root.
 */

import type { FastifyInstance } from 'fastify';
import { promises as fsp } from 'node:fs';
import {
  graphics,
  maps,
  rom as engineRom,
  scripts as engineScripts,
  species as engineSpecies,
  text as engineText,
  world,
} from '@rom-introspection/engine';
import { findFirstGbaFile } from '../scan/binary-rom.js';
import type { ProjectSessionStore } from '../projects/session-store.js';

interface ErrorRespondHelpers {
  errorResponse: (
    reply: import('fastify').FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => unknown;
}

export interface BinaryRomTilesetRequest {
  /** File offset of the 24-byte Tileset struct. The backend parses the
   *  struct internally to extract tilesOffset / palettesOffset /
   *  metatilesOffset / isCompressed so the frontend doesn't have to
   *  follow Gen-3 family-specific slot layouts. */
  readonly tilesetStructOffset: number;
  /** Optional caps mirrored from FetchTilesetGraphicsOptions. */
  readonly maxMetatiles?: number;
  readonly maxTiles?: number;
}

export interface BinaryRomTilesetResponse {
  readonly tileCount: number;
  /** 16 decoded palettes, each 16 u32 RGBA values. */
  readonly palettes: ReadonlyArray<ReadonlyArray<number>>;
  /** Base64-encoded RAW palette-index tile sheet (1 byte per pixel,
   *  64 bytes per tile, `tileCount × 64` total). Each byte is a
   *  palette index 0-15; the frontend re-applies the per-metatile-tile
   *  spec's paletteIndex to render correct colors per the GBA 4bpp
   *  convention (different tiles in a metatile can use different
   *  palettes; serving pre-RGBA would lock everything to palette 0
   *  and render many tiles as black). */
  readonly tileSheetIndices: string;
  /** @deprecated Pre-baked palette-0 RGBA tile sheet. Retained
   *  briefly for migration; frontend should use `tileSheetIndices`
   *  + per-metatile palette resolution instead. */
  readonly tileSheetRgba: string;
  /** Per-metatile decoded layer-0 + layer-1 specs (matches engine
   *  TilesetGraphics.metatiles shape). Frontend composes 16×16
   *  textures from these + the tileSheet + palettes via
   *  composeMetatile. */
  readonly metatileSpecs: ReadonlyArray<{
    readonly layer0: ReadonlyArray<{
      readonly tileIndex: number;
      readonly hflip: boolean;
      readonly vflip: boolean;
      readonly paletteIndex: number;
    }>;
    readonly layer1: ReadonlyArray<{
      readonly tileIndex: number;
      readonly hflip: boolean;
      readonly vflip: boolean;
      readonly paletteIndex: number;
    }>;
  }>;
  readonly truncated: boolean;
}

export interface BinaryRomMapDataRequest {
  readonly layoutOffset: number;
  readonly width: number;
  readonly height: number;
}

export interface BinaryRomMapCell {
  readonly metatileId: number;
  readonly collision: number;
  readonly elevation: number;
}

export interface BinaryRomMapDataResponse {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<BinaryRomMapCell>;
}

/** Pack raw palette-index tile bytes for the frontend to apply the
 *  correct per-metatile palette at composition time. 1 byte per pixel
 *  × 64 pixels per tile = 64 bytes per tile. This is the canonical
 *  serving format - palette-0 RGBA was a placeholder that rendered
 *  most tiles black when their metatile spec referenced palettes 1-15. */
function packTileSheetIndices(tiles: ReadonlyArray<Uint8Array>): Buffer {
  const buf = Buffer.alloc(tiles.length * 64);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    buf.set(tile, i * 64);
  }
  return buf;
}

/** Legacy palette-0-prebaked RGBA tile sheet. Kept briefly so the
 *  frontend can fall back during migration; new code should use the
 *  raw-indices path with per-metatile palette resolution. */
function packTileSheetRgba(
  tiles: ReadonlyArray<Uint8Array>,
  palettes: ReadonlyArray<Uint32Array>,
): Buffer {
  const buf = Buffer.alloc(tiles.length * 256);
  const palette = palettes[0] ?? new Uint32Array(16);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    for (let p = 0; p < 64; p++) {
      const palIdx = tile[p]!;
      const rgba = palette[palIdx] ?? 0;
      const off = i * 256 + p * 4;
      buf[off] = rgba & 0xff;
      buf[off + 1] = (rgba >> 8) & 0xff;
      buf[off + 2] = (rgba >> 16) & 0xff;
      buf[off + 3] = (rgba >> 24) & 0xff;
    }
  }
  return buf;
}

/** Decode the Gen-3 16-bit map cell: bits 0-9 = metatile id, bits
 *  10-11 = collision, bits 12-15 = elevation. (Mirrors the decomp
 *  layouts.ts decoder.) */
function decodeMapCell(word: number): BinaryRomMapCell {
  return {
    metatileId: word & 0x03ff,
    collision: (word >> 10) & 0x03,
    elevation: (word >> 12) & 0x0f,
  };
}

export interface RegisterBinaryRomGraphicsRoutesArgs {
  readonly app: FastifyInstance;
  readonly sessionStore: ProjectSessionStore;
  readonly errorResponse: ErrorRespondHelpers['errorResponse'];
}

export function registerBinaryRomGraphicsRoutes({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomTilesetRequest }>(
    '/api/projects/:id/binary-rom-tileset',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (!body || typeof body.tilesetStructOffset !== 'number') {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric tilesetStructOffset.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root; this route requires a bare-ROM project.',
        );
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }
      try {
        const romBuffer = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length);
        // Parse the 24-byte Tileset struct at the supplied offset to
        // extract the actual tiles/palettes/metatiles sub-offsets +
        // isCompressed flag. Caller passes one offset; backend follows.
        const parsed = maps.parseTileset(romBuffer, body.tilesetStructOffset);
        if (!parsed.ok) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Tileset parse at 0x${body.tilesetStructOffset.toString(16)} failed: ${parsed.failure.kind}`,
          );
        }
        // FireRed convention: metatileAttributes at slot 0x14. Emerald
        // convention: slot 0x10. We try slot14 first (FireRed is the
        // more common base for hacks) and fall back to slot10 when
        // slot14 is null. This is the same disambiguation pret
        // workshops use in practice.
        const metatilesOffset =
          parsed.tileset.metatilesOffset ??
          parsed.tileset.slot14Offset ??
          parsed.tileset.slot10Offset;
        const tileset = maps.fetchTilesetGraphics(
          {
            rom: romBuffer,
            tilesOffset: parsed.tileset.tilesOffset,
            palettesOffset: parsed.tileset.palettesOffset,
            metatilesOffset,
            isCompressed: parsed.tileset.isCompressed,
          },
          {
            maxTiles: body.maxTiles,
            maxMetatiles: body.maxMetatiles,
          },
        );

        const tileSheetIndicesBuffer = packTileSheetIndices(tileset.tiles);
        const tileSheetRgbaBuffer = packTileSheetRgba(tileset.tiles, tileset.palettes);
        const response: BinaryRomTilesetResponse = {
          tileCount: tileset.tiles.length,
          palettes: tileset.palettes.map((p) => Array.from(p)),
          tileSheetIndices: tileSheetIndicesBuffer.toString('base64'),
          tileSheetRgba: tileSheetRgbaBuffer.toString('base64'),
          metatileSpecs: tileset.metatiles.map((m) => ({
            layer0: m.layer0.map((s) => ({
              tileIndex: s.tileIndex,
              hflip: s.hflip,
              vflip: s.vflip,
              paletteIndex: s.paletteIndex,
            })),
            layer1: m.layer1.map((s) => ({
              tileIndex: s.tileIndex,
              hflip: s.hflip,
              vflip: s.vflip,
              paletteIndex: s.paletteIndex,
            })),
          })),
          truncated: tileset.truncated,
        };
        return response;
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          e instanceof Error ? e.message : 'unknown',
        );
      }
    },
  );

  app.post<{ Params: { id: string }; Body: BinaryRomMapDataRequest }>(
    '/api/projects/:id/binary-rom-map-data',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (
        !body ||
        typeof body.layoutOffset !== 'number' ||
        typeof body.width !== 'number' ||
        typeof body.height !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric layoutOffset, width, and height.',
        );
      }
      if (body.width <= 0 || body.height <= 0 || body.width > 1024 || body.height > 1024) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Implausible map dimensions ${String(body.width)}×${String(body.height)}; expected 1..1024 each.`,
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root; this route requires a bare-ROM project.',
        );
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }
      const cellCount = body.width * body.height;
      const totalBytes = cellCount * 2;
      if (body.layoutOffset < 0 || body.layoutOffset + totalBytes > romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Map layout at 0x${body.layoutOffset.toString(16)} + ${String(totalBytes)} bytes exceeds ROM size ${String(romBytes.length)}.`,
        );
      }
      const cells: BinaryRomMapCell[] = new Array(cellCount);
      // Use DataView for endian-safe u16 reads.
      const view = new DataView(romBytes.buffer, romBytes.byteOffset, romBytes.length);
      for (let i = 0; i < cellCount; i++) {
        const word = view.getUint16(body.layoutOffset + i * 2, true);
        cells[i] = decodeMapCell(word);
      }
      const response: BinaryRomMapDataResponse = {
        width: body.width,
        height: body.height,
        cells,
      };
      return response;
    },
  );
}

// Re-export to keep the graphics utility usable from tests too.
export { decodeMapCell };

// Suppress unused-graphics warning - the import is kept for parity
// (frontend imports the same types from engine) even though this file
// doesn't directly invoke graphics functions.
void graphics;

// ─────────────────────────────────────────────────────────────────────
// Phase UX-D - ROM map-cell write route
//
// POST /api/projects/:id/binary-rom-edit/map-cells
//   body: { layoutOffset, width, height, edits: [{ x, y, metatileId,
//           collision?, elevation? }] }
//   → patches the ROM map binary in-place AFTER writing a one-time
//     `<rom>.bak` backup. Returns the rewritten cell array so the
//     frontend can refresh its tileGrid.
//
// Safety:
//   - Creates `<rom>.bak` on first write per session (idempotent;
//     skipped if backup file already exists). Operator can restore by
//     hand if a paint session goes wrong.
//   - Validates each edit's coord in [0, width) × [0, height).
//   - Validates each metatileId fits in 10 bits, collision in 2 bits,
//     elevation in 4 bits per the Gen-3 16-bit cell encoding.
//   - Atomic: all edits applied to an in-memory copy first; only the
//     final buffer is fsync-flushed to disk.
//
// Out of scope for this iter: relocating overflowing structures (e.g.
// expanding the event table). Cell edits never expand the map data.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditCellsRequest {
  readonly layoutOffset: number;
  readonly width: number;
  readonly height: number;
  readonly edits: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly metatileId?: number;
    readonly collision?: number;
    readonly elevation?: number;
  }>;
}

export interface BinaryRomEditCellsResponse {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<BinaryRomMapCell>;
  /** True when this write created the `<rom>.bak` backup file (first
   *  edit of the session). False on subsequent writes. */
  readonly backupCreated: boolean;
  /** Number of cells actually changed (vs. requested but identical). */
  readonly cellsChanged: number;
}

/** Encode {metatileId, collision, elevation} → Gen-3 16-bit cell word. */
function encodeMapCell(cell: BinaryRomMapCell): number {
  return (
    (cell.metatileId & 0x03ff) |
    ((cell.collision & 0x03) << 10) |
    ((cell.elevation & 0x0f) << 12)
  );
}

export function registerBinaryRomEditRoutes({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditCellsRequest }>(
    '/api/projects/:id/binary-rom-edit/map-cells',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (
        !body ||
        typeof body.layoutOffset !== 'number' ||
        typeof body.width !== 'number' ||
        typeof body.height !== 'number' ||
        !Array.isArray(body.edits)
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric layoutOffset, width, height, and an edits array.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root; this route requires a bare-ROM project.',
        );
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }

      const cellCount = body.width * body.height;
      const totalBytes = cellCount * 2;
      if (body.layoutOffset < 0 || body.layoutOffset + totalBytes > romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Map layout at 0x${body.layoutOffset.toString(16)} + ${String(totalBytes)} bytes exceeds ROM size ${String(romBytes.length)}.`,
        );
      }

      // Validate all edits before mutating anything.
      for (const e of body.edits) {
        if (e.x < 0 || e.x >= body.width || e.y < 0 || e.y >= body.height) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Edit (${String(e.x)},${String(e.y)}) out of map bounds ${String(body.width)}×${String(body.height)}.`,
          );
        }
        if (e.metatileId !== undefined && (e.metatileId < 0 || e.metatileId > 0x03ff)) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Edit metatileId ${String(e.metatileId)} exceeds 10-bit cell field (0..1023).`,
          );
        }
        if (e.collision !== undefined && (e.collision < 0 || e.collision > 0x03)) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Edit collision ${String(e.collision)} exceeds 2-bit cell field (0..3).`,
          );
        }
        if (e.elevation !== undefined && (e.elevation < 0 || e.elevation > 0x0f)) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Edit elevation ${String(e.elevation)} exceeds 4-bit cell field (0..15).`,
          );
        }
      }

      // Create backup if it doesn't exist yet.
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        // Backup doesn't exist → create it.
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(
            reply,
            500,
            'internal_error',
            `Failed to write ROM backup at ${backupPath}: ${String(e)}`,
          );
        }
      }

      // Apply edits to an in-memory copy.
      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      let cellsChanged = 0;
      for (const e of body.edits) {
        const cellOff = body.layoutOffset + (e.y * body.width + e.x) * 2;
        const before = view.getUint16(cellOff, true);
        const beforeCell = decodeMapCell(before);
        const merged: BinaryRomMapCell = {
          metatileId: e.metatileId ?? beforeCell.metatileId,
          collision: e.collision ?? beforeCell.collision,
          elevation: e.elevation ?? beforeCell.elevation,
        };
        const after = encodeMapCell(merged);
        if (after !== before) {
          view.setUint16(cellOff, after, true);
          cellsChanged++;
        }
      }

      // Flush to disk.
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          `Failed to write ROM: ${String(e)}`,
        );
      }

      // Read back the updated cells for the response.
      const updated: BinaryRomMapCell[] = new Array(cellCount);
      const updatedView = new DataView(out.buffer, out.byteOffset, out.length);
      for (let i = 0; i < cellCount; i++) {
        updated[i] = decodeMapCell(updatedView.getUint16(body.layoutOffset + i * 2, true));
      }
      const response: BinaryRomEditCellsResponse = {
        width: body.width,
        height: body.height,
        cells: updated,
        backupCreated,
        cellsChanged,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase G-RC5 - Binary-ROM ObjectEvent field write route
//
// POST /api/projects/:id/binary-rom-edit/object-event-fields
//   body: {
//     edits: [{
//       structFileOffset: number,
//       fields: { graphics_id?, elevation?, movement_type?,
//                 movement_range_x?, movement_range_y?, trainer_type?,
//                 trainer_sight_or_berry_tree_id?, script?, flag? }
//     }]
//   }
//   → patches the 24-byte ObjectEventTemplate struct(s) in place
//     after writing a one-time `<rom>.bak` backup. Returns per-edit
//     previous + next field values so the frontend can update its
//     in-memory state without re-scanning.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditObjectEventFieldsRequest {
  readonly edits: ReadonlyArray<{
    readonly structFileOffset: number;
    readonly fields: Readonly<Record<string, number | null | undefined>>;
  }>;
}

export interface BinaryRomEditObjectEventFieldsResponse {
  readonly backupCreated: boolean;
  readonly bytesChanged: number;
  readonly results: ReadonlyArray<{
    readonly structFileOffset: number;
    readonly previous: Readonly<Record<string, number>>;
    readonly next: Readonly<Record<string, number>>;
  }>;
}

export function registerBinaryRomObjectEventEditRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditObjectEventFieldsRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/object-event-fields',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (!body || !Array.isArray(body.edits) || body.edits.length === 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include a non-empty `edits` array.',
        );
      }
      for (const e of body.edits) {
        if (!e || typeof e.structFileOffset !== 'number' || !e.fields) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'Each edit must include numeric `structFileOffset` and `fields` object.',
          );
        }
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root; this route requires a bare-ROM project.',
        );
      }
      const { applyBinaryRomObjectEventEdits, BinaryRomObjectEventWriteError } =
        await import('../events/binary-rom-object-event-write.js');
      try {
        const result = await applyBinaryRomObjectEventEdits(
          romPath,
          body.edits.map((e) => ({
            structFileOffset: e.structFileOffset,
            fields: e.fields,
          })),
        );
        const response: BinaryRomEditObjectEventFieldsResponse = {
          backupCreated: result.backupCreated,
          bytesChanged: result.bytesChanged,
          results: result.results,
        };
        return response;
      } catch (e) {
        if (e instanceof BinaryRomObjectEventWriteError) {
          return errorResponse(reply, 400, e.code, e.message);
        }
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          e instanceof Error ? e.message : String(e),
        );
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase UX-E - overworld sprite image route
//
// POST /api/projects/:id/binary-rom-ow-sprite
//   body: { structFileOffset: number, frameIndex?: number,
//           palette?: ReadonlyArray<number> /* 16 u32 RGBA */ }
//   → returns { width, height, rgbaBase64 } - composed sprite ready
//     for the frontend to wrap as a PixiJS Texture.
//
// Decodes via iter-111's engine module (decodeOverworldSpriteImage +
// applyPaletteToOverworldSprite). Palette resolution is the caller's
// responsibility (the OW sprite's paletteSlot/Tag mapping to a loaded
// palette block needs a separate engine substrate iter that isn't
// done yet - see iter-112 honest-scope note in the heartbeat). When
// no palette is supplied, the route falls back to a grayscale ramp so
// operators see a sprite SILHOUETTE at the NPC marker rather than a
// purple square - visible improvement honest about the limit.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomOwSpriteRequest {
  readonly structFileOffset: number;
  readonly frameIndex?: number;
  /** Optional 16-entry palette (u32 RGBA each, little-endian RGBA byte
   *  order matching engine.graphics.bgr555ToRgba output). When omitted
   *  the route generates a grayscale palette so the sprite renders as
   *  a silhouette. */
  readonly palette?: ReadonlyArray<number>;
}

export interface BinaryRomOwSpriteResponse {
  readonly width: number;
  readonly height: number;
  readonly rgbaBase64: string;
  /** @deprecated Kept for backwards compatibility - use paletteSource
   *  instead. Equals true when paletteSource === 'neutral'. */
  readonly grayscaleFallback: boolean;
  /** The Real Game Editor Push - which step of the palette resolution
   *  chain produced the colors:
   *   - 'detected': caller supplied a 16-entry palette derived from the
   *     engine's sObjectEventSpritePalettes[] cross-ref. Sprite renders
   *     with the real in-game colors.
   *   - 'neutral': caller didn't supply a palette (engine couldn't
   *     resolve the tag); route returns a warm sepia palette so the
   *     sprite reads as a CHARACTER silhouette rather than the previous
   *     pure-gray "broken render" appearance. Frontend should overlay
   *     a "?" badge so the user knows the colors are a guess.
   *
   *  Future: a 'signature' step that hashes sprite tiles and looks up
   *  known palettes from a bundled vanilla table; not enabled yet so
   *  the contract is honest about today's coverage.
   */
  readonly paletteSource: 'detected' | 'neutral';
}

/** The Real Game Editor Push - warm sepia neutral palette for when no
 *  detected palette was supplied. Replaces the previous pure-grayscale
 *  ramp (which made NPCs look BROKEN instead of "we don't know the
 *  colors yet"). Skin/clothing-friendly sepia tones so the sprite reads
 *  as a person under uncertain lighting rather than a black-and-white
 *  ghost. RGBA byte order matches engine.graphics.bgr555ToRgba (R/G/B/A
 *  in u32 little-endian, R = byte0). */
function buildNeutralPalette(): Uint32Array {
  // Carefully chosen sepia ramp: warm browns shading from cream
  // highlights to deep coffee shadows. Index 0 transparent (the GBA
  // BG-color slot the game itself uses for transparency).
  const SEPIA_RGB: ReadonlyArray<[number, number, number]> = [
    [0, 0, 0], // 0 transparent
    [248, 233, 200], // 1 cream (lightest highlight)
    [240, 215, 170], // 2
    [230, 192, 142], // 3
    [218, 168, 118], // 4 skin / neutral
    [200, 145, 96], // 5
    [180, 120, 78], // 6
    [156, 100, 62], // 7
    [134, 84, 50], // 8 deep tan
    [112, 70, 42], // 9
    [94, 58, 34], // 10
    [76, 48, 28], // 11
    [60, 38, 22], // 12 deep brown shadow
    [44, 28, 16], // 13
    [28, 18, 10], // 14
    [16, 10, 6], // 15 near-black
  ];
  const out = new Uint32Array(16);
  out[0] = 0;
  for (let i = 1; i < 16; i++) {
    const rgb = SEPIA_RGB[i]!;
    // little-endian u32 RGBA: byte0=R, byte1=G, byte2=B, byte3=A=0xff
    out[i] = (0xff << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];
  }
  return out;
}

export function registerBinaryRomOwSpriteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomOwSpriteRequest }>(
    '/api/projects/:id/binary-rom-ow-sprite',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (!body || typeof body.structFileOffset !== 'number') {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric structFileOffset.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root; this route requires a bare-ROM project.',
        );
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }
      const romBuffer = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length);
      const frameIndex = body.frameIndex ?? 0;
      const decoded = world.decodeOverworldSpriteImage(romBuffer, body.structFileOffset, frameIndex);
      if (!decoded.ok) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `OW sprite decode at 0x${body.structFileOffset.toString(16)} failed: ${decoded.failure.kind}`,
        );
      }
      const customPalette = body.palette && body.palette.length === 16;
      const palette = customPalette
        ? Uint32Array.from(body.palette as ReadonlyArray<number>)
        : buildNeutralPalette();
      const paletteSource: BinaryRomOwSpriteResponse['paletteSource'] = customPalette
        ? 'detected'
        : 'neutral';
      const rgba = world.applyPaletteToOverworldSprite(decoded.image, palette);
      // Pack to a Buffer for base64 transport. Uint32Array shares the
      // same underlying ArrayBuffer; copy via Buffer.from to be safe
      // about offset alignment.
      const rgbaBuf = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      const response: BinaryRomOwSpriteResponse = {
        width: decoded.image.width,
        height: decoded.image.height,
        rgbaBase64: rgbaBuf.toString('base64'),
        grayscaleFallback: paletteSource === 'neutral',
        paletteSource,
      };
      return response;
    },
  );
}

// Suppress unused-graphics warning at this position too.
void graphics;

// ─────────────────────────────────────────────────────────────────────
// Phase I.3 - Binary-ROM dialogue-string write route
//
// POST /api/projects/:id/binary-rom-edit/dialogue-string
//   body: { stringFileOffset: number, newText: string }
//   → re-encodes `newText` via the Gen-3 codec and writes it at
//     `stringFileOffset`, ending with the 0xFF terminator. Validates
//     that the new encoded length (including terminator) fits within
//     the ORIGINAL terminator-bounded span - no relocation.
//
// Surfaces a clear error when the new text contains characters the
// encoder can't map (the user can either rephrase or wait for a future
// encoder extension).
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditDialogueStringRequest {
  readonly stringFileOffset: number;
  readonly newText: string;
}

export interface BinaryRomEditDialogueStringResponse {
  readonly stringFileOffset: number;
  readonly bytesWritten: number;
  readonly originalSpanBytes: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomDialogueEditRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditDialogueStringRequest }>(
    '/api/projects/:id/binary-rom-edit/dialogue-string',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (
        !body ||
        typeof body.stringFileOffset !== 'number' ||
        typeof body.newText !== 'string'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric stringFileOffset and string newText.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root; this route requires a bare-ROM project.',
        );
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }

      if (body.stringFileOffset < 0 || body.stringFileOffset >= romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `String offset 0x${body.stringFileOffset.toString(16)} out of ROM bounds.`,
        );
      }

      // Find the original terminator so we know the writable span.
      let terminatorOffset = -1;
      const MAX_STRING_BYTES = 4096;
      for (let i = 0; i < MAX_STRING_BYTES; i++) {
        const idx = body.stringFileOffset + i;
        if (idx >= romBytes.length) break;
        if (romBytes[idx] === engineText.STRING_TERMINATOR) {
          terminatorOffset = idx;
          break;
        }
      }
      if (terminatorOffset < 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Could not find string terminator within ${String(MAX_STRING_BYTES)} bytes of 0x${body.stringFileOffset.toString(16)} - refusing to write.`,
        );
      }
      const originalSpanBytes = terminatorOffset - body.stringFileOffset + 1;

      // Encode new text.
      let encoded: Uint8Array;
      try {
        encoded = engineText.encodeString(body.newText);
      } catch (e) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Cannot encode text: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const newSpanBytes = encoded.length + 1; // +1 terminator
      if (newSpanBytes > originalSpanBytes) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `New text encodes to ${String(newSpanBytes)} bytes but original span is only ${String(originalSpanBytes)} bytes. Shorten the text or wait for relocation support.`,
        );
      }

      // Create backup if it doesn't exist yet.
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(
            reply,
            500,
            'internal_error',
            `Failed to write ROM backup at ${backupPath}: ${String(e)}`,
          );
        }
      }

      // Apply edit to an in-memory copy.
      const out = Buffer.from(romBytes);
      for (let i = 0; i < encoded.length; i++) {
        out[body.stringFileOffset + i] = encoded[i]!;
      }
      out[body.stringFileOffset + encoded.length] = engineText.STRING_TERMINATOR;
      // Zero-fill any remaining bytes between new terminator and old
      // terminator so stale text isn't visible in hex dumps + the bytes
      // are clearly "padding". The Gen-3 engine stops at 0xFF so the
      // exact padding bytes don't matter for runtime behavior.
      for (let i = encoded.length + 1; i < originalSpanBytes; i++) {
        out[body.stringFileOffset + i] = engineText.STRING_TERMINATOR;
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          `Failed to write ROM: ${String(e)}`,
        );
      }

      const response: BinaryRomEditDialogueStringResponse = {
        stringFileOffset: body.stringFileOffset,
        bytesWritten: encoded.length + 1,
        originalSpanBytes,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase I.4 - Binary-ROM script-step args write route
//
// POST /api/projects/:id/binary-rom-edit/script-step-args
//   body: { stepFileOffset: number, argBytes: number[] }
//   → validates that the opcode at stepFileOffset has argBytes.length
//     argument bytes per its Gen-3 spec, then writes the new bytes
//     starting at stepFileOffset + 1 (skipping the opcode byte).
//
// Used by the inspector's per-step inline editors (set_flag, setvar,
// give_item, etc.) - each step kind builds its own argBytes array from
// the user's numeric inputs and POSTs it here.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditScriptStepArgsRequest {
  readonly stepFileOffset: number;
  readonly argBytes: ReadonlyArray<number>;
}

export interface BinaryRomEditScriptStepArgsResponse {
  readonly stepFileOffset: number;
  readonly opcodeByte: number;
  readonly bytesWritten: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomScriptStepArgsRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditScriptStepArgsRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/script-step-args',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (
        !body ||
        typeof body.stepFileOffset !== 'number' ||
        !Array.isArray(body.argBytes) ||
        body.argBytes.some((b) => typeof b !== 'number' || b < 0 || b > 0xff)
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric stepFileOffset + argBytes array of u8.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root.',
        );
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }

      if (
        body.stepFileOffset < 0 ||
        body.stepFileOffset + 1 + body.argBytes.length > romBytes.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Step offset + args extend past ROM end.`,
        );
      }

      const opcode = romBytes[body.stepFileOffset]!;
      const spec = engineScripts.getGen3OpcodeSpec(opcode);
      if (spec === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No opcode spec for byte 0x${opcode.toString(16)} at 0x${body.stepFileOffset.toString(16)} - refusing to write args for an unknown opcode.`,
        );
      }
      if (spec.argBytes !== body.argBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Opcode ${spec.name} (0x${opcode.toString(16)}) expects ${String(spec.argBytes)} arg bytes, got ${String(body.argBytes.length)}.`,
        );
      }

      // Backup if needed.
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(
            reply,
            500,
            'internal_error',
            `Failed to write ROM backup at ${backupPath}: ${String(e)}`,
          );
        }
      }

      // Apply.
      const out = Buffer.from(romBytes);
      for (let i = 0; i < body.argBytes.length; i++) {
        out[body.stepFileOffset + 1 + i] = body.argBytes[i]!;
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          `Failed to write ROM: ${String(e)}`,
        );
      }

      const response: BinaryRomEditScriptStepArgsResponse = {
        stepFileOffset: body.stepFileOffset,
        opcodeByte: opcode,
        bytesWritten: body.argBytes.length,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.23 - Trainerbattle step trainerId partial writer
//
// POST /api/projects/:id/binary-rom-edit/start-battle-trainer-id
//   body: { stepFileOffset, trainerId: number }
//
// Targets the trainerbattle opcode (0x5C). Layout per Gen-3 conventions:
//   +0x00 u8  opcode (must be 0x5C)
//   +0x01 u8  battleType (varies, 0..9)
//   +0x02 u16 trainerId  ← the only field we touch
//   +0x04 u16 second u16
//   +0x06 ...variable script pointers per battleType
//
// Writes only the 2-byte trainerId. The other variable bytes are
// preserved untouched. Reusing the generic script-step-args route
// won't work because the trailing bytes' count depends on battleType
// and writing all of them would require reading first.
// ─────────────────────────────────────────────────────────────────────

const TRAINERBATTLE_OPCODE = 0x5c;

export interface BinaryRomEditStartBattleTrainerIdRequest {
  readonly stepFileOffset: number;
  readonly trainerId: number;
}

export interface BinaryRomEditStartBattleTrainerIdResponse {
  readonly stepFileOffset: number;
  readonly trainerId: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomStartBattleTrainerIdRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditStartBattleTrainerIdRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/start-battle-trainer-id',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.stepFileOffset !== 'number' ||
        typeof body.trainerId !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric stepFileOffset and trainerId.',
        );
      }
      if (body.trainerId < 0 || body.trainerId > 0xffff) {
        return errorResponse(reply, 400, 'internal_error', 'trainerId out of u16 range.');
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (body.stepFileOffset < 0 || body.stepFileOffset + 4 > romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'stepFileOffset out of ROM bounds (need at least 4 bytes for opcode+type+trainerId).',
        );
      }
      // Sanity: confirm opcode at stepFileOffset is trainerbattle.
      const observedOpcode = romBytes[body.stepFileOffset]!;
      if (observedOpcode !== TRAINERBATTLE_OPCODE) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Opcode mismatch at offset 0x${body.stepFileOffset.toString(16)} - expected trainerbattle (0x${TRAINERBATTLE_OPCODE.toString(16)}), found 0x${observedOpcode.toString(16)}. Re-scan to refresh script step offsets.`,
        );
      }

      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();
      // Write u16 trainerId at stepFileOffset + 2 (skipping opcode + battleType).
      out[body.stepFileOffset + 2] = body.trainerId & 0xff;
      out[body.stepFileOffset + 3] = (body.trainerId >> 8) & 0xff;

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditStartBattleTrainerIdResponse = {
        stepFileOffset: body.stepFileOffset,
        trainerId: body.trainerId,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.26 - Single-byte movement action writer
//
// POST /api/projects/:id/binary-rom-edit/movement-action-byte
//   body: { movementDataOffset, actionIndex, newActionByte }
//
// Movement byte arrays live at applymovement's movementPtr target
// (file offset = movementPtr − GBA_ROM_BASE). Each action is one u8.
// The array is terminated by 0xFE (MOVEMENT_END_BYTE).
//
// This route patches exactly one byte at movementDataOffset +
// actionIndex. Refuses to write at or past the END sentinel - that
// would either truncate or grow the sequence (both require relocation
// for the grow case + adjacent-step shifting for truncation).
//
// Use case: change "Walk normal down" → "Walk fast down" in an NPC's
// follow-me cutscene without rewriting the whole sequence.
// ─────────────────────────────────────────────────────────────────────

const MOVEMENT_END_BYTE = 0xfe;
const MOVEMENT_MAX_INDEX = 255;

export interface BinaryRomEditMovementActionByteRequest {
  readonly movementDataOffset: number;
  readonly actionIndex: number;
  readonly newActionByte: number;
}

export interface BinaryRomEditMovementActionByteResponse {
  readonly movementDataOffset: number;
  readonly actionIndex: number;
  readonly newActionByte: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMovementActionByteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditMovementActionByteRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/movement-action-byte',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.movementDataOffset !== 'number' ||
        typeof body.actionIndex !== 'number' ||
        typeof body.newActionByte !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric movementDataOffset, actionIndex, newActionByte.',
        );
      }
      if (body.newActionByte < 0 || body.newActionByte > 0xff) {
        return errorResponse(reply, 400, 'internal_error', 'newActionByte out of u8 range.');
      }
      if (body.actionIndex < 0 || body.actionIndex > MOVEMENT_MAX_INDEX) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `actionIndex ${String(body.actionIndex)} out of plausible range (0..${String(MOVEMENT_MAX_INDEX)}).`,
        );
      }
      if (body.movementDataOffset < 0) {
        return errorResponse(reply, 400, 'internal_error', 'movementDataOffset out of bounds.');
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const byteOffset = body.movementDataOffset + body.actionIndex;
      if (byteOffset < 0 || byteOffset >= romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Resolved byte offset is out of ROM bounds.',
        );
      }
      // Refuse to overwrite the END sentinel - would grow the sequence.
      const currentByte = romBytes[byteOffset]!;
      if (currentByte === MOVEMENT_END_BYTE) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Byte at actionIndex ${String(body.actionIndex)} is the END sentinel (0xFE) - refusing to overwrite (would grow the sequence; needs a separate relocation route).`,
        );
      }
      // Refuse to write END at non-terminal position - would truncate.
      if (body.newActionByte === MOVEMENT_END_BYTE) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'newActionByte 0xFE would truncate the sequence - use a sequence-delete route (deferred).',
        );
      }

      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();
      out[byteOffset] = body.newActionByte;

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditMovementActionByteResponse = {
        movementDataOffset: body.movementDataOffset,
        actionIndex: body.actionIndex,
        newActionByte: body.newActionByte,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase I.4 - Binary-ROM map header write route
//
// POST /api/projects/:id/binary-rom-edit/map-header
//   body: { mapHeaderOffset, fields: { musicId?, regionMapSectionId?,
//                                       weather?, mapType?, battleType?,
//                                       caveOrType?, flags? } }
//   → patches the relevant u8/u16 fields inside the 28-byte MapHeader
//     struct in place. Music id is u16 at +0x14, regionMapSectionId
//     is u8 at +0x16, weather u8 at +0x18, mapType u8 at +0x19,
//     battleType u8 at +0x1A, flags u8 at +0x1B (FRLG; RSE differs).
//     We don't try to detect family here - caller supplies the offset
//     and the fields layout matches both FRLG + RSE for the fields we
//     expose (music + section id are at the same offsets).
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditMapHeaderRequest {
  readonly mapHeaderOffset: number;
  readonly fields: {
    readonly musicId?: number;
    readonly regionMapSectionId?: number;
    readonly weather?: number;
    readonly mapType?: number;
    readonly battleType?: number;
    readonly caveOrType?: number;
    readonly flags?: number;
  };
}

export interface BinaryRomEditMapHeaderResponse {
  readonly mapHeaderOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

// MapHeader struct layout (FRLG/RSE) - the fields we touch share offsets
// across families. Verified against pret/pokefirered include/global.map.h.
const MAP_HEADER_FIELD_OFFSETS: Readonly<
  Record<
    keyof BinaryRomEditMapHeaderRequest['fields'],
    { offset: number; bytes: 1 | 2 }
  >
> = {
  musicId: { offset: 0x14, bytes: 2 },
  regionMapSectionId: { offset: 0x16, bytes: 1 },
  weather: { offset: 0x18, bytes: 1 },
  mapType: { offset: 0x19, bytes: 1 },
  battleType: { offset: 0x1a, bytes: 1 },
  flags: { offset: 0x1b, bytes: 1 },
  caveOrType: { offset: 0x17, bytes: 1 },
};

export function registerBinaryRomMapHeaderEditRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditMapHeaderRequest }>(
    '/api/projects/:id/binary-rom-edit/map-header',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (
        !body ||
        typeof body.mapHeaderOffset !== 'number' ||
        !body.fields ||
        typeof body.fields !== 'object'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric mapHeaderOffset and fields object.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(
          reply,
          400,
          'no_rom_file',
          'No .gba file found in this project root.',
        );
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }
      const MAP_HEADER_SIZE = 28;
      if (body.mapHeaderOffset < 0 || body.mapHeaderOffset + MAP_HEADER_SIZE > romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Map header @ 0x${body.mapHeaderOffset.toString(16)} extends past ROM end.`,
        );
      }

      // Validate fields + bounds.
      const fieldEntries = Object.entries(body.fields).filter(
        ([, v]) => typeof v === 'number',
      ) as Array<[keyof typeof MAP_HEADER_FIELD_OFFSETS, number]>;
      for (const [key, value] of fieldEntries) {
        const spec = MAP_HEADER_FIELD_OFFSETS[key];
        if (!spec) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Unknown map header field '${key}'.`,
          );
        }
        const max = spec.bytes === 1 ? 0xff : 0xffff;
        if (value < 0 || value > max) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Field ${key} value ${String(value)} exceeds ${spec.bytes}-byte range (0..${String(max)}).`,
          );
        }
      }

      // Backup if needed.
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(
            reply,
            500,
            'internal_error',
            `Failed to write ROM backup: ${String(e)}`,
          );
        }
      }

      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const fieldsWritten: string[] = [];
      for (const [key, value] of fieldEntries) {
        const spec = MAP_HEADER_FIELD_OFFSETS[key];
        if (!spec) continue;
        const at = body.mapHeaderOffset + spec.offset;
        if (spec.bytes === 1) {
          view.setUint8(at, value);
        } else {
          view.setUint16(at, value, true);
        }
        fieldsWritten.push(key);
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          `Failed to write ROM: ${String(e)}`,
        );
      }

      const response: BinaryRomEditMapHeaderResponse = {
        mapHeaderOffset: body.mapHeaderOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase J.1 - Binary-ROM trigger field write route
//
// POST /api/projects/:id/binary-rom-edit/trigger-fields
//   body: { triggerKind: 'bg' | 'coord', structFileOffset, fields }
//
//   bg:    fields.bgEventKind (u8 at +0x05)
//          fields.elevation (u8 at +0x04)
//          fields.hiddenItemId (u16 at +0x08) - kinds 5/7 only
//          fields.hiddenItemFlagOffset (u8 at +0x0A) - kinds 5/7 only
//          fields.hiddenItemQuantity (u8 at +0x0B) - kinds 5/7 only
//   coord: fields.coordTriggerVar (u16 at +0x06)
//          fields.coordTriggerIndex (u16 at +0x08)
//          fields.elevation (u8 at +0x04)
//
// Validates value ranges, writes in place + .bak.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditTriggerFieldsRequest {
  readonly triggerKind: 'bg' | 'coord';
  readonly structFileOffset: number;
  readonly fields: {
    readonly bgEventKind?: number;
    readonly coordTriggerVar?: number;
    readonly coordTriggerIndex?: number;
    readonly elevation?: number;
    readonly hiddenItemId?: number;
    readonly hiddenItemFlagOffset?: number;
    readonly hiddenItemQuantity?: number;
  };
}

export interface BinaryRomEditTriggerFieldsResponse {
  readonly structFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomTriggerEditRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditTriggerFieldsRequest }>(
    '/api/projects/:id/binary-rom-edit/trigger-fields',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (
        !body ||
        (body.triggerKind !== 'bg' && body.triggerKind !== 'coord') ||
        typeof body.structFileOffset !== 'number' ||
        !body.fields ||
        typeof body.fields !== 'object'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include triggerKind (bg|coord), structFileOffset, and fields object.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to read ROM: ${String(e)}`);
      }

      const structSize = body.triggerKind === 'coord' ? 16 : 12;
      if (
        body.structFileOffset < 0 ||
        body.structFileOffset + structSize > romBytes.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Trigger struct @ 0x${body.structFileOffset.toString(16)} extends past ROM end.`,
        );
      }

      // Validate ranges.
      const f = body.fields;
      if (f.bgEventKind !== undefined && (f.bgEventKind < 0 || f.bgEventKind > 0xff)) {
        return errorResponse(reply, 400, 'internal_error', 'bgEventKind out of u8 range.');
      }
      if (
        f.coordTriggerVar !== undefined &&
        (f.coordTriggerVar < 0 || f.coordTriggerVar > 0xffff)
      ) {
        return errorResponse(reply, 400, 'internal_error', 'coordTriggerVar out of u16 range.');
      }
      if (
        f.coordTriggerIndex !== undefined &&
        (f.coordTriggerIndex < 0 || f.coordTriggerIndex > 0xffff)
      ) {
        return errorResponse(reply, 400, 'internal_error', 'coordTriggerIndex out of u16 range.');
      }
      if (f.elevation !== undefined && (f.elevation < 0 || f.elevation > 0xff)) {
        return errorResponse(reply, 400, 'internal_error', 'elevation out of u8 range.');
      }
      if (
        f.hiddenItemId !== undefined &&
        (f.hiddenItemId < 0 || f.hiddenItemId > 0xffff)
      ) {
        return errorResponse(reply, 400, 'internal_error', 'hiddenItemId out of u16 range.');
      }
      if (
        f.hiddenItemFlagOffset !== undefined &&
        (f.hiddenItemFlagOffset < 0 || f.hiddenItemFlagOffset > 0xff)
      ) {
        return errorResponse(reply, 400, 'internal_error', 'hiddenItemFlagOffset out of u8 range.');
      }
      if (
        f.hiddenItemQuantity !== undefined &&
        (f.hiddenItemQuantity < 0 || f.hiddenItemQuantity > 0xff)
      ) {
        return errorResponse(reply, 400, 'internal_error', 'hiddenItemQuantity out of u8 range.');
      }
      if (
        (f.hiddenItemId !== undefined ||
          f.hiddenItemFlagOffset !== undefined ||
          f.hiddenItemQuantity !== undefined) &&
        body.triggerKind !== 'bg'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Hidden-item fields only apply to triggerKind=bg.',
        );
      }

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(
            reply,
            500,
            'internal_error',
            `Failed to write ROM backup: ${String(e)}`,
          );
        }
      }

      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const fieldsWritten: string[] = [];
      if (f.elevation !== undefined) {
        view.setUint8(body.structFileOffset + 0x04, f.elevation);
        fieldsWritten.push('elevation');
      }
      if (body.triggerKind === 'bg' && f.bgEventKind !== undefined) {
        view.setUint8(body.structFileOffset + 0x05, f.bgEventKind);
        fieldsWritten.push('bgEventKind');
      }
      if (body.triggerKind === 'coord' && f.coordTriggerVar !== undefined) {
        view.setUint16(body.structFileOffset + 0x06, f.coordTriggerVar, true);
        fieldsWritten.push('coordTriggerVar');
      }
      if (body.triggerKind === 'coord' && f.coordTriggerIndex !== undefined) {
        view.setUint16(body.structFileOffset + 0x08, f.coordTriggerIndex, true);
        fieldsWritten.push('coordTriggerIndex');
      }
      if (body.triggerKind === 'bg' && f.hiddenItemId !== undefined) {
        view.setUint16(body.structFileOffset + 0x08, f.hiddenItemId, true);
        fieldsWritten.push('hiddenItemId');
      }
      if (body.triggerKind === 'bg' && f.hiddenItemFlagOffset !== undefined) {
        view.setUint8(body.structFileOffset + 0x0a, f.hiddenItemFlagOffset);
        fieldsWritten.push('hiddenItemFlagOffset');
      }
      if (body.triggerKind === 'bg' && f.hiddenItemQuantity !== undefined) {
        view.setUint8(body.structFileOffset + 0x0b, f.hiddenItemQuantity);
        fieldsWritten.push('hiddenItemQuantity');
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Failed to write ROM: ${String(e)}`);
      }

      const response: BinaryRomEditTriggerFieldsResponse = {
        structFileOffset: body.structFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.42 step 3/5 - Heal location write route
//
// POST /api/projects/:id/binary-rom-edit/heal-location
//   body: { sourceFileOffset, fields: { group?, mapNum?, x?, y? } }
//
// Patches the 6-byte HealLocation struct in place:
//   +0x00 u8  group
//   +0x01 u8  mapNum
//   +0x02 s16 x
//   +0x04 s16 y
//
// Validates value ranges (group ≤ 50, mapNum ≤ 200, x/y ∈ [0, 511] - 
// same caps the detector uses; rejects out-of-bound writes that would
// either be obvious corruption or violate the heal-locations heuristic
// on the next re-scan). Writes in place + .bak. Mirrors the
// trigger-fields route pattern.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditHealLocationRequest {
  readonly sourceFileOffset: number;
  readonly fields: {
    readonly group?: number;
    readonly mapNum?: number;
    readonly x?: number;
    readonly y?: number;
  };
}

export interface BinaryRomEditHealLocationResponse {
  readonly sourceFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

const HEAL_LOCATION_STRUCT_SIZE = 6;
const HEAL_LOC_GROUP_MAX = 50;
const HEAL_LOC_MAP_NUM_MAX = 200;
const HEAL_LOC_COORD_MIN = 0;
const HEAL_LOC_COORD_MAX = 511;

export function registerBinaryRomHealLocationEditRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditHealLocationRequest }>(
    '/api/projects/:id/binary-rom-edit/heal-location',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(
          reply,
          404,
          'session_not_found',
          `Session '${req.params.id}' not found`,
        );
      }
      const body = req.body;
      if (
        !body ||
        typeof body.sourceFileOffset !== 'number' ||
        !body.fields ||
        typeof body.fields !== 'object'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include sourceFileOffset and fields object.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          `Failed to read ROM: ${String(e)}`,
        );
      }
      if (
        body.sourceFileOffset < 0 ||
        body.sourceFileOffset + HEAL_LOCATION_STRUCT_SIZE > romBytes.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Heal location struct @ 0x${body.sourceFileOffset.toString(16)} extends past ROM end.`,
        );
      }
      const f = body.fields;
      if (f.group !== undefined && (f.group < 0 || f.group > HEAL_LOC_GROUP_MAX)) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `group out of range (0..${String(HEAL_LOC_GROUP_MAX)}).`,
        );
      }
      if (
        f.mapNum !== undefined &&
        (f.mapNum < 0 || f.mapNum > HEAL_LOC_MAP_NUM_MAX)
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `mapNum out of range (0..${String(HEAL_LOC_MAP_NUM_MAX)}).`,
        );
      }
      if (
        f.x !== undefined &&
        (f.x < HEAL_LOC_COORD_MIN || f.x > HEAL_LOC_COORD_MAX)
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `x out of range (${String(HEAL_LOC_COORD_MIN)}..${String(HEAL_LOC_COORD_MAX)}).`,
        );
      }
      if (
        f.y !== undefined &&
        (f.y < HEAL_LOC_COORD_MIN || f.y > HEAL_LOC_COORD_MAX)
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `y out of range (${String(HEAL_LOC_COORD_MIN)}..${String(HEAL_LOC_COORD_MAX)}).`,
        );
      }

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(
            reply,
            500,
            'internal_error',
            `Failed to write ROM backup: ${String(e)}`,
          );
        }
      }

      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const fieldsWritten: string[] = [];
      if (f.group !== undefined) {
        view.setUint8(body.sourceFileOffset + 0x00, f.group);
        fieldsWritten.push('group');
      }
      if (f.mapNum !== undefined) {
        view.setUint8(body.sourceFileOffset + 0x01, f.mapNum);
        fieldsWritten.push('mapNum');
      }
      if (f.x !== undefined) {
        view.setInt16(body.sourceFileOffset + 0x02, f.x, true);
        fieldsWritten.push('x');
      }
      if (f.y !== undefined) {
        view.setInt16(body.sourceFileOffset + 0x04, f.y, true);
        fieldsWritten.push('y');
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          `Failed to write ROM: ${String(e)}`,
        );
      }

      const response: BinaryRomEditHealLocationResponse = {
        sourceFileOffset: body.sourceFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase J.3 / O.16 - Map dimensions write route (shrink in place,
// grow via primary-blocks buffer relocation)
//
// POST /api/projects/:id/binary-rom-edit/map-dimensions
//   body: { layoutFileOffset, currentWidth, currentHeight, newWidth, newHeight }
//   → patches the width + height u32 fields inside the MapLayout
//     struct at layoutFileOffset. When growing past the original
//     allocation, allocates a new primaryBlocks buffer in free ROM
//     space, copies existing cells (top-left aligned with 0-fill for
//     new area), and rewrites the primaryBlocksPtr u32. MapLayout
//     struct per pret/pokefirered include/global.fieldmap.h:
//       +0x00 u32 width
//       +0x04 u32 height
//       +0x08 const u16* borderBlocks
//       +0x0C const u16* primaryBlocks
//       +0x10 const struct Tileset* primaryTileset
//       +0x14 const struct Tileset* secondaryTileset
//
// Each cell is 2 bytes (u16: low 10 bits = metatile id, top 6 bits
// = collision/elevation). Grow copies existing cells row-by-row at
// the same (x, y) and 0-fills the new rows/columns. Old buffer left
// in place (fixed-cost waste; acceptable per O.6 precedent).
// ─────────────────────────────────────────────────────────────────────

const MAP_LAYOUT_WIDTH_OFFSET = 0x00;
const MAP_LAYOUT_HEIGHT_OFFSET = 0x04;
const MAP_LAYOUT_PRIMARY_BLOCKS_PTR_OFFSET = 0x0c;
const MAP_LAYOUT_STRUCT_BYTES = 0x18; // covers all 6 fields
const MAP_CELL_BYTES = 2;
const MAP_MAX_DIMENSION = 256; // sanity cap; vanilla Gen-3 maps top out at ~80x80

export interface BinaryRomEditMapDimensionsRequest {
  readonly layoutFileOffset: number;
  readonly currentWidth: number;
  readonly currentHeight: number;
  readonly newWidth: number;
  readonly newHeight: number;
}

export interface BinaryRomEditMapDimensionsResponse {
  readonly layoutFileOffset: number;
  readonly newWidth: number;
  readonly newHeight: number;
  /** When grow triggered relocation, this is the new primaryBlocks
   *  ROM pointer; when shrinking in place, equals the prior value. */
  readonly newPrimaryBlocksPointer: number;
  readonly relocated: boolean;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMapDimensionsRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditMapDimensionsRequest }>(
    '/api/projects/:id/binary-rom-edit/map-dimensions',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session not found`);
      }
      const body = req.body;
      if (
        !body ||
        typeof body.layoutFileOffset !== 'number' ||
        typeof body.currentWidth !== 'number' ||
        typeof body.currentHeight !== 'number' ||
        typeof body.newWidth !== 'number' ||
        typeof body.newHeight !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include layoutFileOffset, currentWidth, currentHeight, newWidth, newHeight.',
        );
      }
      if (body.newWidth < 1 || body.newHeight < 1) {
        return errorResponse(reply, 400, 'internal_error', 'newWidth + newHeight must be ≥ 1.');
      }
      if (body.newWidth > MAP_MAX_DIMENSION || body.newHeight > MAP_MAX_DIMENSION) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `new dimensions exceed sanity cap (${String(MAP_MAX_DIMENSION)}×${String(MAP_MAX_DIMENSION)}).`,
        );
      }
      if (body.currentWidth < 1 || body.currentHeight < 1) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'currentWidth + currentHeight must be ≥ 1.',
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (
        body.layoutFileOffset < 0 ||
        body.layoutFileOffset + MAP_LAYOUT_STRUCT_BYTES > romBytes.length
      ) {
        return errorResponse(reply, 400, 'internal_error', `Layout offset out of bounds.`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

      const newCells = body.newWidth * body.newHeight;
      const currentCells = body.currentWidth * body.currentHeight;
      const isGrow = newCells > currentCells;

      let newPrimaryBlocksPointer = view.getUint32(
        body.layoutFileOffset + MAP_LAYOUT_PRIMARY_BLOCKS_PTR_OFFSET,
        true,
      );
      let relocated = false;

      if (isGrow) {
        // Read current primaryBlocks pointer and resolve.
        const oldPtr = newPrimaryBlocksPointer;
        if (
          oldPtr < GBA_ROM_BASE_PTR ||
          oldPtr >= GBA_ROM_BASE_PTR + 0x02000000
        ) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Map's primaryBlocks pointer 0x${oldPtr.toString(16)} not in ROM range; cannot grow.`,
          );
        }
        const oldOff = oldPtr - GBA_ROM_BASE_PTR;
        const oldBytes = currentCells * MAP_CELL_BYTES;
        if (oldOff < 0 || oldOff + oldBytes > out.length) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'Current primaryBlocks buffer resolves outside ROM bounds; cannot grow.',
          );
        }
        const newBytes = newCells * MAP_CELL_BYTES;
        // Build new buffer (top-left aligned copy, 0-fill new area).
        const newBuf = new Uint8Array(newBytes); // already zero-filled
        const copyRows = Math.min(body.currentHeight, body.newHeight);
        const copyColsBytes = Math.min(body.currentWidth, body.newWidth) * MAP_CELL_BYTES;
        for (let y = 0; y < copyRows; y++) {
          const srcOff = oldOff + y * body.currentWidth * MAP_CELL_BYTES;
          const dstOff = y * body.newWidth * MAP_CELL_BYTES;
          newBuf.set(out.subarray(srcOff, srcOff + copyColsBytes), dstOff);
        }
        // Allocate free space for the new buffer.
        const alloc = engineRom.findFreeRomSpace(out, newBytes);
        if (alloc === null) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `No free ROM space for ${String(newBytes)} bytes of new primaryBlocks buffer.`,
          );
        }
        out.set(newBuf, alloc.offset);
        newPrimaryBlocksPointer = (GBA_ROM_BASE_PTR + alloc.offset) >>> 0;
        relocated = true;
      }
      // For shrink: leave buffer in place; existing bytes past the new
      // W×H window are no longer reachable but stay as-is (cheap).

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }

      // Patch width + height. When relocated, also patch the
      // primaryBlocks pointer.
      view.setUint32(body.layoutFileOffset + MAP_LAYOUT_WIDTH_OFFSET, body.newWidth, true);
      view.setUint32(body.layoutFileOffset + MAP_LAYOUT_HEIGHT_OFFSET, body.newHeight, true);
      if (relocated) {
        view.setUint32(
          body.layoutFileOffset + MAP_LAYOUT_PRIMARY_BLOCKS_PTR_OFFSET,
          newPrimaryBlocksPointer,
          true,
        );
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditMapDimensionsResponse = {
        layoutFileOffset: body.layoutFileOffset,
        newWidth: body.newWidth,
        newHeight: body.newHeight,
        newPrimaryBlocksPointer,
        relocated,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase J.7 + J.8 - Object-event table add/delete (true delete with shift)
//
// POST /api/projects/:id/binary-rom-edit/object-event-table
//   body: {
//     mapEventsStructOffset,   // 20-byte MapEvents struct
//     objectEventsArrayOffset, // start of ObjectEvent[] array
//     op: 'delete'|'append',
//     deleteStructFileOffset?: number,   // delete: struct file offset of the slot to remove
//     newObject?: {                       // append: bytes for the new 24-byte slot
//       graphicsId, x, y, elevation, movementType, movementRangeXY,
//       trainerType, trainerSightOrBerryTreeId, scriptPointer, flagId
//     }
//   }
//
// Delete: shifts subsequent slots down by 24 bytes, zeroes the last
// slot, decrements the count byte at mapEventsStructOffset+0.
// Append: increments the count byte, writes a fresh 24-byte slot at
// the new index. The caller is responsible for ensuring the allocated
// buffer has room - we conservatively allow append IF the new count
// stays within a reasonable cap (256) without inspecting the buffer's
// real allocation (Gen-3 doesn't expose it). On real ROMs this is
// usually safe for ≤ 8 added slots; aggressive use may corrupt the
// next adjacent struct. Use with caution.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditObjectEventTableRequest {
  readonly mapEventsStructOffset: number;
  readonly objectEventsArrayOffset: number;
  readonly op: 'delete' | 'append';
  readonly deleteStructFileOffset?: number;
  readonly newObject?: {
    readonly localId: number;
    readonly graphicsId: number;
    readonly x: number;
    readonly y: number;
    readonly elevation: number;
    readonly movementType: number;
    readonly movementRangeXY: number;
    readonly trainerType: number;
    readonly trainerSightOrBerryTreeId: number;
    readonly scriptPointer: number;
    readonly flagId: number;
  };
}

export interface BinaryRomEditObjectEventTableResponse {
  readonly op: 'delete' | 'append';
  readonly newCount: number;
  readonly mutatedStructOffset: number;
  readonly backupCreated: boolean;
}

const OBJECT_EVENT_TEMPLATE_SIZE = 24;

export function registerBinaryRomObjectEventTableRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditObjectEventTableRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/object-event-table',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (
        !body ||
        typeof body.mapEventsStructOffset !== 'number' ||
        typeof body.objectEventsArrayOffset !== 'number' ||
        (body.op !== 'delete' && body.op !== 'append')
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include mapEventsStructOffset, objectEventsArrayOffset, and op (delete|append).',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (
        body.mapEventsStructOffset < 0 ||
        body.mapEventsStructOffset + 20 > romBytes.length ||
        body.objectEventsArrayOffset < 0 ||
        body.objectEventsArrayOffset >= romBytes.length
      ) {
        return errorResponse(reply, 400, 'internal_error', 'Offsets out of ROM bounds.');
      }
      // Count is u8 at +0x00 of MapEvents.
      const currentCount = romBytes[body.mapEventsStructOffset]!;
      if (currentCount === 0xff) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Count byte appears uninitialized (0xFF) - refusing to mutate.',
        );
      }

      // Backup if needed.
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }

      const out = Buffer.from(romBytes);

      let newCount = currentCount;
      let mutatedStructOffset = 0;

      if (body.op === 'delete') {
        if (typeof body.deleteStructFileOffset !== 'number') {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'op=delete requires deleteStructFileOffset.',
          );
        }
        const idx =
          (body.deleteStructFileOffset - body.objectEventsArrayOffset) /
          OBJECT_EVENT_TEMPLATE_SIZE;
        if (!Number.isInteger(idx) || idx < 0 || idx >= currentCount) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Delete offset doesn't align to a slot index (idx=${String(idx)}, count=${String(currentCount)}).`,
          );
        }
        // Shift slots [idx+1..count-1] down by one slot.
        const arrayEndExclusive =
          body.objectEventsArrayOffset + currentCount * OBJECT_EVENT_TEMPLATE_SIZE;
        if (arrayEndExclusive > out.length) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'Array extends past ROM end.',
          );
        }
        const bytesToShift = (currentCount - 1 - idx) * OBJECT_EVENT_TEMPLATE_SIZE;
        if (bytesToShift > 0) {
          out.copy(
            out,
            body.objectEventsArrayOffset + idx * OBJECT_EVENT_TEMPLATE_SIZE,
            body.objectEventsArrayOffset + (idx + 1) * OBJECT_EVENT_TEMPLATE_SIZE,
            arrayEndExclusive,
          );
        }
        // Zero the now-unused last slot.
        const lastSlotStart = arrayEndExclusive - OBJECT_EVENT_TEMPLATE_SIZE;
        for (let i = 0; i < OBJECT_EVENT_TEMPLATE_SIZE; i++) {
          out[lastSlotStart + i] = 0;
        }
        newCount = currentCount - 1;
        mutatedStructOffset = body.objectEventsArrayOffset + idx * OBJECT_EVENT_TEMPLATE_SIZE;
        out[body.mapEventsStructOffset] = newCount;
      } else {
        // Append.
        if (!body.newObject) {
          return errorResponse(reply, 400, 'internal_error', 'op=append requires newObject.');
        }
        if (currentCount >= 0xff) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'Count already at u8 max (255).',
          );
        }
        const newSlotStart =
          body.objectEventsArrayOffset + currentCount * OBJECT_EVENT_TEMPLATE_SIZE;
        if (newSlotStart + OBJECT_EVENT_TEMPLATE_SIZE > out.length) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'New slot would extend past ROM end.',
          );
        }
        const view = new DataView(out.buffer, out.byteOffset, out.length);
        const o = body.newObject;
        view.setUint8(newSlotStart + 0x00, o.localId & 0xff);
        view.setUint8(newSlotStart + 0x01, o.graphicsId & 0xff);
        view.setUint8(newSlotStart + 0x02, 1); // kind (1 = normal). Hardcode for now.
        view.setUint8(newSlotStart + 0x03, 0); // padding
        view.setInt16(newSlotStart + 0x04, o.x, true);
        view.setInt16(newSlotStart + 0x06, o.y, true);
        view.setUint8(newSlotStart + 0x08, o.elevation & 0xff);
        view.setUint8(newSlotStart + 0x09, o.movementType & 0xff);
        view.setUint8(newSlotStart + 0x0a, o.movementRangeXY & 0xff);
        view.setUint8(newSlotStart + 0x0b, 0); // padding
        view.setUint16(newSlotStart + 0x0c, o.trainerType & 0xffff, true);
        view.setUint16(newSlotStart + 0x0e, o.trainerSightOrBerryTreeId & 0xffff, true);
        view.setUint32(newSlotStart + 0x10, o.scriptPointer >>> 0, true);
        view.setUint16(newSlotStart + 0x14, o.flagId & 0xffff, true);
        view.setUint16(newSlotStart + 0x16, 0, true); // padding3
        newCount = currentCount + 1;
        mutatedStructOffset = newSlotStart;
        out[body.mapEventsStructOffset] = newCount;
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditObjectEventTableResponse = {
        op: body.op,
        newCount,
        mutatedStructOffset,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase M.1 - Species (BaseStats) struct field writer
//
// 28-byte BaseStats struct (Gen-3):
//   +0x00 u8 baseHP, +0x01 baseAttack, +0x02 baseDefense, +0x03 baseSpeed
//   +0x04 u8 baseSpAttack, +0x05 baseSpDefense
//   +0x06 u8 type1, +0x07 u8 type2
//   +0x08 u8 catchRate, +0x09 u8 expYield
//   +0x0A u16 evYield (packed bitfield - left untouched)
//   +0x0C u16 item1, +0x0E u16 item2
//   +0x10 u8 genderRatio, +0x11 u8 eggCycles, +0x12 u8 friendship
//   +0x13 u8 growthRate, +0x14 u8 eggGroup1, +0x15 u8 eggGroup2
//   +0x16 u8 ability1, +0x17 u8 ability2
//   +0x18 u8 safariZoneFleeRate
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditSpeciesFieldsRequest {
  readonly sourceFileOffset: number;
  readonly fields: Readonly<Record<string, number>>;
}
export interface BinaryRomEditSpeciesFieldsResponse {
  readonly sourceFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

const SPECIES_FIELD_LAYOUT: Readonly<Record<string, { offset: number; bytes: 1 | 2 }>> = {
  baseHP: { offset: 0x00, bytes: 1 },
  baseAttack: { offset: 0x01, bytes: 1 },
  baseDefense: { offset: 0x02, bytes: 1 },
  baseSpeed: { offset: 0x03, bytes: 1 },
  baseSpAttack: { offset: 0x04, bytes: 1 },
  baseSpDefense: { offset: 0x05, bytes: 1 },
  type1: { offset: 0x06, bytes: 1 },
  type2: { offset: 0x07, bytes: 1 },
  catchRate: { offset: 0x08, bytes: 1 },
  expYield: { offset: 0x09, bytes: 1 },
  item1: { offset: 0x0c, bytes: 2 },
  item2: { offset: 0x0e, bytes: 2 },
  genderRatio: { offset: 0x10, bytes: 1 },
  eggCycles: { offset: 0x11, bytes: 1 },
  friendship: { offset: 0x12, bytes: 1 },
  growthRate: { offset: 0x13, bytes: 1 },
  eggGroup1: { offset: 0x14, bytes: 1 },
  eggGroup2: { offset: 0x15, bytes: 1 },
  ability1: { offset: 0x16, bytes: 1 },
  ability2: { offset: 0x17, bytes: 1 },
  safariZoneFleeRate: { offset: 0x18, bytes: 1 },
};

// 12-byte BattleMove struct:
//   +0x00 u8 effect, +0x01 u8 power, +0x02 u8 type, +0x03 u8 accuracy
//   +0x04 u8 pp, +0x05 u8 secondaryEffectChance
//   +0x06 u8 target, +0x07 s8 priority
//   +0x08 u8 flags, +0x09 u8 split
const MOVE_FIELD_LAYOUT: Readonly<Record<string, { offset: number; bytes: 1; signed?: boolean }>> = {
  effect: { offset: 0x00, bytes: 1 },
  power: { offset: 0x01, bytes: 1 },
  type: { offset: 0x02, bytes: 1 },
  accuracy: { offset: 0x03, bytes: 1 },
  pp: { offset: 0x04, bytes: 1 },
  secondaryEffectChance: { offset: 0x05, bytes: 1 },
  target: { offset: 0x06, bytes: 1 },
  priority: { offset: 0x07, bytes: 1, signed: true },
  flags: { offset: 0x08, bytes: 1 },
  split: { offset: 0x09, bytes: 1 },
};

// 44-byte Item struct (FRLG/Emerald):
//   +0x10 u16 price, +0x12 u8 holdEffect, +0x13 u8 holdEffectParam,
//   +0x18 u8 importance, +0x1A u8 pocket, +0x1B u8 type
const ITEM_FIELD_LAYOUT: Readonly<Record<string, { offset: number; bytes: 1 | 2 }>> = {
  price: { offset: 0x10, bytes: 2 },
  holdEffect: { offset: 0x12, bytes: 1 },
  holdEffectParam: { offset: 0x13, bytes: 1 },
  importance: { offset: 0x18, bytes: 1 },
  pocket: { offset: 0x1a, bytes: 1 },
  type: { offset: 0x1b, bytes: 1 },
};

type FieldLayout = Readonly<
  Record<string, { offset: number; bytes: 1 | 2; signed?: boolean }>
>;

async function applyStructFieldEdit(args: {
  romPath: string;
  sourceFileOffset: number;
  fields: Readonly<Record<string, number>>;
  layout: FieldLayout;
  structSize: number;
}): Promise<{ fieldsWritten: string[]; backupCreated: boolean }> {
  const romBytes = await fsp.readFile(args.romPath);
  if (args.sourceFileOffset < 0 || args.sourceFileOffset + args.structSize > romBytes.length) {
    throw new Error('Struct offset out of ROM bounds');
  }
  // Validate.
  for (const [key, value] of Object.entries(args.fields)) {
    const spec = args.layout[key];
    if (!spec) throw new Error(`Unknown field '${key}'`);
    if (typeof value !== 'number') throw new Error(`Field '${key}' must be numeric`);
    if (spec.bytes === 1) {
      if (spec.signed) {
        if (value < -128 || value > 127) throw new Error(`'${key}' out of s8 range`);
      } else {
        if (value < 0 || value > 0xff) throw new Error(`'${key}' out of u8 range`);
      }
    } else if (spec.bytes === 2) {
      if (value < 0 || value > 0xffff) throw new Error(`'${key}' out of u16 range`);
    }
  }
  // Backup if needed.
  const backupPath = `${args.romPath}.bak`;
  let backupCreated = false;
  try {
    await fsp.access(backupPath);
  } catch {
    await fsp.copyFile(args.romPath, backupPath);
    backupCreated = true;
  }
  const out = Buffer.from(romBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.length);
  const fieldsWritten: string[] = [];
  for (const [key, value] of Object.entries(args.fields)) {
    const spec = args.layout[key]!;
    const at = args.sourceFileOffset + spec.offset;
    if (spec.bytes === 1) {
      if (spec.signed) view.setInt8(at, value);
      else view.setUint8(at, value);
    } else {
      view.setUint16(at, value, true);
    }
    fieldsWritten.push(key);
  }
  await fsp.writeFile(args.romPath, out);
  return { fieldsWritten, backupCreated };
}

interface StructFieldRequest {
  readonly sourceFileOffset: number;
  readonly fields: Readonly<Record<string, number>>;
}

function makeStructFieldRoute(
  endpoint: string,
  layout: FieldLayout,
  structSize: number,
): (deps: RegisterBinaryRomGraphicsRoutesArgs) => void {
  return (deps) => {
    deps.app.post<{ Params: { id: string }; Body: StructFieldRequest }>(endpoint, async (req, reply) => {
      const session = deps.sessionStore.get(req.params.id);
      if (!session) return deps.errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.sourceFileOffset !== 'number' ||
        !body.fields ||
        typeof body.fields !== 'object'
      ) {
        return deps.errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric sourceFileOffset + fields.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return deps.errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      try {
        const result = await applyStructFieldEdit({
          romPath,
          sourceFileOffset: body.sourceFileOffset,
          fields: body.fields,
          layout,
          structSize,
        });
        return {
          sourceFileOffset: body.sourceFileOffset,
          fieldsWritten: result.fieldsWritten,
          backupCreated: result.backupCreated,
        };
      } catch (e) {
        return deps.errorResponse(
          reply,
          400,
          'internal_error',
          e instanceof Error ? e.message : String(e),
        );
      }
    });
  };
}

export const registerBinaryRomSpeciesFieldsRoute = makeStructFieldRoute(
  '/api/projects/:id/binary-rom-edit/species-fields',
  SPECIES_FIELD_LAYOUT,
  28,
);

export const registerBinaryRomMoveFieldsRoute = makeStructFieldRoute(
  '/api/projects/:id/binary-rom-edit/move-fields',
  MOVE_FIELD_LAYOUT,
  12,
);

export const registerBinaryRomItemFieldsRoute = makeStructFieldRoute(
  '/api/projects/:id/binary-rom-edit/item-fields',
  ITEM_FIELD_LAYOUT,
  44,
);

// ─────────────────────────────────────────────────────────────────────
// Phase M.5 - Species evolution + learnset writers
//
// Evolution slot (6 bytes - pret/pokefirered, pokeemerald and pokeruby
// all define `struct Evolution { u16 method; u16 param; u16 targetSpecies; }`,
// with no padding word; EVOS_PER_MON = 5 makes a per-species block 30 bytes):
//   +0x00 u16 method, +0x02 u16 param, +0x04 u16 targetSpecies
//
// Learnset entry (2 bytes packed):
//   bits 0..8  = move id (9 bits)
//   bits 9..15 = level (7 bits)
//   Terminator 0xFFFF
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditEvolutionSlotRequest {
  readonly slotFileOffset: number;
  readonly fields: {
    readonly method?: number;
    readonly param?: number;
    readonly targetSpecies?: number;
  };
}
export interface BinaryRomEditEvolutionSlotResponse {
  readonly slotFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomEvolutionSlotRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditEvolutionSlotRequest }>(
    '/api/projects/:id/binary-rom-edit/species-evolution-slot',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (!body || typeof body.slotFileOffset !== 'number' || !body.fields) {
        return errorResponse(reply, 400, 'internal_error', 'Body must include slotFileOffset + fields');
      }
      const f = body.fields;
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined) continue;
        if (typeof v !== 'number' || v < 0 || v > 0xffff) {
          return errorResponse(reply, 400, 'internal_error', `${k} out of u16 range`);
        }
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (
        body.slotFileOffset < 0 ||
        body.slotFileOffset + engineSpecies.EVOLUTION_STRUCT_SIZE_BYTES > romBytes.length
      ) {
        return errorResponse(reply, 400, 'internal_error', 'Slot offset out of bounds');
      }
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }
      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const fieldsWritten: string[] = [];
      if (f.method !== undefined) {
        view.setUint16(body.slotFileOffset + 0x00, f.method, true);
        fieldsWritten.push('method');
      }
      if (f.param !== undefined) {
        view.setUint16(body.slotFileOffset + 0x02, f.param, true);
        fieldsWritten.push('param');
      }
      if (f.targetSpecies !== undefined) {
        view.setUint16(body.slotFileOffset + 0x04, f.targetSpecies, true);
        fieldsWritten.push('targetSpecies');
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditEvolutionSlotResponse = {
        slotFileOffset: body.slotFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.15 - Species evolution DELETE (in-place slot compaction)
//
// POST /api/projects/:id/binary-rom-edit/species-evolution-delete
//   body: { blockFileOffset, slotIndex, currentPopulatedCount }
//
// Gen-3 stores evolutions as `Evolution[EVOS_PER_MON]` - 5 slots of 6
// bytes each, i.e. a 30-byte block per species (pret/pokefirered,
// pokeemerald and pokeruby all define the struct as three u16 fields
// with no padding word).
// The engine reads slots sequentially, stopping at the FIRST EVO_NONE
// (method == 0). So populated slots MUST be contiguous from index 0
// - a hole truncates trailing evolutions.
//
// Strategy: shift slots [slotIndex+1, currentPopulatedCount-1] left
// by 6 bytes WITHIN the fixed 5-slot window, zero-fill the slot at
// (currentPopulatedCount-1) so it becomes the new EVO_NONE terminator.
// No pointer or count byte to update - the engine's truncation is
// driven entirely by the slot.method == 0 sentinel.
//
// Gates: slotIndex must be < currentPopulatedCount + must be ≤ 4
// (Gen-3 max). currentPopulatedCount must be 1..5.
// ─────────────────────────────────────────────────────────────────────

// Sourced from the engine so the writer can never disagree with the
// reader's `struct Evolution` layout.
const EVOLUTION_SLOT_SIZE_BYTES = engineSpecies.EVOLUTION_STRUCT_SIZE_BYTES;
const EVOLUTION_SLOTS_PER_BLOCK = engineSpecies.EVOLUTION_SLOTS_PER_SPECIES;

export interface BinaryRomEditEvolutionDeleteRequest {
  readonly blockFileOffset: number;
  readonly slotIndex: number;
  readonly currentPopulatedCount: number;
}

export interface BinaryRomEditEvolutionDeleteResponse {
  readonly newPopulatedCount: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomEvolutionDeleteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditEvolutionDeleteRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/species-evolution-delete',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.blockFileOffset !== 'number' ||
        typeof body.slotIndex !== 'number' ||
        typeof body.currentPopulatedCount !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include blockFileOffset, slotIndex, currentPopulatedCount.',
        );
      }
      if (body.blockFileOffset < 0) {
        return errorResponse(reply, 400, 'internal_error', 'blockFileOffset out of bounds.');
      }
      if (
        body.currentPopulatedCount < 1 ||
        body.currentPopulatedCount > EVOLUTION_SLOTS_PER_BLOCK
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `currentPopulatedCount ${String(body.currentPopulatedCount)} must be 1..${String(EVOLUTION_SLOTS_PER_BLOCK)}.`,
        );
      }
      if (body.slotIndex < 0 || body.slotIndex >= body.currentPopulatedCount) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `slotIndex ${String(body.slotIndex)} out of range [0, ${String(body.currentPopulatedCount - 1)}].`,
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      const blockEnd =
        body.blockFileOffset + EVOLUTION_SLOTS_PER_BLOCK * EVOLUTION_SLOT_SIZE_BYTES;
      if (blockEnd > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'EvolutionBlock 30-byte window out of ROM bounds.',
        );
      }

      const deleteOff = body.blockFileOffset + body.slotIndex * EVOLUTION_SLOT_SIZE_BYTES;
      const trailing = body.currentPopulatedCount - body.slotIndex - 1;
      if (trailing > 0) {
        const srcStart = deleteOff + EVOLUTION_SLOT_SIZE_BYTES;
        const shiftBytes = trailing * EVOLUTION_SLOT_SIZE_BYTES;
        out.copyWithin(deleteOff, srcStart, srcStart + shiftBytes);
      }
      // Zero-fill the slot that previously held the LAST populated
      // entry (= new EVO_NONE terminator position). After this write,
      // engine truncation kicks in at this slot.
      const lastSlotOff =
        body.blockFileOffset + (body.currentPopulatedCount - 1) * EVOLUTION_SLOT_SIZE_BYTES;
      for (let i = 0; i < EVOLUTION_SLOT_SIZE_BYTES; i++) out[lastSlotOff + i] = 0;

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditEvolutionDeleteResponse = {
        newPopulatedCount: body.currentPopulatedCount - 1,
        backupCreated,
      };
      return response;
    },
  );
}

export interface BinaryRomEditLearnsetMoveRequest {
  readonly arrayFileOffset: number;
  readonly entryIndex: number;
  readonly level: number;
  readonly move: number;
}
export interface BinaryRomEditLearnsetMoveResponse {
  readonly entryFileOffset: number;
  readonly packedValue: number;
  readonly backupCreated: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Phase M.6 - TM/HM compatibility writer
//
// Each species has an 8-byte slot in gTMHMLearnsets. The low u32 + high
// u32 together form a 64-bit bitfield where bit i means "compatible
// with TM/HM index i" (TMs 0..49, HMs 50..57 in vanilla).
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditTmhmRequest {
  readonly slotFileOffset: number;
  readonly low: number;
  readonly high: number;
}
export interface BinaryRomEditTmhmResponse {
  readonly slotFileOffset: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomTmhmRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditTmhmRequest }>(
    '/api/projects/:id/binary-rom-edit/species-tmhm',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.slotFileOffset !== 'number' ||
        typeof body.low !== 'number' ||
        typeof body.high !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include slotFileOffset + low + high.',
        );
      }
      if (body.low < 0 || body.low > 0xffffffff || body.high < 0 || body.high > 0xffffffff) {
        return errorResponse(reply, 400, 'internal_error', 'low + high must be u32');
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (body.slotFileOffset < 0 || body.slotFileOffset + 8 > romBytes.length) {
        return errorResponse(reply, 400, 'internal_error', 'Slot offset out of bounds');
      }
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }
      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      view.setUint32(body.slotFileOffset + 0, body.low >>> 0, true);
      view.setUint32(body.slotFileOffset + 4, body.high >>> 0, true);
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditTmhmResponse = {
        slotFileOffset: body.slotFileOffset,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase N.4 - Type matchup writer
//
// Each Gen-3 type matchup is a 3-byte entry: attacker u8, defender u8,
// effectiveness u8. Effectiveness uses the standard ×10 encoding:
//   0  = no effect    5  = ½× (resisted)
//   10 = 1× (normal)  20 = 2× (super-effective)
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditTypeMatchupRequest {
  readonly entryFileOffset: number;
  readonly fields: {
    readonly attackerType?: number;
    readonly defenderType?: number;
    readonly effectiveness?: number;
  };
}
export interface BinaryRomEditTypeMatchupResponse {
  readonly entryFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomTypeMatchupRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditTypeMatchupRequest }>(
    '/api/projects/:id/binary-rom-edit/type-matchup',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (!body || typeof body.entryFileOffset !== 'number' || !body.fields) {
        return errorResponse(reply, 400, 'internal_error', 'Body must include entryFileOffset + fields');
      }
      const f = body.fields;
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined) continue;
        if (typeof v !== 'number' || v < 0 || v > 0xff) {
          return errorResponse(reply, 400, 'internal_error', `${k} out of u8 range`);
        }
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (body.entryFileOffset < 0 || body.entryFileOffset + 3 > romBytes.length) {
        return errorResponse(reply, 400, 'internal_error', 'Entry offset out of bounds');
      }
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }
      const out = Buffer.from(romBytes);
      const fieldsWritten: string[] = [];
      if (f.attackerType !== undefined) {
        out[body.entryFileOffset + 0] = f.attackerType & 0xff;
        fieldsWritten.push('attackerType');
      }
      if (f.defenderType !== undefined) {
        out[body.entryFileOffset + 1] = f.defenderType & 0xff;
        fieldsWritten.push('defenderType');
      }
      if (f.effectiveness !== undefined) {
        out[body.entryFileOffset + 2] = f.effectiveness & 0xff;
        fieldsWritten.push('effectiveness');
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditTypeMatchupResponse = {
        entryFileOffset: body.entryFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase N.2 - Map connection writer
//
// MapConnection struct (12 bytes):
//   +0x00 u32 direction (1=down, 2=up, 3=left, 4=right, 5=dive, 6=emerge)
//   +0x04 s32 offset
//   +0x08 u8  destMapGroup
//   +0x09 u8  destMapNum
//   +0x0A u16 padding
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditMapConnectionRequest {
  readonly slotFileOffset: number;
  readonly fields: {
    readonly direction?: number;
    readonly offset?: number;
    readonly destMapGroup?: number;
    readonly destMapNum?: number;
  };
}
export interface BinaryRomEditMapConnectionResponse {
  readonly slotFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMapConnectionRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditMapConnectionRequest }>(
    '/api/projects/:id/binary-rom-edit/map-connection-slot',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (!body || typeof body.slotFileOffset !== 'number' || !body.fields) {
        return errorResponse(reply, 400, 'internal_error', 'Body must include slotFileOffset + fields');
      }
      const f = body.fields;
      if (f.direction !== undefined && (f.direction < 0 || f.direction > 0xffffffff)) {
        return errorResponse(reply, 400, 'internal_error', 'direction out of u32 range');
      }
      if (f.offset !== undefined && (f.offset < -0x80000000 || f.offset > 0x7fffffff)) {
        return errorResponse(reply, 400, 'internal_error', 'offset out of s32 range');
      }
      if (f.destMapGroup !== undefined && (f.destMapGroup < 0 || f.destMapGroup > 0xff)) {
        return errorResponse(reply, 400, 'internal_error', 'destMapGroup out of u8 range');
      }
      if (f.destMapNum !== undefined && (f.destMapNum < 0 || f.destMapNum > 0xff)) {
        return errorResponse(reply, 400, 'internal_error', 'destMapNum out of u8 range');
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (body.slotFileOffset < 0 || body.slotFileOffset + 12 > romBytes.length) {
        return errorResponse(reply, 400, 'internal_error', 'Slot offset out of bounds');
      }
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }
      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const fieldsWritten: string[] = [];
      if (f.direction !== undefined) {
        view.setUint32(body.slotFileOffset + 0x00, f.direction >>> 0, true);
        fieldsWritten.push('direction');
      }
      if (f.offset !== undefined) {
        view.setInt32(body.slotFileOffset + 0x04, f.offset, true);
        fieldsWritten.push('offset');
      }
      if (f.destMapGroup !== undefined) {
        view.setUint8(body.slotFileOffset + 0x08, f.destMapGroup);
        fieldsWritten.push('destMapGroup');
      }
      if (f.destMapNum !== undefined) {
        view.setUint8(body.slotFileOffset + 0x09, f.destMapNum);
        fieldsWritten.push('destMapNum');
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditMapConnectionResponse = {
        slotFileOffset: body.slotFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.7 - Map connection APPEND (relocation + grow)
//
// POST /api/projects/:id/binary-rom-edit/map-connection-append
//   body: {
//     connectionsHeaderOffset: number,  // 8-byte MapConnections struct
//     currentCount: number,             // current connections[] length
//     currentConnectionsArrayPointer: number, // ROM-space u32, or 0
//     newConnection: { direction, offset, destMapGroup, destMapNum }
//   }
//
// MapConnections struct (8 bytes):
//   +0x00 u32 count
//   +0x04 u32 connections (ROM pointer to MapConnection[count])
//
// Each MapConnection is 12 bytes (see Phase N.2 route above).
//
// Strategy: identical shape to the trainer-party-append route (O.6).
// Allocate free ROM space for (count+1) connections, copy existing,
// write new at slot[count], patch header count + pointer.
//
// Only supported when count >= 0 AND connectionsHeaderOffset > 0 (the
// map has a MapConnections struct already). Maps with NO connections
// struct at all (header pointer is NULL in the parent MapHeader) need
// a different flow that allocates the 8-byte struct too - deferred.
// ─────────────────────────────────────────────────────────────────────

const MAP_CONNECTION_SIZE = 12;
const MAP_CONNECTIONS_HEADER_SIZE = 8;
const MAP_CONNECTIONS_OFFSET_COUNT = 0x00;
const MAP_CONNECTIONS_OFFSET_PTR = 0x04;

export interface BinaryRomEditMapConnectionAppendRequest {
  readonly connectionsHeaderOffset: number;
  readonly currentCount: number;
  readonly currentConnectionsArrayPointer: number;
  readonly newConnection: {
    readonly direction: number;
    readonly offset: number;
    readonly destMapGroup: number;
    readonly destMapNum: number;
  };
}

export interface BinaryRomEditMapConnectionAppendResponse {
  readonly newConnectionsArrayPointer: number;
  readonly newConnectionsArrayFileOffset: number;
  readonly newCount: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMapConnectionAppendRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditMapConnectionAppendRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/map-connection-append',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.connectionsHeaderOffset !== 'number' ||
        typeof body.currentCount !== 'number' ||
        typeof body.currentConnectionsArrayPointer !== 'number' ||
        !body.newConnection
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include connectionsHeaderOffset, currentCount, currentConnectionsArrayPointer, and newConnection.',
        );
      }
      const nc = body.newConnection;
      if (
        typeof nc.direction !== 'number' ||
        typeof nc.offset !== 'number' ||
        typeof nc.destMapGroup !== 'number' ||
        typeof nc.destMapNum !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'newConnection must include numeric direction, offset, destMapGroup, destMapNum.',
        );
      }
      // Direction is u32 in struct but realistic Gen-3 values are 0..7.
      // Allow 0..0xffffffff per the slot edit route's existing tolerance.
      if (nc.direction < 0 || nc.direction > 0xffffffff) {
        return errorResponse(reply, 400, 'internal_error', 'direction out of u32 range');
      }
      if (nc.offset < -0x80000000 || nc.offset > 0x7fffffff) {
        return errorResponse(reply, 400, 'internal_error', 'offset out of s32 range');
      }
      if (nc.destMapGroup < 0 || nc.destMapGroup > 0xff) {
        return errorResponse(reply, 400, 'internal_error', 'destMapGroup out of u8 range');
      }
      if (nc.destMapNum < 0 || nc.destMapNum > 0xff) {
        return errorResponse(reply, 400, 'internal_error', 'destMapNum out of u8 range');
      }
      if (body.currentCount < 0 || body.currentCount > 16) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `currentCount ${String(body.currentCount)} out of plausible range (0..16).`,
        );
      }
      if (body.connectionsHeaderOffset <= 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Map has no MapConnections struct - adding the first connection needs a different flow (deferred).',
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();
      if (
        body.connectionsHeaderOffset + MAP_CONNECTIONS_HEADER_SIZE > out.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'connectionsHeaderOffset out of ROM bounds.',
        );
      }

      const newCount = body.currentCount + 1;
      const newArrayBytes = new Uint8Array(newCount * MAP_CONNECTION_SIZE);
      if (body.currentCount > 0 && body.currentConnectionsArrayPointer !== 0) {
        if (
          body.currentConnectionsArrayPointer < GBA_ROM_BASE_PTR ||
          body.currentConnectionsArrayPointer >= GBA_ROM_BASE_PTR + 0x02000000
        ) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'currentConnectionsArrayPointer not in ROM range.',
          );
        }
        const currentFileOff = body.currentConnectionsArrayPointer - GBA_ROM_BASE_PTR;
        const currentBytesLen = body.currentCount * MAP_CONNECTION_SIZE;
        if (currentFileOff < 0 || currentFileOff + currentBytesLen > out.length) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'currentConnectionsArrayPointer resolves outside ROM bounds.',
          );
        }
        newArrayBytes.set(out.subarray(currentFileOff, currentFileOff + currentBytesLen), 0);
      }

      // Write new connection at slot currentCount.
      const view = new DataView(
        newArrayBytes.buffer,
        newArrayBytes.byteOffset,
        newArrayBytes.byteLength,
      );
      const base = body.currentCount * MAP_CONNECTION_SIZE;
      view.setUint32(base + 0x00, nc.direction >>> 0, true);
      view.setInt32(base + 0x04, nc.offset, true);
      view.setUint8(base + 0x08, nc.destMapGroup);
      view.setUint8(base + 0x09, nc.destMapNum);
      view.setUint16(base + 0x0a, 0, true); // padding

      // Find free ROM space for the new array.
      const freeSpace = engineRom.findFreeRomSpace(out, newArrayBytes.byteLength);
      if (freeSpace === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No free ROM space for ${String(newArrayBytes.byteLength)} bytes - ROM may need expansion.`,
        );
      }
      out.set(newArrayBytes, freeSpace.offset);

      // Patch header: count u32 + pointer u32.
      const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
      const newPointer = (GBA_ROM_BASE_PTR + freeSpace.offset) >>> 0;
      outView.setUint32(
        body.connectionsHeaderOffset + MAP_CONNECTIONS_OFFSET_COUNT,
        newCount >>> 0,
        true,
      );
      outView.setUint32(
        body.connectionsHeaderOffset + MAP_CONNECTIONS_OFFSET_PTR,
        newPointer,
        true,
      );

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditMapConnectionAppendResponse = {
        newConnectionsArrayPointer: newPointer,
        newConnectionsArrayFileOffset: freeSpace.offset,
        newCount,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.9 - Map connection DELETE (in-place compaction, mirrors O.8)
//
// POST /api/projects/:id/binary-rom-edit/map-connection-delete
//   body: {
//     connectionsHeaderOffset: number,
//     currentCount: number,
//     currentConnectionsArrayPointer: number,
//     connectionIndex: number,
//   }
//
// Strategy: SHRINK in place. Shifts subsequent connections up by 12
// bytes (one MapConnection), zero-fills the freed trailing 12-byte
// slot, decrements MapConnections.count (u32 at +0x00). Pointer stays
// the same - the existing array hosts the smaller new array.
//
// Gates: currentCount ≥ 1 + connectionIndex in [0, currentCount-1].
// Deleting the LAST connection (count→0) is allowed; the header's
// count u32 becomes 0 and the engine reads no connections (same
// effect as a NULL-pointer connections struct).
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditMapConnectionDeleteRequest {
  readonly connectionsHeaderOffset: number;
  readonly currentCount: number;
  readonly currentConnectionsArrayPointer: number;
  readonly connectionIndex: number;
}

export interface BinaryRomEditMapConnectionDeleteResponse {
  readonly newCount: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMapConnectionDeleteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditMapConnectionDeleteRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/map-connection-delete',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.connectionsHeaderOffset !== 'number' ||
        typeof body.currentCount !== 'number' ||
        typeof body.currentConnectionsArrayPointer !== 'number' ||
        typeof body.connectionIndex !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include connectionsHeaderOffset, currentCount, currentConnectionsArrayPointer, connectionIndex.',
        );
      }
      if (body.currentCount < 1 || body.currentCount > 16) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `currentCount ${String(body.currentCount)} out of plausible range (1..16).`,
        );
      }
      if (
        body.connectionIndex < 0 ||
        body.connectionIndex >= body.currentCount
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `connectionIndex ${String(body.connectionIndex)} out of range [0, ${String(body.currentCount - 1)}].`,
        );
      }
      if (body.connectionsHeaderOffset <= 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Map has no MapConnections struct.',
        );
      }
      if (body.currentConnectionsArrayPointer === 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'currentConnectionsArrayPointer is NULL - nothing to delete.',
        );
      }
      if (
        body.currentConnectionsArrayPointer < GBA_ROM_BASE_PTR ||
        body.currentConnectionsArrayPointer >= GBA_ROM_BASE_PTR + 0x02000000
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `currentConnectionsArrayPointer 0x${body.currentConnectionsArrayPointer.toString(16)} not in ROM range.`,
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      if (
        body.connectionsHeaderOffset + MAP_CONNECTIONS_HEADER_SIZE > out.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'connectionsHeaderOffset out of ROM bounds.',
        );
      }

      const arrayFileOff =
        body.currentConnectionsArrayPointer - GBA_ROM_BASE_PTR;
      const totalBytes = body.currentCount * MAP_CONNECTION_SIZE;
      if (arrayFileOff < 0 || arrayFileOff + totalBytes > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Connections array resolves outside ROM bounds.',
        );
      }

      // Shift trailing entries up by one slot.
      const deleteOff = arrayFileOff + body.connectionIndex * MAP_CONNECTION_SIZE;
      const trailing = body.currentCount - body.connectionIndex - 1;
      if (trailing > 0) {
        const srcStart = deleteOff + MAP_CONNECTION_SIZE;
        const shiftBytes = trailing * MAP_CONNECTION_SIZE;
        out.copyWithin(deleteOff, srcStart, srcStart + shiftBytes);
      }
      // Zero-fill the (now-vacated) last 12-byte slot.
      const lastSlotOff = arrayFileOff + (body.currentCount - 1) * MAP_CONNECTION_SIZE;
      for (let i = 0; i < MAP_CONNECTION_SIZE; i++) out[lastSlotOff + i] = 0;

      // Decrement header count u32.
      const newCount = body.currentCount - 1;
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint32(
        body.connectionsHeaderOffset + MAP_CONNECTIONS_OFFSET_COUNT,
        newCount >>> 0,
        true,
      );

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditMapConnectionDeleteResponse = {
        newCount,
        backupCreated,
      };
      return response;
    },
  );
}

export function registerBinaryRomLearnsetMoveRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditLearnsetMoveRequest }>(
    '/api/projects/:id/binary-rom-edit/species-learnset-move',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.arrayFileOffset !== 'number' ||
        typeof body.entryIndex !== 'number' ||
        typeof body.level !== 'number' ||
        typeof body.move !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include arrayFileOffset, entryIndex, level, move.',
        );
      }
      if (body.level < 1 || body.level > 100) {
        return errorResponse(reply, 400, 'internal_error', 'level must be 1..100');
      }
      if (body.move < 0 || body.move > 0x1ff) {
        return errorResponse(reply, 400, 'internal_error', 'move must be 0..511 (9-bit)');
      }
      if (body.entryIndex < 0 || body.entryIndex > 255) {
        return errorResponse(reply, 400, 'internal_error', 'entryIndex out of plausible range');
      }
      const entryFileOffset = body.arrayFileOffset + body.entryIndex * 2;
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (entryFileOffset < 0 || entryFileOffset + 2 > romBytes.length) {
        return errorResponse(reply, 400, 'internal_error', 'Entry offset out of ROM bounds');
      }
      // Sanity check: the entry MUST not be past the 0xFFFF terminator.
      // We scan from arrayFileOffset and refuse to write past the existing
      // terminator (relocation needed to grow the learnset).
      let terminatorIdx = -1;
      for (let i = 0; i < 256; i++) {
        const off = body.arrayFileOffset + i * 2;
        if (off + 2 > romBytes.length) break;
        const v = (romBytes[off]! | (romBytes[off + 1]! << 8)) & 0xffff;
        if (v === 0xffff) {
          terminatorIdx = i;
          break;
        }
      }
      if (terminatorIdx < 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Could not find learnset terminator within 256 entries - refusing to write.',
        );
      }
      if (body.entryIndex > terminatorIdx) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Cannot edit entry past the existing terminator (idx ${String(terminatorIdx)}). Adding new entries needs relocation - deferred.`,
        );
      }
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }
      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      // Pack: low 9 bits = move, high 7 bits = level.
      const packed = (body.move & 0x1ff) | ((body.level & 0x7f) << 9);
      view.setUint16(entryFileOffset, packed, true);
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditLearnsetMoveResponse = {
        entryFileOffset,
        packedValue: packed,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.10 - Species learnset APPEND (relocation + grow)
//
// POST /api/projects/:id/binary-rom-edit/species-learnset-append
//   body: { pointerFileOffset, currentArrayFileOffset, level, move }
//
// Learnset layout (Gen-3 packed u16):
//   bit 0..8  = move id (9 bits, 0..511)
//   bit 9..15 = level (7 bits, 0..127, vanilla uses 1..100)
//   sentinel  = 0xFFFF (= move 0x1FF + level 0x7F, used as the terminator)
//
// Strategy: walk the existing array to find the terminator + count.
// Allocate free ROM space for (count + 1 new entry + 1 terminator)
// u16s. Copy existing entries (excluding old terminator), write new
// entry, write 0xFFFF terminator. Rewrite the u32 pointer slot in
// gLevelUpLearnsets[] to the new location. .bak atomic.
//
// Old learnset array is left in place - same fixed-cost waste as O.6
// (negligible vs 16-32 MB ROM total).
// ─────────────────────────────────────────────────────────────────────

const LEARNSET_TERMINATOR_U16 = 0xffff;
const LEARNSET_MAX_ENTRIES_PER_SPECIES = 256;

export interface BinaryRomEditLearnsetAppendRequest {
  readonly pointerFileOffset: number;
  readonly currentArrayFileOffset: number;
  readonly level: number;
  readonly move: number;
}

export interface BinaryRomEditLearnsetAppendResponse {
  readonly newArrayFileOffset: number;
  readonly newArrayPointer: number; // ROM-space u32
  readonly newEntryCount: number; // count excluding terminator
  readonly backupCreated: boolean;
}

export function registerBinaryRomLearnsetAppendRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditLearnsetAppendRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/species-learnset-append',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.pointerFileOffset !== 'number' ||
        typeof body.currentArrayFileOffset !== 'number' ||
        typeof body.level !== 'number' ||
        typeof body.move !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include pointerFileOffset, currentArrayFileOffset, level, move.',
        );
      }
      if (body.level < 1 || body.level > 100) {
        return errorResponse(reply, 400, 'internal_error', 'level must be 1..100');
      }
      if (body.move < 0 || body.move > 0x1ff) {
        return errorResponse(reply, 400, 'internal_error', 'move must be 0..511 (9-bit)');
      }
      if (body.pointerFileOffset < 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'pointerFileOffset missing - re-scan the project to surface gLevelUpLearnsets pointer slots.',
        );
      }
      if (body.currentArrayFileOffset < 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'currentArrayFileOffset out of bounds.',
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      if (body.pointerFileOffset + 4 > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'pointerFileOffset out of ROM bounds.',
        );
      }
      if (body.currentArrayFileOffset + 2 > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'currentArrayFileOffset out of ROM bounds.',
        );
      }

      // Walk the existing array to find the terminator + count.
      let entryCount = -1;
      for (let i = 0; i < LEARNSET_MAX_ENTRIES_PER_SPECIES; i++) {
        const off = body.currentArrayFileOffset + i * 2;
        if (off + 2 > out.length) break;
        const v = (out[off]! | (out[off + 1]! << 8)) & 0xffff;
        if (v === LEARNSET_TERMINATOR_U16) {
          entryCount = i;
          break;
        }
      }
      if (entryCount < 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Could not find 0xFFFF terminator within ${String(LEARNSET_MAX_ENTRIES_PER_SPECIES)} entries - refusing to grow.`,
        );
      }

      // Build new array: existing entries + new entry + terminator.
      const newU16Count = entryCount + 2; // existing + new + terminator
      const newArrayBytes = new Uint8Array(newU16Count * 2);
      // Copy existing entries (not including terminator).
      const existingBytes = entryCount * 2;
      if (existingBytes > 0) {
        newArrayBytes.set(
          out.subarray(body.currentArrayFileOffset, body.currentArrayFileOffset + existingBytes),
          0,
        );
      }
      // Write the new packed u16.
      const packed = (body.move & 0x1ff) | ((body.level & 0x7f) << 9);
      newArrayBytes[existingBytes] = packed & 0xff;
      newArrayBytes[existingBytes + 1] = (packed >> 8) & 0xff;
      // Write the terminator.
      newArrayBytes[existingBytes + 2] = 0xff;
      newArrayBytes[existingBytes + 3] = 0xff;

      // Allocate free space.
      const freeSpace = engineRom.findFreeRomSpace(out, newArrayBytes.byteLength);
      if (freeSpace === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No free ROM space for ${String(newArrayBytes.byteLength)} bytes - ROM may need expansion.`,
        );
      }
      out.set(newArrayBytes, freeSpace.offset);

      // Patch the pointer slot in gLevelUpLearnsets[].
      const newPointer = (GBA_ROM_BASE_PTR + freeSpace.offset) >>> 0;
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint32(body.pointerFileOffset, newPointer, true);

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditLearnsetAppendResponse = {
        newArrayFileOffset: freeSpace.offset,
        newArrayPointer: newPointer,
        newEntryCount: entryCount + 1,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.11 - Species learnset DELETE (in-place compaction)
//
// POST /api/projects/:id/binary-rom-edit/species-learnset-delete
//   body: { arrayFileOffset, entryIndex }
//
// Strategy: SHRINK in place. Shift entries after entryIndex left by
// one u16 (2 bytes), write 0xFFFF at the slot that previously held
// the LAST entry (= new terminator position), zero-fill the slot
// that previously held the old terminator. No pointer rewrite needed - 
// the array shrinks from N+1 to N u16s, all within the existing
// allocation.
//
// Gates: entryIndex must be < terminatorIndex (= current entry count).
// The species must have ≥ 1 entry; we don't refuse deleting down to 0
// (an empty learnset is just [0xFFFF] - valid).
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditLearnsetDeleteRequest {
  readonly arrayFileOffset: number;
  readonly entryIndex: number;
}

export interface BinaryRomEditLearnsetDeleteResponse {
  readonly newEntryCount: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomLearnsetDeleteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditLearnsetDeleteRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/species-learnset-delete',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.arrayFileOffset !== 'number' ||
        typeof body.entryIndex !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include arrayFileOffset and entryIndex.',
        );
      }
      if (body.entryIndex < 0 || body.entryIndex > 255) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'entryIndex out of plausible range (0..255).',
        );
      }
      if (body.arrayFileOffset < 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'arrayFileOffset out of bounds.',
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      // Walk to find the terminator.
      let entryCount = -1;
      for (let i = 0; i < LEARNSET_MAX_ENTRIES_PER_SPECIES; i++) {
        const off = body.arrayFileOffset + i * 2;
        if (off + 2 > out.length) break;
        const v = (out[off]! | (out[off + 1]! << 8)) & 0xffff;
        if (v === LEARNSET_TERMINATOR_U16) {
          entryCount = i;
          break;
        }
      }
      if (entryCount < 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Could not find 0xFFFF terminator within ${String(LEARNSET_MAX_ENTRIES_PER_SPECIES)} entries.`,
        );
      }
      if (body.entryIndex >= entryCount) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `entryIndex ${String(body.entryIndex)} is out of range [0, ${String(entryCount - 1)}].`,
        );
      }

      // Shift entries i+1..N-1 left by one u16 slot.
      const deleteOff = body.arrayFileOffset + body.entryIndex * 2;
      const shiftSrcStart = deleteOff + 2;
      const trailing = entryCount - body.entryIndex - 1; // entries after the deleted one
      if (trailing > 0) {
        const shiftBytes = trailing * 2;
        out.copyWithin(deleteOff, shiftSrcStart, shiftSrcStart + shiftBytes);
      }
      // Write 0xFFFF at the slot that previously held the LAST entry
      // (= new terminator position).
      const newTerminatorOff = body.arrayFileOffset + (entryCount - 1) * 2;
      out[newTerminatorOff] = 0xff;
      out[newTerminatorOff + 1] = 0xff;
      // Zero-fill the slot that previously held the OLD terminator
      // (now stale).
      const oldTerminatorOff = body.arrayFileOffset + entryCount * 2;
      if (oldTerminatorOff + 2 <= out.length) {
        out[oldTerminatorOff] = 0;
        out[oldTerminatorOff + 1] = 0;
      }

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }
      const response: BinaryRomEditLearnsetDeleteResponse = {
        newEntryCount: entryCount - 1,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.12 - Multichoice list APPEND (allocate text + relocate
//              MenuAction array + grow)
//
// POST /api/projects/:id/binary-rom-edit/multichoice-list-append
//   body: { entryFileOffset, newChoiceText: string }
//
// gMultichoiceLists entry (8 bytes):
//   +0x00 u32 listPtr (→ MenuAction[count])
//   +0x04 u8  count
//   +0x05 u8[3] pad (= 0)
//
// MenuAction (8 bytes):
//   +0x00 u32 textPtr (→ Gen-3-encoded string)
//   +0x04 u32 funcPtr (0 = default no-op)
//
// Strategy:
//   1. Read entry's current { listPtr, count }. Reject count ≥ 16.
//   2. Encode newChoiceText via Gen-3 codec; allocate free space for
//      (encoded.length + 1 terminator).
//   3. Build new MenuAction array (count+1 × 8 bytes): copy existing
//      MenuActions + append { textPtr = ROM_BASE + textOffset,
//      funcPtr = 0 }.
//   4. Allocate free space for the new array.
//   5. Patch entry: listPtr u32 + count u8 + zero-fill pad bytes.
//
// Old text bytes + old MenuAction array left in place (acceptable
// fixed-cost waste against 16-32 MB ROM total). .bak preserved.
// ─────────────────────────────────────────────────────────────────────

const MULTICHOICE_LIST_ENTRY_BYTES = 8;
const MENU_ACTION_BYTES = 8;
const MULTICHOICE_LIST_MAX_CHOICES = 16;
const MULTICHOICE_LIST_OFFSET_PTR = 0x00;
const MULTICHOICE_LIST_OFFSET_COUNT = 0x04;

export interface BinaryRomEditMultichoiceAppendRequest {
  readonly entryFileOffset: number;
  readonly newChoiceText: string;
}

export interface BinaryRomEditMultichoiceAppendResponse {
  readonly newCount: number;
  readonly newListPointer: number;
  readonly newTextFileOffset: number;
  readonly newListFileOffset: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMultichoiceAppendRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditMultichoiceAppendRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/multichoice-list-append',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.entryFileOffset !== 'number' ||
        typeof body.newChoiceText !== 'string'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include entryFileOffset (number) and newChoiceText (string).',
        );
      }
      if (body.newChoiceText.length === 0) {
        return errorResponse(reply, 400, 'internal_error', 'newChoiceText cannot be empty.');
      }
      if (body.newChoiceText.length > 32) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'newChoiceText too long (max 32 chars - multichoice menus have narrow display widths).',
        );
      }
      if (body.entryFileOffset < 0) {
        return errorResponse(reply, 400, 'internal_error', 'entryFileOffset out of bounds.');
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      if (body.entryFileOffset + MULTICHOICE_LIST_ENTRY_BYTES > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'entryFileOffset out of ROM bounds.',
        );
      }

      // Read current entry.
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      const currentListPtr = view.getUint32(body.entryFileOffset + MULTICHOICE_LIST_OFFSET_PTR, true);
      const currentCount = out[body.entryFileOffset + MULTICHOICE_LIST_OFFSET_COUNT]!;
      if (currentCount >= MULTICHOICE_LIST_MAX_CHOICES) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Multichoice list already at max ${String(MULTICHOICE_LIST_MAX_CHOICES)} choices.`,
        );
      }
      if (
        currentListPtr < GBA_ROM_BASE_PTR ||
        currentListPtr >= GBA_ROM_BASE_PTR + 0x02000000
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Current listPtr 0x${currentListPtr.toString(16)} not in ROM range.`,
        );
      }
      const currentListFileOff = currentListPtr - GBA_ROM_BASE_PTR;
      const currentMenuActionsBytes = currentCount * MENU_ACTION_BYTES;
      if (currentListFileOff + currentMenuActionsBytes > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Current MenuAction array resolves outside ROM bounds.',
        );
      }

      // Encode new text + terminator.
      let encoded: Uint8Array;
      try {
        encoded = engineText.encodeString(body.newChoiceText);
      } catch (e) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Failed to encode newChoiceText: ${String(e)}`,
        );
      }
      const textBytes = new Uint8Array(encoded.length + 1);
      textBytes.set(encoded, 0);
      textBytes[encoded.length] = engineText.STRING_TERMINATOR;

      // Allocate space for the text first.
      const textAlloc = engineRom.findFreeRomSpace(out, textBytes.byteLength);
      if (textAlloc === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No free ROM space for ${String(textBytes.byteLength)} bytes of choice text.`,
        );
      }
      // Write text.
      out.set(textBytes, textAlloc.offset);

      // Build new MenuAction array (count+1 × 8 bytes).
      const newCount = currentCount + 1;
      const newArrayBytes = new Uint8Array(newCount * MENU_ACTION_BYTES);
      if (currentMenuActionsBytes > 0) {
        newArrayBytes.set(
          out.subarray(currentListFileOff, currentListFileOff + currentMenuActionsBytes),
          0,
        );
      }
      // New MenuAction at slot[currentCount]: textPtr → new text, funcPtr = 0.
      const newActionOff = currentCount * MENU_ACTION_BYTES;
      const newTextPtr = (GBA_ROM_BASE_PTR + textAlloc.offset) >>> 0;
      const newArrayView = new DataView(
        newArrayBytes.buffer,
        newArrayBytes.byteOffset,
        newArrayBytes.byteLength,
      );
      newArrayView.setUint32(newActionOff + 0x00, newTextPtr, true);
      newArrayView.setUint32(newActionOff + 0x04, 0, true); // funcPtr = no-op

      // Allocate space for the new MenuAction array.
      // The text was just written, so it's no longer free space - 
      // findFreeRomSpace will see those bytes as non-fill and skip them.
      const listAlloc = engineRom.findFreeRomSpace(out, newArrayBytes.byteLength);
      if (listAlloc === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No free ROM space for ${String(newArrayBytes.byteLength)} bytes of MenuAction array.`,
        );
      }
      out.set(newArrayBytes, listAlloc.offset);

      // Patch gMultichoiceLists entry: listPtr u32 + count u8 + pad.
      const newListPtr = (GBA_ROM_BASE_PTR + listAlloc.offset) >>> 0;
      view.setUint32(body.entryFileOffset + MULTICHOICE_LIST_OFFSET_PTR, newListPtr, true);
      out[body.entryFileOffset + MULTICHOICE_LIST_OFFSET_COUNT] = newCount;
      // Pad bytes (already 0 in vanilla; reaffirm).
      out[body.entryFileOffset + 0x05] = 0;
      out[body.entryFileOffset + 0x06] = 0;
      out[body.entryFileOffset + 0x07] = 0;

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditMultichoiceAppendResponse = {
        newCount,
        newListPointer: newListPtr,
        newTextFileOffset: textAlloc.offset,
        newListFileOffset: listAlloc.offset,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.13 - Multichoice list DELETE (in-place MenuAction compaction)
//
// POST /api/projects/:id/binary-rom-edit/multichoice-list-delete
//   body: { entryFileOffset, choiceIndex }
//
// Strategy: SHRINK the MenuAction array in place. Read the entry's
// listPtr + count, shift MenuActions [choiceIndex+1, count-1] left
// by one 8-byte slot, zero-fill the freed trailing 8-byte slot,
// decrement the count u8. Pointer stays the same.
//
// Gates: count ≥ 2 (cap at MIN_CHOICES_PER_LIST from O.3's detector - 
// a single-choice multichoice is degenerate and the engine may
// crash). choiceIndex in [0, count-1].
//
// Old choice text bytes are NOT freed (would need a refcount + GC).
// Acceptable fixed-cost waste, same as elsewhere.
// ─────────────────────────────────────────────────────────────────────

const MULTICHOICE_LIST_MIN_CHOICES = 2;

export interface BinaryRomEditMultichoiceDeleteRequest {
  readonly entryFileOffset: number;
  readonly choiceIndex: number;
}

export interface BinaryRomEditMultichoiceDeleteResponse {
  readonly newCount: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMultichoiceDeleteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditMultichoiceDeleteRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/multichoice-list-delete',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.entryFileOffset !== 'number' ||
        typeof body.choiceIndex !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include entryFileOffset and choiceIndex.',
        );
      }
      if (body.entryFileOffset < 0) {
        return errorResponse(reply, 400, 'internal_error', 'entryFileOffset out of bounds.');
      }
      if (body.choiceIndex < 0 || body.choiceIndex > MULTICHOICE_LIST_MAX_CHOICES - 1) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `choiceIndex out of plausible range (0..${String(MULTICHOICE_LIST_MAX_CHOICES - 1)}).`,
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      if (body.entryFileOffset + MULTICHOICE_LIST_ENTRY_BYTES > out.length) {
        return errorResponse(reply, 400, 'internal_error', 'entryFileOffset out of ROM bounds.');
      }

      // Read current entry.
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      const currentListPtr = view.getUint32(body.entryFileOffset + MULTICHOICE_LIST_OFFSET_PTR, true);
      const currentCount = out[body.entryFileOffset + MULTICHOICE_LIST_OFFSET_COUNT]!;
      if (currentCount <= MULTICHOICE_LIST_MIN_CHOICES) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Cannot delete from a list of ${String(currentCount)} choices - Gen-3 multichoice opcode requires ≥ ${String(MULTICHOICE_LIST_MIN_CHOICES)}.`,
        );
      }
      if (body.choiceIndex >= currentCount) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `choiceIndex ${String(body.choiceIndex)} out of range [0, ${String(currentCount - 1)}].`,
        );
      }
      if (
        currentListPtr < GBA_ROM_BASE_PTR ||
        currentListPtr >= GBA_ROM_BASE_PTR + 0x02000000
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Current listPtr 0x${currentListPtr.toString(16)} not in ROM range.`,
        );
      }
      const listFileOff = currentListPtr - GBA_ROM_BASE_PTR;
      const totalBytes = currentCount * MENU_ACTION_BYTES;
      if (listFileOff + totalBytes > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'MenuAction array resolves outside ROM bounds.',
        );
      }

      // Shift trailing MenuActions left by 8 bytes.
      const deleteOff = listFileOff + body.choiceIndex * MENU_ACTION_BYTES;
      const trailing = currentCount - body.choiceIndex - 1;
      if (trailing > 0) {
        const srcStart = deleteOff + MENU_ACTION_BYTES;
        const shiftBytes = trailing * MENU_ACTION_BYTES;
        out.copyWithin(deleteOff, srcStart, srcStart + shiftBytes);
      }
      // Zero-fill the (now-vacated) last MenuAction slot.
      const lastSlotOff = listFileOff + (currentCount - 1) * MENU_ACTION_BYTES;
      for (let i = 0; i < MENU_ACTION_BYTES; i++) out[lastSlotOff + i] = 0;

      // Decrement count byte.
      const newCount = currentCount - 1;
      out[body.entryFileOffset + MULTICHOICE_LIST_OFFSET_COUNT] = newCount;

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditMultichoiceDeleteResponse = {
        newCount,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase L.3 - Trainer struct field writer
//
// POST /api/projects/:id/binary-rom-edit/trainer-fields
//   body: { structFileOffset, fields: {
//     trainerClass?, encounterMusic?, trainerPic?,
//     aiFlagsRaw?, item0?, item1?, item2?, item3?,
//     name? /* string ≤ 12 chars; will be Gen-3-encoded and zero-padded */
//   }}
//
// Trainer struct layout (40 bytes - pret/pokefirered):
//   +0x00 u8 partyFlags
//   +0x01 u8 trainerClass            ← edit
//   +0x02 u8 encounterMusic          ← edit (bits 0..6 = music, bit 7 = isFemale)
//   +0x03 u8 trainerPic              ← edit
//   +0x04 u8 trainerName[12]          ← edit (Gen-3 charset, 0xFF-terminated)
//   +0x10 u16 items[4]                ← edit (4 held items)
//   +0x18 u8 doubleBattle
//   +0x1C u32 aiFlags                ← edit
//   +0x20 u8 partySize
//   +0x24 u32 partyPointer
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditTrainerFieldsRequest {
  readonly structFileOffset: number;
  readonly fields: {
    readonly trainerClass?: number;
    readonly encounterMusic?: number;
    readonly trainerPic?: number;
    readonly aiFlagsRaw?: number;
    readonly item0?: number;
    readonly item1?: number;
    readonly item2?: number;
    readonly item3?: number;
    readonly name?: string;
  };
}

export interface BinaryRomEditTrainerFieldsResponse {
  readonly structFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomTrainerFieldsRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditTrainerFieldsRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/trainer-fields',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (
        !body ||
        typeof body.structFileOffset !== 'number' ||
        !body.fields ||
        typeof body.fields !== 'object'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include structFileOffset + fields.',
        );
      }
      const f = body.fields;
      const checkU8 = (v: number | undefined, name: string): string | null =>
        v === undefined ? null : v < 0 || v > 0xff ? `${name} out of u8` : null;
      const checkU16 = (v: number | undefined, name: string): string | null =>
        v === undefined ? null : v < 0 || v > 0xffff ? `${name} out of u16` : null;
      for (const err of [
        checkU8(f.trainerClass, 'trainerClass'),
        checkU8(f.encounterMusic, 'encounterMusic'),
        checkU8(f.trainerPic, 'trainerPic'),
        checkU16(f.item0, 'item0'),
        checkU16(f.item1, 'item1'),
        checkU16(f.item2, 'item2'),
        checkU16(f.item3, 'item3'),
      ]) {
        if (err) return errorResponse(reply, 400, 'internal_error', err);
      }
      if (f.aiFlagsRaw !== undefined && (f.aiFlagsRaw < 0 || f.aiFlagsRaw > 0xffffffff)) {
        return errorResponse(reply, 400, 'internal_error', 'aiFlagsRaw out of u32');
      }
      if (f.name !== undefined && f.name.length > 11) {
        // 12-byte slot minus 1 for terminator = 11 visible chars.
        return errorResponse(reply, 400, 'internal_error', 'name max 11 characters');
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const TRAINER_SIZE = 40;
      if (body.structFileOffset < 0 || body.structFileOffset + TRAINER_SIZE > romBytes.length) {
        return errorResponse(reply, 400, 'internal_error', 'Trainer struct out of bounds.');
      }

      let nameBytes: Uint8Array | null = null;
      if (f.name !== undefined) {
        try {
          nameBytes = engineText.encodeString(f.name);
        } catch (e) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Cannot encode name: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }

      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const base = body.structFileOffset;
      const fieldsWritten: string[] = [];
      if (f.trainerClass !== undefined) {
        view.setUint8(base + 0x01, f.trainerClass);
        fieldsWritten.push('trainerClass');
      }
      if (f.encounterMusic !== undefined) {
        view.setUint8(base + 0x02, f.encounterMusic);
        fieldsWritten.push('encounterMusic');
      }
      if (f.trainerPic !== undefined) {
        view.setUint8(base + 0x03, f.trainerPic);
        fieldsWritten.push('trainerPic');
      }
      if (nameBytes !== null) {
        const slot = base + 0x04;
        // Zero the slot then write the encoded bytes + 0xFF terminator.
        for (let i = 0; i < 12; i++) out[slot + i] = 0xff;
        for (let i = 0; i < nameBytes.length && i < 11; i++) {
          out[slot + i] = nameBytes[i]!;
        }
        out[slot + Math.min(nameBytes.length, 11)] = 0xff;
        fieldsWritten.push('name');
      }
      const itemOff = [0, 2, 4, 6];
      const itemVals = [f.item0, f.item1, f.item2, f.item3];
      for (let i = 0; i < 4; i++) {
        const v = itemVals[i];
        if (v !== undefined) {
          view.setUint16(base + 0x10 + itemOff[i]!, v, true);
          fieldsWritten.push(`item${i}`);
        }
      }
      if (f.aiFlagsRaw !== undefined) {
        view.setUint32(base + 0x1c, f.aiFlagsRaw >>> 0, true);
        fieldsWritten.push('aiFlagsRaw');
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditTrainerFieldsResponse = {
        structFileOffset: body.structFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase K.4 - Trainer party member writer
//
// POST /api/projects/:id/binary-rom-edit/trainer-party-member
//   body: {
//     memberFileOffset, partyFlags,
//     fields: { speciesId?, level?, heldItemId?, moveIds? }
//   }
//
// Party-member struct variants per pret/pokefirered:
//   PARTY_FLAG_MOVES (0x01) | PARTY_FLAG_HELD_ITEM (0x02):
//     0x00 - Basic (8 B):       iv:u16, level:u8, padding:u8, species:u16, padding:u16
//     0x01 - Moves (16 B):      iv:u16, level:u8, padding:u8, species:u16, moves:u16[4]
//     0x02 - Items (8 B):       iv:u16, level:u8, padding:u8, species:u16, heldItem:u16
//     0x03 - MovesItems (16 B): iv:u16, level:u8, padding:u8, species:u16,
//                                heldItem:u16, moves:u16[4]
//
// All variants share +0x00 iv u16, +0x02 level u8, +0x04 species u16.
// The held-item / moves slots depend on partyFlags. Caller passes
// partyFlags so the route can write the right offsets.
// ─────────────────────────────────────────────────────────────────────

const PARTY_FLAG_MOVES = 0x01;
const PARTY_FLAG_HELD_ITEM = 0x02;

export interface BinaryRomEditTrainerPartyMemberRequest {
  readonly memberFileOffset: number;
  readonly partyFlags: number;
  readonly fields: {
    readonly speciesId?: number;
    readonly level?: number;
    readonly heldItemId?: number;
    readonly moveIds?: ReadonlyArray<number>;
  };
}

export interface BinaryRomEditTrainerPartyMemberResponse {
  readonly memberFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomTrainerPartyRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditTrainerPartyMemberRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/trainer-party-member',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (
        !body ||
        typeof body.memberFileOffset !== 'number' ||
        typeof body.partyFlags !== 'number' ||
        !body.fields
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include memberFileOffset, partyFlags, and fields.',
        );
      }
      const f = body.fields;
      if (f.level !== undefined && (f.level < 1 || f.level > 100)) {
        return errorResponse(reply, 400, 'internal_error', 'level must be 1..100');
      }
      if (f.speciesId !== undefined && (f.speciesId < 0 || f.speciesId > 0xffff)) {
        return errorResponse(reply, 400, 'internal_error', 'speciesId out of u16');
      }
      if (f.heldItemId !== undefined && (f.heldItemId < 0 || f.heldItemId > 0xffff)) {
        return errorResponse(reply, 400, 'internal_error', 'heldItemId out of u16');
      }
      if (f.moveIds && (f.moveIds.length !== 4 || f.moveIds.some((m) => m < 0 || m > 0xffff))) {
        return errorResponse(reply, 400, 'internal_error', 'moveIds must be 4 u16');
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }

      const hasMoves = (body.partyFlags & PARTY_FLAG_MOVES) !== 0;
      const hasItem = (body.partyFlags & PARTY_FLAG_HELD_ITEM) !== 0;
      const memberSize = hasMoves ? 16 : 8;
      if (body.memberFileOffset < 0 || body.memberFileOffset + memberSize > romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Member offset out of ROM bounds.',
        );
      }
      // Reject moves writes when partyFlags doesn't have PARTY_FLAG_MOVES.
      if (f.moveIds && !hasMoves) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Cannot write moves on a no-moves party variant. Re-encode the parent trainer struct first.',
        );
      }
      if (f.heldItemId !== undefined && !hasItem && !hasMoves) {
        // Basic variant has no heldItem slot at all.
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Cannot write heldItem on a Basic party variant.',
        );
      }

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }

      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const base = body.memberFileOffset;
      const fieldsWritten: string[] = [];
      if (f.level !== undefined) {
        view.setUint8(base + 0x02, f.level);
        fieldsWritten.push('level');
      }
      if (f.speciesId !== undefined) {
        view.setUint16(base + 0x04, f.speciesId, true);
        fieldsWritten.push('speciesId');
      }
      if (f.heldItemId !== undefined && hasItem) {
        // PARTY_FLAG_HELD_ITEM: held item at +0x06 (or +0x06 in MovesItems
        // variant where the layout is iv/level/_/species/heldItem/moves[4]).
        view.setUint16(base + 0x06, f.heldItemId, true);
        fieldsWritten.push('heldItemId');
      }
      if (f.moveIds && hasMoves) {
        // Moves layout: when ITEMS bit also set, moves start at +0x08;
        // otherwise (Moves-only), moves start at +0x06.
        const movesOffset = hasItem ? 0x08 : 0x06;
        for (let i = 0; i < 4; i++) {
          view.setUint16(base + movesOffset + i * 2, f.moveIds[i] ?? 0, true);
        }
        fieldsWritten.push('moveIds');
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditTrainerPartyMemberResponse = {
        memberFileOffset: body.memberFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.6 - Trainer party APPEND (relocation + grow)
//
// POST /api/projects/:id/binary-rom-edit/trainer-party-append
//   body: {
//     trainerStructFileOffset: number,  // start of 40-byte Trainer struct
//     currentPartyPointer: number,      // ROM-space u32 (or 0 for null party)
//     currentPartySize: number,         // 0..5 (post-append: 1..6, Gen-3 max)
//     partyFlags: number,
//     newMember: { speciesId, level, heldItemId?, moveIds? }
//   }
//
// Strategy:
//   1. Validate inputs + ranges.
//   2. Find free ROM space for (currentPartySize+1) * memberSize bytes
//      using engineRom.findFreeRomSpace.
//   3. Copy existing members from currentPartyPointer (if any) into the
//      free region. Append the new member at slot currentPartySize.
//   4. Patch Trainer struct's partySize byte (+0x20) + partyPointer u32
//      (+0x24) to point at the new region.
//   5. Atomic write with .bak backup.
//
// The OLD party array is left in place (no compaction). For Gen-3 ROM
// editor use this is fine - appending is rare and the small wasted
// region (≤ 96 bytes per growth) is negligible against the 16-32 MB
// ROM total.
// ─────────────────────────────────────────────────────────────────────

const GBA_ROM_BASE_PTR = 0x08000000;
const TRAINER_STRUCT_SIZE = 40;
const TRAINER_OFFSET_PARTY_SIZE = 0x20;
const TRAINER_OFFSET_PARTY_POINTER = 0x24;

export interface BinaryRomEditTrainerPartyAppendRequest {
  readonly trainerStructFileOffset: number;
  readonly currentPartyPointer: number;
  readonly currentPartySize: number;
  readonly partyFlags: number;
  readonly newMember: {
    readonly speciesId: number;
    readonly level: number;
    readonly heldItemId?: number;
    readonly moveIds?: ReadonlyArray<number>;
  };
}

export interface BinaryRomEditTrainerPartyAppendResponse {
  readonly newPartyPointer: number; // ROM-space u32
  readonly newPartyFileOffset: number;
  readonly newPartySize: number;
  readonly memberSize: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomTrainerPartyAppendRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditTrainerPartyAppendRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/trainer-party-append',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (
        !body ||
        typeof body.trainerStructFileOffset !== 'number' ||
        typeof body.currentPartyPointer !== 'number' ||
        typeof body.currentPartySize !== 'number' ||
        typeof body.partyFlags !== 'number' ||
        !body.newMember ||
        typeof body.newMember.speciesId !== 'number' ||
        typeof body.newMember.level !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include trainerStructFileOffset, currentPartyPointer, currentPartySize, partyFlags, and newMember{speciesId, level}.',
        );
      }
      if (body.currentPartySize < 0 || body.currentPartySize >= 6) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `currentPartySize ${String(body.currentPartySize)} must be 0..5 (Gen-3 max party = 6).`,
        );
      }
      const m = body.newMember;
      if (m.level < 1 || m.level > 100) {
        return errorResponse(reply, 400, 'internal_error', 'newMember.level must be 1..100');
      }
      if (m.speciesId < 0 || m.speciesId > 0xffff) {
        return errorResponse(reply, 400, 'internal_error', 'newMember.speciesId out of u16');
      }
      if (m.heldItemId !== undefined && (m.heldItemId < 0 || m.heldItemId > 0xffff)) {
        return errorResponse(reply, 400, 'internal_error', 'newMember.heldItemId out of u16');
      }
      if (m.moveIds && (m.moveIds.length !== 4 || m.moveIds.some((mi) => mi < 0 || mi > 0xffff))) {
        return errorResponse(reply, 400, 'internal_error', 'newMember.moveIds must be 4 u16');
      }

      const hasMoves = (body.partyFlags & PARTY_FLAG_MOVES) !== 0;
      const hasItem = (body.partyFlags & PARTY_FLAG_HELD_ITEM) !== 0;
      const memberSize = hasMoves ? 16 : 8;
      if (m.moveIds && !hasMoves) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Cannot supply moveIds when partyFlags lacks PARTY_FLAG_MOVES.',
        );
      }
      if (m.heldItemId !== undefined && !hasItem && !hasMoves) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Cannot supply heldItemId on a Basic party variant.',
        );
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      // Validate trainer struct offset is in ROM.
      if (
        body.trainerStructFileOffset < 0 ||
        body.trainerStructFileOffset + TRAINER_STRUCT_SIZE > out.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'trainerStructFileOffset out of ROM bounds.',
        );
      }

      // Read the current party from currentPartyPointer (if non-null).
      const newPartySize = body.currentPartySize + 1;
      const newPartyBytes = new Uint8Array(newPartySize * memberSize);
      if (body.currentPartyPointer !== 0) {
        if (
          body.currentPartyPointer < GBA_ROM_BASE_PTR ||
          body.currentPartyPointer >= GBA_ROM_BASE_PTR + 0x02000000
        ) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `currentPartyPointer 0x${body.currentPartyPointer.toString(16)} not in ROM range.`,
          );
        }
        const currentFileOff = body.currentPartyPointer - GBA_ROM_BASE_PTR;
        const currentBytes = body.currentPartySize * memberSize;
        if (currentFileOff < 0 || currentFileOff + currentBytes > out.length) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'currentPartyPointer resolves outside ROM bounds.',
          );
        }
        // Copy existing members.
        newPartyBytes.set(out.subarray(currentFileOff, currentFileOff + currentBytes), 0);
      }

      // Write the new member into the last slot.
      const view = new DataView(
        newPartyBytes.buffer,
        newPartyBytes.byteOffset,
        newPartyBytes.byteLength,
      );
      const base = body.currentPartySize * memberSize;
      // Always-present fields: iv u16 (left 0), level u8, species u16.
      view.setUint16(base + 0x00, 0, true); // iv (default 0 - vanilla doesn't surface this)
      view.setUint8(base + 0x02, m.level);
      view.setUint8(base + 0x03, 0); // padding
      view.setUint16(base + 0x04, m.speciesId, true);
      if (hasItem && !hasMoves) {
        // Items variant: heldItem u16 at +0x06.
        view.setUint16(base + 0x06, m.heldItemId ?? 0, true);
      } else if (hasMoves && !hasItem) {
        // Moves variant: moves u16[4] starting at +0x06.
        for (let i = 0; i < 4; i++) {
          view.setUint16(base + 0x06 + i * 2, m.moveIds?.[i] ?? 0, true);
        }
      } else if (hasMoves && hasItem) {
        // MovesItems variant: heldItem +0x06, moves +0x08.
        view.setUint16(base + 0x06, m.heldItemId ?? 0, true);
        for (let i = 0; i < 4; i++) {
          view.setUint16(base + 0x08 + i * 2, m.moveIds?.[i] ?? 0, true);
        }
      }
      // Basic variant: no extra fields past species (padding bytes stay 0).

      // Find free ROM space for the new array.
      const freeSpace = engineRom.findFreeRomSpace(out, newPartyBytes.byteLength);
      if (freeSpace === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No free ROM space found for ${String(newPartyBytes.byteLength)} bytes - ROM may need expansion.`,
        );
      }

      // Write new party to free space.
      out.set(newPartyBytes, freeSpace.offset);

      // Patch trainer struct: partySize u8 + partyPointer u32.
      out[body.trainerStructFileOffset + TRAINER_OFFSET_PARTY_SIZE] = newPartySize;
      const newPartyPointer = (GBA_ROM_BASE_PTR + freeSpace.offset) >>> 0;
      const trainerView = new DataView(out.buffer, out.byteOffset, out.byteLength);
      trainerView.setUint32(
        body.trainerStructFileOffset + TRAINER_OFFSET_PARTY_POINTER,
        newPartyPointer,
        true,
      );

      // Atomic write with one-time .bak backup.
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditTrainerPartyAppendResponse = {
        newPartyPointer,
        newPartyFileOffset: freeSpace.offset,
        newPartySize,
        memberSize,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.8 - Trainer party DELETE (in-place compaction, no relocation)
//
// POST /api/projects/:id/binary-rom-edit/trainer-party-delete-member
//   body: {
//     trainerStructFileOffset, currentPartyPointer, currentPartySize,
//     memberIndex, partyFlags
//   }
//
// Strategy: SHRINK in place. The original array can host the smaller
// new array - no relocation needed. Shifts members after memberIndex
// up by one slot (overwriting it), zero-fills the trailing freed
// member slot to leave the old final-slot bytes inert, decrements
// Trainer.partySize (u8 at +0x20). The party pointer stays the same.
//
// Gates: currentPartySize must be ≥ 2 (can't delete the last member - 
// Gen-3 requires party size ≥ 1). memberIndex must be in [0, size-1].
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditTrainerPartyDeleteRequest {
  readonly trainerStructFileOffset: number;
  readonly currentPartyPointer: number;
  readonly currentPartySize: number;
  readonly memberIndex: number;
  readonly partyFlags: number;
}

export interface BinaryRomEditTrainerPartyDeleteResponse {
  readonly newPartySize: number;
  readonly memberSize: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomTrainerPartyDeleteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditTrainerPartyDeleteRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/trainer-party-delete-member',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (
        !body ||
        typeof body.trainerStructFileOffset !== 'number' ||
        typeof body.currentPartyPointer !== 'number' ||
        typeof body.currentPartySize !== 'number' ||
        typeof body.memberIndex !== 'number' ||
        typeof body.partyFlags !== 'number'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include trainerStructFileOffset, currentPartyPointer, currentPartySize, memberIndex, partyFlags.',
        );
      }
      if (body.currentPartySize < 2) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Cannot delete from a party of ${String(body.currentPartySize)} - Gen-3 requires party size ≥ 1.`,
        );
      }
      if (body.currentPartySize > 6) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'currentPartySize > 6 (Gen-3 max).',
        );
      }
      if (body.memberIndex < 0 || body.memberIndex >= body.currentPartySize) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `memberIndex ${String(body.memberIndex)} out of range [0, ${String(body.currentPartySize - 1)}].`,
        );
      }

      const hasMoves = (body.partyFlags & PARTY_FLAG_MOVES) !== 0;
      const memberSize = hasMoves ? 16 : 8;

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();

      if (
        body.trainerStructFileOffset < 0 ||
        body.trainerStructFileOffset + TRAINER_STRUCT_SIZE > out.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'trainerStructFileOffset out of ROM bounds.',
        );
      }

      // Resolve party pointer.
      if (body.currentPartyPointer === 0) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'currentPartyPointer is NULL - nothing to delete from.',
        );
      }
      if (
        body.currentPartyPointer < GBA_ROM_BASE_PTR ||
        body.currentPartyPointer >= GBA_ROM_BASE_PTR + 0x02000000
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `currentPartyPointer 0x${body.currentPartyPointer.toString(16)} not in ROM range.`,
        );
      }
      const partyFileOff = body.currentPartyPointer - GBA_ROM_BASE_PTR;
      const totalBytes = body.currentPartySize * memberSize;
      if (partyFileOff < 0 || partyFileOff + totalBytes > out.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Party array resolves outside ROM bounds.',
        );
      }

      // Shift members after memberIndex up by one slot. Then zero-fill
      // the trailing freed slot to avoid stale bytes peeking in hex
      // dumps.
      const deleteOff = partyFileOff + body.memberIndex * memberSize;
      const trailingMembers = body.currentPartySize - body.memberIndex - 1;
      if (trailingMembers > 0) {
        const srcStart = deleteOff + memberSize;
        const dstStart = deleteOff;
        const shiftBytes = trailingMembers * memberSize;
        // copyWithin is safe for overlapping ranges going left.
        out.copyWithin(dstStart, srcStart, srcStart + shiftBytes);
      }
      // Zero-fill the last (now-vacated) slot.
      const lastSlotOff = partyFileOff + (body.currentPartySize - 1) * memberSize;
      for (let i = 0; i < memberSize; i++) out[lastSlotOff + i] = 0;

      // Patch trainer's partySize.
      const newPartySize = body.currentPartySize - 1;
      out[body.trainerStructFileOffset + TRAINER_OFFSET_PARTY_SIZE] = newPartySize;

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditTrainerPartyDeleteResponse = {
        newPartySize,
        memberSize,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase K.2 - Generic map-event table add/delete (warp/coord/bg events)
//
// Mirrors Phase J.7/J.8 (object-event-table) for the other three event
// sub-arrays. MapEvents struct counts are u8s at:
//   +0x00 objectEventCount   (handled by /object-event-table)
//   +0x01 warpCount
//   +0x02 coordEventCount
//   +0x03 bgEventCount
//
// Strides:
//   warp:        8 bytes
//   coordEvent: 16 bytes
//   bgEvent:    12 bytes
//
// POST /api/projects/:id/binary-rom-edit/map-event-table
//   body: { mapEventsStructOffset, subArrayOffset, kind:'warp'|'coordEvent'|'bgEvent',
//           op:'delete'|'append', deleteStructFileOffset?, newEvent? }
// ─────────────────────────────────────────────────────────────────────

const MAP_EVENT_STRIDE: Readonly<Record<'warp' | 'coordEvent' | 'bgEvent', number>> = {
  warp: 8,
  coordEvent: 16,
  bgEvent: 12,
};
const MAP_EVENT_COUNT_BYTE_OFFSET: Readonly<Record<'warp' | 'coordEvent' | 'bgEvent', number>> = {
  warp: 0x01,
  coordEvent: 0x02,
  bgEvent: 0x03,
};

export interface BinaryRomEditMapEventTableRequest {
  readonly mapEventsStructOffset: number;
  readonly subArrayOffset: number;
  readonly kind: 'warp' | 'coordEvent' | 'bgEvent';
  readonly op: 'delete' | 'append';
  readonly deleteStructFileOffset?: number;
  readonly newWarp?: {
    readonly x: number;
    readonly y: number;
    readonly elevation: number;
    readonly warpId: number;
    readonly destMapNum: number;
    readonly destMapGroup: number;
  };
  readonly newCoordEvent?: {
    readonly x: number;
    readonly y: number;
    readonly elevation: number;
    readonly trigger: number;
    readonly index: number;
    readonly scriptPointer: number;
  };
  readonly newBgEvent?: {
    readonly x: number;
    readonly y: number;
    readonly elevation: number;
    readonly kind: number;
    readonly data: number;
  };
}

export interface BinaryRomEditMapEventTableResponse {
  readonly op: 'delete' | 'append';
  readonly kind: 'warp' | 'coordEvent' | 'bgEvent';
  readonly newCount: number;
  readonly mutatedStructOffset: number;
  readonly backupCreated: boolean;
}

export function registerBinaryRomMapEventTableRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditMapEventTableRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/map-event-table',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (
        !body ||
        typeof body.mapEventsStructOffset !== 'number' ||
        typeof body.subArrayOffset !== 'number' ||
        (body.kind !== 'warp' && body.kind !== 'coordEvent' && body.kind !== 'bgEvent') ||
        (body.op !== 'delete' && body.op !== 'append')
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include mapEventsStructOffset, subArrayOffset, kind, op.',
        );
      }
      const stride = MAP_EVENT_STRIDE[body.kind];
      const countOffset = MAP_EVENT_COUNT_BYTE_OFFSET[body.kind];

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (
        body.mapEventsStructOffset < 0 ||
        body.mapEventsStructOffset + 20 > romBytes.length
      ) {
        return errorResponse(reply, 400, 'internal_error', 'MapEvents offset out of bounds.');
      }

      const currentCount = romBytes[body.mapEventsStructOffset + countOffset]!;

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }

      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      let newCount = currentCount;
      let mutatedStructOffset = 0;

      if (body.op === 'delete') {
        if (typeof body.deleteStructFileOffset !== 'number') {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'op=delete requires deleteStructFileOffset.',
          );
        }
        const idx = (body.deleteStructFileOffset - body.subArrayOffset) / stride;
        if (!Number.isInteger(idx) || idx < 0 || idx >= currentCount) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `Delete offset doesn't align to a slot.`,
          );
        }
        const arrayEndExclusive = body.subArrayOffset + currentCount * stride;
        const bytesToShift = (currentCount - 1 - idx) * stride;
        if (bytesToShift > 0) {
          out.copy(
            out,
            body.subArrayOffset + idx * stride,
            body.subArrayOffset + (idx + 1) * stride,
            arrayEndExclusive,
          );
        }
        for (let i = 0; i < stride; i++) {
          out[arrayEndExclusive - stride + i] = 0;
        }
        newCount = currentCount - 1;
        mutatedStructOffset = body.subArrayOffset + idx * stride;
      } else {
        // append
        if (currentCount >= 0xff) {
          return errorResponse(reply, 400, 'internal_error', 'Count at u8 max.');
        }
        const newSlotStart = body.subArrayOffset + currentCount * stride;
        if (newSlotStart + stride > out.length) {
          return errorResponse(reply, 400, 'internal_error', 'New slot would extend past ROM end.');
        }
        if (body.kind === 'warp') {
          const w = body.newWarp;
          if (!w) return errorResponse(reply, 400, 'internal_error', 'op=append/warp needs newWarp');
          view.setInt16(newSlotStart + 0x00, w.x, true);
          view.setInt16(newSlotStart + 0x02, w.y, true);
          view.setUint8(newSlotStart + 0x04, w.elevation & 0xff);
          view.setUint8(newSlotStart + 0x05, w.warpId & 0xff);
          view.setUint8(newSlotStart + 0x06, w.destMapNum & 0xff);
          view.setUint8(newSlotStart + 0x07, w.destMapGroup & 0xff);
        } else if (body.kind === 'coordEvent') {
          const c = body.newCoordEvent;
          if (!c)
            return errorResponse(
              reply,
              400,
              'internal_error',
              'op=append/coordEvent needs newCoordEvent',
            );
          view.setInt16(newSlotStart + 0x00, c.x, true);
          view.setInt16(newSlotStart + 0x02, c.y, true);
          view.setUint8(newSlotStart + 0x04, c.elevation & 0xff);
          view.setUint8(newSlotStart + 0x05, 0);
          view.setUint16(newSlotStart + 0x06, c.trigger & 0xffff, true);
          view.setUint16(newSlotStart + 0x08, c.index & 0xffff, true);
          view.setUint16(newSlotStart + 0x0a, 0, true);
          view.setUint32(newSlotStart + 0x0c, c.scriptPointer >>> 0, true);
        } else {
          // bgEvent
          const b = body.newBgEvent;
          if (!b)
            return errorResponse(
              reply,
              400,
              'internal_error',
              'op=append/bgEvent needs newBgEvent',
            );
          view.setInt16(newSlotStart + 0x00, b.x, true);
          view.setInt16(newSlotStart + 0x02, b.y, true);
          view.setUint8(newSlotStart + 0x04, b.elevation & 0xff);
          view.setUint8(newSlotStart + 0x05, b.kind & 0xff);
          view.setUint16(newSlotStart + 0x06, 0, true);
          view.setUint32(newSlotStart + 0x08, b.data >>> 0, true);
        }
        newCount = currentCount + 1;
        mutatedStructOffset = newSlotStart;
      }
      out[body.mapEventsStructOffset + countOffset] = newCount;

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditMapEventTableResponse = {
        op: body.op,
        kind: body.kind,
        newCount,
        mutatedStructOffset,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase O.22 - Binary-rom Warp struct field writer
//
// POST /api/projects/:id/binary-rom-edit/warp-fields
//   body: { structFileOffset, fields: {
//     elevation?, warpId?, destMapNum?, destMapGroup?
//   } }
//
// Warp struct (8 bytes):
//   +0x00 s16 x
//   +0x02 s16 y
//   +0x04 u8  elevation
//   +0x05 u8  warpId       (= dest_warp_id, index into dest map's warps[])
//   +0x06 u8  destMapNum
//   +0x07 u8  destMapGroup
//
// x + y are NOT touched by this route - the existing CoordEditor
// handles position via the same map-cells route used by every other
// marker. This route covers the "where does this warp go?" fields.
// ─────────────────────────────────────────────────────────────────────

const WARP_STRUCT_SIZE = 8;
const WARP_OFFSET_ELEVATION = 0x04;
const WARP_OFFSET_WARP_ID = 0x05;
const WARP_OFFSET_DEST_MAP_NUM = 0x06;
const WARP_OFFSET_DEST_MAP_GROUP = 0x07;

export interface BinaryRomEditWarpFieldsRequest {
  readonly structFileOffset: number;
  readonly fields: {
    readonly elevation?: number;
    readonly warpId?: number;
    readonly destMapNum?: number;
    readonly destMapGroup?: number;
  };
}

export interface BinaryRomEditWarpFieldsResponse {
  readonly structFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomWarpFieldsRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{
    Params: { id: string };
    Body: BinaryRomEditWarpFieldsRequest;
  }>(
    '/api/projects/:id/binary-rom-edit/warp-fields',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      const body = req.body;
      if (
        !body ||
        typeof body.structFileOffset !== 'number' ||
        !body.fields
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include structFileOffset and fields.',
        );
      }
      const f = body.fields;
      for (const [name, value] of Object.entries(f)) {
        if (value === undefined) continue;
        if (typeof value !== 'number') {
          return errorResponse(reply, 400, 'internal_error', `${name} must be a number.`);
        }
        if (value < 0 || value > 0xff) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `${name} ${String(value)} out of u8 range (0..255).`,
          );
        }
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) return errorResponse(reply, 400, 'no_rom_file', 'No .gba');
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (
        body.structFileOffset < 0 ||
        body.structFileOffset + WARP_STRUCT_SIZE > romBytes.length
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'structFileOffset out of ROM bounds.',
        );
      }

      const out = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length).slice();
      const fieldsWritten: string[] = [];

      if (f.elevation !== undefined) {
        out[body.structFileOffset + WARP_OFFSET_ELEVATION] = f.elevation;
        fieldsWritten.push('elevation');
      }
      if (f.warpId !== undefined) {
        out[body.structFileOffset + WARP_OFFSET_WARP_ID] = f.warpId;
        fieldsWritten.push('warpId');
      }
      if (f.destMapNum !== undefined) {
        out[body.structFileOffset + WARP_OFFSET_DEST_MAP_NUM] = f.destMapNum;
        fieldsWritten.push('destMapNum');
      }
      if (f.destMapGroup !== undefined) {
        out[body.structFileOffset + WARP_OFFSET_DEST_MAP_GROUP] = f.destMapGroup;
        fieldsWritten.push('destMapGroup');
      }

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        await fsp.copyFile(romPath, backupPath);
        backupCreated = true;
      }
      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditWarpFieldsResponse = {
        structFileOffset: body.structFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase K - Encounter slot writer
//
// POST /api/projects/:id/binary-rom-edit/encounter-slot
//   body: { slotFileOffset, fields: { speciesId?, minLevel?, maxLevel? } }
//   → patches the 4-byte WildPokemon struct at slotFileOffset:
//        +0x00 u8  minLevel
//        +0x01 u8  maxLevel
//        +0x02 u16 species
//
// Validates ranges (level 1..100, species 0..0xFFFF). The encounter-rate
// field on the parent WildPokemonInfo is separate (u8 at infoOffset+0)
// and edited via a sibling route below.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomEditEncounterSlotRequest {
  readonly slotFileOffset: number;
  readonly fields: {
    readonly speciesId?: number;
    readonly minLevel?: number;
    readonly maxLevel?: number;
  };
}

export interface BinaryRomEditEncounterSlotResponse {
  readonly slotFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export function registerBinaryRomEncounterSlotRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomEditEncounterSlotRequest }>(
    '/api/projects/:id/binary-rom-edit/encounter-slot',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (
        !body ||
        typeof body.slotFileOffset !== 'number' ||
        !body.fields ||
        typeof body.fields !== 'object'
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include numeric slotFileOffset + fields object.',
        );
      }
      const f = body.fields;
      if (f.minLevel !== undefined && (f.minLevel < 1 || f.minLevel > 100)) {
        return errorResponse(reply, 400, 'internal_error', 'minLevel must be 1..100');
      }
      if (f.maxLevel !== undefined && (f.maxLevel < 1 || f.maxLevel > 100)) {
        return errorResponse(reply, 400, 'internal_error', 'maxLevel must be 1..100');
      }
      if (f.speciesId !== undefined && (f.speciesId < 0 || f.speciesId > 0xffff)) {
        return errorResponse(reply, 400, 'internal_error', 'speciesId must be 0..0xFFFF');
      }
      if (
        f.minLevel !== undefined &&
        f.maxLevel !== undefined &&
        f.maxLevel < f.minLevel
      ) {
        return errorResponse(reply, 400, 'internal_error', 'maxLevel must be ≥ minLevel');
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      if (body.slotFileOffset < 0 || body.slotFileOffset + 4 > romBytes.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Slot offset out of ROM bounds.',
        );
      }

      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(reply, 500, 'internal_error', `Backup failed: ${String(e)}`);
        }
      }

      const out = Buffer.from(romBytes);
      const view = new DataView(out.buffer, out.byteOffset, out.length);
      const fieldsWritten: string[] = [];
      if (f.minLevel !== undefined) {
        view.setUint8(body.slotFileOffset + 0x00, f.minLevel);
        fieldsWritten.push('minLevel');
      }
      if (f.maxLevel !== undefined) {
        view.setUint8(body.slotFileOffset + 0x01, f.maxLevel);
        fieldsWritten.push('maxLevel');
      }
      if (f.speciesId !== undefined) {
        view.setUint16(body.slotFileOffset + 0x02, f.speciesId, true);
        fieldsWritten.push('speciesId');
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditEncounterSlotResponse = {
        slotFileOffset: body.slotFileOffset,
        fieldsWritten,
        backupCreated,
      };
      return response;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase J.4 - MetatileAttributes read + write routes
//
// GET-style POST /api/projects/:id/binary-rom-metatile-attrs
//   body: { tilesetStructOffset, metatileId, family: 'frlg'|'rse' }
//   → returns { behavior, terrainType, encounterType, layerType, attrsOffset }
//
// POST /api/projects/:id/binary-rom-edit/metatile-attrs
//   body: { tilesetStructOffset, metatileId, family,
//           attrs: { behavior?, terrainType?, encounterType?, layerType? } }
//   → patches the 2- (RSE) or 4- (FRLG) byte attribute word at
//     attrsOffset + metatileId * stride, preserving padding bits.
// ─────────────────────────────────────────────────────────────────────

export interface BinaryRomGetMetatileAttrsRequest {
  readonly tilesetStructOffset: number;
  readonly metatileId: number;
  readonly family: 'frlg' | 'rse';
}

export interface BinaryRomGetMetatileAttrsResponse {
  readonly behavior: number;
  readonly terrainType: number;
  readonly encounterType: number;
  readonly layerType: number;
  readonly attrsOffset: number;
}

export interface BinaryRomEditMetatileAttrsRequest {
  readonly tilesetStructOffset: number;
  readonly metatileId: number;
  readonly family: 'frlg' | 'rse';
  readonly attrs: {
    readonly behavior?: number;
    readonly terrainType?: number;
    readonly encounterType?: number;
    readonly layerType?: number;
  };
}

export interface BinaryRomEditMetatileAttrsResponse {
  readonly tilesetStructOffset: number;
  readonly metatileId: number;
  readonly attrsOffset: number;
  readonly bytesWritten: number;
  readonly backupCreated: boolean;
}

/** Reads the Tileset struct's slot10/slot14 ptr depending on family +
 *  resolves the attribute-table file offset. Returns null if either
 *  parsing fails or the family-specific slot is NULL. */
function resolveMetatileAttrsOffset(
  romBytes: Uint8Array,
  tilesetStructOffset: number,
  family: 'frlg' | 'rse',
): number | null {
  const parsed = maps.parseTileset(romBytes, tilesetStructOffset);
  if (!parsed.ok) return null;
  // FRLG: attrs at slot14. RSE: attrs at slot10.
  return family === 'frlg' ? parsed.tileset.slot14Offset : parsed.tileset.slot10Offset;
}

export function registerBinaryRomMetatileAttrsRoutes({
  app,
  sessionStore,
  errorResponse,
}: RegisterBinaryRomGraphicsRoutesArgs): void {
  app.post<{ Params: { id: string }; Body: BinaryRomGetMetatileAttrsRequest }>(
    '/api/projects/:id/binary-rom-metatile-attrs',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session not found`);
      }
      const body = req.body;
      if (
        !body ||
        typeof body.tilesetStructOffset !== 'number' ||
        typeof body.metatileId !== 'number' ||
        (body.family !== 'frlg' && body.family !== 'rse')
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include tilesetStructOffset, metatileId, and family.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const buf = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length);
      const attrsBase = resolveMetatileAttrsOffset(buf, body.tilesetStructOffset, body.family);
      if (attrsBase === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No attribute pointer in tileset @ 0x${body.tilesetStructOffset.toString(16)} for family ${body.family}.`,
        );
      }
      const stride = maps.metatileAttributesStride(body.family);
      const attrsOffset = attrsBase + body.metatileId * stride;
      if (attrsOffset < 0 || attrsOffset + stride > buf.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Attribute offset out of ROM bounds.`,
        );
      }
      const attrs = maps.parseMetatileAttributes(buf, attrsOffset, body.family);
      const response: BinaryRomGetMetatileAttrsResponse = {
        behavior: attrs.behavior,
        terrainType: attrs.terrainType,
        encounterType: attrs.encounterType,
        layerType: attrs.layerType,
        attrsOffset,
      };
      return response;
    },
  );

  app.post<{ Params: { id: string }; Body: BinaryRomEditMetatileAttrsRequest }>(
    '/api/projects/:id/binary-rom-edit/metatile-attrs',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session not found`);
      }
      const body = req.body;
      if (
        !body ||
        typeof body.tilesetStructOffset !== 'number' ||
        typeof body.metatileId !== 'number' ||
        (body.family !== 'frlg' && body.family !== 'rse') ||
        !body.attrs
      ) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Body must include tilesetStructOffset, metatileId, family, and attrs.',
        );
      }
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (romPath === null) {
        return errorResponse(reply, 400, 'no_rom_file', 'No .gba in project root.');
      }
      let romBytes: Buffer;
      try {
        romBytes = await fsp.readFile(romPath);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Read failed: ${String(e)}`);
      }
      const buf = new Uint8Array(romBytes.buffer, romBytes.byteOffset, romBytes.length);
      const attrsBase = resolveMetatileAttrsOffset(buf, body.tilesetStructOffset, body.family);
      if (attrsBase === null) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No attribute pointer in tileset @ 0x${body.tilesetStructOffset.toString(16)} for family ${body.family}.`,
        );
      }
      const stride = maps.metatileAttributesStride(body.family);
      const attrsOffset = attrsBase + body.metatileId * stride;
      if (attrsOffset < 0 || attrsOffset + stride > buf.length) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Attribute offset out of ROM bounds.`,
        );
      }

      // Backup if needed.
      const backupPath = `${romPath}.bak`;
      let backupCreated = false;
      try {
        await fsp.access(backupPath);
      } catch {
        try {
          await fsp.copyFile(romPath, backupPath);
          backupCreated = true;
        } catch (e) {
          req.log.error(e);
          return errorResponse(
            reply,
            500,
            'internal_error',
            `Backup failed: ${String(e)}`,
          );
        }
      }

      const out = Buffer.from(romBytes);
      const outBuf = new Uint8Array(out.buffer, out.byteOffset, out.length);
      const newBytes = maps.encodeMetatileAttributes(outBuf, attrsOffset, body.family, body.attrs);
      for (let i = 0; i < newBytes.length; i++) {
        out[attrsOffset + i] = newBytes[i]!;
      }

      try {
        await fsp.writeFile(romPath, out);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', `Write failed: ${String(e)}`);
      }

      const response: BinaryRomEditMetatileAttrsResponse = {
        tilesetStructOffset: body.tilesetStructOffset,
        metatileId: body.metatileId,
        attrsOffset,
        bytesWritten: newBytes.length,
        backupCreated,
      };
      return response;
    },
  );
}
