import { z } from 'zod';
import type { AgentPatchEdit, AgentPatchProposal } from '@rom-editor/shared';
import type { ToolContext } from '../types.js';

export const PROPOSE_PATCH_TOOL_NAME = 'propose_patch';

export const PROPOSE_PATCH_DESCRIPTION =
  'Queue a patch for the user to review and apply. The patch is a ' +
  'human-readable description + a typed edit list. NOTHING IS WRITTEN ' +
  'to disk by this tool - the proposal appears in the user\'s diff dock; ' +
  'they click Apply or Reject. Use this for any rename, swap, or systemic ' +
  'change. Up to 200 edits per proposal.\n' +
  '\n' +
  'Edit kinds (v1):\n' +
  '  - replace_in_file: project-relative path, exact-once text find+replace ' +
  'against a source file (decomp targets). Backend rejects edits where ' +
  '`before` appears zero or multiple times. Use Read/Grep first to ' +
  'confirm the exact match.\n' +
  '  - binary_replace_text: in-place Gen-3 text write in the .gba at a ' +
  'specific byte offset (binary-rom targets - FireRed/Unbound/Radical Red). ' +
  'Use the `textFileOffset` field on any decoded dialogue scriptStep as ' +
  '`textOffset`. `before` must exactly match the decoded on-disk text. ' +
  '`after` must encode to the same OR FEWER bytes than the original ' +
  'string (length-increasing renames need AI-1.4b free-space allocation, ' +
  'not yet shipped).\n' +
  '  - binary_write_text: write Gen-3 text at an arbitrary offset. Used ' +
  'with `binary_rewrite_pointer` for length-increasing renames - allocate ' +
  'free ROM space (via `engine.rom.findFreeRomSpace`), write the new ' +
  'string at the free offset, then repoint the original pointer at it.\n' +
  '  - binary_rewrite_pointer: rewrite a 32-bit LE GBA pointer; validates ' +
  'the current pointer value before writing.\n' +
  '  - binary_write_bytes: write raw bytes at an offset in the .gba. ' +
  'Used by import_species_from_library to push the 28-byte species struct ' +
  '+ 30-byte evolution table row + TM/HM bitfield into the target ROM. ' +
  '`beforeBytes` and `afterBytes` are hex (no separators, no 0x prefix); ' +
  'empty `beforeBytes` = free-space mode (applier requires the slot to be ' +
  'fill bytes). v1 requires `beforeBytes.length === afterBytes.length` ' +
  'when `beforeBytes` is non-empty.';

const replaceInFileEditSchema = z.object({
  kind: z.literal('replace_in_file'),
  filePath: z.string().min(1),
  before: z.string().min(1),
  after: z.string(),
  note: z.string().optional(),
});

const binaryReplaceTextEditSchema = z.object({
  kind: z.literal('binary_replace_text'),
  textOffset: z.number().int().nonnegative(),
  before: z.string().min(1),
  after: z.string(),
  maxBytes: z.number().int().positive().max(2048).optional(),
  slotBytes: z.number().int().positive().max(2048).optional(),
  note: z.string().optional(),
});

const binaryWriteTextEditSchema = z.object({
  kind: z.literal('binary_write_text'),
  offset: z.number().int().nonnegative(),
  // before is the empty string for free-space writes; non-empty for
  // in-place rewrites of an existing string slot.
  before: z.string(),
  after: z.string(),
  slotBytes: z.number().int().positive().max(2048).optional(),
  requireFreeSlot: z.boolean().optional(),
  note: z.string().optional(),
});

const binaryRewritePointerEditSchema = z.object({
  kind: z.literal('binary_rewrite_pointer'),
  pointerOffset: z.number().int().nonnegative(),
  beforeTargetOffset: z.number().int().nonnegative(),
  afterTargetOffset: z.number().int().nonnegative(),
  note: z.string().optional(),
});

const binaryWriteBytesEditSchema = z.object({
  kind: z.literal('binary_write_bytes'),
  offset: z.number().int().nonnegative(),
  // beforeBytes empty = free-space mode; non-empty = expected current bytes.
  beforeBytes: z
    .string()
    .regex(/^[0-9a-fA-F]*$/, 'beforeBytes must be hex characters (or empty)'),
  afterBytes: z
    .string()
    .min(2)
    .regex(/^[0-9a-fA-F]+$/, 'afterBytes must be non-empty hex characters'),
  requireFreeSlot: z.boolean().optional(),
  note: z.string().optional(),
});

const editSchema = z.discriminatedUnion('kind', [
  replaceInFileEditSchema,
  binaryReplaceTextEditSchema,
  binaryWriteTextEditSchema,
  binaryRewritePointerEditSchema,
  binaryWriteBytesEditSchema,
]);

export const proposePatchInputShape = {
  description: z.string().min(1).max(500),
  edits: z.array(editSchema).min(1).max(200),
} as const;

export type ProposePatchErrorCode =
  | 'no_baseurl'
  | 'backend_unreachable'
  | 'backend_rejected';

export class ProposePatchError extends Error {
  constructor(public readonly code: ProposePatchErrorCode, message: string) {
    super(message);
    this.name = 'ProposePatchError';
  }
}

export async function proposePatch(
  ctx: ToolContext,
  args: { description: string; edits: AgentPatchEdit[] },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<AgentPatchProposal> {
  if (!ctx.baseUrl) {
    throw new ProposePatchError(
      'no_baseurl',
      'ROM_EDITOR_BASE_URL env var is not set; the MCP server cannot reach the editor backend.',
    );
  }
  const fetchFn = deps.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${ctx.baseUrl}/api/agent/internal/patches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectRoot: ctx.projectRoot,
        description: args.description,
        edits: args.edits,
      }),
    });
  } catch (e) {
    throw new ProposePatchError(
      'backend_unreachable',
      `Could not reach Fastify backend at ${ctx.baseUrl}: ${(e as Error).message}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ProposePatchError(
      'backend_rejected',
      `Backend rejected proposal: HTTP ${response.status} ${text}`.trim(),
    );
  }
  return (await response.json()) as AgentPatchProposal;
}
