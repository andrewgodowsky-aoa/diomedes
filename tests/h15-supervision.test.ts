/**
 * H15 — supervision end to end through `createApp` and real HTTP: a sample run
 * that writes outside its task's selected folder is paused through H08's Stop
 * and escalated as an ordinary Need; the escalation is raised once per issue,
 * is never answered by anything but a person, grants nothing, and continuing
 * goes through H08's Resume with its revalidation. Records survive a restart.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Need, ProjectState, Session } from '../shared/types.js';
import type { SupervisionRecord } from '../shared/supervision.js';
import type { ControlReceipt } from '../shared/work-control.js';
import { createApp } from '../server/app.js';

let server: Server,
  app: Awaited<ReturnType<typeof createApp>>,
  temp: string,
  url: string,
  projectId: string,
  taskId: string,
  threadId: string;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
async function until(predicate: (result: ProjectState) => boolean, what: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await state();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Never reached ${what}.`);
}
const records = async (sessionId?: string): Promise<SupervisionRecord[]> =>
  (
    await request(
      `/projects/${projectId}/supervision${sessionId ? `?sessionId=${sessionId}` : ''}`,
    )
  ).data.records;
const answer = (needId: string, body: Record<string, unknown>) =>
  request(`/projects/${projectId}/supervision/escalations/${needId}/answer`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    ...body,
  });

async function boot() {
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 30,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function shutdown() {
  try {
    await app?.locals.close();
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

beforeEach(async () => {
  vi.stubEnv('DIOMEDES_TEST_MODE', '1');
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'h15-supervision-'));
  await boot();
  // Every change asks for its own OK; the sample worker then writes its plan without asking.
  await request('/settings', 'PUT', {
    permissions: {
      changingFiles: false,
      deleting: true,
      sending: false,
      workingOutside: true,
      spending: true,
    },
  });
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  const folder = (await state()).project.folder;
  await fs.mkdir(path.join(folder, 'Menu'), { recursive: true });
  await fs.writeFile(path.join(folder, 'Menu', 'Fall menu draft.md'), '# Draft\n\nSquash soup.\n');
  const task = await request(`/projects/${projectId}/tasks`, 'POST', {
    name: 'Tidy the menu draft',
    description: 'Tidy the fall menu draft',
    sourceDocument: 'Menu/Fall menu draft.md',
  });
  expect(task.status).toBe(200);
  taskId = task.data.id;
  const thread = await request(`/projects/${projectId}/threads`, 'POST', {
    attachedTo: { kind: 'task', ref: taskId },
  });
  threadId = thread.data.id;
});
afterEach(async () => {
  await shutdown();
  vi.unstubAllEnvs();
});

/** Start the sample run, approve the one file it asks about, and wait for the escalation. */
async function driftingRun(): Promise<{ session: Session; need: Need }> {
  const started = await request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    route: 'sample',
    threadId,
  });
  expect(started.status).toBe(200);
  const session = started.data as Session;
  const asked = await until(
    (r) => r.needs.some((n) => n.sessionId === session.id && n.state === 'open' && !n.supervision),
    'the sample worker to ask about its notes file',
  );
  const notes = asked.needs.find((n) => n.sessionId === session.id && n.state === 'open')!;
  expect(notes.files).toEqual(['Sample work notes.md']);
  expect(
    (
      await request(`/projects/${projectId}/needs/${notes.id}/resolve`, 'POST', {
        resolution: 'go-ahead',
      })
    ).status,
  ).toBe(200);
  const escalated = await until(
    (r) => r.needs.some((n) => n.supervision && n.sessionId === session.id),
    'the supervision escalation',
  );
  return {
    session: escalated.sessions.find((s) => s.id === session.id)!,
    need: escalated.needs.find((n) => n.supervision && n.sessionId === session.id)!,
  };
}

