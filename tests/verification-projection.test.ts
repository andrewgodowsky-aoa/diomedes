import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  VERIFICATION_LABEL,
  canonicalChecks,
  independenceOf,
  runOutputs,
  verificationOf,
  type AcceptanceCheck,
  type AcceptanceDeclaration,
  type VerificationCheckResult,
  type VerificationRecord,
  type VerificationRule,
  type VerificationState,
} from '../shared/verification.js';
import { applicationOrigin, directOrigin, type OriginSnapshot } from '../shared/attribution.js';
import type { FileRecord, HistoryEntry, Session } from '../shared/types.js';

/**
 * H17: the four-state result is a pure projection of the task's declaration,
 * the verification's History entry and History's digests. Every row of the
 * rule table in docs/implementation/2026-09-24-h17-verified-completion.md has
 * a case here, in table order.
 */

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const A1 = sha('menu v1');
const A2 = sha('menu v2');

let seq = 0;
const entry = (over: Partial<Omit<HistoryEntry, 'files'>> & { files?: Partial<FileRecord>[] } = {}): HistoryEntry => ({
  id: `E${++seq}`,
  time: `2026-09-24T00:00:${String(seq).padStart(2, '0')}.000Z`,
  actor: 'diomedes',
  kind: 'changed',
  sentence: 'x',
  sessionId: null,
  taskId: null,
  sample: false,
  label: null,
  restoreOf: null,
  replaced: null,
  versionId: `v${seq}`,
  commit: null,
  ...over,
  files: (over.files ?? []).map(
    (file): FileRecord => ({ path: 'menu.md', op: 'modified', before: null, after: null, recorded: true, reason: null, ...file }),
  ),
});

const CHECKS: AcceptanceCheck[] = [{ id: 'has-menu', kind: 'file-exists', path: 'menu.md' }];
const declaration = (checks: AcceptanceCheck[] = CHECKS): AcceptanceDeclaration => ({
  protocolVersion: 1,
  checks,
  digest: sha(canonicalChecks(checks)),
  declaredAt: '2026-09-24T00:00:00.000Z',
  declaredBy: 'you',
});

const worker = directOrigin({ engine: 'codex', reportedModel: 'gpt-6-astra' });
const verifier: OriginSnapshot = { ...applicationOrigin(), executorId: 'diomedes:verifier' };

const result = (over: Partial<VerificationCheckResult> = {}): VerificationCheckResult => ({
  id: 'has-menu',
  kind: 'file-exists',
  label: 'menu.md exists',
  outcome: 'passed',
  sentence: 'menu.md exists.',
  evidence: [{ path: 'menu.md', sha: A1 }],
  ranAt: '2026-09-24T00:01:00.000Z',
  durationMs: 1,
  origin: verifier,
  ...over,
});

const record = (over: Partial<VerificationRecord> = {}): VerificationRecord => ({
  protocolVersion: 1,
  id: 'Vtest',
  sessionId: 'S1',
  taskId: 'T1',
  declarationDigest: declaration().digest,
  declaredChecks: 1,
  requestedBy: 'you',
  startedAt: '2026-09-24T00:01:00.000Z',
  endedAt: '2026-09-24T00:01:01.000Z',
  producer: worker,
  outputs: [{ path: 'menu.md', sha: A1 }],
  bound: [{ path: 'menu.md', sha: A1 }],
  checks: [
    result({ id: 'outputs-intact', kind: 'outputs-intact', label: 'Outputs intact', sentence: '1 output is intact.' }),
    result(),
  ],
  ...over,
});

const done: Pick<Session, 'id' | 'state'> = { id: 'S1', state: 'done' };
const wrote = () => entry({ sessionId: 'S1', taskId: 'T1', files: [{ after: A1 }] });
const verified = (over: Partial<VerificationRecord> = {}) =>
  entry({ kind: 'verified', actor: 'you', sessionId: 'S1', taskId: 'T1', verification: record(over) });

interface Row {
  name: string;
  session?: Pick<Session, 'id' | 'state'>;
  acceptance?: AcceptanceDeclaration | null;
  history: () => HistoryEntry[];
  state: VerificationState;
  rule: VerificationRule;
  sentence: RegExp;
}

const reviewer = (model: string | null) =>
  result({
    id: 'judged',
    kind: 'review',
    label: 'Reviewer pass',
    origin: directOrigin({ engine: 'codex', reportedModel: model }),
    review: { verdict: 'pass', note: 'Looks right.' },
  });
const reviewDecl = declaration([...CHECKS, { id: 'judged', kind: 'review', instruction: 'Lists every dish.' }]);

