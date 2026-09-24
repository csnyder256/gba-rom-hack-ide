import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInsideProject } from './project-path.js';
import { proposeGenerateReadme } from './tools/propose-generate-readme.js';
import { proposeGenerateDialogue } from './tools/propose-generate-dialogue.js';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(tmpdir(), 'project-path-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
});

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

/** A directory link; junctions need no extra privileges on Windows. */
async function linkDir(target: string, link: string): Promise<boolean> {
  try {
    await fsp.symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

describe('resolveInsideProject', () => {
  it('resolves relative and absolute paths that stay inside', async () => {
    expect(await resolveInsideProject(root, 'share/README.md')).toBe(path.join(root, 'share', 'README.md'));
    expect(await resolveInsideProject(root, path.join(root, 'a', 'b.md'))).toBe(path.join(root, 'a', 'b.md'));
    expect(await resolveInsideProject(root, 'x/../y.md')).toBe(path.join(root, 'y.md'));
  });

  it('refuses paths that leave the root', async () => {
    expect(await resolveInsideProject(root, '../outside/x.md')).toBeNull();
    expect(await resolveInsideProject(root, path.join(outside, 'x.md'))).toBeNull();
    expect(await resolveInsideProject(root, root + '-sibling/x.md')).toBeNull();
  });

  it('refuses a new file under a directory link that leads out', async (ctx) => {
    if (!(await linkDir(outside, path.join(root, 'share')))) return ctx.skip();
    expect(await resolveInsideProject(root, 'share/README.md')).toBeNull();
    expect(await resolveInsideProject(root, 'share/deeper/README.md')).toBeNull();
  });

  it('refuses a path through a link whose target does not exist yet', async (ctx) => {
    if (!(await linkDir(path.join(outside, 'not-yet'), path.join(root, 'share')))) return ctx.skip();
    expect(await resolveInsideProject(root, 'share/README.md')).toBeNull();
  });

  it('allows a directory link that stays inside the root', async (ctx) => {
    await fsp.mkdir(path.join(root, 'real'));
    if (!(await linkDir(path.join(root, 'real'), path.join(root, 'alias')))) return ctx.skip();
    expect(await resolveInsideProject(root, 'alias/README.md')).toBe(path.join(root, 'alias', 'README.md'));
  });
});

describe('propose_generate_readme', () => {
  const args = { hackName: 'Test Hack', version: '1.0', shortDescription: 'A test.' };

  it('writes share/README.md inside the project by default', async () => {
    const r = await proposeGenerateReadme({ projectRoot: root }, args);
    expect(r.ok).toBe(true);
    expect(r.writtenPath).toBe(path.join(root, 'share', 'README.md'));
    expect(await fsp.readFile(path.join(root, 'share', 'README.md'), 'utf8')).toContain('Test Hack');
  });

  it('refuses an outputPath outside the project and writes nothing', async () => {
    const r = await proposeGenerateReadme({ projectRoot: root }, { ...args, outputPath: path.join(outside, 'README.md') });
    expect(r.ok).toBe(false);
    expect(r.writtenPath).toBeNull();
    expect(await fsp.readdir(outside)).toEqual([]);
  });

  it('refuses the default path when share/ links out of the project', async (ctx) => {
    if (!(await linkDir(outside, path.join(root, 'share')))) return ctx.skip();
    const r = await proposeGenerateReadme({ projectRoot: root }, args);
    expect(r.ok).toBe(false);
    expect(await fsp.readdir(outside)).toEqual([]);
  });
});

describe('propose_generate_dialogue', () => {
  it('does not read a voice card through a path-shaped characterId', async () => {
    await fsp.writeFile(path.join(outside, 'secret.md'), '- **Forbidden:** leaked\n', 'utf8');
    const r = await proposeGenerateDialogue(
      { projectRoot: root },
      {
        characterId: '../../../outside/secret',
        sceneId: 'scene',
        beat: 'beat',
        contextSummary: 'context',
        lines: ['That secret was leaked.'],
      },
    );
    expect(r.voiceCardPath).toBeNull();
    expect(r.violations.join(' ')).not.toContain('leaked');
  });
});
