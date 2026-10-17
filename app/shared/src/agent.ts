/**
 * Agent API contracts - shared between backend and frontend.
 *
 * Phase AI-0.3 - buffered turn endpoint.
 * Phase AI-0.4 will add streaming via WebSocket; the AgentTurnEvent
 * shape here is the same envelope used over WS so the frontend can
 * render the same way for both paths.
 */

export interface AgentTurnRequest {
  readonly prompt: string;
  readonly projectId: string;
}

/** One emitted event from the agent turn. `type` mirrors the
 *  Claude Code stream-json `type` (system / assistant / user /
 *  result / unknown). `data` is the raw JSON object. */
export interface AgentTurnEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface AgentTurnResponse {
  readonly sessionId: string;
  readonly turnCount: number;
  readonly events: ReadonlyArray<AgentTurnEvent>;
  /** Extracted text from the terminal `result` event, when present. */
  readonly finalText: string;
  readonly durationMs: number;
}

/** One step in the claude binary discovery trace. The AgentPanel
 *  renders these so when the binary isn't found, the user sees
 *  exactly which paths were tried + which exist. */
export interface AgentBinaryDiscoveryStep {
  readonly source: 'env' | 'path' | 'fallback';
  readonly path: string;
  readonly exists: boolean;
  readonly note?: string;
}

export interface AgentHealthResponse {
  readonly claudeBinary: string | null;
  readonly mcpServerPath: string;
  readonly mcpServerExists: boolean;
  /** Discovery trace - list of paths tried, in order, with their
   *  existence status. Empty array on older backends; the banner
   *  falls back to generic copy when this is missing. */
  readonly claudeBinarySearchTrace: ReadonlyArray<AgentBinaryDiscoveryStep>;
}

export type AgentTurnErrorCode =
  | 'bad_request'
  | 'project_not_open'
  | 'claude_cli_not_installed'
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'aborted'
  /** Claude CLI isn't authenticated (or the cached token expired).
   *  The AgentPanel renders an actionable "Run `claude /login` in a
   *  terminal" banner instead of the generic exit message. */
  | 'not_logged_in'
  /** The --session-id is locked by a stale or concurrent claude
   *  process. Frontend offers a "Reset agent session" button. */
  | 'session_in_use';

export interface AgentTurnErrorResponse {
  readonly error: AgentTurnErrorCode;
  readonly message?: string;
  readonly stderr?: string;
}

export interface AgentResetResponse {
  readonly ok: true;
}

/**
 * Patch proposals - Phase AI-1.0.
 *
 * The agent doesn't mutate files directly. Instead it calls the
 * `propose_patch` MCP tool with a structured patch (a human-readable
 * description + a list of typed edits). The backend stores the
 * proposal in its PatchStore and broadcasts a `patch_proposed` WS
 * frame to the open AgentPanel. The user reviews + clicks Apply or
 * Reject; only then does the backend touch the project on disk via
 * existing patch-gen / op-log infrastructure.
 *
 * Edit kinds are an additive discriminated union - AI-1.0 ships
 * one kind (`replace_in_file`). Future kinds (binary-rom field
 * writes, structured map.json edits, etc.) layer in without
 * breaking the contract.
 */

export interface ReplaceInFileEdit {
  readonly kind: 'replace_in_file';
  /** Path relative to the project root (e.g. `data/maps/Route1/scripts.inc`).
   *  The backend rejects edits whose path escapes the project root. */
  readonly filePath: string;
  /** Exact text to find. Must appear EXACTLY once in the file (so the
   *  edit is unambiguous) - backends fail loud on zero or multiple
   *  matches. Whitespace + casing must match. */
  readonly before: string;
  /** Replacement text. Must differ from `before`. */
  readonly after: string;
  /** Optional inline note for the human reviewer (e.g.
   *  "fly menu label for Route 1"). */
  readonly note?: string;
}

/**
 * In-place Gen-3 text replacement inside a binary `.gba` ROM.
 *
 * Used by binary-rom targets (FireRed/Unbound/Radical Red etc.) where
 * user-facing strings live as encoded byte sequences rather than as
 * source-tree text. The engine already records `textFileOffset` on
 * every decoded dialogue script step, so the agent has the exact
 * offset of every string it might want to rename.
 *
 * v1 (AI-1.4a) supports SAME-LENGTH-OR-SHORTER replacements only:
 *   * decode `before` from `textOffset` (Gen-3 codec, terminator-aware)
 *   * validate the decoded text matches `before` exactly (whitespace
 *     + case-sensitive; unmappable chars decode to `?` so a misaligned
 *     offset produces obviously-garbage that the matcher rejects)
 *   * encode `after`; fail if encoded length + 1 (terminator) > the
 *     ORIGINAL byte length (decoder reads up to and including
 *     terminator at offset)
 *   * write encoded bytes in place, then a 0xFF terminator, then
 *     pad any remaining slot with 0xFF so the decoder stops cleanly
 *
 * Length-increasing edits (e.g. "Route 1" → "Electric Avenue") need
 * free-space allocation + pointer repointing - deferred to AI-1.4b.
 * Until then the agent must propose same-length-or-shorter renames
 * (e.g. "Route 1" → "Lane 17" - 7 chars each, works in place).
 */
