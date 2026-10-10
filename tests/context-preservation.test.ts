import { describe, expect, test } from 'vitest';
import { compactTurns, SUMMARY_MAX_CHARS } from '../server/harness/context-assembly.js';
import { summarisedCount } from '../shared/context-accounting.js';

const turn = (index: number, prompt: string | null, answer: string | null) => ({
  runId: 'owned-history', stepId: `turn:${index}`, index, prompt, answer,
});

describe('complete omitted-history context', () => {
  test('retains late corrections on both sides without normalizing their source text', () => {
    const prompt = 'The delivery date is Friday.\nCorrection: it must arrive on Monday.';
    const answer = 'The purchase is approved.\n  Approval is still pending; do not order.';
    const record = compactTurns([turn(1, prompt, answer)]);
    expect(record.text).toContain(prompt);
    expect(record.text).toContain(answer);
    expect(record.method).toBe('verbatim-turns/1');
    expect(summarisedCount(record)).toBe(1);
  });

  test('retains complete long-opening exceptions, including Unicode, within the existing bound', () => {
    const answer = `${'Scheduled delivery detail '.repeat(16)}\u{1F600}. Exception: wait for the owner.`;
    const record = compactTurns([turn(2, 'What is the status?', answer)]);
    expect(record.text).toContain(answer);
    expect(record.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(record.bytes).toBe(Buffer.byteLength(record.text));
  });

  test('keeps an earlier assertion and its separate later correction together', () => {
    const turns = [
      turn(2, 'Status?', 'The order is approved.'),
      turn(3, 'A later update arrived. Approval is pending; do not order.', 'Update recorded.'),
    ];
    const record = compactTurns(turns);
    expect(record.text).toContain(turns[0].answer);
    expect(record.text).toContain(turns[1].prompt);
    expect(record.listed).toBe(2);
    expect(compactTurns(turns)).toEqual(record);
  });

  test('when the complete group cannot fit, emits no partial claims from that group', () => {
    const record = compactTurns([
      turn(2, 'Status?', 'The order is approved.'),
      turn(3, `${'Details '.repeat(SUMMARY_MAX_CHARS)}Correction: approval is pending.`, 'Noted.'),
    ]);
    expect(record.text).not.toContain('The order is approved.');
    expect(record.text).not.toContain('Details');
    expect(record.text).toContain('may contain corrections or limits');
    expect(record.text).toContain('2 earlier messages');
    expect(record.listed).toBe(0);
    expect(record.turns).toHaveLength(2);
    expect(record.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  test('does not label a partial long message as a complete source', () => {
    const answer = `Approved. ${'background '.repeat(SUMMARY_MAX_CHARS)}Do not proceed.`;
    const record = compactTurns([turn(1, 'Status?', answer)]);
    expect(record.text).not.toContain('Approved.');
    expect(record.text).not.toContain('background');
    expect(summarisedCount(record)).toBe(0);
    expect(record.turns[0].answerSha).toMatch(/^[a-f0-9]{64}$/);
  });

  test('keeps null and empty source sides distinct', () => {
    const record = compactTurns([turn(1, null, ''), turn(2, '', null)]);
    expect(record.turns[0].promptSha).toBeNull();
    expect(record.turns[0].answerSha).not.toBeNull();
    expect(record.turns[1].promptSha).not.toBeNull();
    expect(record.turns[1].answerSha).toBeNull();
    expect(record.listed).toBe(2);
  });
});
