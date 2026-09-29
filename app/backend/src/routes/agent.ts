import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import type WebSocket from 'ws';
import type {
  AgentHealthResponse,
  AgentPatchEdit,
  AgentPatchProposal,
  AgentResetResponse,
  AgentTurnErrorResponse,
  AgentTurnEvent,
  AgentTurnRequest,
  AgentTurnResponse,
  AgentWsClientMessage,
  AgentWsServerMessage,
} from '@rom-editor/shared';
import { diagnoseClaudeBinary, findClaudeBinary } from '../agent/binary-discovery.js';
import { AgentSessionStore, type AgentSession } from '../agent/agent-session-store.js';
import { writeTempMcpConfig } from '../agent/mcp-config.js';
import { runAgentTurn, TurnError, type TurnResult } from '../agent/spawner.js';
import { PatchStore } from '../agent/patch-store.js';
import { applyEdits, PatchApplyError } from '../agent/patch-applier.js';
import { appendOpLogEntry } from '../events/op-log.js';
import type { ProjectSessionStore } from '../projects/session-store.js';

const HERE = fileURLToPath(import.meta.url);
// When compiled, HERE is .../dist/routes/agent.js → the MCP server is at
// .../dist/agent/mcp-server.js. When running under tsx, HERE is
// .../src/routes/agent.ts → mcp-server.ts and we invoke via tsx.
const IS_DEV = HERE.endsWith('.ts');
const MCP_SERVER_PATH = path.resolve(
  path.dirname(HERE),
  '..',
  'agent',
  IS_DEV ? 'mcp-server.ts' : 'mcp-server.js',
);

function mcpServerLauncher(): { command: string; args: ReadonlyArray<string> } {
  if (IS_DEV) {
    return { command: 'npx', args: ['tsx', MCP_SERVER_PATH] };
  }
  return { command: process.execPath, args: [MCP_SERVER_PATH] };
}

export interface AgentRouteOptions {
  readonly sessionStore: ProjectSessionStore;
  readonly agentSessionStore?: AgentSessionStore;
  readonly patchStore?: PatchStore;
  /** Base URL the spawned MCP server uses to call back into Fastify
   *  (e.g. propose_patch). Defaults to `http://127.0.0.1:${PORT}`. */
  readonly baseUrl?: string | (() => string);
  /** Test seam: lets a fake spawner replace the real runAgentTurn. */
  readonly runTurnImpl?: typeof runAgentTurn;
  /** Test seam: lets tests override the binary-discovery result. */
  readonly findClaudeImpl?: () => Promise<string | null>;
  /** AI-4.1 dev-mode: absolute path to the editor's repo root. Passed
   *  through to the spawner so dev-mode turns know where the editor
   *  source lives. Defaults to undefined (the spawner falls back to
   *  the boilerplate "use git rev-parse" instruction). */
  readonly repoRoot?: string;
}

interface ProposePatchBody {
  readonly projectRoot: string;
  readonly description: string;
  readonly edits: ReadonlyArray<AgentPatchEdit>;
}

interface ManagedTurnOpts {
  readonly prompt: string;
  readonly projectRoot: string;
  readonly agentSession: AgentSession;
  readonly claudeBinary: string;
  readonly runTurnImpl: typeof runAgentTurn;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentTurnEvent) => void;
  /** AI-4.1 dev-mode flag - propagated to the spawner so claude
   *  receives the dev-mode system-prompt addendum. */
  readonly devMode?: boolean;
}

interface ManagedTurnExtra {
  readonly baseUrl?: string;
  /** Optional override for the editor's repo root (passed into the
   *  dev-mode system prompt so the agent knows where the source lives).
   *  Defaults to two parents up from the backend dist (which puts the
   *  monorepo root at the right location). */
  readonly repoRoot?: string;
}

/** Stage the temp mcp-config, run the turn, always clean up. POST and
 *  WS both go through here so the spawn / config / cleanup invariants
 *  stay in one place. */
