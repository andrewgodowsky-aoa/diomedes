/** Independent acceptance of host-minted ordinary work authority; no model, I/O or selection click. */
import { describe, expect, test } from 'vitest';
import { mintAutomaticWorkRequest, admitAutomaticWork } from '../server/automatic-work-admission.js';
import { conversationCommandIds, proposalDigest } from '../server/interaction-admission.js';
import { interactionDecisionSchema, type InteractionDecision } from '../shared/interaction.js';
import { digest } from '../server/harness/policy.js';

const PROJECT = 'project_inventory';
const OTHER = 'project_other';
const HOME = 'project_home';
const SOURCE = 'sm.0123456789abcdef0123456789abcdef';
const TEXT = 'Reconcile the selected inventory and write an exceptions report.';
const SOURCES = [{ path: 'inventory.txt', sha: digest('A 10/10\nB 8/6\n') }];
const REQUEST_DIGEST = digest({ action: 'message', text: TEXT, mode: 'auto', sources: SOURCES });

function minted(patch: Record<string, unknown> = {}) {
  const input = {
    projectId: PROJECT, threadId: 'inventory-thread', commandId: 'inventory-message',
    sourceMessageId: SOURCE, mode: 'auto', text: TEXT, sources: structuredClone(SOURCES),
    homeProjectId: HOME, requestDigest: REQUEST_DIGEST, ...patch,
  } as Parameters<typeof mintAutomaticWorkRequest>[0];
  if (!Object.hasOwn(patch, 'requestDigest')) input.requestDigest = digest({
    action: 'message', text: input.text, mode: input.mode, sources: input.sources,
  });
  return mintAutomaticWorkRequest(input);
}

function decision(patch: Partial<InteractionDecision> = {}): InteractionDecision {
  return interactionDecisionSchema.parse({
    sourceMessageId: SOURCE, disposition: 'act', requestedProjectId: null,
    operationClass: 'write_internal', sourceRefs: ['inventory.txt'], targetRunId: null,
    question: null, publicSummary: 'Prepare the inventory exceptions report.', ...patch,
  });
}

function admitted(patch: Record<string, unknown> = {}) {
  const request = minted();
  expect(request, 'an ordinary explicit request is minted by the production host classifier').not.toBeNull();
  return admitAutomaticWork({ request: request!, decision: decision(), restriction: 'automatic',
    conversationProjectId: PROJECT, homeProjectId: HOME, targetableProjectIds: [PROJECT, OTHER],
    ...patch,
  } as Parameters<typeof admitAutomaticWork>[0]);
}

