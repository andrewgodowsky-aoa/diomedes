import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { NativeGenerator } from '../server/native-work';
import type { Conversation, Project, ProjectState, Task } from '../shared/types';
import type { GuidanceRevision } from '../shared/guidance';
import { reopenLastProject } from './fixtures/landing';
import { AGENT_NAME } from '../shared/agent-name';

// H10 in the built Console against the real host, Store and routes: three runs
// rewrite the kitchen's summary and each time a person undoes it. The
// instructions inspector then proposes one line for AGENTS.md with its
// evidence and the replayed evaluation; the person reviews the P06 diff,
// approves it, and rolls it back in one step. The model is an injected
// generator: nothing leaves this machine.

const REPORT = 'reports/summary.md';
const AGENTS = '# Kitchen rules\n\nKeep prices in dollars.\n';
const ORIGINAL = '# Summary\n\nWritten by the manager.\n';
const LINE = `Do not edit \`${REPORT}\`.`;

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let project: Project;
let runs = 0;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${route}: ${response.status} ${response.ok ? '' : await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}
const state = () => api<ProjectState>(`/projects/${project.id}/state`);
const onDisk = (name: string) => fs.readFile(path.join(project.folder, name), 'utf8');

/** One run that rewrites the summary, approved exactly, and then undone by the person. */
async function correctedRun(name: string) {
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { name, taskId: task.id });
  await api(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: `guidance-${task.id}`,
    taskId: task.id,
    threadId: thread.id,
    route: 'codex',
    sources: [REPORT],
    consent: true,
  });
  let need: ProjectState['needs'][number] | undefined;
  await expect
    .poll(
      async () => {
        need = (await state()).needs.find(
          (item) => item.state === 'open' && item.approval && (item.taskId === task.id || !item.taskId),
        );
        return Boolean(need);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await api(`/projects/${project.id}/needs/${need!.id}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution: 'go-ahead',
    allowForTask: false,
    proposalDigest: need!.approval!.proposalDigest,
    actionDigest: need!.approval!.actionDigest,
    baseDigest: need!.approval!.baseDigest,
  });
  let changeId = '';
  await expect
    .poll(
      async () => {
        const current = await state();
        const session = current.sessions.find((item) => item.taskId === task.id);
        const change = current.changes.find((item) => item.taskId === task.id && item.path === REPORT);
        changeId = change?.id ?? '';
        return Boolean(change) && !['queued', 'working'].includes(session?.state ?? 'queued');
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await api(`/projects/${project.id}/review/${encodeURIComponent(changeId)}`, 'POST', { action: 'undo' });
  expect(await onDisk(REPORT)).toBe(ORIGINAL);
}

async function guard(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const requested = new URL(route.request().url());
    if (requested.protocol.startsWith('http') && requested.hostname !== '127.0.0.1') {
      errors.push(`external request: ${requested.href}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/guidance-ui-'));
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  const generator: NativeGenerator = async ({ documents }) => {
    runs++;
    const current = documents.find((document) => document.path === REPORT)?.text ?? ORIGINAL;
    return {
      model: 'Injected guidance test generator',
      text: JSON.stringify({
        summary: `Rewrite the summary (${runs})`,
        changes: [{ path: REPORT, text: `${current}Rewritten by run ${runs}.\n`, summary: `Update ${REPORT}` }],
      }),
    };
  };
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    nativeGenerator: generator,
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/GuidanceMaintenance.tsx',
    'client/console/ProjectInstructions.tsx',
    'client/console/guidance.css',
    'shared/guidance.ts',
  ])
    expect(built, `Build first: ${source}`).toBeGreaterThan((await fs.stat(source)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);

  project = await api<Project>('/projects', 'POST', { name: 'Kitchen guidance fixture' });
  await fs.mkdir(path.join(project.folder, 'reports'), { recursive: true });
  await fs.writeFile(path.join(project.folder, REPORT), ORIGINAL, 'utf8');
  await fs.writeFile(path.join(project.folder, 'AGENTS.md'), AGENTS, 'utf8');
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: [REPORT, 'AGENTS.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  await api('/settings', 'PUT', {
    detail: 'guided',
    openProjects: [project.id],
    services: { codex: true },
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  await api(`/projects/${project.id}/packs/diomedes.software-engineering/activate`, 'POST');
  for (const name of ['Summary run one', 'Summary run two', 'Summary run three']) await correctedRun(name);
});

test.afterAll(async () => {
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('propose, review the diff, approve, and roll back in the instructions inspector', async ({ page }, testInfo) => {
  const errors: string[] = [];
  await guard(page, errors);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(url);
  await reopenLastProject(page);
  await page
    .getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: /Summary run three/ })
    .click();
  await expect(page.locator('#scrThread')).toBeVisible();

  // Trigger rules shares the thread head's line styling; find this one by what it says.
  const line = page.getByRole('button', { name: /^Project instructions / });
  await expect(line).toContainText('Project instructions loaded ·');
  await line.click();

  // The proposal: the line, which file, how many corrections of how many, the evaluation, the evidence.
  const proposals = page.getByRole('region', { name: 'Proposed revisions' });
  await expect(proposals).toBeVisible();
  const proposal = proposals.locator('.guidance-proposal');
  await expect(proposal).toHaveCount(1);
  await expect(proposal.locator('.instructions-name')).toHaveText('AGENTS.md');
  await expect(proposal.locator('.instructions-meta')).toHaveText('Writes you undid · 3 of 3');
  await expect(proposal.locator('.guidance-line')).toHaveText(LINE);
  await expect(proposal.locator('.guidance-verdict')).toHaveText('Improved');
  await expect(proposal.locator('.guidance-evaluation')).toContainText(
    'with this line it flags 3 of the 3 you corrected; without it, 0.',
  );
  const evidence = proposal.getByRole('list', { name: 'Evidence' }).locator('li');
  await expect(evidence).toHaveCount(3);
  await expect(evidence.first()).toContainText(`You undid this run's change to ${REPORT}.`);
  // Nothing is written by proposing.
  expect(await onDisk('AGENTS.md')).toBe(AGENTS);

  // Review the P06 diff, then approve under it.
  await expect(proposal.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await proposal.getByRole('button', { name: 'Review the change' }).click();
  await expect(proposal.locator('.dv-head')).toHaveText('1 line added in AGENTS.md');
  await expect(proposal.locator('.dv-row.added').filter({ hasText: LINE })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('h10-proposal-diff.png'), fullPage: true });
  await proposal.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => onDisk('AGENTS.md')).toBe(`${AGENTS}- ${LINE}\n`);

  // The revision record: who, what, and the chain.
  const revisions = page.getByRole('region', { name: 'Revisions' });
  await expect(revisions.locator('.instructions-run-head')).toHaveText('revisions · chain intact · 1');
  const applied = revisions.locator('.guidance-revision').first();
  await expect(applied.locator('.instructions-name')).toHaveText('Applied · AGENTS.md');
  await expect(applied.locator('p')).toHaveText(`Proposed by ${AGENT_NAME} · approved by you`);
  await expect(proposals).toHaveCount(0);
  const afterApprove = await state();
  const record = afterApprove.instructionFiles!.find((item) => item.path === 'AGENTS.md')!;
  const chain = afterApprove.guidance!.revisions as GuidanceRevision[];
  expect(record.sha).toBe(chain[0].newSha);
  expect(afterApprove.history.find((entry) => entry.id === chain[0].historyEntryId)?.actor).toBe('you');

  // One step back.
  await applied.getByRole('button', { name: 'Roll back to before this' }).click();
  await expect.poll(() => onDisk('AGENTS.md')).toBe(AGENTS);
  await expect(revisions.locator('.instructions-run-head')).toHaveText('revisions · chain intact · 2');
  const rolled = revisions.locator('.guidance-revision').first();
  await expect(rolled.locator('.instructions-name')).toHaveText('Rolled back · AGENTS.md');
  await expect(rolled.locator('p')).toHaveText('You · restored the text before revision 1');
  // Rolled back, the same evidence is not proposed again.
  await expect(page.getByRole('region', { name: 'Proposed revisions' })).toHaveCount(0);
  const final = await state();
  expect(final.instructionFiles!.find((item) => item.path === 'AGENTS.md')!.sha).toBe(
    (final.guidance!.revisions as GuidanceRevision[])[1].newSha,
  );

  // Machine strings stay inside the panel.
  await page.setViewportSize({ width: 900, height: 900 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
