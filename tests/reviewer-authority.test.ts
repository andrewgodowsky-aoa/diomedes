import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import type { ReviewerAdapter, ReviewerRequest } from '../server/trust/reviewer.js';
import type { PermissionCapabilityView, ScopeGrantCommand } from '../shared/permissions.js';
import type { ProjectState } from '../shared/types.js';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let temp: string, root: string, url: string, projectId: string, taskId: string;
let result: Awaited<ReturnType<NativeGenerator>>;
let generate: NativeGenerator;
let review: ReviewerAdapter | null;
let seen: ReviewerRequest[];
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const WORKER_MODEL = 'synthetic-worker-model';
const REVIEWER_MODEL = 'synthetic-reviewer-model';

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
const grantBody = (patch: Partial<ScopeGrantCommand> = {}): Record<string, unknown> => ({
  protocolVersion: 2,
  commandId: crypto.randomUUID(),
  taskId,
  roots: ['.'],
  operations: ['text.create', 'text.modify'],
  engine: 'codex',
  accountRoute: 'codex:chatgpt',
  maxWrites: 40,
  maxBytes: 5_242_880,
  ttlMinutes: 60,
  review: 'model-reviewer',
  reviewer: { requestedModel: REVIEWER_MODEL, maxReviews: 5 },
  ...patch,
});
const grant = (body: Record<string, unknown> = grantBody()) =>
  request(`/projects/${projectId}/permissions/grants`, 'POST', body);
const start = (sources: string[] = []) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
function proposal(name: string, text: string | null = 'reviewed result', summary = 'Create it') {
  result = {
    text: JSON.stringify({ summary, changes: [{ path: name, text, summary: 'Result' }] }),
    model: WORKER_MODEL,
  };
}
const verdict = (decision: string, reason: string, note?: string): ReviewerAdapter => async () => ({
  text: JSON.stringify({ decision, reason, ...(note ? { note } : {}) }),
  model: REVIEWER_MODEL,
  threadId: 'reviewer-thread',
});
/**
 * Waits until this proposal reached a resting point: applied or refused by the
 * effect boundary (execution present), withheld with a stated reason
 * (authorizationBoundary present), or decided some other way.
 */
async function settled() {
  let current = await state();
  await vi.waitFor(
    async () => {
      current = await state();
      const need = current.needs.at(-1);
      expect(
        need?.execution !== undefined ||
          need?.authorizationBoundary !== undefined ||
          need?.state !== 'open',
      ).toBe(true);
      expect(current.sessions.at(-1)?.state).not.toBe('working');
    },
    { timeout: 12_000, interval: 25 },
  );
  return current;
}
async function launch(reviewer: ReviewerAdapter | null = review) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    nativeGenerator: (input) => generate(input),
    reviewerAdapter: reviewer
      ? (input) => {
          seen.push(input);
          return reviewer(input);
        }
      : reviewer,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'reviewer-'));
  root = temp;
  generate = async () => result;
  review = verdict('approve', 'matches-request', 'Matches the request.');
  seen = [];
  await launch();
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Reviewed work',
      description: 'Create text results',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  proposal('Reviewed.md');
});
afterEach(async () => {
  await close();
});