describe('automatic work from the person’s ordinary request', () => {
  test('pins command, message, source bytes, project and operation ceiling without an extra selection', () => {
    const sources = structuredClone(SOURCES);
    const request = minted({ sources });
    expect(request).toEqual({
      v: 1, kind: 'explicit-request', policyRevision: 'automatic-work-v1',
      sourceProjectId: PROJECT, threadId: 'inventory-thread', commandId: 'inventory-message',
      sourceMessageId: SOURCE, requestDigest: REQUEST_DIGEST, goal: TEXT,
      sources: SOURCES, targetProjectId: PROJECT, operationCeiling: 'write_internal',
    });
    sources[0].sha = digest('different bytes');
    expect(request!.sources).toEqual(SOURCES);
    expect(request).not.toHaveProperty('selection');
    expect(request).not.toHaveProperty('consent');
    expect(admitted()).toEqual({ outcome: 'escalate', projectId: PROJECT,
      operationClass: 'write_internal', proposalDigest: proposalDigest(decision(), PROJECT),
      ...conversationCommandIds(SOURCE),
    });
  });

  test('an identical persisted request yields the same task/work identities after reconstruction', () => {
    const request = minted();
    expect(minted()).toEqual(request);
    const reloaded = JSON.parse(JSON.stringify(request));
    const verdict = admitted({ request: reloaded });
    expect(verdict).toEqual(admitted());
    expect(verdict).toMatchObject(conversationCommandIds(SOURCE));
  });

  test.each([
    'Good morning.', 'What does this inventory mean?', 'Can you explain how reconciliation works?',
    'Just explain the discrepancy; do not change anything.',
    'You could also make a purchasing forecast if useful.',
    'Reconcile the inventory, but do not change any files.',
    'Write a description of the discrepancy without editing anything.',
    'Write the inventory report, but do not change or write any files.',
    'Reconcile inventory.txt, but do not modify, edit or create files.',
  ])('does not mint task authority from “%s”', (text) => {
    expect(minted({ text })).toBeNull();
  });

  test.each(['ask', 'plan', 'build', 'fix'])('only Automatic mints authority; %s keeps its existing contract', (mode) => {
    expect(minted({ mode })).toBeNull();
  });

  test('the reserved workspace home never silently chooses a Project', () => {
    expect(minted({ projectId: HOME })).toBeNull();
  });

  test('a stale message or policy refuses with the exact code before starting work', () => {
    expect(admitted({ decision: decision({ sourceMessageId: 'sm.' + 'f'.repeat(32) }) }))
      .toEqual({ outcome: 'blocked', reason: 'stale-request' });
    expect(admitted({ request: { ...minted(), policyRevision: 'retired-policy' } }))
      .toEqual({ outcome: 'blocked', reason: 'stale-request' });
  });

  test('changed source bytes or changed original goal cannot keep the admitted request digest', () => {
    const request = minted();
    expect(request).not.toBeNull();
    for (const altered of [
      { ...request!, sources: [{ ...SOURCES[0], sha: digest('changed source') }] },
      { ...request!, goal: 'Delete the inventory and replace it with guessed counts.' },
    ]) expect(admitted({ request: altered })).toEqual({ outcome: 'blocked', reason: 'stale-request' });
  });

  test('a forged digest or noncanonical source path never mints authority', () => {
    expect(minted({ requestDigest: digest('forged') })).toBeNull();
    expect(minted({ sources: [{ path: '../private.txt', sha: SOURCES[0]!.sha }] })).toBeNull();
    expect(minted({ sources: [SOURCES[0], { ...SOURCES[0], path: 'INVENTORY.TXT' }] })).toBeNull();
  });

  test('a model cannot turn this request into another Project or source scope', () => {
    expect(admitted({ decision: decision({ requestedProjectId: OTHER }) }))
      .toEqual({ outcome: 'blocked', reason: 'request-out-of-scope' });
    expect(admitted({ decision: decision({ sourceRefs: ['private-payroll.txt'] }) }))
      .toEqual({ outcome: 'blocked', reason: 'request-out-of-scope' });
    expect(admitted({ conversationProjectId: OTHER }))
      .toEqual({ outcome: 'blocked', reason: 'stale-request' });
  });

  test('current explicit limits never revive automatic authority from a stored request', () => {
    for (const restriction of ['answer-only', 'plan-only']) {
      expect(admitted({ restriction })).toEqual({ outcome: 'blocked', reason: 'above-ceiling' });
    }
  });

  test('the minted internal-write ceiling cannot authorize external sends or run control', () => {
    expect(admitted({ decision: decision({ operationClass: 'send_external' }) }))
      .toEqual({ outcome: 'blocked', reason: 'send-not-reachable' });
    expect(admitted({ decision: decision({ disposition: 'control', operationClass: 'control_run', targetRunId: 'another-root' }) }))
      .toEqual({ outcome: 'blocked', reason: 'control-not-reachable' });
  });

  test('inert replies do not create work even when the person’s request was actionable', () => {
    expect(admitted({ decision: decision({ disposition: 'respond', operationClass: 'none', sourceRefs: [] }) }))
      .toEqual({ outcome: 'inert' });
  });
});
