import { describe, expect, it } from 'vitest';
import { locateMid2agb, runMid2agb } from './mid2agb-bridge.js';

/**
 * Phase 5.1 - bridge tests. We can't realistically test against a
 * real mid2agb binary in CI; instead we test the SHAPE of the result
 * + the variant detection logic that doesn't depend on running an
 * actual converter.
 */

// locateMid2agb shells out to `where`/`which` once per candidate name. On
// GitHub's Windows runners a cold `where` can take seconds, which made these
// tests trip vitest's 5 s default at random.
describe('locateMid2agb (Phase 5.1)', { timeout: 30_000 }, () => {
  it('returns a structured result regardless of installation state', async () => {
    const result = await locateMid2agb();
    expect(result).toBeDefined();
    expect(typeof result.found).toBe('boolean');
    expect(typeof result.suggestion).toBe('string');
    expect(Array.isArray(result.searchedPaths)).toBe(true);
    expect(result.searchedPaths.length).toBeGreaterThan(0);
  });

  it('result is frozen so callers can cache it safely', async () => {
    const result = await locateMid2agb();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.searchedPaths)).toBe(true);
  });

  it('not-found path surfaces install instructions mentioning both variants', async () => {
    const result = await locateMid2agb();
    if (result.found) {
      // Skip when the host machine happens to have a binary installed.
      return;
    }
    expect(result.path).toBeNull();
    expect(result.variant).toBeNull();
    expect(result.suggestion).toMatch(/midi2agb|mid2agb/i);
    expect(result.suggestedInstallPath).toBeTruthy();
  });

  it('found path includes a variant tag', async () => {
    const result = await locateMid2agb();
    if (!result.found) return;
    expect(['mid2agb', 'midi2agb']).toContain(result.variant);
  });
});

describe('runMid2agb (Phase 5.1)', () => {
  it('object signature: runs against a bogus binary path, returns ok=false', async () => {
    const result = await runMid2agb({
      midiPath: '/no/such/input.mid',
      outputPath: '/tmp/output.s',
      mid2agbPath: '/no/such/midi2agb',
    });
    expect(result.ok).toBe(false);
    // Either stdout or stderr should carry the spawn error.
    expect(result.stderr.length + result.stdout.length).toBeGreaterThan(0);
  });

  it('legacy positional signature still works (Phase 3.6 callers)', async () => {
    // Old call: runMid2agb(midiPath, outputPath, mid2agbPath, extraArgs)
    const result = await runMid2agb('/no/such/input.mid', '/tmp/out.s', '/no/such/midi2agb');
    expect(result.ok).toBe(false);
  });

  it('forwards extraArgs into the spawn command', async () => {
    // We can't introspect the spawn args without mocking, but we
    // confirm extraArgs doesn't crash when present.
    const result = await runMid2agb({
      midiPath: '/no/such/in.mid',
      outputPath: '/tmp/o.s',
      mid2agbPath: '/no/such/bin',
      extraArgs: ['-v', '-m', '128'],
    });
    expect(result.ok).toBe(false);
  });
});
