import type { CloudSharingPolicy, CloudSharingUpgrade, ProjectState, Route } from '../shared/types.js';
import { isConversationRoute, ROUTES } from '../shared/engines.js';
import { ApiError, relativeName } from './paths.js';

const empty = (): CloudSharingPolicy => ({
  version: 0,
  routes: [],
  documents: [],
  shareConversationHistory: false,
  shareReviewPackets: false,
});

const cloudRoute = (value: unknown): value is Exclude<Route, 'sample'> =>
  typeof value === 'string' && value !== 'sample' && (ROUTES as readonly string[]).includes(value);

/** A damaged or older state never grants outbound authority. */
export function cloudSharing(state: ProjectState): CloudSharingPolicy {
  const policy = state.cloudSharing;
  if (!policy) return empty();
  try {
    if (
      !Number.isSafeInteger(policy.version) || policy.version < 1 ||
      !Array.isArray(policy.routes) || !Array.isArray(policy.documents) ||
      typeof policy.shareConversationHistory !== 'boolean' ||
      typeof policy.shareReviewPackets !== 'boolean' ||
      policy.routes.length > ROUTES.length || policy.documents.length > 1000 ||
      !policy.routes.every(cloudRoute) ||
      !policy.documents.every((name) => typeof name === 'string' && relativeName(name) === name)
    ) return empty();
  } catch {
    return empty();
  }
  const upgrade = upgradeRecord(policy.upgrade);
  return {
    version: policy.version,
    routes: [...new Set(policy.routes)],
    documents: [...new Set(policy.documents)],
    shareConversationHistory: policy.shareConversationHistory,
    shareReviewPackets: policy.shareReviewPackets,
    ...(upgrade ? { upgrade } : {}),
  };
}

/** The upgrade's provenance record, or nothing when it is damaged. It never grants anything. */
function upgradeRecord(value: unknown): CloudSharingUpgrade | undefined {
  const record = value as Partial<CloudSharingUpgrade> | null | undefined;
  try {
    if (
      !record || typeof record !== 'object' || typeof record.at !== 'string' ||
      record.from !== 'recorded-history' || typeof record.shareConversationHistory !== 'boolean' ||
      !Array.isArray(record.routes) || !record.routes.every(cloudRoute) ||
      !Array.isArray(record.documents) || record.documents.length > 1000 ||
      !record.documents.every((name) => typeof name === 'string' && relativeName(name) === name)
    ) return undefined;
  } catch {
    return undefined;
  }
  return {
    at: record.at,
    from: 'recorded-history',
    routes: [...record.routes],
    documents: [...record.documents],
    shareConversationHistory: record.shareConversationHistory,
  };
}

export function changeCloudSharing(state: ProjectState, input: Record<string, unknown>): CloudSharingPolicy {
  const current = cloudSharing(state);
  if (input.expectedVersion !== current.version)
    throw new ApiError(409, 'Cloud sharing changed. Reload it before saving.', { code: 'cloud_sharing_conflict' });
  const routes = input.routes;
  const documents = input.documents;
  if (
    !Array.isArray(routes) || routes.length > ROUTES.length || !routes.every(cloudRoute) ||
    !Array.isArray(documents) || documents.length > 1000 ||
    typeof input.shareConversationHistory !== 'boolean' ||
    typeof input.shareReviewPackets !== 'boolean'
  ) throw new ApiError(400, 'Choose valid cloud routes, documents, and history sharing.');
  const names = documents.map(relativeName);
  if (new Set(names).size !== names.length)
    throw new ApiError(400, 'Choose each document once.');
  const updated: CloudSharingPolicy = {
    version: current.version + 1,
    routes: [...new Set(routes)] as Exclude<Route, 'sample'>[],
    documents: names,
    shareConversationHistory: input.shareConversationHistory,
    shareReviewPackets: input.shareReviewPackets,
    ...(current.upgrade ? { upgrade: current.upgrade } : {}),
  };
  state.cloudSharing = updated;
  return updated;
}

/** Holding lines a Work turn shows before its run has produced anything. */
const HOLDING_LINE = /^(Preparing a proposal\b|Picked up a message from the team\.$)/;

