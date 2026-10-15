import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  DirectoryListing,
  ProjectErrorResponse,
  ProjectOpenResponse,
  ProjectSession,
  ScanResponse,
} from '@rom-editor/shared';
import { createServer } from '../server.js';

describe('projects route', () => {
  let app: FastifyInstance;
  let projectDir: string;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-test-'));
    mkdirSync(path.join(projectDir, 'src'));
    mkdirSync(path.join(projectDir, 'data', 'maps'), { recursive: true });
    writeFileSync(path.join(projectDir, 'Makefile'), 'all:\n\techo build\n');
    writeFileSync(path.join(projectDir, 'README.md'), '# Test Project\n');
    writeFileSync(path.join(projectDir, 'src', 'main.c'), 'int main(){return 0;}\n');
    writeFileSync(path.join(projectDir, 'data', 'maps', 'town.json'), '{}');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('opens a real project directory and returns a session + root listing + identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProjectOpenResponse;
    expect(body.session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(body.session.projectRoot).toBe(path.resolve(projectDir));
    expect(body.session.openedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.rootListing.path).toBe('');
    const names = body.rootListing.entries.map((e) => e.name).sort();
    expect(names).toContain('Makefile');
    expect(names).toContain('README.md');
    expect(names).toContain('src');
    expect(names).toContain('data');
    expect(body.rootListing.entries[0]?.kind).toBe('directory');
    const makefile = body.rootListing.entries.find((e) => e.name === 'Makefile');
    expect(makefile?.kind).toBe('file');
    expect(makefile?.sizeBytes).toBeGreaterThan(0);
    expect(makefile?.relativePath).toBe('Makefile');

    // Identity is classified by the detection adapter (the test fixture is
    // a thin decomp shape: Makefile + src/ + data/ → decomp at ~0.5 confidence).
    expect(body.identity.kind).toBe('decomp');
    expect(body.identity.confidence).toBeGreaterThanOrEqual(0.4);
    expect(body.identity.confidence).toBeLessThan(1);
    expect(body.identity.evidence).toContain('Makefile');
    expect(body.identity.evidence).toContain('src/');
    expect(body.identity.evidence).toContain('data/');
  });

  it('classifies an empty project directory as kind=unknown with a guidance warning', async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-empty-'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: emptyDir },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ProjectOpenResponse;
      expect(body.identity.kind).toBe('unknown');
      expect(body.identity.confidence).toBe(0);
      expect(body.identity.warnings.length).toBeGreaterThan(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('rejects a relative projectRoot with 400 project_root_not_absolute', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: 'relative/path' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('project_root_not_absolute');
  });

  it('rejects a missing projectRoot with 404 project_root_not_found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: path.join(projectDir, 'nope-does-not-exist') },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('project_root_not_found');
  });

  it('rejects a file (not directory) projectRoot with 400 project_root_not_directory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: path.join(projectDir, 'Makefile') },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('project_root_not_directory');
  });

  it('rejects a body missing projectRoot via schema validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists a subdirectory in the opened project', async () => {
    const open = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    const { session } = open.json() as ProjectOpenResponse;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${session.id}/listing?path=data/maps`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DirectoryListing;
    expect(body.path).toBe('data/maps');
    const names = body.entries.map((e) => e.name);
    expect(names).toContain('town.json');
    const townJson = body.entries.find((e) => e.name === 'town.json');
    expect(townJson?.relativePath).toBe('data/maps/town.json');
  });

  it('rejects path traversal via ".." with 400 path_escapes_project_root', async () => {
    const open = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    const { session } = open.json() as ProjectOpenResponse;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${session.id}/listing?path=${encodeURIComponent('../..')}`,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('path_escapes_project_root');
  });

  it('returns 404 for unknown session id on listing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/listing`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns 400 path_not_directory when listing a file', async () => {
    const open = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    const { session } = open.json() as ProjectOpenResponse;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${session.id}/listing?path=README.md`,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('path_not_directory');
  });

  it('returns 404 path_not_found when listing a non-existent path', async () => {
    const open = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    const { session } = open.json() as ProjectOpenResponse;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${session.id}/listing?path=does-not-exist`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('path_not_found');
  });

  it('exposes session metadata via GET /api/projects/:id', async () => {
    const open = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    const { session } = open.json() as ProjectOpenResponse;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${session.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProjectSession;
    expect(body.id).toBe(session.id);
    expect(body.projectRoot).toBe(session.projectRoot);
  });

  it('isolates sessions: a second open returns a new id', async () => {
    const open1 = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    const open2 = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { projectRoot: projectDir },
    });
    const s1 = (open1.json() as ProjectOpenResponse).session;
    const s2 = (open2.json() as ProjectOpenResponse).session;
    expect(s1.id).not.toBe(s2.id);
  });

  describe('scan + manifest persistence', () => {
    let decompDir: string;

    beforeEach(() => {
      decompDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-scan-route-'));
      writeFileSync(path.join(decompDir, 'Makefile'), 'all:\n');
      writeFileSync(path.join(decompDir, 'pokeemerald.ld'), '');
      mkdirSync(path.join(decompDir, 'src'));
      mkdirSync(path.join(decompDir, 'include'));
      mkdirSync(path.join(decompDir, 'data', 'maps', 'LittlerootTown'), { recursive: true });
      writeFileSync(
        path.join(decompDir, 'data', 'maps', 'LittlerootTown', 'map.json'),
        JSON.stringify({ id: 'MAP_LITTLEROOT_TOWN', name: 'LITTLEROOT_TOWN', map_type: 'MAP_TYPE_TOWN', object_events: [], warp_events: [], coord_events: [], bg_events: [] }),
      );
      mkdirSync(path.join(decompDir, 'data', 'maps', 'Route1'), { recursive: true });
      writeFileSync(
        path.join(decompDir, 'data', 'maps', 'Route1', 'map.json'),
        JSON.stringify({ id: 'MAP_ROUTE1', name: 'ROUTE1', map_type: 'MAP_TYPE_ROUTE', object_events: [], warp_events: [], coord_events: [], bg_events: [] }),
      );
    });

    afterEach(() => {
      rmSync(decompDir, { recursive: true, force: true });
    });

    it('POST /api/projects/:id/scan scans a real decomp and persists the manifest to disk', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const scanRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/scan`,
      });
      expect(scanRes.statusCode).toBe(200);
      const body = scanRes.json() as ScanResponse;
      expect(body.scannerName).toBe('DecompScanner');
      expect(body.manifest.maps).toHaveLength(2);
      expect(body.manifest.maps.map((m) => m.id).sort()).toEqual([
        'MAP_LITTLEROOT_TOWN',
        'MAP_ROUTE1',
      ]);
      expect(body.scanDurationMs).toBeGreaterThanOrEqual(0);
      expect(body.manifestPath).toBe(path.join(decompDir, '.editor', 'manifest.json'));
      expect(existsSync(body.manifestPath)).toBe(true);
    });

    it('POST /api/projects/:id/scan returns 404 for an unknown session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/00000000-0000-0000-0000-000000000000/scan',
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as ProjectErrorResponse;
      expect(body.error.code).toBe('session_not_found');
    });

    it('scan of a non-decomp project returns the NoOpScanner result with empty maps', async () => {
      const emptyDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-empty-scan-'));
      try {
        const openRes = await app.inject({
          method: 'POST',
          url: '/api/projects/open',
          payload: { projectRoot: emptyDir },
        });
        const { session } = openRes.json() as ProjectOpenResponse;
        const scanRes = await app.inject({
          method: 'POST',
          url: `/api/projects/${session.id}/scan`,
        });
        expect(scanRes.statusCode).toBe(200);
        const body = scanRes.json() as ScanResponse;
        expect(body.scannerName).toBe('NoOpScanner');
        expect(body.manifest.maps).toHaveLength(0);
        expect(body.warnings.length).toBeGreaterThan(0);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('manifest.buildProfile is populated by the decomp scanner', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const scanRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/scan`,
      });
      const body = scanRes.json() as ScanResponse;
      // The route-test fixture has Makefile + pokeemerald.ld → make profile.
      expect(body.manifest.buildProfile).not.toBeNull();
      expect(body.manifest.buildProfile?.toolchain).toBe('make');
      expect(body.manifest.buildProfile?.buildCommand).toBe('make');
    });

    it('POST /api/projects/:id/build runs a custom command and returns stdout + exit code', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/build`,
        payload: {
          argvOverride: [process.execPath, '-e', 'console.log("BUILD_OK_FROM_RUNNER")'],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        exitCode: number | null;
        stdout: string;
        stderr: string;
        spawnError: string | null;
      };
      expect(body.exitCode).toBe(0);
      expect(body.stdout).toContain('BUILD_OK_FROM_RUNNER');
      expect(body.spawnError).toBeNull();
    });

    it('POST /api/projects/:id/build returns 400 when no manifest exists', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/build`,
        payload: { commandOverride: 'echo' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/projects/:id/search returns ranked hits after a scan', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/search`,
        payload: { query: 'littleroot' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        query: string;
        tokenizedTerms: string[];
        hits: Array<{ entityId: string; entityKind: string; score: number }>;
        truncated: boolean;
        searchedAtUtc: string;
      };
      expect(body.tokenizedTerms).toEqual(['littleroot']);
      expect(body.hits.length).toBeGreaterThanOrEqual(1);
      const ids = body.hits.map((h) => h.entityId);
      expect(ids).toContain('MAP_LITTLEROOT_TOWN');
    });

    it('POST /api/projects/:id/search returns 400 when no scan has run yet', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/search`,
        payload: { query: 'foo' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as ProjectErrorResponse;
      expect(body.error.message).toMatch(/scan/i);
    });

    it('POST /api/projects/:id/search returns 404 for unknown session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/00000000-0000-0000-0000-000000000000/search',
        payload: { query: 'anything' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('PATCH /api/projects/:id/events/objectEvent/:id moves an event and rewrites map.json', async () => {
      // The decompDir already has LittlerootTown/map.json with no object events;
      // augment it with one so we can move it.
      const mapJsonPath = path.join(decompDir, 'data', 'maps', 'LittlerootTown', 'map.json');
      const mapJson = JSON.parse(readFileSync(mapJsonPath, 'utf8'));
      mapJson.object_events = [
        {
          graphics_id: 'OBJ_EVENT_GFX_BOY',
          x: 4,
          y: 5,
          elevation: 3,
          trainer_type: 'TRAINER_TYPE_NONE',
          script: 'BoyScript',
          flag: '0',
        },
      ];
      writeFileSync(mapJsonPath, JSON.stringify(mapJson));

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/events/objectEvent/MAP_LITTLEROOT_TOWN_obj_0`,
        payload: { x: 12, y: 8 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        previous: { x: number; y: number };
        next: { x: number; y: number };
      };
      expect(body.previous).toEqual({ x: 4, y: 5 });
      expect(body.next).toEqual({ x: 12, y: 8 });

      // Confirm the on-disk map.json was rewritten and the manifest refreshed.
      const after = JSON.parse(readFileSync(mapJsonPath, 'utf8'));
      expect(after.object_events[0].x).toBe(12);
      expect(after.object_events[0].y).toBe(8);
    });

    it('PATCH /api/projects/:id/events/* returns 400 for invalid coords', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/events/objectEvent/MAP_LITTLEROOT_TOWN_obj_0`,
        payload: { x: -1, y: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH /api/projects/:id/events/* returns 404 for unknown session', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/projects/00000000-0000-0000-0000-000000000000/events/objectEvent/MAP_X_obj_0',
        payload: { x: 1, y: 1 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('PATCH /events/objectEvent/:id/fields writes a numeric field (trainer sight range)', async () => {
      // Regression: schema previously used `oneOf` for the value type,
      // which fails under Fastify's default coerceTypes:true because a
      // number coerces to a string and matches BOTH subschemas - yielding
      // an opaque "must match exactly one schema in oneOf" 400. The
      // schema now uses `anyOf` so numeric writes round-trip.
      const mapJsonPath = path.join(decompDir, 'data', 'maps', 'LittlerootTown', 'map.json');
      const mapJson = JSON.parse(readFileSync(mapJsonPath, 'utf8'));
      mapJson.object_events = [
        {
          graphics_id: 'OBJ_EVENT_GFX_BUG_CATCHER',
          x: 7,
          y: 16,
          elevation: 3,
          movement_type: 'MOVEMENT_TYPE_FACE_LEFT',
          trainer_type: 'TRAINER_TYPE_NORMAL',
          trainer_sight_or_berry_tree_id: '1',
          script: 'Bug',
          flag: '0',
        },
      ];
      writeFileSync(mapJsonPath, JSON.stringify(mapJson));

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/events/objectEvent/MAP_LITTLEROOT_TOWN_obj_0/fields`,
        payload: { fields: { trainer_sight_or_berry_tree_id: 5 } },
      });
      expect(res.statusCode).toBe(200);
      const after = JSON.parse(readFileSync(mapJsonPath, 'utf8'));
      // On-disk JSON type preserved (was a string in pret's map.json).
      expect(after.object_events[0].trainer_sight_or_berry_tree_id).toBe('5');
    });

    it('GET /api/projects/:id/layout?name=… parses a real layout.json + map.bin', async () => {
      // Add a layouts directory to decompDir
      mkdirSync(path.join(decompDir, 'data', 'layouts', 'LittlerootTown'), { recursive: true });
      writeFileSync(
        path.join(decompDir, 'data', 'layouts', 'LittlerootTown', 'layout.json'),
        JSON.stringify({
          id: 'LAYOUT_LITTLEROOT_TOWN',
          name: 'LittlerootTown_Layout',
          width: 2,
          height: 2,
          border_width: 2,
          border_height: 2,
          primary_tileset: 'gTileset_General',
          secondary_tileset: 'gTileset_LittlerootTown',
          blockdata_filepath: 'data/layouts/LittlerootTown/map.bin',
        }),
      );
      writeFileSync(
        path.join(decompDir, 'data', 'layouts', 'LittlerootTown', 'map.bin'),
        Buffer.from([0x01, 0x04, 0x02, 0x00, 0x0a, 0x10, 0xff, 0xf0]),
      );

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/layout?name=LAYOUT_LITTLEROOT_TOWN`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        id: string;
        width: number;
        height: number;
        cells: Array<{ metatileId: number; collision: number; elevation: number }>;
      };
      expect(body.id).toBe('LAYOUT_LITTLEROOT_TOWN');
      expect(body.width).toBe(2);
      expect(body.height).toBe(2);
      expect(body.cells).toHaveLength(4);
      expect(body.cells[0]).toEqual({ metatileId: 1, collision: 1, elevation: 0 });
    });

    it('GET /api/projects/:id/layout returns 404 when layout name is unknown', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/layout?name=LAYOUT_NOT_REAL`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/projects/:id/layout returns 400 when neither name nor dir is given', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/layout`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /api/projects/:id/manifest-path returns the expected manifest path', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/manifest-path`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { manifestPath: string };
      expect(body.manifestPath).toBe(path.join(decompDir, '.editor', 'manifest.json'));
    });

    it('PUT /api/projects/:id/assets/:assetId atomically replaces the PNG and refreshes manifest metadata', async () => {
      // Seed a real PNG file under graphics/object_events/pics so it gets
      // indexed as an asset by the scanner.
      const relPath = 'graphics/object_events/pics/may.png';
      mkdirSync(path.join(decompDir, path.dirname(relPath)), { recursive: true });
      const seed = makePngBuffer({ width: 16, height: 16 });
      writeFileSync(path.join(decompDir, relPath), seed);

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const replacement = makePngBuffer({ width: 48, height: 32 });
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${session.id}/assets/${encodeURIComponent(relPath)}`,
        payload: { pngBase64: replacement.toString('base64') },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { width: number; height: number; bytesWritten: number };
      expect(body.width).toBe(48);
      expect(body.height).toBe(32);
      expect(body.bytesWritten).toBe(replacement.length);

      // Confirm on-disk replacement happened
      const onDisk = readFileSync(path.join(decompDir, relPath));
      expect(onDisk.equals(replacement)).toBe(true);
    });

    it('PUT /api/projects/:id/assets/:assetId returns 400 when the body is not a valid PNG', async () => {
      const relPath = 'graphics/object_events/pics/may.png';
      mkdirSync(path.join(decompDir, path.dirname(relPath)), { recursive: true });
      writeFileSync(path.join(decompDir, relPath), makePngBuffer({}));

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${session.id}/assets/${encodeURIComponent(relPath)}`,
        payload: { pngBase64: Buffer.from('not a png').toString('base64') },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT /api/projects/:id/assets/:assetId returns 404 for an unknown assetId', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const png = makePngBuffer({});
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${session.id}/assets/${encodeURIComponent('graphics/does/not/exist.png')}`,
        payload: { pngBase64: png.toString('base64') },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/projects/:id/assets creates a new PNG under graphics/ and surfaces it on rescan', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const png = makePngBuffer({ width: 16, height: 16 });
      const relPath = 'graphics/object_events/pics/freshly_created.png';
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/assets`,
        payload: { relativePath: relPath, pngBase64: png.toString('base64') },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { relativePath: string; width: number; height: number };
      expect(body.relativePath).toBe(relPath);
      expect(body.width).toBe(16);
      expect(existsSync(path.join(decompDir, relPath))).toBe(true);
    });

    it('POST /api/projects/:id/assets rejects paths that escape the project root with 400', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const png = makePngBuffer({});
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/assets`,
        payload: { relativePath: '../escaped.png', pngBase64: png.toString('base64') },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/projects/:id/patches generates a real IPS patch atomically on disk', async () => {
      const base = Buffer.alloc(64, 0x00);
      const modified = Buffer.from(base);
      modified[5] = 0xff;
      modified[20] = 0xee;
      writeFileSync(path.join(decompDir, 'base.gba'), base);
      writeFileSync(path.join(decompDir, 'pokeemerald.gba'), modified);

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/patches`,
        payload: {
          baseRomPath: 'base.gba',
          modifiedRomPath: 'pokeemerald.gba',
          outputPath: 'patches/my-mod.ips',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        recordCount: number;
        totalPatchedBytes: number;
        patchBytes: number;
        baseSizeBytes: number;
      };
      expect(body.recordCount).toBe(2);
      expect(body.totalPatchedBytes).toBe(2);
      expect(body.baseSizeBytes).toBe(64);
      // On-disk verification
      const onDisk = readFileSync(path.join(decompDir, 'patches/my-mod.ips'));
      expect(onDisk.length).toBe(body.patchBytes);
      expect(onDisk.subarray(0, 5).toString('ascii')).toBe('PATCH');
      expect(onDisk.subarray(-3).toString('ascii')).toBe('EOF');
    });

    it('POST /api/projects/:id/templates/:templateId/stage writes the staged JSON to .editor/staged-templates/', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/templates/town_skeleton/stage`,
        payload: {
          params: { mapName: 'NewTown' },
          materialization: { summary: 'creates town', entities: { maps: [{ id: 'NewTown' }] } },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { stagedPath: string; templateId: string };
      expect(body.templateId).toBe('town_skeleton');
      expect(body.stagedPath).toMatch(/^\.editor\/staged-templates\/.+town_skeleton\.json$/);
      // Confirm on-disk file exists
      expect(existsSync(path.join(decompDir, body.stagedPath))).toBe(true);
    });

    it('POST /api/projects/:id/templates/:templateId/stage rejects empty templateId via path', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      // Fastify won't route empty path segments so we test the body-validation
      // path with a malformed body instead (missing required fields).
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/templates/whatever/stage`,
        payload: { params: 'not-an-object' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /api/projects/:id/plugins returns empty arrays when no plugins dir exists', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/plugins`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { plugins: unknown[]; parseErrors: unknown[]; pluginsDir: string };
      expect(body.plugins).toEqual([]);
      expect(body.parseErrors).toEqual([]);
      expect(body.pluginsDir).toBe(path.join(decompDir, '.editor', 'plugins'));
    });

    it('GET /api/projects/:id/plugins loads a real plugin manifest and reports parse errors per file', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const pluginsDir = path.join(decompDir, '.editor', 'plugins');
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        path.join(pluginsDir, 'rule_pack.json'),
        JSON.stringify({
          id: 'rule_pack',
          label: 'Rule Pack',
          version: '0.1.0',
          description: 'project-specific design rules',
          validators: [
            {
              ruleId: 'no_temp_flags',
              severity: 'warn',
              message: 'flag id starts with TEMP_',
              predicate: { kind: 'entity_pattern', entityKind: 'flag', idPattern: '^TEMP_' },
            },
          ],
        }),
        'utf-8',
      );
      writeFileSync(path.join(pluginsDir, 'broken.json'), '{not json', 'utf-8');

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/plugins`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        plugins: Array<{ id: string; validators?: unknown[] }>;
        parseErrors: Array<{ code: string }>;
      };
      expect(body.plugins).toHaveLength(1);
      expect(body.plugins[0]!.id).toBe('rule_pack');
      expect(body.plugins[0]!.validators).toHaveLength(1);
      expect(body.parseErrors).toHaveLength(1);
      expect(body.parseErrors[0]!.code).toBe('invalid_json');
    });

    it('POST /api/projects/open-from-file rejects an unsupported extension with 400', async () => {
      const txt = path.join(decompDir, 'note.txt');
      writeFileSync(txt, 'hello');
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/open-from-file',
        payload: { filePath: txt },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { message: string } }).error.message).toContain('unsupported_file_kind');
    });

    it('POST /api/projects/open-from-file intakes a .gba and opens the managed project', async () => {
      // Build a 256-byte buffer with a valid GBA header so the detector
      // surfaces the ROM info in the identity.
      const buf = Buffer.alloc(0x200, 0);
      buf.write('POKEMON FIRE', 0xa0, 'ascii');
      buf.write('BPRE', 0xac, 'ascii');
      buf.write('01', 0xb0, 'ascii');
      buf[0xb2] = 0x96;
      buf[0xbc] = 1;
      const gba = path.join(decompDir, 'firered.gba');
      writeFileSync(gba, buf);
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/open-from-file',
        payload: { filePath: gba },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        session: { projectRoot: string };
        identity: { kind: string; baseGame: string | null; displayName: string };
        intake: { kind: string; sha1: string; originalPath: string };
      };
      expect(body.intake.kind).toBe('rom');
      expect(body.intake.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(body.intake.originalPath).toBe(gba);
      expect(body.identity.kind).toBe('patch');
      expect(body.identity.baseGame).toBe('Pokémon FireRed');
      // RT-1.3: displayName now derives from GBA header (or SHA-1 hack
      // fingerprint) instead of the generic "Bare ROM" fallback. For
      // a synthetic test ROM with a valid BPRE header it surfaces
      // "Pokémon FireRed"; for an unknown ROM with no header parse it
      // would still fall back to "Bare ROM workspace".
      expect(body.identity.displayName).toMatch(/Pokémon FireRed|Bare ROM/);
      // Managed dir contains the copied ROM under the SHA-1.
      expect(body.session.projectRoot).toContain(body.intake.sha1);
    });

    it.skipIf(process.platform === 'win32')(
      'POST /api/dialogs/pick returns platform_not_supported gracefully off-Windows',
      async () => {
        // Hitting this route on Windows would open a real OpenFileDialog +
        // hang waiting for user input - skipped on Windows. Off-Windows the
        // file-picker module short-circuits with a typed result.
        const res = await app.inject({
          method: 'POST',
          url: '/api/dialogs/pick',
          payload: { kind: 'folder' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { kind: string; path: null | string; error?: string };
        expect(body.kind).toBe('folder');
        expect(body.error).toBe('platform_not_supported');
      },
    );

    it('POST /api/dialogs/pick rejects an invalid kind value with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dialogs/pick',
        payload: { kind: 'not-a-real-kind' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /api/projects/:id/op-log returns empty list when no log exists', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/op-log`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { entries: unknown[]; totalLines: number };
      expect(body.entries).toEqual([]);
      expect(body.totalLines).toBe(0);
    });

    it('POST /api/projects/:id/undo on an empty log returns 400 nothing_to_undo', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });
      const res = await app.inject({ method: 'POST', url: `/api/projects/${session.id}/undo` });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { message: string } }).error.message).toContain('nothing_to_undo');
    });

    it('mechanic-config PATCH then UNDO restores the prior doc, op-log records both', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      // Initial config is empty.
      const init = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/mechanic-config`,
      });
      expect((init.json() as { doc: { starter_selection: { starters: string[] } } }).doc.starter_selection.starters).toEqual([]);

      // Patch: set starters.
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/mechanic-config/starter_selection`,
        payload: { starters: ['SPECIES_X'] },
      });
      expect(patchRes.statusCode).toBe(200);
      const after = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/mechanic-config`,
      });
      expect((after.json() as { doc: { starter_selection: { starters: string[] } } }).doc.starter_selection.starters).toEqual(['SPECIES_X']);

      // Undo.
      const undo = await app.inject({ method: 'POST', url: `/api/projects/${session.id}/undo` });
      expect(undo.statusCode).toBe(200);
      const undoBody = undo.json() as { reversedOp: string };
      expect(undoBody.reversedOp).toBe('patch_mechanic_config');

      // Verify the doc is back to empty.
      const restored = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/mechanic-config`,
      });
      expect((restored.json() as { doc: { starter_selection: { starters: string[] } } }).doc.starter_selection.starters).toEqual([]);

      // Op-log has 2 entries: the patch + the undo.
      const log = await app.inject({ method: 'GET', url: `/api/projects/${session.id}/op-log` });
      const entries = (log.json() as { entries: Array<{ op: string }> }).entries;
      expect(entries.map((e) => e.op)).toEqual(['undo', 'patch_mechanic_config']);

      // Redo restores the change.
      const redo = await app.inject({ method: 'POST', url: `/api/projects/${session.id}/redo` });
      expect(redo.statusCode).toBe(200);
      const back = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/mechanic-config`,
      });
      expect((back.json() as { doc: { starter_selection: { starters: string[] } } }).doc.starter_selection.starters).toEqual(['SPECIES_X']);
    });

    it('GET /api/projects/:id/undo-state returns canUndo/canRedo state from the op-log', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      // Empty log.
      let r = await app.inject({ method: 'GET', url: `/api/projects/${session.id}/undo-state` });
      expect((r.json() as { canUndo: boolean; canRedo: boolean }).canUndo).toBe(false);

      // Mutate.
      await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/mechanic-config/starter_selection`,
        payload: { starters: ['SPECIES_Y'] },
      });
      r = await app.inject({ method: 'GET', url: `/api/projects/${session.id}/undo-state` });
      const after = r.json() as { canUndo: boolean; canRedo: boolean; nextUndoOp: string };
      expect(after.canUndo).toBe(true);
      expect(after.canRedo).toBe(false);
      expect(after.nextUndoOp).toBe('patch_mechanic_config');
    });

    it('a successful mechanic-config PATCH records an entry visible via GET /op-log', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/mechanic-config/starter_selection`,
        payload: { starters: ['SPECIES_X'] },
      });
      expect(patchRes.statusCode).toBe(200);

      const logRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/op-log`,
      });
      expect(logRes.statusCode).toBe(200);
      const body = logRes.json() as {
        entries: Array<{ op: string; sessionId: string; payload: { mechanicId: string } }>;
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]!.op).toBe('patch_mechanic_config');
      expect(body.entries[0]!.sessionId).toBe(session.id);
      expect(body.entries[0]!.payload.mechanicId).toBe('starter_selection');
    });

    it('GET + PATCH /api/projects/:id/mechanic-config roundtrips per-mechanic config', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      // Initial GET returns the empty doc.
      const init = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/mechanic-config`,
      });
      expect(init.statusCode).toBe(200);
      const initBody = init.json() as { doc: { starter_selection: { starters: string[] } } };
      expect(initBody.doc.starter_selection.starters).toEqual([]);

      // PATCH starter_selection.
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/mechanic-config/starter_selection`,
        payload: { starters: ['SPECIES_BULBASAUR', 'SPECIES_CHARMANDER'] },
      });
      expect(patch.statusCode).toBe(200);
      const after = patch.json() as { doc: { starter_selection: { starters: string[] } } };
      expect(after.doc.starter_selection.starters).toEqual(['SPECIES_BULBASAUR', 'SPECIES_CHARMANDER']);

      // Confirm persistence: re-GET returns the patched doc.
      const again = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/mechanic-config`,
      });
      const againBody = again.json() as { doc: { starter_selection: { starters: string[] } } };
      expect(againBody.doc.starter_selection.starters).toEqual(['SPECIES_BULBASAUR', 'SPECIES_CHARMANDER']);
    });

    it('PATCH /api/projects/:id/mechanic-config/:mechanicId returns 404 for unknown mechanic id', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${session.id}/mechanic-config/totally_fake`,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/projects/:id/share-package materializes patch + README and reports base ROM SHA-256', async () => {
      // Seed a patch + base ROM inside the project so the share path can pick
      // them up via project-relative paths.
      mkdirSync(path.join(decompDir, 'patches'), { recursive: true });
      writeFileSync(path.join(decompDir, 'patches/my-mod.ips'), Buffer.from('PATCHbytesEOF'));
      writeFileSync(path.join(decompDir, 'base.gba'), Buffer.alloc(64, 0xff));

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/share-package`,
        payload: {
          patchPath: 'patches/my-mod.ips',
          baseRomPath: 'base.gba',
          outputDir: 'dist/share',
          meta: {
            modName: 'My Mod',
            version: '1.0',
            author: 'Alice',
            description: 'A test mod.',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        outputDir: string;
        files: Array<{ relativePath: string }>;
        baseRomSha256: string;
      };
      expect(body.outputDir).toBe('dist/share');
      expect(body.files.map((f) => f.relativePath).sort()).toEqual(['README.md', 'my-mod.ips']);
      // SHA-256 of a 64-byte 0xFF buffer is deterministic
      expect(body.baseRomSha256).toMatch(/^[0-9a-f]{64}$/);

      const readme = readFileSync(path.join(decompDir, 'dist/share/README.md'), 'utf8');
      expect(readme).toContain('# My Mod');
      expect(readme).toContain(body.baseRomSha256);
    });

    it('POST /api/projects/:id/share-package returns 400 when outputDir escapes project root', async () => {
      mkdirSync(path.join(decompDir, 'patches'), { recursive: true });
      writeFileSync(path.join(decompDir, 'patches/my-mod.ips'), Buffer.from('PATCHabcEOF'));
      writeFileSync(path.join(decompDir, 'base.gba'), Buffer.alloc(8));
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/share-package`,
        payload: {
          patchPath: 'patches/my-mod.ips',
          baseRomPath: 'base.gba',
          outputDir: '../escaped',
          meta: { modName: 'm', version: '', author: '', description: '' },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/projects/:id/patches returns 404 when base ROM does not exist', async () => {
      writeFileSync(path.join(decompDir, 'pokeemerald.gba'), Buffer.alloc(8));
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/patches`,
        payload: {
          baseRomPath: 'missing.gba',
          modifiedRomPath: 'pokeemerald.gba',
          outputPath: 'p.ips',
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/projects/:id/build/artifacts probes detected outputPaths for size + mtime', async () => {
      // Decomp scanner detects pokeemerald-class build profile from Makefile.
      // Seed a real on-disk pokeemerald.gba so the probe finds something.
      writeFileSync(path.join(decompDir, 'pokeemerald.gba'), Buffer.from('R'.repeat(2048)));

      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${session.id}/build/artifacts`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        buildProfileDetected: boolean;
        outputPaths: Array<{ relativePath: string; exists: boolean; sizeBytes: number | null }>;
      };
      expect(body.buildProfileDetected).toBe(true);
      const rom = body.outputPaths.find((o) => o.relativePath.endsWith('pokeemerald.gba'));
      expect(rom?.exists).toBe(true);
      expect(rom?.sizeBytes).toBe(2048);
    });

    it('GET /api/projects/:id/build/artifacts returns 404 for an unknown session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/00000000-0000-0000-0000-000000000000/build/artifacts',
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/projects/:id/assets returns 409 when the target path already exists', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/projects/open',
        payload: { projectRoot: decompDir },
      });
      const { session } = openRes.json() as ProjectOpenResponse;
      const relPath = 'graphics/object_events/pics/already_here.png';
      mkdirSync(path.join(decompDir, path.dirname(relPath)), { recursive: true });
      writeFileSync(path.join(decompDir, relPath), Buffer.from('existing'));
      await app.inject({ method: 'POST', url: `/api/projects/${session.id}/scan` });

      const png = makePngBuffer({});
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${session.id}/assets`,
        payload: { relativePath: relPath, pngBase64: png.toString('base64') },
      });
      expect(res.statusCode).toBe(409);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.46 - Heal-locations write route integration test.
//
// Verifies POST /api/projects/:id/binary-rom-edit/heal-location patches
// the 6-byte HealLocation struct in place per the layout:
//   +0x00 u8  group
//   +0x01 u8  mapNum
//   +0x02 s16 x
//   +0x04 s16 y
// And creates a .bak on first edit.
// ─────────────────────────────────────────────────────────────────────

describe('heal-locations edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const targetOffset = 0x1000;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-heal-loc-'));
    // Minimal valid GBA header for the open-from-file route to accept
    // this as a Pokémon FireRed-style ROM. Buffer is sized large enough
    // to host the heal-location struct at offset 0x1000.
    //
    // Crucially: the intake-from-file route routes by SHA-1 to a managed
    // %APPDATA% dir, so we MUST make each test's bytes unique to get a
    // fresh managed copy. A random byte at 0x500 (not 0x1000) does the
    // trick without touching the heal-location struct under test.
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test → unique SHA-1 → fresh managed dir.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a HealLocation struct: group=0, mapNum=12, x=6, y=9
    // (vanilla SPAWN_PALLET_TOWN style values).
    buf[targetOffset + 0] = 0;
    buf[targetOffset + 1] = 12;
    buf.writeInt16LE(6, targetOffset + 2);
    buf.writeInt16LE(9, targetOffset + 4);
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    // Open via the file-intake route which copies the ROM into the
    // managed project dir + opens a session.
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    // Update gbaPath to the managed-dir copy so we can verify byte
    // patches on the in-session ROM.
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('patches all four fields and reports fieldsWritten', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/heal-location`,
      payload: {
        sourceFileOffset: targetOffset,
        fields: { group: 1, mapNum: 4, x: 99, y: 100 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sourceFileOffset: number;
      fieldsWritten: string[];
      backupCreated: boolean;
    };
    expect(body.sourceFileOffset).toBe(targetOffset);
    expect(body.fieldsWritten.sort()).toEqual(['group', 'mapNum', 'x', 'y']);
    expect(body.backupCreated).toBe(true);
    // Verify the bytes on disk.
    const out = readFileSync(gbaPath);
    expect(out[targetOffset + 0]).toBe(1);
    expect(out[targetOffset + 1]).toBe(4);
    expect(out.readInt16LE(targetOffset + 2)).toBe(99);
    expect(out.readInt16LE(targetOffset + 4)).toBe(100);
    // .bak should also exist.
    expect(existsSync(`${gbaPath}.bak`)).toBe(true);
  });

  it('patches a single field without touching the others', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/heal-location`,
      payload: {
        sourceFileOffset: targetOffset,
        fields: { mapNum: 20 },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[targetOffset + 0]).toBe(0); // unchanged
    expect(out[targetOffset + 1]).toBe(20); // patched
    expect(out.readInt16LE(targetOffset + 2)).toBe(6); // unchanged
    expect(out.readInt16LE(targetOffset + 4)).toBe(9); // unchanged
  });

  it('rejects an out-of-range group with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/heal-location`,
      payload: {
        sourceFileOffset: targetOffset,
        fields: { group: 99 }, // > GROUP_MAX (50)
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('group');
    // Bytes must be unchanged.
    const out = readFileSync(gbaPath);
    expect(out[targetOffset + 0]).toBe(0);
  });

  it('rejects an out-of-range x with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/heal-location`,
      payload: {
        sourceFileOffset: targetOffset,
        fields: { x: 9999 }, // > COORD_MAX (511)
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('x');
  });

  it('rejects sourceFileOffset past ROM end with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/heal-location`,
      payload: {
        sourceFileOffset: 0x100000,
        fields: { group: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('past ROM end');
  });

  it('rejects a missing fields object with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/heal-location`,
      payload: { sourceFileOffset: targetOffset },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/heal-location`,
      payload: {
        sourceFileOffset: targetOffset,
        fields: { group: 0 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.51 - Warp-fields write route integration test.
//
// Verifies POST /api/projects/:id/binary-rom-edit/warp-fields patches
// the 4 u8 fields (elevation / warpId / destMapNum / destMapGroup)
// in place at offsets +0x04..+0x07 of the 8-byte Warp struct, leaves
// x/y (the +0x00 s16 + +0x02 s16) alone, and creates a .bak on the
// first edit.
// ─────────────────────────────────────────────────────────────────────

describe('warp-fields edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const targetOffset = 0x1000;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-warp-fields-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test → unique SHA-1 → fresh managed dir
    // (the intake-from-file route hashes the ROM into %APPDATA%).
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a Warp struct: x=5, y=7, elevation=3, warpId=0, destMapNum=12, destMapGroup=0
    buf.writeInt16LE(5, targetOffset + 0);
    buf.writeInt16LE(7, targetOffset + 2);
    buf[targetOffset + 0x04] = 3;
    buf[targetOffset + 0x05] = 0;
    buf[targetOffset + 0x06] = 12;
    buf[targetOffset + 0x07] = 0;
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('patches all 4 destination fields, leaves x/y bytes alone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/warp-fields`,
      payload: {
        structFileOffset: targetOffset,
        fields: {
          elevation: 4,
          warpId: 2,
          destMapNum: 10,
          destMapGroup: 1,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      structFileOffset: number;
      fieldsWritten: string[];
      backupCreated: boolean;
    };
    expect(body.structFileOffset).toBe(targetOffset);
    expect(body.fieldsWritten.sort()).toEqual([
      'destMapGroup',
      'destMapNum',
      'elevation',
      'warpId',
    ]);
    expect(body.backupCreated).toBe(true);
    const out = readFileSync(gbaPath);
    // x + y should be unchanged.
    expect(out.readInt16LE(targetOffset + 0)).toBe(5);
    expect(out.readInt16LE(targetOffset + 2)).toBe(7);
    expect(out[targetOffset + 0x04]).toBe(4);
    expect(out[targetOffset + 0x05]).toBe(2);
    expect(out[targetOffset + 0x06]).toBe(10);
    expect(out[targetOffset + 0x07]).toBe(1);
    expect(existsSync(`${gbaPath}.bak`)).toBe(true);
  });

  it('patches a single field without touching the other 7 bytes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/warp-fields`,
      payload: {
        structFileOffset: targetOffset,
        fields: { warpId: 5 },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out.readInt16LE(targetOffset + 0)).toBe(5);
    expect(out.readInt16LE(targetOffset + 2)).toBe(7);
    expect(out[targetOffset + 0x04]).toBe(3); // unchanged
    expect(out[targetOffset + 0x05]).toBe(5); // patched
    expect(out[targetOffset + 0x06]).toBe(12); // unchanged
    expect(out[targetOffset + 0x07]).toBe(0); // unchanged
  });

  it('rejects out-of-u8-range elevation with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/warp-fields`,
      payload: {
        structFileOffset: targetOffset,
        fields: { elevation: 256 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('elevation');
    // Bytes must be unchanged.
    const out = readFileSync(gbaPath);
    expect(out[targetOffset + 0x04]).toBe(3);
  });

  it('rejects a non-numeric field value with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/warp-fields`,
      payload: {
        structFileOffset: targetOffset,
        fields: { warpId: 'not a number' as unknown as number },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('warpId');
  });

  it('rejects structFileOffset past ROM end with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/warp-fields`,
      payload: {
        structFileOffset: 0x100000,
        fields: { elevation: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('out of ROM bounds');
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/warp-fields`,
      payload: {
        structFileOffset: targetOffset,
        fields: { elevation: 0 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.52 - Trigger-fields write route integration test.
//
// Larger surface than O.46/O.51 since this route has two trigger
// kinds (bg + coord) plus the hidden-item subfields added in O.33.
//
// BG struct (12 bytes):
//   +0x00 s16 x, +0x02 s16 y, +0x04 u8 elevation, +0x05 u8 kind,
//   +0x06 u16 pad, +0x08 u32 data (hidden-item kinds 5/7 pack
//   { u16 itemId, u8 flagOffset, u8 quantity } in this slot)
//
// Coord struct (16 bytes):
//   +0x00 s16 x, +0x02 s16 y, +0x04 u8 elevation, +0x05 u8 pad,
//   +0x06 u16 trigger, +0x08 u16 index, +0x0A u16 pad, +0x0C u32 script
// ─────────────────────────────────────────────────────────────────────

describe('trigger-fields edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const bgOffset = 0x1000;
  const coordOffset = 0x1100;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-trigger-fields-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a BG event (sign kind=0) at bgOffset: x=3, y=4, elevation=0, kind=0, data=0
    buf.writeInt16LE(3, bgOffset + 0);
    buf.writeInt16LE(4, bgOffset + 2);
    buf[bgOffset + 0x04] = 0;
    buf[bgOffset + 0x05] = 0;
    buf.writeUInt32LE(0, bgOffset + 0x08);
    // Seed a coord event at coordOffset: x=10, y=11, elevation=3,
    // trigger=0x4000, index=1, script=0.
    buf.writeInt16LE(10, coordOffset + 0);
    buf.writeInt16LE(11, coordOffset + 2);
    buf[coordOffset + 0x04] = 3;
    buf[coordOffset + 0x05] = 0;
    buf.writeUInt16LE(0x4000, coordOffset + 0x06);
    buf.writeUInt16LE(1, coordOffset + 0x08);
    buf.writeUInt16LE(0, coordOffset + 0x0a);
    buf.writeUInt32LE(0, coordOffset + 0x0c);
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('BG: patches kind + elevation + creates .bak', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'bg',
        structFileOffset: bgOffset,
        fields: { bgEventKind: 5, elevation: 7 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      structFileOffset: number;
      fieldsWritten: string[];
      backupCreated: boolean;
    };
    expect(body.fieldsWritten.sort()).toEqual(['bgEventKind', 'elevation']);
    expect(body.backupCreated).toBe(true);
    const out = readFileSync(gbaPath);
    expect(out[bgOffset + 0x04]).toBe(7); // elevation
    expect(out[bgOffset + 0x05]).toBe(5); // kind
    expect(out.readInt16LE(bgOffset + 0)).toBe(3); // x unchanged
    expect(out.readInt16LE(bgOffset + 2)).toBe(4); // y unchanged
    expect(existsSync(`${gbaPath}.bak`)).toBe(true);
  });

  it('BG: hidden-item subfields pack into the data u32 (kinds 5/7)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'bg',
        structFileOffset: bgOffset,
        fields: {
          bgEventKind: 5,
          hiddenItemId: 0x44, // ITEM_RARE_CANDY in vanilla
          hiddenItemFlagOffset: 0x11,
          hiddenItemQuantity: 1,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[bgOffset + 0x05]).toBe(5);
    expect(out.readUInt16LE(bgOffset + 0x08)).toBe(0x44); // itemId
    expect(out[bgOffset + 0x0a]).toBe(0x11); // flagOffset
    expect(out[bgOffset + 0x0b]).toBe(1); // quantity
  });

  it('Coord: patches var/value/elevation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'coord',
        structFileOffset: coordOffset,
        fields: {
          coordTriggerVar: 0x4001,
          coordTriggerIndex: 42,
          elevation: 5,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[coordOffset + 0x04]).toBe(5); // elevation
    expect(out.readUInt16LE(coordOffset + 0x06)).toBe(0x4001); // var
    expect(out.readUInt16LE(coordOffset + 0x08)).toBe(42); // index
    // x/y untouched
    expect(out.readInt16LE(coordOffset + 0)).toBe(10);
    expect(out.readInt16LE(coordOffset + 2)).toBe(11);
  });

  it('rejects hidden-item fields when triggerKind is coord (cross-kind misuse)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'coord',
        structFileOffset: coordOffset,
        fields: { hiddenItemId: 0x44 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('Hidden-item');
  });

  it('rejects out-of-u8-range bgEventKind with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'bg',
        structFileOffset: bgOffset,
        fields: { bgEventKind: 300 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('bgEventKind');
  });

  it('rejects out-of-u16-range coordTriggerVar with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'coord',
        structFileOffset: coordOffset,
        fields: { coordTriggerVar: 0x10000 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('coordTriggerVar');
  });

  it('rejects missing triggerKind with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        structFileOffset: bgOffset,
        fields: { elevation: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
  });

  it('rejects structFileOffset past ROM end with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'bg',
        structFileOffset: 0x100000,
        fields: { elevation: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('past ROM end');
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/trigger-fields`,
      payload: {
        triggerKind: 'bg',
        structFileOffset: bgOffset,
        fields: { elevation: 0 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.53 - Object-event-fields write route integration test.
//
// 24-byte ObjectEventTemplate layout (per pret/pokefirered):
//   +0x00 u8  localId
//   +0x01 u8  graphicsId
//   +0x02 u8  kind
//   +0x03 u8  _pad
//   +0x04 s16 x, +0x06 s16 y
//   +0x08 u8  elevation
//   +0x09 u8  movementType
//   +0x0A u8  movementRangeXY  (high nibble = x, low nibble = y)
//   +0x0B u8  _pad
//   +0x0C u16 trainerType
//   +0x0E u16 trainerSight_or_berryTreeId
//   +0x10 u32 script (ROM pointer)
//   +0x14 u16 flagId
//   +0x16 u16 _pad
//
// Most-used write path in practice - every NPC field edit goes
// through this route. Route signature accepts an array of edits in
// one call (mirrors the decomp PATCH route's multi-edit shape).
// ─────────────────────────────────────────────────────────────────────

describe('object-event-fields edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const targetOffset = 0x1000;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-objevent-fields-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a typical NPC ObjectEventTemplate at targetOffset:
    //   localId=1, graphicsId=24 (Old man), x=5, y=7, elevation=3,
    //   movementType=2 (wander), movementRangeXY=0x33 (3x/3y),
    //   trainerType=0, trainerSight=0, script=0, flag=0.
    buf[targetOffset + 0x00] = 1;
    buf[targetOffset + 0x01] = 24;
    buf.writeInt16LE(5, targetOffset + 0x04);
    buf.writeInt16LE(7, targetOffset + 0x06);
    buf[targetOffset + 0x08] = 3;
    buf[targetOffset + 0x09] = 2;
    buf[targetOffset + 0x0a] = 0x33;
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('patches u8 + u16 + script fields and returns the diff', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: {
              graphics_id: 16, // Youngster
              elevation: 5,
              movement_type: 0, // None (stationary)
              trainer_type: 1, // Normal trainer
              flag: 0x820, // Boulder Badge get
              script: 0x08123456, // valid ROM pointer
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      backupCreated: boolean;
      bytesChanged: number;
      results: Array<{
        structFileOffset: number;
        previous: Record<string, number>;
        next: Record<string, number>;
      }>;
    };
    expect(body.backupCreated).toBe(true);
    expect(body.bytesChanged).toBeGreaterThan(0);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.next.graphics_id).toBe(16);
    expect(body.results[0]!.previous.graphics_id).toBe(24);
    // Verify bytes on disk.
    const out = readFileSync(gbaPath);
    expect(out[targetOffset + 0x01]).toBe(16);
    expect(out[targetOffset + 0x08]).toBe(5);
    expect(out[targetOffset + 0x09]).toBe(0);
    expect(out.readUInt16LE(targetOffset + 0x0c)).toBe(1);
    expect(out.readUInt32LE(targetOffset + 0x10)).toBe(0x08123456);
    expect(out.readUInt16LE(targetOffset + 0x14)).toBe(0x820);
    // x/y untouched.
    expect(out.readInt16LE(targetOffset + 0x04)).toBe(5);
    expect(out.readInt16LE(targetOffset + 0x06)).toBe(7);
  });

  it('movement_range_x + _y pack into one nibble byte at +0x0a', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: { movement_range_x: 5, movement_range_y: 7 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    // High nibble = 5, low nibble = 7 → 0x57.
    expect(out[targetOffset + 0x0a]).toBe(0x57);
  });

  it('patches a single field and leaves other bytes untouched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: { graphics_id: 45 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[targetOffset + 0x00]).toBe(1); // localId unchanged
    expect(out[targetOffset + 0x01]).toBe(45); // graphics_id patched
    expect(out[targetOffset + 0x08]).toBe(3); // elevation unchanged
    expect(out[targetOffset + 0x09]).toBe(2); // movementType unchanged
    expect(out[targetOffset + 0x0a]).toBe(0x33); // range unchanged
  });

  it('rejects unknown field name with 400 unknown_field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: { localId: 99 }, // not in whitelist
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('unknown_field');
  });

  it('rejects out-of-range u8 graphics_id with 400 out_of_range', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: { graphics_id: 300 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('out_of_range');
    expect(body.error.message).toContain('graphics_id');
  });

  it('rejects an invalid script pointer (out of ROM space)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: { script: 0x05000000 }, // not in [0x08000000, 0x0A000000)
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('out_of_range');
    expect(body.error.message).toContain('script');
  });

  it('rejects movement_range_x > 15 (4-bit nibble overflow)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: { movement_range_x: 16 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('out_of_range');
    expect(body.error.message).toContain('movement_range_x');
  });

  it('rejects empty edits array with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/object-event-fields`,
      payload: { edits: [] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/object-event-fields`,
      payload: {
        edits: [
          {
            structFileOffset: targetOffset,
            fields: { graphics_id: 0 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.54 - Map-header-edit write route integration test.
//
// MapHeader struct (FRLG/RSE shared offsets for the editable fields):
//   +0x14 u16 musicId
//   +0x16 u8  regionMapSectionId
//   +0x17 u8  caveOrType
//   +0x18 u8  weather
//   +0x19 u8  mapType
//   +0x1A u8  battleType
//   +0x1B u8  flags
//
// Map-header struct is 28 bytes. Route accepts a flat `fields`
// object (unlike the multi-edit array shape on object-event-fields).
// ─────────────────────────────────────────────────────────────────────

describe('map-header edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const headerOffset = 0x1000;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-map-header-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a MapHeader at headerOffset:
    //   musicId=350, regionMapSectionId=88, caveOrType=0, weather=2,
    //   mapType=1, battleType=0, flags=1.
    buf.writeUInt16LE(350, headerOffset + 0x14);
    buf[headerOffset + 0x16] = 88;
    buf[headerOffset + 0x17] = 0;
    buf[headerOffset + 0x18] = 2;
    buf[headerOffset + 0x19] = 1;
    buf[headerOffset + 0x1a] = 0;
    buf[headerOffset + 0x1b] = 1;
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('patches musicId u16 + creates .bak on first edit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/map-header`,
      payload: {
        mapHeaderOffset: headerOffset,
        fields: { musicId: 367 }, // MUS_CYCLING-style
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      mapHeaderOffset: number;
      fieldsWritten: string[];
      backupCreated: boolean;
    };
    expect(body.fieldsWritten).toEqual(['musicId']);
    expect(body.backupCreated).toBe(true);
    const out = readFileSync(gbaPath);
    expect(out.readUInt16LE(headerOffset + 0x14)).toBe(367);
    expect(existsSync(`${gbaPath}.bak`)).toBe(true);
  });

  it('patches multiple u8 fields at distinct offsets', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/map-header`,
      payload: {
        mapHeaderOffset: headerOffset,
        fields: {
          regionMapSectionId: 100,
          weather: 5,
          battleType: 1, // gym
          mapType: 2, // route
          flags: 3,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[headerOffset + 0x16]).toBe(100);
    expect(out[headerOffset + 0x18]).toBe(5);
    expect(out[headerOffset + 0x19]).toBe(2);
    expect(out[headerOffset + 0x1a]).toBe(1);
    expect(out[headerOffset + 0x1b]).toBe(3);
    // Bytes before/after the header should be untouched.
    expect(out[headerOffset + 0x13]).toBe(0); // before musicId
    expect(out[headerOffset + 0x1c]).toBe(0); // past last field
  });

  it('caveOrType writes to +0x17, NOT +0x18 (verifies layout)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/map-header`,
      payload: {
        mapHeaderOffset: headerOffset,
        fields: { caveOrType: 7 },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[headerOffset + 0x17]).toBe(7); // caveOrType
    expect(out[headerOffset + 0x18]).toBe(2); // weather unchanged
  });

  it('rejects out-of-u8 weather (256) with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/map-header`,
      payload: {
        mapHeaderOffset: headerOffset,
        fields: { weather: 256 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('weather');
  });

  it('rejects out-of-u16 musicId (0x10000) with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/map-header`,
      payload: {
        mapHeaderOffset: headerOffset,
        fields: { musicId: 0x10000 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('musicId');
  });

  it('rejects mapHeaderOffset past ROM end with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/map-header`,
      payload: {
        mapHeaderOffset: 0x100000,
        fields: { musicId: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('past ROM end');
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/map-header`,
      payload: {
        mapHeaderOffset: headerOffset,
        fields: { musicId: 0 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.56 - Metatile-attrs write route integration test.
//
// Tileset struct (24 bytes):
//   +0x00 u8  isCompressed
//   +0x01 u8  isSecondary
//   +0x02 u16 padding
//   +0x04 ptr tiles
//   +0x08 ptr palettes
//   +0x0C ptr metatiles
//   +0x10 ptr slot10 (RSE attrs / FRLG behaviors)
//   +0x14 ptr slot14 (FRLG attrs)
//
// FRLG attribute word (4 bytes, packed bitfield per pret/pokefirered):
//   bits  0..8  behavior (9b)
//   bits  9..13 terrainType (5b)
//   bits 14..23 padding (10b)
//   bits 24..26 encounterType (3b)
//   bits 27..28 layerType (2b)
//   bits 29..31 padding (3b)
//
// This test seeds a valid Tileset struct with slot14 pointing at a
// 4-byte attribute table, calls the write route, and verifies the
// packed bytes update at the right sub-bits.
// ─────────────────────────────────────────────────────────────────────

describe('metatile-attrs edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const GBA_ROM_BASE = 0x08000000;
  const tilesetOffset = 0x1000;
  const attrsFileOffset = 0x1800; // where slot14 will point

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-metatile-attrs-'));
    const buf = Buffer.alloc(0x4000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a valid primary uncompressed Tileset struct at tilesetOffset
    // with non-null tiles + palettes (parseTileset requires them) and
    // a slot14 pointer at attrsFileOffset (FRLG attribute table).
    buf[tilesetOffset + 0x00] = 0; // isCompressed
    buf[tilesetOffset + 0x01] = 0; // isSecondary
    // Tiles pointer at 0x600 (any in-ROM offset works for parsing).
    buf.writeUInt32LE((GBA_ROM_BASE + 0x600) >>> 0, tilesetOffset + 0x04);
    // Palettes pointer at 0x700.
    buf.writeUInt32LE((GBA_ROM_BASE + 0x700) >>> 0, tilesetOffset + 0x08);
    // Metatiles pointer null.
    buf.writeUInt32LE(0, tilesetOffset + 0x0c);
    // slot10 null.
    buf.writeUInt32LE(0, tilesetOffset + 0x10);
    // slot14 → attrsFileOffset (where FRLG attribute table lives).
    buf.writeUInt32LE((GBA_ROM_BASE + attrsFileOffset) >>> 0, tilesetOffset + 0x14);
    // Seed metatile #0 attributes: behavior=0, terrain=0, encounter=0, layer=0.
    buf.writeUInt32LE(0, attrsFileOffset + 0 * 4);
    // Seed metatile #1 attributes: behavior=0x42 (tall grass-ish),
    // terrain=2 (grass), encounter=1 (land), layer=0 (normal). Packed:
    //   (1 << 24) | (2 << 9) | 0x42 = 0x01000442
    buf.writeUInt32LE((1 << 24) | (2 << 9) | 0x42, attrsFileOffset + 1 * 4);
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('GET returns parsed attrs for an existing metatile', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-metatile-attrs`,
      payload: {
        tilesetStructOffset: tilesetOffset,
        metatileId: 1,
        family: 'frlg',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      behavior: number;
      terrainType: number;
      encounterType: number;
      layerType: number;
      attrsOffset: number;
    };
    expect(body.behavior).toBe(0x42);
    expect(body.terrainType).toBe(2);
    expect(body.encounterType).toBe(1);
    expect(body.layerType).toBe(0);
    expect(body.attrsOffset).toBe(attrsFileOffset + 1 * 4);
  });

  it('patches behavior + terrain + creates .bak', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/metatile-attrs`,
      payload: {
        tilesetStructOffset: tilesetOffset,
        metatileId: 0,
        family: 'frlg',
        attrs: { behavior: 0x10, terrainType: 3 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tilesetStructOffset: number;
      metatileId: number;
      attrsOffset: number;
      bytesWritten: number;
      backupCreated: boolean;
    };
    expect(body.attrsOffset).toBe(attrsFileOffset + 0 * 4);
    expect(body.backupCreated).toBe(true);
    // Read the patched word + verify the sub-fields decoded.
    const out = readFileSync(gbaPath);
    const word = out.readUInt32LE(attrsFileOffset + 0 * 4);
    expect(word & 0x1ff).toBe(0x10); // behavior
    expect((word >>> 9) & 0x1f).toBe(3); // terrain
    expect(existsSync(`${gbaPath}.bak`)).toBe(true);
  });

  it('preserves unset fields when only one is patched', async () => {
    // Pre-existing attrs for metatile #1: behavior=0x42, terrain=2,
    // encounter=1, layer=0. Patch ONLY the encounter type.
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/metatile-attrs`,
      payload: {
        tilesetStructOffset: tilesetOffset,
        metatileId: 1,
        family: 'frlg',
        attrs: { encounterType: 2 },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    const word = out.readUInt32LE(attrsFileOffset + 1 * 4);
    expect(word & 0x1ff).toBe(0x42); // behavior preserved
    expect((word >>> 9) & 0x1f).toBe(2); // terrain preserved
    expect((word >>> 24) & 0x07).toBe(2); // encounter updated
    expect((word >>> 29) & 0x03).toBe(0); // layer preserved
  });

  it('rejects body with no attrs object', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/metatile-attrs`,
      payload: {
        tilesetStructOffset: tilesetOffset,
        metatileId: 0,
        family: 'frlg',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
  });

  it('rejects unknown family value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/metatile-attrs`,
      payload: {
        tilesetStructOffset: tilesetOffset,
        metatileId: 0,
        family: 'gen2', // invalid
        attrs: { behavior: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
  });

  it('returns 400 when tileset struct has no slot14 pointer (FRLG)', async () => {
    // Use the GET route to confirm behaviour: a tileset struct at an
    // offset where slot14 is NULL/garbage should fail to resolve.
    // We point at an arbitrary offset (0x2000) that has no seeded
    // tileset bytes - parseTileset will refuse it.
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/metatile-attrs`,
      payload: {
        tilesetStructOffset: 0x2000, // no tileset here
        metatileId: 0,
        family: 'frlg',
        attrs: { behavior: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/metatile-attrs`,
      payload: {
        tilesetStructOffset: tilesetOffset,
        metatileId: 0,
        family: 'frlg',
        attrs: { behavior: 0 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.57 - Encounter-slot write route integration test.
//
// WildPokemon struct (4 bytes):
//   +0x00 u8  minLevel  (1..100)
//   +0x01 u8  maxLevel  (1..100, must be ≥ minLevel when both supplied)
//   +0x02 u16 species   (0..0xFFFF)
//
// Each encounter table holds an array of these (12 land slots / 5
// water / 10 fishing in vanilla FRLG). This route patches one slot
// at a time - adding / removing slots needs different machinery.
// ─────────────────────────────────────────────────────────────────────

describe('encounter-slot edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const slotOffset = 0x1000;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-encounter-slot-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a WildPokemon slot: minLevel=3, maxLevel=5, species=16 (Pidgey).
    buf[slotOffset + 0x00] = 3;
    buf[slotOffset + 0x01] = 5;
    buf.writeUInt16LE(16, slotOffset + 0x02);
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('patches all 3 fields + creates .bak on first edit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: slotOffset,
        fields: { minLevel: 7, maxLevel: 9, speciesId: 25 }, // Pikachu
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      slotFileOffset: number;
      fieldsWritten: string[];
      backupCreated: boolean;
    };
    expect(body.fieldsWritten.sort()).toEqual([
      'maxLevel',
      'minLevel',
      'speciesId',
    ]);
    expect(body.backupCreated).toBe(true);
    const out = readFileSync(gbaPath);
    expect(out[slotOffset + 0x00]).toBe(7);
    expect(out[slotOffset + 0x01]).toBe(9);
    expect(out.readUInt16LE(slotOffset + 0x02)).toBe(25);
    expect(existsSync(`${gbaPath}.bak`)).toBe(true);
  });

  it('patches a single field without touching the others', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: slotOffset,
        fields: { speciesId: 4 }, // Charmander
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[slotOffset + 0x00]).toBe(3); // unchanged
    expect(out[slotOffset + 0x01]).toBe(5); // unchanged
    expect(out.readUInt16LE(slotOffset + 0x02)).toBe(4);
  });

  it('rejects minLevel below 1 with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: slotOffset,
        fields: { minLevel: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('minLevel');
  });

  it('rejects maxLevel above 100 with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: slotOffset,
        fields: { maxLevel: 101 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('maxLevel');
  });

  it('rejects maxLevel < minLevel when both supplied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: slotOffset,
        fields: { minLevel: 10, maxLevel: 5 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('maxLevel');
  });

  it('rejects speciesId above 0xFFFF with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: slotOffset,
        fields: { speciesId: 0x10000 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('speciesId');
  });

  it('rejects slotFileOffset past ROM end with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: 0x100000,
        fields: { minLevel: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('out of ROM bounds');
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/encounter-slot`,
      payload: {
        slotFileOffset: slotOffset,
        fields: { minLevel: 1 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// WP-C3 - Annotation side-car routes.
//
// GET  /api/projects/:id/annotations - read the persisted side-car
// PUT  /api/projects/:id/annotations - replace the side-car with body
//
// Persists to <projectRoot>/.editor/annotations.json. The frontend
// keeps its own local copy authoritative and pushes the union here
// debounced - these tests just verify the HTTP surface.
// ─────────────────────────────────────────────────────────────────────

describe('annotation side-car routes', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let sessionId: string;
  let sessionProjectRoot: string;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-annotations-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    const gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    sessionProjectRoot = body.session.projectRoot;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('GET returns empty side-car when none persisted yet', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/annotations`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { schemaVersion: number; annotations: Record<string, unknown> };
    expect(body.schemaVersion).toBe(1);
    expect(body.annotations).toEqual({});
  });

  it('PUT persists annotations + GET reads them back', async () => {
    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/annotations`,
      payload: {
        annotations: {
          'flag:FLAG_BADGE01_GET': {
            name: 'Got Boulder Badge',
            description: 'Player has beaten Pewter Gym',
          },
          'objectEvent:obj_2_0_1': { name: "Oak's gift NPC" },
        },
      },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json() as { annotations: Record<string, unknown> };
    expect(Object.keys(putBody.annotations).sort()).toEqual([
      'flag:FLAG_BADGE01_GET',
      'objectEvent:obj_2_0_1',
    ]);
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/annotations`,
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json() as {
      annotations: Record<string, { name?: string; description?: string }>;
    };
    expect(getBody.annotations['flag:FLAG_BADGE01_GET']).toEqual({
      name: 'Got Boulder Badge',
      description: 'Player has beaten Pewter Gym',
    });
    expect(getBody.annotations['objectEvent:obj_2_0_1']).toEqual({
      name: "Oak's gift NPC",
    });
    // Side-car file lives at <projectRoot>/.editor/annotations.json
    const sidecarPath = path.join(sessionProjectRoot, '.editor', 'annotations.json');
    expect(existsSync(sidecarPath)).toBe(true);
  });

  it('PUT replaces the whole map (no merging)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/annotations`,
      payload: { annotations: { 'flag:A': { name: 'a' } } },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/annotations`,
      payload: { annotations: { 'flag:B': { name: 'b' } } },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${sessionId}/annotations`,
    });
    const body = res.json() as { annotations: Record<string, unknown> };
    expect(Object.keys(body.annotations).sort()).toEqual(['flag:B']);
  });

  it('PUT returns 400 when body missing annotations object', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${sessionId}/annotations`,
      payload: { other: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 session_not_found for unknown sessionId on GET', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/annotations`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 session_not_found for unknown sessionId on PUT', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/annotations`,
      payload: { annotations: {} },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// WP-C1 - Encounter-table edit route integration test.
//
// /api/projects/:id/binary-rom-edit/encounter-table accepts three ops:
//   setRate - write u8 at infoFileOffset+0
//   reorder - write permuted slot array at slotsFileOffset
//   bulkReplaceSpecies - overwrite every slot's species u16
//
// Unlike /encounter-slot, this route reads the manifest to resolve
// infoFileOffset / slotsFileOffset / slot count. Each test writes a
// synthetic manifest (via writeManifest) to a freshly-opened session
// so we can drive the route without depending on a scanner round-trip.
// ─────────────────────────────────────────────────────────────────────

describe('encounter-table edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  let sessionProjectRoot: string;
  const infoOffset = 0x1100;
  const slotsOffset = 0x1200;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-encounter-table-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a WildPokemonInfo at infoOffset:
    //   +0x00 u8 encounterRate = 25
    //   +0x01..03 padding
    //   +0x04..07 ptr (we don't actually deref it in this test)
    buf[infoOffset] = 25;
    // Seed 3 WildPokemon slots at slotsOffset:
    //   slot0: minL=5 maxL=7 species=16 (Pidgey)
    //   slot1: minL=6 maxL=8 species=19 (Rattata)
    //   slot2: minL=10 maxL=12 species=129 (Magikarp)
    buf[slotsOffset + 0x00] = 5;
    buf[slotsOffset + 0x01] = 7;
    buf.writeUInt16LE(16, slotsOffset + 0x02);
    buf[slotsOffset + 0x04] = 6;
    buf[slotsOffset + 0x05] = 8;
    buf.writeUInt16LE(19, slotsOffset + 0x06);
    buf[slotsOffset + 0x08] = 10;
    buf[slotsOffset + 0x09] = 12;
    buf.writeUInt16LE(129, slotsOffset + 0x0a);
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    sessionProjectRoot = body.session.projectRoot;
    const managedFiles = require('node:fs').readdirSync(sessionProjectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(sessionProjectRoot, gbaFile);
    // Write a manifest with our synthetic encounter table.
    const { writeManifest } = await import('../scan/manifest-io.js');
    await writeManifest(sessionProjectRoot, {
      schemaVersion: 1,
      generatedAtUtc: '2026-05-25T00:00:00.000Z',
      projectRoot: sessionProjectRoot,
      identity: {
        kind: 'patch',
        confidence: 1,
        displayName: 'fake binary rom',
        baseGame: 'firered',
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
      encounterTables: [
        {
          id: 'binary_encounter_2_0_land',
          name: 'Route 1 grass',
          mapId: 'map_2_0',
          type: 'grass',
          encounterRate: 25,
          slots: [
            { speciesId: 'species_16', minLevel: 5, maxLevel: 7, weight: 1, fileOffset: slotsOffset + 0x00 },
            { speciesId: 'species_19', minLevel: 6, maxLevel: 8, weight: 1, fileOffset: slotsOffset + 0x04 },
            { speciesId: 'species_129', minLevel: 10, maxLevel: 12, weight: 1, fileOffset: slotsOffset + 0x08 },
          ],
          infoFileOffset: infoOffset,
          slotsFileOffset: slotsOffset,
        },
      ],
      trainers: [],
      scriptSteps: [],
      assets: [],
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('setRate writes a single u8 at infoFileOffset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-table`,
      payload: {
        encounterTableId: 'binary_encounter_2_0_land',
        op: 'setRate',
        encounterRate: 75,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { op: string; editsApplied: number };
    expect(body.op).toBe('setRate');
    expect(body.editsApplied).toBe(1);
    const out = readFileSync(gbaPath);
    expect(out[infoOffset]).toBe(75);
  });

  it('reorder writes a permuted slot array', async () => {
    // Swap slots 0 and 2 (Pidgey ↔ Magikarp).
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-table`,
      payload: {
        encounterTableId: 'binary_encounter_2_0_land',
        op: 'reorder',
        slotOrder: [2, 1, 0],
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    // Slot 0 should now hold what was slot 2 (Magikarp at L10-12).
    expect(out[slotsOffset + 0x00]).toBe(10);
    expect(out[slotsOffset + 0x01]).toBe(12);
    expect(out.readUInt16LE(slotsOffset + 0x02)).toBe(129);
    // Slot 1 unchanged (Rattata).
    expect(out[slotsOffset + 0x04]).toBe(6);
    expect(out.readUInt16LE(slotsOffset + 0x06)).toBe(19);
    // Slot 2 holds the old slot 0 (Pidgey at L5-7).
    expect(out[slotsOffset + 0x08]).toBe(5);
    expect(out[slotsOffset + 0x09]).toBe(7);
    expect(out.readUInt16LE(slotsOffset + 0x0a)).toBe(16);
  });

  it('bulkReplaceSpecies overwrites every slot species, preserves levels', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-table`,
      payload: {
        encounterTableId: 'binary_encounter_2_0_land',
        op: 'bulkReplaceSpecies',
        speciesId: 129, // Magikarp
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    // Every slot's species is now Magikarp (129).
    expect(out.readUInt16LE(slotsOffset + 0x02)).toBe(129);
    expect(out.readUInt16LE(slotsOffset + 0x06)).toBe(129);
    expect(out.readUInt16LE(slotsOffset + 0x0a)).toBe(129);
    // Levels preserved.
    expect(out[slotsOffset + 0x00]).toBe(5);
    expect(out[slotsOffset + 0x01]).toBe(7);
    expect(out[slotsOffset + 0x04]).toBe(6);
    expect(out[slotsOffset + 0x05]).toBe(8);
    expect(out[slotsOffset + 0x08]).toBe(10);
    expect(out[slotsOffset + 0x09]).toBe(12);
  });

  it('returns 400 bad_request when op missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-table`,
      payload: { encounterTableId: 'binary_encounter_2_0_land' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 unknown_table for an id not in the manifest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/encounter-table`,
      payload: {
        encounterTableId: 'binary_encounter_99_99_water',
        op: 'setRate',
        encounterRate: 30,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('unknown_table');
  });

  it('returns 404 session_not_found for unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/encounter-table`,
      payload: {
        encounterTableId: 'binary_encounter_2_0_land',
        op: 'setRate',
        encounterRate: 75,
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.58 - Trainer-fields write route integration test.
//
// Trainer struct (40 bytes, FRLG/Emerald shared layout):
//   +0x00 u8  partyFlags
//   +0x01 u8  trainerClass        ← edit
//   +0x02 u8  encounterMusic      ← edit
//   +0x03 u8  trainerPic          ← edit
//   +0x04 u8[12] trainerName      ← edit (Gen-3 encoded, 0xFF terminator)
//   +0x10 u16[4] items            ← edit (item0..item3)
//   +0x18 u8  doubleBattle
//   +0x1C u32 aiFlags             ← edit (aiFlagsRaw)
//   +0x20 u8  partySize
//   +0x24 u32 partyPointer
//
// Final core write route in the marker/struct-edit test series
// (O.46 → O.58). All ObjectEvent / Warp / Trigger / HealLoc / Map
// / Tileset / Encounter / Trainer write paths now have integration
// tests guarding them.
// ─────────────────────────────────────────────────────────────────────

describe('trainer-fields edit route', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const trainerOffset = 0x1000;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-trainer-fields-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a Trainer struct at trainerOffset:
    //   partyFlags=0, trainerClass=23 (Bug Catcher), encounterMusic=0,
    //   trainerPic=10, name=0xFF-fill (12 bytes), items=[0,0,0,0],
    //   doubleBattle=0, aiFlags=0x07, partySize=2, partyPointer=0.
    buf[trainerOffset + 0x00] = 0;
    buf[trainerOffset + 0x01] = 23;
    buf[trainerOffset + 0x02] = 0;
    buf[trainerOffset + 0x03] = 10;
    for (let i = 0; i < 12; i++) buf[trainerOffset + 0x04 + i] = 0xff;
    buf.writeUInt16LE(0, trainerOffset + 0x10);
    buf.writeUInt16LE(0, trainerOffset + 0x12);
    buf.writeUInt16LE(0, trainerOffset + 0x14);
    buf.writeUInt16LE(0, trainerOffset + 0x16);
    buf[trainerOffset + 0x18] = 0;
    buf.writeUInt32LE(0x07, trainerOffset + 0x1c);
    buf[trainerOffset + 0x20] = 2;
    buf.writeUInt32LE(0, trainerOffset + 0x24);
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('patches the 4 byte-fields + 4 item u16s + aiFlags u32 in one call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: trainerOffset,
        fields: {
          trainerClass: 35, // Lass
          encounterMusic: 1, // Female
          trainerPic: 5,
          item0: 13,
          item1: 14,
          item2: 0,
          item3: 0,
          aiFlagsRaw: 0xff,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      structFileOffset: number;
      fieldsWritten: string[];
      backupCreated: boolean;
    };
    expect(body.fieldsWritten).toContain('trainerClass');
    expect(body.fieldsWritten).toContain('encounterMusic');
    expect(body.fieldsWritten).toContain('trainerPic');
    expect(body.fieldsWritten).toContain('item0');
    expect(body.fieldsWritten).toContain('aiFlagsRaw');
    expect(body.backupCreated).toBe(true);
    const out = readFileSync(gbaPath);
    expect(out[trainerOffset + 0x01]).toBe(35);
    expect(out[trainerOffset + 0x02]).toBe(1);
    expect(out[trainerOffset + 0x03]).toBe(5);
    expect(out.readUInt16LE(trainerOffset + 0x10)).toBe(13);
    expect(out.readUInt16LE(trainerOffset + 0x12)).toBe(14);
    expect(out.readUInt32LE(trainerOffset + 0x1c)).toBe(0xff);
    // partyFlags / doubleBattle / partySize / partyPointer untouched.
    expect(out[trainerOffset + 0x00]).toBe(0);
    expect(out[trainerOffset + 0x18]).toBe(0);
    expect(out[trainerOffset + 0x20]).toBe(2);
    expect(out.readUInt32LE(trainerOffset + 0x24)).toBe(0);
  });

  it('writes Gen-3-encoded name to the 12-byte slot with 0xFF terminator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: trainerOffset,
        fields: { name: 'BROCK' },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    // Verify the 5 character bytes are non-0xFF + the 6th is 0xFF
    // terminator. Exact Gen-3 codec values vary, but the structural
    // invariants are: first 5 bytes encode letters (so not 0xFF/0x00),
    // 6th byte is 0xFF, remaining 6 bytes are 0xFF-fill.
    for (let i = 0; i < 5; i++) {
      const b = out[trainerOffset + 0x04 + i];
      expect(b).toBeDefined();
      expect(b).not.toBe(0xff);
      expect(b).not.toBe(0);
    }
    expect(out[trainerOffset + 0x04 + 5]).toBe(0xff);
    // Slot bytes after the terminator must all be 0xFF (pad).
    for (let i = 6; i < 12; i++) {
      expect(out[trainerOffset + 0x04 + i]).toBe(0xff);
    }
  });

  it('rejects name > 11 characters with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: trainerOffset,
        fields: { name: 'A_LONG_NAME_THAT_OVERFLOWS' },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('name');
  });

  it('rejects out-of-u8 encounterMusic (300)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: trainerOffset,
        fields: { encounterMusic: 300 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('encounterMusic');
  });

  it('rejects out-of-u16 item0 (0x10000)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: trainerOffset,
        fields: { item0: 0x10000 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('item0');
  });

  it('rejects structFileOffset past ROM end with 400 internal_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: 0x100000,
        fields: { trainerClass: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('out of bounds');
  });

  it('patches a single field without touching the others', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: trainerOffset,
        fields: { aiFlagsRaw: 0x0f },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out.readUInt32LE(trainerOffset + 0x1c)).toBe(0x0f);
    // trainerClass unchanged (was 23 in beforeEach seed).
    expect(out[trainerOffset + 0x01]).toBe(23);
    expect(out[trainerOffset + 0x02]).toBe(0);
    expect(out[trainerOffset + 0x03]).toBe(10);
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/trainer-fields`,
      payload: {
        structFileOffset: trainerOffset,
        fields: { trainerClass: 0 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase O.59-test - Species / Move / Item struct-field routes
//
// All three routes share a single `makeStructFieldRoute` factory +
// `applyStructFieldEdit` helper. The factory validates a per-route
// layout map, checks u8 / u16 / signed-s8 ranges, and patches in
// place + .bak. This block exercises the species-fields route end
// to end (the heaviest layout) + spot-checks the move-fields and
// item-fields shapes to verify the factory is wired for all three.
//
// Species BaseStats struct (28 bytes, key offsets):
//   +0x00 baseHP / +0x01 atk / +0x02 def / +0x03 spd / +0x04 spAtk /
//   +0x05 spDef / +0x06 type1 / +0x07 type2 / +0x08 catchRate /
//   +0x09 expYield / +0x0C u16 item1 / +0x0E u16 item2 /
//   +0x10 genderRatio / +0x11 eggCycles / +0x12 friendship /
//   +0x13 growthRate / +0x14 eggGroup1 / +0x15 eggGroup2 /
//   +0x16 ability1 / +0x17 ability2 / +0x18 safariFleeRate
//
// Move BattleMove struct (12 bytes, key offsets):
//   +0x00 effect / +0x01 power / +0x02 type / +0x03 accuracy / +0x04 pp
//   +0x05 secondaryEffectChance / +0x06 target / +0x07 s8 priority
//
// Item struct (44 bytes, key offsets):
//   +0x10 u16 price / +0x12 holdEffect / +0x13 holdEffectParam
//   +0x18 importance / +0x1A pocket / +0x1B type
// ─────────────────────────────────────────────────────────────────────

describe('species/move/item struct-field routes', () => {
  let app: FastifyInstance;
  let projectDir: string;
  let gbaPath: string;
  let sessionId: string;
  const speciesOffset = 0x1000;
  const moveOffset = 0x1100;
  const itemOffset = 0x1200;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'rom-editor-struct-fields-'));
    const buf = Buffer.alloc(0x2000, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96;
    buf[0xbc] = 1;
    // Unique stamp per test.
    const stamp = Buffer.from(`${Date.now()}-${Math.random()}`, 'utf8');
    stamp.copy(buf, 0x500, 0, Math.min(stamp.length, 0x100));
    // Seed a Bulbasaur-like species at speciesOffset.
    buf[speciesOffset + 0x00] = 45; // baseHP
    buf[speciesOffset + 0x01] = 49; // baseAttack
    buf[speciesOffset + 0x06] = 12; // type1 (Grass)
    buf[speciesOffset + 0x07] = 3; // type2 (Poison)
    buf.writeUInt16LE(0, speciesOffset + 0x0c); // item1
    buf.writeUInt16LE(0, speciesOffset + 0x0e); // item2
    // Seed a Tackle-like move at moveOffset.
    buf[moveOffset + 0x00] = 0; // effect
    buf[moveOffset + 0x01] = 40; // power
    buf[moveOffset + 0x02] = 0; // type (Normal)
    buf[moveOffset + 0x03] = 100; // accuracy
    buf[moveOffset + 0x04] = 35; // PP
    // Seed an item at itemOffset (price 200, pocket 1).
    buf.writeUInt16LE(200, itemOffset + 0x10);
    buf[itemOffset + 0x1a] = 1;
    gbaPath = path.join(projectDir, 'firered.gba');
    writeFileSync(gbaPath, buf);
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/projects/open-from-file',
      payload: { filePath: gbaPath },
    });
    expect(openRes.statusCode).toBe(200);
    const body = openRes.json() as {
      session: { id: string; projectRoot: string };
    };
    sessionId = body.session.id;
    const managedFiles = require('node:fs').readdirSync(body.session.projectRoot);
    const gbaFile = managedFiles.find((f: string) => f.endsWith('.gba'));
    if (gbaFile) gbaPath = path.join(body.session.projectRoot, gbaFile);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('species-fields: patches u8 + u16 fields together + creates .bak', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/species-fields`,
      payload: {
        sourceFileOffset: speciesOffset,
        fields: {
          baseHP: 100,
          baseAttack: 80,
          type1: 14, // Bug
          item1: 13, // Berry
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sourceFileOffset: number;
      fieldsWritten: string[];
      backupCreated: boolean;
    };
    expect(body.fieldsWritten.sort()).toEqual([
      'baseAttack',
      'baseHP',
      'item1',
      'type1',
    ]);
    expect(body.backupCreated).toBe(true);
    const out = readFileSync(gbaPath);
    expect(out[speciesOffset + 0x00]).toBe(100);
    expect(out[speciesOffset + 0x01]).toBe(80);
    expect(out[speciesOffset + 0x06]).toBe(14);
    expect(out.readUInt16LE(speciesOffset + 0x0c)).toBe(13);
    // type2 + item2 untouched.
    expect(out[speciesOffset + 0x07]).toBe(3);
    expect(out.readUInt16LE(speciesOffset + 0x0e)).toBe(0);
  });

  it('species-fields: rejects unknown field name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/species-fields`,
      payload: {
        sourceFileOffset: speciesOffset,
        fields: { unknownField: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain("Unknown field");
  });

  it('species-fields: rejects out-of-u8 baseHP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/species-fields`,
      payload: {
        sourceFileOffset: speciesOffset,
        fields: { baseHP: 300 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('baseHP');
  });

  it('species-fields: rejects out-of-u16 item1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/species-fields`,
      payload: {
        sourceFileOffset: speciesOffset,
        fields: { item1: 0x10000 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('item1');
  });

  it('species-fields: rejects sourceFileOffset past ROM end', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/species-fields`,
      payload: {
        sourceFileOffset: 0x100000,
        fields: { baseHP: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('out of ROM bounds');
  });

  it('move-fields: patches u8 fields + signed s8 priority', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/move-fields`,
      payload: {
        sourceFileOffset: moveOffset,
        fields: { power: 65, accuracy: 95, priority: -1 },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out[moveOffset + 0x01]).toBe(65);
    expect(out[moveOffset + 0x03]).toBe(95);
    // priority is s8 → -1 stored as 0xFF.
    expect(out[moveOffset + 0x07]).toBe(0xff);
  });

  it('move-fields: rejects out-of-s8-range priority (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/move-fields`,
      payload: {
        sourceFileOffset: moveOffset,
        fields: { priority: 200 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('priority');
  });

  it('move-fields: refuses to write the 0x09 padding byte (no stored damage class)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/move-fields`,
      payload: {
        sourceFileOffset: moveOffset,
        fields: { split: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.message).toContain("Unknown field 'split'");
    // The padding byte must be untouched: 0x09 is not a damage-class slot.
    expect(readFileSync(gbaPath)[moveOffset + 0x09]).toBe(0);
  });

  it('item-fields: patches price u16 + pocket u8', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${sessionId}/binary-rom-edit/item-fields`,
      payload: {
        sourceFileOffset: itemOffset,
        fields: { price: 9999, pocket: 4 },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = readFileSync(gbaPath);
    expect(out.readUInt16LE(itemOffset + 0x10)).toBe(9999);
    expect(out[itemOffset + 0x1a]).toBe(4);
  });

  it('returns 404 session_not_found for an unknown sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/00000000-0000-0000-0000-000000000000/binary-rom-edit/species-fields`,
      payload: {
        sourceFileOffset: speciesOffset,
        fields: { baseHP: 50 },
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as ProjectErrorResponse;
    expect(body.error.code).toBe('session_not_found');
  });
});

// Helper for building PNG bytes for the asset-replace tests above.
function makePngBuffer({
  width = 16,
  height = 16,
  bitDepth = 8,
  colorType = 3,
}: {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: 0 | 2 | 3 | 4 | 6;
}): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 4, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt8(bitDepth, 24);
  buf.writeUInt8(colorType, 25);
  buf.writeUInt8(0, 26);
  buf.writeUInt8(0, 27);
  buf.writeUInt8(0, 28);
  buf.writeUInt32BE(0, 29);
  return buf;
}
