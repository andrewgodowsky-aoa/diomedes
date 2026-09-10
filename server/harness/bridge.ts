import type { HarnessPrincipal, HarnessRun } from '../../shared/harness.js';
import type { Need, Session } from '../../shared/types.js';
import { assertApprovalMatches, type ApprovalAdmission } from '../approval-admission.js';
import { ApiError } from '../paths.js';
import { identifier, now, Store } from '../store.js';
import { FIXTURE_ENGINE, harnessWrites, identifyHarnessApproval } from './approval.js';
import { FORMAT_REPORT } from './capabilities/format-report.js';
import { NativeAgent, type ModelAdapter } from './native-agent.js';
import { digest, HarnessError, validatePrincipal } from './policy.js';
import { needFromWaitingStep, presentRun } from './present.js';
import { RunService, Suspended, type HarnessHook } from './run-service.js';
import type { ToolRegistry } from './tools.js';
import { CODEX_ENGINE, CODEX_REPORT, HarnessAuthorityUnavailable, type CodexEngineAdapter, type CodexRunInput } from './codex-engine.js';
import type { WorkAdmission } from '../work-admission.js';

export const localHarnessPrincipal = (projectId: string): HarnessPrincipal => ({
  id: 'local-client',
  tenantId: 'local',
  projectId,
  capabilities: ['write-project-file'],
  identityGeneration: 1,
});

const active = (session: Session) => ['queued', 'working', 'waiting'].includes(session.state);

export class HarnessBridge {
  private readonly owner = identifier('harness-');
  private readonly mirrors = new Set<Promise<void>>();
  private readonly jobs = new Map<string, Promise<void>>();
  private closed = false;
  private mirrorError: unknown;

  constructor(
    private readonly store: Store,
    private readonly runs: RunService,
    private readonly tools: ToolRegistry,
    private readonly adapter: ModelAdapter,
    private readonly redact: (text: string) => string,
    private readonly codex?: CodexEngineAdapter,
  ) {}

  /** Notifications enqueue onto the existing Store lock, never await it inside a run commit. */
  enqueue(run: HarnessRun) {
    if (run.sessionId) this.sessionRuns.set(run.sessionId, run.id);
    const job = this.store.locked(() => this.mirror(run));
    this.mirrors.add(job);
    void job.then(
      () => this.mirrors.delete(job),
      (error: unknown) => {
        this.mirrors.delete(job);
        this.mirrorError = error;
        console.error('Could not mirror a harness run:', this.redact(String(error)));
      },
    );
  }
  async flush() {
    while (this.mirrors.size) await Promise.all([...this.mirrors]);
    if (this.mirrorError) throw this.mirrorError;
  }
  async beforeStep({ runId, step }: Parameters<HarnessHook>[0]) {
    const run = await this.runs.get(runId);
    if (run.steps.some((item) => item.intent.stepId === step.stepId && item.state === 'succeeded'))
      return;
    await this.store.locked(async () => {
      const state = this.store.state(run.projectId);
      const session = state.sessions.find((item) => item.id === run.sessionId);
      if (!session || !active(session)) return;
      session.log.push({
        time: now(),
        level: 'technical',
        sentence: this.redact(`Before step ${step.stepId}: ${step.name ?? step.kind}.`),
      });
      await this.store.persist(state);
    });
  }

