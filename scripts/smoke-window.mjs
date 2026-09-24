import { expect } from '@playwright/test';

// The packaged local service answers only requests that carry this launch's
// loopback session header (server/app.ts). The Electron main process adds it to
// the app window's own requests for the service origin and gives it to nothing
// else (desktop/main.mjs), so a request from a driver's Node process, or a
// Playwright route.fetch() replay, is refused with 401. The packaged smoke
// drivers therefore ask from inside the window, the way the Console itself does.
//
// A fixture host a driver starts with the compiled createApp() has no session,
// so its calls stay in Node; so do the checks that a closed service no longer
// answers at all.

// Marks a driver's own request, so a page.route() standing in for the network
// lets it straight through instead of treating it as the Console's.
export const SMOKE_REQUEST_HEADER = 'x-diomedes-smoke-request';

export const isSmokeRequest = (route) =>
  route.request().headers()[SMOKE_REQUEST_HEADER] === '1';

// fetch() from inside `page`, against the service that page was loaded from.
export async function windowFetch(page, path, { method = 'GET', body } = {}) {
  return page.evaluate(
    async ({ path, method, body, header }) => {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1', [header]: '1' },
        body,
      });
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/json',
        text: await response.text(),
      };
    },
    { path, method, body, header: SMOKE_REQUEST_HEADER },
  );
}

// The drivers' usual api(): JSON in, JSON out, and a thrown error on a non-2xx.
export async function windowApi(page, route, method = 'GET', data) {
  const result = await windowFetch(page, `/api${route}`, {
    method,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!result.ok) throw new Error(`${route}: ${result.status} ${result.text}`);
  return JSON.parse(result.text);
}

// Stands in for route.fetch(): delivers the request the route intercepted from
// inside the window, so it carries the session. The route has to let the
// delivery itself through (isSmokeRequest), or it would intercept it again.
export async function deliverFromWindow(page, route) {
  const request = route.request();
  const { pathname, search } = new URL(request.url());
  return windowFetch(page, pathname + search, {
    method: request.method(),
    body: request.postData() ?? undefined,
  });
}

// Hands a delivered response back to the page that asked for it.
export const fulfillDelivered = (route, delivered) =>
  route.fulfill({ status: delivered.status, contentType: delivered.contentType, body: delivered.text });

// tests/fixtures/landing.ts does this for the browser suite and is TypeScript, so
// the same pattern lives here: a launch opens on the agent's home even with
// openProjects saved, and the last open project is entered through its Open
// projects button, with the same guard against clicking "Projects" and the same
// active-state check. A reload keeps its place, so nothing calls this after one.
export async function enterLastOpenProject(win) {
  const openProjects = () => win.getByRole('navigation', { name: 'Open projects', exact: true });
  const buttons = openProjects().getByRole('button');
  await expect(buttons.first()).toBeVisible();
  if ((await buttons.count()) < 2) {
    throw new Error(
      'enterLastOpenProject: the Open projects bar has only the "Projects" button, so there is ' +
        'no project to enter. Give the settings at least one project in openProjects first.',
    );
  }
  await buttons.last().click();
  await expect(openProjects().getByRole('button').last()).toHaveClass(
    /(?:^|\s)(?:on|active)(?:\s|$)/,
  );
}

// Cloud sharing is default-deny (security pass 2026-09-23): a project sends
// nothing to a cloud route until its owner shares that route, its documents and
// its history. tests/fixtures/cloud-sharing-grant.ts grants it for the browser
// suite and is TypeScript, so the same grant lives here, limited to the routes a
// driver's flow uses. It shares the project's current documents plus `extra`,
// such as files a proposal will create and send for review. `api` is the
// driver's own (route, method, data) caller.
export async function shareFixtureProject(api, projectId, { routes = ['codex'], extra = [] } = {}) {
  const listed = await api(`/projects/${projectId}/documents`);
  const current = await api(`/projects/${projectId}/cloud-sharing`);
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: current.version,
    routes,
    documents: [...new Set([...listed.documents.map((doc) => doc.path), ...extra])],
    shareConversationHistory: true,
    shareReviewPackets: true,
  });
}

// The landing page's main landmark carries the agent's name (AGENT_NAME in
// shared/agent-name.ts, labelled in client/console/Diomedes.tsx). The product is
// named Nectovia in the app; the executable and its identifiers stay Diomedes.
export const AGENT_NAME = 'Nectovia';
