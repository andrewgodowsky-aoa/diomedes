import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** The app-server shapes the kept ChatGPT conversation relies on, as the pinned runtime generates them. */
const dir = path.resolve('evidence/codex-app-server-0.153.4');
const schema = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));

describe('the Codex 0.153.4 app-server shapes a ChatGPT conversation relies on', () => {
  test('turn/interrupt names the thread and the turn, and answers with nothing', () => {
    expect([...schema('TurnInterruptParams').required].sort()).toEqual(['threadId', 'turnId']);
    expect(schema('TurnInterruptResponse').properties ?? {}).toEqual({});
  });
  test('turn/start carries a reasoning summary setting, and none is one of its values', () => {
    const params = schema('TurnStartParams');
    expect(params.properties.summary).toBeDefined();
    const values = params.definitions.ReasoningSummary.oneOf.flatMap(
      (entry: { enum: string[] }) => entry.enum,
    );
    expect(values).toEqual(expect.arrayContaining(['auto', 'none']));
  });
  test('turn/start answers with the turn id, and a finished turn says when it was interrupted', () => {
    const answer = schema('TurnStartResponse');
    expect(answer.required).toContain('turn');
    expect(answer.definitions.Turn.required).toEqual(expect.arrayContaining(['id', 'status']));
    expect(answer.definitions.TurnStatus.enum).toEqual(
      expect.arrayContaining(['completed', 'interrupted', 'failed']),
    );
    expect([...schema('TurnCompletedNotification').required].sort()).toEqual(['threadId', 'turn']);
  });
  test('reasoning summaries stream as deltas that name their part', () => {
    expect([...schema('ReasoningSummaryTextDeltaNotification').required].sort()).toEqual([
      'delta',
      'itemId',
      'summaryIndex',
      'threadId',
      'turnId',
    ]);
    expect([...schema('ReasoningSummaryPartAddedNotification').required].sort()).toEqual([
      'itemId',
      'summaryIndex',
      'threadId',
      'turnId',
    ]);
  });
});
