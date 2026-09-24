/**
 * Review C (2026-09-24): regressions for the H18 findings in
 * docs/implementation/2026-09-24-review-c.md. Each test failed on the reviewed base.
 */
import { describe, expect, test } from 'vitest';
import type { HarnessRun } from '../shared/harness';
import { compactTurns, selectHistory } from '../server/harness/context-assembly';

const turn = (key: string, prompt: string, answer: string | null) => ({
  intent: { stepId: `turn:${key}`, input: { prompt } },
  output: { response: answer === null ? null : { text: answer } },
  state: 'succeeded',
});
const run = (id: string, steps: unknown[]) => ({ id, steps }) as unknown as HarnessRun;

/** Every message the record calls included is whole in the text; every other one is named as omitted. */
function expectTruthfulSelection(selected: ReturnType<typeof selectHistory>, prompts: Map<number, string>) {
  const selection = selected.selection!;
  const omitted = new Set(selection.omitted.map((item) => item.index));
  for (const item of selection.included) {
    expect(omitted.has(item.index)).toBe(false);
    const prompt = prompts.get(item.index)!;
    if (item.truncated) expect(selection.cutChars).toBeGreaterThan(0);
    else expect(selected.text, `message ${item.index} is recorded as included`).toContain(`Person: ${prompt}`);
  }
  for (const index of prompts.keys())
    expect(
      omitted.has(index) || selection.included.some((item) => item.index === index),
      `message ${index} is neither included nor omitted`,
    ).toBe(true);
  // A lineage's own omitted message is in the summary record.
  const summarised = new Set((selected.compaction?.turns ?? []).map((item) => item.index));
  for (const item of selection.omitted) if (!item.carried) expect(summarised.has(item.index)).toBe(true);
}

describe('H18 review C', () => {
  test('RC-H18-1: the opening and recent messages are never recorded as included and then cut away', () => {
    const prompts = new Map<number, string>();
    const steps: unknown[] = [];
    const add = (index: number, prompt: string) => {
      prompts.set(index, prompt);
      steps.push(turn(String(index), prompt, 'ok.'));
    };
    add(1, 'OPENING-MARKER what is the plan?');
    for (let i = 2; i <= 7; i++) add(i, `middle ${i}`);
    for (let i = 8; i <= 13; i++) add(i, `RECENT-${i} ${'y'.repeat(4_500)}`);
    const selected = selectHistory({ own: run('own', steps), message: 'next' });
    expectTruthfulSelection(selected, prompts);
    // The newest message is always there whole when it fits on its own.
    expect(selected.text).toContain(`Person: ${prompts.get(13)}`);
  });

  test('RC-H18-1: whole recent messages that do not fit are omitted and summarised, not silently cut', () => {
    const prompts = new Map<number, string>();
    const steps = Array.from({ length: 13 }, (_, i) => {
      prompts.set(i + 1, `M${i + 1}-START ${'z'.repeat(7_000)}`);
      return turn(String(i + 1), prompts.get(i + 1)!, 'ok.');
    });
    const selected = selectHistory({ own: run('own', steps), message: 'next' });
    expectTruthfulSelection(selected, prompts);
    expect(selected.selection!.cutChars).toBe(0);
  });

  test('RC-H18-1: a newest message longer than the budget is marked truncated, not claimed whole', () => {
    const prompts = new Map<number, string>();
    const steps = Array.from({ length: 13 }, (_, i) => {
      prompts.set(i + 1, i === 12 ? `NEWEST-START ${'q'.repeat(25_000)}` : `m${i + 1}`);
      return turn(String(i + 1), prompts.get(i + 1)!, 'ok.');
    });
    const selected = selectHistory({ own: run('own', steps), message: 'next' });
    expectTruthfulSelection(selected, prompts);
    const newest = selected.selection!.included.find((item) => item.index === 13);
    expect(newest?.truncated).toBe(true);
    expect(selected.text.endsWith('Diomedes: ok.')).toBe(true);
  });

  test('RC-H18-2: a summary excerpt never splits a surrogate pair', () => {
    const prompt = `${'a'.repeat(158)}\u{1F600} and more text with no full stop`;
    const record = compactTurns([{ runId: 'r', stepId: 'turn:x', index: 1, prompt, answer: 'fine.' }]);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(record.text)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(record.text)).toBe(false);
  });

  test('RC-H18-3: the record says how many omitted messages have a line in the summary', () => {
    const steps = Array.from({ length: 60 }, (_, i) =>
      turn(
        String(i + 1),
        `Question ${i + 1} about the weekly kitchen rota and who covers Sunday.`,
        `Answer ${i + 1}: Sam covers Sunday this week.`,
      ),
    );
    const selected = selectHistory({ own: run('own', steps), message: 'next' });
    const compaction = selected.compaction!;
    const lines = (compaction.text.match(/^- Message \d+:/gm) ?? []).length;
    expect(compaction.listed).toBe(lines);
    expect(compaction.listed).toBeLessThan(compaction.turns.length);
  });
});
