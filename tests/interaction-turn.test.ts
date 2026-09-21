import { describe, expect, it } from 'vitest';
import { ISSUED_SOURCE_ID, PACKAGE_FIELD_NAMES } from '../shared/interaction.js';
import { MODES } from '../server/modes.js';
import type { InteractionPhase } from '../server/harness/claude-session-run.js';
import type { AdmissionVerdict } from '../server/interaction-admission.js';
import {
  commandBinding,
  DECISION_FORMAT,
  decideWith,
  instructionsFor,
  outcomeOf,
  previewGate,
  promptFor,
  restrictionOf,
  sourceMessageIdFor,
  splitDecision,
} from '../server/interaction-turn.js';

const SM = sourceMessageIdFor('linen0000001', 'thread-1', 'command-1');
const block = (fields: Record<string, unknown>) =>
  '```diomedes-decision\n' + JSON.stringify(fields) + '\n```';
const proposal = (patch: Record<string, unknown> = {}) => ({
  source_message_id: SM,
  disposition: 'act',
  requested_project_id: null,
  operation_class: 'write_internal',
  source_refs: [],
  target_run_id: null,
  question: null,
  public_summary: 'Order the usual from the bakery supplier.',
  ...patch,
});

describe('identities', () => {
  it('issues one identity per project, thread and command, in the frozen shape', () => {
    expect(SM).toMatch(ISSUED_SOURCE_ID);
    expect(sourceMessageIdFor('linen0000001', 'thread-1', 'command-1')).toBe(SM);
    expect(sourceMessageIdFor('linen0000001', 'thread-1', 'command-2')).not.toBe(SM);
    expect(sourceMessageIdFor('linen0000001', 'thread-2', 'command-1')).not.toBe(SM);
    expect(sourceMessageIdFor('cater0000002', 'thread-1', 'command-1')).not.toBe(SM);
  });

  it('binds the text, the mode, each source with its version and order, and the action', () => {
    const sources = [
      { path: 'a.md', sha: 'a'.repeat(64) },
      { path: 'b.md', sha: 'b'.repeat(64) },
    ];
    const command = { text: 'hello', mode: 'auto' as const, sources };
    const bound = commandBinding('start', command);
    expect(commandBinding('start', { ...command, sources: [...sources] })).toBe(bound);
    expect(commandBinding('follow-up', command)).not.toBe(bound);
    expect(commandBinding('start', { ...command, text: 'hello ' })).not.toBe(bound);
    expect(commandBinding('start', { ...command, mode: 'ask' })).not.toBe(bound);
    expect(commandBinding('start', { ...command, sources: [sources[1], sources[0]] })).not.toBe(bound);
    expect(
      commandBinding('start', { ...command, sources: [sources[0], { ...sources[1], sha: 'c'.repeat(64) }] }),
    ).not.toBe(bound);
  });

  it('resolves the restriction from the Mode control alone', () => {
    expect(restrictionOf('auto')).toBe('automatic');
    expect(restrictionOf('ask')).toBe('answer-only');
    expect(restrictionOf('plan')).toBe('plan-only');
  });

  it('gives only an Automatic message the identity trailer', () => {
    expect(promptFor('auto', 'Order the usual', SM)).toBe(
      `Order the usual\n\n[[diomedes source_message_id=${SM}]]`,
    );
    expect(promptFor('ask', 'Order the usual', SM)).toBe('Order the usual');
    expect(promptFor('plan', 'Order the usual', SM)).toBe('Order the usual');
  });
});

