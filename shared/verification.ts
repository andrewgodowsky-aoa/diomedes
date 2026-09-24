/**
 * H17: independent verification, four-state results and evidence-bound completion.
 *
 * A run's result is one of four states, and the state is never stored. It is
 * projected on every read from three authoritative records: the task's declared
 * acceptance checks, the History entry that carries a verification's evidence,
 * and the History digests of every file that evidence names. Nothing here keeps
 * a lifecycle of its own, so a file that changes after it was verified turns the
 * result uncertain the moment History knows about the new bytes, and a restart
 * reads back exactly the same answer.
 *
 * The rules are ordered; the first that matches decides. They are tabled in
 * docs/implementation/2026-09-24-h17-verified-completion.md and tested row by
 * row in tests/verification-projection.test.ts.
 *
 * Pure: no clock, no disk, no request. Client and server share it.
 */
import { z } from 'zod';
import type { OriginSnapshot } from './attribution.js';
import type { HistoryEntry, Session, Task } from './types.js';

export const VERIFICATION_PROTOCOL_VERSION = 1 as const;
/** A declaration names at most this many checks; a record binds at most this many files. */
export const VERIFICATION_MAX_CHECKS = 16;
export const VERIFICATION_MAX_BOUND_FILES = 64;

const checkId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'A check id is lowercase letters, digits and dashes.');
const filePath = z.string().trim().min(1).max(400);

/**
 * What a person declares a finished run must satisfy. File checks read the
 * project's own recorded bytes and nothing else. A `command` check is declared
 * so the result can say plainly that it did not run: running project code is a
 * Trust decision this build does not have (server/change-review/checks.ts), so
 * it is reported as not run and the result is never Verified on its strength.
 * A `review` check asks the separate reviewer route and is attributed to it.
 */
export const acceptanceCheckSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: checkId, kind: z.literal('file-exists'), path: filePath }),
  z.strictObject({
    id: checkId,
    kind: z.literal('file-digest'),
    path: filePath,
    sha: z.string().regex(/^[a-f0-9]{64}$/, 'A digest is 64 lowercase hex characters (sha256).'),
  }),
  z.strictObject({
    id: checkId,
    kind: z.literal('text-contains'),
    path: filePath,
    text: z.string().min(1).max(500),
  }),
  z.strictObject({
    id: checkId,
    kind: z.literal('json-valid'),
    path: filePath,
    requiredKeys: z.array(z.string().min(1).max(100)).max(32).default([]),
  }),
  z.strictObject({ id: checkId, kind: z.literal('command'), command: z.string().trim().min(1).max(500) }),
  z.strictObject({
    id: checkId,
    kind: z.literal('review'),
    instruction: z.string().trim().min(1).max(1000),
  }),
]);
export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>;
export type AcceptanceCheckKind = AcceptanceCheck['kind'];

export const acceptanceDeclarationInputSchema = z.strictObject({
  checks: z
    .array(acceptanceCheckSchema)
    .max(VERIFICATION_MAX_CHECKS)
    .refine((checks) => new Set(checks.map((check) => check.id)).size === checks.length, 'Check ids must be unique.'),
});

/** Kept on the task. Replaced whole when the person changes it; each change is also a History entry. */
export interface AcceptanceDeclaration {
  readonly protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
  readonly checks: readonly AcceptanceCheck[];
  /** sha256 of the canonical check list. A verification records the digest it ran against. */
  readonly digest: string;
  readonly declaredAt: string;
  readonly declaredBy: 'you';
}

/** One file and the exact bytes (sha256 of its text, as History records them) a check judged. */
export interface BoundFile {
  readonly path: string;
  /** null: the file did not exist when it was judged. */
  readonly sha: string | null;
}

export type CheckOutcome = 'passed' | 'failed' | 'incomplete';

export interface ReviewVerdict {
  readonly verdict: 'pass' | 'fail' | 'unsure';
  readonly note: string;
}

export interface VerificationCheckResult {
  /** The declared check's id, or `outputs-intact` for the check every verification runs. */
  readonly id: string;
  readonly kind: AcceptanceCheckKind | 'outputs-intact';
  readonly label: string;
  readonly outcome: CheckOutcome;
  /** What was found, in plain words. For a failure, the failing evidence; for incomplete, why. */
  readonly sentence: string;
  readonly evidence: readonly BoundFile[];
  readonly ranAt: string;
  readonly durationMs: number;
  /** Who checked. Deterministic checks are Diomedes application actions; a review is the reviewer's runtime. */
  readonly origin: OriginSnapshot;
  readonly review?: ReviewVerdict;
}