  /** Caller owns Store.locked, matching NativeWorkService.start/resolve/stop. */
  async start(
    projectId: string,
    taskId: string | null,
    capabilityId: string,
    prompt: string,
    principal: HarnessPrincipal,
    codex?: { runId: string; input: CodexRunInput; admission: WorkAdmission },
  ): Promise<Session> {
    if (this.closed) throw new ApiError(503, 'The local service is closing.');
    const capability = codex && this.codex && capabilityId === CODEX_REPORT.id ? CODEX_REPORT : FORMAT_REPORT;
    if (capabilityId !== capability.id)
      throw new ApiError(400, 'This native capability is not available.');
    validatePrincipal(principal);
    if (
      principal.tenantId !== 'local' ||
      principal.projectId !== projectId ||
      !principal.capabilities.includes('write-project-file')
    )
      throw new ApiError(403, 'This person cannot start that capability in this project.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000)
      throw new ApiError(400, 'Provide a work instruction of no more than 16,000 characters.');
    const state = this.store.state(projectId);
    if (state.sessions.some(active))
      throw new ApiError(409, 'This project already has work in progress.');
    await this.store.checkFolder(state);
    if (state.project.missing) throw new ApiError(409, 'The project folder is missing.');
    const task =
      taskId === null
        ? this.store.createTask(state, {
            name: FORMAT_REPORT.label,
            description: prompt,
            owner: 'diomedes-with-ok',
          })
        : state.tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) throw new ApiError(404, 'This task was not found.');
    const thread = state.conversations.find((item) => item.taskId === task.id);
    const session: Session = {
      id: identifier('S'),
      taskId: task.id,
      sample: false,
      state: 'queued',
      permission: thread?.permission ?? 'show-first',
      startedAt: now(),
      endedAt: null,
      log: [{ time: now(), level: 'plain', sentence: this.redact(`Requested: ${prompt}`) }],
      entryIds: [],
      needId: null,
      engine: {
        name: codex ? CODEX_ENGINE : this.adapter.id,
        model: null,
        worker: 1,
        branch: null,
        context: null,
        events: 0,
        version: codex ? this.codex!.version : this.adapter.version,
        verified: false,
      },
    };
    state.sessions.push(session);
    if (codex) session.log.push({ time: now(), level: 'technical',
      sentence: `Codex adapter guarantees: ${JSON.stringify(this.codex!.capabilities())}` });
    task.sessionIds.push(session.id);
    task.state = 'working';
    task.reason = null;
    task.needId = null;
    // A run may reference only a durable Session. A failed run-file create leaves a
    // visible stopped Session, not an undiscoverable file writer.
    this.store.recordWorkAdmission(projectId, session, codex?.admission);
    await this.store.persist(state);
    let createdRunId: string | undefined;
    try {
      const run = await this.runs.start({
        ...(codex ? { id: codex.runId, input: codex.input } : {}),
        tenantId: 'local',
        projectId,
        taskId: task.id,
        sessionId: session.id,
        principal,
        capability,
        tools: this.tools,
        budget: codex ? { units: 1, modelCalls: 1, toolCalls: 1, wallMs: null }
          : { units: 6, modelCalls: 6, toolCalls: 6, wallMs: null },
      });
      createdRunId = run.id;
      await this.runs.claim(run.id, this.owner, codex ? 5 * 60_000 : 60_000);
      this.launch(run.id, prompt);
    } catch (error) {
      // A durable queued run must not be resurrected by its already queued
      // mirror or by startup recovery after a failed claim.
      if (createdRunId) {
        await this.runs.cancel(createdRunId, 'The native run could not start.', principal);
        await this.mirror(await this.runs.get(createdRunId));
      } else {
        session.state = 'failed';
        session.endedAt = now();
        task.state = 'waiting';
        task.reason = 'went-wrong';
        session.log.push({
          time: now(),
          level: 'plain',
          sentence: 'The native run could not start. No report was written.',
        });
        await this.store.persist(state);
      }
      throw error;
    }
    return structuredClone(session);
  }
  startNativeRun(
    projectId: string,
    taskId: string | null,
    capabilityId: string,
    prompt: string,
    principal: HarnessPrincipal,
  ) {
    return this.store.locked(() => this.start(projectId, taskId, capabilityId, prompt, principal));
  }

