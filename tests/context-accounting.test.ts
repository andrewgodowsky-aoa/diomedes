/**
 * H18: context accounting, selective retrieval, the stable prefix and safe compaction on the
 * Diomedes-owned model routes (server/harness/context-assembly.ts, shared/context-accounting.ts).
 */
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import type { HarnessRun } from '../shared/harness';
import {
  CONTEXT_SECTION_IDS,
  estimateTokens,
  formatTokens,
  modelContextWindow,
  type ContextAccount,
} from '../shared/context-accounting';
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, boundedHistory } from '../server/harness/conversation-history';
import {
  RECENT_KEEP,
  SUMMARY_MAX_CHARS,
  accountContext,
  cacheSupport,
  compactTurns,
  reconcileContext,
  relevance,
  selectHistory,
  stablePrefix,
} from '../server/harness/context-assembly';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const turn = (key: string, prompt: string, answer: string | null, state = 'succeeded') => ({
  intent: { stepId: `turn:${key}`, input: { prompt } },
  output: { response: answer === null ? null : { text: answer } },
  state,
});
const run = (steps: unknown[], patch: Record<string, unknown> = {}) =>
  ({
    id: 'own-run',
    projectId: 'p1',
    capabilityId: 'model-api-conversation',
    input: { projectId: 'p1', threadId: 't1' },
    steps,
    ...patch,
  }) as unknown as HarnessRun;
const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) =>
    turn(`${prefix}${index + 1}`, `${prefix}${index + 1} asks about lunch`, `${prefix}${index + 1} said soup.`),
  );

describe('the estimate and the window', () => {
  test('one token per four bytes of UTF-8, rounded up, and the window only where declared', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    // Four bytes each: the estimate is of bytes, not of characters.
    expect(estimateTokens('\u{1F35E}\u{1F35E}')).toBe(2);
    expect(modelContextWindow('aws-bedrock', 'us.openai.gpt-5.6-luna')).toEqual({ tokens: null, source: 'not declared' });
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1_200)).toBe('1.2k');
    expect(formatTokens(2_000)).toBe('2k');
    expect(formatTokens(18_400)).toBe('18k');
  });
});

