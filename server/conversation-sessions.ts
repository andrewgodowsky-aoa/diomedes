import type { EngineService } from './engines/service.js';
import type { TextRequest } from './engines/contract.js';
import type { AcpSessionEngine } from './engines/acp-session.js';
import {
  claudeSessionRunId,
  type ClaudeSessionRuns,
  type ClaudeSessionTurn,
  type ClaudeSessionTurnResult,
  type SessionCheckpointFacts,
} from './harness/claude-session-run.js';
import { codexSessionRunId } from './harness/codex-session-run.js';
import { opencodeSessionRunId } from './harness/opencode-session-run.js';
import { acpSessionRunId } from './harness/acp-session-run.js';
import type { ConversationDriver } from './interaction-service.js';
import type { ConversationRoute } from '../shared/engines.js';
import type { ModelApiRoute } from '../shared/model-api.js';

/** The conversation routes that run on an engine's own session: Claude Code and the kept-session engines. */
export type SessionRoute = Exclude<ConversationRoute, ModelApiRoute>;
/** The engine service as the kept sessions use it: each route's driver and its turn. */
export type KeptSessionEngines = Pick<
  EngineService,
  | 'nativeSessions'
  | 'claudeSession'
  | 'codexSessions'
  | 'codexSession'
  | 'opencodeSessions'
  | 'opencodeSession'
  | 'cursorSessions'
  | 'devinSessions'
  | 'acpSession'
>;
/**
 * What the conversation, the host and the thread's session view use of a session's driver. Each
 * of these methods is the same whatever checkpoint the engine saves, so every engine's
 * `ClaudeSessionRuns<C>` satisfies it without a cast.
 */
export type SessionDriver = ConversationDriver &
  Pick<ClaudeSessionRuns<SessionCheckpointFacts>, 'status' | 'get' | 'busy' | 'assertLive' | 'fenced' | 'evidence'>;
/** One session route: its contract, its runs and how a turn reaches it. */
export interface KeptSession {
  route: SessionRoute;
  /** The route contract its turns run under; the thread's controls come from it. */
  routeId: string;
  /** Every run this route's conversations own starts with this, and no other route's does. */
  runPrefix: string;
  runId(projectId: string, commandId: string): string;
  driver(engines: KeptSessionEngines): SessionDriver | undefined;
  turn(
    engines: KeptSessionEngines,
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    input: TextRequest,
    sourceRunId?: string,
    options?: { queued?: boolean },
  ): Promise<ClaudeSessionTurnResult>;
}

const acp = (engine: AcpSessionEngine): KeptSession => ({
  route: engine,
  routeId: `${engine}-session`,
  runPrefix: `${engine}-`,
  runId: acpSessionRunId(engine),
  driver: (engines) => (engine === 'cursor' ? engines.cursorSessions : engines.devinSessions),
  // ACP conversations take no steering (their contract has no steer command), so a queued
  // message is never passed; the driver refuses a second message while a turn runs.
  turn: (engines, mode, runId, input, sourceRunId) => engines.acpSession(engine, mode, runId, input, sourceRunId),
});

/**
 * The one place a conversation's session is chosen from. The host resolves a message to a route;
 * this says which driver owns its runs, how its runs are named and how a turn reaches it, so the
 * conversation, its Stop and the thread's session view can never disagree about an engine.
 */
export const KEPT_SESSIONS: Record<SessionRoute, KeptSession> = {
  'claude-code': {
    route: 'claude-code',
    routeId: 'claude-code-session',
    runPrefix: 'claude-',
    runId: claudeSessionRunId,
    driver: (engines) => engines.nativeSessions,
    turn: (engines, mode, runId, input, sourceRunId, options) =>
      engines.claudeSession(mode, runId, input, sourceRunId, options),
  },
  codex: {
    route: 'codex',
    routeId: 'codex-session',
    runPrefix: 'codex-session-',
    runId: codexSessionRunId,
    driver: (engines) => engines.codexSessions,
    turn: (engines, mode, runId, input, sourceRunId, options) =>
      engines.codexSession(mode, runId, input, sourceRunId, options),
  },
  opencode: {
    route: 'opencode',
    routeId: 'opencode-session',
    runPrefix: 'opencode-',
    runId: opencodeSessionRunId,
    driver: (engines) => engines.opencodeSessions,
    turn: (engines, mode, runId, input, sourceRunId, options) =>
      engines.opencodeSession(mode, runId, input, sourceRunId, options),
  },
  cursor: acp('cursor'),
  devin: acp('devin'),
};

/** The session a run belongs to, from its id; null for a model-API run or any other run. */
export function keptSessionOfRun(runId: string | null | undefined): KeptSession | null {
  if (!runId) return null;
  return Object.values(KEPT_SESSIONS).find((session) => runId.startsWith(session.runPrefix)) ?? null;
}
