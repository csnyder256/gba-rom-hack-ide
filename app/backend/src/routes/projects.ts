import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  DirectoryListing,
  ProjectErrorCode,
  ProjectErrorResponse,
  ProjectOpenRequest,
  ProjectOpenResponse,
} from '@rom-editor/shared';
import type { ProjectSessionStore } from '../projects/session-store.js';
import {
  NotADirectoryError,
  NotFoundError,
  PathEscapeError,
  listDirectory,
} from '../projects/directory.js';
import { detectProject } from '../detect/index.js';
import { scanProject, writeManifest, readManifest, manifestPathFor } from '../scan/index.js';
import type {
  BuildArtifactsResponse,
  BuildRunRequest,
  BuildRunResponse,
  LayoutData,
  MechanicConfigResponse,
  MechanicId,
  PatchGenerationRequest,
  PatchGenerationResponse,
  ScanResponse,
  SearchRequest,
  SearchResponse,
  SharePackageRequest,
  SharePackageResponse,
} from '@rom-editor/shared';
import { searchManifest } from '../search/search.js';
import { runCommand } from '../build/runner.js';
import { findLayoutDirById, parseLayoutDir, LayoutParseError } from '../scan/layouts.js';
import { renderLayoutMetatiles } from '../scan/tileset-render.js';
import { ScriptSourceError, fetchScriptSource } from '../scan/script-source.js';
import { MoveEventError, moveEvent } from '../events/move.js';
import { PatchFieldsError, patchEventFields } from '../events/patch-fields.js';
import { DialogueEditError, editDialogueText } from '../events/dialogue.js';
import {
  resolveTrainerIdFromScripts,
  getTrainerParty,
  editTrainerParty,
} from '../events/trainer-party-edit.js';
import type { PartyMon } from '../scan/trainers-party.js';
import { readDecompNames } from '../scan/decomp-names.js';
import { readSpecies, toSpeciesDetail, editSpecies, type SpeciesEdit } from '../scan/data/species.js';
import { readSpeciesEnums } from '../scan/data/constants.js';
import { readMoves, toMoveDetail, moveEnums, editMove, type MoveEdit } from '../scan/data/moves.js';
import { readAbilities, editAbility, type AbilityEdit } from '../scan/data/abilities.js';
import { readItems, itemEnums, editItem, type ItemEdit } from '../scan/data/items.js';
import { editEncounterSlot, type EncounterSlotEdit } from '../scan/data/encounters-edit.js';
import { readLearnsets, editLearnsetMove, type LearnsetEntryEdit } from '../scan/data/learnsets.js';
import { readTypeChart, editTypeChartCell } from '../scan/data/typechart.js';
import { addObjectEventToMap, setObjectEventFields, type NewObjectEventInput } from '../events/decomp-map-events.js';
import { addTalkScript, addTrainerNpcScript } from '../events/decomp-scripts.js';
import { startDecompBuild, getDecompBuildJob } from '../build/decomp-build.js';
import { AssetImportError, importAssetPng, replaceAssetPng } from '../events/asset-import.js';
import { probeBuildArtifacts } from '../events/build-artifacts.js';
import { PatchGenerationError, generatePatch } from '../events/patch-gen.js';
import { ModernizeError, modernizeRom } from '../agent/modernize.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SharePackageError, materializeSharePackage } from '../events/share-package.js';
import {
  MechanicConfigError,
  patchMechanicConfig,
  readMechanicConfig,
} from '../events/mechanic-config.js';
import { TemplateStagingError, stageTemplate } from '../events/template-staging.js';
import { loadProjectPlugins } from '../plugins/loader.js';
import { intakeFile, IntakeError } from '../projects/intake.js';
import { pickPath, type PickKind } from '../projects/file-picker.js';
import { appendOpLogEntry, readOpLogTail, type OpKind } from '../events/op-log.js';
import {
  UndoError,
  applyForward,
  applyReverse,
  computeUndoState,
  computeUndoStateInternal,
} from '../events/undo.js';

// Best-effort op-log writer. Never throws - a log failure should not abort
// the user's successful mutation. Errors are logged via Fastify and dropped.
async function recordOp(
  app: { log: { warn: (e: unknown, msg?: string) => void } },
  projectRoot: string,
  sessionId: string,
  op: OpKind,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await appendOpLogEntry({ projectRoot, sessionId, op, payload });
  } catch (e) {
    app.log.warn(e, `op-log append failed for op=${op}`);
  }
}
import type {
  MoveEventKind,
  MoveEventRequest,
  MoveEventResponse,
} from '@rom-editor/shared';

export interface ProjectsRouteOptions {
  readonly sessionStore: ProjectSessionStore;
  readonly nativePicker?: typeof pickPath;
}

function errorResponse(
  reply: FastifyReply,
  status: number,
  code: ProjectErrorCode,
  message: string,
): ProjectErrorResponse {
  void reply.code(status);
  return { error: { code, message } };
}

