/**
 * H15 supervision: reads a run's durable records, detects drift, and answers
 * each finding on its ladder — note, ask the run to correct, pause and ask you.
 *
 * It acts only through paths that already exist and already hold their own
 * guarantees. A correction is an H08 Steer (where the route steers a running
 * turn natively) or an H08 Queue (everywhere else), asked for in Diomedes
 * supervision's name and carrying a message that says so. A pause is an H08
 * Stop. An escalation is an ordinary Need a person answers; continuing is an
 * H08 Resume asked for by the person, with every re-check Resume makes. Nothing
 * here grants, widens, approves or decides for anyone (decisions 7 and 8), and
 * every action is appended to `ProjectState.supervision` and never rewritten
 * (decision 10).
 *
 * The trigger is the store's own `change` announcement, the one the follow-up
 * queue already listens to: a write to a project with a live run queues an
 * evaluation of that run behind the store lock. Evaluation is idempotent — the
 * same evidence is never acted on twice — so it can run as often as records
 * change without repeating itself.
 */
import { z } from 'zod';
import type { HarnessRun } from '../../shared/harness.js';
import type { OriginSnapshot } from '../../shared/attribution.js';
import {
  DRIFT_THRESHOLDS,
  MAX_SUPERVISION_RECORDS,
  SUPERVISION_ACTOR,
  SUPERVISION_MESSAGE_PREFIX,
  supervisionFor,
  type DriftFinding,
  type DriftThresholds,
  type EscalationAnswer,
  type SupervisionRecord,
} from '../../shared/supervision.js';
import type { ControlReceipt, ControlRequester } from '../../shared/work-control.js';
import type { Need, Session } from '../../shared/types.js';
import { workRouteOf, type DurableControls } from '../durable-controls.js';
import { ApiError } from '../paths.js';
import { hash, identifier, now, type Store } from '../store.js';
import { detectDrift } from './detectors.js';
import { nextStep, type LadderStep } from './ladder.js';
import { driftInputFor } from './records.js';

const LIVE: readonly Session['state'][] = ['queued', 'working', 'waiting'];
const isLive = (session: Session) => LIVE.includes(session.state);
const RANK = { critical: 0, warning: 1, info: 2 } as const;

/** Supervision is deterministic application code; no model is implied (decision 8). */
export function supervisionOrigin(): OriginSnapshot {
  return {
    protocolVersion: 1,
    mode: 'application',
    engine: null,
    model: { requested: null, reported: null, source: 'not-recorded' },
    executorId: 'diomedes:supervision',
  };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The exact message a correction carries: who sent it, what was found, what to do. */
export function correctionMessage(finding: DriftFinding): string {
  return `${SUPERVISION_MESSAGE_PREFIX} ${capital(finding.summary)}. ${finding.ask}`;
}

export const escalationAnswerSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .max(100),
  answer: z.enum(['continue', 'redirect', 'stop']),
  text: z.string().trim().min(1).max(16_000).optional(),
});

export interface SupervisionDeps {
  store: Store;
  controls: DurableControls;
  /** The harness run linked to a Work run, when it has one. */
  harnessRun?(projectId: string, session: Session): Promise<HarnessRun | null>;
  thresholds?: DriftThresholds;
}

export interface EscalationAnswerResult {
  need: Need;
  record: SupervisionRecord;
  receipt: ControlReceipt | null;
}

export class SupervisionService {
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly running = new Set<string>();
  private readonly again = new Set<string>();
  private closed = false;
  constructor(private readonly deps: SupervisionDeps) {}
  private get store() {
    return this.deps.store;
  }

  /** A project's supervision records, or one run's. */
  list(projectId: string, sessionId?: string): SupervisionRecord[] {
    const records = this.store.state(projectId).supervision ?? [];
    return structuredClone(sessionId ? supervisionFor(records, sessionId) : records);
  }

  /** The delivered bytes of an instruction file: its History object, else the file if unchanged. */
  private instructionText(projectId: string) {
    return async (path: string, sha: string): Promise<string | null> => {
      try {
        const saved = await this.store.object(projectId, sha);
        if (saved !== null) return saved;
      } catch {
        // Not kept as a History object; read the file and use it only if it is still those bytes.
      }
      try {
        const current = await this.store.current(projectId, path);
        return current !== null && hash(current) === sha ? current : null;
      } catch {
        return null;
      }
    };
  }

  /** The findings on one run's records now. Pure reading; acts on nothing. */
  async findings(projectId: string, sessionId: string): Promise<DriftFinding[]> {
    const state = this.store.state(projectId);
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new ApiError(404, 'This run was not found.');
    const harness = (await this.deps.harnessRun?.(projectId, session).catch(() => null)) ?? null;
    const input = await driftInputFor({
      state,
      session,
      harness,
      instructions: this.instructionText(projectId),
    });
    return detectDrift(input, this.deps.thresholds ?? DRIFT_THRESHOLDS).sort(
      (a, b) => RANK[a.severity] - RANK[b.severity],
    );
  }

