import { describe, expect, it } from 'vitest';
import { fixtures } from '@rom-introspection/engine';
import { runEngineOnRom } from './engine-client.js';

/**
 * EngineClient integration test - UW Phase UW-0 P13 substrate verification.
 *
 * Invariants under test:
 *   - Engine/editor single source of truth: the editor backend's ONLY path
 *     to ROM introspection is `runEngineOnRom`. This test proves the wire is
 *     intact: backend → engine via the npm `file:` dep → full ingest
 *     pipeline → WorkspaceModel.
 *   - No empty success: every detector returns typed data with evidence or a
 *     typed `not_detected`. The orchestrator throws on violation; this test
 *     would fail if any detector violated it.
 *
 * This is the cumulative end-to-end test skeleton's first member. As
 * subsequent UW phases land, additional tests assert per-category
 * coverage (Cat 1..15) against the same `WorkspaceModel` output.
 */
describe('runEngineOnRom - PD 13 substrate (editor backend ↔ engine wire)', () => {
  // A full engine pass over a 16 MiB ROM takes minutes: 215-270 s on
  // GitHub's runners, about 345 s in a local node:22 container. vitest
  // 1.x never enforced the old 30 s timeout on a test that blocks the
  // event loop, so it looked fine; vitest 2+ does, and correctly fails
  // it. The budget below is the real one.
  it('returns a populated WorkspaceModel for a FireRed-shaped synthetic ROM', async () => {
    const rom = fixtures.buildSyntheticRom({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      romSize: 16 * 1024 * 1024,
    });

    const result = await runEngineOnRom({
      romBytes: rom.bytes,
      sourcePath: rom.sourcePath ?? 'test://synthetic',
      synthetic: true,
      nowIsoUtc: '2026-05-17T08:30:00.000Z',
    });

    // Identity section populated.
    expect(result.workspaceModel.identity.sha1).toBe(rom.sha1);
    expect(result.workspaceModel.identity.byteLength).toBe(16 * 1024 * 1024);
    expect(result.workspaceModel.identity.familyVerdict.family).toBeTruthy();

    // Coverage section populated; PD 8 sanity (every byte accounted).
    expect(result.workspaceModel.coverage.romSize).toBe(16 * 1024 * 1024);
    expect(
      result.workspaceModel.coverage.classifiedBytes +
        result.workspaceModel.coverage.unknownScoredBytes +
        result.workspaceModel.coverage.unaccountedBytes,
    ).toBe(16 * 1024 * 1024);

    // Feature detection section populated with ≥14 detectors (default set).
    expect(result.workspaceModel.featureDetection.detectors.length).toBeGreaterThanOrEqual(14);
    const { detectedCount, partialCount, notDetectedCount } = result.workspaceModel.featureDetection.summary;
    expect(detectedCount + partialCount + notDetectedCount).toBeGreaterThanOrEqual(14);

    // Family verdict produced (FireRed-shaped → 'firered').
    expect(result.familyVerdict.family).toBe('firered');
    expect(result.familyVerdict.confidence).toBeGreaterThan(0);

    // IngestReport carried through.
    expect(result.ingestReport.summary.totalDetectors).toBeGreaterThanOrEqual(14);
    expect(result.ingestReport.coverage.regions.length).toBeGreaterThan(0);
  }, 900_000);

  it('returns unrecognized family for an unknown-game-code synthetic ROM', async () => {
    const rom = fixtures.buildSyntheticRom({
      title: 'UNKNOWNGAME',
      gameCode: 'ZZZZ',
      makerCode: 'ZZ',
      softwareVersion: 0,
      romSize: 1024 * 1024, // 1 MiB
    });

    const result = await runEngineOnRom({
      romBytes: rom.bytes,
      sourcePath: rom.sourcePath ?? 'test://synthetic',
      synthetic: true,
    });

    expect(result.familyVerdict.family).toBe('unrecognized');
    // Even unrecognized ROMs produce a complete WorkspaceModel (PD 4
    // universality before completeness).
    expect(result.workspaceModel.identity.sha1).toBe(rom.sha1);
    expect(result.workspaceModel.coverage.romSize).toBe(1024 * 1024);
  }, 30_000);
});
