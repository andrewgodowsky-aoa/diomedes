import { test, expect, type Page, type Route, type Response } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Store } from '../server/store';
import type { CloudSharingPolicy, Project, ProjectState } from '../shared/types';
import { AWS_CONNECT_BODY, AWS_TEST_KEY, awsTransport, seen } from './fixtures/scripted-home-luna';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { shareAfter } from './fixtures/cloud-sharing-grant';

// The Diomedes page on AWS Bedrock (Luna), end to end in a real browser and with no Claude
// installed at all: the engine service discovers nothing, so there is no login to fall back
// to. The conversation still runs on the real Store, Runtime, interaction service and
// model-session driver; only the HTTPS call the provider boundary makes is scripted. It never
// reaches AWS and never spends money. It serves the built bundle, so it refuses a stale one.
test.describe.configure({ mode: 'serial' });

const port = Number(process.env.DIOMEDES_LUNA_UI_PORT ?? 47640);
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let pageErrors: string[] = [];
/** This run's own folder, so a test can set up a record an earlier build left. */
let dataRoot = '';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Luna page fixture request ${route} failed (${response.status}): ${await response.text()}`,
    );
  const value = (await response.json()) as T;
  await shareAfter(api, route, method, value);
  return value;
}

async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  for (const dir of ['client', 'client/console', 'shared']) {
    for (const entry of await fs.readdir(path.resolve(dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.resolve(dir, entry.name);
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = path.relative(process.cwd(), file);
      }
    }
  }
  expect(
    built,
    `dist is older than ${newestPath}, so this spec would test the previous build. Run "npm run build" first.`,
  ).toBeGreaterThan(newest);
}

const home = () => api<{ projectId: string; threadId: string } | null>('/home/conversation');
const homeState = async () => {
  const bound = await home();
  if (!bound) return null;
  return api<ProjectState>(`/projects/${bound.projectId}/state`);
};
const homeThread = async () => {
  const [bound, state] = [await home(), await homeState()];
  if (!bound || !state) return null;
  return state.conversations.find((item) => item.id === bound.threadId) ?? null;
};
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Nectovia' });
const answers = (page: Page) => page.locator('.turn.dio .body');
// There is no Route control: a customer chooses a tier, never a route (owner decision
// 2026-09-23). The locator stays so each test can say it is absent.
const routeControl = (page: Page) => page.getByRole('combobox', { name: 'Route' });
const styleControl = (page: Page) => page.getByRole('combobox', { name: 'Style' });
const strip = (page: Page) =>
  page.getByRole('group', { name: 'A message that was not confirmed' });
/** A message send is a POST to the collection; an interrupt POST ends in /interrupt. */
const messagePost = (request: { method(): string; url(): string }) =>
  request.method() === 'POST' && /\/messages$/.test(request.url());
const interruptPost = (request: { method(): string; url(): string }) =>
  request.method() === 'POST' && /\/messages\/[^/]+\/interrupt$/.test(request.url());
/** Two paints, so anything an arriving answer could paint has had its chance. */
async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
/** Holds one response after the server has answered it, until the test lets it through. */
function gate() {
  let release!: () => void;
  let reached!: () => void;
  let delivered!: () => void;
  return {
    held: new Promise<void>((resolve) => (release = resolve)),
    recorded: new Promise<void>((resolve) => (reached = resolve)),
    arrived: new Promise<void>((resolve) => (delivered = resolve)),
    release: () => release(),
    reached: () => reached(),
    delivered: () => delivered(),
  };
}

async function open(page: Page) {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
}
async function say(page: Page, text: string) {
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  await composer(page).fill(text);
  await composer(page).press('Enter');
}
/** The command this browser still holds pending, read the way the page's own recovery reads it. */
const claimedCommand = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('diomedes.conversation.claim.')) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const saved = JSON.parse(raw) as { commandId?: unknown };
        if (typeof saved.commandId === 'string') return saved.commandId;
      } catch {
        // A damaged record is not this test's to repair.
      }
    }
    return null;
  });

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'home-luna-'));
  dataRoot = root;
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    // No engine on this computer: discovery finds nothing, so there is no Claude login to
    // fall back to and nothing the conversation could silently retarget.
    engineService: new EngineService(path.join(root, 'engines'), {
      discover: async () => [],
      version: async () => {
        throw new Error('No engine is installed in this fixture.');
      },
      adapter: () => {
        throw new Error('No engine is installed in this fixture.');
      },
    }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: awsTransport,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server = application.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  // AWS is connected and spend-approved the way a person would do it in AI setup. Nothing but
  // the transport is faked.
  await api('/ai/model-api/aws-bedrock', 'PUT', AWS_CONNECT_BODY);
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  await api('/settings', 'PUT', {
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'new',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});

test.afterAll(async () => {
  await application?.locals.close?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test('the home conversation opens on AWS Bedrock (Luna) and answers with no Claude login', async ({
  page,
}) => {
  await open(page);
  // The caption names the default a first send takes, before any thread exists to read.
  await expect(page.locator('.instr')).toContainText('AWS Bedrock (Luna)');
  // And there is nothing to choose yet: the control needs a concrete thread to write to.
  await expect(routeControl(page)).toHaveCount(0);

  const callsBefore = seen.length;
  await say(page, 'Good morning');
  await expect(answers(page).last()).toHaveText('You said: Good morning');
  await expect(composer(page)).toHaveValue('');

  // The provisioner pinned the new thread to the default, and the provider boundary really was
  // AWS's: the guarded transport attached the saved credential, the approved endpoint and the
  // Luna model, and the call carried the conversation's tools.
  const bound = await home();
  expect(bound).not.toBeNull();
  const thread = await homeThread();
  expect(thread?.engine).toBe('aws-bedrock');
  const call = seen.slice(callsBefore).at(-1)!;
  expect(call.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses');
  expect(call.authorization).toBe(`Bearer ${AWS_TEST_KEY}`);
  expect(call.body.model).toBe(AWS_LUNA_MODEL);
  expect(Array.isArray(call.body.tools)).toBe(true);
  expect(call.body.store).toBe(false);

  // Now that the thread exists, the only model control offers the tiers, never a route.
  await expect(routeControl(page)).toHaveCount(0);
  await expect(styleControl(page).locator('option')).toHaveText(['Default', 'Efficient', 'Focused', 'Thorough']);
});

test('a project scope conversation is provisioned on AWS Bedrock too', async ({ page }) => {
  const project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption({ label: 'Linen service' });
  await say(page, 'About this project');
  await expect(answers(page).last()).toHaveText('You said: About this project');
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  const thread = state.conversations.find((item) => item.name === 'Diomedes');
  expect(thread?.engine).toBe('aws-bedrock');
  // There is no Route control on any scope; the caption names the route without a tier.
  await expect(routeControl(page)).toHaveCount(0);
  await expect(page.locator('.instr')).toContainText('AWS Bedrock (Luna)');
});

test('AWS that is on but not configured refuses by name, and nothing falls back', async ({
  page,
}) => {
  // The services map is replaced whole, so the account route and model keys are dropped inside
  // the full map and the full map is put back afterwards.
  const { services } = await api<{ services: Record<string, boolean | string> }>('/settings');
  const narrowed = { ...services };
  delete narrowed['aws-bedrockAccountRoute'];
  delete narrowed['aws-bedrockModel'];
  await api('/settings', 'PUT', { services: narrowed });
  try {
    await open(page);
    const callsBefore = seen.length;
    await say(page, 'Are you there?');
    await expect(page.getByRole('alert')).toHaveText(
      'Connect AWS Bedrock (GPT-5.6 Luna) and choose its model in AI setup first.',
    );
    await expect(composer(page)).toHaveValue('Are you there?');
    await expect(page.locator('.dio-card')).toHaveCount(0);
    // The refusal happened in admission: no provider call was ever attempted, and the caption
    // still names the route the thread is actually on rather than a fallback it did not take.
    expect(seen.length).toBe(callsBefore);
    await expect(page.locator('.instr')).toContainText('AWS Bedrock (Luna)');
  } finally {
    await api('/settings', 'PUT', { services });
  }
});

test('a pin saved before choices were marked is re-pinned to the default on the next send', async ({
  page,
}) => {
  const bound = await home();
  expect(bound).not.toBeNull();
  // What a thread pinned before engineChoice existed looks like: the engine alone, no marker.
  const store = application!.locals.store as Store;
  const saved = store.state(bound!.projectId);
  const pinned = saved.conversations.find((item) => item.id === bound!.threadId)!;
  pinned.engine = 'claude-code';
  delete (pinned as { engineChoice?: string }).engineChoice;
  await store.persist(saved);

  await open(page);
  // The pin is still the truth while nothing has run: the caption names it even though this
  // computer cannot send on it.
  await expect(page.locator('.instr')).toContainText('Claude Code');

  await say(page, 'Still here after the upgrade');
  await expect(answers(page).last()).toHaveText('You said: Still here after the upgrade');
  const thread = await homeThread();
  expect(thread?.engine).toBe('aws-bedrock');
  await expect(page.locator('.instr')).toContainText('AWS Bedrock (Luna)');
});

test('a route the person chose is kept, and its refusal names it', async ({ page }) => {
  const bound = await home();
  expect(bound).not.toBeNull();
  try {
    // The person's own choice, written through the same PUT the control uses, so it is marked.
    await api(`/projects/${bound!.projectId}/threads/${bound!.threadId}`, 'PUT', {
      engine: 'claude-code',
    });
    await open(page);
    await expect(page.locator('.instr')).toContainText('Claude Code');
    const callsBefore = seen.length;
    await say(page, 'On the route I chose');
    // The provisioner kept the choice, the send refused on it by name, and nothing was
    // silently retargeted to the AWS route that would have answered.
    await expect(page.getByRole('alert')).toHaveText(
      'Turn Claude Code on in Settings before sending.',
    );
    await expect(composer(page)).toHaveValue('On the route I chose');
    expect(seen.length).toBe(callsBefore);
    expect((await homeThread())?.engine).toBe('claude-code');
  } finally {
    await api(`/projects/${bound!.projectId}/threads/${bound!.threadId}`, 'PUT', {
      engine: 'aws-bedrock',
    });
  }
});

test('Stop names only this message\'s command, and the record says what it came to', async ({
  page,
}) => {
  await open(page);
  const callsBefore = seen.length;
  // SLOW tells the scripted provider to hold the call on the wire, so the delivery is still
  // pending when the person stops it.
  await composer(page).fill('SLOW hold this');
  await composer(page).press('Enter');
  await expect(page.locator('.dio-pending')).toBeVisible();
  // The provider call on the wire is the proof this delivery's dispatch was issued an identity:
  // a Stop pressed before it would find nothing to name. The fixture records each call as it
  // starts, so the wait is deterministic.
  await expect.poll(() => seen.length).toBeGreaterThan(callsBefore);
  // The delivery that is on its way is the only one the choice and the Stop can name.
  await expect(styleControl(page)).toBeDisabled();
  // The claim was issued before the dispatch: it is the one command this Stop may name.
  const commandId = await claimedCommand(page);
  expect(commandId).not.toBeNull();
  const interrupt = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/messages/${commandId}/interrupt`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Stop' }).click();
  const ack = await interrupt;
  expect(ack.ok()).toBe(true);
  // The path named the command and the body was empty: no run id, no engine, nothing else.
  expect(ack.request().postDataJSON()).toEqual({});
  const ackBody = (await ack.json()) as { commandId: string; state: string };
  expect(ackBody.commandId).toBe(commandId);
  expect(['requested', 'settled']).toContain(ackBody.state);

  // The pending strip owns what was never confirmed, under the command it was issued. The
  // transport acknowledgement is not the outcome: the command's own record is.
  const bound = await home();
  const recorded = await api<{ interrupted: boolean; answerText: string | null }>(
    `/projects/${bound!.projectId}/threads/${bound!.threadId}/messages/${commandId}`,
  );
  expect(recorded.interrupted).toBe(true);
  expect(recorded.answerText).toBeNull();
  expect(seen.length).toBeGreaterThan(callsBefore);

  const strip = page.locator('.dio-unconfirmed');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('SLOW hold this');
  // Send again sends that same command: the server answers it from its record rather than
  // running it again. The strip hides when the resend starts, not when it finishes, so the
  // replay of this exact command is awaited and read before the claim is asked about.
  const replay = page.waitForResponse((response) => {
    if (!messagePost(response.request())) return false;
    if (!response.url().includes(`/threads/${bound!.threadId}/`)) return false;
    try {
      const posted = response.request().postDataJSON() as { commandId?: string };
      return posted.commandId === commandId;
    } catch {
      return false;
    }
  });
  const callsAtReplay = seen.length;
  await strip.getByRole('button', { name: 'Send again' }).click();
  const replayed = await replay;
  expect(replayed.ok()).toBe(true);
  const replayResult = (await replayed.json()) as { commandId: string; interrupted: boolean };
  // The replay is the command's own durable record: same command, still interrupted, and the
  // provider was never asked again.
  expect([replayResult.commandId, replayResult.interrupted]).toEqual([commandId, true]);
  expect(seen.length).toBe(callsAtReplay);
  await expect(strip).toHaveCount(0);
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await claimedCommand(page)).toBeNull();
});