describe('splitDecision', () => {
  it('reads an answer with no block as an answer', () => {
    const split = splitDecision('  Tuesday, per prices.md.  ', SM, 'automatic', 'When?');
    expect(split.answerText).toBe('Tuesday, per prices.md.');
    expect(split.body).toMatchObject({ block: 'absent', restriction: 'automatic', raw: null });
    expect(split.body.decision).toMatchObject({
      sourceMessageId: SM,
      disposition: 'respond',
      operationClass: 'none',
    });
  });

  it('takes the last block as the proposal and everything before it as the answer', () => {
    const answer = `I can start that.\n\n${block(proposal({ disposition: 'plan', operation_class: 'none' }))}\n\nMore.\n\n${block(proposal())}`;
    const split = splitDecision(answer, SM, 'automatic', 'Order the usual');
    expect(split.body.block).toBe('parsed');
    expect(split.body.decision).toMatchObject({
      disposition: 'act',
      operationClass: 'write_internal',
      publicSummary: 'Order the usual from the bakery supplier.',
    });
    expect(split.answerText.startsWith('I can start that.')).toBe(true);
    expect(split.answerText.endsWith('More.')).toBe(true);
  });

  it('degrades every block that is not a valid proposal for this message to an answer', () => {
    const cases: Record<string, string> = {
      'not JSON': '```diomedes-decision\n{not json}\n```',
      'an array': '```diomedes-decision\n[]\n```',
      'never closed': '```diomedes-decision\n' + JSON.stringify(proposal()),
      'a field the package does not name': block({ ...proposal(), extra: true }),
      'camelCase names': block({ ...proposal(), sourceMessageId: SM }),
      'a missing field': block({ ...proposal(), question: undefined }),
      'an operation class the disposition may not name': block(
        proposal({ disposition: 'respond', operation_class: 'write_internal' }),
      ),
      'another message’s identity': block(proposal({ source_message_id: 'sm.' + 'f'.repeat(32) })),
      'an identity with a space added': block(proposal({ source_message_id: SM + ' ' })),
    };
    for (const [name, text] of Object.entries(cases)) {
      const split = splitDecision(`Here is the answer.\n\n${text}`, SM, 'automatic', 'Order');
      expect(split.body.block, name).toBe('refused');
      expect(split.body.decision, name).toMatchObject({
        disposition: 'respond',
        operationClass: 'none',
        sourceMessageId: SM,
      });
      expect(split.body.raw, name).not.toBeNull();
      expect(split.answerText, name).toBe('Here is the answer.');
    }
  });

  it('refuses any proposal when the identity it was given is not one the server issues', () => {
    const forged = 'client-made-id';
    const split = splitDecision(block(proposal({ source_message_id: forged })), forged, 'automatic', 'x');
    expect(split.body.block).toBe('refused');
  });

  it('is pure: the splitter handed to the driver gives the same body every time', () => {
    const decide = decideWith(SM, 'plan-only', 'Plan the order');
    const answer = `Plan below.\n\n${block(proposal({ disposition: 'plan', operation_class: 'none' }))}`;
    expect(decide(answer)).toEqual(decide(answer));
    expect(decide(answer).body).toMatchObject({
      text: 'Plan the order',
      restriction: 'plan-only',
      block: 'parsed',
    });
  });
});

describe('previewGate', () => {
  const stream = (chunks: string[]) => {
    const gate = previewGate();
    return chunks.map((chunk) => gate(chunk)).join('');
  };
  it('passes an ordinary answer through whole, however it is cut', () => {
    const text = 'Use `code` and ```ts\nfences``` freely. Done';
    expect(stream([text])).toBe(text.slice(0, stream([text]).length));
    expect(text.startsWith(stream(text.split('')))).toBe(true);
    // Only a tail that could still begin the fence is ever held back.
    expect(text.length - stream(text.split('')).length).toBeLessThan('```diomedes-decision'.length);
  });
  it('shows nothing from the opening fence onward, even when the fence arrives in pieces', () => {
    const answer = 'I can start that.\n\n```diomedes-decision\n{"disposition":"act"}\n```';
    for (const size of [1, 2, 3, 7, 1000]) {
      const chunks = answer.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
      const shown = stream(chunks);
      expect(shown, `chunk size ${size}`).toBe('I can start that.\n\n');
      expect(shown).not.toContain('diomedes');
    }
  });
});