const ROWS: Row[] = [
  {
    name: 'a live run is not verified yet',
    session: { id: 'S1', state: 'working' },
    history: () => [wrote()],
    state: 'not-verified',
    rule: 'run-not-finished',
    sentence: /has not finished/,
  },
  {
    name: 'no declared checks is the honest default',
    acceptance: null,
    history: () => [wrote()],
    state: 'not-verified',
    rule: 'no-checks-declared',
    sentence: /No acceptance checks are declared/,
  },
  {
    name: 'declared but never run',
    history: () => [wrote()],
    state: 'not-verified',
    rule: 'checks-not-run',
    sentence: /1 acceptance check declared; not run/,
  },
  {
    name: 'a later write to a verified output flips it to uncertain',
    history: () => [
      wrote(),
      verified(),
      entry({ kind: 'edited', actor: 'you', files: [{ before: A1, after: A2 }] }),
    ],
    state: 'uncertain',
    rule: 'outputs-changed',
    sentence: /menu\.md changed after verification/,
  },
  {
    name: 'an outside change recorded by History flips it to uncertain',
    history: () => [wrote(), verified(), entry({ kind: 'outside', actor: 'you', files: [{ before: A1, after: A2 }] })],
    state: 'uncertain',
    rule: 'outputs-changed',
    sentence: /changed after verification/,
  },
  {
    name: 'deleting a verified output flips it to uncertain',
    history: () => [wrote(), verified(), entry({ kind: 'outside', files: [{ op: 'deleted', before: A1, after: null }] })],
    state: 'uncertain',
    rule: 'outputs-changed',
    sentence: /changed after verification/,
  },
  {
    name: 'a run output the record never bound is uncertain',
    history: () => [
      wrote(),
      verified(),
      entry({ sessionId: 'S1', taskId: 'T1', files: [{ path: 'extra.md', after: A2 }] }),
    ],
    state: 'uncertain',
    rule: 'outputs-changed',
    sentence: /extra\.md changed after verification/,
  },
  {
    name: 'a failed result whose bytes then changed says both',
    history: () => [
      wrote(),
      verified({ checks: [result({ outcome: 'failed', sentence: 'menu.md is missing prices.' })] }),
      entry({ kind: 'edited', actor: 'you', files: [{ before: A1, after: A2 }] }),
    ],
    state: 'uncertain',
    rule: 'outputs-changed',
    sentence: /It had failed on the earlier bytes/,
  },
  {
    name: 'changing the declared checks after verification is uncertain',
    acceptance: declaration([{ id: 'has-menu', kind: 'text-contains', path: 'menu.md', text: 'Soup' }]),
    history: () => [wrote(), verified()],
    state: 'uncertain',
    rule: 'checks-changed',
    sentence: /declared checks changed/,
  },
  {
    name: 'a failed check is failed verification with its evidence',
    history: () => [
      wrote(),
      verified({ checks: [result({ outcome: 'failed', sentence: 'menu.md does not contain “Soup”.' })] }),
    ],
    state: 'failed',
    rule: 'check-failed',
    sentence: /1 check failed: menu\.md does not contain “Soup”/,
  },
  {
    name: 'a check that could not complete is uncertain',
    history: () => [
      wrote(),
      verified({ checks: [result({ outcome: 'incomplete', sentence: 'The reviewer did not answer within 1 seconds.' })] }),
    ],
    state: 'uncertain',
    rule: 'check-incomplete',
    sentence: /could not complete: The reviewer did not answer/,
  },
  {
    name: 'a review by the same model as the worker is not independent',
    acceptance: reviewDecl,
    history: () => [
      wrote(),
      verified({ declarationDigest: reviewDecl.digest, declaredChecks: 2, checks: [result(), reviewer('gpt-6-astra')] }),
    ],
    state: 'uncertain',
    rule: 'review-not-independent',
    sentence: /same engine and model as the worker/,
  },
  {
    name: 'a review whose model was not reported is not independent',
    acceptance: reviewDecl,
    history: () => [
      wrote(),
      verified({ declarationDigest: reviewDecl.digest, declaredChecks: 2, checks: [result(), reviewer(null)] }),
    ],
    state: 'uncertain',
    rule: 'review-not-independent',
    sentence: /cannot be shown to be independent/,
  },
  {
    name: 'every declared check passed against the exact bytes',
    history: () => [wrote(), verified()],
    state: 'verified',
    rule: 'all-passed',
    sentence: /1 declared check passed against 1 exact file version/,
  },
  {
    name: 'an independent reviewer pass counts',
    acceptance: reviewDecl,
    history: () => [
      wrote(),
      verified({ declarationDigest: reviewDecl.digest, declaredChecks: 2, checks: [result(), reviewer('gpt-5.5')] }),
    ],
    state: 'verified',
    rule: 'all-passed',
    sentence: /2 declared checks passed/,
  },
  {
    name: 'a record that ran no declared check verified nothing',
    history: () => [wrote(), verified({ declaredChecks: 0, checks: [record().checks[0]] })],
    state: 'not-verified',
    rule: 'no-checks-declared',
    sentence: /ran no declared check/,
  },
  {
    name: 'a record missing a declared check’s result is not Verified on the others',
    history: () => [wrote(), verified({ checks: [record().checks[0]] })],
    state: 'uncertain',
    rule: 'check-incomplete',
    sentence: /has-menu/,
  },
  {
    name: 'a re-read of the same bytes (observed entry) does not disturb it',
    history: () => [wrote(), verified(), entry({ kind: 'observed', files: [{ before: A1, after: A1 }] })],
    state: 'verified',
    rule: 'all-passed',
    sentence: /passed/,
  },
];

