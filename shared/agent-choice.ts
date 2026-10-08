/**
 * A thread's Agent box (DIO-292): what it holds, the control an Automatic proposal is held to,
 * and how a send records the kind it ran as. The host and the Console read a thread through
 * these same functions, so the two never disagree about who a thread's agent is.
 */
import { AGENT_CATALOG, AUTO_AGENT, DEFAULT_AGENT, runKindOf } from './agents.js';
import type { ConversationMode } from './conversation.js';
import { isKeptSessionRoute, type KeptSessionRoute } from './engines.js';
import { isModelApiRoute, type ModelApiRoute } from './model-api.js';
import type { Conversation, Mode } from './types.js';

/** The internal worker loops use. A thread that picked it before it left the menu reads as Auto. */
export const GENERAL_AGENT = 'diomedes.general';

type ThreadChoice = Pick<Conversation, 'mode' | 'requested'>;
type Requested = Conversation['requested'];

/**
 * What a thread's Agent box holds: `auto` or an Agent id. A thread saved before agents carried
 * the limits has no Agent, so its stored mode reads as that kind's default Agent and it keeps
 * behaving as it did. A profile thread reads as Auto here; the host resolves a profile's own
 * Agent when it picks (`POST .../agent-pick`).
 */
export function agentChoiceOf(thread: ThreadChoice): string {
  if (thread.requested?.profile) return AUTO_AGENT;
  const chosen = thread.requested?.agent?.trim();
  if (chosen) return chosen === GENERAL_AGENT ? AUTO_AGENT : chosen;
  return thread.mode === 'auto' ? AUTO_AGENT : DEFAULT_AGENT[thread.mode];
}

/**
 * The control a pending Automatic proposal is held to: the Agent box, never the kind Auto
 * picked for the last message. Auto keeps Automatic. A chosen Agent holds its own kind, mapped
 * as the mode control always was (Plan to plan-only, Ask, Build and Fix to answer-only).
 */
export function controlOf(thread: ThreadChoice): ConversationMode {
  const box = agentChoiceOf(thread);
  if (box === AUTO_AGENT) return 'auto';
  // A built-in's kind is the catalog's; an added Agent's is the kind the thread stored for it.
  const listed = AGENT_CATALOG.find((item) => item.id === box);
  const kind = listed ? runKindOf(listed) : thread.mode;
  return kind === 'plan' ? 'plan' : kind === 'auto' ? 'auto' : 'ask';
}

/** A route change drops the model pick, which belonged to the old route, and keeps the Agent. */
export function keepAgentOnly(requested: Requested): Requested {
  const agent = requested?.agent?.trim();
  return agent ? { model: null, effort: null, agent } : null;
}

/**
 * The thread's picks without its Agent, for a mode an API caller names: the thread then reads as
 * that mode's default Agent, as a mode always did. A profile stands alone and is left as it is.
 */
export function withoutAgent(requested: Requested): Requested {
  if (!requested || requested.profile || !requested.agent) return requested ?? null;
  return requested.model ? { model: requested.model, effort: requested.effort } : null;
}

/**
 * Records the kind a send ran as on its thread, where that kind is the thread's own choice: a
 * thread with no Agent of its own reads its stored kind as that kind's default Agent, so it follows
 * its sends, as a mode always did. Auto stays Auto whatever it picks for a message, and a chosen
 * Agent or profile keeps its own kind. The stored kind of an Auto thread never moves, since an
 * Automatic kind is what marks a project's own Diomedes conversation.
 */
export function recordRunKind(thread: Conversation, mode: Mode): void {
  if (thread.mode === 'auto' || thread.requested?.agent?.trim() || thread.requested?.profile) return;
  thread.mode = mode;
}

/**
 * Whether a project thread's Ask, Plan or Automatic message on this route answers in the
 * conversation: a model-API route or an engine that keeps its own session. Claude Code project
 * threads take the direct request path, which has no Automatic (O38).
 */
export const throughConversation = (route: string): route is ModelApiRoute | KeptSessionRoute =>
  isModelApiRoute(route) || isKeptSessionRoute(route);

/** What `POST /api/projects/:id/threads/:threadId/agent-pick` answers for one message. */
export interface AgentPickView {
  /** `id: 'auto'` when Auto answers the message itself. */
  agent: { id: string; name: string };
  /** The kind of run the message takes. */
  mode: Mode;
  by: 'chosen' | 'profile' | 'rule' | 'jev' | 'default';
  /** The route the message would take now. */
  route: string;
  /** The host's sentence when the message would be refused before anything is sent. */
  refusal: string | null;
}
