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
  boundedHistory,
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

  test('never leaves half a character at the cut, whichever way the bound falls', () => {
    // An emoji is two UTF-16 units, so the cut, counted from the end, lands between the two
    // halves of one or the other depending on the answer's length.
    for (const pad of ['', 'a']) {
      const history = conversationHistory([run([turn('x', '\u{1F35E}'.repeat(30_000), `ok${pad}`)])]);
      expect(history.startsWith('…')).toBe(true);
      const first = history.charCodeAt(1);
      expect(first >= 0xdc00 && first <= 0xdfff, `pad ${JSON.stringify(pad)}`).toBe(false);
      expect((history as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);
      expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS + 1);
    }
  });

  test('says how many messages each run gave, counting one the character bound cut short', () => {
    const carried = run(numbered('C', 10), { id: 'carried-run' });
    const own = run(numbered('O', 5), { id: 'own-run' });
    // Seven of the carried run's ten, then all five of the lineage's own.
    expect(boundedHistory([carried, own]).messages).toEqual(new Map([['carried-run', 7], ['own-run', 5]]));
    expect(boundedHistory([carried, run(numbered('O', 12), { id: 'own-run' })]).messages).toEqual(new Map([['own-run', 12]]));
    expect(boundedHistory([run([], { id: 'carried-run' }), own]).messages.get('carried-run')).toBeUndefined();
    // A long own message leaves only the tail of the carried one inside the bound: it still counts.
    // The carried block is 58 characters and the own one 23,970, so the cut falls 30 in, right
    // after the carried question.
    const tail = run([turn('c', 'the carried question', 'the carried answer')], { id: 'carried-run' });
    const long = run([turn('o', `own ${'y'.repeat(MAX_HISTORY_CHARS - 56)}`, 'ok')], { id: 'own-run' });
    const cut = boundedHistory([tail, long]);
    expect(cut.text).toContain('answer');
    expect(cut.text).not.toContain('the carried question');
    expect(cut.messages).toEqual(new Map([['carried-run', 1], ['own-run', 1]]));
    // And one cut away entirely does not.
    const gone = boundedHistory([tail, run([turn('o', `own ${'y'.repeat(MAX_HISTORY_CHARS)}`, 'ok')], { id: 'own-run' })]);
    expect(gone.text).not.toContain('carried');
    expect(gone.messages).toEqual(new Map([['own-run', 1]]));
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
  });

  test('is nothing when the run cannot be read, so the message is still answered, without it', async () => {
    // A damaged file, a newer contract written before a downgrade, a locked disk: none fails the send.
    expect(await carriedRun(reader(new HarnessError('store_failed', 'disk')), input)).toBeNull();
    expect(await carriedRun(reader(new HarnessError('unsupported_version', 'newer contract')), input)).toBeNull();
    expect(await carriedRun(reader(new SyntaxError('Unexpected end of JSON input')), input)).toBeNull();
  });

  test('names exactly the two conversation drivers', () => {
    expect([...CONVERSATION_CAPABILITY_IDS].sort()).toEqual([CLAUDE_SESSION_CAPABILITY.id, MODEL_CONVERSATION_CAPABILITY.id].sort());
  });
});
