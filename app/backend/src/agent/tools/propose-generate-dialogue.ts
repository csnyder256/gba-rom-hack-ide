/**
 * propose_generate_dialogue - Phase 3.22.
 *
 * Surfaces the voice card + scene context for a given dialogue beat
 * so the agent can compose lines that honor the character's voice.
 * The tool itself does NOT call an LLM - it loads the voice card +
 * cache, prompts the agent (via the result), and lets the agent
 * write the lines.
 *
 * Cache: by default, a (characterId, sceneId, beat, contextHash)
 * tuple keys into `.editor/dialogue-cache/<hash>.json`. Two runs
 * with the same inputs return the cached lines (for reproducibility
 * during overnight runs).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolContext } from '../types.js';

export const PROPOSE_GENERATE_DIALOGUE_TOOL_NAME = 'propose_generate_dialogue';

export const PROPOSE_GENERATE_DIALOGUE_DESCRIPTION =
  'Compose dialogue lines for a specific character + scene + beat,\n' +
  'honoring the character\'s voice card.\n\n' +
  'Inputs:\n' +
  '  - `characterId`: must match an existing voice card at\n' +
  '    `.editor/voices/<characterId>.md` (create one first via\n' +
  '    propose_character_voice_card).\n' +
  '  - `sceneId`: stable id for the scene (e.g. \'pallet_first_meeting\').\n' +
  '  - `beat`: \'greet\' | \'reveal\' | \'mock\' | \'parting\' | string.\n' +
  '  - `contextSummary`: 1-3 sentence description of what just happened\n' +
  '    leading into this beat.\n' +
  '  - `lines`: the agent\'s drafted lines (1-6). Persisted to cache.\n' +
  '  - `constraint.maxLength`: optional per-line char cap.\n' +
  '  - `constraint.lineCount`: optional exact line count.\n\n' +
  'The tool validates lines against the voice card\'s forbidden\n' +
  'vocabulary + caches the result. Subsequent calls with the same\n' +
  'inputs return the cached entry. Cache lives at\n' +
  '`.editor/dialogue-cache/<contentHash>.json`.';

export const proposeGenerateDialogueInputShape = {
  characterId: z.string().min(1).max(60),
  sceneId: z.string().min(1).max(60),
  beat: z.string().min(1).max(40),
  contextSummary: z.string().min(1).max(1000),
  lines: z.array(z.string().min(1).max(500)).min(1).max(10),
  constraint: z
    .object({
      maxLength: z.number().int().min(10).max(500).optional(),
      lineCount: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
} as const;

export interface ProposeGenerateDialogueResult {
  readonly ok: boolean;
  readonly lines: ReadonlyArray<string>;
  readonly fromCache: boolean;
  readonly cachePath: string | null;
  readonly voiceCardPath: string | null;
  readonly violations: ReadonlyArray<string>;
  readonly message: string;
}

interface VoiceCardSummary {
  readonly forbidden: ReadonlyArray<string>;
  readonly preferred: ReadonlyArray<string>;
}

async function loadVoiceCard(projectRoot: string, characterId: string): Promise<{ path: string; summary: VoiceCardSummary } | null> {
  // Same id rule propose_character_voice_card enforces when it writes the
  // card; anything else (a '../' path, say) cannot name one.
  if (!/^[a-z0-9_-]+$/i.test(characterId)) return null;
  const file = path.join(projectRoot, '.editor', 'voices', `${characterId}.md`);
  try {
    const md = await fsp.readFile(file, 'utf8');
    // Parse the markdown for forbidden / preferred lines.
    const forbidden: string[] = [];
    const preferred: string[] = [];
    for (const line of md.split(/\r?\n/)) {
      const f = line.match(/^\s*-\s*\*\*Forbidden:\*\*\s*(.+)$/);
      if (f) {
        const words = f[1]!.split(',').map((w) => w.replace(/`/g, '').trim()).filter(Boolean);
        forbidden.push(...words);
      }
      const p = line.match(/^\s*-\s*\*\*Preferred:\*\*\s*(.+)$/);
      if (p) {
        const words = p[1]!.split(',').map((w) => w.replace(/`/g, '').trim()).filter(Boolean);
        preferred.push(...words);
      }
    }
    return { path: file, summary: { forbidden, preferred } };
  } catch {
    return null;
  }
}

export async function proposeGenerateDialogue(
  ctx: ToolContext,
  args: {
    characterId: string;
    sceneId: string;
    beat: string;
    contextSummary: string;
    lines: string[];
    constraint?: { maxLength?: number; lineCount?: number };
  },
): Promise<ProposeGenerateDialogueResult> {
  const voiceCard = await loadVoiceCard(ctx.projectRoot, args.characterId);

  // Build a stable hash from the (character, scene, beat, context, constraint)
  // tuple. Lines are NOT in the hash - we cache by INPUT signature.
  const hashInput = JSON.stringify({
    characterId: args.characterId,
    sceneId: args.sceneId,
    beat: args.beat,
    contextSummary: args.contextSummary,
    constraint: args.constraint ?? null,
  });
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  const cacheDir = path.join(ctx.projectRoot, '.editor', 'dialogue-cache');
  const cacheFile = path.join(cacheDir, `${hash}.json`);

  // Cache hit returns saved lines.
  try {
    const cached = await fsp.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(cached) as { lines: string[]; characterId: string };
    if (parsed.characterId === args.characterId && Array.isArray(parsed.lines)) {
      return {
        ok: true,
        lines: Object.freeze(parsed.lines),
        fromCache: true,
        cachePath: cacheFile,
        voiceCardPath: voiceCard?.path ?? null,
        violations: [],
        message: `Returned ${String(parsed.lines.length)} cached lines for ${args.characterId}/${args.sceneId}/${args.beat}.`,
      };
    }
  } catch {
    /* miss; continue to validate + cache */
  }

  // Validate against voice card.
  const violations: string[] = [];
  if (voiceCard) {
    for (let i = 0; i < args.lines.length; i++) {
      const line = args.lines[i]!;
      const lc = line.toLowerCase();
      for (const banned of voiceCard.summary.forbidden) {
        if (lc.includes(banned.toLowerCase())) {
          violations.push(`Line ${String(i + 1)} contains forbidden word "${banned}".`);
        }
      }
    }
  } else {
    violations.push(`No voice card at .editor/voices/${args.characterId}.md - create one via propose_character_voice_card first.`);
  }
  if (args.constraint?.maxLength) {
    for (let i = 0; i < args.lines.length; i++) {
      if (args.lines[i]!.length > args.constraint.maxLength) {
        violations.push(`Line ${String(i + 1)} exceeds maxLength ${String(args.constraint.maxLength)} chars (${String(args.lines[i]!.length)} chars).`);
      }
    }
  }
  if (args.constraint?.lineCount && args.lines.length !== args.constraint.lineCount) {
    violations.push(`Expected ${String(args.constraint.lineCount)} lines; got ${String(args.lines.length)}.`);
  }

  // Cache (even with violations - caller decides whether to accept).
  let cachePath: string | null = null;
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      cacheFile,
      JSON.stringify(
        {
          characterId: args.characterId,
          sceneId: args.sceneId,
          beat: args.beat,
          contextSummary: args.contextSummary,
          lines: args.lines,
          violations,
          generatedAtUtc: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    cachePath = cacheFile;
  } catch {
    /* best-effort */
  }

  return {
    ok: violations.length === 0,
    lines: Object.freeze([...args.lines]),
    fromCache: false,
    cachePath,
    voiceCardPath: voiceCard?.path ?? null,
    violations: Object.freeze(violations),
    message:
      violations.length > 0
        ? `Persisted ${String(args.lines.length)} draft lines with ${String(violations.length)} voice violations.`
        : `Persisted ${String(args.lines.length)} lines for ${args.characterId}/${args.sceneId}/${args.beat}.`,
  };
}
