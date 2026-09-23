/**
 * The one-time Cloud sharing upgrade (owner decision, 2026-09-23).
 *
 * A project that already sent to a route before default-deny sharing landed keeps that route,
 * derived once from its recorded turns. The upgrade never allows a document, or history, that
 * the record does not show every kept route already received, so it can only narrow what those
 * routes had. A project with no such record, a new project and Home stay default-deny, and an
 * owner's later change is never undone by it.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';
import { changeCloudSharing, cloudSharing, requireCloudSharing } from '../server/cloud-sharing';
import type { Conversation, Route, Turn } from '../shared/types';

let temp: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-sharing-upgrade-'));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

const open = async () => {
  const store = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
  await store.init();
  return store;
};
const at = '2026-09-20T12:00:00.000Z';
let serial = 0;
const turn = (role: Turn['role'], route: Route, text: string, sources: string[] = []): Turn => ({
  id: `T${++serial}`,
  role,
  mode: 'ask',
  text,
  at,
  sources,
  route,
});
const thread = (projectId: string, turns: Turn[]): Conversation => ({
  id: `C${++serial}`,
  attachedTo: { kind: 'project', ref: projectId },
  turns,
  name: 'Earlier',
  createdAt: at,
  updatedAt: at,
  taskId: null,
  helper: null,
  permission: 'show-first',
  mode: 'ask',
});
const denied = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return (error as { code?: string; details?: { code?: string } }).details?.code ?? (error as { code?: string }).code ?? 'thrown';
  }
  return 'allowed';
};

/** A project as an earlier build left it: turns on cloud routes and no sharing record. */
async function upgradedFixture() {
  const store = await open();
  const project = await store.createProject('Harbor Street', path.join(temp, 'harbor'));
  const state = store.state(project.id);
  state.conversations.push(
    // Claude Code answered twice in one thread: the menu and payroll went, and so did history.
    thread(project.id, [
      turn('you', 'claude-code', 'What sells best?', ['menu.md', 'payroll.csv']),
      turn('assistant', 'claude-code', 'Soup.'),
      turn('you', 'claude-code', 'And on Fridays?'),
      turn('assistant', 'claude-code', 'Fish.'),
    ]),
    // Codex answered once, with only the menu.
    thread(project.id, [
      turn('you', 'codex', 'Summarise the menu.', ['menu.md']),
      turn('assistant', 'codex', 'Three soups.'),
    ]),
    // OpenCode was asked for work that never produced a proposal: nothing is shown to have gone.
    thread(project.id, [
      turn('you', 'opencode', 'Tidy the menu.', ['menu.md']),
      turn('assistant', 'opencode', 'Preparing a proposal.'),
    ]),
    // Cursor was asked and never answered.
    thread(project.id, [turn('you', 'cursor', 'Hello?', ['payroll.csv'])]),
  );
  delete state.cloudSharing;
  await store.persist(state);
  return project.id;
}

test('an upgraded project keeps the routes it used, and only what every kept route already received', async () => {
  const id = await upgradedFixture();
  const store = await open();
  const state = store.state(id);
  const policy = cloudSharing(state);
  expect(policy).toMatchObject({
    version: 1,
    routes: ['claude-code', 'codex'],
    // Payroll went only to Claude Code. One document list serves every route, so keeping it
    // would send it to Codex too; the upgrade leaves it out rather than widen.
    documents: ['menu.md'],
    // Codex never had an earlier turn sent, so history stays off for both.
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  expect(state.cloudSharing?.upgrade).toMatchObject({ from: 'recorded-history' });

  expect(denied(() => requireCloudSharing(state, 'codex', []))).toBe('allowed');
  expect(denied(() => requireCloudSharing(state, 'codex', ['menu.md']))).toBe('allowed');
  expect(denied(() => requireCloudSharing(state, 'claude-code', ['menu.md']))).toBe('allowed');
  expect(denied(() => requireCloudSharing(state, 'codex', ['payroll.csv']))).toBe('cloud_sharing_denied');
  expect(denied(() => requireCloudSharing(state, 'claude-code', [], true))).toBe('cloud_sharing_denied');
  // Routes the record never shows answering stay off.
  expect(denied(() => requireCloudSharing(state, 'opencode', []))).toBe('cloud_sharing_denied');
  expect(denied(() => requireCloudSharing(state, 'cursor', []))).toBe('cloud_sharing_denied');
  expect(denied(() => requireCloudSharing(state, 'aws-bedrock', []))).toBe('cloud_sharing_denied');

  // Everything new stays default-deny.
  const fresh = await store.createProject('New cafe', path.join(temp, 'cafe'));
  expect(cloudSharing(store.state(fresh.id)).version).toBe(0);
  expect(denied(() => requireCloudSharing(store.state(fresh.id), 'codex', []))).toBe('cloud_sharing_denied');
});

test('history is kept only when every kept route already had an earlier turn sent', async () => {
  const store = await open();
  const project = await store.createProject('Linen', path.join(temp, 'linen'));
  const state = store.state(project.id);
  state.conversations.push(
    thread(project.id, [
      turn('you', 'codex', 'One', ['menu.md']),
      turn('assistant', 'codex', 'A'),
      turn('you', 'codex', 'Two', ['menu.md']),
      turn('assistant', 'codex', 'B'),
    ]),
  );
  delete state.cloudSharing;
  await store.persist(state);
  const policy = cloudSharing((await open()).state(project.id));
  expect(policy).toMatchObject({ routes: ['codex'], documents: ['menu.md'], shareConversationHistory: true });
});

test('the upgrade runs once: an owner change survives a restart, and Home is never upgraded', async () => {
  const id = await upgradedFixture();
  let store = await open();
  const state = store.state(id);
  const upgrade = state.cloudSharing?.upgrade;
  changeCloudSharing(state, {
    expectedVersion: 1,
    routes: [],
    documents: [],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  await store.persist(state);
  store = await open();
  expect(cloudSharing(store.state(id))).toMatchObject({ version: 2, routes: [], documents: [] });
  // The record of what the upgrade kept stays with the policy, as provenance and not authority.
  expect(store.state(id).cloudSharing?.upgrade).toEqual(upgrade);

  const home = await store.provisionHome();
  const homeState = store.state(home.projectId);
  homeState.conversations[0].turns.push(
    turn('you', 'aws-bedrock', 'Good morning'),
    turn('assistant', 'aws-bedrock', 'Morning.'),
    turn('you', 'aws-bedrock', 'Plans?'),
    turn('assistant', 'aws-bedrock', 'Three.'),
  );
  delete homeState.cloudSharing;
  await store.persist(homeState);
  store = await open();
  expect(cloudSharing(store.state(home.projectId)).version).toBe(0);
});