/**
 * The one-time upgrade for a project that has no sharing record yet (owner decision,
 * 2026-09-23): a project that already sent to a route before default-deny sharing keeps that
 * route. Everything else stays default-deny.
 *
 * It reads only recorded turns: a person's turn on a cloud route counts when the next turn is
 * that route's answer, and not a Work holding line (a Work turn's text becomes its proposal
 * summary only when its run produced one). A turn with no recorded route counts for nothing.
 *
 * One policy serves every route, so the upgrade can only narrow: it keeps a document only when
 * every kept route received it, and history only when every kept route had an earlier turn
 * sent (two answered turns in one thread). Review packets stay off.
 *
 * It runs once. A project with a record is never upgraded again, so an owner's later change
 * stands; a project with nothing to keep gets no record and stays default-deny, and since no
 * cloud send can happen without a record, it can never acquire history to upgrade from later.
 * Home is never upgraded: its typed messages need no grant, and its history stays gated.
 */
export function upgradeCloudSharing(state: ProjectState, at: string, home: boolean): boolean {
  if (state.cloudSharing !== undefined || home) return false;
  const received = new Map<Exclude<Route, 'sample'>, { documents: Set<string>; history: boolean }>();
  for (const conversation of state.conversations ?? []) {
    const answered = new Map<string, number>();
    const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
    for (let index = 0; index + 1 < turns.length; index += 1) {
      const mine = turns[index];
      const answer = turns[index + 1];
      if (mine?.role !== 'you' || !cloudRoute(mine.route)) continue;
      if (answer?.role !== 'assistant' || answer.route !== mine.route) continue;
      if (typeof answer.text !== 'string' || HOLDING_LINE.test(answer.text.trim())) continue;
      const route = mine.route;
      const entry = received.get(route) ?? { documents: new Set<string>(), history: false };
      for (const source of Array.isArray(mine.sources) ? mine.sources : []) {
        try {
          entry.documents.add(relativeName(source));
        } catch {
          // A name this build would refuse was never a document it could share.
        }
      }
      const count = (answered.get(route) ?? 0) + 1;
      answered.set(route, count);
      if (count > 1) entry.history = true;
      received.set(route, entry);
    }
  }
  if (!received.size) return false;
  const routes = [...received.keys()].sort();
  const [first, ...rest] = routes.map((route) => received.get(route)!);
  const documents = [...first.documents]
    .filter((name) => rest.every((entry) => entry.documents.has(name)))
    .sort()
    .slice(0, 1000);
  const shareConversationHistory = [first, ...rest].every((entry) => entry.history);
  state.cloudSharing = {
    version: 1,
    routes,
    documents,
    shareConversationHistory,
    shareReviewPackets: false,
    upgrade: { at, from: 'recorded-history', routes: [...routes], documents: [...documents], shareConversationHistory },
  };
  return true;
}

export function requireCloudReview(state: ProjectState, documents: readonly string[]): void {
  const policy = cloudSharing(state);
  if (!policy.routes.includes('codex') || !policy.shareReviewPackets)
    throw new ApiError(403, 'Sharing proposal excerpts with the AI reviewer is off in this project.', {
      code: 'cloud_sharing_denied',
    });
  requireCloudSharing(state, 'codex', documents);
}

/**
 * Check before any file read or provider dispatch. The sample route stays local.
 *
 * `home` is set only by the conversation-message checks, from the store's folder-based Home
 * identity. Home is the person's own landing-page agent: their typed message, with no document
 * and no earlier conversation, may go to a conversation route without a sharing grant. Any
 * document or history from Home still needs one, exactly as in a project.
 */
export function requireCloudSharing(
  state: ProjectState,
  route: Route,
  documents: readonly string[],
  priorConversation = false,
  context: { home?: boolean } = {},
): CloudSharingPolicy {
  const policy = cloudSharing(state);
  if (route === 'sample') return policy;
  if (context.home === true && isConversationRoute(route) && documents.length === 0 && !priorConversation)
    return policy;
  const allowed = new Set(policy.documents);
  if (
    !policy.routes.includes(route) ||
    documents.some((name) => !allowed.has(relativeName(name))) ||
    (priorConversation && !policy.shareConversationHistory)
  ) throw new ApiError(403, 'Cloud sharing for this route, document, or conversation history is off in this project.', {
    code: 'cloud_sharing_denied',
  });
  return policy;
}