export async function registerProjectsRoute(
  app: FastifyInstance,
  options: ProjectsRouteOptions,
): Promise<void> {
  const { sessionStore } = options;

  const openBodySchema = {
    type: 'object',
    required: ['projectRoot'],
    additionalProperties: false,
    properties: {
      projectRoot: { type: 'string', minLength: 1 },
    },
  } as const;

  app.post<{ Body: ProjectOpenRequest }>(
    '/api/projects/open',
    { schema: { body: openBodySchema } },
    async (req, reply) => {
      const { projectRoot } = req.body;
      if (!path.isAbsolute(projectRoot)) {
        return errorResponse(
          reply,
          400,
          'project_root_not_absolute',
          `projectRoot must be an absolute path; got '${projectRoot}'`,
        );
      }
      let stat;
      try {
        stat = await fsp.stat(projectRoot);
      } catch {
        return errorResponse(
          reply,
          404,
          'project_root_not_found',
          `projectRoot '${projectRoot}' does not exist`,
        );
      }
      if (!stat.isDirectory()) {
        return errorResponse(
          reply,
          400,
          'project_root_not_directory',
          `projectRoot '${projectRoot}' is not a directory`,
        );
      }
      const resolved = path.resolve(projectRoot);
      const session = sessionStore.create(resolved);
      const [rootListing, identity] = await Promise.all([
        listDirectory(resolved, ''),
        detectProject(resolved),
      ]);
      const response: ProjectOpenResponse = { session, rootListing, identity };
      return response;
    },
  );

  const openFromFileBodySchema = {
    type: 'object',
    required: ['filePath'],
    additionalProperties: false,
    properties: {
      filePath: { type: 'string', minLength: 1 },
    },
  } as const;

  app.post<{ Body: { filePath: string } }>(
    '/api/projects/open-from-file',
    { schema: { body: openFromFileBodySchema } },
    async (req, reply) => {
      const { filePath } = req.body;
      if (!path.isAbsolute(filePath)) {
        return errorResponse(
          reply,
          400,
          'project_root_not_absolute',
          `filePath must be an absolute path; got '${filePath}'`,
        );
      }
      let intake;
      try {
        intake = await intakeFile(filePath);
      } catch (e) {
        if (e instanceof IntakeError) {
          const status =
            e.code === 'file_not_found'
              ? 404
              : e.code === 'unsupported_file_kind' || e.code === 'not_a_file'
                ? 400
                : e.code === 'zip_slip_attempt'
                  ? 400
                  : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
      // Reuse the regular open flow on the managed project root.
      const resolved = path.resolve(intake.managedProjectRoot);
      const session = sessionStore.create(resolved);
      const [rootListing, identity] = await Promise.all([
        listDirectory(resolved, ''),
        detectProject(resolved),
      ]);
      const response: ProjectOpenResponse & {
        intake: { kind: typeof intake.intakeKind; originalPath: string; sha1: string };
      } = {
        session,
        rootListing,
        identity,
        intake: { kind: intake.intakeKind, originalPath: intake.originalPath, sha1: intake.sha1 },
      };
      return response;
    },
  );

  const pickBodySchema = {
    type: 'object',
    required: ['kind'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['folder', 'rom-or-archive'] },
    },
  } as const;

  app.post<{ Body: { kind: PickKind } }>(
    '/api/dialogs/pick',
    { schema: { body: pickBodySchema } },
    async (req) => {
      // Picker is best-effort. Errors surface via the typed PickResult fields
      // so the frontend can show a friendly "fall back to typed input" hint
      // without treating the dialog cancel as an error.
      return await (options.nativePicker ?? pickPath)(req.body.kind);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/listing',
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
      const relPath = req.query.path ?? '';
      try {
        const listing: DirectoryListing = await listDirectory(session.projectRoot, relPath);
        return listing;
      } catch (e) {
        if (e instanceof PathEscapeError) {
          return errorResponse(reply, 400, 'path_escapes_project_root', e.message);
        }
        if (e instanceof NotFoundError) {
          return errorResponse(reply, 404, 'path_not_found', e.message);
        }
        if (e instanceof NotADirectoryError) {
          return errorResponse(reply, 400, 'path_not_directory', e.message);
        }
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

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    return session;
  });

  // WP-B - Stream the project's .gba file so the embedded mGBA-WASM
  // emulator can boot it directly. Resolves through findFirstGbaFile
  // (the same helper every other binary-rom-edit route uses) so the
  // route picks up the working .gba even after a name change.
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/rom-bytes',
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
      const { findFirstGbaFile } = await import('../scan/binary-rom.js');
      const romPath = await findFirstGbaFile(session.projectRoot);
      if (!romPath) {
        return errorResponse(
          reply,
          404,
          'path_not_found',
          `No .gba file in ${session.projectRoot}`,
        );
      }
      try {
        const bytes = await fsp.readFile(romPath);
        return reply
          .header('Content-Type', 'application/octet-stream')
          // The .gba is rebuilt in place by Build & Play; never let the browser
          // serve a cached copy or "Reload ROM" shows a stale ROM forever.
          .header('Cache-Control', 'no-store, no-cache, must-revalidate')
          .header('Pragma', 'no-cache')
          .header('Content-Disposition', `attachment; filename="${path.basename(romPath)}"`)
          .send(bytes);
      } catch (e) {
        req.log.error(e);
        return errorResponse(
          reply,
          500,
          'internal_error',
          `ROM read failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/scan', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    const startedAt = Date.now();
    try {
      const result = await scanProject(session.projectRoot);
      const manifestPath = await writeManifest(session.projectRoot, result.manifest);
      const response: ScanResponse = {
        sessionId: session.id,
        manifestPath,
        manifest: result.manifest,
        scannerName: result.scannerName,
        scanDurationMs: Date.now() - startedAt,
        warnings: result.warnings,
      };
      return response;
    } catch (e) {
      req.log.error(e);
      return errorResponse(
        reply,
        500,
        'internal_error',
        e instanceof Error ? e.message : 'scan failed',
      );
    }
  });

  const moveEventBodySchema = {
    type: 'object',
    required: ['x', 'y'],
    additionalProperties: false,
    properties: {
      x: { type: 'integer', minimum: 0, maximum: 10000 },
      y: { type: 'integer', minimum: 0, maximum: 10000 },
    },
  } as const;

  app.patch<{
    Params: { id: string; kind: MoveEventKind; eventId: string };
    Body: MoveEventRequest;
  }>(
    '/api/projects/:id/events/:kind/:eventId',
    { schema: { body: moveEventBodySchema } },
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
      const kind = req.params.kind;
      if (kind !== 'objectEvent' && kind !== 'warp' && kind !== 'trigger') {
        return errorResponse(reply, 400, 'internal_error', `Unknown event kind '${kind}'`);
      }
      const manifest = await readManifest(session.projectRoot);
      if (!manifest) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No manifest. Run POST /api/projects/${session.id}/scan first.`,
        );
      }
      const mapDirByMapId = new Map<string, string>();
      const bounds = new Map<string, { width: number; height: number }>();
      for (const m of manifest.maps) {
        const src = m.metadata['sourceDir'];
        if (typeof src === 'string') {
          const dir = src.replace(/^data\/maps\//, '').replace(/^data\\maps\\/, '');
          mapDirByMapId.set(m.id, dir);
        }
        if (m.dimensions.width > 0 && m.dimensions.height > 0) {
          bounds.set(m.id, { width: m.dimensions.width, height: m.dimensions.height });
        }
      }
      try {
        const result = await moveEvent(kind, req.params.eventId, req.body.x, req.body.y, {
          projectRoot: session.projectRoot,
          mapDirByMapId,
          bounds,
        });
        // Re-scan + persist so subsequent reads see the new coords.
        const rescan = await scanProject(session.projectRoot);
        await writeManifest(session.projectRoot, rescan.manifest);
        const response: MoveEventResponse = {
          entityKind: kind,
          entityId: req.params.eventId,
          mapId: result.mapId,
          previous: result.previous,
          next: result.next,
          mapJsonPath: result.mapJsonPath,
        };
        await recordOp(app, session.projectRoot, session.id, 'move_event', {
          entityKind: kind,
          entityId: req.params.eventId,
          mapId: result.mapId,
          previous: result.previous,
          next: result.next,
        });
        return response;
      } catch (e) {
        if (e instanceof MoveEventError) {
          const status =
            e.code === 'session_not_found' || e.code === 'entity_not_found' || e.code === 'map_not_found'
              ? 404
              : e.code === 'coord_out_of_bounds' || e.code === 'invalid_coord'
                ? 400
                : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  const patchFieldsBodySchema = {
    type: 'object',
    required: ['fields'],
    additionalProperties: false,
    properties: {
      fields: {
        type: 'object',
        // Deliberately UNtyped values. Fastify's Ajv runs with
        // coerceTypes: true, and any typed union here misbehaves:
        //  - `oneOf [string|number|…]` counts a numeric value (e.g.
        //    trainer_sight_or_berry_tree_id: 5) as matching BOTH string
        //    (coerced "5") and number → "must match exactly one schema" → 400.
        //  - `anyOf [string, …]` (string first) coerces 5 → "5", which then
        //    corrupts numeric on-disk fields like `elevation` (writes "5").
        // An untyped additionalProperties performs NO coercion, so values
        // reach patchEventFields with their real JSON types. That handler
        // validates the value type, whitelists the key, and preserves the
        // on-disk JSON type, so type safety is enforced there.
        additionalProperties: true,
      },
    },
  } as const;

  app.patch<{
    Params: { id: string; kind: MoveEventKind; eventId: string };
    Body: { fields: Record<string, unknown> };
  }>(
    '/api/projects/:id/events/:kind/:eventId/fields',
    { schema: { body: patchFieldsBodySchema } },
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
      const kind = req.params.kind;
      if (kind !== 'objectEvent' && kind !== 'warp' && kind !== 'trigger') {
        return errorResponse(reply, 400, 'internal_error', `Unknown event kind '${kind}'`);
      }
      const manifest = await readManifest(session.projectRoot);
      if (!manifest) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No manifest. Run POST /api/projects/${session.id}/scan first.`,
        );
      }
      const mapDirByMapId = new Map<string, string>();
      for (const m of manifest.maps) {
        const src = m.metadata['sourceDir'];
        if (typeof src === 'string') {
          const dir = src.replace(/^data\/maps\//, '').replace(/^data\\maps\\/, '');
          mapDirByMapId.set(m.id, dir);
        }
      }
      try {
        const result = await patchEventFields(kind, req.params.eventId, req.body.fields, {
          projectRoot: session.projectRoot,
          mapDirByMapId,
        });
        const rescan = await scanProject(session.projectRoot);
        await writeManifest(session.projectRoot, rescan.manifest);
        await recordOp(app, session.projectRoot, session.id, 'patch_event_fields', {
          entityKind: kind,
          entityId: req.params.eventId,
          mapId: result.mapId,
          previous: result.previous,
          next: result.next,
        });
        return {
          entityKind: kind,
          entityId: req.params.eventId,
          mapId: result.mapId,
          previous: result.previous,
          next: result.next,
          mapJsonPath: result.mapJsonPath,
        };
      } catch (e) {
        if (e instanceof PatchFieldsError) {
          const status =
            e.code === 'entity_not_found' || e.code === 'map_not_found'
              ? 404
              : e.code === 'invalid_coord'
                ? 400
                : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  const dialogueBodySchema = {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: {
      text: { type: 'string', maxLength: 4096 },
    },
  } as const;

  app.patch<{
    Params: { id: string; label: string };
    Body: { text: string };
  }>(
    '/api/projects/:id/dialogue/:label',
    { schema: { body: dialogueBodySchema } },
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
      try {
        const result = await editDialogueText(req.params.label, req.body.text, {
          projectRoot: session.projectRoot,
        });
        // Re-scan so the cached manifest reflects the new text.
        const rescan = await scanProject(session.projectRoot);
        await writeManifest(session.projectRoot, rescan.manifest);
        await recordOp(app, session.projectRoot, session.id, 'edit_dialogue', {
          label: result.label,
          sourcePath: result.sourcePath,
          previousLineCount: result.previousLines.length,
          nextLineCount: result.nextLines.length,
          // Captured for undo: previous + next text content (line arrays).
          previousLines: result.previousLines,
          nextLines: result.nextLines,
          nextText: req.body.text,
        });
        return result;
      } catch (e) {
        if (e instanceof DialogueEditError) {
          const status = e.code === 'dialogue_not_found' ? 404 : e.code === 'invalid_text' ? 400 : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  // ── Decomp expansion trainer-party editing (src/data/trainers.party) ──
  // GET resolves the trainer an NPC battles (from its script label, via the
  // map's scripts.inc → trainerbattle TRAINER_*) and returns the parsed,
  // human-readable party. PATCH persists an edited party back to source.
  app.get<{
    Params: { id: string };
    Querystring: { script?: string; mapId?: string; trainerId?: string };
  }>('/api/projects/:id/decomp-trainer', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    try {
      let trainerId: string | null = req.query.trainerId ?? null;
      if (!trainerId && req.query.script) {
        let mapSourceDir: string | null = null;
        if (req.query.mapId) {
          const manifest = await readManifest(session.projectRoot);
          const map = manifest?.maps.find((m) => m.id === req.query.mapId);
          const sd = map?.metadata?.['sourceDir'];
          mapSourceDir = typeof sd === 'string' ? sd : null;
        }
        trainerId = await resolveTrainerIdFromScripts(session.projectRoot, req.query.script, {
          mapSourceDir,
        });
      }
      if (!trainerId) {
        return { resolved: false, trainerId: null, trainer: null };
      }
      const trainer = await getTrainerParty(session.projectRoot, trainerId);
      return { resolved: trainer !== null, trainerId, trainer };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  app.patch<{
    Params: { id: string; trainerId: string };
    Body: { party: PartyMon[] };
  }>('/api/projects/:id/decomp-trainer/:trainerId', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    try {
      const result = await editTrainerParty(
        session.projectRoot,
        req.params.trainerId,
        req.body.party,
      );
      const rescan = await scanProject(session.projectRoot);
      await writeManifest(session.projectRoot, rescan.manifest);
      await recordOp(app, session.projectRoot, session.id, 'edit_trainer_party', {
        trainerId: result.trainerId,
        sourcePath: result.sourcePath,
        before: result.before,
        after: result.after,
      });
      return { ok: true, trainerId: result.trainerId };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  // Canonical name lists (species/moves/items/abilities) harvested from the
  // decomp source, for the trainer-team autocomplete. Empty arrays on a
  // non-expansion project - the UI just falls back to free text.
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/decomp-names',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        return await readDecompNames(session.projectRoot);
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp Game-Data engine: Species (A1) ──
  // GET list (summary), GET one (detail + dropdown enums), PATCH one (edit in
  // place, op-logged). Source: src/data/pokemon/species_info/*.h.
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/decomp-species',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const all = await readSpecies(session.projectRoot);
        return {
          species: all.map((s) => {
            const d = toSpeciesDetail(s);
            return {
              id: d.id,
              name: d.name,
              type1: d.type1,
              type2: d.type2,
              bst:
                d.baseHP + d.baseAttack + d.baseDefense + d.baseSpeed + d.baseSpAttack + d.baseSpDefense,
            };
          }),
        };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  app.get<{ Params: { id: string; speciesId: string } }>(
    '/api/projects/:id/decomp-species/:speciesId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const all = await readSpecies(session.projectRoot);
        const found = all.find((s) => s.id === req.params.speciesId);
        if (!found) {
          return errorResponse(reply, 404, 'path_not_found', `Species '${req.params.speciesId}' not found`);
        }
        const enums = await readSpeciesEnums(session.projectRoot);
        return { detail: toSpeciesDetail(found), enums };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  app.patch<{ Params: { id: string; speciesId: string }; Body: { edit: SpeciesEdit } }>(
    '/api/projects/:id/decomp-species/:speciesId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const result = await editSpecies(session.projectRoot, req.params.speciesId, req.body.edit);
        await recordOp(app, session.projectRoot, session.id, 'edit_species', {
          speciesId: req.params.speciesId,
          sourceRel: result.sourceRel,
          before: result.before,
          after: result.after,
        });
        return { ok: true, speciesId: req.params.speciesId };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp Game-Data engine: Moves (A2) ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/decomp-moves', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    try {
      const all = await readMoves(session.projectRoot);
      return {
        moves: all.map((m) => {
          const d = toMoveDetail(m);
          return { id: d.id, name: d.name, type: d.type, power: d.power, category: d.category };
        }),
      };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  app.get<{ Params: { id: string; moveId: string } }>(
    '/api/projects/:id/decomp-moves/:moveId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const all = await readMoves(session.projectRoot);
        const found = all.find((m) => m.id === req.params.moveId);
        if (!found) {
          return errorResponse(reply, 404, 'path_not_found', `Move '${req.params.moveId}' not found`);
        }
        return { detail: toMoveDetail(found), enums: moveEnums(all) };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  app.patch<{ Params: { id: string; moveId: string }; Body: { edit: MoveEdit } }>(
    '/api/projects/:id/decomp-moves/:moveId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const result = await editMove(session.projectRoot, req.params.moveId, req.body.edit);
        await recordOp(app, session.projectRoot, session.id, 'edit_move', {
          moveId: req.params.moveId,
          before: result.before,
          after: result.after,
        });
        return { ok: true, moveId: req.params.moveId };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp Game-Data engine: Abilities (A6) ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/decomp-abilities', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    try {
      return { abilities: await readAbilities(session.projectRoot) };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  app.patch<{ Params: { id: string; abilityId: string }; Body: { edit: AbilityEdit } }>(
    '/api/projects/:id/decomp-abilities/:abilityId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const result = await editAbility(session.projectRoot, req.params.abilityId, req.body.edit);
        await recordOp(app, session.projectRoot, session.id, 'edit_ability', {
          abilityId: req.params.abilityId,
          before: result.before,
          after: result.after,
        });
        return { ok: true, abilityId: req.params.abilityId };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp Game-Data engine: Items (A5) ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/decomp-items', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    try {
      const items = await readItems(session.projectRoot);
      return { items, pockets: itemEnums(items).pockets };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  app.patch<{ Params: { id: string; itemId: string }; Body: { edit: ItemEdit } }>(
    '/api/projects/:id/decomp-items/:itemId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const result = await editItem(session.projectRoot, req.params.itemId, req.body.edit);
        await recordOp(app, session.projectRoot, session.id, 'edit_item', {
          itemId: req.params.itemId,
          before: result.before,
          after: result.after,
        });
        return { ok: true, itemId: req.params.itemId };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp Game-Data engine: Wild encounters (A4) ──
  // Read side is already in the manifest (scan/encounters.ts parses
  // wild_encounters.json). This PATCH edits a single slot's species / level
  // range in place in that JSON (the build regenerates the .h from it).
  app.patch<{
    Params: { id: string; tableId: string; slotIndex: string };
    Body: { edit: EncounterSlotEdit };
  }>(
    '/api/projects/:id/decomp-encounters/:tableId/:slotIndex',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      const slotIndex = Number.parseInt(req.params.slotIndex, 10);
      if (!Number.isInteger(slotIndex) || slotIndex < 0) {
        return errorResponse(reply, 400, 'internal_error', `Invalid slotIndex '${req.params.slotIndex}'`);
      }
      try {
        const result = await editEncounterSlot(
          session.projectRoot,
          req.params.tableId,
          slotIndex,
          req.body.edit,
        );
        await recordOp(app, session.projectRoot, session.id, 'edit_encounter_slot', {
          tableId: req.params.tableId,
          slotIndex,
          before: result.before,
          after: result.after,
        });
        return { ok: true, tableId: req.params.tableId, slotIndex };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp Game-Data engine: Level-up learnsets (A3) ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/decomp-learnsets', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    try {
      return { learnsets: await readLearnsets(session.projectRoot) };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  app.patch<{
    Params: { id: string; learnsetId: string; entryIndex: string };
    Body: { edit: LearnsetEntryEdit };
  }>(
    '/api/projects/:id/decomp-learnsets/:learnsetId/:entryIndex',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      const entryIndex = Number.parseInt(req.params.entryIndex, 10);
      if (!Number.isInteger(entryIndex) || entryIndex < 0) {
        return errorResponse(reply, 400, 'internal_error', `Invalid entryIndex '${req.params.entryIndex}'`);
      }
      try {
        const result = await editLearnsetMove(
          session.projectRoot,
          req.params.learnsetId,
          entryIndex,
          req.body.edit,
        );
        await recordOp(app, session.projectRoot, session.id, 'edit_learnset', {
          learnsetId: req.params.learnsetId,
          entryIndex,
          before: result.before,
          after: result.after,
        });
        return { ok: true, learnsetId: req.params.learnsetId, entryIndex };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp Game-Data engine: Type chart (A8) ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/decomp-typechart', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    try {
      return await readTypeChart(session.projectRoot);
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  app.patch<{
    Params: { id: string; attacker: string; defenderIndex: string };
    Body: { multiplier: number };
  }>(
    '/api/projects/:id/decomp-typechart/:attacker/:defenderIndex',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      const defenderIndex = Number.parseInt(req.params.defenderIndex, 10);
      if (!Number.isInteger(defenderIndex) || defenderIndex < 0) {
        return errorResponse(reply, 400, 'internal_error', `Invalid defenderIndex '${req.params.defenderIndex}'`);
      }
      try {
        const result = await editTypeChartCell(
          session.projectRoot,
          req.params.attacker,
          defenderIndex,
          req.body.multiplier,
        );
        await recordOp(app, session.projectRoot, session.id, 'edit_type_matchup', {
          attacker: req.params.attacker,
          defenderIndex,
          before: result.before,
          after: result.after,
        });
        return { ok: true, attacker: req.params.attacker, defenderIndex };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  // ── Decomp: add a new ObjectEvent (NPC) to a map (appends to map.json) ──
  app.post<{
    Params: { id: string };
    Body: { mapId: string } & NewObjectEventInput;
  }>('/api/projects/:id/decomp-map-object-event', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    const { mapId, ...input } = req.body;
    try {
      const manifest = await readManifest(session.projectRoot);
      const map = manifest?.maps.find((m) => m.id === mapId);
      const sourceDir = typeof map?.metadata?.['sourceDir'] === 'string'
        ? (map.metadata['sourceDir'] as string)
        : null;
      if (!sourceDir) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `Map '${mapId}' has no decomp sourceDir - adding NPCs is only supported on decomp maps (this looks like a binary ROM, where you'd use the agent's propose_add_object_event instead).`,
        );
      }
      const result = await addObjectEventToMap(session.projectRoot, sourceDir, input);
      await recordOp(app, session.projectRoot, session.id, 'add_object_event', {
        mapId,
        sourceDir,
        newIndex: result.newIndex,
        x: result.x,
        y: result.y,
        before: result.before,
        after: result.after,
      });
      return { ok: true, mapId, newIndex: result.newIndex, x: result.x, y: result.y, graphicsId: result.graphicsId };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  // ── Decomp: add a talking NPC (creates a msgbox script + binds it) ──
  app.post<{
    Params: { id: string };
    Body: { mapId: string; x: number; y: number; message: string; name?: string };
  }>('/api/projects/:id/decomp-script-talk-npc', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    const { mapId, x, y, message, name } = req.body;
    try {
      const manifest = await readManifest(session.projectRoot);
      const map = manifest?.maps.find((m) => m.id === mapId);
      const sourceDir = typeof map?.metadata?.['sourceDir'] === 'string' ? (map.metadata['sourceDir'] as string) : null;
      if (!sourceDir) {
        return errorResponse(reply, 400, 'internal_error', `Map '${mapId}' has no decomp sourceDir.`);
      }
      const baseName = name && name.trim() ? name.trim() : `Npc ${String(x)}x${String(y)}`;
      const talk = await addTalkScript(session.projectRoot, sourceDir, baseName, message);
      // Bind to an existing NPC at (x,y); if none, add a new one.
      const bound = await setObjectEventFields(session.projectRoot, sourceDir, { x, y }, { script: talk.scriptLabel });
      if (!bound.matched) {
        await addObjectEventToMap(session.projectRoot, sourceDir, { x, y, script: talk.scriptLabel });
      }
      await recordOp(app, session.projectRoot, session.id, 'add_decomp_script', {
        mapId, sourceDir, kind: 'talk', scriptLabel: talk.scriptLabel, boundExisting: bound.matched,
        before: talk.before, after: talk.after,
      });
      return { ok: true, scriptLabel: talk.scriptLabel, boundExisting: bound.matched };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  // ── Decomp: make a trainer (trainers.party entry + battle script + bind) ──
  app.post<{
    Params: { id: string };
    Body: {
      mapId: string; x: number; y: number;
      trainerName?: string; species?: string; level?: number;
      intro?: string; defeat?: string;
    };
  }>('/api/projects/:id/decomp-make-trainer', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    const { mapId, x, y, trainerName, species, level, intro, defeat } = req.body;
    try {
      const manifest = await readManifest(session.projectRoot);
      const map = manifest?.maps.find((m) => m.id === mapId);
      const sourceDir = typeof map?.metadata?.['sourceDir'] === 'string' ? (map.metadata['sourceDir'] as string) : null;
      if (!sourceDir) {
        return errorResponse(reply, 400, 'internal_error', `Map '${mapId}' has no decomp sourceDir.`);
      }
      const baseName = trainerName && trainerName.trim() ? trainerName.trim() : `Trainer ${String(x)}x${String(y)}`;
      const tr = await addTrainerNpcScript(session.projectRoot, sourceDir, {
        baseName,
        ...(trainerName ? { trainerName } : {}),
        ...(species ? { species } : {}),
        ...(level !== undefined ? { level } : {}),
        ...(intro ? { intro } : {}),
        ...(defeat ? { defeat } : {}),
      });
      const trainerFields = {
        script: tr.scriptLabel,
        trainer_type: 'TRAINER_TYPE_NORMAL',
        trainer_sight_or_berry_tree_id: '4',
      };
      const bound = await setObjectEventFields(session.projectRoot, sourceDir, { x, y }, trainerFields);
      if (!bound.matched) {
        await addObjectEventToMap(session.projectRoot, sourceDir, {
          x, y, script: tr.scriptLabel, trainerType: 'TRAINER_TYPE_NORMAL', trainerSightRange: 4,
        });
      }
      await recordOp(app, session.projectRoot, session.id, 'add_decomp_script', {
        mapId, sourceDir, kind: 'trainer', scriptLabel: tr.scriptLabel, trainerId: tr.trainerId, boundExisting: bound.matched,
        before: tr.scriptsBefore, after: tr.scriptsAfter,
      });
      return { ok: true, scriptLabel: tr.scriptLabel, trainerId: tr.trainerId, boundExisting: bound.matched };
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
    }
  });

  // ── One-click decomp build ("Build & Play") ──
  // POST starts an async `make modern` build (the proven devkitARM recipe) and
  // returns a jobId. GET polls the job for live log + completion. The output
  // ROM path (relative to project root) is returned on success.
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/build/start',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      const result = await startDecompBuild(session.id, session.projectRoot);
      if (result.error || !result.job) {
        return errorResponse(reply, 400, 'build_unavailable', result.error ?? 'Could not start build');
      }
      return { jobId: result.job.id, state: result.job.state };
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/api/projects/:id/build/job/:jobId',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      const job = getDecompBuildJob(req.params.jobId);
      if (!job || job.sessionId !== session.id) {
        return errorResponse(reply, 404, 'job_not_found', `Build job '${req.params.jobId}' not found`);
      }
      return {
        jobId: job.id,
        state: job.state,
        exitCode: job.exitCode,
        log: job.log,
        romRelPath: job.romRelPath,
        errorSummary: job.errorSummary,
        startedAtUtc: job.startedAtUtc,
        endedAtUtc: job.endedAtUtc,
      };
    },
  );

  // Serve the bundled mGBA-wasm engine RAW. Vite proxies /api here, so these
  // files never go through Vite's module pipeline - which is the whole point:
  // the emscripten glue re-loads itself + its .wasm inside a pthread Worker
  // via `new URL('mgba.js'|'mgba.wasm', import.meta.url)`. Importing the npm
  // package through Vite mangles that worker ("worker sent an error"), and
  // /public files can't be import()'d. Serving from a stable same-origin /api
  // URL with COEP lets the worker resolve both files and be cross-origin
  // isolated (SharedArrayBuffer).
  app.get<{ Params: { file: string } }>('/api/emulator-engine/:file', async (req, reply) => {
    const file = req.params.file;
    if (file !== 'mgba.js' && file !== 'mgba.wasm') {
      return errorResponse(reply, 404, 'path_not_found', `Unknown engine file '${file}'`);
    }
    let bytes: Buffer;
    try {
      const require = createRequire(import.meta.url);
      const pkgJson = require.resolve('@thenick775/mgba-wasm/package.json');
      const enginePath = path.join(path.dirname(pkgJson), 'dist', file);
      bytes = await fsp.readFile(enginePath);
    } catch (e) {
      req.log.error(e);
      return errorResponse(reply, 404, 'path_not_found', `Emulator engine '${file}' not found`);
    }
    reply.header('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(bytes);
  });

  // Composed metatile pixels for a layout - the actual rendered tiles, built
  // from the decomp tilesets (tiles.4bpp + metatiles.bin + palettes). Returns
  // metatileId → base64(RGBA 16×16) for every metatile the map uses, so the
  // map panel can draw the real world instead of grey placeholders.
  app.get<{ Params: { id: string }; Querystring: { name?: string } }>(
    '/api/projects/:id/layout-tiles',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      const name = req.query.name;
      if (!name) {
        return errorResponse(reply, 400, 'internal_error', 'layout name query param required');
      }
      try {
        const dir = await findLayoutDirById(session.projectRoot, name);
        if (!dir) {
          return errorResponse(reply, 404, 'path_not_found', `Layout '${name}' not found`);
        }
        const layout = await parseLayoutDir(session.projectRoot, dir);
        const tiles = await renderLayoutMetatiles(session.projectRoot, layout);
        const out: Record<string, string> = {};
        for (const [metatileId, buf] of tiles) out[String(metatileId)] = buf.toString('base64');
        return { tiles: out };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  const assetReplaceBodySchema = {
    type: 'object',
    required: ['pngBase64'],
    additionalProperties: false,
    properties: {
      pngBase64: { type: 'string', minLength: 1, maxLength: 16 * 1024 * 1024 },
    },
  } as const;

  const assetImportBodySchema = {
    type: 'object',
    required: ['relativePath', 'pngBase64'],
    additionalProperties: false,
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: 512 },
      pngBase64: { type: 'string', minLength: 1, maxLength: 16 * 1024 * 1024 },
    },
  } as const;

  app.post<{
    Params: { id: string };
    Body: { relativePath: string; pngBase64: string };
  }>(
    '/api/projects/:id/assets',
    { schema: { body: assetImportBodySchema } },
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
      try {
        const result = await importAssetPng({
          projectRoot: session.projectRoot,
          relativePath: req.body.relativePath,
          pngBase64: req.body.pngBase64,
        });
        // Re-scan so the new asset shows up in the manifest immediately.
        const rescan = await scanProject(session.projectRoot);
        await writeManifest(session.projectRoot, rescan.manifest);
        await recordOp(app, session.projectRoot, session.id, 'import_asset', {
          relativePath: result.relativePath,
          width: result.width,
          height: result.height,
          bitDepth: result.bitDepth,
          bytesWritten: result.bytesWritten,
          // Captured for redo: original bytes so a redoed import recreates
          // the exact same file. (Undo for import is simply unlink.)
          pngBase64: req.body.pngBase64,
        });
        return result;
      } catch (e) {
        if (e instanceof AssetImportError) {
          const status =
            e.code === 'path_already_exists'
              ? 409
              : e.code === 'invalid_png' ||
                  e.code === 'dimensions_out_of_range' ||
                  e.code === 'path_escapes_project_root' ||
                  e.code === 'path_not_under_graphics_or_sound' ||
                  e.code === 'unclassifiable_path'
                ? 400
                : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  app.put<{
    Params: { id: string; assetId: string };
    Body: { pngBase64: string };
  }>(
    '/api/projects/:id/assets/:assetId',
    { schema: { body: assetReplaceBodySchema } },
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
      // Look up the asset in the current manifest so we know its relativePath.
      const manifest = await readManifest(session.projectRoot);
      if (!manifest) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'no_manifest: scan the project before replacing an asset',
        );
      }
      const decodedAssetId = decodeURIComponent(req.params.assetId);
      const asset = manifest.assets.find((a) => a.id === decodedAssetId);
      if (!asset) {
        return errorResponse(reply, 404, 'internal_error', `asset_not_found: '${decodedAssetId}'`);
      }
      try {
        // Capture the prior bytes BEFORE the replace so undo can restore them.
        let previousBytesBase64: string | null = null;
        try {
          const priorBytes = await fsp.readFile(
            path.join(session.projectRoot, asset.relativePath),
          );
          previousBytesBase64 = priorBytes.toString('base64');
        } catch {
          // If the prior file is unreadable, undo for this op won't be
          // possible; recordOp will store null and the undo engine will
          // surface that to the user as a typed error.
        }
        const result = await replaceAssetPng({
          projectRoot: session.projectRoot,
          asset,
          pngBase64: req.body.pngBase64,
        });
        // Re-scan so the cached manifest reflects the new file's metadata.
        const rescan = await scanProject(session.projectRoot);
        await writeManifest(session.projectRoot, rescan.manifest);
        await recordOp(app, session.projectRoot, session.id, 'replace_asset', {
          assetId: result.assetId,
          relativePath: result.relativePath,
          width: result.width,
          height: result.height,
          bitDepth: result.bitDepth,
          bytesWritten: result.bytesWritten,
          previousBytesBase64,
          nextBytesBase64: req.body.pngBase64,
        });
        return result;
      } catch (e) {
        if (e instanceof AssetImportError) {
          const status =
            e.code === 'asset_not_found'
              ? 404
              : e.code === 'invalid_png' || e.code === 'dimensions_out_of_range'
                ? 400
                : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  app.get<{ Params: { id: string }; Querystring: { label?: string } }>(
    '/api/projects/:id/scripts/raw',
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
      const label = req.query.label;
      if (!label) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Query parameter `label` is required.',
        );
      }
      try {
        const result = await fetchScriptSource(session.projectRoot, label);
        return result;
      } catch (e) {
        if (e instanceof ScriptSourceError) {
          const status = e.code === 'label_not_found' ? 404 : 500;
          return errorResponse(reply, status, 'path_not_found', e.message);
        }
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

  app.get<{ Params: { id: string }; Querystring: { name?: string; dir?: string } }>(
    '/api/projects/:id/layout',
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
      const name = req.query.name;
      const dirOverride = req.query.dir;
      if (!name && !dirOverride) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'Either `name` (LAYOUT_*) or `dir` query parameter is required.',
        );
      }
      let layoutDir = dirOverride ?? null;
      if (!layoutDir && name) {
        layoutDir = await findLayoutDirById(session.projectRoot, name);
        if (!layoutDir) {
          return errorResponse(
            reply,
            404,
            'path_not_found',
            `No layout directory found whose layout.json declares id='${name}'.`,
          );
        }
      }
      if (!layoutDir) {
        return errorResponse(reply, 400, 'internal_error', 'layoutDir resolution failed');
      }
      try {
        const data: LayoutData = await parseLayoutDir(session.projectRoot, layoutDir);
        return data;
      } catch (e) {
        if (e instanceof LayoutParseError) {
          return errorResponse(reply, 400, 'internal_error', e.message);
        }
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

  app.get<{ Params: { id: string } }>('/api/projects/:id/manifest-path', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    return { manifestPath: manifestPathFor(session.projectRoot) };
  });

  // WP-C3 - annotation side-car. GET returns the current persisted
  // annotations (empty object when the project has none). PUT replaces
  // the whole map with the supplied body - the frontend keeps its own
  // local copy authoritative and pushes the union here debounced.
  app.get<{ Params: { id: string } }>('/api/projects/:id/annotations', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    const { readAnnotationsSidecar } = await import('../scan/annotations-io.js');
    const sidecar = await readAnnotationsSidecar(session.projectRoot);
    return sidecar;
  });

  app.put<{
    Params: { id: string };
    Body: { annotations?: Readonly<Record<string, { name?: string; description?: string }>> };
  }>('/api/projects/:id/annotations', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    if (!req.body || typeof req.body !== 'object' || !req.body.annotations || typeof req.body.annotations !== 'object') {
      return errorResponse(reply, 400, 'internal_error', 'Body must include annotations object');
    }
    const { writeAnnotationsSidecar, readAnnotationsSidecar } = await import('../scan/annotations-io.js');
    try {
      await writeAnnotationsSidecar(session.projectRoot, req.body.annotations);
    } catch (e) {
      req.log.error(e);
      return errorResponse(
        reply,
        500,
        'internal_error',
        `Write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Return the freshly-written + normalised side-car so the caller
    // can replace its local cache with the canonical shape.
    return await readAnnotationsSidecar(session.projectRoot);
  });

  // AI-1.5a - Cross-project species library. Returns a portable
  // SpeciesLibrary derived from the project's current manifest:
  // names + base stats + learnsets + evolutions + reference tables.
  // No persistent file is written; the library is built on demand
  // so it always reflects the latest scan.
  app.get<{ Params: { id: string } }>('/api/projects/:id/species-library', async (req, reply) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
    }
    const manifest = await readManifest(session.projectRoot);
    if (!manifest) {
      return reply.status(404).send({
        error: { code: 'manifest_not_found', message: `Project at '${session.projectRoot}' has not been scanned yet.` },
      });
    }
    const { buildSpeciesLibrary } = await import('../scan/species-library.js');
    return buildSpeciesLibrary(manifest);
  });

  const searchBodySchema = {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  } as const;

  const buildBodySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      useTestCommand: { type: 'boolean' },
      commandOverride: { type: 'string', minLength: 1, maxLength: 1000 },
      argvOverride: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 64,
      },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 600_000 },
    },
  } as const;

  app.post<{ Params: { id: string }; Body: BuildRunRequest }>(
    '/api/projects/:id/build',
    { schema: { body: buildBodySchema } },
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
      const manifest = await readManifest(session.projectRoot);
      if (!manifest) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No manifest found for this project. Run POST /api/projects/${session.id}/scan first.`,
        );
      }
      let command: string;
      let argvOverride: string[] | undefined;
      if (req.body?.argvOverride && req.body.argvOverride.length > 0) {
        argvOverride = [...req.body.argvOverride];
        command = argvOverride.join(' ');
      } else if (req.body?.commandOverride) {
        command = req.body.commandOverride;
      } else if (!manifest.buildProfile) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          'No build profile detected for this project. Provide commandOverride or argvOverride in the request body to run a custom command.',
        );
      } else if (req.body?.useTestCommand) {
        if (!manifest.buildProfile.testCommand) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            'No testCommand detected. Provide commandOverride to run a custom command.',
          );
        }
        command = manifest.buildProfile.testCommand;
      } else {
        command = manifest.buildProfile.buildCommand;
      }
      const result = await runCommand(command, {
        cwd: session.projectRoot,
        timeoutMs: req.body?.timeoutMs,
        argvOverride,
      });
      const response: BuildRunResponse = {
        sessionId: session.id,
        command: result.command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        spawnError: result.spawnError,
      };
      return response;
    },
  );

  const patchGenBodySchema = {
    type: 'object',
    required: ['baseRomPath', 'modifiedRomPath', 'outputPath'],
    additionalProperties: false,
    properties: {
      baseRomPath: { type: 'string', minLength: 1, maxLength: 1024 },
      modifiedRomPath: { type: 'string', minLength: 1, maxLength: 1024 },
      outputPath: { type: 'string', minLength: 1, maxLength: 1024 },
      patchFormat: { type: 'string', enum: ['ips', 'bps'] },
    },
  } as const;

  app.post<{
    Params: { id: string };
    Body: PatchGenerationRequest;
  }>(
    '/api/projects/:id/patches',
    { schema: { body: patchGenBodySchema } },
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
      try {
        const result = await generatePatch({
          projectRoot: session.projectRoot,
          baseRomPath: req.body.baseRomPath,
          modifiedRomPath: req.body.modifiedRomPath,
          outputPath: req.body.outputPath,
          ...(req.body.patchFormat !== undefined ? { patchFormat: req.body.patchFormat } : {}),
        });
        const response: PatchGenerationResponse = {
          sessionId: session.id,
          outputPath: result.outputPath,
          recordCount: result.recordCount,
          totalPatchedBytes: result.totalPatchedBytes,
          patchBytes: result.patchBytes,
          baseSizeBytes: result.baseSizeBytes,
          modifiedSizeBytes: result.modifiedSizeBytes,
          patchFormat: result.patchFormat,
        };
        return response;
      } catch (e) {
        if (e instanceof PatchGenerationError) {
          const status =
            e.code === 'base_rom_not_found' || e.code === 'modified_rom_not_found'
              ? 404
              : e.code === 'output_path_escapes_project_root' ||
                  e.code === 'rom_empty' ||
                  e.code === 'rom_too_large' ||
                  e.code === 'patch_exceeds_ips_format' ||
                  e.code === 'bps_encode_failed'
                ? 400
                : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  // Modernize-and-Ship slice 4 - one-click "Modernize" upgrade route.
  // Applies the bundled CFRU patch to the project's vanilla FRLG ROM,
  // logs a `modernize_rom` op-log entry on success. No request body
  // (everything needed lives in the bundled assets shipped with the
  // editor). Errors map to plain-English status codes the frontend's
  // ModernizeCard already knows how to render.
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/modernize',
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
      try {
        const result = await modernizeRom({
          projectRoot: session.projectRoot,
          sessionId: session.id,
        });
        await recordOp(app, session.projectRoot, session.id, 'modernize_rom', {
          previousSha1: result.previousSha1,
          newSha1: result.newSha1,
          cfruVersion: result.cfruVersion,
          cfruCommitShortSha: result.cfruCommitShortSha,
          buildOffset: result.buildOffset,
          bytesWritten: result.bytesWritten,
          previousRomBackupPath: result.previousRomBackupPath,
          bundledPatchSha1: result.bundledPatchSha1,
          // Phase 6.2 - persist which bundle was applied so the patch
          // detector can derive `identity.modernizedBy` + `overlaySafe`
          // at scan time and the vanilla-truth overlay can activate.
          bundleId: result.bundleId,
        });
        const response = {
          sessionId: session.id,
          previousSha1: result.previousSha1,
          newSha1: result.newSha1,
          cfruVersion: result.cfruVersion,
          cfruCommitShortSha: result.cfruCommitShortSha,
          buildOffset: result.buildOffset,
          bytesWritten: result.bytesWritten,
          bundleId: result.bundleId,
        };
        return response;
      } catch (e) {
        if (e instanceof ModernizeError) {
          const status =
            e.code === 'rom_hash_mismatch'
              ? 400
              : e.code === 'already_modernized'
                ? 409
                : e.code === 'rom_not_found' || e.code === 'patch_artifact_missing'
                  ? 404
                  : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  // Modernize-and-Ship slice 4 - attribution surface. Returns the
  // bundled CFRU credits + license clause so the AttributionPanel can
  // render Skeli789's no-monetization terms verbatim. Project-scoped
  // for consistency even though the data is bundle-static.
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/modernize/attribution',
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
      // Resolve assets path the same way modernize.ts does. Keep in
      // sync if that helper is ever extracted.
      const assetsRoot = path.resolve(
        fileURLToPath(import.meta.url),
        '..',
        '..',
        'assets',
        'modernize',
      );
      try {
        const jsonText = await fsp.readFile(path.join(assetsRoot, 'cfru.json'), 'utf-8');
        const json = JSON.parse(jsonText) as {
          cfruVersion: string;
          cfruCommitShortSha: string;
          built: boolean;
        };
        let attribution = '';
        try {
          attribution = await fsp.readFile(path.join(assetsRoot, 'ATTRIBUTION.md'), 'utf-8');
        } catch {
          attribution = '(attribution file not found)';
        }
        return {
          cfruVersion: json.cfruVersion,
          cfruCommitShortSha: json.cfruCommitShortSha,
          built: json.built,
          attribution,
        };
      } catch (e) {
        return errorResponse(
          reply,
          500,
          'internal_error',
          `Couldn't load modernize attribution: ${(e as Error).message}`,
        );
      }
    },
  );

  const templateStageBodySchema = {
    type: 'object',
    required: ['params', 'materialization'],
    additionalProperties: false,
    properties: {
      params: { type: 'object', additionalProperties: { type: 'string' } },
      materialization: { type: 'object', additionalProperties: true },
    },
  } as const;

  app.post<{
    Params: { id: string; templateId: string };
    Body: { params: Record<string, string>; materialization: Record<string, unknown> };
  }>(
    '/api/projects/:id/templates/:templateId/stage',
    { schema: { body: templateStageBodySchema } },
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
      try {
        const result = await stageTemplate({
          projectRoot: session.projectRoot,
          templateId: req.params.templateId,
          params: req.body.params,
          materialization: req.body.materialization,
        });
        await recordOp(app, session.projectRoot, session.id, 'stage_template', {
          templateId: result.templateId,
          stagedPath: result.stagedPath,
          params: req.body.params,
          // Captured for redo: full materialization so a redoed stage
          // recreates the same staged JSON.
          materialization: req.body.materialization,
        });
        return { sessionId: session.id, ...result };
      } catch (e) {
        if (e instanceof TemplateStagingError) {
          const status = e.code === 'invalid_template_id' || e.code === 'invalid_payload' ? 400 : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/plugins',
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
      try {
        const result = await loadProjectPlugins(session.projectRoot);
        return result;
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

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string };
  }>(
    '/api/projects/:id/op-log',
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
      let limit = 200;
      if (req.query.limit !== undefined) {
        const n = Number.parseInt(req.query.limit, 10);
        if (Number.isFinite(n) && n > 0 && n <= 1000) limit = n;
      }
      try {
        const result = await readOpLogTail(session.projectRoot, limit);
        return { sessionId: session.id, ...result };
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

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/undo-state',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const log = await readOpLogTail(session.projectRoot, 1000);
        const state = computeUndoState(log.entries);
        return { sessionId: session.id, ...state };
      } catch (e) {
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  async function loadActiveManifestOrFail(session: { projectRoot: string }, reply: import('fastify').FastifyReply) {
    const manifest = await readManifest(session.projectRoot);
    if (!manifest) {
      return errorResponse(
        reply,
        400,
        'internal_error',
        'no_manifest: scan the project before undo/redo',
      );
    }
    return manifest;
  }

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/undo',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const log = await readOpLogTail(session.projectRoot, 1000);
        const internal = computeUndoStateInternal(log.entries);
        const nextUndoId = internal.applied[internal.applied.length - 1];
        if (!nextUndoId) {
          return errorResponse(reply, 400, 'internal_error', 'nothing_to_undo: nothing to undo');
        }
        const entry = internal.entriesById.get(nextUndoId);
        if (!entry) {
          return errorResponse(reply, 500, 'internal_error', `op-log inconsistency: missing entry ${nextUndoId}`);
        }
        const manifest = await loadActiveManifestOrFail(session, reply);
        if (typeof manifest !== 'object' || manifest === null || 'error' in manifest) return manifest;
        await applyReverse(entry, { projectRoot: session.projectRoot, manifest });
        // Re-scan after the reverse so the cached manifest reflects new disk state.
        const rescan = await scanProject(session.projectRoot);
        await writeManifest(session.projectRoot, rescan.manifest);
        const undoEntry = await appendOpLogEntry({
          projectRoot: session.projectRoot,
          sessionId: session.id,
          op: 'undo',
          payload: { reversedOp: entry.op, reversedEntryId: entry.entryId },
          undoOf: entry.entryId,
        });
        return { sessionId: session.id, undoOf: entry.entryId, undoEntryId: undoEntry.entryId, reversedOp: entry.op };
      } catch (e) {
        if (e instanceof UndoError) {
          const status = e.code === 'missing_previous_state' ? 422 : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/redo',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', `Session '${req.params.id}' not found`);
      }
      try {
        const log = await readOpLogTail(session.projectRoot, 1000);
        const internal = computeUndoStateInternal(log.entries);
        const slot = internal.redoable[internal.redoable.length - 1];
        if (!slot) {
          return errorResponse(reply, 400, 'internal_error', 'nothing_to_redo: nothing to redo');
        }
        const originalEntry = internal.entriesById.get(slot.originalId);
        if (!originalEntry) {
          return errorResponse(reply, 500, 'internal_error', `op-log inconsistency: missing entry ${slot.originalId}`);
        }
        const manifest = await loadActiveManifestOrFail(session, reply);
        if (typeof manifest !== 'object' || manifest === null || 'error' in manifest) return manifest;
        await applyForward(originalEntry, { projectRoot: session.projectRoot, manifest });
        const rescan = await scanProject(session.projectRoot);
        await writeManifest(session.projectRoot, rescan.manifest);
        const redoEntry = await appendOpLogEntry({
          projectRoot: session.projectRoot,
          sessionId: session.id,
          op: 'redo',
          payload: { reappliedOp: originalEntry.op, reappliedEntryId: originalEntry.entryId },
          redoOf: slot.undoEntryId,
        });
        return { sessionId: session.id, redoOf: slot.undoEntryId, redoEntryId: redoEntry.entryId, reappliedOp: originalEntry.op };
      } catch (e) {
        if (e instanceof UndoError) {
          const status = e.code === 'missing_previous_state' ? 422 : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
        req.log.error(e);
        return errorResponse(reply, 500, 'internal_error', e instanceof Error ? e.message : 'unknown');
      }
    },
  );

  const sharePackageBodySchema = {
    type: 'object',
    required: ['patchPath', 'baseRomPath', 'outputDir', 'meta'],
    additionalProperties: false,
    properties: {
      patchPath: { type: 'string', minLength: 1, maxLength: 1024 },
      baseRomPath: { type: 'string', minLength: 1, maxLength: 1024 },
      outputDir: { type: 'string', minLength: 1, maxLength: 1024 },
      meta: {
        type: 'object',
        required: ['modName', 'version', 'author', 'description'],
        additionalProperties: false,
        properties: {
          modName: { type: 'string', minLength: 1, maxLength: 200 },
          version: { type: 'string', maxLength: 60 },
          author: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 4000 },
        },
      },
    },
  } as const;

  app.post<{
    Params: { id: string };
    Body: SharePackageRequest;
  }>(
    '/api/projects/:id/share-package',
    { schema: { body: sharePackageBodySchema } },
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
      try {
        const result = await materializeSharePackage({
          projectRoot: session.projectRoot,
          patchPath: req.body.patchPath,
          baseRomPath: req.body.baseRomPath,
          meta: req.body.meta,
          outputDir: req.body.outputDir,
        });
        const response: SharePackageResponse = {
          sessionId: session.id,
          outputDir: result.outputDir,
          files: result.files,
          totalSize: result.totalSize,
          baseRomSha256: result.baseRomSha256,
        };
        return response;
      } catch (e) {
        if (e instanceof SharePackageError) {
          const status =
            e.code === 'patch_not_found' || e.code === 'base_rom_not_found'
              ? 404
              : e.code === 'output_dir_escapes_project_root' || e.code === 'invalid_meta'
                ? 400
                : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/mechanic-config',
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
      try {
        const doc = await readMechanicConfig(session.projectRoot);
        const response: MechanicConfigResponse = { sessionId: session.id, doc };
        return response;
      } catch (e) {
        if (e instanceof MechanicConfigError) {
          return errorResponse(reply, 400, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  const mechanicPatchBodySchema = {
    type: 'object',
    additionalProperties: true,
  } as const;

  app.patch<{
    Params: { id: string; mechanicId: string };
    Body: Record<string, unknown>;
  }>(
    '/api/projects/:id/mechanic-config/:mechanicId',
    { schema: { body: mechanicPatchBodySchema } },
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
      try {
        // Capture the prior doc BEFORE the patch so undo can restore it.
        const previousDoc = await readMechanicConfig(session.projectRoot);
        const doc = await patchMechanicConfig(
          session.projectRoot,
          req.params.mechanicId as MechanicId,
          req.body ?? {},
        );
        await recordOp(app, session.projectRoot, session.id, 'patch_mechanic_config', {
          mechanicId: req.params.mechanicId,
          patch: req.body ?? {},
          previousDoc: previousDoc as unknown as Record<string, unknown>,
          nextDoc: doc as unknown as Record<string, unknown>,
        });
        const response: MechanicConfigResponse = { sessionId: session.id, doc };
        return response;
      } catch (e) {
        if (e instanceof MechanicConfigError) {
          const status = e.code === 'unknown_mechanic_id' ? 404 : e.code === 'invalid_shape' ? 400 : 500;
          return errorResponse(reply, status, 'internal_error', `${e.code}: ${e.message}`);
        }
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

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/build/artifacts',
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
      const manifest = await readManifest(session.projectRoot);
      const profile = manifest?.buildProfile ?? null;
      const outputPaths = profile?.outputPaths ?? [];
      const probed = await probeBuildArtifacts(session.projectRoot, outputPaths);
      const response: BuildArtifactsResponse = {
        sessionId: session.id,
        buildProfileDetected: profile !== null,
        outputPaths: probed,
      };
      return response;
    },
  );

  app.post<{ Params: { id: string }; Body: SearchRequest }>(
    '/api/projects/:id/search',
    { schema: { body: searchBodySchema } },
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
      const manifest = await readManifest(session.projectRoot);
      if (!manifest) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `No manifest found for this project. Run POST /api/projects/${session.id}/scan first.`,
        );
      }
      const result = searchManifest(manifest, req.body.query, { limit: req.body.limit });
      const response: SearchResponse = {
        query: req.body.query,
        tokenizedTerms: result.terms,
        hits: result.hits,
        truncated: result.truncated,
        searchedAtUtc: new Date().toISOString(),
      };
      return response;
    },
  );

  // Phase UX-C.3 + D - binary-ROM tile graphics + map cell read/write.
  // Imported lazily to keep projects.ts focused.
  const {
    registerBinaryRomGraphicsRoutes,
    registerBinaryRomEditRoutes,
    registerBinaryRomOwSpriteRoute,
    registerBinaryRomObjectEventEditRoute,
    registerBinaryRomDialogueEditRoute,
    registerBinaryRomScriptStepArgsRoute,
    registerBinaryRomStartBattleTrainerIdRoute,
    registerBinaryRomMovementActionByteRoute,
    registerBinaryRomMapHeaderEditRoute,
    registerBinaryRomTriggerEditRoute,
    registerBinaryRomHealLocationEditRoute,
    registerBinaryRomMetatileAttrsRoutes,
    registerBinaryRomMapDimensionsRoute,
    registerBinaryRomObjectEventTableRoute,
    registerBinaryRomEncounterSlotRoute,
    registerBinaryRomMapEventTableRoute,
    registerBinaryRomWarpFieldsRoute,
    registerBinaryRomTrainerPartyRoute,
    registerBinaryRomTrainerPartyAppendRoute,
    registerBinaryRomTrainerPartyDeleteRoute,
    registerBinaryRomTrainerFieldsRoute,
    registerBinaryRomSpeciesFieldsRoute,
    registerBinaryRomMoveFieldsRoute,
    registerBinaryRomItemFieldsRoute,
    registerBinaryRomEvolutionSlotRoute,
    registerBinaryRomEvolutionDeleteRoute,
    registerBinaryRomLearnsetMoveRoute,
    registerBinaryRomLearnsetAppendRoute,
    registerBinaryRomLearnsetDeleteRoute,
    registerBinaryRomMultichoiceAppendRoute,
    registerBinaryRomMultichoiceDeleteRoute,
    registerBinaryRomTmhmRoute,
    registerBinaryRomMapConnectionRoute,
    registerBinaryRomMapConnectionAppendRoute,
    registerBinaryRomMapConnectionDeleteRoute,
    registerBinaryRomTypeMatchupRoute,
  } = await import('./binary-rom-graphics.js');
  const adapterArgs = {
    app,
    sessionStore,
    errorResponse: errorResponse as unknown as (
      reply: FastifyReply,
      status: number,
      code: string,
      message: string,
    ) => unknown,
  };
  registerBinaryRomGraphicsRoutes(adapterArgs);
  registerBinaryRomEditRoutes(adapterArgs);
  registerBinaryRomOwSpriteRoute(adapterArgs);
  registerBinaryRomObjectEventEditRoute(adapterArgs);
  registerBinaryRomDialogueEditRoute(adapterArgs);
  registerBinaryRomScriptStepArgsRoute(adapterArgs);
  registerBinaryRomStartBattleTrainerIdRoute(adapterArgs);
  registerBinaryRomMovementActionByteRoute(adapterArgs);
  registerBinaryRomMapHeaderEditRoute(adapterArgs);
  registerBinaryRomTriggerEditRoute(adapterArgs);
  registerBinaryRomHealLocationEditRoute(adapterArgs);
  registerBinaryRomMetatileAttrsRoutes(adapterArgs);
  registerBinaryRomMapDimensionsRoute(adapterArgs);
  registerBinaryRomObjectEventTableRoute(adapterArgs);
  registerBinaryRomEncounterSlotRoute(adapterArgs);
  registerBinaryRomMapEventTableRoute(adapterArgs);
  registerBinaryRomWarpFieldsRoute(adapterArgs);
  registerBinaryRomTrainerPartyRoute(adapterArgs);
  registerBinaryRomTrainerPartyAppendRoute(adapterArgs);
  registerBinaryRomTrainerPartyDeleteRoute(adapterArgs);
  registerBinaryRomTrainerFieldsRoute(adapterArgs);
  registerBinaryRomSpeciesFieldsRoute(adapterArgs);
  registerBinaryRomMoveFieldsRoute(adapterArgs);
  registerBinaryRomItemFieldsRoute(adapterArgs);
  registerBinaryRomEvolutionSlotRoute(adapterArgs);
  registerBinaryRomEvolutionDeleteRoute(adapterArgs);
  registerBinaryRomLearnsetMoveRoute(adapterArgs);
  registerBinaryRomLearnsetAppendRoute(adapterArgs);
  registerBinaryRomLearnsetDeleteRoute(adapterArgs);
  registerBinaryRomMultichoiceAppendRoute(adapterArgs);
  registerBinaryRomMultichoiceDeleteRoute(adapterArgs);
  registerBinaryRomTmhmRoute(adapterArgs);
  registerBinaryRomMapConnectionRoute(adapterArgs);
  registerBinaryRomMapConnectionAppendRoute(adapterArgs);
  registerBinaryRomMapConnectionDeleteRoute(adapterArgs);
  registerBinaryRomTypeMatchupRoute(adapterArgs);

  // WP-A4 - Direct-apply route for visual scripter Add/Edit/Delete step.
  // Bypasses the agent-review flow (the user IS the reviewer when they
  // click "+ Add step" in the inspector). Lives in its own file because
  // it depends on the script encoder + manifest cross-ref scan, not
  // the binary-rom-graphics route family.
  const { registerBinaryRomScriptStepEditRoute } = await import(
    './binary-rom-script-step-edit.js'
  );
  registerBinaryRomScriptStepEditRoute(adapterArgs);

  // WP-C1 - Direct-apply route for encounter-table mutations beyond the
  // per-slot species/level edits already handled by /encounter-slot.
  // setRate / reorder / bulkReplaceSpecies each map to a single
  // binary_write_bytes edit; the user is the reviewer.
  const { registerBinaryRomEncounterTableEditRoute } = await import(
    './binary-rom-encounter-table-edit.js'
  );
  registerBinaryRomEncounterTableEditRoute(adapterArgs);

  // Phase 4.1A - Named save-state library routes. CRUD for
  // <projectRoot>/.editor/save-states/.
  const { registerSaveStatesRoutes } = await import('./save-states.js');
  registerSaveStatesRoutes(adapterArgs);

  // Phase 4.1B - Scene-boot recipe routes. CRUD for
  // <projectRoot>/.editor/scene-boots/.
  const { registerSceneBootRoutes } = await import('./scene-boot.js');
  registerSceneBootRoutes(adapterArgs);

  // Phase 4.2C - Pokémon sprite endpoint. Returns a placeholder PNG
  // keyed by species id today; swaps in real ROM-decoded sprites
  // when the species-sprite lifter lands.
  const { registerPokemonSpriteRoute } = await import('./pokemon-sprite.js');
  registerPokemonSpriteRoute(adapterArgs);

  // Phase 4.3F - sim a trainer's party vs a curated benchmark.
  const { registerSimTrainerBattleRoute } = await import('./sim-trainer-battle.js');
  registerSimTrainerBattleRoute(adapterArgs);
}
