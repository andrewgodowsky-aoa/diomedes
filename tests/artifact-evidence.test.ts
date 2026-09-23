/**
 * The Console's reader of recorded artifacts (client/console/artifact-evidence.ts): what the
 * server's writer records (server/harness/artifact-steps.ts, used here as it is) reads back as
 * "recorded" against the same text, and anything else is said: a changed block is "changed since
 * recorded", a place that no longer holds an artifact is missing, and nothing unchecked passes.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  artifactEvidence,
  EVIDENCE_WORDS,
  readRecordedArtifacts,
  sha256Hex,
} from '../client/console/artifact-evidence';
import { artifactSteps } from '../server/harness/artifact-steps';
import { indexArtifacts } from '../shared/artifacts';
import { projectedTurnIds, turnIdentityText } from '../shared/conversation-turn-id';
import { recordedArtifactOf, recordedArtifactsOf, type RecordedArtifact } from '../shared/recorded-artifact';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const RUN = 'model-conversation-7';
const SM = 'sm.' + 'c'.repeat(32);
const ANSWER = [
  'The delivery and the label.',
  '',
  '```mermaid',
  '%% artifact: id=delivery title="Delivery"',
  'graph LR',
  '  Bakery --> Kitchen',
  '```',
  '',
  '```markdown',
  '<!-- artifact: id=label title="Shelf label" -->',
  '# Rye',
  '',
  'Twelve loaves, baked Friday.',
  '```',
].join('\n');
const TURN = projectedTurnIds(sha(turnIdentityText(RUN, 'm-1'))).assistant;
/** What the server records for this answer, as the run read returns it. */
const recorded: RecordedArtifact[] = artifactSteps({
  runId: RUN,
  threadId: 't-9',
  commandId: 'm-1',
  sourceMessageId: SM,
  turnStepId: 'turn:' + 'd'.repeat(40),
  answer: ANSWER,
}).map((step) => recordedArtifactOf(step.input)!);
const thread = (text: string) => [
  { id: 'Uyou-1', role: 'you', text: 'Draw the delivery and the label.' },
  { id: TURN, role: 'assistant', text },
];
const evidenceFor = (text: string) => {
  const turns = thread(text);
  return artifactEvidence(recorded, indexArtifacts('t-9', turns), turns);
};
const states = async (text: string) => (await evidenceFor(text)).map((item) => item.state);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('artifactEvidence', () => {
  test('what the server recorded reads as recorded against the text it recorded, and opens that text', async () => {
    expect(recorded).toHaveLength(2);
    const evidence = await evidenceFor(ANSWER);
    expect(evidence.map((item) => item.state)).toEqual(['recorded', 'recorded']);
    const index = indexArtifacts('t-9', thread(ANSWER));
    expect(evidence.map((item) => item.record)).toEqual(index.list);
    expect(EVIDENCE_WORDS.recorded).toBe('As recorded');
  });

  test('a block whose text changed is "changed since recorded", and still opens from the text', async () => {
    const edited = ANSWER.replace('Bakery --> Kitchen', 'Bakery --> Freezer');
    const evidence = await evidenceFor(edited);
    expect(evidence.map((item) => item.state)).toEqual(['changed', 'recorded']);
    expect(EVIDENCE_WORDS[evidence[0].state]).toBe('Changed since recorded');
    expect(evidence[0].record?.source).toContain('Bakery --> Freezer');
    // A change of kind at the same place is a change too, whatever its digest.
    const retyped = ANSWER.replace('```markdown', '```html');
    expect(await states(retyped)).toEqual(['recorded', 'changed']);
  });

  test('a place that no longer holds an artifact is missing, with nothing to open', async () => {
    const flattened = ANSWER.replace('```mermaid', '```text');
    const evidence = await evidenceFor(flattened);
    expect(evidence.map((item) => item.state)).toEqual(['missing', 'recorded']);
    expect(evidence[0].record).toBeNull();
    expect(EVIDENCE_WORDS.missing).toBe('No longer in the conversation');
  });

  test('a record whose answer the thread does not show yet is left out, not called a change', async () => {
    const turns = [{ id: 'Uyou-1', role: 'you', text: 'Draw the delivery and the label.' }];
    expect(await artifactEvidence(recorded, indexArtifacts('t-9', turns), turns)).toEqual([]);
  });

  test('a digest that cannot be computed is never read as a match', async () => {
    const turns = thread(ANSWER);
    await expect(
      artifactEvidence(recorded, indexArtifacts('t-9', turns), turns, () => Promise.reject(new Error('no digest here'))),
    ).rejects.toThrow('no digest here');
  });

  test('the browser digest is the server\'s: SHA-256 of the UTF-8 bytes, in lowercase hex', async () => {
    for (const text of ['', 'graph LR\n  A --> B', 'Café, 12 € — naïve ✓ 🍞']) expect(await sha256Hex(text)).toBe(sha(text));
  });
});

describe('reading what a run recorded', () => {
  const step = (input: unknown, state = 'succeeded', stepId = 'artifact.v1:' + 'e'.repeat(40)) => ({
    intent: { stepId, input },
    state,
  });

  test('only succeeded artifact steps with a well-formed input count, in the order recorded', () => {
    const [first, second] = recorded;
    expect(
      recordedArtifactsOf({
        steps: [
          step(first),
          step({ phase: 'decision' }, 'succeeded', 'phase.decision:x'),
          step(second, 'retry_wait'),
          step({ ...second, sha256: 'not-a-digest' }),
          step({ ...second, source: undefined, blockIndex: -1 }),
          step(second),
        ],
      }),
    ).toEqual([first, second]);
    expect(recordedArtifactOf({ ...first, v: 2 })).toBeNull();
    expect(recordedArtifactOf(null)).toBeNull();
  });

  test('each lineage run is read through the existing run read, and a run that is not there reads as nothing', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      if (url.endsWith('/run-old'))
        return new Response(JSON.stringify({ error: 'This run does not exist.' }), { status: 404 });
      return new Response(JSON.stringify({ steps: recorded.map((input) => step(input)) }), { status: 200 });
    });
    expect(await readRecordedArtifacts('p 1', ['run-old', 'model-7'])).toEqual(recorded);
    expect(asked).toEqual(['/api/projects/p%201/harness/runs/run-old', '/api/projects/p%201/harness/runs/model-7']);
  });

  test('any other failure is the caller\'s to show', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'The local service is closing.' }), { status: 503 }));
    await expect(readRecordedArtifacts('p', ['model-7'])).rejects.toThrow('The local service is closing.');
  });
});
