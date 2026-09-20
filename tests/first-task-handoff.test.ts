import { describe, expect, it } from 'vitest';
import type { ConnectionReceipt, EngineConnection } from '../shared/engines.js';
import { firstTaskHandoff } from '../client/ai-setup-state.js';
import {
  FIRST_TASK_TTL_MS,
  decideFirstTask,
  type PendingFirstTask,
  type ThreadFacts,
} from '../client/first-task-handoff.js';

/**
 * When a route may carry a person straight into their first real task.
 *
 * The answer is the host's, not the screen's: the host says a receipt still
 * names what is selected now by keeping `verification` on the record and by
 * moving `nextAction` to `ready`. A click that succeeded a moment ago proves
 * nothing on its own, so nothing here reads one.
 */

const VERIFIED_AT = '2026-09-20T10:00:00.000Z';

const receipt = (patch: Partial<ConnectionReceipt> = {}): ConnectionReceipt => ({
  engine: 'opencode',
  revision: 3,
  candidateId: 'managed:opencode:C:\\Diomedes\\engines\\opencode\\opencode.exe',
  version: '1.18.4',
  accountRoute: 'opencode:opencode-go',
  model: 'opencode/fixture-model',
  runId: 'run-fixture',
  buildId: 'build-fixture',
  verifiedAt: VERIFIED_AT,
  ...patch,
});

const base: EngineConnection = {
  engine: 'opencode',
  installation: 'found',
  compatibility: 'supported',
  authentication: 'signed-in',
  accountRoute: 'opencode:opencode-go',
  models: [
    {
      slug: 'opencode/fixture-model',
      name: 'Fixture model',
      description: 'A fixture model.',
      defaultEffort: null,
      efforts: [],
    },
  ],
  checkedAt: VERIFIED_AT,
  detail: 'Native OpenCode Go account connected.',
  usage: { state: 'unknown', checkedAt: null },
  revision: 3,
  nextAction: 'ready',
  verification: receipt(),
};

describe('the route a first task may start on', () => {
  it('names the route and the model the host verified', () => {
    expect(firstTaskHandoff(base, 'opencode/fixture-model')).toEqual({
      route: 'opencode',
      model: 'opencode/fixture-model',
    });
  });

  it('offers nothing until the host says this route is ready', () => {
    expect(firstTaskHandoff({ ...base, nextAction: 'test-connection' }, 'opencode/fixture-model'))
      .toBeNull();
    expect(firstTaskHandoff({ ...base, nextAction: undefined }, 'opencode/fixture-model')).toBeNull();
  });

  it('offers nothing when no real request has ever run', () => {
    expect(firstTaskHandoff({ ...base, verification: null }, 'opencode/fixture-model')).toBeNull();
  });

  it('offers nothing when the receipt is for an older binding revision', () => {
    expect(firstTaskHandoff({ ...base, revision: 4 }, 'opencode/fixture-model')).toBeNull();
  });

  it('offers nothing when this route is set to use a different model now', () => {
    expect(firstTaskHandoff(base, 'opencode/another-model')).toBeNull();
    expect(firstTaskHandoff(base, '')).toBeNull();
  });

  it('offers nothing when the account route changed since the receipt', () => {
    expect(
      firstTaskHandoff({ ...base, accountRoute: 'opencode:zen' }, 'opencode/fixture-model'),
    ).toBeNull();
  });
});

/**
 * What happens to that offer between the click in Settings and the Console it
 * is applied in.
 *
 * The offer was gated on four facts of the host's at the moment it was drawn.
 * Applying it later without asking any of them again is how a route and model
 * chosen once came to be written over a thread hours afterwards. Every branch
 * of the answer is decided here, and the components only carry it out.
 */
