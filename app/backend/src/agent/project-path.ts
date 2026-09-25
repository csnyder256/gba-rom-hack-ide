import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a path an agent tool was given against the project root, or
 * return null when it would land outside the root. Relative paths resolve
 * against the root; absolute paths are accepted only when they point inside
 * it. Symbolic links and junctions are followed: the deepest part of the
 * path that already exists is resolved on disk, so a file about to be
 * created under a linked directory is caught as well as an existing linked
 * file. (Hard links cannot be told apart from ordinary files.)
 */
export async function resolveInsideProject(
  projectRoot: string,
  supplied: string,
): Promise<string | null> {
  const target = path.resolve(projectRoot, supplied);
  if (!isInside(path.resolve(projectRoot), target)) return null;
  const realRoot = await fsp.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  for (let probe = target; ; probe = path.dirname(probe)) {
    const real = await fsp.realpath(probe).catch(() => undefined);
    if (real !== undefined) return isInside(realRoot, real) ? target : null;
    // On disk but unresolvable: a link to a missing target. Creating
    // through it could create that target, wherever it points.
    if (await fsp.lstat(probe).then(() => true, () => false)) return null;
    if (path.dirname(probe) === probe) return null;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
