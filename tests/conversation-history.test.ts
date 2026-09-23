/**
 * The one history reader both conversation drivers use (server/harness/conversation-history.ts):
 * bounded, read only from answered `turn:` steps, and willing to carry only a conversation run of
 * the same project and thread.
 */
import { describe, expect, test, vi } from 'vitest';
import type { HarnessRun } from '../shared/harness';
import {
  CONVERSATION_CAPABILITY_IDS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  carriedRun,
  conversationHistory,
} from '../server/harness/conversation-history';
import { CLAUDE_SESSION_CAPABILITY } from '../server/harness/claude-session-run';
import { MODEL_CONVERSATION_CAPABILITY } from '../server/harness/model-session-run';
import { HarnessError } from '../server/harness/policy';

const turn = (key: string, prompt: string, answer: string | null, state = 'succeeded') => ({
  intent: { stepId: `turn:${key}`, input: { prompt } },
  output: { response: answer === null ? null : { text: answer } },
  state,
});
const run = (steps: unknown[], patch: Record<string, unknown> = {}) =>
  ({
    id: 'model-run',
    projectId: 'p1',
    capabilityId: 'model-api-conversation',
    input: { projectId: 'p1', threadId: 't1' },
    steps,
    ...patch,
  }) as unknown as HarnessRun;
const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => turn(`${prefix}${index + 1}`, `${prefix}${index + 1} asks`, `${prefix}${index + 1} said`));

describe('the history a conversation turn is given', () => {
  test('the carried run comes first, and the last 12 messages across both are kept', () => {
    expect(MAX_HISTORY_TURNS).toBe(12);
    const history = conversationHistory([run(numbered('C', 10)), run(numbered('O', 5))]);
    const people = history.split('\n\n').filter((line) => line.startsWith('Person: ')).map((line) => line.slice(8));
    expect(people).toEqual(['C4 asks', 'C5 asks', 'C6 asks', 'C7 asks', 'C8 asks', 'C9 asks', 'C10 asks', 'O1 asks', 'O2 asks', 'O3 asks', 'O4 asks', 'O5 asks']);
    expect(history).toContain('Diomedes: C4 said');
    expect(history).not.toContain('C3 asks');
  });

  test('keeps at most the last 24,000 characters, marked where it was cut', () => {
    expect(MAX_HISTORY_CHARS).toBe(24_000);
    const long = (tag: string) => `${tag}${'x'.repeat(9_990)}`;
    const history = conversationHistory([run([turn('1', long('first'), 'ok'), turn('2', long('second'), 'ok'), turn('3', long('third'), 'ok')])]);
    expect(history).toHaveLength(MAX_HISTORY_CHARS + 1);
    expect(history.startsWith('…')).toBe(true);
    expect(history).not.toContain('first');
    expect(history.endsWith('Diomedes: ok')).toBe(true);
  });

  test('reads only answered messages, never the one being answered, and never a decision block', () => {
    const history = conversationHistory(
      [
        run([
          turn('a', 'answered', 'here it is\n\n```diomedes-decision\n{"disposition":"respond"}\n```'),
          turn('b', 'failed', 'never', 'failed'),
          turn('c', 'stopped', null),
          { intent: { stepId: 'phase.decision:x', input: { prompt: 'a phase' } }, output: { response: { text: 'phase' } }, state: 'succeeded' },
          turn('now', 'the one being answered', null, 'running'),
          turn('d', 'being answered again', 'recorded'),
        ]),
      ],
      'turn:d',
    );
    expect(history).toBe('Person: answered\n\nDiomedes: here it is\n\nPerson: stopped');
  });
});

describe('the run a lineage carries history from', () => {
  const input = { projectId: 'p1', threadId: 't1', carriedFrom: 'model-run' };
  const reader = (found: HarnessRun | Error) => ({
    get: vi.fn(async () => {
      if (found instanceof Error) throw found;
      return found;
    }),
  });

  test('is a conversation run of the same project and the same thread', async () => {
    const same = run([]);
    expect(await carriedRun(reader(same), input)).toBe(same);
    const claude = run([], { capabilityId: 'claude-native-session' });
    expect(await carriedRun(reader(claude), input)).toBe(claude);
  });

  test('is nothing when the pointer is absent, the run is gone, or anything about it differs', async () => {
    const none = reader(run([]));
    expect(await carriedRun(none, { projectId: 'p1', threadId: 't1' })).toBeNull();
    expect(none.get).not.toHaveBeenCalled();
    expect(await carriedRun(reader(new HarnessError('unknown_run', 'gone')), input)).toBeNull();
    expect(await carriedRun(reader(run([], { projectId: 'p2' })), input)).toBeNull();
    expect(await carriedRun(reader(run([], { input: { projectId: 'p1', threadId: 't2' } })), input)).toBeNull();
    expect(await carriedRun(reader(run([], { capabilityId: 'model-api-turn' })), input)).toBeNull();
    await expect(carriedRun(reader(new HarnessError('store_failed', 'disk')), input)).rejects.toThrow('disk');
  });

  test('names exactly the two conversation drivers', () => {
    expect([...CONVERSATION_CAPABILITY_IDS].sort()).toEqual([CLAUDE_SESSION_CAPABILITY.id, MODEL_CONVERSATION_CAPABILITY.id].sort());
  });
});
