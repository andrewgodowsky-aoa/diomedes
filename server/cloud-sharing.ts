import type { CloudSharingPolicy, ProjectState, Route } from '../shared/types.js';
import { ROUTES } from '../shared/engines.js';
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
  return {
    version: policy.version,
    routes: [...new Set(policy.routes)],
    documents: [...new Set(policy.documents)],
    shareConversationHistory: policy.shareConversationHistory,
    shareReviewPackets: policy.shareReviewPackets,
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
  };
  state.cloudSharing = updated;
  return updated;
}

export function requireCloudReview(state: ProjectState, documents: readonly string[]): void {
  const policy = cloudSharing(state);
  if (!policy.routes.includes('codex') || !policy.shareReviewPackets)
    throw new ApiError(403, 'Sharing proposal excerpts with the AI reviewer is off in this project.', {
      code: 'cloud_sharing_denied',
    });
  requireCloudSharing(state, 'codex', documents);
}

/** Check before any file read or provider dispatch. The sample route stays local. */
export function requireCloudSharing(
  state: ProjectState,
  route: Route,
  documents: readonly string[],
  priorConversation = false,
): CloudSharingPolicy {
  const policy = cloudSharing(state);
  if (route === 'sample') return policy;
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
