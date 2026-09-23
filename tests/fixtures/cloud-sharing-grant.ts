/**
 * Cloud sharing is default-deny (security pass 2026-09-23): a project sends nothing to a
 * cloud route until its owner shares that route, its documents and its history. A browser
 * fixture that exercises a cloud flow grants that on the project it creates, the way a
 * person would in the Cloud sharing dialog, so the flow under test is reached. Production
 * keeps the default.
 */
import { ROUTES } from '../../shared/engines';

type Api = <T>(route: string, method?: string, data?: unknown) => Promise<T>;

/** Shares every cloud route, the project's current documents plus `extra`, history and review packets. */
export async function shareFixtureProject(api: Api, projectId: string, extra: readonly string[] = []) {
  const listed = await api<{ documents: { path: string }[] }>(`/projects/${projectId}/documents`);
  const documents = [...new Set([...listed.documents.map((doc) => doc.path), ...extra])];
  const current = await api<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: current.version,
    routes: ROUTES.filter((route) => route !== 'sample'),
    documents,
    shareConversationHistory: true,
    shareReviewPackets: true,
  });
}

/**
 * After a fixture request: a project it created, or a document it created in one, is shared,
 * so a document the fixture adds after creating the project is covered too.
 */
export async function shareAfter(api: Api, route: string, method: string, value: unknown) {
  if (method !== 'POST') return;
  if (route === '/projects' || route === '/projects/sample')
    return shareFixtureProject(api, (value as { id: string }).id);
  const created = /^\/projects\/([^/]+)\/documents\/create$/.exec(route);
  if (created) return shareFixtureProject(api, created[1]);
}