describe('selective retrieval', () => {
  test('a history inside its budget is exactly the bounded history, with no selection record', () => {
    const own = run(numbered('O', 5));
    const selected = selectHistory({ own, message: 'anything' });
    expect(selected.text).toBe(boundedHistory([own]).text);
    expect(selected.selection).toBeNull();
    expect(selected.compaction).toBeNull();
    expect(selected.messages).toEqual(new Map([['own-run', 5]]));
  });

  test('over the budget: the newest and the opening message stay, the relevant one is recalled, the rest are summarised', () => {
    const steps = numbered('O', 20);
    // Message 3 is about the invoice; nothing else is.
    steps[2] = turn('O3', 'Where is the linen invoice from Harbor Supply?', 'The linen invoice is in invoices/harbor.md. It is due Friday.');
    const own = run(steps);
    const selected = selectHistory({ own, message: 'Has the Harbor Supply invoice been paid?' });
    const selection = selected.selection!;
    expect(selection.method).toBe('recency+lexical/1');
    expect(selection.available).toBe(20);
    expect(selection.budget).toEqual({ turns: MAX_HISTORY_TURNS, chars: MAX_HISTORY_CHARS });
    const by = (reason: string) => selection.included.filter((item) => item.reason === reason).map((item) => item.index);
    // Never dropped: the newest messages and the conversation's opening one.
    expect(by('recent')).toEqual([15, 16, 17, 18, 19, 20]);
    expect(by('pinned')).toEqual([1]);
    // Recalled ahead of newer ones for sharing words with this message.
    expect(by('relevant')).toContain(3);
    expect(selection.included.find((item) => item.index === 3)!.score).toBeGreaterThan(0);
    expect(selection.included).toHaveLength(MAX_HISTORY_TURNS);
    expect(selection.omitted).toHaveLength(8);
    expect(selection.omitted.every((item) => !item.carried)).toBe(true);
    // In the text, oldest first, as a conversation reads.
    expect(selected.text).toContain('Person: Where is the linen invoice from Harbor Supply?');
    expect(selected.text.indexOf('Person: O1 asks')).toBeLessThan(selected.text.indexOf('Person: Where is the linen'));
    expect(selected.text.indexOf('Person: Where is the linen')).toBeLessThan(selected.text.indexOf('Person: O20 asks'));
    // The marker says what was left out, by message number, and the summary is marked as one.
    const omitted = selection.omitted.map((item) => item.index);
    expect(selection.marker).toContain(`left out ${omitted.length} earlier messages`);
    expect(omitted).toEqual([2, 4, 5, 6, 7, 8, 9, 10]);
    expect(selection.marker).toContain('(2, 4–10)');
    expect(selected.text.startsWith(selection.marker!)).toBe(true);
    const compaction = selected.compaction!;
    expect(compaction.kind).toBe('summary');
    expect(compaction.author).toBe('diomedes-application');
    expect(compaction.turns.map((item) => item.index)).toEqual(omitted);
    expect(selected.text).toContain(compaction.text);
    expect(selected.text.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS + 1);
  });

  test('the newest messages are never dropped for relevance, whatever the message says', () => {
    const own = run(numbered('O', 30));
    const selected = selectHistory({ own, message: 'O2 asks about lunch O3 asks about lunch O4 O5 O6 O7 O8' });
    const indexes = selected.selection!.included.map((item) => item.index);
    for (let index = 31 - RECENT_KEEP; index <= 30; index++) expect(indexes).toContain(index);
  });

  test('carried messages from a retired lineage give way first and are not summarised', () => {
    const carried = run(numbered('C', 3), { id: 'carried-run' });
    const own = run(numbered('O', 12));
    const selected = selectHistory({ carried, own, message: 'C1 C2 C3 lunch' });
    expect(selected.text).not.toContain('C1 asks');
    expect(selected.messages).toEqual(new Map([['own-run', 12]]));
    const selection = selected.selection!;
    expect(selection.omitted.map((item) => [item.runId, item.carried])).toEqual([
      ['carried-run', true],
      ['carried-run', true],
      ['carried-run', true],
    ]);
    expect(selected.compaction).toBeNull();
    expect(selection.marker).toContain('3 earlier messages');
    expect(selection.marker).toContain('not summarised');
    // The same answer the bounded reader gives for which messages reach the model.
    expect(boundedHistory([carried, own]).messages).toEqual(selected.messages);
  });

  test('when the newest messages alone pass the character bound, the oldest part is cut, never the newest', () => {
    const long = (tag: string) => `${tag}${'x'.repeat(9_990)}`;
    const own = run([turn('1', long('first'), 'ok'), turn('2', long('second'), 'ok'), turn('3', long('third'), 'ok')]);
    const selected = selectHistory({ own, message: 'next' });
    expect(selected.text).toBe(boundedHistory([own]).text);
    expect(selected.selection!.cutChars).toBeGreaterThan(0);
    expect(selected.selection!.omitted).toEqual([]);
    expect(selected.text.endsWith('Diomedes: ok')).toBe(true);
  });

  test('relevance is lexical, deterministic and ignores filler words', () => {
    expect(relevance('the invoice from Harbor', 'Harbor invoice paid?')).toBeGreaterThan(0);
    expect(relevance('the and of with', 'the and of with')).toBe(0);
    expect(relevance('Lunch menu', 'lunch')).toBe(relevance('Lunch menu', 'lunch'));
  });
});