  private async mirror(run: HarnessRun) {
    const state = this.store.state(run.projectId);
    const session = state.sessions.find((item) => item.id === run.sessionId);
    const task = state.tasks.find((item) => item.id === run.taskId);
    if (!session || !task) return;
    if (run.lastSeq <= session.engine.events) return;
    const view = presentRun(run);
    const currentTask = task.sessionIds.at(-1) === session.id;
    for (const event of run.events.filter((item) => item.seq > session.engine.events)) {
      session.log.push({ time: event.at, level: 'plain', sentence: this.redact(view.sentence) });
      session.log.push({
        time: event.at,
        level: 'technical',
        sentence: this.redact(JSON.stringify(event)),
      });
    }
    session.engine.events = run.lastSeq;
    if (run.capabilityId === CODEX_REPORT.id && run.transcripts.codex) {
      session.engine.model = run.transcripts.codex.modelId;
      session.engine.verified = true;
    }
    session.state = view.sessionState;
    session.endedAt = ['done', 'failed', 'stopped'].includes(view.sessionState)
      ? run.updatedAt
      : null;
    if (currentTask) {
      task.state = view.taskState;
      task.reason = view.reason;
      task.needId = null;
    }
    session.needId = null;
    if (run.state === 'waiting' && view.waiting) {
      const step = run.steps.find((item) => item.intent.stepId === view.waiting!.stepId)!;
      let need = state.needs.find(
        (item) =>
          item.sessionId === session.id &&
          (item.state === 'open' || item.execution?.state === 'pending') &&
          item.approval?.actionDigest === step.intentHash,
      );
      if (!need) {
        const fields = needFromWaitingStep(run, step);
        need = {
          id: identifier('N'),
          taskId: task.id,
          sessionId: session.id,
          what: fields.what,
          why: fields.why,
          consequence: fields.consequence,
          files: fields.files,
          state: 'open',
          createdAt: now(),
          decidedAt: null,
          decidedFrom: '',
          allowForTask: false,
          preview: [],
          harness: { runId: run.id, intent: structuredClone(step.intent) },
        };
        const sources = run.capabilityId === CODEX_REPORT.id
          ? this.codex!.sources(run) : [];
        need.approval = identifyHarnessApproval(run.projectId, need, sources);
        harnessWrites(run.projectId, need);
        state.needs.push(need);
      }
      session.needId = need.id;
      if (currentTask) task.needId = need.id;
    }
    if (['completed', 'failed', 'cancelled'].includes(run.state))
      for (const need of state.needs.filter(
        (item) => item.sessionId === session.id && item.state === 'open',
      )) {
        need.state = 'expired';
        need.decidedAt = now();
      }
    if (
      ['failed', 'cancelled'].includes(run.state) &&
      !run.steps.some((step) => step.state === 'reconcile_required')
    )
      for (const need of state.needs.filter(
        (item) => item.harness?.runId === run.id && item.execution?.state === 'pending',
      ))
        need.execution = {
          state: 'not-applied',
          eventId: null,
          completedAt: now(),
          reason: 'The run stopped before this write was prepared.',
          conflicts: [],
        };
    await this.store.persist(state);
  }

  private launch(runId: string, prompt: string) {
    if (this.closed) return;
    if (this.jobs.has(runId)) {
      this.resumes.set(runId, prompt);
      return;
    }
    const job = this.drive(runId, prompt);
    this.jobs.set(runId, job);
    void job
      .finally(() => {
        this.jobs.delete(runId);
        const resume = this.resumes.get(runId);
        this.resumes.delete(runId);
        if (resume !== undefined) this.launch(runId, resume);
      })
      .catch((error: unknown) => {
        console.error('The harness run stopped:', this.redact(String(error)));
      });
  }
  private async drive(runId: string, prompt: string) {
    await this.flush();
    const run = await this.runs.get(runId);
    if (['completed', 'failed', 'cancelled', 'reconcile_required'].includes(run.state)) return;
    try {
      if (run.capabilityId === CODEX_REPORT.id && this.codex) {
        await this.codex.run(run, this.owner);
        return;
      }
      await new NativeAgent(this.runs, this.adapter, this.tools).run(
        runId,
        this.owner,
        prompt,
        run.principal,
        { maxTurns: FORMAT_REPORT.maxTurns },
      );
    } catch (error) {
      if (!(error instanceof Suspended)) {
        await this.runs.fail(runId, this.owner, error);
        throw error;
      }
    } finally {
      await this.flush();
    }
  }
  private prompt(run: HarnessRun) {
    const input = run.steps.find((step) => step.intent.stepId === 'model:0')?.intent.input;
    if (
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Array.isArray(input.messages)
    ) {
      const first = input.messages[0];
      if (
        first &&
        typeof first === 'object' &&
        !Array.isArray(first) &&
        typeof first.text === 'string'
      )
        return first.text;
    }
    const session = this.store
      .state(run.projectId)
      .sessions.find((item) => item.id === run.sessionId);
    const line = session?.log[0]?.sentence;
    if (!line?.startsWith('Requested: '))
      throw new ApiError(409, 'The saved run has no instruction to resume.', {
        code: 'missing_run_instruction',
      });
    return line.slice('Requested: '.length);
  }