/** The evidence of one verification, carried on its History entry. Never rewritten. */
export interface VerificationRecord {
  readonly protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  /** The declaration this ran against. */
  readonly declarationDigest: string;
  readonly declaredChecks: number;
  /** Who asked: the person, or a Diomedes work loop's finish gate (H13) running the person's checks. */
  readonly requestedBy: 'you' | 'diomedes-loop';
  readonly startedAt: string;
  readonly endedAt: string;
  /** Who produced the output, copied from the run when it was verified. */
  readonly producer: OriginSnapshot | null;
  /** The run's own outputs, with the digests the run recorded. */
  readonly outputs: readonly BoundFile[];
  /** Every file any check judged, with the exact digest it judged. Includes the outputs. */
  readonly bound: readonly BoundFile[];
  readonly checks: readonly VerificationCheckResult[];
}

export type VerificationState = 'verified' | 'not-verified' | 'failed' | 'uncertain';

export const VERIFICATION_LABEL: Readonly<Record<VerificationState, string>> = Object.freeze({
  verified: 'Verified',
  'not-verified': 'Not verified',
  failed: 'Failed verification',
  uncertain: 'Verification uncertain',
});

/** The rule that decided, in table order. Tests and the record cite these ids. */
export type VerificationRule =
  | 'run-not-finished'
  | 'no-checks-declared'
  | 'checks-not-run'
  | 'outputs-changed'
  | 'checks-changed'
  | 'check-failed'
  | 'check-incomplete'
  | 'review-not-independent'
  | 'all-passed';

/**
 * Whether a check's actor is independent of the worker that produced the output.
 * `deterministic`: Diomedes code compared bytes; no model graded anything.
 * `independent`: a reviewer whose runtime-reported identity differs from the worker's.
 * `same-model`: the reviewer reported the same engine and model as the worker.
 * `unknown`: one side's model was not reported, so independence cannot be shown.
 */
export type CheckIndependence = 'deterministic' | 'independent' | 'same-model' | 'unknown';

export interface VerificationCheckView extends VerificationCheckResult {
  readonly independence: CheckIndependence;
}

export interface ChangedFile {
  readonly path: string;
  readonly verified: string | null;
  readonly current: string | null;
}

export interface VerificationView {
  readonly sessionId: string;
  readonly state: VerificationState;
  readonly label: string;
  readonly rule: VerificationRule;
  /** One sentence, the rule's own words. */
  readonly sentence: string;
  readonly declared: number;
  readonly record: VerificationRecord | null;
  /** The History entry that carries the record. */
  readonly entryId: string | null;
  readonly checks: readonly VerificationCheckView[];
  readonly changed: readonly ChangedFile[];
}

/** The record's canonical check list digest input. Key order is fixed by construction. */
export function canonicalChecks(checks: readonly AcceptanceCheck[]): string {
  return JSON.stringify(
    checks.map((check) => {
      switch (check.kind) {
        case 'file-exists':
          return [check.id, check.kind, check.path];
        case 'file-digest':
          return [check.id, check.kind, check.path, check.sha];
        case 'text-contains':
          return [check.id, check.kind, check.path, check.text];
        case 'json-valid':
          return [check.id, check.kind, check.path, [...check.requiredKeys]];
        case 'command':
          return [check.id, check.kind, check.command];
        case 'review':
          return [check.id, check.kind, check.instruction];
      }
    }),
  );
}

export function checkLabel(check: AcceptanceCheck): string {
  switch (check.kind) {
    case 'file-exists':
      return `${check.path} exists`;
    case 'file-digest':
      return `${check.path} matches ${check.sha.slice(0, 12)}`;
    case 'text-contains':
      return `${check.path} contains “${check.text.length > 40 ? `${check.text.slice(0, 40)}…` : check.text}”`;
    case 'json-valid':
      return check.requiredKeys.length
        ? `${check.path} is JSON with ${check.requiredKeys.join(', ')}`
        : `${check.path} is valid JSON`;
    case 'command':
      return `Command: ${check.command}`;
    case 'review':
      return 'Reviewer pass';
  }
}

const FINISHED: ReadonlySet<Session['state']> = new Set(['done', 'failed', 'stopped']);

/** The newest digest History holds for a path, or null when History never saw it or saw it deleted. */
export function latestDigest(history: readonly HistoryEntry[], path: string): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const file = history[i].files.find((item) => item.path === path);
    if (file) return file.after;
  }
  return null;
}

/**
 * What a run wrote, by path, with the digest of its last write: the files of
 * every History entry the run's session is named on. A run that wrote nothing
 * has no outputs; its checks can still bind the files they judged.
 */
export function runOutputs(history: readonly HistoryEntry[], sessionId: string): BoundFile[] {
  const outputs = new Map<string, string | null>();
  for (const entry of history) {
    if (entry.sessionId !== sessionId || entry.verification) continue;
    for (const file of entry.files) if (file.recorded) outputs.set(file.path, file.after);
  }
  return [...outputs].map(([path, sha]) => ({ path, sha })).sort((a, b) => a.path.localeCompare(b.path));
}