test('a run writing outside the selected folder is paused through H08 Stop and escalated as a Need', async () => {
  const { session, need } = await driftingRun();
  expect(session.state).toBe('stopped');
  expect(need).toMatchObject({
    state: 'open',
    what: 'Diomedes paused this run: it started writing outside the selected folder',
    files: ['Reopening plan.md'],
    allowForTask: false,
    origin: { mode: 'application', executorId: 'diomedes:supervision' },
    supervision: { code: 'scope-drift', issueKey: 'scope:/', choices: ['continue', 'redirect', 'stop'] },
  });
  expect(need.why).toContain('Wrote Reopening plan.md, outside Menu/.');
  const current = await state();
  const task = current.tasks.find((t) => t.id === taskId)!;
  expect(task).toMatchObject({ state: 'waiting', reason: 'needs-ok', needId: need.id });
  // The proposal to add the notes file was noted while it waited for you; once you approved
  // that exact file it was admitted, so the escalation names only the unapproved write.
  const trail = await records(session.id);
  expect(trail.map((r) => r.action)).toEqual(['note', 'escalate']);
  expect(trail[0]).toMatchObject({ code: 'scope-drift', severity: 'info', issueKey: 'scope:/' });
  expect(trail[0].summary).toBe('it proposed writing outside the selected folder');
  expect(trail[0].evidence.map((e) => [e.kind, e.path])).toEqual([
    ['proposal', 'Sample work notes.md'],
  ]);
  trail.shift();
  expect(trail[0]).toMatchObject({
    code: 'scope-drift',
    severity: 'critical',
    actor: { kind: 'diomedes', role: 'supervision', mode: 'application' },
    needId: need.id,
    control: { control: 'stop', outcome: 'applied' },
  });
  expect(trail[0].evidence.map((e) => e.path)).toEqual(['Reopening plan.md']);
  // The pause is an H08 receipt asked for in supervision's name, performed by Diomedes.
  const receipt = (current.controlReceipts ?? []).find(
    (r) => r.commandId === trail[0].control!.commandId,
  )!;
  expect(receipt).toMatchObject({
    control: 'stop',
    requestedBy: { actor: 'diomedes', via: 'supervision', recordId: trail[0].id },
    performedBy: { kind: 'diomedes' },
  });
  expect(current.history.some((h) => h.kind === 'supervision' && h.actor === 'diomedes')).toBe(
    true,
  );
});

test('an escalation is raised once per issue and re-evaluating adds nothing', async () => {
  const { session, need } = await driftingRun();
  const before = await records();
  for (let pass = 0; pass < 3; pass++) {
    const again = await request(`/projects/${projectId}/supervision/evaluate`, 'POST', {
      sessionId: session.id,
    });
    expect(again.status).toBe(200);
  }
  const after = await records();
  // The run has ended, so the only thing ever added is at most one note; never a second escalation.
  expect(after.filter((r) => r.action === 'escalate')).toHaveLength(1);
  expect(after.length - before.length).toBeLessThanOrEqual(1);
  const open = (await state()).needs.filter((n) => n.supervision && n.state === 'open');
  expect(open.map((n) => n.id)).toEqual([need.id]);
});

test('an escalation is never answered for the task and never by anything but a person', async () => {
  const { need } = await driftingRun();
  const wide = await request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', {
    resolution: 'go-ahead',
    allowForTask: true,
  });
  expect(wide.status).toBe(400);
  const remember = await request(
    `/projects/${projectId}/permissions/remembered`,
    'POST',
    { needId: need.id },
  );
  expect(remember.status).toBeGreaterThanOrEqual(400);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect((await state()).needs.find((n) => n.id === need.id)!.state).toBe('open');
});

test('continue is refused where the route cannot resume, and the escalation stays open', async () => {
  const { need } = await driftingRun();
  const refused = await answer(need.id, { answer: 'continue' });
  expect(refused.status).toBe(200);
  expect(refused.data.receipt).toMatchObject({ control: 'resume', outcome: 'refused' });
  expect(refused.data.need.state).toBe('open');
  expect(refused.data.record).toMatchObject({ action: 'answer', answer: 'continue' });
  const stopped = await answer(need.id, { answer: 'stop' });
  expect(stopped.status).toBe(200);
  expect(stopped.data.need).toMatchObject({ state: 'declined', supervision: { answer: 'stop' } });
  const current = await state();
  expect(current.tasks.find((t) => t.id === taskId)).toMatchObject({ state: 'todo', needId: null });
  expect(current.sessions.filter((s) => ['queued', 'working', 'waiting'].includes(s.state))).toEqual([]);
  // Answered once; another answer is refused.
  expect((await answer(need.id, { answer: 'stop' })).status).toBe(409);
});

