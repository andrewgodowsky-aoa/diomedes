/**
 * Job check-ins on this computer (Andrew, 2026-10-05): where the amount comes from, what one raise is,
 * how work that nobody was watching stops and is kept going, and the words. Fakes only.
 *
 * The whole-app paths (the real routes over the faux account service, a loop that stops and is retried)
 * are in `job-check-ins-host.test.ts`; this file pins the rules under them.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import express from 'express';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CHECK_IN_KEEP_GOING,
  CHECK_IN_STOP,
  UNATTENDED_CHECK_IN_UNKNOWN,
  checkInCopy,
  checkInMore,
  checkInQuestion,
  isCheckInRefusal,
  jobTierOf,
  unattendedCheckInLine,
  type JobShape,
  type JobTier,
} from '../shared/job-caps.js';
import { creditAmount, micro, type MicroUsd } from '../shared/managed-usage.js';
import { checkInAmount, codeCheckIns, resolveCheckIns, setCheckInOverrideInput } from '../shared/job-check-ins.js';
import { JobCaps, jobKeyFor } from '../server/job-caps.js';
import { estimateView, mountJobCapRoutes, type JobPlan } from '../server/job-cap-routes.js';
import { CHECK_IN_AMOUNT_INVALID, CHECK_INS_NOT_SIGNED_IN, mountJobCheckInRoutes } from '../server/job-check-in-routes.js';
import { ApiError } from '../server/paths.js';
import { ModelApiError } from '../server/engines/model-api-core.js';
import { FileRunStore, RunService, ToolRegistry, type ModelAdapter } from '../server/harness/index.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { NativeLoop, type LoopToolBinding } from '../server/harness/native-loop.js';
import { presentRun } from '../server/harness/present.js';
import { loopOutcome, loopView } from '../shared/native-loop.js';
import { taskEvidence } from '../shared/task-evidence.js';
import { needsYou } from '../shared/needs-you.js';
import type { CapabilityManifest, HarnessBudget, HarnessPrincipal, ModelRequest, ModelResult } from '../shared/harness.js';
import type { Session, Task } from '../shared/types.js';
import { JobCapWarning } from '../client/console/JobCapWarning';
import { CHECK_INS_INVALID, amountsText, loadJobCheckIns, parseAmounts, saveJobCheckIns } from '../client/console/JobCheckIns';
import { RunControls } from '../client/console/StopMenu';
import { defaultWorkContract } from '../server/durable-controls.js';
import { workControlProfile } from '../shared/session-controls.js';

const credits = (n: number) => creditAmount(n);
const SHAPE: JobShape = {
  inputBytes: 20_000,
  messages: 3,
  maxOutputTokensPerStep: 4_096,
  maxSteps: 8,
  maxRequestBytes: 200_000,
  toolResultBytesPerStep: 200_000,
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-job-check-ins-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A host whose account service says each tier's amount, and whose threads carry a style the test can change. */
function host(amounts: { current: Record<JobTier, number> | null | 'throws' } = { current: null }) {
  const styles = new Map<string, JobTier>();
  const caps = new JobCaps(path.join(dir, 'data'), {
    tierOf: (_projectId, threadId) => jobTierOf(threadId ? (styles.get(threadId) ?? null) : null),
    checkInOf: async (_projectId, tier) => {
      if (amounts.current === 'throws') throw new Error('The account service did not answer.');
      return amounts.current ? credits(amounts.current[tier]) : null;
    },
  });
  return { caps, styles, amounts };
}
const BUSINESS = { efficient: 40, focused: 60, thorough: 80 } as const;