test('a Stop while Home is still being provisioned sends nothing at all', async ({ page }) => {
  await open(page);
  const callsBefore = seen.length;
  let posts = 0;
  let interrupts = 0;
  page.on('request', (request) => {
    if (messagePost(request)) posts += 1;
    if (interruptPost(request)) interrupts += 1;
  });
  // The real provisioner answers; only its response reaching this window is held, the way a
  // slow network would hold it. Whether provisioning itself ran is not this test's to claim.
  const provision = gate();
  const holdProvision = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    provision.reached();
    await provision.held;
    await route.fulfill({ response });
    provision.delivered();
  };
  await page.route('**/api/home/conversation', holdProvision);
  try {
    await composer(page).fill('Stopped before it left');
    await composer(page).press('Enter');
    await expect(page.locator('.dio-pending')).toBeVisible();
    // The provisioner has answered, but the delivery still does not know where to send.
    await provision.recorded;
    await page.getByRole('button', { name: 'Stop' }).click();
    provision.release();
    await provision.arrived;
    // The delivery ends with nothing issued: no message POST, no interrupt, no provider call,
    // no saved claim. The words are still the person's, back in the box, not an unconfirmed
    // claim the record never saw.
    await expect(page.locator('.dio-pending')).toHaveCount(0);
    await expect(composer(page)).toHaveValue('Stopped before it left');
    await expect(strip(page)).toHaveCount(0);
    await expect(page.locator('.dio-notice')).toHaveCount(0);
    expect(posts).toBe(0);
    expect(interrupts).toBe(0);
    expect(seen.length).toBe(callsBefore);
    expect(await claimedCommand(page)).toBeNull();
  } finally {
    provision.release();
    await page.unroute('**/api/home/conversation', holdProvision);
  }
});

