/**
 * DIO-23: past its bounds, a conversation's history folds its oldest messages in steps, so its
 * start stays byte for byte the same from one message to the next until a step, and a provider's
 * prefix cache can reuse it (server/harness/context-assembly.ts, `foldPoint` and `selectHistory`).
 */
import { describe, expect, test } from 'vitest';
import type { HarnessRun } from '../shared/harness';
import { MAX_HISTORY_CHARS } from '../server/harness/conversation-history';
import {
  KEPT_ROOM_CHARS,
  PICK_MAX,
  foldPoint,
  selectHistory,
  type SelectedHistory,
} from '../server/harness/context-assembly';
import { leftOutLine } from '../client/console/ContextUsed';

const turn = (key: string, prompt: string, answer: string) => ({
  intent: { stepId: `turn:${key}`, input: { prompt } },
  output: { response: { text: answer } },
  state: 'succeeded',
});
const run = (steps: unknown[], id = 'own-run') =>
  ({
    id,
    projectId: 'p1',
    capabilityId: 'model-api-conversation',
    input: { projectId: 'p1', threadId: 't1' },
    steps,
  }) as unknown as HarnessRun;

const SENTENCE =
  'The linen order for that week listed one hundred napkins and the delivery note counted ninety six, so the invoice bills four napkins that never arrived. ';
const answerOf = (chars: number) => SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars).trim();
const question = (n: number) => `Question ${n}: which week of the linen order came up short, and by how many napkins?`;

interface Message {
  n: number;
  prompt: string;
  answer: string;
  selected: SelectedHistory;
}

/** Every message of one conversation, each with the history it was given. */
function conversation(
  count: number,
  answerChars: (n: number) => number,
  ask: (n: number) => string = question,
  carried?: HarnessRun,
): Message[] {
  const steps: unknown[] = [];
  const out: Message[] = [];
  for (let n = 1; n <= count; n++) {
    const prompt = ask(n);
    const selected = selectHistory({ carried, own: run([...steps]), message: prompt });
    const answer = answerOf(answerChars(n));
    out.push({ n, prompt, answer, selected });
    steps.push(turn(String(n), prompt, answer));
  }
  return out;
}

/** How many of the oldest messages a history folded: none inside the bounds. */
const foldOf = (selected: SelectedHistory) =>
  selected.selection
    ? Math.min(...selected.selection.included.filter((item) => item.reason === 'recent').map((item) => item.index)) - 1
    : 0;

/** Sizes that vary the way a working conversation's do, the same on every run. */
const varied = (n: number) => [120, 600, 2_000, 340, 5_200, 900, 60, 3_100, 1_400, 7_800][n % 10] + ((n * 37) % 250);

describe('between steps the history only appends', () => {
  for (const chars of [600, 2_000])
    test(`(a) each message's history starts with the previous one's stable part, ${chars}-character answers`, () => {
      const messages = conversation(30, () => chars);
      let compared = 0;
      for (let i = 1; i < messages.length; i++) {
        const before = messages[i - 1].selected;
        const after = messages[i].selected;
        if (foldOf(before) !== foldOf(after) || !before.text) continue;
        compared += 1;
        // The bytes up to the end of the kept messages are identical; the newly answered message
        // follows them.
        expect(after.text.slice(0, before.stable)).toBe(before.text.slice(0, before.stable));
        const previous = messages[i - 1];
        expect(after.text.slice(before.stable)).toMatch(
          new RegExp(`^\\n\\nPerson: ${previous.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\nDiomedes: `),
        );
        expect(after.stable).toBeGreaterThan(before.stable);
      }
      expect(compared).toBeGreaterThan(20);
    });

  test('(d) the marker and the summary are the same bytes between steps', () => {
    const messages = conversation(30, () => 2_000);
    for (let i = 1; i < messages.length; i++) {
      const before = messages[i - 1].selected;
      const after = messages[i].selected;
      if (!before.selection || foldOf(before) !== foldOf(after)) continue;
      expect(after.selection!.marker).toBe(before.selection.marker);
      expect(after.compaction!.text).toBe(before.compaction!.text);
      expect(after.compaction!.id).toBe(before.compaction!.id);
    }
    // The marker names the folded range in words and never lists messages one by one.
    for (const { selected } of messages)
      if (selected.selection) expect(selected.selection.marker).toMatch(/^\[Message 1 follows in full\. Messages 2 to \d+ are summarised after it\.\]$/);
  });
});