describe('H17 four-state projection, rule by rule', () => {
  test.each(ROWS)('$name → $state ($rule)', (row) => {
    const view = verificationOf({
      session: row.session ?? done,
      task: { acceptance: row.acceptance === undefined ? declaration() : (row.acceptance ?? undefined) },
      history: row.history(),
    });
    expect(view.state).toBe(row.state);
    expect(view.rule).toBe(row.rule);
    expect(view.label).toBe(VERIFICATION_LABEL[row.state]);
    expect(view.sentence).toMatch(row.sentence);
  });

  test('the newest verification of a run decides, and a verification of another run never does', () => {
    const history = [
      wrote(),
      verified({ checks: [result({ outcome: 'failed', sentence: 'first attempt failed' })] }),
      verified(),
      entry({ kind: 'verified', sessionId: 'S2', verification: record({ sessionId: 'S2', checks: [result({ outcome: 'failed' })] }) }),
    ];
    const view = verificationOf({ session: done, task: { acceptance: declaration() }, history });
    expect(view.state).toBe('verified');
    expect(view.entryId).toBe(history[2].id);
  });

  test('changed files name the verified and the current digest', () => {
    const view = verificationOf({
      session: done,
      task: { acceptance: declaration() },
      history: [wrote(), verified(), entry({ kind: 'outside', files: [{ before: A1, after: A2 }] })],
    });
    expect(view.changed).toEqual([{ path: 'menu.md', verified: A1, current: A2 }]);
  });

  test('runOutputs keeps the last digest per path and ignores verification entries', () => {
    const history = [
      entry({ sessionId: 'S1', files: [{ path: 'b.md', after: A1 }, { path: 'a.md', after: A1 }] }),
      entry({ sessionId: 'S1', files: [{ path: 'b.md', before: A1, after: A2 }] }),
      verified(),
      entry({ sessionId: 'S9', files: [{ path: 'c.md', after: A1 }] }),
    ];
    expect(runOutputs(history, 'S1')).toEqual([
      { path: 'a.md', sha: A1 },
      { path: 'b.md', sha: A2 },
    ]);
  });
});

describe('H17 attribution and independence (decision 8)', () => {
  test('deterministic checks are Diomedes application actions, never a model', () => {
    const check = result();
    expect(check.origin.mode).toBe('application');
    expect(check.origin.executorId).toBe('diomedes:verifier');
    expect(independenceOf(check, worker)).toBe('deterministic');
  });
  test('a review is judged only by runtime-reported identities', () => {
    expect(independenceOf(reviewer('gpt-6-astra'), worker)).toBe('same-model');
    expect(independenceOf(reviewer('gpt-5.5'), worker)).toBe('independent');
    expect(independenceOf(reviewer(null), worker)).toBe('unknown');
    expect(independenceOf(reviewer('gpt-5.5'), null)).toBe('unknown');
    expect(independenceOf(reviewer('gpt-5.5'), directOrigin({ engine: 'codex', requestedModel: 'gpt-5.5' }))).toBe(
      'unknown',
    );
    expect(independenceOf(reviewer('gpt-5.5'), applicationOrigin())).toBe('independent');
  });
  test('a view carries each check with its independence', () => {
    const view = verificationOf({
      session: done,
      task: { acceptance: reviewDecl },
      history: [
        wrote(),
        verified({ declarationDigest: reviewDecl.digest, declaredChecks: 2, checks: [result(), reviewer('gpt-5.5')] }),
      ],
    });
    expect(view.checks.map((check) => check.independence)).toEqual(['deterministic', 'independent']);
  });
});