describe('applying a first-task handover later', () => {
  const MADE = 2_000_000;
  const pending: PendingFirstTask = {
    route: 'opencode',
    model: 'opencode/fixture-model',
    effort: null,
    madeAtMs: MADE,
    n: 1,
  };
  const free: ThreadFacts = { live: false, busy: false, requested: null };
  const decide = (patch: {
    now?: number;
    connection?: EngineConnection | null;
    storedModel?: string;
    thread?: ThreadFacts | null;
  } = {}) =>
    decideFirstTask({
      pending,
      now: patch.now ?? MADE + 1_000,
      connection: patch.connection === undefined ? base : patch.connection,
      storedModel: patch.storedModel ?? 'opencode/fixture-model',
      thread: patch.thread === undefined ? free : patch.thread,
    });

  it('applies when the host still answers with the same route and model', () => {
    expect(decide()).toEqual({
      kind: 'apply',
      route: 'opencode',
      model: 'opencode/fixture-model',
      effort: null,
    });
  });

  it('drops an offer older than its window, and says nothing about it', () => {
    const late = decide({ now: MADE + FIRST_TASK_TTL_MS });
    expect(late).toEqual({ kind: 'drop', reason: 'expired', sentence: '' });
    // One millisecond inside the window is still the offer the person took.
    expect(decide({ now: MADE + FIRST_TASK_TTL_MS - 1 }).kind).toBe('apply');
  });

  it('drops and says so when this route is set to a different model now', () => {
    const answer = decide({ storedModel: 'opencode/another-model' });
    expect(answer.kind).toBe('drop');
    if (answer.kind !== 'drop') return;
    expect(answer.reason).toBe('route-changed');
    expect(answer.sentence).toMatch(/changed/i);
    expect(answer.sentence).toMatch(/nothing was selected/i);
  });

  it('drops when the host no longer calls this route ready', () => {
    expect(decide({ connection: { ...base, nextAction: 'test-connection' } }).kind).toBe('drop');
    expect(decide({ connection: { ...base, verification: null } }).kind).toBe('drop');
    expect(decide({ connection: { ...base, accountRoute: 'opencode:zen' } }).kind).toBe('drop');
  });

  it('drops when the host answered about a different route than the one offered', () => {
    const other = decide({ connection: { ...base, engine: 'cursor' } });
    expect(other.kind).toBe('drop');
  });

  it('drops and says so when the host could not be read at all', () => {
    const answer = decide({ connection: null });
    expect(answer.kind).toBe('drop');
    if (answer.kind !== 'drop') return;
    expect(answer.reason).toBe('unreadable');
    expect(answer.sentence).toMatch(/nothing was selected/i);
  });

  it('opens a new thread rather than taking a thread that is running', () => {
    expect(decide({ thread: { ...free, live: true } })).toEqual({
      kind: 'new-thread',
      reason: 'thread-running',
    });
  });

  it('opens a new thread rather than overwriting a choice somebody made', () => {
    expect(
      decide({ thread: { ...free, requested: { model: 'opencode/another-model', effort: null } } }),
    ).toEqual({ kind: 'new-thread', reason: 'thread-chosen' });
  });

  it('applies to a thread that already asks for this very model', () => {
    expect(
      decide({
        thread: { ...free, requested: { model: 'opencode/fixture-model', effort: null } },
      }).kind,
    ).toBe('apply');
    // A thread that chose an agent and no model has chosen no model.
    expect(
      decide({ thread: { ...free, requested: { model: null, effort: null, agent: 'auto' } } }).kind,
    ).toBe('apply');
  });

  it('opens a thread to land in when the project has none selected', () => {
    expect(decide({ thread: null })).toEqual({ kind: 'new-thread', reason: 'no-thread' });
  });

  it('waits while the Console is in the middle of its own write', () => {
    expect(decide({ thread: { ...free, busy: true } })).toEqual({ kind: 'wait' });
    // Waiting is never the answer for an offer that has already expired.
    expect(decide({ thread: { ...free, busy: true }, now: MADE + FIRST_TASK_TTL_MS }).kind).toBe(
      'drop',
    );
  });
});