  /**
   * Evaluate one run and act on what the ladder says. The caller holds the
   * store lock, as every route does. Returns the records this pass appended.
   */
  async evaluate(projectId: string, sessionId: string): Promise<SupervisionRecord[]> {
    const findings = await this.findings(projectId, sessionId);
    const created: SupervisionRecord[] = [];
    for (const finding of findings) {
      const state = this.store.state(projectId);
      if ((state.supervision ?? []).length >= MAX_SUPERVISION_RECORDS) break;
      const session = state.sessions.find((item) => item.id === sessionId)!;
      const step = nextStep(finding, {
        sessionId,
        taskId: session.taskId,
        lineage: this.lineage(projectId, sessionId),
        live: isLive(session),
        records: state.supervision ?? [],
        needs: state.needs,
      });
      if (!step.rung) continue;
      created.push(await this.act(projectId, session, finding, step));
    }
    return created;
  }

  /** This run and the runs before it that only a supervision correction started. */
  private lineage(projectId: string, sessionId: string): string[] {
    const followUps = this.store.state(projectId).followUps ?? [];
    const chain = [sessionId];
    for (;;) {
      const started = followUps.find(
        (item) =>
          item.queuedBy === 'diomedes-supervision' && item.deliveredSessionId === chain.at(-1),
      );
      if (!started?.queuedDuringSessionId || chain.includes(started.queuedDuringSessionId))
        return chain;
      chain.push(started.queuedDuringSessionId);
    }
  }

  private base(
    session: Session,
    finding: DriftFinding,
    step: Extract<LadderStep, { rung: string }>,
  ): SupervisionRecord {
    return {
      protocolVersion: 1,
      id: identifier('SV'),
      action: step.rung,
      sessionId: session.id,
      taskId: session.taskId,
      code: finding.code,
      issueKey: finding.issueKey,
      severity: finding.severity,
      summary: finding.summary,
      evidence: structuredClone(finding.evidence),
      evidenceDigest: finding.evidenceDigest,
      at: now(),
      actor: SUPERVISION_ACTOR,
      reason: step.reason,
      ...(step.attempt ? { attempt: step.attempt } : {}),
      ...(step.settled ? { settled: step.settled } : {}),
    };
  }

  private async append(projectId: string, record: SupervisionRecord) {
    const state = this.store.state(projectId);
    state.supervision ??= [];
    state.supervision.push(record);
    await this.store.persist(state);
    return structuredClone(record);
  }