describe('safe compaction', () => {
  test('a deterministic extract, attributed to the application, naming each turn and the sha of what it said', () => {
    const turns = [
      { runId: 'own-run', stepId: 'turn:a', index: 2, prompt: 'Where is the linen order? It was due.', answer: 'It shipped Tuesday. Tracking is in orders.md.' },
      { runId: 'own-run', stepId: 'turn:b', index: 4, prompt: 'Thanks', answer: null },
    ];
    const first = compactTurns(turns);
    expect(compactTurns(turns)).toEqual(first);
    expect(first.v).toBe(1);
    expect(first.method).toBe('extract-first-sentence/1');
    expect(first.author).toBe('diomedes-application');
    expect(first.turns).toEqual([
      { runId: 'own-run', stepId: 'turn:a', index: 2, promptSha: sha(turns[0].prompt), answerSha: sha(turns[0].answer!) },
      { runId: 'own-run', stepId: 'turn:b', index: 4, promptSha: sha('Thanks'), answerSha: null },
    ]);
    expect(first.text).toContain('Where is the linen order?');
    expect(first.text).not.toContain('It was due');
    expect(first.text).toContain('It shipped Tuesday.');
    expect(first.text).toContain('no model wrote');
    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.bytes).toBe(Buffer.byteLength(first.text));
  });

  test('the summary is bounded and says how many it did not list', () => {
    const turns = Array.from({ length: 60 }, (_, index) => ({
      runId: 'own-run',
      stepId: `turn:${index}`,
      index: index + 1,
      prompt: `Question ${index} ${'about the weekly schedule '.repeat(6)}`,
      answer: `Answer ${index}.`,
    }));
    const record = compactTurns(turns);
    expect(record.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(record.text).toMatch(/\d+ more were left out without a line here/);
    expect(record.turns).toHaveLength(60);
  });

  test('the summarised messages stay in the run they came from', () => {
    const steps = numbered('O', 20);
    const own = run(steps);
    const before = JSON.stringify(own);
    const selected = selectHistory({ own, message: 'lunch' });
    expect(selected.compaction).not.toBeNull();
    expect(JSON.stringify(own)).toBe(before);
    for (const item of selected.compaction!.turns) {
      const step = own.steps.find((candidate) => candidate.intent.stepId === item.stepId)!;
      expect(item.promptSha).toBe(sha((step.intent.input as { prompt: string }).prompt));
    }
  });
});

describe('the stable prefix', () => {
  test('is the lineage instructions and the tool note, byte-identical whatever the read scope adds after it', () => {
    const lineage = 'You answer questions about the kitchen.\n\nAnswer format here.';
    const a = stablePrefix(lineage, 'Web access is not available.');
    const b = stablePrefix(lineage, 'fetch_page opens one public web page by its full address.');
    expect(a.prefix).toBe(b.prefix);
    expect(a.sha).toBe(b.sha);
    expect(a.instructions.startsWith(a.prefix)).toBe(true);
    expect(b.instructions.startsWith(b.prefix)).toBe(true);
    expect(a.instructions).not.toBe(b.instructions);
    expect(a.bytes).toBe(Buffer.byteLength(a.prefix));
    expect(stablePrefix(lineage, null).instructions).toBe(a.prefix);
  });

  test('each route declares what this build does about prompt caching', () => {
    expect(cacheSupport('aws-bedrock').support).toBe('automatic-prefix');
    expect(cacheSupport('azure-openai').support).toBe('automatic-prefix');
    expect(cacheSupport('google-vertex').support).toBe('automatic-prefix');
    expect(cacheSupport('openrouter').support).toBe('not-wired');
    expect(cacheSupport('elsewhere').support).toBe('not-wired');
  });
});