export interface BinaryReplaceTextEdit {
  readonly kind: 'binary_replace_text';
  /** File offset (in bytes) inside the project's `.gba` ROM where the
   *  encoded string begins. The agent reads this from the engine's
   *  decoded scriptSteps[].params.textFileOffset field. */
  readonly textOffset: number;
  /** Expected decoded text at `textOffset`. Validation fails if the
   *  on-disk bytes don't decode to this exact string. */
  readonly before: string;
  /** New decoded text to write. Must encode (via Gen-3 codec) to a
   *  byte length that fits inside the original string's slot
   *  (encoded length + 1 ≤ slot byte length including terminator). */
  readonly after: string;
  /** Maximum bytes to read when validating `before`. Defaults to 256
   *  (Gen-3 dialogue rarely exceeds 250 chars). The decoder stops at
   *  the first 0xFF terminator regardless. */
  readonly maxBytes?: number;
  /** Explicit slot size in bytes (encoded string + terminator + any
   *  reserved padding the agent or reverseEdit wants preserved). When
   *  ABSENT, the applier walks bytes from `textOffset` to the first
   *  0xFF terminator (inclusive) and uses that as the slot. The
   *  applier ALWAYS records the resolved slotBytes in the reverseEdit
   *  so undo can restore a shorter-than-original string back to its
   *  original length without re-deriving from the now-padded buffer. */
  readonly slotBytes?: number;
  /** Optional human-readable note for the reviewer. */
  readonly note?: string;
}

/**
 * Write encoded Gen-3 text at an arbitrary file offset inside the .gba.
 *
 * Used by AI-1.4b's repointing pipeline: when a length-INCREASING
 * rename can't fit in its original slot, propose_rename allocates
 * free space via the engine's findFreeRomSpace primitive and emits
 * a BinaryWriteTextEdit at the free-space offset + a
 * BinaryRewritePointerEdit to update the pointer that referenced
 * the old slot.
 *
 * Two modes:
 *   - `before === ''`: free-space write. Applier validates the first
 *     slotBytes bytes at `offset` are all fill bytes (0xFF or 0x00).
 *     Use this when writing into newly-allocated space.
 *   - `before !== ''`: in-place write at a known string slot.
 *     Applier validates decoded(buffer, offset) === before. Reverse
 *     edits use this mode to restore an original string.
 */
export interface BinaryWriteTextEdit {
  readonly kind: 'binary_write_text';
  readonly offset: number;
  /** Empty string = free-space write; non-empty = in-place write at a
   *  known string slot. The applier picks the validation path. */
  readonly before: string;
  readonly after: string;
  /** Slot size in bytes. For free-space writes this is the size that
   *  was allocated (the applier validates these bytes are all fill).
   *  When omitted: for non-empty `before` walks to first terminator;
   *  for empty `before` defaults to encoded(after).length + 1. */
  readonly slotBytes?: number;
  /** When `before` is empty (free-space write), require the first
   *  slotBytes bytes at offset to be all 0xFF/0x00. Defaults true. */
  readonly requireFreeSlot?: boolean;
  readonly note?: string;
}

/**
 * Rewrite a 32-bit little-endian GBA pointer at a known offset.
 *
 * The applier reads 4 bytes at `pointerOffset` and validates that
 * they encode `beforeTargetOffset + 0x08000000` (the GBA ROM mirror
 * base). It then writes `afterTargetOffset + 0x08000000` in the same
 * little-endian shape. AI-1.4b uses this to repoint pointers that
 * referenced a too-small in-place text slot onto a newly-allocated
 * free-space slot.
 */
export interface BinaryRewritePointerEdit {
  readonly kind: 'binary_rewrite_pointer';
  /** File offset of the 32-bit LE pointer to rewrite. */
  readonly pointerOffset: number;
  /** Expected current target (file offset, not GBA mirror; applier
   *  applies the 0x08000000 mask before validating). */
  readonly beforeTargetOffset: number;
  /** New target (file offset; applier applies the mirror mask). */
  readonly afterTargetOffset: number;
  readonly note?: string;
}

