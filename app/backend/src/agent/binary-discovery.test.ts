import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { findClaudeBinary } from './binary-discovery.js';

describe('findClaudeBinary', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(tmpdir(), 'claude-discover-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns CLAUDE_CLI_PATH when it points at a real file', async () => {
    const fakeClaude = path.join(tmpHome, 'claude.cmd');
    await fsp.writeFile(fakeClaude, '# fake', 'utf8');
    const result = await findClaudeBinary({
      env: { CLAUDE_CLI_PATH: fakeClaude, USERPROFILE: tmpHome, HOME: tmpHome },
      platform: 'win32',
    });
    expect(result).toBe(fakeClaude);
  });

  it('falls through when CLAUDE_CLI_PATH points at a missing file', async () => {
    // No fallback claude exists anywhere - should return null.
    // Inject a stub findOnPathImpl so the host machine's REAL claude
    // install (if any) doesn't leak into the result.
    const result = await findClaudeBinary({
      env: { CLAUDE_CLI_PATH: path.join(tmpHome, 'nope.exe'), USERPROFILE: tmpHome, HOME: tmpHome, APPDATA: tmpHome, LOCALAPPDATA: tmpHome },
      platform: 'win32',
      findOnPathImpl: async () => null,
    });
    expect(result).toBeNull();
  });

  it('finds claude in a known windows install location', async () => {
    const npmDir = path.join(tmpHome, 'npm');
    await fsp.mkdir(npmDir, { recursive: true });
    const installed = path.join(npmDir, 'claude.cmd');
    await fsp.writeFile(installed, '# fake', 'utf8');
    const result = await findClaudeBinary({
      env: { USERPROFILE: tmpHome, HOME: tmpHome, APPDATA: tmpHome, LOCALAPPDATA: tmpHome },
      platform: 'win32',
      findOnPathImpl: async () => null,
    });
    expect(result).toBe(installed);
  });

  it('finds claude in a known unix install location', async () => {
    const localBin = path.join(tmpHome, '.claude', 'local');
    await fsp.mkdir(localBin, { recursive: true });
    const installed = path.join(localBin, 'claude');
    await fsp.writeFile(installed, '# fake', 'utf8');
    const result = await findClaudeBinary({
      env: { HOME: tmpHome },
      platform: 'linux',
      findOnPathImpl: async () => null,
    });
    expect(result).toBe(installed);
  });
});