describe('the budget table and usage reconciliation', () => {
  const tools = [{ name: 'read_source', description: 'Read one attached file.' }];
  const base = () =>
    accountContext({
      route: 'aws-bedrock',
      model: 'us.openai.gpt-5.6-luna',
      system: 'MODE TEXT\n\nFORMAT TEXT\n\nTOOL NOTE',
      guidance: ['FORMAT TEXT', 'NOT PRESENT'],
      tools,
      parts: { history: 'Earlier in this conversation:\n\nPerson: hi', files: 'Files attached:\n- menu.md', message: "The person's message:\n\nWhat's for lunch?" },
      separatorBytes: 14,
      documents: 1,
      requestLimitBytes: 200_000,
      prefix: { sha: 'a'.repeat(64), bytes: 30 },
      previousPrefixSha: null,
      history: null,
      compaction: null,
    });

  test('every byte sent is in exactly one section, and the estimate is the sum of the sections', () => {
    const account = base();
    expect(account.sections.map((section) => section.id)).toEqual(CONTEXT_SECTION_IDS.filter((id) => id !== 'tool-results'));
    const bytes = Object.fromEntries(account.sections.map((section) => [section.id, section.bytes]));
    expect(bytes['answer-format']).toBe(Buffer.byteLength('FORMAT TEXT'));
    expect(bytes.instructions).toBe(Buffer.byteLength('MODE TEXT\n\nFORMAT TEXT\n\nTOOL NOTE') - Buffer.byteLength('FORMAT TEXT'));
    expect(bytes.tools).toBe(Buffer.byteLength(JSON.stringify(tools)));
    expect(bytes.history).toBe(Buffer.byteLength('Earlier in this conversation:\n\nPerson: hi'));
    expect(bytes['project-files']).toBe(Buffer.byteLength('Files attached:\n- menu.md'));
    expect(bytes.message).toBe(Buffer.byteLength("The person's message:\n\nWhat's for lunch?") + 14);
    expect(account.estimatedTokens).toBe(account.sections.reduce((sum, section) => sum + section.estimatedTokens, 0));
    for (const section of account.sections) expect(section.estimatedTokens).toBe(Math.ceil(section.bytes / 4));
    expect(account.window).toEqual({ tokens: null, source: 'not declared' });
    expect(account.stablePrefix).toEqual({ sha: 'a'.repeat(64), bytes: 30, sameAsPrevious: null });
    expect(account.provider).toBeNull();
    expect(account.reconciliation).toBeNull();
    expect(account.cache.support).toBe('automatic-prefix');
  });

  test('provider usage is summed across calls, cache reads kept apart, and the first call reconciled', () => {
    const child = {
      steps: [
        { intent: { stepId: 'model:0', kind: 'model' }, state: 'succeeded', output: { usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
        { intent: { stepId: 'tool:0', kind: 'tool' }, state: 'succeeded', output: { path: 'menu.md', text: 'Soup' } },
        { intent: { stepId: 'model:1', kind: 'model' }, state: 'succeeded', output: { usage: { inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 850, cacheWriteTokens: 0 } } },
      ],
    } as unknown as HarnessRun;
    const account = reconcileContext(base(), child);
    expect(account.provider).toEqual({
      calls: 2,
      reportedCalls: 2,
      inputTokens: 1_900,
      cacheReadTokens: 850,
      cacheWriteTokens: 0,
      outputTokens: 60,
      firstCallInputTokens: 900,
    });
    expect(account.reconciliation).toEqual({
      estimated: account.estimatedTokens,
      reported: 900,
      difference: 900 - account.estimatedTokens,
    });
    const results = account.sections.find((section) => section.id === 'tool-results')!;
    expect(results.bytes).toBe(Buffer.byteLength(JSON.stringify({ path: 'menu.md', text: 'Soup' })));
    expect(results.detail).toBe('1 tool call, sent back on later calls');
    // The first call's estimate never includes what only later calls carried.
    expect(account.estimatedTokens).toBe(base().estimatedTokens);
  });

  test('missing usage is unknown, never zero', () => {
    const child = {
      steps: [{ intent: { stepId: 'model:0', kind: 'model' }, state: 'succeeded', output: { usage: null } }],
    } as unknown as HarnessRun;
    const account: ContextAccount = reconcileContext(base(), child);
    expect(account.provider).toEqual({
      calls: 1,
      reportedCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      firstCallInputTokens: null,
    });
    expect(account.reconciliation).toBeNull();
  });

  test('the prefix is compared with the previous turn of the same conversation', () => {
    const same = accountContext({ ...baseInput(), previousPrefixSha: 'a'.repeat(64) });
    expect(same.stablePrefix.sameAsPrevious).toBe(true);
    const changed = accountContext({ ...baseInput(), previousPrefixSha: 'b'.repeat(64) });
    expect(changed.stablePrefix.sameAsPrevious).toBe(false);
  });

  function baseInput() {
    return {
      route: 'aws-bedrock',
      model: 'm',
      system: 'S',
      guidance: [],
      tools: [],
      parts: { history: '', files: 'F', message: 'M' },
      separatorBytes: 7,
      documents: 0,
      requestLimitBytes: null,
      prefix: { sha: 'a'.repeat(64), bytes: 1 },
      previousPrefixSha: null as string | null,
      history: null,
      compaction: null,
    };
  }
});
