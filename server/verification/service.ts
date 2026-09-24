/**
 * H17 verification: runs a task's declared acceptance checks against a
 * finished run's output, separately from the worker that produced it, and
 * records the evidence on a History entry.
 *
 * What it may do is deliberately narrow, and within scopes that already exist:
 * - File checks read project files through `Store.readDocument`, the same
 *   guarded read path the Files pane uses. Reading also records an outside
 *   change in History when the bytes on disk moved, so what a check judged is
 *   always a digest History holds.
 * - A `command` check is never run. Running project code is a Trust decision
 *   this build does not make (server/change-review/checks.ts says the same),
 *   so it is recorded as not run and the result can never be Verified on it.
 * - A `review` check goes to the separate reviewer route only when the host
 *   wired one, the Codex connection is on, and the project allows review
 *   packets to be shared (requireCloudReview). Otherwise it is not run.
 * Nothing here writes a project file, decides a Need, or issues or widens a
 * grant. Its only write is the History entry carrying the evidence.
 *
 * The four-state result is never stored: shared/verification.ts projects it
 * from the task's declaration, this entry and History's digests on every read.
 */
import { randomUUID } from 'node:crypto';
import {
  VERIFICATION_MAX_BOUND_FILES,
  VERIFICATION_PROTOCOL_VERSION,
  acceptanceDeclarationInputSchema,
  canonicalChecks,
  checkLabel,
  runOutputs,
  verificationOf,
  type AcceptanceCheck,
  type AcceptanceDeclaration,
  type BoundFile,
  type VerificationCheckResult,
  type VerificationRecord,
  type VerificationView,
} from '../../shared/verification.js';
import { applicationOrigin, directOrigin, originForSession, type OriginSnapshot } from '../../shared/attribution.js';
import { REVIEWER_MAX_EXCERPT_BYTES, REVIEWER_TIMEOUT_MS } from '../../shared/permissions.js';
import type { Session, Task } from '../../shared/types.js';
import { ApiError } from '../paths.js';
import { requireCloudReview } from '../cloud-sharing.js';
import { hash, now, type Store } from '../store.js';
import {
  VERIFICATION_REVIEWER_INSTRUCTIONS,
  VERIFICATION_REVIEWER_PROMPT,
  parseVerificationVerdict,
  type VerificationPacket,
  type VerificationReviewerAdapter,
} from './reviewer.js';

/** Deterministic checks are Diomedes application actions, never a model's judgement. */
export const verifierOrigin = (): OriginSnapshot => ({
  ...applicationOrigin(),
  executorId: 'diomedes:verifier',
});

export interface VerificationOptions {
  /** How long the reviewer pass may take. Tests shorten it to prove a timeout is uncertain. */
  reviewTimeoutMs?: number;
}

interface Read {
  text: string | null;
  sha: string | null;
  /** Set when the file could not be read at all (outside the project, unreadable). */
  error: string | null;
}

const FINISHED = new Set<Session['state']>(['done', 'failed', 'stopped']);

export class VerificationService {
  private readonly inFlight = new Map<string, Promise<VerificationView>>();
  private readonly reviewTimeoutMs: number;
  constructor(
    private readonly store: Store,
    private readonly reviewer: VerificationReviewerAdapter | null,
    options: VerificationOptions = {},
  ) {
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? REVIEWER_TIMEOUT_MS;
  }