describe('the fold', () => {
  test('(b) steps at the same messages every time: a pure function of the messages\' sizes', () => {
    const folds = (chars: number) => conversation(30, () => chars).map((message) => foldOf(message.selected));
    const short = [...Array(13).fill(0), ...Array(7).fill(8), ...Array(7).fill(15), ...Array(3).fill(22)];
    const long = [...Array(12).fill(0), ...Array(5).fill(9), ...Array(5).fill(14), ...Array(5).fill(19), ...Array(3).fill(24)];
    expect(folds(600)).toEqual(short);
    expect(folds(2_000)).toEqual(long);
    // Twice, the same history.
    const steps = conversation(20, varied).map((message) => turn(String(message.n), message.prompt, message.answer));
    const once = selectHistory({ own: run(steps), message: 'Which week came up short?' });
    expect(selectHistory({ own: run(steps), message: 'Which week came up short?' })).toEqual(once);
    // Other words of the same length fold at the same place; the message never moves the fold.
    const same = steps.map((step, i) =>
      turn(String(i + 1), 'q'.repeat(question(i + 1).length), 'a'.repeat(answerOf(varied(i + 1)).length)),
    );
    expect(foldOf(selectHistory({ own: run(same), message: 'other words' }))).toBe(foldOf(once));
    expect(foldPoint(
      steps.map((_, i) => ({ text: `Person: ${question(i + 1)}\n\nDiomedes: ${answerOf(varied(i + 1))}` })),
      0,
      { text: `Person: ${question(1)}\n\nDiomedes: ${answerOf(varied(1))}` },
    )).toBe(foldOf(once));
  });

  test('(b) a step point never moves: the fold only grows, and the first crossing steps once', () => {
    for (const sizes of [() => 600, () => 2_000, varied]) {
      const folds = conversation(40, sizes).map((message) => foldOf(message.selected));
      for (let i = 1; i < folds.length; i++) expect(folds[i]).toBeGreaterThanOrEqual(folds[i - 1]);
    }
    for (const chars of [600, 2_000]) {
      const folds = conversation(40, () => chars).map((message) => foldOf(message.selected));
      const steps = folds.flatMap((fold, i) => (i > 0 && fold !== folds[i - 1] ? [i] : []));
      expect(steps.length).toBeGreaterThanOrEqual(4);
      // Several messages fit between steps, the first crossing's included.
      for (let i = 1; i < steps.length; i++) expect(steps[i] - steps[i - 1]).toBeGreaterThanOrEqual(5);
    }
  });

  test('(c) the newest message is never dropped, and stays whole unless it alone passes the room', () => {
    const sizes = (n: number) => (n % 9 === 0 ? 30_000 : varied(n));
    const messages = conversation(40, sizes);
    for (let i = 1; i < messages.length; i++) {
      const { selected } = messages[i];
      const newest = messages[i - 1];
      if (!selected.selection) {
        expect(selected.text.endsWith(`Diomedes: ${newest.answer}`)).toBe(true);
        continue;
      }
      const item = selected.selection.included.find((entry) => entry.index === newest.n)!;
      expect(item.reason).toBe('recent');
      expect(selected.selection.omitted.some((entry) => entry.index === newest.n)).toBe(false);
      const block = `Person: ${newest.prompt}\n\nDiomedes: ${newest.answer}`;
      if (block.length >= MAX_HISTORY_CHARS) {
        // Its end stays, as the bounded history always kept it.
        expect(item.truncated).toBe(true);
        expect(selected.selection.cutChars).toBeGreaterThan(0);
        expect(selected.text.endsWith(newest.answer.slice(-200))).toBe(true);
      } else {
        expect(block.length + 2).toBeLessThanOrEqual(KEPT_ROOM_CHARS);
        expect(item.truncated).toBeUndefined();
        expect(selected.text).toContain(block);
      }
    }
  });

  test('(f) the history is never cut inside a step', () => {
    for (const sizes of [() => 600, () => 2_000, varied]) {
      const messages = conversation(30, sizes);
      for (const { selected } of messages) {
        expect(selected.text.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
        if (!selected.selection) continue;
        expect(selected.selection.cutChars).toBe(0);
        for (const item of selected.selection.included) {
          expect(item.truncated).toBeUndefined();
          const message = messages[item.index - 1];
          expect(selected.text).toContain(`Person: ${message.prompt}\n\nDiomedes: ${message.answer}`);
        }
      }
    }
  });

  test('a carried lineage gives way first, without a summary', () => {
    const carried = run(
      Array.from({ length: 14 }, (_, i) => turn(`c${i + 1}`, `C${i + 1} asks about lunch`, `C${i + 1} said soup.`)),
      'carried-run',
    );
    const selected = selectHistory({ carried, own: run([]), message: 'And the soup?' });
    const selection = selected.selection!;
    expect(selection.marker).toBe('[Messages 1 to 7 came before this conversation was updated and are left out.]');
    expect(selected.compaction).toBeNull();
    expect(selection.omitted.map((item) => item.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(selection.omitted.every((item) => item.carried)).toBe(true);
    expect(selected.messages).toEqual(new Map([['carried-run', 7]]));
    // The new lineage's own first message appends, as any message between steps does.
    const next = selectHistory({ carried, own: run([turn('o1', 'O1 asks', 'O1 said.')]), message: 'next' });
    expect(next.text.slice(0, selected.stable)).toBe(selected.text);
    expect(next.messages).toEqual(new Map([['carried-run', 7], ['own-run', 1]]));
  });
});

describe('(e) what one message recalls', () => {
  const invoice = (n: number) =>
    n === 2 ? 'Where is the Harbor Supply linen invoice, and when is it due?' : question(n);
  const history = (message: string) => {
    const steps = conversation(24, () => 600, invoice).map((item) => turn(String(item.n), item.prompt, item.answer));
    return selectHistory({ own: run(steps), message });
  };

  test('a summarised message that bears on this one more than any message in full follows the kept messages', () => {
    const selected = history('Has the Harbor Supply invoice been paid?');
    const selection = selected.selection!;
    expect(selection.included.find((item) => item.index === 2)).toMatchObject({ reason: 'relevant' });
    expect(selection.omitted.some((item) => item.index === 2)).toBe(false);
    // The summary still has its line, so the summary does not depend on what this message recalls.
    expect(selected.compaction!.turns.some((item) => item.index === 2)).toBe(true);
    const note = '[Message 2 is repeated in full here because it bears on the new message.]';
    const recalled = selected.text.indexOf('Person: Where is the Harbor Supply linen invoice');
    expect(selected.text.indexOf(note)).toBe(selected.stable + 2);
    expect(recalled).toBeGreaterThan(selected.text.indexOf(`Person: ${question(24)}`));
    expect(recalled).toBeGreaterThan(selected.stable);
    // What it recalls never changes the stable part.
    const plain = history('Thanks, that helps.');
    expect(plain.text).toBe(selected.text.slice(0, selected.stable));
    expect(plain.stable).toBe(plain.text.length);
    expect(plain.selection!.included.some((item) => item.reason === 'relevant')).toBe(false);
  });

  test('a summarised message no more relevant than the kept ones is not recalled', () => {
    // Every message asks the same thing, so the kept ones already carry what the summarised ones say.
    const steps = conversation(24, () => 600).map((item) => turn(String(item.n), item.prompt, item.answer));
    const selected = selectHistory({ own: run(steps), message: question(25) });
    expect(selected.selection!.included.some((item) => item.reason === 'relevant')).toBe(false);
    expect(selected.text.length).toBe(selected.stable);
    expect(selected.text).not.toContain('repeated in full here');
  });

  test(`at most ${PICK_MAX}, oldest first, named in one note`, () => {
    const topic = (n: number) =>
      n === 2 || n === 3 || n === 4
        ? `Message ${n} on the Harbor Supply linen invoice and its due date`
        : question(n);
    const steps = conversation(24, () => 600, topic).map((item) => turn(String(item.n), item.prompt, item.answer));
    const selected = selectHistory({ own: run(steps), message: 'Harbor Supply invoice due date?' });
    const recalled = selected.selection!.included.filter((item) => item.reason === 'relevant').map((item) => item.index);
    expect(recalled).toHaveLength(PICK_MAX);
    expect(selected.text.slice(selected.stable)).toMatch(
      new RegExp(`^\\n\\n\\[Messages ${recalled[0]} and ${recalled[1]} are repeated in full here because they bear on the new message\\.\\]\\n\\n`),
    );
  });
});

describe("the Context panel's Left out line", () => {
  test('a recalled message is not left out, and only messages with a line in the summary read as summarised', () => {
    const ask = (n: number) =>
      n === 3
        ? 'Where is the Harbor Supply linen invoice, and when is it due?'
        : `Question ${n}: ${'which week of the linen order came up short and by how many napkins and what the driver noted '.repeat(2)}`;
    const steps = conversation(40, () => 600, ask).map((item) => turn(String(item.n), item.prompt, item.answer));
    const selected = selectHistory({ own: run(steps), message: 'Has the Harbor Supply invoice been paid?' });
    const compaction = selected.compaction!;
    const listed = compaction.listed!;
    // The summary has no room for a line for every folded message, and message 3 is recalled.
    expect(listed).toBeGreaterThan(2);
    expect(listed).toBeLessThan(compaction.turns.length);
    expect(selected.selection!.included.find((item) => item.index === 3)?.reason).toBe('relevant');
    const lined = compaction.turns.slice(0, listed).map((item) => item.index).filter((index) => index !== 3);
    const unlined = compaction.turns.slice(listed).map((item) => item.index);
    expect(leftOutLine(selected.selection!, compaction)).toBe(
      `messages ${lined.join(', ')}, summarised. messages ${unlined.join(', ')}, left out without a line in the summary. `,
    );
    // An older record, whose summary stands for exactly the omitted messages, reads as before.
    const older = { omitted: [3, 4].map((index) => ({ runId: 'r', stepId: `turn:${index}`, index, carried: false })) };
    expect(leftOutLine(older, { ...compaction, turns: compaction.turns.slice(0, 2).map((item, i) => ({ ...item, index: i + 3 })), listed: undefined })).toBe(
      'messages 3, 4, summarised. ',
    );
  });
});