test('a Stop while the send waits on the conversation lock sends nothing', async ({
  page,
  context,
}) => {
  await open(page);
  // A real bound thread, so the lock the next send waits on is the real one.
  await say(page, 'A conversation to hold');
  await expect(answers(page).last()).toHaveText('You said: A conversation to hold');
  const bound = (await home())!;
  const lock = `diomedes.conversation.send.${encodeURIComponent(bound.projectId)}|${encodeURIComponent(bound.threadId)}`;
  const other = await context.newPage();
  try {
    await open(other);
    // The other window holds this conversation's send lock, the way a send there would.
    await other.evaluate(async (name) => {
      const holder = window as typeof window & { releaseLunaLock?: () => void };
      await new Promise<void>((acquired, reject) => {
        void navigator.locks
          .request(name, async () => {
            await new Promise<void>((release) => {
              holder.releaseLunaLock = release;
              acquired();
            });
          })
          .catch(reject);
      });
    }, lock);
    const callsBefore = seen.length;
    let posts = 0;
    let interrupts = 0;
    page.on('request', (request) => {
      if (messagePost(request)) posts += 1;
      if (interruptPost(request)) interrupts += 1;
    });
    await composer(page).fill('Queued behind the lock');
    await composer(page).press('Enter');
    // The send really is queued on the lock before the Stop lands.
    await expect
      .poll(() =>
        other.evaluate(async (name) => {
          const snapshot = await navigator.locks.query();
          return snapshot.pending?.some((entry) => entry.name === name) ?? false;
        }, lock),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Stop' }).click();
    await other.evaluate(
      () => (window as typeof window & { releaseLunaLock?: () => void }).releaseLunaLock?.(),
    );
    // The wait ended with nothing written and nothing sent: no save, no POST, no provider
    // call, no interrupt, and the words are still the person's.
    await expect(page.locator('.dio-pending')).toHaveCount(0);
    await expect(composer(page)).toHaveValue('Queued behind the lock');
    await expect(strip(page)).toHaveCount(0);
    await expect(page.locator('.dio-notice')).toHaveCount(0);
    expect(posts).toBe(0);
    expect(interrupts).toBe(0);
    expect(seen.length).toBe(callsBefore);
    expect(await claimedCommand(page)).toBeNull();
  } finally {
    await other
      .evaluate(
        () => (window as typeof window & { releaseLunaLock?: () => void }).releaseLunaLock?.(),
      )
      .catch(() => undefined);
    await other.close();
  }
});

test('a late interrupt answer cannot paint the scope the person moved to', async ({ page }) => {
  const project = await api<Project>('/projects', 'POST', { name: 'Away scope' });
  await open(page);
  const callsBefore = seen.length;
  // The interrupt really reaches the server; only its answer is held until the visit moved.
  const ack = gate();
  const holdAck = async (route: Route) => {
    const response = await route.fetch();
    ack.reached();
    await ack.held;
    // A successful acknowledgement that still cannot confirm a stop: no live turn held it.
    const commandId = decodeURIComponent(
      route.request().url().split('/messages/')[1].split('/')[0],
    );
    await route.fulfill({ response, json: { commandId, runId: null, state: 'idle' } });
    ack.delivered();
  };
  await page.route('**/api/projects/*/threads/*/messages/*/interrupt', holdAck);
  try {
    await composer(page).fill('SLOW while I leave');
    await composer(page).press('Enter');
    await expect.poll(() => seen.length).toBeGreaterThan(callsBefore);
    await page.getByRole('button', { name: 'Stop' }).click();
    // The request is on the wire, unanswered.
    await ack.recorded;
    // The person is somewhere else entirely before the answer arrives.
    await page.getByRole('combobox', { name: 'In' }).selectOption({ label: 'Away scope' });
    const scope = page.getByRole('combobox', { name: 'In' });
    await expect(scope).toHaveValue(project.id);
    await expect(composer(page)).toBeVisible();
    ack.release();
    await ack.arrived;
    await painted(page);
    // The acknowledgement belonged to the visit that asked. This scope is told nothing.
    await expect(page.locator('.dio-notice')).toHaveCount(0);
  } finally {
    ack.release();
    await page.unroute('**/api/projects/*/threads/*/messages/*/interrupt', holdAck);
  }
});

test('a late failed interrupt cannot paint a newer visit to the same scope', async ({ page }) => {
  const project = await api<Project>('/projects', 'POST', { name: 'Layover' });
  await open(page);
  const callsBefore = seen.length;
  const ack = gate();
  const holdAck = async (route: Route) => {
    await route.fetch();
    ack.reached();
    await ack.held;
    // The answer never arrives: the connection dropped after the interrupt ran.
    await route.abort('failed');
    ack.delivered();
  };
  await page.route('**/api/projects/*/threads/*/messages/*/interrupt', holdAck);
  try {
    await composer(page).fill('SLOW then back home');
    await composer(page).press('Enter');
    await expect.poll(() => seen.length).toBeGreaterThan(callsBefore);
    await page.getByRole('button', { name: 'Stop' }).click();
    await ack.recorded;
    // Leave and come back: the home scope the person returns to is a newer visit, and it is
    // visibly the active one before the failure lands.
    const scope = page.getByRole('combobox', { name: 'In' });
    await scope.selectOption({ label: 'Layover' });
    await expect(scope).toHaveValue(project.id);
    await scope.selectOption({ label: 'All projects' });
    await expect(scope).toHaveValue(':all');
    await expect(composer(page)).toBeVisible();
    ack.release();
    await ack.arrived;
    await painted(page);
    // A failed interrupt would have said "Stop was not confirmed" - in the visit that asked.
    // This newer visit to the same conversation is not that visit.
    await expect(page.locator('.dio-notice')).toHaveCount(0);
  } finally {
    ack.release();
    await page.unroute('**/api/projects/*/threads/*/messages/*/interrupt', holdAck);
  }
});

test('a Stop already answered names nothing again', async ({ page }) => {
  await open(page);
  const callsBefore = seen.length;
  let interrupts = 0;
  page.on('request', (request) => {
    if (interruptPost(request)) interrupts += 1;
  });
  await composer(page).fill('SLOW double stop');
  await composer(page).press('Enter');
  await expect.poll(() => seen.length).toBeGreaterThan(callsBefore);
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  // Two presses on the same delivery, faster than the abort can settle: the first released the
  // delivery's identity, so the second has nothing to name.
  await Promise.all([
    stop.dispatchEvent('click', { bubbles: true }),
    stop.dispatchEvent('click', { bubbles: true }),
  ]);
  // The delivery is over and so is its control: a press after it cannot exist on screen.
  await expect(strip(page)).toContainText('SLOW double stop');
  await expect(stop).toHaveCount(0);
  await painted(page);
  expect(interrupts).toBe(1);
});

test('two Stop presses in one JavaScript turn name the command once', async ({ page }) => {
  await open(page);
  const callsBefore = seen.length;
  const interrupts: string[] = [];
  page.on('request', (request) => {
    if (interruptPost(request)) interrupts.push(request.url());
  });
  await composer(page).fill('SLOW two presses one turn');
  await composer(page).press('Enter');
  await expect.poll(() => seen.length).toBeGreaterThan(callsBefore);
  const commandId = await claimedCommand(page);
  expect(commandId).not.toBeNull();
  // The record is read only once the interrupt has been answered: the request leaving the page
  // is not the server having recorded it.
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/messages/${commandId}/interrupt`) &&
      response.request().method() === 'POST',
  );
  // Both click events run in one page evaluation, before any promise continuation can settle
  // the first press: the second finds the delivery's identity already released and has nothing
  // left to name.
  await page.evaluate(() => {
    const stop = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop',
    );
    if (!stop) throw new Error('The Stop button is not on screen.');
    stop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    stop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // One interrupt, for that delivery's command and no other. The message stays the person's
  // pending message to recover, and the page threw nothing.
  await expect(strip(page)).toContainText('SLOW two presses one turn');
  await painted(page);
  expect(interrupts).toHaveLength(1);
  expect(interrupts[0]).toContain(`/messages/${commandId}/interrupt`);
  expect((await answered).ok()).toBe(true);
  const bound = await home();
  const recorded = await api<{ interrupted: boolean }>(
    `/projects/${bound!.projectId}/threads/${bound!.threadId}/messages/${commandId}`,
  );
  expect(recorded.interrupted).toBe(true);
});

test('a delivery left behind in an old visit cannot take the new Stop with it', async ({
  page,
}) => {
  const project = await api<Project>('/projects', 'POST', { name: 'Second scope' });
  await open(page);
  const callsBefore = seen.length;
  const posts: string[] = [];
  page.on('request', (request) => {
    if (messagePost(request)) posts.push(request.url());
  });
  // Home's provisioner really answers; only its response reaching this window is held, so the
  // old delivery is still finding its conversation while the person moves on.
  const old = gate();
  const holdOldProvision = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    old.reached();
    await old.held;
    await route.fulfill({ response });
    old.delivered();
  };
  await page.route('**/api/home/conversation', holdOldProvision);
  try {
    await composer(page).fill('Left before it landed');
    await composer(page).press('Enter');
    await expect(page.locator('.dio-pending')).toBeVisible();
    await old.recorded;
    // The new scope's delivery is the one on screen now: it provisions, dispatches, and its
    // provider call holds long enough to be stopped.
    const scope = page.getByRole('combobox', { name: 'In' });
    await scope.selectOption({ label: 'Second scope' });
    await expect(scope).toHaveValue(project.id);
    await composer(page).fill('SLOW newer delivery');
    await composer(page).press('Enter');
    await expect(page.locator('.dio-pending')).toBeVisible();
    await expect.poll(() => seen.length).toBeGreaterThan(callsBefore);
    const commandId = await claimedCommand(page);
    expect(commandId).not.toBeNull();
    // A listener, not a floating waiter: if the Stop names nothing, the bounded poll below
    // fails as the missing-interrupt assertion while the page is still open, instead of a
    // waiter outliving the test and failing cleanup.
    const interruptAcks: Response[] = [];
    page.on('response', (response) => {
      if (
        interruptPost(response.request()) &&
        response.url().endsWith(`/messages/${commandId}/interrupt`)
      )
        interruptAcks.push(response);
    });
    // Now the old provision answer is let through. Its continuation finds the visit moved and
    // its own delivery cancelled, and finishes; two paints is further than that continuation
    // can take to run its cleanup.
    old.release();
    await old.arrived;
    await painted(page);
    // The delivery on screen still owns its identity: this Stop names the newer command.
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => interruptAcks.length).toBe(1);
    const ack = interruptAcks[0];
    expect(ack.ok()).toBe(true);
    expect(((await ack.json()) as { commandId: string }).commandId).toBe(commandId);
    // The delivery that never learned its conversation sent nothing: one message POST, and it
    // belongs to the new scope's thread. The stopped message stays pending, ready to be sent
    // again from its own record.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`/projects/${project.id}/`);
    await expect(strip(page)).toContainText('SLOW newer delivery');
  } finally {
    old.release();
    await page.unroute('**/api/home/conversation', holdOldProvision);
  }
});

test('a tier change that starts the conversation fresh says so in the thread', async ({ page }) => {
  // Its own scope, so the only lineage this test moves is one it opened itself.
  await api<Project>('/projects', 'POST', { name: 'Tier change' });
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption({ label: 'Tier change' });
  await say(page, 'Where is the linen order?');
  await expect(answers(page).last()).toHaveText('You said: Where is the linen order?');
  const notes = page.locator('.turn.dio').filter({ hasText: 'started this conversation fresh' });
  await expect(notes).toHaveCount(0);

  // Efficient runs at another level than the conversation was opened at, so the next message
  // starts it fresh. The choice is saved before anything is sent under it.
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && /\/threads\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await styleControl(page).selectOption({ label: 'Efficient' });
  expect((await saved).ok()).toBe(true);
  await say(page, 'And the invoice?');
  await expect(answers(page).last()).toHaveText('You said: And the invoice?');

  // One note, in plain words, naming the tier, between the exchange it ended and the next.
  const note =
    "Nectovia started this conversation fresh because this conversation moved to the Efficient tier. Your earlier messages are still here, but it won't remember them.";
  await expect(notes).toHaveCount(1);
  await expect(notes.locator('.body')).toHaveText(note);
  await expect(page.locator('.transcript .turn .body')).toHaveText([
    'Where is the linen order?',
    'You said: Where is the linen order?',
    note,
    'And the invoice?',
    'You said: And the invoice?',
  ]);
});

/**
 * The conversation menu's dry runs in one project, as this page read them: how many conversations
 * each said an update would start fresh.
 */
function dryRuns(page: Page, projectId: string) {
  const read: number[] = [];
  page.on('response', (response) => {
    if (response.request().method() !== 'GET') return;
    const { pathname } = new URL(response.url());
    if (!pathname.includes(`/projects/${projectId}/`) || !pathname.endsWith('/answer-format')) return;
    void response.json().then(
      (body: { retiring: number }) => read.push(body.retiring),
      () => undefined,
    );
  });
  return read;
}
/** The project's history grant, with the rest of its sharing as it stands. */
async function shareHistory(projectId: string, on: boolean) {
  const policy = await api<CloudSharingPolicy>(`/projects/${projectId}/cloud-sharing`);
  await api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version,
    routes: policy.routes,
    documents: policy.documents,
    shareConversationHistory: on,
    shareReviewPackets: policy.shareReviewPackets,
  });
}
/**
 * One exchange in its own scope, then the lineage as 0.1.8 left it: its run records main's 0.1.8
 * Automatic text, which this build still knows and keeps, so without the update every message
 * would stay on it. The page is opened again, as after the update to this build.
 */
async function openedBefore(page: Page, name: string, words: string, answer: string) {
  const project = await api<Project>('/projects', 'POST', { name });
  const read = dryRuns(page, project.id);
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption({ label: name });
  await say(page, words);
  await expect(answers(page).last()).toContainText(answer);
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  // Opened on this build's own text, it has nothing to update: the dry run says so, and the
  // conversation has no menu.
  await expect.poll(() => read.length).toBeGreaterThan(0);
  await painted(page);
  expect(read.every((retiring) => retiring === 0)).toBe(true);
  await expect(page.getByRole('button', { name: 'Conversation menu' })).toHaveCount(0);
  const opened = (await api<ProjectState>(`/projects/${project.id}/state`)).conversations[0];
  const [lineage] = opened.lineages ?? [];
  expect(lineage).toMatchObject({ mode: 'auto', generation: 1 });
  const fixture = JSON.parse(
    await fs.readFile(path.resolve('tests/fixtures/instruction-texts.json'), 'utf8'),
  ) as { texts: { build: string; mode: string; text: string }[] };
  const runFile = path.join(dataRoot, 'data', 'projects', project.id, 'harness', 'runs', `${lineage.runId}.json`);
  const run = JSON.parse(await fs.readFile(runFile, 'utf8')) as { input: { instructions: string } };
  run.input.instructions = fixture.texts.find((row) => row.build === '0.1.8' && row.mode === 'auto')!.text;
  await fs.writeFile(runFile, JSON.stringify(run));
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption({ label: name });
  await expect(answers(page).last()).toContainText(answer);
  return { project, opened, lineage };
}
const updatePost = (response: Response) =>
  response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/answer-format');

test('"Update this conversation" moves a conversation opened before this build, says so once, and the next answer continues', async ({
  page,
}) => {
  const { project, opened, lineage } = await openedBefore(
    page,
    'Format update',
    'Where is the linen order?',
    'You said: Where is the linen order?',
  );

  // The conversation's own menu, then a confirmation that says what the update does to memory,
  // in the server's words: the route the next message takes, and whether history goes with it.
  await page.getByRole('button', { name: 'Conversation menu' }).click();
  await page.getByRole('menuitem', { name: 'Update this conversation' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Update this conversation?' });
  await expect(dialog).toContainText(
    'History sharing is on for AWS Bedrock, so Nectovia will carry over your most recent messages.',
  );

  // The first answer is lost on the way back, after the server carried the update out.
  const commands: string[] = [];
  let lose = true;
  const loseOnce = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    commands.push((route.request().postDataJSON() as { commandId: string }).commandId);
    if (!lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort('failed');
  };
  await page.route('**/answer-format', loseOnce);
  try {
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      "The update's answer didn't arrive. Press Update again to check whether it went through; it's never done twice.",
    );
    // Closed and opened again: the menu is still there, and asks about that same update.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Conversation menu' }).click();
    await page.getByRole('menuitem', { name: 'Update this conversation' }).click();
    await expect(dialog).toContainText('Your last update may have gone through already. Press Update to check; nothing is done twice.');
    const posted = page.waitForResponse(updatePost);
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    const answered = await posted;
    expect(answered.status()).toBe(200);
    // The same command both times, so the second press read back what the first did.
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(await answered.json()).toEqual({ updated: true, noteId: expect.stringMatching(/^Nlineage-/) });
  } finally {
    await page.unroute('**/answer-format', loseOnce);
  }
  await expect(dialog).toHaveCount(0);

  // One note, in plain words, after the exchange it ended.
  const note =
    'Nectovia started this conversation fresh because you updated it to the current instructions. Your earlier messages are still here, and it carried over the most recent ones.';
  const notes = page.locator('.turn.dio').filter({ hasText: 'started this conversation fresh' });
  await expect(notes).toHaveCount(1);
  await expect(notes.locator('.body')).toHaveText(note);
  // Nothing is left to update, so the menu goes.
  await expect(page.getByRole('button', { name: 'Conversation menu' })).toHaveCount(0);

  // The next answer continues, on a new lineage that carried the earlier exchange but not the note.
  const callsBefore = seen.length;
  await say(page, 'And the invoice?');
  await expect(answers(page).last()).toHaveText('You said: And the invoice?');
  await expect(page.locator('.transcript .turn .body')).toHaveText([
    'Where is the linen order?',
    'You said: Where is the linen order?',
    note,
    'And the invoice?',
    'You said: And the invoice?',
  ]);
  const after = (await api<ProjectState>(`/projects/${project.id}/state`)).conversations.find(
    (item) => item.id === opened.id,
  )!;
  expect(after.lineages).toEqual([
    expect.objectContaining({ runId: lineage.runId, retired: 'format-change', carry: { route: 'aws-bedrock' } }),
    expect.objectContaining({ mode: 'auto', generation: 2, carriedFrom: lineage.runId }),
  ]);
  const sent = JSON.stringify(seen.slice(callsBefore).at(-1)!.body.input);
  expect(sent).toContain('Earlier in this conversation');
  expect(sent).toContain('Person: Where is the linen order?');
  expect(sent).not.toContain('started this conversation fresh');
});

test('with history sharing off, the update says the conversation won\'t be remembered, and a grant given afterwards carries nothing', async ({
  page,
}) => {
  const { project, opened, lineage } = await openedBefore(
    page,
    'Format update without history',
    'Where is the linen order?',
    'You said: Where is the linen order?',
  );
  await shareHistory(project.id, false);

  // The confirmation says what the server decided: nothing is carried, and updating turns nothing on.
  await page.getByRole('button', { name: 'Conversation menu' }).click();
  await page.getByRole('menuitem', { name: 'Update this conversation' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Update this conversation?' });
  await expect(dialog).toContainText(
    "History sharing is off for AWS Bedrock, so your earlier messages stay on screen but Nectovia won't remember them. Updating doesn't turn sharing on.",
  );
  const posted = page.waitForResponse(updatePost);
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  expect((await posted).status()).toBe(200);
  await expect(dialog).toHaveCount(0);

  // The note says the same.
  const note =
    "Nectovia started this conversation fresh because you updated it to the current instructions. Your earlier messages are still here, but it won't remember them.";
  const notes = page.locator('.turn.dio').filter({ hasText: 'started this conversation fresh' });
  await expect(notes).toHaveCount(1);
  await expect(notes.locator('.body')).toHaveText(note);

  // Sharing turned on afterwards changes nothing the update decided: the next answer starts fresh,
  // without a second note.
  await shareHistory(project.id, true);
  const callsBefore = seen.length;
  await say(page, 'And the invoice?');
  await expect(answers(page).last()).toHaveText('You said: And the invoice?');
  await expect(page.locator('.transcript .turn .body')).toHaveText([
    'Where is the linen order?',
    'You said: Where is the linen order?',
    note,
    'And the invoice?',
    'You said: And the invoice?',
  ]);
  const sent = JSON.stringify(seen.slice(callsBefore).at(-1)!.body.input);
  expect(sent).toContain('And the invoice?');
  expect(sent).not.toContain('Earlier in this conversation');
  expect(sent).not.toContain('Where is the linen order?');
  const after = (await api<ProjectState>(`/projects/${project.id}/state`)).conversations.find(
    (item) => item.id === opened.id,
  )!;
  expect(after.lineages).toEqual([
    expect.objectContaining({ runId: lineage.runId, retired: 'format-change' }),
    expect.objectContaining({ mode: 'auto', generation: 2 }),
  ]);
  expect(after.lineages![0].carry).toBeUndefined();
  expect(after.lineages![1].carriedFrom).toBeUndefined();
});

test('an update the server refuses says why in the confirmation, which stays open, and changes nothing', async ({
  page,
}) => {
  // A proposal waiting for the person's choice: updating would strand it, so the server refuses.
  const { project, lineage } = await openedBefore(page, 'Format refusal', 'ACT order the usual', 'I can start that.');
  await expect(page.locator('.dio-card').getByRole('button', { name: 'Start', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Conversation menu' }).click();
  await page.getByRole('menuitem', { name: 'Update this conversation' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Update this conversation?' });
  await expect(dialog).toContainText(
    'History sharing is on for AWS Bedrock, so Nectovia will carry over your most recent messages.',
  );
  const posted = page.waitForResponse(updatePost);
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  const refused = await posted;
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'proposal_waiting' });

  // The server's reason, in its own words, in the confirmation, which stays open to try again.
  await expect(dialog.getByRole('alert')).toHaveText(
    'Nectovia is waiting for your choice on what it proposed. Start it, or send another message, before you update this conversation.',
  );
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();

  // Nothing changed: no note, the lineage still open, and the proposal still there to start.
  await expect(page.locator('.turn.dio').filter({ hasText: 'started this conversation fresh' })).toHaveCount(0);
  const [kept] = (await api<ProjectState>(`/projects/${project.id}/state`)).conversations;
  expect(kept.lineages).toEqual([expect.objectContaining({ runId: lineage.runId, generation: 1 })]);
  expect(kept.lineages![0].retired).toBeUndefined();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.dio-card').getByRole('button', { name: 'Start', exact: true })).toBeVisible();
});