  private task(projectId: string, taskId: string): Task {
    const task = this.store.state(projectId).tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) throw new ApiError(404, 'This task was not found.');
    return task;
  }

  private session(projectId: string, sessionId: string): Session {
    const session = this.store.state(projectId).sessions.find((item) => item.id === sessionId);
    if (!session) throw new ApiError(404, 'This run was not found.');
    return session;
  }

  /** The result of one run, projected from its records. */
  view(projectId: string, sessionId: string): VerificationView {
    const state = this.store.state(projectId);
    const session = this.session(projectId, sessionId);
    const task = state.tasks.find((item) => item.id === session.taskId) ?? null;
    return verificationOf({ session, task, history: state.history });
  }

  /**
   * Replace a task's declared checks. Declaring is not an authorization event:
   * file checks read what the Files pane can already read, a command check is
   * never run, and a review check still needs the project's sharing consent.
   * Call under `store.locked`.
   */
  async declare(projectId: string, taskId: string, input: unknown): Promise<AcceptanceDeclaration> {
    const parsed = acceptanceDeclarationInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'These acceptance checks are not valid.');
    this.task(projectId, taskId);
    const state = this.store.state(projectId);
    const task = state.tasks.find((item) => item.id === taskId)!;
    const checks = parsed.data.checks as AcceptanceCheck[];
    const declaration: AcceptanceDeclaration = {
      protocolVersion: VERIFICATION_PROTOCOL_VERSION,
      checks,
      digest: hash(canonicalChecks(checks))!,
      declaredAt: now(),
      declaredBy: 'you',
    };
    task.acceptance = declaration;
    this.store.addEntry(state, {
      actor: 'you',
      kind: 'acceptance-declared',
      sentence: checks.length
        ? `You declared ${checks.length === 1 ? '1 acceptance check' : `${checks.length} acceptance checks`} for ${task.name}`
        : `You cleared the acceptance checks for ${task.name}`,
      taskId,
    });
    await this.store.persist(state);
    return declaration;
  }

  /**
   * Keep History current for every file a latest verification bound, so a
   * change made outside Diomedes turns the result uncertain on the next read
   * instead of waiting for someone to open the file. Reading is the existing
   * outside-change recorder (`Store.readDocument`); nothing else is written.
   * Call under `store.locked`.
   */
  async sync(projectId: string): Promise<void> {
    const state = this.store.state(projectId);
    if (state.project.missing) return;
    const seen = new Set<string>();
    const paths: string[] = [];
    for (let i = state.history.length - 1; i >= 0 && paths.length < 256; i--) {
      const record = state.history[i].verification;
      if (!record || seen.has(record.sessionId)) continue;
      seen.add(record.sessionId);
      for (const file of record.bound) if (!paths.includes(file.path)) paths.push(file.path);
    }
    for (const path of paths) await this.read(projectId, path);
  }

  private async read(projectId: string, path: string): Promise<Read> {
    try {
      const document = await this.store.readDocument(projectId, path);
      return { text: document.text, sha: document.sha, error: null };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { text: null, sha: null, error: null };
      return { text: null, sha: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Run the declared checks on one finished run. One verification per run at a time. A
   * Diomedes work loop's finish gate (H13) asks for the same checks the person declared; it
   * never declares its own, and the record says who asked.
   */
  verify(
    projectId: string,
    sessionId: string,
    options: { requestedBy?: VerificationRecord['requestedBy'] } = {},
  ): Promise<VerificationView> {
    const key = `${projectId}\0${sessionId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = this.run(projectId, sessionId, options.requestedBy ?? 'you').finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async run(
    projectId: string,
    sessionId: string,
    requestedBy: VerificationRecord['requestedBy'],
  ): Promise<VerificationView> {
    const startedAt = now();
    // 1. Under the store lock: read the exact bytes and run the deterministic checks.
    const prepared = await this.store.locked(async () => {
      const session = this.session(projectId, sessionId);
      if (!FINISHED.has(session.state))
        throw new ApiError(409, 'This run has not finished, so there is nothing to verify yet.', {
          code: 'run_not_finished',
        });
      const task = this.task(projectId, session.taskId);
      const declaration = task.acceptance;
      if (!declaration || declaration.checks.length === 0)
        throw new ApiError(409, 'Declare at least one acceptance check before verifying.', {
          code: 'no_checks_declared',
        });
      const state = this.store.state(projectId);
      const outputs = runOutputs(state.history, session.id);
      const reads = new Map<string, Read>();
      const readOnce = async (path: string) => {
        let found = reads.get(path);
        if (!found) {
          found = await this.read(projectId, path);
          reads.set(path, found);
        }
        return found;
      };
      const results: VerificationCheckResult[] = [];
      results.push(await this.outputsIntact(outputs, readOnce));
      const reviews: Extract<AcceptanceCheck, { kind: 'review' }>[] = [];
      for (const check of declaration.checks) {
        if (check.kind === 'review') reviews.push(check);
        else results.push(await this.deterministic(check, readOnce));
      }
      const current = this.store.state(projectId);
      return {
        session: structuredClone(session),
        task: structuredClone(task),
        declaration,
        outputs,
        reads,
        results,
        reviews,
        projectName: current.project.name,
        cloud: (() => {
          try {
            requireCloudReview(current, outputs.map((file) => file.path));
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        })(),
      };
    });

    // 2. Outside the lock: the reviewer pass, bounded by its own timeout.
    for (const check of prepared.reviews)
      prepared.results.push(await this.review(check, prepared));
    // Keep the declared order for display: outputs-intact first, then as declared.
    const order = new Map(prepared.declaration.checks.map((check, index) => [check.id, index]));
    prepared.results.sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));

    // 3. Under the lock again: record the evidence. If a file moved meanwhile,
    //    the projection reads it as uncertain; the record stays what was judged.
    return this.store.locked(async () => {
      const state = this.store.state(projectId);
      const bound = new Map<string, string | null>();
      for (const result of prepared.results)
        for (const file of result.evidence)
          if (!bound.has(file.path) && bound.size < VERIFICATION_MAX_BOUND_FILES) bound.set(file.path, file.sha);
      const record: VerificationRecord = {
        protocolVersion: VERIFICATION_PROTOCOL_VERSION,
        id: `V${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        sessionId: prepared.session.id,
        taskId: prepared.task.id,
        declarationDigest: prepared.declaration.digest,
        declaredChecks: prepared.declaration.checks.length,
        requestedBy,
        startedAt,
        endedAt: now(),
        producer: originForSession(prepared.session) ?? null,
        outputs: prepared.outputs,
        bound: [...bound].map(([path, sha]) => ({ path, sha })),
        checks: prepared.results,
      };
      const passed = record.checks.filter((check) => check.outcome === 'passed').length;
      const entry = this.store.addEntry(state, {
        origin: verifierOrigin(),
        actor: requestedBy === 'you' ? 'you' : 'diomedes',
        kind: 'verified',
        sentence:
          requestedBy === 'you'
            ? `You verified ${prepared.task.name}: ${passed} of ${record.checks.length} checks passed`
            : `Diomedes ran your checks on ${prepared.task.name} when its loop finished: ${passed} of ${record.checks.length} passed`,
        sessionId: prepared.session.id,
        taskId: prepared.task.id,
      });
      entry.verification = record;
      await this.store.persist(state);
      return this.view(projectId, sessionId);
    });
  }

  /** Every verification first confirms it is judging the bytes the run wrote. */
  private async outputsIntact(
    outputs: readonly BoundFile[],
    read: (path: string) => Promise<Read>,
  ): Promise<VerificationCheckResult> {
    const started = Date.now();
    const evidence: BoundFile[] = [];
    const moved: string[] = [];
    const unreadable: string[] = [];
    for (const output of outputs) {
      const found = await read(output.path);
      if (found.error) unreadable.push(output.path);
      evidence.push({ path: output.path, sha: found.sha });
      if (found.sha !== output.sha) moved.push(output.path);
    }
    const base = {
      id: 'outputs-intact',
      kind: 'outputs-intact' as const,
      label: 'Outputs are the bytes the run wrote',
      evidence,
      ranAt: now(),
      durationMs: Date.now() - started,
      origin: verifierOrigin(),
    };
    if (unreadable.length)
      return { ...base, outcome: 'incomplete', sentence: `${unreadable[0]} could not be read.` };
    if (moved.length)
      return {
        ...base,
        outcome: 'incomplete',
        sentence: `${moved[0]} changed after the run and before verification, so the checks would not be judging the run's output.`,
      };
    return {
      ...base,
      outcome: 'passed',
      sentence: outputs.length
        ? `${outputs.length === 1 ? '1 output is' : `${outputs.length} outputs are`} byte-for-byte what the run recorded.`
        : 'The run recorded no file output.',
    };
  }

  private async deterministic(
    check: Exclude<AcceptanceCheck, { kind: 'review' }>,
    read: (path: string) => Promise<Read>,
  ): Promise<VerificationCheckResult> {
    const started = Date.now();
    const base = { id: check.id, kind: check.kind, label: checkLabel(check), origin: verifierOrigin() };
    const done = (
      outcome: VerificationCheckResult['outcome'],
      sentence: string,
      evidence: BoundFile[],
    ): VerificationCheckResult => ({ ...base, outcome, sentence, evidence, ranAt: now(), durationMs: Date.now() - started });
    if (check.kind === 'command')
      return done(
        'incomplete',
        'Not run: running project commands is a Trust decision this build does not make, so this check cannot pass here.',
        [],
      );
    const found = await read(check.path);
    const evidence = [{ path: check.path, sha: found.sha }];
    if (found.error) return done('incomplete', `${check.path} could not be read: ${found.error}`, []);
    const short = (sha: string | null) => (sha ? sha.slice(0, 12) : 'none');
    if (found.text === null) return done('failed', `${check.path} does not exist.`, evidence);
    switch (check.kind) {
      case 'file-exists':
        return done('passed', `${check.path} exists (${short(found.sha)}).`, evidence);
      case 'file-digest':
        return found.sha === check.sha
          ? done('passed', `${check.path} is exactly ${short(check.sha)}.`, evidence)
          : done('failed', `${check.path} is ${short(found.sha)}, not the declared ${short(check.sha)}.`, evidence);
      case 'text-contains':
        return found.text.includes(check.text)
          ? done('passed', `${check.path} contains the declared text.`, evidence)
          : done('failed', `${check.path} does not contain “${check.text.slice(0, 80)}”.`, evidence);
      case 'json-valid': {
        let value: unknown;
        try {
          value = JSON.parse(found.text);
        } catch (error) {
          return done('failed', `${check.path} is not valid JSON: ${(error as Error).message.slice(0, 160)}`, evidence);
        }
        const missing =
          value && typeof value === 'object' && !Array.isArray(value)
            ? check.requiredKeys.filter((key) => !Object.hasOwn(value as object, key))
            : check.requiredKeys;
        return missing.length
          ? done('failed', `${check.path} is missing ${missing.join(', ')}.`, evidence)
          : done('passed', `${check.path} is valid JSON${check.requiredKeys.length ? ' with every required key' : ''}.`, evidence);
      }
    }
  }

  private async review(
    check: Extract<AcceptanceCheck, { kind: 'review' }>,
    prepared: {
      session: Session;
      task: Task;
      outputs: BoundFile[];
      reads: Map<string, Read>;
      results: VerificationCheckResult[];
      projectName: string;
      cloud: string | null;
    },
  ): Promise<VerificationCheckResult> {
    const started = Date.now();
    const evidence = prepared.outputs.map((output) => ({
      path: output.path,
      sha: prepared.reads.get(output.path)?.sha ?? null,
    }));
    const notRun = (sentence: string): VerificationCheckResult => ({
      id: check.id,
      kind: 'review',
      label: checkLabel(check),
      outcome: 'incomplete',
      sentence,
      evidence,
      ranAt: now(),
      durationMs: Date.now() - started,
      origin: verifierOrigin(),
    });
    if (!this.reviewer) return notRun('Not run: no separate reviewer route is connected on this installation.');
    if (this.store.settings.services?.codex !== true)
      return notRun('Not run: turn on the Codex connection before a reviewer can be used.');
    if (prepared.cloud) return notRun(`Not run: ${prepared.cloud}`);
    if (!prepared.outputs.length) return notRun('Not run: the run recorded no output to review.');

    let budget = REVIEWER_MAX_EXCERPT_BYTES;
    const outputs = prepared.outputs.map((output) => {
      const text = prepared.reads.get(output.path)?.text ?? null;
      if (text === null) return { path: output.path, sha: null, excerpt: null, truncated: false };
      const excerpt = text.slice(0, Math.max(0, budget));
      budget -= excerpt.length;
      return {
        path: output.path,
        sha: prepared.reads.get(output.path)?.sha ?? null,
        excerpt,
        truncated: excerpt.length < text.length,
      };
    });
    const packet: VerificationPacket = {
      protocolVersion: 1,
      purpose: 'verification',
      projectName: prepared.projectName,
      taskName: prepared.task.name,
      taskDescription: prepared.task.description,
      instruction: check.instruction,
      outputs,
      deterministic: prepared.results.map((result) => ({ label: result.label, outcome: result.outcome })),
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timeout');
    try {
      const answer = await Promise.race([
        this.reviewer({
          invocationId: randomUUID(),
          instructions: VERIFICATION_REVIEWER_INSTRUCTIONS,
          prompt: VERIFICATION_REVIEWER_PROMPT,
          packet,
          signal: controller.signal,
        }),
        new Promise<typeof timedOut>((resolve) => {
          // Settle first: the abort makes a well-behaved adapter reject at once,
          // and that rejection must not outrun the timeout it was caused by.
          timer = setTimeout(() => {
            resolve(timedOut);
            queueMicrotask(() => controller.abort());
          }, this.reviewTimeoutMs);
        }),
      ]);
      const reviewerOrigin =
        answer === timedOut
          ? directOrigin({ engine: 'codex', executorId: 'diomedes:verification-reviewer' })
          : directOrigin({
              engine: 'codex',
              reportedModel: answer.model ?? null,
              version: answer.version ?? null,
              executorId: 'diomedes:verification-reviewer',
            });
      const base = {
        id: check.id,
        kind: 'review' as const,
        label: checkLabel(check),
        evidence,
        ranAt: now(),
        durationMs: Date.now() - started,
        origin: reviewerOrigin,
      };
      if (answer === timedOut)
        return {
          ...base,
          outcome: 'incomplete',
          sentence: `The reviewer did not answer within ${Math.round(this.reviewTimeoutMs / 1000)} seconds.`,
        };
      const verdict = parseVerificationVerdict(answer.text);
      if (!verdict)
        return { ...base, outcome: 'incomplete', sentence: 'The reviewer answered without a readable verdict; prose is never a verdict.' };
      const note = verdict.note || 'No reason given.';
      return {
        ...base,
        review: verdict,
        outcome: verdict.verdict === 'pass' ? 'passed' : verdict.verdict === 'fail' ? 'failed' : 'incomplete',
        sentence:
          verdict.verdict === 'pass'
            ? `The reviewer passed it: ${note}`
            : verdict.verdict === 'fail'
              ? `The reviewer failed it: ${note}`
              : `The reviewer was unsure: ${note}`,
      };
    } catch (error) {
      return {
        ...notRun(`The reviewer could not complete: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`),
        origin: directOrigin({ engine: 'codex', executorId: 'diomedes:verification-reviewer' }),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
