import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import type { HistoryEntry, Project, ProjectState, Session, Task } from '../shared/types.js';

// One live turn on one text route through the app's own HTTP path.
//   tsx scripts/route-probe.ts --engine opencode --model opencode-go/glm-5.2 [--port 47641]
// It checks the engine, selects the model the way "Use as default" does, creates
// a project with one synthetic document and one bounded task, starts work on the
// named route, waits for the session to settle, and records what came back:
// the session state, every log sentence, the reported model, and the proposal
// preview if one was produced. Nothing is approved and no project file changes.
// Exactly one paid turn is spent per invocation. The record lands under
// evidence/route-probes/.

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith('--')) args.set(key.slice(2), process.argv[i + 1] ?? ''), (i += 1);
}
const engine = args.get('engine') ?? 'opencode';
const wantedModel = args.get('model') ?? '';
const port = Number(args.get('port') ?? 47641);
const root = fileURLToPath(new URL('../', import.meta.url));
const baseUrl = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const appData = path.join(root, '.data', `route-probe-${stamp}`);
const projectFolder = path.join(root, 'test-results', `route-probe-${stamp}`, 'project');
const brief = '# Route probe\n\nThis is synthetic verification text.\n';

const record: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  engine,
  wantedModel: wantedModel || null,
  liveTurns: 0,
  outcome: 'not-started',
};

async function api<T>(route: string, method = 'GET', body?: unknown, timeoutMs = 20_000): Promise<T> {
  const response = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: { 'X-Diomedes-Client': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status} for ${method} ${route}: ${(await response.text()).slice(0, 600)}`);
  return (await response.json()) as T;
}

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
try {
  app = await createApp({ dataDir: appData, projectRoot: path.dirname(projectFolder), port, clientPort: 5173 });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });

  const discovered = await api<unknown>('/ai/discover', 'POST', { consent: true }, 180_000);
  record.discovered = discovered;
  const check = await api<Record<string, unknown>>(`/ai/check/${engine}`, 'POST', {}, 180_000);
  record.check = check;
  const models = Array.isArray((check as { models?: { slug: string }[] }).models)
    ? (check as { models: { slug: string }[] }).models.map((m) => m.slug)
    : [];
  record.advertisedModels = models;
  const model = wantedModel && models.includes(wantedModel) ? wantedModel : models[0] ?? wantedModel;
  if (!model) throw new Error(`${engine} advertised no models; check: ${JSON.stringify(check).slice(0, 400)}`);
  const settings = await api<{ services?: Record<string, unknown> }>('/ai/select', 'POST', { engine, model });
  record.selected = {
    model: settings.services?.[`${engine}Model`] ?? null,
    accountRoute: settings.services?.[`${engine}AccountRoute`] ?? null,
    defaultEngine: settings.services?.defaultEngine ?? null,
  };

  const project = await api<Project>('/projects', 'POST', { name: 'Route probe', folder: projectFolder });
  await api<HistoryEntry>(`/projects/${project.id}/documents/create`, 'POST', { path: 'Brief.md', text: brief });
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Append one sentence to Brief.md',
    owner: 'diomedes-with-ok',
    description:
      'Append exactly the sentence Route probe verified. as one new line at the end of Brief.md, followed by a newline. Preserve every existing character. Do not create, delete, or change any other file.',
  });
  const command = {
    protocolVersion: 1,
    commandId: `route-probe-${stamp}`,
    taskId: task.id,
    route: engine,
    sources: ['Brief.md'],
    consent: true,
  };
  const startedAt = Date.now();
  record.liveTurns = 1;
  const started = await api<Session>(`/projects/${project.id}/work/start`, 'POST', command);
  record.sessionId = started.id;

  let session: Session | undefined;
  let state: ProjectState | undefined;
  const deadline = Date.now() + 200_000;
  while (Date.now() < deadline) {
    state = await api<ProjectState>(`/projects/${project.id}/state`);
    session = state.sessions.find((item) => item.id === started.id);
    if (!session) throw new Error('The session disappeared from project state.');
    if (['failed', 'stopped', 'waiting', 'done'].includes(session.state)) break;
    await pause(500);
  }
  record.elapsedMs = Date.now() - startedAt;
  record.sessionState = session?.state ?? 'unknown';
  record.reportedModel = session?.engine?.model ?? null;
  record.engineRecord = session?.engine ?? null;
  record.log = (session?.log ?? []).map((entry) => entry.sentence);
  const need = state?.needs.find((item) => item.sessionId === started.id);
  record.need = need
    ? {
        state: need.state,
        previewFiles: need.preview?.map((p) => ({ path: p.path, afterLength: p.after?.length ?? 0 })) ?? [],
        summary: (need as { summary?: string }).summary ?? null,
      }
    : null;
  record.fault = (session as { fault?: unknown } | undefined)?.fault ?? null;
  record.history = (state?.history ?? [])
    .filter((h) => (h as { sessionId?: string }).sessionId === started.id)
    .slice(-4)
    .map((h) => (h as { sentence?: string; summary?: string }).sentence ?? (h as { summary?: string }).summary ?? '');
  record.fileUnchanged = (await fs.readFile(path.join(projectFolder, 'Brief.md'), 'utf8')) === brief;
  record.outcome = session?.state === 'waiting' && need?.preview?.length ? 'proposal' : session?.state ?? 'unknown';
} catch (error) {
  record.outcome = 'error';
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  record.finishedAt = new Date().toISOString();
  const out = path.join(root, 'evidence', 'route-probes', `${stamp}-${engine}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: record.outcome, state: record.sessionState, model: record.reportedModel, elapsedMs: record.elapsedMs, log: record.log, error: record.error, need: record.need, out }, null, 2));
  try {
    if (app) await app.locals.close();
  } catch {}
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  setTimeout(() => process.exit(0), 500).unref();
}