describe('outcomeOf', () => {
  const phase = (name: InteractionPhase['phase'], body: unknown): InteractionPhase => ({
    phase: name,
    sourceMessageId: SM,
    body: body as InteractionPhase['body'],
  });
  const decided = phase(
    'decision',
    splitDecision(`Ok.\n\n${block(proposal())}`, SM, 'automatic', 'Order the usual').body,
  );
  const none = { projectId: null, taskId: null, sessionId: null };
  const proposed: AdmissionVerdict = {
    outcome: 'proposed',
    projectId: 'linen0000001',
    operationClass: 'write_internal',
    proposalDigest: 'd'.repeat(64),
  };
  const live = { settled: false };

  it('shows a proposal with its words, and starts nothing', () => {
    expect(outcomeOf([decided], none, proposed, live)).toEqual({
      status: 'proposed',
      projectId: 'linen0000001',
      operationClass: 'write_internal',
      proposalDigest: 'd'.repeat(64),
      summary: 'Order the usual from the bakery supplier.',
    });
  });

  it('reads a receipt as started whether or not its phase was ever linked', () => {
    const receipts = { projectId: 'linen0000001', taskId: 'T7', sessionId: 'S3' };
    const started = { status: 'started', projectId: 'linen0000001', taskId: 'T7', sessionId: 'S3' };
    expect(outcomeOf([decided, phase('task-input', {})], receipts, proposed, live)).toEqual(started);
    expect(outcomeOf([decided], receipts, null, { settled: true })).toEqual(started);
  });

  it('reports a refusal as final, with the task that does exist', () => {
    const phases = [
      decided,
      phase('task-input', {}),
      phase('task-receipt', { taskId: 'T7' }),
      phase('work-input', {}),
      phase('work-refused', { status: 409, message: 'This project is busy.' }),
    ];
    expect(
      outcomeOf(phases, { projectId: 'linen0000001', taskId: 'T7', sessionId: null }, proposed, live),
    ).toEqual({ status: 'not-started', reason: 'refused', message: 'This project is busy.', taskId: 'T7' });
  });

  it('says unresolved when an input has no receipt and no refusal, and never says started', () => {
    const partial = outcomeOf([decided, phase('task-input', {})], none, proposed, live);
    expect(partial.status).toBe('unresolved');
    const taskOnly = outcomeOf(
      [decided],
      { projectId: 'linen0000001', taskId: 'T7', sessionId: null },
      proposed,
      live,
    );
    expect(taskOnly.status).toBe('unresolved');
  });

  it('never offers a proposal on a settled conversation, and never starts one', () => {
    const settled = outcomeOf([decided], none, proposed, { settled: true });
    expect(settled.status).toBe('unresolved');
    // Even with no first phase recorded at all, which is the crash before phase one.
    expect(outcomeOf([], none, proposed, { settled: true }).status).toBe('unresolved');
  });

  it('says why nothing was proposed', () => {
    expect(
      outcomeOf([decided], none, { outcome: 'blocked', reason: 'needs-target' }, live),
    ).toMatchObject({ status: 'not-started', reason: 'needs-target', taskId: null });
    expect(outcomeOf([decided], none, { outcome: 'inert' }, live)).toEqual({ status: 'answered' });
    expect(outcomeOf([decided], none, { outcome: 'read', projectId: 'p' }, live)).toEqual({
      status: 'read',
      projectId: 'p',
    });
  });
});

describe('what the model is told', () => {
  it('names the tag, the identity line and exactly the eight fields the parser accepts', () => {
    expect(DECISION_FORMAT).toContain('fenced block tagged diomedes-decision');
    expect(DECISION_FORMAT).toContain('[[diomedes source_message_id=...]]');
    const named = [...DECISION_FORMAT.matchAll(/^- ([a-z_]+):/gm)].map((match) => match[1]);
    expect(named).toEqual(Object.values(PACKAGE_FIELD_NAMES));
  });

  it('asks for the block under Automatic only, and leaves every Mode text short', () => {
    expect(instructionsFor('ask', MODES.ask.instructions)).toBe(MODES.ask.instructions);
    expect(instructionsFor('plan', MODES.plan.instructions)).toBe(MODES.plan.instructions);
    expect(instructionsFor('auto', MODES.auto.instructions)).toBe(
      `${MODES.auto.instructions}\n\n${DECISION_FORMAT}`,
    );
    expect(MODES.auto.instructions).not.toContain('diomedes-decision');
  });

  it('a block written the way the format describes is the block the parser reads', () => {
    const answer = 'Done.\n\n' + block(proposal());
    const read = splitDecision(answer, SM, 'automatic', 'Order the usual');
    expect(read.body.block).toBe('parsed');
    expect(read.answerText).toBe('Done.');
  });
});