describe('where the amount comes from', () => {
  test('a job is held to the amount the account service names, pinned when it starts', async () => {
    const h = host({ current: { ...BUSINESS } });
    await h.caps.init();
    h.styles.set('t', 'focused');
    const first = await h.caps.scope('p', 'cmd-1', 't');
    expect(first.capMicroUsd).toBe(credits(60));
    // The business changes its amount: the job already running keeps the one it started with, the next takes the new one.
    h.amounts.current = { efficient: 40, focused: 90, thorough: 80 };
    expect((await h.caps.scope('p', 'cmd-1', 't')).capMicroUsd).toBe(credits(60));
    expect((await h.caps.scope('p', 'cmd-2', 't')).capMicroUsd).toBe(credits(90));
    // And it is recorded, so a restart does not move it.
    const again = host({ current: { ...BUSINESS } });
    await again.caps.init();
    expect((await again.caps.scope('p', 'cmd-1', 't')).capMicroUsd).toBe(credits(60));
  });

  test('without an amount, or when the account service cannot say it, the code default applies', async () => {
    const none = host({ current: null });
    await none.caps.init();
    expect((await none.caps.scope('p', 'a', 't')).capMicroUsd).toBe(credits(100));
    const broken = host({ current: 'throws' });
    await broken.caps.init();
    broken.styles.set('t', 'thorough');
    expect((await broken.caps.scope('p', 'b', 't')).capMicroUsd).toBe(credits(500));
    expect(await broken.caps.checkInFor('p', 'focused')).toBe(credits(250));
  });

  test('a job written before check-ins keeps the cap it had: the code default for its tier', async () => {
    const stored = [
      {
        projectId: 'p', jobId: 'old', key: jobKeyFor('p', 'old'), tier: 'efficient', pinnedAt: '2026-09-23T00:00:00.000Z', raise: null, stop: null,
      },
    ];
    await fs.mkdir(path.join(dir, 'data'), { recursive: true });
    await fs.writeFile(path.join(dir, 'data', 'job-caps.json'), JSON.stringify({ v: 1, jobs: stored }));
    const h = host({ current: { ...BUSINESS } });
    await h.caps.init();
    expect((await h.caps.scope('p', 'old', null, 'efficient')).capMicroUsd).toBe(credits(100));
  });

  test('the shared rule: a business\'s own amount, else staff\'s default, else the code default', () => {
    expect(codeCheckIns().credits).toEqual({ efficient: 100, focused: 250, thorough: 500 });
    const staff = { version: 3, amounts: { efficient: 120, focused: 260, thorough: 520 } };
    const resolved = resolveCheckIns(staff, { efficient: 30, focused: null, thorough: null });
    expect(resolved.credits).toEqual({ efficient: 30, focused: 260, thorough: 520 });
    expect(resolved.source).toEqual({ efficient: 'business', focused: 'staff', thorough: 'staff' });
    expect(checkInAmount(resolved, 'efficient')).toBe(credits(30));
    expect(resolveCheckIns(null, null).source).toEqual({ efficient: 'code', focused: 'code', thorough: 'code' });
  });

  test('an amount is whole credits from 1 up, and a request names nothing else', () => {
    const ok = (amounts: unknown) => setCheckInOverrideInput.safeParse({ amounts }).success;
    expect(ok({ efficient: 1, focused: null, thorough: 100_000 })).toBe(true);
    for (const amounts of [
      { efficient: 0, focused: null, thorough: null },
      { efficient: -5, focused: null, thorough: null },
      { efficient: 2.5, focused: null, thorough: null },
      { efficient: 100_001, focused: null, thorough: null },
      { efficient: 5, focused: null },
      { efficient: 5, focused: null, thorough: null, jobId: 'x' },
    ])
      expect(ok(amounts)).toBe(false);
  });
});

describe('the estimate names the amount', () => {
  const plan: JobPlan = {
    threadId: 't',
    metering: 'metered',
    rates: { input: 600_000_000, output: 2_400_000_000, cacheRead: 90_000_000, cacheWrite: 750_000_000 },
    shape: { ...SHAPE, inputBytes: 180_000 },
  };

  test('the warning reads the business\'s amount and what going over lets the job use', () => {
    const view = estimateView('efficient', plan, credits(40));
    expect(view.estimate.capMicroUsd).toBe(credits(40));
    expect(view.warning?.body).toMatch(/Efficient jobs check in at 40 credits\.$/);
    expect(view.warning?.raise).toBe('Going over lets this job use 80 credits before it checks in, for this job only.');
    expect(view.raisedToMicroUsd).toBe(credits(80));
  });

  test('without an amount given it is the tier\'s code default', () => {
    expect(estimateView('focused', plan).estimate.capMicroUsd).toBe(credits(250));
  });
});