/**
 * Write a span of raw bytes at a known offset inside the .gba.
 *
 * Used by AI-1.5b's cross-project species importer: structures like
 * the 28-byte species table row, the 30-byte evolution table row,
 * and the TM/HM compatibility bitfield are non-text binary blobs the
 * existing binary_replace_text / binary_write_text edits can't carry.
 * binary_write_bytes is the generic "fixed-length byte span" primitive
 * the higher-level import_species_from_library tool composes into a
 * patch proposal.
 *
 * Two modes (mirror BinaryWriteTextEdit):
 *   - `beforeBytes === ''`: free-space write. Applier validates the
 *     `afterBytes.length / 2` bytes at `offset` are all fill bytes
 *     (0xFF or 0x00). Use this when writing into newly-allocated
 *     space (e.g. appending to a relocated table).
 *   - `beforeBytes !== ''`: in-place write at a known struct slot.
 *     Applier validates buffer[offset..offset+expected.length] matches
 *     `beforeBytes` byte-for-byte. v1 requires `beforeBytes.length ===
 *     afterBytes.length` (same-size replace) - table-expansion variants
 *     can layer on later.
 *
 * Hex encoding: lowercase or uppercase, no `0x` prefix, no separators.
 * Even-length only. Empty `beforeBytes` is the free-space sentinel.
 */
export interface BinaryWriteBytesEdit {
  readonly kind: 'binary_write_bytes';
  readonly offset: number;
  /** Hex-encoded expected current bytes. Empty string = free-space
   *  mode (applier requires the slot to be fill bytes). */
  readonly beforeBytes: string;
  /** Hex-encoded bytes to write. Must be non-empty. */
  readonly afterBytes: string;
  /** When `beforeBytes` is empty (free-space write), require the slot
   *  to currently be all 0xFF/0x00. Defaults true. */
  readonly requireFreeSlot?: boolean;
  readonly note?: string;
}

export type AgentPatchEdit =
  | ReplaceInFileEdit
  | BinaryReplaceTextEdit
  | BinaryWriteTextEdit
  | BinaryRewritePointerEdit
  | BinaryWriteBytesEdit;

export type AgentPatchStatus = 'pending' | 'applied' | 'rejected';

export interface AgentPatchProposal {
  readonly id: string;
  readonly projectId: string;
  readonly description: string;
  readonly edits: ReadonlyArray<AgentPatchEdit>;
  readonly status: AgentPatchStatus;
  readonly createdAtUtc: string;
  readonly appliedAtUtc?: string;
  readonly rejectedAtUtc?: string;
}

/**
 * WebSocket protocol - Phase AI-0.4 (extended in AI-1.0 with
 * patch-lifecycle frames).
 *
 * Connection URL: `/api/agent/ws?projectId=<projectId>`.
 * Server emits one JSON message per WS frame. Messages are NDJSON-shaped
 * at the protocol level (one envelope per frame) so the frontend can
 * route by `kind` without parsing buffered chunks.
 *
 * Client → Server messages start a turn, abort an in-flight turn,
 * reset the session, or ping. Server → Client messages stream events
 * from the live `claude` subprocess plus turn-lifecycle markers and
 * patch-lifecycle markers.
 */
export type AgentWsClientMessage =
  | {
      readonly kind: 'turn_start';
      readonly prompt: string;
      /** AI-4.1 dev mode: when true the backend appends the dev-mode
       *  system prompt addendum telling the agent it may edit the
       *  editor's own source tree via the built-in Edit/Write/Bash
       *  tools. Default false (safe). */
      readonly devMode?: boolean;
    }
  | { readonly kind: 'turn_abort' }
  | { readonly kind: 'session_reset' }
  | { readonly kind: 'ping' };

export type AgentWsServerMessage =
  | { readonly kind: 'ready'; readonly sessionId: string; readonly turnCount: number }
  | { readonly kind: 'turn_started'; readonly sessionId: string; readonly turnIndex: number }
  | { readonly kind: 'turn_event'; readonly event: AgentTurnEvent }
  | {
      readonly kind: 'turn_done';
      readonly sessionId: string;
      readonly finalText: string;
      readonly durationMs: number;
      readonly turnCount: number;
    }
  | {
      readonly kind: 'turn_error';
      readonly code: AgentTurnErrorCode | 'already_running' | 'no_turn_in_flight' | 'malformed_message';
      readonly message?: string;
      readonly stderr?: string;
    }
  | { readonly kind: 'session_reset'; readonly sessionId: string }
  | { readonly kind: 'pong' }
  | { readonly kind: 'patch_proposed'; readonly proposal: AgentPatchProposal }
  | { readonly kind: 'patch_applied'; readonly proposalId: string }
  | { readonly kind: 'patch_rejected'; readonly proposalId: string };