  async resolve(
    projectId: string,
    needId: string,
    resolution: 'go-ahead' | 'declined',
    allowForTask = false,
    admission?: ApprovalAdmission,
  ) {
    const need = this.store.state(projectId).needs.find((item) => item.id === needId);
    if (!need?.harness) throw new ApiError(404, 'This harness request was not found.');
    if (!admission || allowForTask || resolution !== admission.command.resolution)
      throw new ApiError(409, 'Reload this request and send its exact approval identity.', {
        code: 'exact_approval_required',
      });
    const run = await this.runs.get(need.harness.runId);
    if (run.capabilityId === CODEX_REPORT.id) await this.codex!.authorityForRun(run, 'approval.decide');
    const replay = this.store.approvalCommand(projectId, admission);
    if (replay) return structuredClone(replay);
    if (need.state !== 'open') throw new ApiError(409, 'This request has already been decided.');
    assertApprovalMatches(projectId, need, admission);
    const step = run.steps.find((item) => item.intent.stepId === need.harness!.intent.stepId);
    if (
      run.projectId !== projectId ||
      run.sessionId !== need.sessionId ||
      run.state !== 'waiting' ||
      step?.state !== 'waiting_approval' ||
      step.intentHash !== need.approval!.actionDigest ||
      digest(step.intent) !== digest(need.harness.intent)
    )
      throw new ApiError(409, 'This request no longer matches the waiting run.');
    this.store.recordApprovalDecision(projectId, need, admission);
    await this.store.persist(this.store.state(projectId));
    await this.decide(need, run);
    return structuredClone(need);
  }
  private async decide(need: Need, run: HarnessRun) {
    if (!need.harness || !need.approvalReceipt || !need.approval)
      throw new Error('A durable harness decision is required.');
    const ttlMs = Date.parse(need.approval.expiresAt) - Date.now();
    if (ttlMs <= 0)
      throw new ApiError(409, 'This approval window expired. The run is still waiting.', {
        code: 'approval_expired',
      });
    try {
      await this.runs.decide(
        {
          runId: run.id,
          stepId: need.harness.intent.stepId,
          decision: need.approvalReceipt.decision === 'go-ahead' ? 'approved' : 'denied',
          ttlMs,
          expiresAt: need.approval.expiresAt,
          decidedBy: 'local-client',
        },
        run.capabilityId === CODEX_REPORT.id
          ? (await this.codex!.authorityForRun(run, 'approval.decide')).principal : localHarnessPrincipal(run.projectId),
      );
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'approval_expired')
        throw new ApiError(
          409,
          'This approval window expired. Stop the run and start again for a new approval.',
          { code: 'approval_expired' },
        );
      throw error;
    }
    if (need.approvalReceipt.decision === 'go-ahead') {
      await this.runs.claim(run.id, this.owner, run.capabilityId === CODEX_REPORT.id ? 5 * 60_000 : 60_000);
      this.launch(run.id, this.prompt(run));
    }
  }

  async stop(
    projectId: string,
    sessionId: string,
    reason = 'Stopped by the person.',
    principal = localHarnessPrincipal(projectId),
  ) {
    const run = await this.runForSession(projectId, sessionId);
    if (run.capabilityId === CODEX_REPORT.id) {
      await this.codex!.authorityForRun(run, 'work.cancel');
      this.codex!.revoke(run.id);
    }
    await this.runs.cancel(run.id, this.redact(reason), principal);
    await this.mirror(await this.runs.get(run.id));
    return structuredClone(
      this.store.state(projectId).sessions.find((item) => item.id === sessionId)!,
    );
  }
  async note(projectId: string, sessionId: string, text: string) {
    const session = this.store.state(projectId).sessions.find((item) => item.id === sessionId);
    if (!session || ![FIXTURE_ENGINE, CODEX_ENGINE].includes(session.engine.name))
      throw new ApiError(404, 'This run was not found.');
    session.log.push({
      time: now(),
      level: 'plain',
      sentence: this.redact(
        `Noted for this task: ${text.slice(0, 4000)}. The approved step stays the same.`,
      ),
    });
    await this.store.persist(this.store.state(projectId));
    return structuredClone(session);
  }
  private readonly sessionRuns = new Map<string, string>();
  private readonly resumes = new Map<string, string>();
  private async runForSession(projectId: string, sessionId: string) {
    const id = this.sessionRuns.get(sessionId);
    if (!id) throw new ApiError(404, 'This harness session has no saved run.');
    const run = await this.runs.get(id);
    if (run.projectId !== projectId)
      throw new ApiError(404, 'This run was not found in this project.');
    return run;
  }
  async recover(projectId: string, saved: HarnessRun[]) {
    const known = new Set<string>();
    for (let run of saved) {
      if (run.sessionId) this.sessionRuns.set(run.sessionId, run.id);
      if (
        ![FORMAT_REPORT.id, CODEX_REPORT.id].includes(run.capabilityId) ||
        run.capabilityVersion !== 'v1'
      ) {
        console.warn('Skipped a harness run whose capability is unavailable.');
        continue;
      }
      const state = this.store.state(projectId);
      if (
        !run.sessionId ||
        !state.sessions.some(
          (session) => session.id === run.sessionId && session.taskId === run.taskId,
        ) ||
        !state.tasks.some((task) => task.id === run.taskId)
      ) {
        console.warn('Skipped a harness run whose Session or Task is unavailable.');
        continue;
      }
      if (['queued', 'running', 'waiting'].includes(run.state)) {
        try {
          this.prompt(run);
        } catch (error) {
          if (!(error instanceof ApiError) || error.details?.code !== 'missing_run_instruction')
            throw error;
          console.warn('Skipped a harness run whose saved instruction is unavailable.');
          continue;
        }
      }
      known.add(run.sessionId);
      let current: HarnessPrincipal;
      try {
        current = run.capabilityId === CODEX_REPORT.id
          ? (await this.codex!.authorityForRun(run, 'project.read')).principal : localHarnessPrincipal(projectId);
      } catch (error) {
        if (!(error instanceof HarnessAuthorityUnavailable)) throw error;
        // Do not replay, fail, renew or rewrite the run under stale authority.
        // The host may describe the pause in its existing Session without
        // preventing unrelated projects from opening. The exact Need is kept.
        await this.store.locked(async () => {
          const session = state.sessions.find(s => s.id === run.sessionId)!;
          if (!active(session)) return;
          const sentence = 'This saved run needs current authority before it can continue. No provider request or project write was resumed.';
          const task = state.tasks.find(t => t.id === session.taskId)!;
          const changed = session.state !== 'waiting' || session.log.at(-1)?.sentence !== sentence
            || task.state !== 'waiting' || task.reason !== 'went-wrong';
          session.state = 'waiting';
          if (session.log.at(-1)?.sentence !== sentence)
            session.log.push({ time: now(), level: 'plain', sentence });
          task.state = 'waiting';
          task.reason = 'went-wrong';
          if (changed) await this.store.persist(state);
        });
        continue;
      }
      await this.runs.recover(run.id, current);
      run = await this.runs.get(run.id);
      this.enqueue(run);
      await this.flush();
      if (run.state === 'waiting') {
        const need = this.store
          .state(projectId)
          .needs.find(
            (item) =>
              item.harness?.runId === run.id &&
              item.approvalReceipt &&
              run.steps.some(
                (step) =>
                  step.state === 'waiting_approval' &&
                  step.intentHash === item.approval?.actionDigest,
              ),
          );
        if (need && Date.parse(need.approval!.expiresAt) > Date.now()) {
          try {
            await this.store.locked(() => this.decide(need, run));
          } catch (error) {
            if (!(error instanceof ApiError) || error.details?.code !== 'approval_expired')
              throw error;
            console.warn('The recovered approval expired. Its run remains waiting.');
          }
        }
      } else if (run.state === 'queued') {
        await this.runs.claim(run.id, this.owner, run.capabilityId === CODEX_REPORT.id ? 5 * 60_000 : 60_000);
        this.launch(run.id, this.prompt(run));
      }
    }
    await this.store.locked(async () => {
      const state = this.store.state(projectId);
      let changed = false;
      for (const session of state.sessions.filter(
        (item) => [FIXTURE_ENGINE, CODEX_ENGINE].includes(item.engine.name) && active(item) && !known.has(item.id),
      )) {
        session.state = 'failed';
        session.endedAt = now();
        session.log.push({
          time: now(),
          level: 'plain',
          sentence: 'The saved run could not be read. Check its record before starting again.',
        });
        const task = state.tasks.find((item) => item.id === session.taskId);
        if (task) {
          task.state = 'waiting';
          task.reason = 'went-wrong';
        }
        changed = true;
      }
      if (changed) await this.store.persist(state);
    });
  }
  async close() {
    this.closed = true;
    for (const runId of this.jobs.keys()) {
      const run = await this.runs.get(runId);
      if (run.capabilityId === CODEX_REPORT.id && ['queued', 'running'].includes(run.state))
        await this.runs.cancel(runId, 'The owned host is closing.');
    }
    this.codex?.close();
    await Promise.allSettled([...this.jobs.values()]);
    await this.flush();
  }
}