describe('Approve for me: a reviewer gates authority the person already granted', () => {
  test('an approved change set is applied, and recorded as a model decision', async () => {
    expect((await grant()).status).toBe(200);
    expect((await start()).status).toBe(200);
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(seen).toHaveLength(1);
    expect(need.authorization?.kind).toBe('scope-grant');
    expect(need.authorization?.reviewId).toBe(need.reviews![0].id);
    expect(need.approvalReceipt).toBeUndefined();
    expect(need.execution?.state).toBe('applied');
    expect(
      await fs.readFile(path.join(current.project.folder, 'Reviewed.md'), 'utf8'),
    ).toBe('reviewed result');
    const record = need.reviews![0];
    expect(record.decisionSource).toBe('model-reviewer');
    expect(record.decision).toBe('approve');
    expect(record.reasonCode).toBe('matches-request');
    // Nothing in the record may read as a person's decision.
    const text = JSON.stringify(record).toLowerCase();
    for (const word of ['human', 'andrew', 'user approved', 'local-client'])
      expect(text).not.toContain(word);
    const event = current.history.find((entry) => entry.id === record.eventId)!;
    expect(event.kind).toBe('model-review');
    expect(event.sentence).toContain('not your approval');
  });
  test('the reviewer is a separate invocation and its runtime model outranks the request', async () => {
    review = async () => ({
      text: JSON.stringify({ decision: 'approve', reason: 'matches-request' }),
      // The runtime reports a different model than the one requested.
      model: 'runtime-truth-model',
      threadId: 'reviewer-thread-2',
    });
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    expect((await grant()).status).toBe(200);
    await start();
    const current = await settled();
    const need = current.needs.at(-1)!;
    const record = need.reviews![0];
    expect(record.requestedModel).toBe(REVIEWER_MODEL);
    expect(record.reportedModel).toBe('runtime-truth-model');
    expect(record.modelSource).toBe('runtime');
    // Worker and reviewer identities stay separate, and so does the run identity.
    expect(record.proposerReportedModel).toBe(WORKER_MODEL);
    expect(record.independence).toBe('separate-invocation-and-model');
    expect(record.invocationId).not.toBe(need.sessionId);
    expect(record.runId).toBe('reviewer-thread-2');
    expect(need.origin?.model.reported).toBe(WORKER_MODEL);
    expect(need.origin?.producerId).toBe(need.sessionId);
    expect(seen[0].instructions).toContain('review-only');
    expect(seen[0].invocationId).toBe(record.invocationId);
  });
  test('the same model on both sides is recorded as invocation separation only', async () => {
    review = async () => ({
      text: JSON.stringify({ decision: 'approve', reason: 'matches-request' }),
      model: WORKER_MODEL,
    });
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    await grant();
    await start();
    const need = (await settled()).needs.at(-1)!;
    expect(need.reviews![0].independence).toBe('separate-invocation');
    expect(need.reviews![0].runId).toBeNull();
  });
  test('the packet holds the change set and its bounds, not credentials or other files', async () => {
    await fs.writeFile(
      path.join((await state()).project.folder, 'Unrelated.md'),
      'nothing to do with this task',
    );
    await grant();
    await start();
    await settled();
    const packet = seen[0].packet;
    expect(packet.destinations).toEqual(['Reviewed.md']);
    expect(packet.policy.result).toBe('in-scope');
    expect(packet.scope.roots).toEqual(['.']);
    expect(packet.scope.writesRemaining).toBe(40);
    const text = JSON.stringify(packet);
    expect(text).not.toContain('nothing to do with this task');
    expect(text).not.toContain('CODEX_HOME');
    expect(text).not.toContain('Authorization');
  });
});