  private async control(
    projectId: string,
    body: Record<string, unknown>,
    requestedBy: ControlRequester,
  ): Promise<ControlReceipt | { refused: string }> {
    try {
      return await this.deps.controls.perform(projectId, body, requestedBy);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) return { refused: error.message };
      throw error;
    }
  }

  private async act(
    projectId: string,
    session: Session,
    finding: DriftFinding,
    step: Extract<LadderStep, { rung: string }>,
  ): Promise<SupervisionRecord> {
    const record = this.base(session, finding, step);
    const by: ControlRequester = { actor: 'diomedes', via: 'supervision', recordId: record.id };
    if (step.rung === 'note') return this.append(projectId, record);

    if (step.rung === 'correct') {
      const message = correctionMessage(finding);
      const profile = this.deps.controls.profile(projectId, workRouteOf(session), session);
      const steer = profile.controls.steer.support !== null && session.state === 'working';
      const commandId = `sup.${record.id}`;
      let receipt = await this.control(
        projectId,
        steer
          ? {
              protocolVersion: 1,
              commandId,
              taskId: session.taskId,
              control: 'steer',
              sessionId: session.id,
              text: message,
            }
          : this.queueBody(commandId, session, message),
        by,
      );
      // A steer the route turned away is queued instead, so the correction is still asked for.
      if (steer && 'outcome' in receipt && receipt.outcome === 'refused')
        receipt = await this.control(
          projectId,
          this.queueBody(`${commandId}.q`, session, message),
          by,
        );
      return this.append(projectId, {
        ...record,
        message,
        control:
          'outcome' in receipt
            ? {
                commandId: receipt.commandId,
                control: receipt.control as 'steer' | 'queue',
                outcome: receipt.outcome,
                detail: receipt.detail,
              }
            : {
                commandId,
                control: steer ? 'steer' : 'queue',
                outcome: 'refused',
                detail: receipt.refused,
              },
      });
    }

    // Escalate: pause the run through H08's Stop, then ask the person with an ordinary Need.
    const commandId = `sup.${record.id}`;
    const stop = await this.control(
      projectId,
      {
        protocolVersion: 1,
        commandId,
        taskId: session.taskId,
        control: 'stop',
        scope: 'task',
        sessionId: session.id,
      },
      by,
    );
    const state = this.store.state(projectId);
    const task = state.tasks.find((item) => item.id === session.taskId);
    const fresh = state.sessions.find((item) => item.id === session.id)!;
    const paths = [
      ...new Set(finding.evidence.flatMap((item) => (item.path ? [item.path] : []))),
    ].slice(0, 20);
    const need: Need = {
      id: identifier('N'),
      sessionId: session.id,
      taskId: session.taskId,
      what: `Diomedes paused this run: ${finding.summary}`,
      why: finding.evidence
        .slice(0, 3)
        .map((item) => item.detail)
        .join(' '),
      consequence:
        'Continue resumes it after re-checking its permission, inputs and route. Redirect sends your instruction as its next run. Stop leaves it stopped. No answer grants anything new.',
      files: paths,
      state: 'open',
      createdAt: now(),
      decidedAt: null,
      decidedFrom: 'desktop',
      allowForTask: false,
      origin: supervisionOrigin(),
      supervision: {
        protocolVersion: 1,
        recordId: record.id,
        code: finding.code,
        issueKey: finding.issueKey,
        choices: ['continue', 'redirect', 'stop'],
      },
    };
    const paused = !isLive(fresh);
    if (paused) {
      state.needs.push(need);
      if (task) {
        this.store.moveTask(state, task, 'waiting', 'diomedes');
        task.reason = 'needs-ok';
        task.needId = need.id;
      }
      this.store.addEntry(state, {
        kind: 'supervision',
        sentence: `Diomedes supervision paused ${task?.name ?? 'this task'}: ${finding.summary}.`,
        actor: 'diomedes',
        sessionId: session.id,
        taskId: session.taskId,
        sample: session.sample,
      });
    }
    return this.append(projectId, {
      ...record,
      ...(paused
        ? { needId: need.id }
        : { settled: 'The run could not be paused, so nothing was asked; see the stop receipt.' }),
      control:
        'outcome' in stop
          ? {
              commandId: stop.commandId,
              control: 'stop',
              outcome: stop.outcome,
              detail: stop.detail,
            }
          : { commandId, control: 'stop', outcome: 'refused', detail: stop.refused },
    });
  }

  private queueBody(commandId: string, session: Session, text: string) {
    return {
      protocolVersion: 1,
      commandId,
      taskId: session.taskId,
      control: 'queue',
      text,
      waitsFor: 'turn',
      route: workRouteOf(session),
      model: null,
      agentId: session.inputs?.agentId ?? null,
      sources: [...(session.inputs?.sources ?? [])].slice(0, 8),
    };
  }

  /**
   * A person's answer to an escalation. Continue is an H08 Resume, redirect an
   * H08 Queue of the person's words, stop leaves the run stopped. A continue or
   * redirect the route or revalidation refuses leaves the Need open, with the
   * refusal recorded, so the person can choose again. The caller holds the lock.
   */
  async answer(projectId: string, needId: string, body: unknown): Promise<EscalationAnswerResult> {
    const parsed = escalationAnswerSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(400, 'Choose continue, redirect or stop, with a command id.', {
        code: 'invalid_escalation_answer',
      });
    const request = parsed.data;
    if (request.answer === 'redirect' && !request.text)
      throw new ApiError(400, 'Say where the run should go instead.');
    let state = this.store.state(projectId);
    const need = state.needs.find((item) => item.id === needId);
    if (!need) throw new ApiError(404, 'This request was not found.');
    if (!need.supervision) throw new ApiError(400, 'This request is not a supervision escalation.');
    const replay = (state.supervision ?? []).find(
      (record) => record.action === 'answer' && record.control?.commandId === request.commandId,
    );
    if (replay) {
      if (replay.needId !== needId || replay.answer !== request.answer)
        throw new ApiError(409, 'This command already names a different answer.', {
          code: 'escalation_command_conflict',
        });
      const receipt =
        (state.controlReceipts ?? []).find((item) => item.commandId === request.commandId) ?? null;
      return { need: structuredClone(need), record: structuredClone(replay), receipt };
    }
    if (need.state !== 'open') throw new ApiError(409, 'This request has already been answered.');
    const escalation = (state.supervision ?? []).find(
      (record) => record.id === need.supervision!.recordId,
    );
    const session = state.sessions.find((item) => item.id === need.sessionId);
    if (!escalation || !session) throw new ApiError(409, 'This escalation is missing its run.');

    let receipt: ControlReceipt | null = null;
    let refusal: string | null = null;
    if (request.answer !== 'stop') {
      const outcome = await this.control(
        projectId,
        request.answer === 'continue'
          ? {
              protocolVersion: 1,
              commandId: request.commandId,
              taskId: need.taskId,
              control: 'resume',
              sessionId: session.id,
            }
          : this.queueBody(request.commandId, session, request.text!),
        { actor: 'you', via: 'local-client' },
      );
      if ('outcome' in outcome) {
        receipt = outcome;
        if (outcome.outcome === 'refused') refusal = outcome.detail;
      } else refusal = outcome.refused;
    }

    state = this.store.state(projectId);
    const current = state.needs.find((item) => item.id === needId)!;
    const task = state.tasks.find((item) => item.id === current.taskId);
    const answered: SupervisionRecord = {
      protocolVersion: 1,
      id: identifier('SV'),
      action: 'answer',
      sessionId: session.id,
      taskId: current.taskId,
      code: escalation.code,
      issueKey: escalation.issueKey,
      severity: escalation.severity,
      summary: escalation.summary,
      evidence: [],
      evidenceDigest: escalation.evidenceDigest,
      at: now(),
      actor: { kind: 'you', via: 'local-client' },
      reason: refusal
        ? `Not done: ${refusal} The request stays open.`
        : request.answer === 'continue'
          ? 'You chose to continue; Resume re-checked the run before it started.'
          : request.answer === 'redirect'
            ? 'You redirected the run; your instruction is its next run.'
            : 'You stopped the run.',
      needId,
      answer: request.answer as EscalationAnswer,
      ...(request.text ? { text: request.text } : {}),
      control: receipt
        ? {
            commandId: receipt.commandId,
            control: receipt.control as 'resume' | 'queue',
            outcome: receipt.outcome,
            detail: receipt.detail,
          }
        : request.answer === 'stop'
          ? {
              commandId: request.commandId,
              control: 'stop',
              outcome: 'applied',
              detail: 'The run stays stopped.',
            }
          : {
              commandId: request.commandId,
              control: request.answer === 'continue' ? 'resume' : 'queue',
              outcome: 'refused',
              detail: refusal ?? '',
            },
    };
    if (!refusal) {
      current.state = request.answer === 'stop' ? 'declined' : 'go-ahead';
      current.decidedAt = answered.at;
      current.decidedFrom = 'desktop';
      current.supervision = { ...current.supervision!, answer: request.answer };
      if (task && task.needId === needId) {
        task.needId = null;
        task.reason = null;
        if (task.state === 'waiting') this.store.moveTask(state, task, 'todo', 'diomedes');
      }
      this.store.addEntry(state, {
        kind: 'decision',
        sentence:
          request.answer === 'continue'
            ? `You chose to continue ${task?.name ?? 'the task'} after Diomedes supervision paused it.`
            : request.answer === 'redirect'
              ? `You redirected ${task?.name ?? 'the task'} after Diomedes supervision paused it.`
              : `You stopped ${task?.name ?? 'the task'} after Diomedes supervision paused it.`,
        actor: 'you',
        sessionId: session.id,
        taskId: current.taskId,
        sample: session.sample,
      });
    }
    state.supervision ??= [];
    state.supervision.push(answered);
    await this.store.persist(state);
    return {
      need: structuredClone(current),
      record: structuredClone(answered),
      receipt: receipt ? structuredClone(receipt) : null,
    };
  }

  /** Queue an evaluation of a project's live runs behind the store lock. */
  schedule(projectId: string) {
    if (this.closed) return;
    if (this.running.has(projectId)) {
      this.again.add(projectId);
      return;
    }
    let live: string[];
    try {
      live = this.store
        .state(projectId)
        .sessions.filter(isLive)
        .map((session) => session.id);
    } catch {
      return;
    }
    if (!live.length) return;
    this.running.add(projectId);
    const job = this.store
      .locked(async () => {
        for (const sessionId of live) {
          if (this.closed) return;
          const session = this.store
            .state(projectId)
            .sessions.find((item) => item.id === sessionId);
          if (!session || !isLive(session)) continue;
          // A detector failing is logged, never allowed to roll the store back.
          await this.evaluate(projectId, sessionId).catch((error: unknown) =>
            console.error(
              'Supervision could not evaluate a run:',
              error instanceof Error ? error.message : error,
            ),
          );
        }
      })
      .catch((error) =>
        console.error(
          'Supervision could not evaluate a run:',
          error instanceof Error ? error.message : error,
        ),
      )
      .finally(() => {
        this.jobs.delete(job);
        this.running.delete(projectId);
        if (this.again.delete(projectId)) this.schedule(projectId);
      });
    this.jobs.add(job);
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.jobs]);
  }
}
