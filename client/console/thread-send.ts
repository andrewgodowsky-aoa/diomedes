import { api, readDocument } from '../api';
import {
  interruptMessage,
  sendMessage,
  type DispatchIdentity,
} from '../conversation-send';
import { isRoute } from '../../shared/engines';
import { isModelApiRoute, MODEL_API_NAMES, type ModelApiRoute } from '../../shared/model-api';
import type { ConversationMode, MessageResult } from '../../shared/conversation';
import type { Conversation, Mode, Route } from '../../shared/types';
import type { ReadAccess } from '../../shared/read-access';

/**
 * Which path one project-thread message takes, decided from the host's own answer.
 *
 * A thread's next request runs on the route the host resolves for it: the owner's tier map
 * when a tier applies, else the route the thread is recorded on. Ask, Plan and Automatic on a
 * model-API route answer through the conversation (`conversation-send.ts`), which holds that
 * route's lineage, read tools and tool activity; the direct request path refuses them there.
 * Build and Fix, and every other route, keep the direct request path.
 */

/** What `GET /projects/:id/threads/:threadId/work-style` says about the route, and nothing more. */
export interface ThreadRouteView {
  /** The route the host would send the next request on. */
  route: string;
  /** The host's sentence when the next request would be refused before anything is sent. */
  refusal: string | null;
}

export type ThreadSendPlan =
  | { kind: 'refuse'; reason: string }
  | { kind: 'conversation'; route: ModelApiRoute; mode: ConversationMode }
  | { kind: 'direct'; route: Route };

const conversationMode = (mode: Mode): ConversationMode | null =>
  mode === 'ask' || mode === 'plan' || mode === 'auto' ? mode : null;

/** Reads the route the host resolves for this thread now. A failed read sends nothing. */
export async function readThreadRoute(
  projectId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadRouteView> {
  const view = await api<{ route?: unknown; refusal?: unknown }>(
    `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/work-style`,
    'GET',
    undefined,
    signal,
  );
  if (typeof view?.route !== 'string' || !view.route)
    throw new Error('Nectovia could not tell which route this thread uses. Nothing was sent.');
  return {
    route: view.route,
    refusal: typeof view.refusal === 'string' && view.refusal ? view.refusal : null,
  };
}

/**
 * The path for one message. Pure. The host's refusal is said in its own words; nothing is
 * moved to another route.
 */
export function planThreadSend(view: ThreadRouteView, mode: Mode, skill?: string): ThreadSendPlan {
  if (view.refusal) return { kind: 'refuse', reason: view.refusal };
  const conversational = conversationMode(mode);
  if (isModelApiRoute(view.route) && conversational) {
    // The conversation takes no playbook, and dropping one silently would send a different
    // request from the one the person composed.
    if (skill)
      return {
        kind: 'refuse',
        reason: `Playbooks do not run in ${MODEL_API_NAMES[view.route]} conversations yet. Remove the playbook to send this message.`,
      };
    return { kind: 'conversation', route: view.route, mode: conversational };
  }
  if (!isRoute(view.route))
    return { kind: 'refuse', reason: `${view.route} is not available in this build. Nothing was sent.` };
  return { kind: 'direct', route: view.route };
}

/** The direct request's body, exactly as the thread composer has always sent it. */
export function directAskBody(input: {
  thread: Pick<Conversation, 'id' | 'attachedTo'>;
  mode: Mode;
  text: string;
  route: Route;
  failing?: { document?: string; text?: string };
  sources?: string[];
  skill?: string;
  readAccess?: ReadAccess;
}) {
  return {
    mode: input.mode,
    text: input.text,
    route: input.route,
    consent: true as const,
    threadId: input.thread.id,
    attachedTo: input.thread.attachedTo,
    ...(input.sources ? { sources: input.sources } : {}),
    ...(input.mode === 'fix' && input.failing ? { failing: input.failing } : {}),
    ...(input.skill ? { skill: input.skill } : {}),
    // Sent only when the person chose it for this message; absent means the selection.
    ...(input.readAccess === 'project' ? { readAccess: input.readAccess } : {}),
  };
}

/**
 * The documents the person's message selected, each with the version it was read at. Exactly
 * the prepared list: nothing is added, so the scope sent is never wider than what was chosen.
 * The host reads each again and refuses one that changed in between.
 */
export async function conversationSources(
  projectId: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<{ path: string; sha: string }[]> {
  const unique = [...new Set(paths)];
  return Promise.all(
    unique.map(async (path) => ({ path, sha: (await readDocument(projectId, path, signal)).sha })),
  );
}

/** One Ask, Plan or Automatic message on a model-API thread, through the conversation. */
export async function sendThreadConversation(input: {
  projectId: string;
  threadId: string;
  text: string;
  mode: ConversationMode;
  paths: readonly string[];
  signal?: AbortSignal;
  onClaim?: (identity: DispatchIdentity) => void;
}): Promise<MessageResult> {
  const sources = await conversationSources(input.projectId, input.paths, input.signal);
  return sendMessage(
    input.projectId,
    input.threadId,
    { text: input.text, mode: input.mode, sources },
    input.signal,
    input.onClaim,
  );
}

/**
 * The person's Stop for a conversation message. With the command issued, the host is asked to
 * interrupt that one command, and the send stays open so it returns the recorded, interrupted
 * turn and settles the pending message. Only when the host cannot confirm the stop, or nothing
 * was issued yet, is this window's request abandoned; the message then stays unconfirmed and
 * sending it again reads what the record says.
 */
export async function stopThreadMessage(
  issued: DispatchIdentity | null,
  abandon: () => void,
): Promise<'interrupted' | 'abandoned'> {
  if (issued) {
    try {
      const ack = await interruptMessage(issued.projectId, issued.threadId, issued.commandId);
      if (ack.state === 'requested' || ack.state === 'settled') return 'interrupted';
    } catch {
      // Not confirmed; the request is abandoned below.
    }
  }
  abandon();
  return 'abandoned';
}