/** The newest History entry carrying a verification of this run. */
export function latestVerification(
  history: readonly HistoryEntry[],
  sessionId: string,
): { entry: HistoryEntry; record: VerificationRecord } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i].verification;
    if (record && record.sessionId === sessionId) return { entry: history[i], record };
  }
  return null;
}

/**
 * Independence of one check's actor from the worker. Only runtime-reported
 * identities count; a requested model or a display name proves nothing.
 */
export function independenceOf(check: VerificationCheckResult, producer: OriginSnapshot | null): CheckIndependence {
  if (check.kind !== 'review') return 'deterministic';
  const reviewer = check.origin;
  const reviewerModel = reviewer.model.source === 'runtime' ? reviewer.model.reported : null;
  if (!reviewerModel || !reviewer.engine) return 'unknown';
  if (!producer) return 'unknown';
  if (producer.mode === 'application') return 'independent';
  const producerModel = producer.model.source === 'runtime' ? producer.model.reported : null;
  if (!producerModel || !producer.engine) return 'unknown';
  return producer.engine.id === reviewer.engine.id && producerModel === reviewerModel ? 'same-model' : 'independent';
}

export interface VerificationInput {
  readonly session: Pick<Session, 'id' | 'state'>;
  readonly task: Pick<Task, 'acceptance'> | null;
  readonly history: readonly HistoryEntry[];
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The four-state result of one run, from its records alone. */
export function verificationOf(input: VerificationInput): VerificationView {
  const { session, history } = input;
  const declaration = input.task?.acceptance ?? null;
  const declared = declaration?.checks.length ?? 0;
  const found = latestVerification(history, session.id);
  const record = found?.record ?? null;
  const checks: VerificationCheckView[] = (record?.checks ?? []).map((check) => ({
    ...check,
    independence: independenceOf(check, record?.producer ?? null),
  }));
  const view = (
    state: VerificationState,
    rule: VerificationRule,
    sentence: string,
    changed: ChangedFile[] = [],
  ): VerificationView => ({
    sessionId: session.id,
    state,
    label: VERIFICATION_LABEL[state],
    rule,
    sentence,
    declared,
    record,
    entryId: found?.entry.id ?? null,
    checks,
    changed,
  });

  if (!FINISHED.has(session.state))
    return view('not-verified', 'run-not-finished', 'The run has not finished, so there is nothing to verify yet.');
  if (!record) {
    if (declared === 0)
      return view('not-verified', 'no-checks-declared', 'No acceptance checks are declared for this task, so nothing was verified.');
    return view('not-verified', 'checks-not-run', `${plural(declared, 'acceptance check')} declared; not run on this run yet.`);
  }
  if (record.declaredChecks === 0)
    return view('not-verified', 'no-checks-declared', 'The verification on record ran no declared check.');

  // Evidence binds exact bytes: any bound file whose newest History digest
  // differs, or any run output the record did not bind, makes the result stale.
  const changed: ChangedFile[] = [];
  for (const file of record.bound) {
    const current = latestDigest(history, file.path);
    if (current !== file.sha) changed.push({ path: file.path, verified: file.sha, current });
  }
  const recorded = new Map(record.outputs.map((file) => [file.path, file.sha]));
  for (const output of runOutputs(history, session.id))
    if (!recorded.has(output.path) || recorded.get(output.path) !== output.sha)
      if (!changed.some((file) => file.path === output.path))
        changed.push({ path: output.path, verified: recorded.get(output.path) ?? null, current: output.sha });
  const failed = checks.filter((check) => check.outcome === 'failed');
  if (changed.length) {
    const names = changed.slice(0, 3).map((file) => file.path).join(', ');
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : '';
    const earlier = failed.length ? ' It had failed on the earlier bytes.' : '';
    return view(
      'uncertain',
      'outputs-changed',
      `${names}${more} changed after verification, so the result no longer describes these bytes.${earlier}`,
      changed,
    );
  }
  if (!declaration || declaration.digest !== record.declarationDigest)
    return view('uncertain', 'checks-changed', 'The declared checks changed after this verification ran.');
  if (failed.length)
    return view(
      'failed',
      'check-failed',
      `${plural(failed.length, 'check')} failed: ${failed[0].sentence}`,
    );
  const incomplete = checks.filter((check) => check.outcome === 'incomplete');
  if (incomplete.length)
    return view(
      'uncertain',
      'check-incomplete',
      `${plural(incomplete.length, 'check')} could not complete: ${incomplete[0].sentence}`,
    );
  const graded = checks.find((check) => check.kind === 'review' && check.independence !== 'independent');
  if (graded)
    return view(
      'uncertain',
      'review-not-independent',
      graded.independence === 'same-model'
        ? 'The reviewer reported the same engine and model as the worker, so its pass is not independent.'
        : 'The reviewer or the worker did not report its model, so the review cannot be shown to be independent.',
    );
  return view(
    'verified',
    'all-passed',
    `${plural(record.declaredChecks, 'declared check')} passed against ${plural(record.bound.length, 'exact file version')}.`,
  );
}
