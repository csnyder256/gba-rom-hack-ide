import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startDecompBuild, getDecompBuildJob } from './decomp-build.js';

describe.skipIf(process.platform === 'win32')('native project build', () => {
  it('runs the actual make target in a path containing spaces and an apostrophe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gba build user's "));
    try {
      await writeFile(path.join(root, 'Makefile'), '.PHONY: modern\nmodern:\n\tprintf original-homebrew > demo.gba\n');
      const result = await startDecompBuild('native-test', root);
      expect(result.error).toBeUndefined();
      expect(result.job).toBeDefined();
      const deadline = Date.now() + 10_000;
      while (getDecompBuildJob(result.job!.id)?.state === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const job = getDecompBuildJob(result.job!.id)!;
      expect(job.state, job.log).toBe('success');
      expect(job.exitCode).toBe(0);
      expect(job.romRelPath).toBe('demo.gba');
      expect(await readFile(path.join(root, 'demo.gba'), 'utf8')).toBe('original-homebrew');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
