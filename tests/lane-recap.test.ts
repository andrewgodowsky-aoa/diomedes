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
const run = (turns: { prompt: string; answer: string }[]) =>
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
