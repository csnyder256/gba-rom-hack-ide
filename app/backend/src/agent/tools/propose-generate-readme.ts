/**
 * propose_generate_readme - Phase 3.39.
 *
 * Synthesizes a README.md for the hack's distribution package. Pulls
 * data from:
 *   - The manifest (project name, map count, trainer count, etc.)
 *   - The story spec at `.editor/story-spec.md` (if present)
 *   - The form-change-rules.json (Phase 2E persistence)
 *   - CFRU's non-monetization clause (required from Phase 1)
 *   - DPE's clause when the project is on the `firered-cfru-dpe` fork
 *
 * Output: writes README.md to `<outputPath>` (defaults to
 * `<projectRoot>/share/README.md`). The path must stay inside the
 * project root, symbolic links included.
 *
 * The agent supplies the hack-specific copy (description, features,
 * known issues); the tool stitches it together with the boilerplate
 * the licenses require.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readManifest } from '../../scan/manifest-io.js';
import { resolveInsideProject } from '../project-path.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_GENERATE_README_TOOL_NAME = 'propose_generate_readme';

export const PROPOSE_GENERATE_README_DESCRIPTION =
  'Synthesize a README.md for the hack\'s distribution package.\n\n' +
  'Inputs:\n' +
  '  - `hackName`: display name of the hack.\n' +
  '  - `version`: e.g. \'1.0\', \'0.5-beta\'.\n' +
  '  - `authorName`: optional.\n' +
  '  - `shortDescription`: 280-char tagline.\n' +
  '  - `longDescription`: optional multi-paragraph description.\n' +
  '  - `features`: bullet list of headline features.\n' +
  '  - `knownIssues`: bullet list of known limitations.\n' +
  '  - `outputPath`: optional override (default\n' +
  '    `<projectRoot>/share/README.md`); must stay inside the project.\n\n' +
  'The tool stitches in: project stats from the manifest, story-spec\n' +
  'cast/acts (if .editor/story-spec.md exists), the CFRU non-\n' +
  'monetization clause, and (if applicable) the DPE attribution.';

export const proposeGenerateReadmeInputShape = {
  hackName: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  authorName: z.string().max(60).optional(),
  shortDescription: z.string().min(1).max(280),
  longDescription: z.string().max(4000).optional(),
  features: z.array(z.string().min(1).max(200)).max(40).optional(),
  knownIssues: z.array(z.string().min(1).max(200)).max(20).optional(),
  outputPath: z.string().optional(),
} as const;

export interface ProposeGenerateReadmeResult {
  readonly ok: boolean;
  readonly writtenPath: string | null;
  readonly bytes: number;
  readonly preview: string;
  readonly message: string;
}

export async function proposeGenerateReadme(
  ctx: ToolContext,
  args: {
    hackName: string;
    version: string;
    authorName?: string;
    shortDescription: string;
    longDescription?: string;
    features?: string[];
    knownIssues?: string[];
    outputPath?: string;
  },
): Promise<ProposeGenerateReadmeResult> {
  const manifest = await readManifest(ctx.projectRoot);
  const isCfru = manifest?.identity.fork === 'CFRU' || manifest?.identity.displayName?.includes('Modernized');
  const isCfruDpe = manifest?.identity.fork === 'firered-cfru-dpe';

  // Try to read the story spec.
  let storySpecExcerpt = '';
  try {
    const spec = await fsp.readFile(
      path.join(ctx.projectRoot, '.editor', 'story-spec.md'),
      'utf8',
    );
    const titleM = spec.match(/^# 📖 Story plan - (.+)$/m);
    const premiseM = spec.match(/\*\*Premise:\*\*\s*(.+)/);
    if (titleM || premiseM) {
      storySpecExcerpt = '\n## Story\n\n';
      if (premiseM) storySpecExcerpt += `${premiseM[1]!.trim()}\n\n`;
    }
  } catch {
    /* no spec */
  }

  const lines: string[] = [];
  lines.push(`# ${args.hackName}`);
  lines.push('');
  lines.push(`*Version ${args.version}${args.authorName ? ` - by ${args.authorName}` : ''}*`);
  lines.push('');
  lines.push(args.shortDescription);
  lines.push('');
  if (args.longDescription) {
    lines.push('## About');
    lines.push('');
    lines.push(args.longDescription);
    lines.push('');
  }
  if (storySpecExcerpt) lines.push(storySpecExcerpt);
  if (args.features && args.features.length > 0) {
    lines.push('## Features');
    lines.push('');
    for (const f of args.features) lines.push(`- ${f}`);
    lines.push('');
  }
  if (manifest) {
    lines.push('## What\'s in the hack');
    lines.push('');
    lines.push(`- ${String(manifest.maps.length)} map(s)`);
    lines.push(`- ${String(manifest.trainers.length)} trainer(s)`);
    lines.push(`- ${String(manifest.objectEvents.length)} NPC(s)`);
    lines.push(`- ${String(manifest.scriptSteps.length)} script step(s)`);
    if (manifest.dialogue && manifest.dialogue.length > 0) {
      lines.push(`- ${String(manifest.dialogue.length)} dialogue node(s)`);
    }
    lines.push('');
  }
  lines.push('## How to play');
  lines.push('');
  lines.push('1. Obtain a legal copy of **Pokémon FireRed Version (USA)** - the v1.0 dump.');
  lines.push('2. Apply this patch (`.bps`) to a clean ROM using a patcher like [Flips](https://www.romhacking.net/utilities/1040/) or [Floating IPS](https://www.smwcentral.net/?p=section&a=details&id=11474).');
  lines.push('3. Run the patched ROM on a GBA emulator like [mGBA](https://mgba.io/) or on real hardware.');
  lines.push('');
  if (args.knownIssues && args.knownIssues.length > 0) {
    lines.push('## Known issues');
    lines.push('');
    for (const i of args.knownIssues) lines.push(`- ${i}`);
    lines.push('');
  }
  lines.push('## Credits & licenses');
  lines.push('');
  if (isCfru || isCfruDpe) {
    lines.push('This hack is built on **Complete Fire Red Upgrade (CFRU)** by Skeli789. CFRU adds modern battle features to Pokémon FireRed including the Fairy type, generations 2-8 species, abilities, and items; mega evolution, Z-moves, and 600+ battle mechanics. Read more at <https://github.com/Skeli789/Complete-Fire-Red-Upgrade>.');
    lines.push('');
    lines.push('> By the terms of CFRU\'s license, this hack - and any hack built on CFRU - is **non-commercial**. The patch author must not sell it, accept donations for it, or otherwise profit from it. This includes pay-walls as well as optional donations (ko-fi, Patreon, etc.).');
    lines.push('');
  }
  if (isCfruDpe) {
    lines.push('This hack additionally uses **Dynamic Pokémon Expansion (DPE)** by Skeli789, which extends the species set to Generation 9. Read more at <https://github.com/Skeli789/Dynamic-Pokemon-Expansion>. The same non-monetization clause applies.');
    lines.push('');
  }
  lines.push('Pokémon and all character names, sprites, and content not produced by this hack\'s author are property of Game Freak / Nintendo / The Pokémon Company. This is a fan project; no commercial use intended.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*Patch generated ${new Date().toISOString().split('T')[0]} by the ROM editor.*`);

  const markdown = lines.join('\n');
  const requested = args.outputPath ?? path.join('share', 'README.md');
  const out = await resolveInsideProject(ctx.projectRoot, requested);
  if (out === null) {
    return {
      ok: false,
      writtenPath: null,
      bytes: 0,
      preview: markdown.slice(0, 500),
      message: `Refusing to write README at ${requested}: the path leaves the project root.`,
    };
  }
  try {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, markdown, 'utf8');
  } catch (e) {
    return {
      ok: false,
      writtenPath: null,
      bytes: 0,
      preview: markdown.slice(0, 500),
      message: `Could not write README at ${out}: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }

  const previewMax = 500;
  return {
    ok: true,
    writtenPath: out,
    bytes: markdown.length,
    preview: markdown.length > previewMax ? `${markdown.slice(0, previewMax)}…` : markdown,
    message: `Wrote ${String(markdown.length)}-byte README to ${out}.`,
  };
}