describe('one raise is one more amount', () => {
  test('before sending: the job runs to twice its amount, for that job only', async () => {
    const h = host({ current: { ...BUSINESS } });
    await h.caps.init();
    h.styles.set('t', 'efficient');
    const raised = await h.caps.raiseBeforeSend({ projectId: 'p', jobId: 'cmd-1', threadId: 't', neededMicroUsd: credits(500), by: 'local-person' });
    // Never sized from the estimate: 500 credits needed raises it by one amount all the same.
    expect(raised.raise).toMatchObject({ toMicroUsd: credits(80), basis: 'estimate' });
    expect((await h.caps.scope('p', 'cmd-2', 't')).capMicroUsd).toBe(credits(40));
  });

  test('after a stop: the new job continues the old one, raised from the cap it reached by one amount', async () => {
    const h = host({ current: { ...BUSINESS } });
    await h.caps.init();
    h.styles.set('t', 'efficient');
    const first = await h.caps.scope('p', 'cmd-1', 't');
    await h.caps.noteStop(first.id, { usedMicroUsd: credits(35), capMicroUsd: credits(40), neededMicroUsd: credits(45) });
    h.amounts.current = { efficient: 50, focused: 60, thorough: 80 };
    const second = await h.caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-2', fromJobId: 'cmd-1', threadId: 't', by: 'local-person' });
    // The cap it reached plus one amount as the business has it now.
    expect(second.raise).toMatchObject({ basis: 'overrun', fromJobId: 'cmd-1', toMicroUsd: credits(90) });
    expect(second.baseMicroUsd).toBe(credits(40));
  });

  test('on the same job, for work that is resumed as itself: once per stop, and again at the next', async () => {
    const h = host({ current: { ...BUSINESS } });
    await h.caps.init();
    h.styles.set('t', 'efficient');
    const job = await h.caps.scope('p', 'loop-1', 't');
    await expect(h.caps.raiseInPlace({ projectId: 'p', jobId: 'loop-1', by: 'local-person' })).rejects.toMatchObject({ details: { code: 'no_stop' } });
    await h.caps.noteStop(job.id, { usedMicroUsd: credits(38), capMicroUsd: credits(40), neededMicroUsd: credits(44) });
    const raised = await h.caps.raiseInPlace({ projectId: 'p', jobId: 'loop-1', by: 'local-person' });
    expect(raised.raise?.toMicroUsd).toBe(credits(80));
    expect(raised.stop?.consumedBy).toBe('loop-1');
    expect((await h.caps.scope('p', 'loop-1', 't')).capMicroUsd).toBe(credits(80));
    // A second press adds nothing.
    expect((await h.caps.raiseInPlace({ projectId: 'p', jobId: 'loop-1', by: 'local-person' })).raise?.toMicroUsd).toBe(credits(80));
    // The job checks in again at its new cap: that is a new stop, and one more amount.
    await h.caps.noteStop(job.id, { usedMicroUsd: credits(78), capMicroUsd: credits(80), neededMicroUsd: credits(84) });
    expect((await h.caps.raiseInPlace({ projectId: 'p', jobId: 'loop-1', by: 'local-person' })).raise?.toMicroUsd).toBe(credits(120));
  });

  test('the raise says who agreed, and an unnamed agreement is refused', async () => {
    const h = host();
    await h.caps.init();
    await expect(h.caps.raiseBeforeSend({ projectId: 'p', jobId: 'cmd-1', threadId: 't', neededMicroUsd: null, by: '' })).rejects.toMatchObject({ status: 400 });
    await expect(h.caps.raiseInPlace({ projectId: 'p', jobId: 'cmd-1', by: '' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('a job that continues another is metered under it', () => {
  test('the account service\'s name for the first job follows every later one, however many times', async () => {
    const h = host();
    await h.caps.init();
    h.styles.set('t', 'focused');
    const first = await h.caps.scope('p', 'cmd-1', 't');
    expect(h.caps.meteredAs('p', 'cmd-1')).toBeNull();
    await h.caps.noteMetered('p', 'cmd-1', 'turn-run-1.cmd-1');
    // The first name recorded stays, however often the job is admitted.
    await h.caps.noteMetered('p', 'cmd-1', 'something-else');
    expect(h.caps.get('p', 'cmd-1')?.meteredJobId).toBe('turn-run-1.cmd-1');
    await h.caps.noteStop(first.id, { usedMicroUsd: credits(240), capMicroUsd: credits(250), neededMicroUsd: credits(260) });
    await h.caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-2', fromJobId: 'cmd-1', threadId: 't', by: 'local-person' });
    expect(h.caps.meteredAs('p', 'cmd-2')).toBe('turn-run-1.cmd-1');
    const second = await h.caps.scope('p', 'cmd-2', 't');
    await h.caps.noteStop(second.id, { usedMicroUsd: credits(490), capMicroUsd: credits(500), neededMicroUsd: credits(510) });
    await h.caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-3', fromJobId: 'cmd-2', threadId: 't', by: 'local-person' });
    expect(h.caps.meteredAs('p', 'cmd-3')).toBe('turn-run-1.cmd-1');
    // A job that continues nothing is its own, and another project's job of the same name is another job.
    expect(h.caps.meteredAs('p', 'cmd-9')).toBeNull();
    expect(h.caps.meteredAs('q', 'cmd-3')).toBeNull();
  });

  test('the name survives a restart, and a job nobody metered records nothing', async () => {
    const h = host();
    await h.caps.init();
    await h.caps.scope('p', 'cmd-1', 't');
    await h.caps.noteMetered('p', 'cmd-1', 'meter-1');
    await h.caps.noteMetered('p', 'never-scoped', 'meter-2');
    const again = host();
    await again.caps.init();
    expect(again.caps.get('p', 'cmd-1')?.meteredJobId).toBe('meter-1');
    expect(again.caps.get('p', 'never-scoped')).toBeNull();
  });

  test('a stop the account service made first is recorded at the cap the job holds, once', async () => {
    const h = host({ current: { ...BUSINESS } });
    await h.caps.init();
    h.styles.set('t', 'efficient');
    await h.caps.scope('p', 'cmd-1', 't');
    await h.caps.noteManagedStop('p', 'cmd-1');
    const stopped = h.caps.get('p', 'cmd-1')!;
    expect(stopped.stop).toMatchObject({ capMicroUsd: credits(40), consumedBy: null });
    const at = stopped.stop!.at;
    await h.caps.noteManagedStop('p', 'cmd-1');
    expect(h.caps.get('p', 'cmd-1')!.stop!.at).toBe(at);
    // A job nobody scoped has nothing to stop.
    await h.caps.noteManagedStop('p', 'ghost');
    expect(h.caps.get('p', 'ghost')).toBeNull();
  });
});

describe('Keep going on a message: the account service is told first', () => {
  async function serve(keepGoing: (projectId: string, jobId: string, stop: { capMicroUsd: MicroUsd }) => Promise<void>) {
    const { caps, styles } = host({ current: { ...BUSINESS } });
    await caps.init();
    styles.set('t', 'efficient');
    const app = express();
    app.use(express.json());
    mountJobCapRoutes(app, {
      jobCaps: caps,
      messagePlan: async (_p, threadId) => ({ threadId, metering: 'not-metered', rates: null, shape: SHAPE }),
      teamWakePlan: async () => ({ threadId: 't', metering: 'not-metered', rates: null, shape: SHAPE }),
      wake: async () => ({ ok: true }),
      keepGoing,
    });
    app.use((error: { status?: number; message: string; details?: object }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message, ...(error.details ?? {}) });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: (await response.json()) as Record<string, any> };
    };
    return { caps, call, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  test('the job and the cap it stopped at are named to the account service, before the new job is raised', async () => {
    const seen: string[] = [];
    const s = await serve(async (projectId, jobId, stop) => {
      seen.push(`${projectId}:${jobId}:${stop.capMicroUsd}`);
      // Nothing is raised locally until the account service has agreed.
      expect(s.caps.get('p', 'cmd-2')).toBeNull();
    });
    try {
      const stopped = await s.caps.scope('p', 'cmd-1', 't');
      await s.caps.noteStop(stopped.id, { usedMicroUsd: credits(38), capMicroUsd: credits(40), neededMicroUsd: credits(44) });
      const resend = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-2/go-over', { fromJobId: 'cmd-1' });
      expect(resend.status).toBe(200);
      expect(resend.data).toMatchObject({ jobId: 'cmd-2', capMicroUsd: credits(80), raised: true });
      expect(seen).toEqual([`p:cmd-1:${credits(40)}`]);
    } finally {
      await s.close();
    }
  });

  test('when the account service refuses, the new job is not raised and the stop stays open', async () => {
    const s = await serve(async () => {
      throw new ApiError(409, 'This job already checked in again. Read where it stands, then choose.', { code: 'check_in_stale' });
    });
    try {
      const stopped = await s.caps.scope('p', 'cmd-1', 't');
      await s.caps.noteStop(stopped.id, { usedMicroUsd: credits(38), capMicroUsd: credits(40), neededMicroUsd: credits(44) });
      const refused = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-2/go-over', { fromJobId: 'cmd-1' });
      expect(refused.status).toBe(409);
      expect(refused.data.code).toBe('check_in_stale');
      expect(s.caps.get('p', 'cmd-2')).toBeNull();
      expect(s.caps.get('p', 'cmd-1')?.stop?.consumedBy).toBeNull();
    } finally {
      await s.close();
    }
  });

  test('a job that never stopped has nothing to keep going, and the account service is not asked', async () => {
    const keepGoing = vi.fn(async () => undefined);
    const s = await serve(keepGoing);
    try {
      await s.caps.scope('p', 'cmd-1', 't');
      const refused = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-2/go-over', { fromJobId: 'cmd-1' });
      expect(refused.status).toBe(409);
      expect(refused.data.code).toBe('no_stop');
      expect(keepGoing).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });
});

describe('what counts as a check-in', () => {
  const managed = (state: 'released' | 'uncertain' | 'pending' | null, dispatched = true) =>
    new ModelApiError('nectovia_cap_request_required', 'x', dispatched, state ? { reservation: { id: 'r', state, maxMicroUsd: micro(5), settledMicroUsd: null } } : {});

  test('the local ledger\'s refusal before the call, and the account service\'s with its hold released', () => {
    expect(isCheckInRefusal(new ModelApiError('aws_job_cap_reached', 'x', false))).toBe(true);
    expect(isCheckInRefusal(new ModelApiError('openrouter_job_cap_reached', 'x', false))).toBe(true);
    expect(isCheckInRefusal(managed('released'))).toBe(true);
  });

  test('nothing else is: a hold that may have been used, a call that was sent, other refusals, other errors', () => {
    expect(isCheckInRefusal(managed('uncertain'))).toBe(false);
    expect(isCheckInRefusal(managed('pending'))).toBe(false);
    expect(isCheckInRefusal(managed(null))).toBe(false);
    expect(isCheckInRefusal(new ModelApiError('aws_job_cap_reached', 'x', true))).toBe(false);
    expect(isCheckInRefusal(new ModelApiError('nectovia_insufficient_allowance', 'x', true, { reservation: { id: 'r', state: 'released', maxMicroUsd: micro(5), settledMicroUsd: null } }))).toBe(false);
    expect(isCheckInRefusal(new Error('aws_job_cap_reached'))).toBe(false);
    expect(isCheckInRefusal(null)).toBe(false);
  });
});

// --- unattended work -----------------------------------------------------------------------------

const principal: HarnessPrincipal = { id: 'local-client', tenantId: 'local', projectId: 'p', capabilities: [], identityGeneration: 1 };
const capability: CapabilityManifest = {
  id: 'diomedes-loop', version: 'v1', label: 'Loop under test', description: 'Synthetic.', tools: ['read_note'],
  requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 16, supportedPlatforms: ['win32', 'linux', 'darwin'],
};
const BUDGET: HarnessBudget = { units: 40, modelCalls: 20, toolCalls: 20, wallMs: null };

describe('a loop that reaches its check-in', () => {
  const NOTES: Record<string, string> = { 'order.md': 'Order 1182: 100 napkins.' };
  const tools = () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_note', version: 'v1', description: 'Read a note.', effect: 'read', effectClass: 'read', permission: null,
      approval: false, destination: 'local', trustedInputRequired: false, cost: 0,
      schema: z.strictObject({ path: z.string() }),
      outputSchema: z.strictObject({ path: z.string(), text: z.string().nullable() }),
      execute: ({ input }) => ({ path: input.path, text: NOTES[input.path] ?? null }),
    });
    return registry;
  };
  const bindings: LoopToolBinding[] = [
    { name: 'read_note', description: 'Read a note by path.', schema: z.strictObject({ path: z.string() }), bind: (input) => input as { path: string } },
  ];
  /** The plan, one tool call, then the next call is the one the job checks in at. */
  function adapter(refusal: () => Error): ModelAdapter {
    return {
      id: 'nectovia', version: 'v1', destination: 'external', contract: routeContractFor('native-fixture'),
      capabilities: () => ({
        engineId: 'nectovia', engineVersion: 'v1', protocolVersion: 'test', modelCalls: 'enforced', toolCalls: 'enforced',
        filesystemWrites: 'unsupported', networkEgress: 'enforced', approvals: 'unsupported', resumability: 'observed',
        cancellability: 'observed', checkpointGranularity: 'step', notes: [],
      }),
      async complete(request: ModelRequest): Promise<ModelResult> {
        if (!request.tools.length) return { response: { type: 'final', text: '1. Read the order.\n2. Report the count.' } };
        if (request.messages.filter((message) => message.role === 'tool').length === 0)
          return { response: { type: 'tool', name: 'read_note', input: { path: 'order.md' } } };
        throw refusal();
      },
    };
  }
  async function execute(id: string, refusal: () => Error, options: { checkInCap?: () => number | null } = {}) {
    const root = await fs.mkdtemp(path.join(dir, 'runs-'));
    const runs = new RunService(new FileRunStore(root), { authorizeEgress: async () => undefined });
    const registry = tools();
    await runs.start({ id, tenantId: 'local', projectId: 'p', principal, capability, budget: BUDGET, tools: registry });
    await runs.claim(id, 'host', 60_000);
    const result = await new NativeLoop(runs, adapter(refusal), registry, {
      maxTurns: 6, instructions: '', bindings, route: 'nectovia', model: null, ...options,
    }).run(id, 'host', 'Report the order count.', principal);
    return { result, run: await runs.get(id) };
  }
  const local = () => new ModelApiError('aws_job_cap_reached', 'This job would pass its cap.', false, {
    job: { id: jobKeyFor('p', 'loop-1'), usedMicroUsd: credits(240), capMicroUsd: credits(250), neededMicroUsd: credits(260) },
  });
  const managed = () => new ModelApiError('nectovia_cap_request_required', 'Gateway words.', true, {
    reservation: { id: 'r1', state: 'released', maxMicroUsd: micro(5), settledMicroUsd: null }, status: 402,
  });

  test('the local ledger\'s stop ends the run there, keeps what it did, and says the section 7 line at the cap it reached', async () => {
    const { result, run } = await runWith('local-1', local);
    expect(result).toEqual({ kind: 'stopped', reason: 'check-in' });
    expect(run.state).toBe('cancelled');
    expect(run.steps.map((step) => `${step.intent.stepId}:${step.state}`).slice(-3)).toEqual(['observe:0:succeeded', 'model:1:failed', 'stop:check-in:succeeded']);
    const line = 'A routine stopped to check in after 250 credits.';
    expect(loopView(run).stop).toMatchObject({ reason: 'check-in', detail: line });
    expect(loopOutcome(loopView(run), null)).toEqual({ state: 'stopped-limit', label: 'Stopped: checking in', sentence: line });
    // Waiting for the person, not failed and not an out-of-credits stop.
    expect(presentRun(run)).toMatchObject({ taskState: 'waiting', reason: 'check-in', sessionState: 'stopped', sentence: line });
    expect(loopView(run).turns[0].observation?.excerpt).toContain('Order 1182');
  });

  test('the account service\'s stop, with its hold released, is the same stop; the amount comes from the host', async () => {
    const { result, run } = await runWith('managed-1', managed, { checkInCap: () => credits(100) });
    expect(result).toEqual({ kind: 'stopped', reason: 'check-in' });
    // Its hold was released, so the refused step is a known outcome: failed, never parked for reconciliation.
    expect(run.steps.map((step) => `${step.intent.stepId}:${step.state}`).slice(-2)).toEqual(['model:1:failed', 'stop:check-in:succeeded']);
    expect(run.state).toBe('cancelled');
    expect(loopView(run).stop).toMatchObject({ reason: 'check-in', detail: unattendedCheckInLine(credits(100)) });
  });

  test('when no one can say the amount it still stops to check in, and says only that', async () => {
    const { run } = await runWith('managed-2', managed);
    expect(loopView(run).stop).toMatchObject({ reason: 'check-in', detail: UNATTENDED_CHECK_IN_UNKNOWN });
  });

  test('a refusal whose hold may have been used is not a check-in: the run is parked to be checked, as before', async () => {
    const uncertain = () => new ModelApiError('nectovia_cap_request_required', 'Gateway words.', true, {
      reservation: { id: 'r2', state: 'uncertain', maxMicroUsd: micro(5), settledMicroUsd: null }, status: 402,
    });
    await expect(runWith('managed-3', uncertain)).rejects.toThrow();
  });

  async function runWith(id: string, refusal: () => Error, options: { checkInCap?: () => number | null } = {}) {
    return execute(id, refusal, options);
  }
});

describe('work that checks in waits in Needs you with its line', () => {
  const task = (patch: Partial<Task> = {}) =>
    ({ id: 'T1', name: 'Check the order', description: '', from: null, owner: 'you', state: 'waiting', reason: 'check-in', needId: null, sessionIds: ['S1'], changeIds: [], moves: [], ...patch }) as unknown as Task;
  const session = (log: Session['log']) =>
    ({ id: 'S1', taskId: 'T1', state: 'stopped', startedAt: '2026-10-06T00:00:00.000Z', endedAt: '2026-10-06T00:01:00.000Z', log, needId: null, entryIds: [] }) as unknown as Session;
  const LINE = 'A routine stopped to check in after 250 credits.';

  test('the task reads Review, with the line the run recorded, not a stack of technical lines after it', () => {
    const stopped = session([
      { time: '1', level: 'plain', sentence: LINE },
      { time: '2', level: 'technical', sentence: '{"type":"run.cancelled"}' },
    ]);
    expect(taskEvidence(task(), [stopped])).toMatchObject({ column: 'Review', detail: LINE, wait: 'review' });
    const items = needsYou({ tasks: [task()], sessions: [stopped], needs: [], changes: [] });
    expect(items).toEqual([expect.objectContaining({ kind: 'review', taskId: 'T1', detail: LINE })]);
  });

  test('a stopped task that is not at a check-in reads as it always did', () => {
    const stopped = session([{ time: '1', level: 'plain', sentence: 'Stopped.' }]);
    expect(taskEvidence(task({ reason: null, state: 'todo' }), [stopped])).toMatchObject({ column: 'Ready', wait: null });
  });
});

describe('Keep going and Stop here are said once, in the words the owner approved', () => {
  test('the section 7 strings', () => {
    expect(checkInQuestion(credits(250))).toBe('This job has used 250 credits. Keep going?');
    expect(checkInMore(credits(250))).toBe('It can use 250 more before it checks in again.');
    expect(unattendedCheckInLine(credits(250))).toBe('A routine stopped to check in after 250 credits.');
    expect(CHECK_IN_KEEP_GOING).toBe('Keep going');
    expect(CHECK_IN_STOP).toBe('Stop here');
    expect(checkInCopy({ capMicroUsd: credits(250), checkInMicroUsd: credits(250) })).toEqual({
      title: 'This job has used 250 credits. Keep going?',
      body: '',
      upgrade: null,
      raise: 'It can use 250 more before it checks in again.',
      actions: { goOver: 'Keep going', cancel: 'Stop here' },
    });
  });

  test('plain words: no dashes, no dollars, no provider names, no figure a tier could not have said', () => {
    const all = [
      checkInQuestion(credits(100)), checkInMore(credits(100)), unattendedCheckInLine(credits(100)), UNATTENDED_CHECK_IN_UNKNOWN,
      CHECK_IN_KEEP_GOING, CHECK_IN_STOP, CHECK_INS_INVALID, CHECK_IN_AMOUNT_INVALID, CHECK_INS_NOT_SIGNED_IN,
    ];
    for (const text of all) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\$|dollar|USD/i);
      expect(text).not.toMatch(/AWS|Bedrock|OpenAI|GPT|Luna|provider/i);
    }
  });

  test('the dialog reads Stop here then Keep going, and the other asks keep their words', () => {
    const html = renderToStaticMarkup(
      createElement(JobCapWarning, { copy: checkInCopy({ capMicroUsd: credits(250), checkInMicroUsd: credits(250) }), inline: true, onUpgrade: () => {}, onGoOver: () => {}, onCancel: () => {} }),
    );
    expect([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).filter(Boolean)).toEqual(['Stop here', 'Keep going']);
  });
});

describe('the Retry of a loop that checked in reads Keep going', () => {
  const profile = workControlProfile(defaultWorkContract('codex'), 'codex');
  const render = (reason: Task['reason']) =>
    renderToStaticMarkup(
      createElement(RunControls, {
        projectId: 'p',
        task: { id: 'T1', reason } as unknown as Task,
        session: { id: 'S1', state: 'stopped' } as unknown as Session,
        profile,
        queuedCount: 0,
        latest: true,
        onStopTask: () => {},
      }),
    );

  test('only for a stop at the check-in', () => {
    const labels = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(labels(render('check-in'))).toContain('Keep going');
    expect(labels(render('check-in'))).not.toContain('Retry');
    expect(labels(render(null))).toContain('Retry');
    expect(labels(render(null))).not.toContain('Keep going');
  });
});

// --- settings routes and the client model --------------------------------------------------------------

describe('the settings route', () => {
  const view = { effective: { amounts: { efficient: 100, focused: 250, thorough: 500 } } };
  async function serve(opts: { manage?: boolean; signedIn?: boolean } = {}) {
    const session = {
      jobCheckInSettings: vi.fn(async () => view),
      setJobCheckIns: vi.fn(async () => view),
    };
    const changed = vi.fn();
    const workspaces = {
      assertMine: () => {},
      assertCanManageMemberLimits: () => {
        if (opts.manage === false) throw new ApiError(403, 'Only an owner or an admin can do that for this business.', { code: 'not_owner_or_admin' });
      },
    };
    const app = express();
    app.use(express.json());
    mountJobCheckInRoutes(app, workspaces as never, opts.signedIn === false ? null : (session as never), changed);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: error.message, ...error.details });
      else res.status(500).json({ error: String(error) });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace/organizations/org-1/job-check-ins`;
    const call = async (method: string, body?: unknown) => {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: (await response.json()) as Record<string, any> };
    };
    return { session, changed, call, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  test('an owner or admin reads and sets the business\'s amounts, and what was kept for a minute is read again', async () => {
    const s = await serve();
    try {
      expect((await s.call('GET')).status).toBe(200);
      expect(s.session.jobCheckInSettings).toHaveBeenCalledWith('org-1');
      const amounts = { efficient: 40, focused: null, thorough: 80 };
      const saved = await s.call('POST', { amounts });
      expect(saved.status).toBe(200);
      expect(s.session.setJobCheckIns).toHaveBeenCalledWith('org-1', { amounts });
      expect(s.changed).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  test('a member is turned away on this computer, and nothing reaches the account service', async () => {
    const s = await serve({ manage: false });
    try {
      expect((await s.call('GET')).status).toBe(403);
      expect((await s.call('POST', { amounts: { efficient: 1, focused: null, thorough: null } })).status).toBe(403);
      expect(s.session.jobCheckInSettings).not.toHaveBeenCalled();
      expect(s.session.setJobCheckIns).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  test('a request that names anything but amounts is refused before it is sent on', async () => {
    const s = await serve();
    try {
      for (const body of [
        { amounts: { efficient: 0, focused: null, thorough: null } },
        { amounts: { efficient: 5, focused: null, thorough: null }, organizationId: 'org-2' },
        { amounts: { efficient: 5, focused: null, thorough: null }, jobId: 'job-1' },
        { efficient: 5 },
      ]) {
        const refused = await s.call('POST', body);
        expect(refused.status).toBe(400);
        expect(refused.data.code).toBe('invalid_amount');
      }
      expect(s.session.setJobCheckIns).not.toHaveBeenCalled();
      expect(s.changed).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  test('signed out, it says so', async () => {
    const s = await serve({ signedIn: false });
    try {
      const refused = await s.call('GET');
      expect(refused.status).toBe(401);
      expect(refused.data).toMatchObject({ code: 'sign_in_required', error: CHECK_INS_NOT_SIGNED_IN });
    } finally {
      await s.close();
    }
  });
});

describe('the Settings boxes', () => {
  const full = {
    effective: { amounts: { efficient: 40, focused: 250, thorough: 500 }, source: { efficient: 'business', focused: 'code', thorough: 'code' }, defaultsVersion: null },
    defaults: { efficient: 100, focused: 250, thorough: 500 },
    override: { efficient: 40, focused: null, thorough: null },
    updatedAt: null,
  } as never;

  test('what is typed becomes whole credits, and an empty box goes back to Nectovia\'s amount', () => {
    expect(parseAmounts({ efficient: ' 40 ', focused: '', thorough: '500' })).toEqual({ efficient: 40, focused: null, thorough: 500 });
    expect(parseAmounts({ efficient: '', focused: '', thorough: '' })).toEqual({ efficient: null, focused: null, thorough: null });
  });

  test('anything else is refused where it is typed: zero, decimals, text, signs, too many digits, too large', () => {
    for (const bad of ['0', '2.5', 'abc', '-3', '+3', '1e3', '1,000', '1000000', '100001'])
      expect(parseAmounts({ efficient: bad, focused: '', thorough: '' }), bad).toBeNull();
  });

  test('the boxes are filled with the business\'s own amounts, and empty where it has none', () => {
    expect(amountsText(full)).toEqual({ efficient: '40', focused: '', thorough: '' });
  });

  test('the read is one call for this business, and never throws; a save sends the amounts and nothing else', async () => {
    const read = vi.fn(async () => full);
    expect(await loadJobCheckIns('org 1', read as never)).toBe(full);
    expect(read).toHaveBeenCalledWith('/workspace/organizations/org%201/job-check-ins');
    expect(await loadJobCheckIns('org-1', (async () => { throw new Error('no'); }) as never)).toBeNull();
    const send = vi.fn(async () => full);
    await saveJobCheckIns('org-1', { efficient: 40, focused: null, thorough: null }, send as never);
    expect(send).toHaveBeenCalledWith('/workspace/organizations/org-1/job-check-ins', 'POST', { amounts: { efficient: 40, focused: null, thorough: null } });
  });
});

void [micro, CHECK_IN_STOP];