async function runManagedTurn(opts: ManagedTurnOpts & ManagedTurnExtra): Promise<TurnResult> {
  const launcher = mcpServerLauncher();
  const mcpConfig = await writeTempMcpConfig({
    projectRoot: opts.projectRoot,
    mcpServerCommand: launcher.command,
    mcpServerArgs: launcher.args,
    baseUrl: opts.baseUrl,
  });
  try {
    return await opts.runTurnImpl({
      prompt: opts.prompt,
      projectRoot: opts.projectRoot,
      claudeSessionId: opts.agentSession.claudeSessionId,
      claudeBinary: opts.claudeBinary,
      mcpConfigPath: mcpConfig.path,
      signal: opts.signal,
      onEvent: opts.onEvent,
      devMode: opts.devMode,
      repoRoot: opts.repoRoot,
      // First turn for this session id: create (--session-id).
      // Subsequent turns: resume (--resume). Passing --session-id twice
      // for the same UUID fails with "Session ID <uuid> is already in
      // use" - the bug the user hit when their first turn crashed on
      // "Not logged in".
      isResume: opts.agentSession.turnCount > 0,
    });
  } finally {
    await mcpConfig.cleanup();
  }
}

export async function registerAgentRoute(
  app: FastifyInstance,
  opts: AgentRouteOptions,
): Promise<void> {
  // NOTE: @fastify/websocket must be registered on the parent scope by
  // the caller (server.ts in prod; tests' buildApp helper otherwise).
  // Registering it here would encapsulate `injectWS` away from the
  // parent instance, which breaks app.inject + test harnesses.
  const agentStore = opts.agentSessionStore ?? new AgentSessionStore();
  const patchStore = opts.patchStore ?? new PatchStore();
  const runTurn = opts.runTurnImpl ?? runAgentTurn;
  const findClaude = opts.findClaudeImpl ?? findClaudeBinary;
  const getBaseUrl = () => (typeof opts.baseUrl === 'function' ? opts.baseUrl() : opts.baseUrl) ?? `http://127.0.0.1:${process.env.PORT ?? 8717}`;

  /** Live WS subscribers, indexed by projectId, used to broadcast
   *  out-of-band events (patch_proposed, patch_applied, …) to every
   *  open AgentPanel for that project. */
  const wsSubscribers = new Map<string, Set<WebSocket>>();

  function subscribeWs(projectId: string, socket: WebSocket): void {
    let set = wsSubscribers.get(projectId);
    if (!set) {
      set = new Set();
      wsSubscribers.set(projectId, set);
    }
    set.add(socket);
  }

  function unsubscribeWs(projectId: string, socket: WebSocket): void {
    const set = wsSubscribers.get(projectId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) wsSubscribers.delete(projectId);
  }

  function broadcastToProject(projectId: string, msg: AgentWsServerMessage): void {
    const set = wsSubscribers.get(projectId);
    if (!set) return;
    const payload = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.send(payload);
        } catch {
          // best-effort; bad sockets drop on next close
        }
      }
    }
  }

  /** Resolve a projectId from an absolute projectRoot. The MCP server
   *  only knows the root path (passed via ROM_EDITOR_PROJECT_ROOT) - it
   *  doesn't know which ProjectSession id Fastify minted for it. */
  function projectIdForRoot(projectRoot: string): string | null {
    for (const session of opts.sessionStore.list()) {
      if (session.projectRoot === projectRoot) return session.id;
    }
    return null;
  }

  app.get('/api/agent/health', async (): Promise<AgentHealthResponse> => {
    // Use diagnoseClaudeBinary directly so the response includes the
    // search trace - the AgentPanel banner renders this to tell the
    // user exactly which paths were tried + which exist. The
    // injectable test seam (`opts.findClaudeImpl`) only returns a
    // string-or-null, so when it's set we provide an empty trace.
    let claudeBinary: string | null;
    let claudeBinarySearchTrace: AgentHealthResponse['claudeBinarySearchTrace'] = [];
    if (opts.findClaudeImpl) {
      claudeBinary = await findClaude();
    } else {
      const result = await diagnoseClaudeBinary();
      claudeBinary = result.binary;
      claudeBinarySearchTrace = result.trace;
    }
    let mcpServerExists = false;
    try {
      await fsp.access(MCP_SERVER_PATH);
      mcpServerExists = true;
    } catch {
      mcpServerExists = false;
    }
    return {
      claudeBinary,
      mcpServerPath: MCP_SERVER_PATH,
      mcpServerExists,
      claudeBinarySearchTrace,
    };
  });

  app.post<{ Body: AgentTurnRequest }>('/api/agent/turn', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body.prompt !== 'string' || typeof body.projectId !== 'string' || body.prompt.length === 0) {
      const err: AgentTurnErrorResponse = { error: 'bad_request', message: 'prompt and projectId are required.' };
      return reply.status(400).send(err);
    }

    const projectSession = opts.sessionStore.get(body.projectId);
    if (!projectSession) {
      const err: AgentTurnErrorResponse = { error: 'project_not_open', message: `No open project with id '${body.projectId}'.` };
      return reply.status(404).send(err);
    }

    const claudeBinary = await findClaude();
    if (!claudeBinary) {
      const err: AgentTurnErrorResponse = {
        error: 'claude_cli_not_installed',
        message:
          'Could not locate the `claude` CLI on this machine. Install Claude Code or set CLAUDE_CLI_PATH.',
      };
      return reply.status(503).send(err);
    }

    const agentSession = agentStore.getOrCreate(body.projectId, projectSession.projectRoot);

    try {
      let turn: TurnResult;
      try {
        turn = await runManagedTurn({
          prompt: body.prompt,
          projectRoot: projectSession.projectRoot,
          agentSession,
          claudeBinary,
          runTurnImpl: runTurn,
          baseUrl: getBaseUrl(),
        });
      } finally {
        // Mark the turn as ATTEMPTED (not "succeeded") so isResume=true
        // on the next try. Without this, a failed first turn (e.g.
        // "not logged in") leaves turnCount=0; the retry passes
        // --session-id for the same UUID claude already created →
        // "Session ID is already in use". Marking on attempt makes
        // the retry pass --resume and bypass that lock.
        agentStore.markTurn(body.projectId);
      }
      const response: AgentTurnResponse = {
        sessionId: agentSession.claudeSessionId,
        turnCount: agentSession.turnCount,
        events: turn.events,
        finalText: turn.finalText,
        durationMs: turn.durationMs,
      };
      return reply.send(response);
    } catch (e) {
      if (e instanceof TurnError) {
        const err: AgentTurnErrorResponse = { error: e.code, message: e.message, stderr: e.stderr };
        return reply.status(500).send(err);
      }
      throw e;
    }
  });

  app.post<{ Params: { projectId: string } }>(
    '/api/agent/sessions/:projectId/reset',
    async (req, reply) => {
      agentStore.reset(req.params.projectId);
      const response: AgentResetResponse = { ok: true };
      return reply.send(response);
    },
  );

  // List pending proposals for a project - frontend uses this on
  // reconnect to recover any proposals that arrived before the WS
  // subscription was active.
  app.get<{ Params: { projectId: string } }>(
    '/api/agent/projects/:projectId/patches',
    async (req, reply) => {
      const session = opts.sessionStore.get(req.params.projectId);
      if (!session) {
        return reply.status(404).send({ error: 'project_not_open' });
      }
      return reply.send({
        proposals: patchStore.listByProject(req.params.projectId),
      });
    },
  );

  // Internal route - used by the spawned MCP server's `propose_patch`
  // tool to register a proposal. Loopback-only (127.0.0.1 by default,
  // matching the rest of the backend). Resolves projectRoot →
  // projectId via the existing ProjectSessionStore.
  app.post<{ Body: ProposePatchBody }>(
    '/api/agent/internal/patches',
    async (req, reply) => {
      const body = req.body;
      if (
        !body ||
        typeof body.projectRoot !== 'string' ||
        typeof body.description !== 'string' ||
        !Array.isArray(body.edits) ||
        body.edits.length === 0
      ) {
        return reply.status(400).send({ error: 'bad_request' });
      }

      const projectId = projectIdForRoot(body.projectRoot);
      if (!projectId) {
        return reply.status(404).send({
          error: 'project_not_open',
          message: `No open project at '${body.projectRoot}'.`,
        });
      }

      // Defense in depth: validate every edit before storing the
      // proposal. Actual fs/ROM writes don't happen until apply, but
      // failing fast gives the agent immediate feedback.
      for (const edit of body.edits) {
        if (edit.kind === 'replace_in_file') {
          if (typeof edit.filePath !== 'string' || edit.filePath.length === 0) {
            return reply.status(400).send({ error: 'bad_edit_path' });
          }
          if (path.posix.isAbsolute(edit.filePath) || path.win32.isAbsolute(edit.filePath) || edit.filePath.includes('..')) {
            return reply.status(400).send({
              error: 'unsafe_edit_path',
              message: `Edit path '${edit.filePath}' must be relative to projectRoot and may not contain '..'.`,
            });
          }
          if (typeof edit.before !== 'string' || edit.before.length === 0) {
            return reply.status(400).send({ error: 'bad_edit_before' });
          }
          if (typeof edit.after !== 'string') {
            return reply.status(400).send({ error: 'bad_edit_after' });
          }
          if (edit.before === edit.after) {
            return reply.status(400).send({
              error: 'noop_edit',
              message: `Edit on '${edit.filePath}' has identical before/after text.`,
            });
          }
          continue;
        }
        if (edit.kind === 'binary_replace_text') {
          if (typeof edit.textOffset !== 'number' || !Number.isInteger(edit.textOffset) || edit.textOffset < 0) {
            return reply.status(400).send({ error: 'bad_edit_offset' });
          }
          if (typeof edit.before !== 'string' || edit.before.length === 0) {
            return reply.status(400).send({ error: 'bad_edit_before' });
          }
          if (typeof edit.after !== 'string') {
            return reply.status(400).send({ error: 'bad_edit_after' });
          }
          if (edit.before === edit.after) {
            return reply.status(400).send({
              error: 'noop_edit',
              message: `Binary edit at offset 0x${edit.textOffset.toString(16)} has identical before/after text.`,
            });
          }
          continue;
        }
        if (edit.kind === 'binary_write_text') {
          if (typeof edit.offset !== 'number' || !Number.isInteger(edit.offset) || edit.offset < 0) {
            return reply.status(400).send({ error: 'bad_edit_offset' });
          }
          if (typeof edit.before !== 'string') {
            return reply.status(400).send({ error: 'bad_edit_before' });
          }
          if (typeof edit.after !== 'string') {
            return reply.status(400).send({ error: 'bad_edit_after' });
          }
          if (edit.before === edit.after && edit.before !== '') {
            return reply.status(400).send({
              error: 'noop_edit',
              message: `binary_write_text at 0x${edit.offset.toString(16)} has identical before/after text.`,
            });
          }
          continue;
        }
        if (edit.kind === 'binary_rewrite_pointer') {
          if (typeof edit.pointerOffset !== 'number' || edit.pointerOffset < 0) {
            return reply.status(400).send({ error: 'bad_pointer_offset' });
          }
          if (typeof edit.beforeTargetOffset !== 'number' || edit.beforeTargetOffset < 0) {
            return reply.status(400).send({ error: 'bad_before_target' });
          }
          if (typeof edit.afterTargetOffset !== 'number' || edit.afterTargetOffset < 0) {
            return reply.status(400).send({ error: 'bad_after_target' });
          }
          if (edit.beforeTargetOffset === edit.afterTargetOffset) {
            return reply.status(400).send({
              error: 'noop_edit',
              message: `binary_rewrite_pointer at 0x${edit.pointerOffset.toString(16)} has identical before/after target.`,
            });
          }
          continue;
        }
        if (edit.kind === 'binary_write_bytes') {
          if (typeof edit.offset !== 'number' || !Number.isInteger(edit.offset) || edit.offset < 0) {
            return reply.status(400).send({ error: 'bad_edit_offset' });
          }
          if (typeof edit.beforeBytes !== 'string' || !/^[0-9a-fA-F]*$/.test(edit.beforeBytes)) {
            return reply.status(400).send({ error: 'bad_before_bytes' });
          }
          if (
            typeof edit.afterBytes !== 'string' ||
            edit.afterBytes.length === 0 ||
            !/^[0-9a-fA-F]+$/.test(edit.afterBytes)
          ) {
            return reply.status(400).send({ error: 'bad_after_bytes' });
          }
          if (edit.afterBytes.length % 2 !== 0 || edit.beforeBytes.length % 2 !== 0) {
            return reply.status(400).send({ error: 'odd_hex_length' });
          }
          if (edit.beforeBytes !== '' && edit.beforeBytes.length !== edit.afterBytes.length) {
            return reply.status(400).send({
              error: 'length_mismatch',
              message: `beforeBytes is ${edit.beforeBytes.length / 2} bytes; afterBytes is ${edit.afterBytes.length / 2} bytes. v1 requires equal length.`,
            });
          }
          if (edit.beforeBytes.toLowerCase() === edit.afterBytes.toLowerCase()) {
            return reply.status(400).send({
              error: 'noop_edit',
              message: `binary_write_bytes at 0x${edit.offset.toString(16)} has identical before/after bytes.`,
            });
          }
          continue;
        }
        return reply.status(400).send({ error: 'unknown_edit_kind' });
      }

      const proposal = patchStore.create({
        projectId,
        description: body.description,
        edits: body.edits,
      });
      broadcastToProject(projectId, { kind: 'patch_proposed', proposal });
      return reply.send(proposal satisfies AgentPatchProposal);
    },
  );

  // Apply a pending proposal: walk its edits, write them to disk under
  // projectRoot, log the inverse to the op-log for undo, mark the
  // proposal applied, and broadcast `patch_applied` to WS subscribers.
  app.post<{ Params: { proposalId: string } }>(
    '/api/agent/patches/:proposalId/apply',
    async (req, reply) => {
      const proposal = patchStore.get(req.params.proposalId);
      if (!proposal) {
        return reply.status(404).send({ error: 'proposal_not_found' });
      }
      if (proposal.status !== 'pending') {
        return reply.status(409).send({
          error: 'proposal_not_pending',
          status: proposal.status,
          message: `Proposal is already '${proposal.status}'.`,
        });
      }
      const session = opts.sessionStore.get(proposal.projectId);
      if (!session) {
        return reply.status(404).send({ error: 'project_not_open' });
      }

      let result;
      try {
        result = await applyEdits(session.projectRoot, proposal.edits);
      } catch (e) {
        if (e instanceof PatchApplyError) {
          return reply.status(400).send({
            error: e.code,
            message: e.message,
            editIndex: e.editIndex,
            filePath: e.filePath,
          });
        }
        throw e;
      }

      await appendOpLogEntry({
        projectRoot: session.projectRoot,
        sessionId: session.id,
        op: 'agent_patch_apply',
        payload: {
          proposalId: proposal.id,
          description: proposal.description,
          edits: proposal.edits,
          reverseEdits: result.reverseEdits,
        },
      });

      const applied = patchStore.setStatus(proposal.id, 'applied');
      broadcastToProject(proposal.projectId, {
        kind: 'patch_applied',
        proposalId: proposal.id,
      });
      return reply.send(applied);
    },
  );

  // Reject a pending proposal: flip status to 'rejected' and broadcast.
  // No disk changes. Terminal-status proposals return 409.
  app.post<{ Params: { proposalId: string } }>(
    '/api/agent/patches/:proposalId/reject',
    async (req, reply) => {
      const proposal = patchStore.get(req.params.proposalId);
      if (!proposal) {
        return reply.status(404).send({ error: 'proposal_not_found' });
      }
      if (proposal.status !== 'pending') {
        return reply.status(409).send({
          error: 'proposal_not_pending',
          status: proposal.status,
          message: `Proposal is already '${proposal.status}'.`,
        });
      }
      const rejected = patchStore.setStatus(proposal.id, 'rejected');
      broadcastToProject(proposal.projectId, {
        kind: 'patch_rejected',
        proposalId: proposal.id,
      });
      return reply.send(rejected);
    },
  );

  app.get<{ Querystring: { projectId?: string } }>(
    '/api/agent/ws',
    { websocket: true },
    (socket: WebSocket, request) => {
      const send = (msg: AgentWsServerMessage): void => {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(JSON.stringify(msg));
        }
      };

      const rawProjectId = request.query?.projectId;
      if (!rawProjectId || typeof rawProjectId !== 'string') {
        send({ kind: 'turn_error', code: 'malformed_message', message: 'projectId query param is required.' });
        socket.close(1008, 'projectId required');
        return;
      }
      const projectSession = opts.sessionStore.get(rawProjectId);
      if (!projectSession) {
        send({ kind: 'turn_error', code: 'malformed_message', message: `No open project with id '${rawProjectId}'.` });
        socket.close(1008, 'project not open');
        return;
      }

      // Re-bind narrowed values so the async closure below sees `string` /
      // `ProjectSession` instead of widened `string | undefined`.
      const projectId: string = rawProjectId;
      const validatedSession = projectSession;

      let agentSession = agentStore.getOrCreate(projectId, validatedSession.projectRoot);
      // Register this WS connection so broadcasts (e.g. patch_proposed)
      // reach every open AgentPanel for this project.
      subscribeWs(projectId, socket);
      // Defer the initial 'ready' frame to the next macrotask so the
      // client has a chance to attach its 'message' listener after the
      // WebSocket constructor resolves. Without this, in-process test
      // clients (and tight synchronous client code) can miss it.
      setImmediate(() => {
        send({ kind: 'ready', sessionId: agentSession.claudeSessionId, turnCount: agentSession.turnCount });
      });

      let inflight: { abort: AbortController } | null = null;

      socket.on('message', (raw: WebSocket.RawData) => {
        void handleClientMessage(raw);
      });

      socket.on('close', () => {
        unsubscribeWs(projectId, socket);
        if (inflight) inflight.abort.abort();
      });

      async function handleClientMessage(raw: WebSocket.RawData): Promise<void> {
        let parsed: AgentWsClientMessage;
        try {
          parsed = JSON.parse(raw.toString()) as AgentWsClientMessage;
        } catch {
          send({ kind: 'turn_error', code: 'malformed_message', message: 'WS frame was not valid JSON.' });
          return;
        }

        switch (parsed.kind) {
          case 'ping':
            send({ kind: 'pong' });
            return;

          case 'session_reset':
            agentStore.reset(projectId);
            agentSession = agentStore.getOrCreate(projectId, validatedSession.projectRoot);
            send({ kind: 'session_reset', sessionId: agentSession.claudeSessionId });
            return;

          case 'turn_abort':
            if (!inflight) {
              send({ kind: 'turn_error', code: 'no_turn_in_flight' });
              return;
            }
            inflight.abort.abort();
            return;

          case 'turn_start': {
            if (typeof parsed.prompt !== 'string' || parsed.prompt.length === 0) {
              send({ kind: 'turn_error', code: 'malformed_message', message: 'turn_start requires a non-empty prompt.' });
              return;
            }
            if (inflight) {
              send({ kind: 'turn_error', code: 'already_running' });
              return;
            }
            const claudeBinary = await findClaude();
            if (!claudeBinary) {
              send({
                kind: 'turn_error',
                code: 'claude_cli_not_installed',
                message: 'Could not locate the `claude` CLI on this machine.',
              });
              return;
            }
            const abort = new AbortController();
            inflight = { abort };
            const turnIndex = agentSession.turnCount + 1;
            send({ kind: 'turn_started', sessionId: agentSession.claudeSessionId, turnIndex });
            try {
              let result: TurnResult;
              try {
                result = await runManagedTurn({
                  prompt: parsed.prompt,
                  projectRoot: validatedSession.projectRoot,
                  agentSession,
                  claudeBinary,
                  runTurnImpl: runTurn,
                  signal: abort.signal,
                  onEvent: (event) => send({ kind: 'turn_event', event }),
                  baseUrl: getBaseUrl(),
                  devMode: parsed.devMode === true,
                  repoRoot: opts.repoRoot,
                });
              } finally {
                // Mark on attempt (not success) - see POST handler for
                // the rationale. Without this, a failed first turn
                // leaves turnCount=0 + a stale claude session lock,
                // and every retry fails with "Session ID is already
                // in use".
                agentStore.markTurn(projectId);
              }
              send({
                kind: 'turn_done',
                sessionId: agentSession.claudeSessionId,
                finalText: result.finalText,
                durationMs: result.durationMs,
                turnCount: agentSession.turnCount,
              });
            } catch (e) {
              if (e instanceof TurnError) {
                send({ kind: 'turn_error', code: e.code, message: e.message, stderr: e.stderr });
              } else {
                send({
                  kind: 'turn_error',
                  code: 'spawn_failed',
                  message: (e as Error).message,
                });
              }
            } finally {
              inflight = null;
            }
            return;
          }

          default:
            send({
              kind: 'turn_error',
              code: 'malformed_message',
              message: `Unknown client message kind '${(parsed as { kind?: unknown }).kind ?? ''}'.`,
            });
        }
      }
    },
  );
}