test('continuing goes through H08 Resume and its revalidation, and never with wider authority', async () => {
  expect(
    (await request(`/projects/${projectId}/controls/fixture`, 'PUT', { enabled: true })).status,
  ).toBe(200);
  const { session, need } = await driftingRun();
  // The thread was widened after the pause: Resume refuses rather than run with more authority.
  expect(
    (await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'task' })).status,
  ).toBeLessThan(300);
  const widened = await answer(need.id, { answer: 'continue' });
  expect(widened.data.receipt).toMatchObject({
    control: 'resume',
    outcome: 'refused',
    refusal: { code: 'permission-widened' },
    requestedBy: { actor: 'you', via: 'local-client' },
  });
  expect(widened.data.need.state).toBe('open');
  expect(
    (await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { permission: 'show-first' })).status,
  ).toBeLessThan(300);
  const resumed = await answer(need.id, { answer: 'continue' });
  const receipt = resumed.data.receipt as ControlReceipt;
  expect(receipt).toMatchObject({
    control: 'resume',
    outcome: 'applied',
    lineage: { kind: 'resume', originSessionId: session.id },
  });
  expect(receipt.revalidated.join(' ')).toContain('Permission: every change waits for your OK.');
  expect(resumed.data.need).toMatchObject({ state: 'go-ahead', supervision: { answer: 'continue' } });
  // Continuing acknowledges the issue: the resumed run's same drift is noted, not raised again.
  const next = receipt.result.sessionId!;
  const later = await until(
    (r) => (r.supervision ?? []).some((rec) => rec.sessionId === next),
    'the resumed run to be supervised',
  );
  expect(later.needs.filter((n) => n.supervision && n.state === 'open')).toEqual([]);
  expect(
    (later.supervision ?? []).filter((rec) => rec.sessionId === next).map((rec) => rec.action),
  ).toEqual(['note']);
});

test('redirect queues your words as the next run through ordinary admission', async () => {
  const { need } = await driftingRun();
  const redirected = await answer(need.id, {
    answer: 'redirect',
    text: 'Only tidy the menu draft; leave the plan alone.',
  });
  expect(redirected.status).toBe(200);
  expect(redirected.data.receipt).toMatchObject({
    control: 'queue',
    requestedBy: { actor: 'you', via: 'local-client' },
  });
  expect(redirected.data.need.state).toBe('go-ahead');
  const delivered = await until(
    (r) => (r.followUps ?? []).some((f) => f.state === 'delivered'),
    'the redirect to be delivered',
  );
  const followUp = delivered.followUps!.find((f) => f.state === 'delivered')!;
  expect(followUp.text).toBe('Only tidy the menu draft; leave the plan alone.');
  expect(followUp.queuedBy).toBeUndefined();
});

test('supervision records and the open escalation survive a restart, and are not raised again', async () => {
  const { session, need } = await driftingRun();
  const before = await records();
  await shutdown();
  await boot();
  const after = await records();
  expect(after).toEqual(before);
  expect((await state()).needs.find((n) => n.id === need.id)!.state).toBe('open');
  await request(`/projects/${projectId}/supervision/evaluate`, 'POST', { sessionId: session.id });
  expect((await records()).filter((r) => r.action === 'escalate')).toHaveLength(1);
  // And it is still answerable after the restart.
  expect((await answer(need.id, { answer: 'stop' })).data.need.state).toBe('declined');
});

test('a run inside its selected folder, or with no selected source, is not drift', async () => {
  const plain = await request(`/projects/${projectId}/tasks`, 'POST', {
    name: 'No source',
    description: 'No selected source',
  });
  const started = await request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId: plain.data.id,
    route: 'sample',
  });
  const session = started.data as Session;
  const asked = await until(
    (r) => r.needs.some((n) => n.sessionId === session.id && n.state === 'open'),
    'the notes request',
  );
  const notes = asked.needs.find((n) => n.sessionId === session.id && n.state === 'open')!;
  await request(`/projects/${projectId}/needs/${notes.id}/resolve`, 'POST', {
    resolution: 'go-ahead',
  });
  await until(
    (r) => r.sessions.find((s) => s.id === session.id)?.state === 'done',
    'the run to finish',
  );
  expect(await records(session.id)).toEqual([]);
});
