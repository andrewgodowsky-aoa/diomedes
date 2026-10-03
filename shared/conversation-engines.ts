import { KEPT_SESSION_ROUTES, routeDisplayName, type EngineConnection } from './engines.js';
import type { IntegrationStatus } from './types.js';

/** The engines a conversation runs on when this computer has them: Claude Code, then the kept-session engines. */
export const CONVERSATION_ENGINES = ['claude-code', ...KEPT_SESSION_ROUTES] as const;
export type ConversationEngine = (typeof CONVERSATION_ENGINES)[number];

/**
 * Found (spec decision 5): installed, a supported version, signed in, a model list the engine
 * itself reported, no broken binding and no account on another route. The same facts AI setup
 * calls connected, whatever the freshness window says about how its status line reads.
 */
export function isFoundEngine(connection: EngineConnection | undefined): connection is EngineConnection {
  return (
    !!connection &&
    connection.installation === 'found' &&
    connection.compatibility === 'supported' &&
    connection.authentication === 'signed-in' &&
    connection.models.length > 0 &&
    !connection.repair &&
    !connection.routeIssue
  );
}

/**
 * Codex is found when Diomedes' own Codex runtime answered and a ChatGPT account is signed in
 * there: the status reads signed in only after the runtime started and reported a ChatGPT account.
 */
export function isChatGptFound(status: IntegrationStatus | undefined): boolean {
  return status?.id === 'codex' && status.found && status.signIn === 'signed-in';
}

/**
 * The engines a conversation may offer on this computer, in the order a person reads them. When
 * none is found, the only suggestion a conversation surface makes is the Nectovia plan.
 */
export function foundConversationEngines(input: {
  connections: readonly EngineConnection[];
  integrations: readonly IntegrationStatus[];
}): { engines: ConversationEngine[]; suggestPlan: boolean } {
  const engines = CONVERSATION_ENGINES.filter((engine) =>
    engine === 'codex'
      ? isChatGptFound(input.integrations.find((status) => status.id === 'codex'))
      : isFoundEngine(input.connections.find((connection) => connection.engine === engine)),
  );
  return { engines, suggestPlan: engines.length === 0 };
}

/** Why a conversation's own engine can't take a message, as a person can act on it. */
export type EngineGone = 'not-installed' | 'signed-out';
/** The refusals that mean the engine isn't found on this computer, by their code. */
export const ENGINE_GONE_CODES: Readonly<Record<string, EngineGone>> = {
  NOT_INSTALLED: 'not-installed',
  NATIVE_NOT_INSTALLED: 'not-installed',
  AUTH_REQUIRED: 'signed-out',
  CHATGPT_REQUIRED: 'signed-out',
};

/**
 * The refusal when a thread's engine is no longer found. It names the thread's own engine and
 * says nothing was sent. It never tells a person to install or choose any engine, and the thread
 * stays on its engine.
 */
export function engineGoneSentence(engine: string, gone: EngineGone): string {
  const state = gone === 'not-installed' ? "isn't installed" : "isn't signed in";
  return `${routeDisplayName(engine)} ${state} on this computer, so this conversation can't continue here. Nothing was sent.`;
}
