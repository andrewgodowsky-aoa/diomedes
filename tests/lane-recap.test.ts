import { describe, expect, test } from 'vitest';
import { RECAP_CHARS, laneRecap, spokenPrompt, withRecap } from '../server/lane-recap.js';
import { framedText } from '../server/agent-framing.js';
import { promptFor } from '../server/interaction-turn.js';
import { AGENT_CATALOG } from '../shared/agents.js';
import type { HarnessRun } from '../shared/harness.js';

/**
 * DIO-292: lanes are per kind of run, so a message that moves lanes brings the other lane's last
 * exchange along, read from that lane's durable run.
 */
const run = (turns: { prompt: string | null; answer: string | null }[]) =>
  ({
    id: 'run-ask',
    steps: turns.map((turn, n) => ({
      intent: { stepId: `turn:c${n}`, input: { prompt: turn.prompt } },
      state: 'succeeded',
      output: { response: { text: turn.answer } },
    })),
  }) as unknown as HarnessRun;
const reviewer = AGENT_CATALOG.find((item) => item.id === 'diomedes.reviewer')!;
const ISSUED = `sm.${'a'.repeat(32)}`;
const EARLIER = 'Earlier in this thread:\n\nPerson: How many napkins were short?\n\nDiomedes: Six were short.';

describe('the last answer of another lane', () => {
  test('reads only the last exchange of a long answered lane', () => {
    let stepReads = 0;
    let promptReads = 0;
    const previous = run(Array.from({ length: 10_000 }, (_, index) => ({ prompt: `Question ${index}`, answer: `Answer ${index}` })));
    for (const step of previous.steps) {
      const input = step.intent.input as { prompt: string };
      const prompt = input.prompt;
      Object.defineProperty(input, 'prompt', {
        get: () => {
          promptReads += 1;
          return prompt;
        },
      });
    }
    previous.steps = new Proxy(previous.steps, {
      get: (target, key, receiver) => {
        if (typeof key === 'string' && /^\d+$/.test(key)) stepReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(laneRecap(previous)).toBe('Earlier in this thread:\n\nPerson: Question 9999\n\nDiomedes: Answer 9999');
    expect({ stepReads, promptReads }).toEqual({ stepReads: 1, promptReads: 1 });
  });

  test('skips exchanges with no lines and keeps an answer without a prompt', () => {
    const previous = run([{ prompt: 'Old question', answer: 'Old answer' }, { prompt: null, answer: 'Only an answer' }, { prompt: null, answer: null }]);
    previous.steps.push(
      { ...previous.steps[0], state: 'failed' },
      { ...previous.steps[0], intent: { ...previous.steps[0].intent, stepId: 'phase:x' } },
    );
    expect(laneRecap(previous)).toBe('Earlier in this thread:\n\nDiomedes: Only an answer');
  });

  test.each([null, '', '```diomedes-decision\n{}\n```'])('does not fall back past the latest exchange without a spoken answer: %s', (answer) => {
    expect(laneRecap(run([{ prompt: 'Old question', answer: 'Old answer' }, { prompt: 'Latest question', answer }]))).toBeNull();
  });

  test('only the last exchange comes along, without its decision block', () => {
    const recap = laneRecap(
      run([
        { prompt: 'Old question', answer: 'Old answer' },
        { prompt: 'How many napkins were short?', answer: 'Six were short.\n\n```diomedes-decision\n{}\n```' },
      ]),
    );
    expect(recap).toBe(EARLIER);
  });
  test('it is cut to its bound and nothing comes from an empty lane', () => {
    const long = laneRecap(run([{ prompt: 'q', answer: 'x'.repeat(RECAP_CHARS * 2) }]))!;
    expect(long.length).toBeLessThanOrEqual('Earlier in this thread:\n\n'.length + RECAP_CHARS + 1);
    expect(laneRecap(run([]))).toBeNull();
    expect(laneRecap(null)).toBeNull();
  });
  test('the new message follows the recap', () => {
    expect(withRecap('Make a plan for that.', 'Earlier in this thread:\n\nX')).toBe(
      'Earlier in this thread:\n\nX\n\nThe new message:\n\nMake a plan for that.',
    );
    expect(withRecap('Make a plan for that.', null)).toBe('Make a plan for that.');
  });
  test("an earlier recap, an agent's marker and the identity line never come along", () => {
    // Auto's lane: its last message moved lanes itself, and it closed with the identity line.
    const automatic = promptFor('auto', withRecap('Order sixty more.', EARLIER), ISSUED);
    expect(laneRecap(run([{ prompt: automatic, answer: 'I can start that.\n\n```diomedes-decision\n{}\n```' }]))).toBe(
      'Earlier in this thread:\n\nPerson: Order sixty more.\n\nDiomedes: I can start that.',
    );
    // Ask's lane, where Reviewer answered: its marker opened the message, ahead of the recap.
    const reviewed = promptFor('ask', framedText(reviewer, 'ask', withRecap('Check the order.', EARLIER)), ISSUED);
    expect(laneRecap(run([{ prompt: reviewed, answer: 'It looks right.' }]))).toBe(
      'Earlier in this thread:\n\nPerson: Check the order.\n\nDiomedes: It looks right.',
    );
  });
  test('what the person typed is kept whole, whatever it says', () => {
    expect(spokenPrompt('What sells best?')).toBe('What sells best?');
    const typed = 'Read this back:\n\nThe new message:\n\nis the old one.';
    expect(spokenPrompt(withRecap(typed, EARLIER))).toBe(typed);
  });
});