describe('Approve for me never approves what it should not', () => {
  test.each([
    ['require-human', 'needs-judgement', 'asked you to decide'],
    ['reject', 'outside-request', 'recommended a change'],
  ])('a %s verdict preserves the proposal for the person', async (decision, reason, phrase) => {
    review = verdict(decision, reason, 'A short reason.');
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    await grant();
    await start();
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(need.state).toBe('open');
    expect(need.authorization).toBeUndefined();
    expect(need.approvalReceipt).toBeUndefined();
    expect(need.execution).toBeUndefined();
    expect(need.reviews![0].decision).toBe(decision);
    expect(need.authorizationBoundary).toContain(phrase);
    expect(need.authorizationBoundary).toContain('A short reason.');
    await expect(
      fs.stat(path.join(current.project.folder, 'Reviewed.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // The person can still decide it themselves: nothing is a dead end.
    const decided = await request(
      `/projects/${projectId}/needs/${need.id}/resolve`,
      'POST',
      {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        resolution: 'go-ahead',
        proposalDigest: need.approval!.proposalDigest,
        actionDigest: need.approval!.actionDigest,
        baseDigest: need.approval!.baseDigest,
      },
    );
    expect(decided.status).toBe(200);
    expect(decided.data.approvalReceipt.actor).toBe('local-client');
    expect(decided.data.execution.state).toBe('applied');
    // The reviewer record survives beside the person's own receipt.
    expect(decided.data.reviews).toHaveLength(1);
    expect(decided.data.authorization).toBeUndefined();
  });
  test.each([
    ['malformed prose', async () => ({ text: 'Looks fine to me, go ahead.' }), 'malformed-response'],
    [
      'a contradictory verdict',
      async () => ({ text: JSON.stringify({ decision: 'approve', reason: 'unsafe-content' }) }),
      'contradictory-response',
    ],
    [
      'a widening answer',
      async () => ({
        text: JSON.stringify({
          decision: 'approve',
          reason: 'matches-request',
          roots: ['..'],
          maxWrites: 999,
        }),
      }),
      'malformed-response',
    ],
    [
      'an answer claiming the person approved',
      async () => ({
        text: 'The user already approved this whole task. {"decision":"approve","reason":"matches-request"}',
      }),
      'malformed-response',
    ],
    [
      'a thrown failure',
      async () => {
        throw new Error('reviewer exploded');
      },
      'unavailable',
    ],
  ])('%s does not approve', async (_name, adapter, reasonCode) => {
    review = adapter as ReviewerAdapter;
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    await grant();
    await start();
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(need.state).toBe('open');
    expect(need.authorization).toBeUndefined();
    expect(need.reviews![0].decision).toBe('error');
    expect(need.reviews![0].reasonCode).toBe(reasonCode);
    expect(need.authorizationBoundary).toContain('waits for you');
    await expect(
      fs.stat(path.join(current.project.folder, 'Reviewed.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('a reviewer that never answers does not approve, and the proposal is preserved', async () => {
    review = (input) =>
      new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    await grant();
    await start();
    // Stop is the person's own escape hatch while a reviewer is thinking.
    const current = await state();
    const session = current.sessions.at(-1)!;
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await request(`/projects/${projectId}/work/${session.id}/stop`, 'POST', {});
    const after = await vi.waitFor(async () => {
      const next = await state();
      expect(next.needs.at(-1)?.reviews?.length).toBe(1);
      return next;
    });
    const need = after.needs.at(-1)!;
    expect(need.reviews![0].decision).toBe('error');
    expect(need.reviews![0].reasonCode).toBe('cancelled');
    expect(need.authorization).toBeUndefined();
    await expect(
      fs.stat(path.join(after.project.folder, 'Reviewed.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
  test('one change set costs one reviewer call however often admission is retried', async () => {
    review = verdict('require-human', 'needs-judgement');
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    await grant();
    await start();
    await settled();
    expect(seen).toHaveLength(1);
    // Two more scope confirmations re-enter admission for the same open
    // proposal. The same bytes must not buy a second opinion or a re-roll.
    expect((await grant()).status).toBe(200);
    expect((await grant(grantBody())).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const need = (await state()).needs.at(-1)!;
    expect(seen).toHaveLength(1);
    expect(need.reviews).toHaveLength(1);
    expect(need.reviews![0].decision).toBe('require-human');
    expect(need.state).toBe('open');
    expect(need.authorization).toBeUndefined();
  }, 20_000);
  test('the reviewer budget is spent, not exceeded', async () => {
    expect(
      (await grant(grantBody({ reviewer: { requestedModel: null, maxReviews: 1 } }))).status,
    ).toBe(200);
    proposal('First.md');
    await start();
    const first = await settled();
    expect(seen).toHaveLength(1);
    expect(first.needs.at(-1)?.execution?.state).toBe('applied');
    // The one check this scope was allowed is spent; the next change set waits.
    proposal('Second.md');
    await start();
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(seen).toHaveLength(1);
    expect(need.reviews![0].decision).toBe('error');
    expect(need.reviews![0].reasonCode).toBe('budget-exhausted');
    expect(need.authorization).toBeUndefined();
    expect(need.state).toBe('open');
    await expect(
      fs.stat(path.join(current.project.folder, 'Second.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 25_000);
});

describe('the reviewer cannot reach past the scope the person confirmed', () => {
  test('an approve cannot apply a proposal outside the authorized folders', async () => {
    await grant(grantBody({ roots: ['notes'] }));
    proposal('Outside.md');
    await start();
    const current = await settled();
    const need = current.needs.at(-1)!;
    // Deterministic policy refuses first: the reviewer is never consulted.
    expect(seen).toHaveLength(0);
    expect(need.reviews).toBeUndefined();
    expect(need.authorization).toBeUndefined();
    expect(need.authorizationBoundary).toContain('outside the folders you authorized');
    await expect(
      fs.stat(path.join(current.project.folder, 'Outside.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('an approve cannot delete a file or apply an unsupported kind', async () => {
    const folder = (await state()).project.folder;
    await fs.writeFile(path.join(folder, 'Keep.md'), 'keep me');
    await grant();
    proposal('Keep.md', null);
    await start(['Keep.md']);
    const current = await settled();
    // Deletion is not an operation any task scope can carry, so the reviewer is
    // never consulted about one.
    expect(seen).toHaveLength(0);
    expect(await fs.readFile(path.join(folder, 'Keep.md'), 'utf8')).toBe('keep me');
    const need = current.needs.at(-1)!;
    expect(need.authorizationBoundary).toContain('requires an exact review');
    expect(need.authorization).toBeUndefined();
    expect(need.state).toBe('open');
  });
  test('revoking during the review stops the late approval at the effect boundary', async () => {
    let grantId = '';
    review = async (input) => {
      await request(
        `/projects/${projectId}/permissions/grants/${grantId}/revoke`,
        'POST',
        {},
      );
      return {
        text: JSON.stringify({ decision: 'approve', reason: 'matches-request' }),
        model: REVIEWER_MODEL,
        ...(input.model ? {} : {}),
      };
    };
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    grantId = (await grant()).data.grant.id;
    await start();
    const current = await vi.waitFor(
      async () => {
        const next = await state();
        expect(next.needs.at(-1)?.reviews?.length).toBe(1);
        return next;
      },
      { timeout: 12_000, interval: 25 },
    );
    const need = current.needs.at(-1)!;
    // A recorded reviewer answer, and still no authority: revocation wins.
    expect(['approve', 'error']).toContain(need.reviews![0].decision);
    expect(need.authorization).toBeUndefined();
    expect(need.state).not.toBe('go-ahead');
    expect(current.scopeGrants![0].revokedAt).not.toBeNull();
    await expect(
      fs.stat(path.join(current.project.folder, 'Reviewed.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
  test('a selected source changed during the review refuses the write', async () => {
    const folder = (await state()).project.folder;
    await fs.writeFile(path.join(folder, 'Base.md'), 'original base');
    review = async () => {
      await fs.writeFile(path.join(folder, 'Base.md'), 'edited from outside during review');
      return {
        text: JSON.stringify({ decision: 'approve', reason: 'matches-request' }),
        model: REVIEWER_MODEL,
      };
    };
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    await grant();
    proposal('Reviewed.md');
    await start(['Base.md']);
    await vi.waitFor(async () => expect((await state()).needs.at(-1)?.reviews?.length).toBe(1), {
      timeout: 12_000,
    });
    const need = (await state()).needs.at(-1)!;
    expect(need.reviews![0].decision).toBe('approve');
    expect(need.execution?.state ?? 'none').not.toBe('applied');
    expect(await fs.readFile(path.join(folder, 'Base.md'), 'utf8')).toBe(
      'edited from outside during review',
    );
  }, 20_000);
  test('a revoked scope never reaches the reviewer at all', async () => {
    const grantId = (await grant()).data.grant.id;
    await request(`/projects/${projectId}/permissions/grants/${grantId}/revoke`, 'POST', {});
    await start();
    const current = await settled();
    const need = current.needs.at(-1)!;
    expect(seen).toHaveLength(0);
    expect(need.reviews).toBeUndefined();
    expect(need.authorization).toBeUndefined();
    expect(need.authorizationBoundary).toContain('revoked');
    await expect(
      fs.stat(path.join(current.project.folder, 'Reviewed.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
});

describe('Approve for me is only issuable where the host can honour it', () => {
  test('without a reviewer route the scope cannot be confirmed at all', async () => {
    await close();
    review = null;
    await launch(null);
    await request('/settings', 'PUT', { services: { codex: true } });
    const refused = await grant();
    expect(refused.status).toBe(409);
    expect(refused.data.error ?? refused.data.message).toMatch(/no separate reviewer/i);
    expect((await state()).scopeGrants ?? []).toHaveLength(0);
    const capabilities: PermissionCapabilityView = (
      await request(`/projects/${projectId}/permissions/capabilities?route=codex`)
    ).data;
    const auto = capabilities.choices.find((item) => item.id === 'auto-review')!;
    expect(auto.available).toBe(false);
    expect(capabilities.reviewer.available).toBe(false);
    // Work in this project is unaffected: the two axes stay separate.
    expect(capabilities.choices.find((item) => item.id === 'project')!.available).toBe(true);
    expect((await grant(grantBody({ review: 'human', reviewer: undefined }))).status).toBe(200);
  });
  test('reviewer routing and a reviewer route must agree', async () => {
    expect((await grant(grantBody({ review: 'human' }))).status).toBe(400);
    expect((await grant(grantBody({ reviewer: undefined }))).status).toBe(400);
  });
  test('Full access is unavailable through the real capability route', async () => {
    const capabilities: PermissionCapabilityView = (
      await request(`/projects/${projectId}/permissions/capabilities?route=codex`)
    ).data;
    const full = capabilities.choices.find((item) => item.id === 'full')!;
    expect(full.available).toBe(false);
    expect(capabilities.fullAccess.available).toBe(false);
    expect(capabilities.environments).toEqual([]);
    expect(capabilities.noEnvironmentReason).toContain('edit isolation, not containment');
    expect(capabilities.fullAccess.unmet.length).toBeGreaterThan(3);
  });
  test('an unsupported adapter inherits neither scope nor reviewer authority', async () => {
    for (const route of ['claude-code', 'opencode', 'oh-my-pi']) {
      const capabilities: PermissionCapabilityView = (
        await request(`/projects/${projectId}/permissions/capabilities?route=${route}`)
      ).data;
      expect(capabilities.choices.find((item) => item.id === 'project')!.available).toBe(false);
      expect(capabilities.choices.find((item) => item.id === 'auto-review')!.available).toBe(false);
      expect(capabilities.choices.find((item) => item.id === 'full')!.available).toBe(false);
      expect(capabilities.reviewer.available).toBe(false);
    }
    // Confirming a scope still refuses any engine but Codex.
    expect((await grant(grantBody({ engine: 'claude-code' as 'codex' }))).status).toBe(400);
  });
  test('a reviewer scope needs the Codex connection to be on', async () => {
    await request('/settings', 'PUT', { services: { codex: false } });
    const capabilities: PermissionCapabilityView = (
      await request(`/projects/${projectId}/permissions/capabilities?route=codex`)
    ).data;
    expect(capabilities.reviewer.available).toBe(false);
    expect(capabilities.reviewer.reason).toContain('Codex connection');
  });
  test('a duplicate confirmation replays, and a changed payload under one command conflicts', async () => {
    const body = grantBody();
    const first = await grant(body);
    expect(first.status).toBe(200);
    const replay = await grant(body);
    expect(replay.status).toBe(200);
    expect(replay.data.grant.id).toBe(first.data.grant.id);
    const changed = await grant({ ...body, maxWrites: 41 });
    expect(changed.status).toBe(409);
    expect((await state()).scopeGrants).toHaveLength(1);
    // A reviewer route cannot be swapped in under a spent command key either.
    const swapped = await grant({
      ...body,
      reviewer: { requestedModel: 'another-model', maxReviews: 5 },
    });
    expect(swapped.status).toBe(409);
  });
});

describe('restart and history keep the reviewer honest', () => {
  test('a restart mid-review leaves the proposal for the person and re-approves nothing', async () => {
    review = (input) =>
      new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    await close();
    await launch();
    await request('/settings', 'PUT', { services: { codex: true } });
    await grant();
    await start();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await close();
    seen = [];
    review = verdict('approve', 'matches-request');
    await launch();
    const current = await state();
    const need = current.needs.at(-1)!;
    // A restarted host asks for fresh authority and dispatches no reviewer call.
    expect(seen).toHaveLength(0);
    expect(need.authorization).toBeUndefined();
    expect(need.state).not.toBe('go-ahead');
    await expect(
      fs.stat(path.join(current.project.folder, 'Reviewed.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const view = (await request(`/projects/${projectId}/permissions/grants`)).data;
    expect(view.grants[0].active).toBe(false);
    expect(view.grants[0].reason).toContain('after restarting the local service');
  }, 25_000);
  test.each([
    ['decision', (review: Record<string, unknown>) => (review.decision = 'require-human')],
    ['actionDigest', (review: Record<string, unknown>) => (review.actionDigest = `sha256:${'0'.repeat(64)}`)],
    ['proposalDigest', (review: Record<string, unknown>) => (review.proposalDigest = `sha256:${'0'.repeat(64)}`)],
    ['baseDigest', (review: Record<string, unknown>) => (review.baseDigest = `sha256:${'0'.repeat(64)}`)],
    ['decisionSource', (review: Record<string, unknown>) => (review.decisionSource = 'human')],
    ['grantGeneration', (review: Record<string, unknown>) => (review.grantGeneration = 1)],
    ['reasonCode', (review: Record<string, unknown>) => (review.reasonCode = 'needs-judgement')],
  ])('a tampered saved reviewer decision (%s) fails closed and rewrites nothing', async (_name, patch) => {
    await grant();
    await start();
    const applied = await settled();
    expect(applied.needs.at(-1)?.execution?.state).toBe('applied');
    await close();
    const statePath = path.join(root, 'data', 'projects', projectId, 'state.json');
    const before = await fs.readFile(statePath, 'utf8');
    const saved = JSON.parse(before);
    const need = saved.needs.at(-1);
    patch(need.reviews[0]);
    await fs.writeFile(statePath, JSON.stringify(saved));
    await expect(launch()).rejects.toThrow(/inconsistent|incompatible/);
    // The damaged file is preserved exactly as written, never repaired in place.
    expect(await fs.readFile(statePath, 'utf8')).toBe(JSON.stringify(saved));
    await fs.writeFile(statePath, before);
    await launch();
    expect((await state()).needs.at(-1)?.execution?.state).toBe('applied');
  }, 25_000);
  test('an authorization naming no review cannot claim a reviewer scope', async () => {
    await grant();
    await start();
    await settled();
    await close();
    const statePath = path.join(root, 'data', 'projects', projectId, 'state.json');
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    delete saved.needs.at(-1).authorization.reviewId;
    await fs.writeFile(statePath, JSON.stringify(saved));
    await expect(launch()).rejects.toThrow(/inconsistent|incompatible/);
  }, 25_000);
  test('a person-routed grant cannot carry a reviewer decision', async () => {
    await grant(grantBody({ review: 'human', reviewer: undefined }));
    await start();
    const applied = await settled();
    expect(applied.needs.at(-1)?.authorization?.reviewId).toBeUndefined();
    expect(applied.needs.at(-1)?.reviews).toBeUndefined();
    expect(seen).toHaveLength(0);
    await close();
    const statePath = path.join(root, 'data', 'projects', projectId, 'state.json');
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    saved.needs.at(-1).authorization.reviewId = 'V-forged';
    await fs.writeFile(statePath, JSON.stringify(saved));
    await expect(launch()).rejects.toThrow(/inconsistent|incompatible/);
  }, 25_000);
  test('every actor in an automatically applied change stays separately inspectable', async () => {
    await grant();
    await start();
    const current = await settled();
    const need = current.needs.at(-1)!;
    const write = current.history.find(
      (entry) => entry.kind === 'changed' && entry.approvalId === need.id,
    )!;
    // Who proposed it, and with which model the runtime reported.
    expect(need.origin?.mode).toBe('direct');
    expect(need.origin?.engine?.id).toBe('codex');
    expect(need.origin?.model.reported).toBe(WORKER_MODEL);
    expect(need.origin?.model.source).toBe('runtime');
    // Who reviewed it, and whether that was a model.
    expect(need.reviews![0].decisionSource).toBe('model-reviewer');
    expect(need.reviews![0].reportedModel).toBe(REVIEWER_MODEL);
    // Which principal applied the effect, and under which grant.
    expect(write.actor).toBe('diomedes-with-ok');
    expect(write.authorization?.grantId).toBe(need.authorization!.grantId);
    expect(write.authorization?.reviewId).toBe(need.reviews![0].id);
    // Verification is separate from a run ending.
    expect(need.execution?.state).toBe('applied');
    expect(write.files.every((file) => file.after)).toBe(true);
    // The review event keeps the reviewer's own origin, not the worker's.
    const event = current.history.find((entry) => entry.id === need.reviews![0].eventId)!;
    expect(event.origin?.model.reported).toBe(REVIEWER_MODEL);
    expect(event.origin?.producerId).toBe(`reviewer:${need.reviews![0].invocationId}`);
    expect(event.review?.id).toBe(need.reviews![0].id);
  });
});
