import { randomUUID } from 'node:crypto';
import type {
  CapabilityManifest,
  HarnessRun,
  Json,
  NativeCheckpoint,
} from '../../shared/harness.js';
import type { NativeSessionRef } from '../../shared/contract-revision.js';
import type { TextRequest, TextResponse } from '../engines/contract.js';
import {
  claudeCheckpointSchema,
  type ClaudeNativeSession,
  type ClaudeSessionCheckpoint,
  type ClaudeSessionOptions,
} from '../engines/claude-session.js';
import { EngineError } from '../engines/process.js';
import { localHarnessPrincipal } from './bridge.js';
import { digest, HarnessError } from './policy.js';
import { RunService, Suspended, type StepContext, type StepDefinition } from './run-service.js';

export const CLAUDE_SESSION_CAPABILITY: CapabilityManifest = {
  id: 'claude-native-session',
  version: '1',
  label: 'Claude native conversation',
  description: 'An explicitly admitted native Claude conversation with durable turns and no tools.',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 128,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
};
export function validateClaudeNativeCheckpoint(value: NativeCheckpoint): NativeCheckpoint {
  if (value.providerId !== 'claude-code')
    throw new HarnessError('invalid_checkpoint', 'Unknown native checkpoint provider.');
  const parsed = claudeCheckpointSchema.safeParse(value.payload);
  if (!parsed.success)
    throw new HarnessError('invalid_checkpoint', 'Claude recovery metadata is malformed.');
  return { v: 1, providerId: 'claude-code', payload: parsed.data };
}
export interface ClaudeSessionAdmission {
  location: string;
  version: string;
  model: string;
  accountRoute: string;
}
export type ClaudeConversation = Pick<
  ClaudeNativeSession,
  'turn' | 'interrupt' | 'close' | 'checkpoint' | 'nativeSession'
>;
type Connection = {
  session: ClaudeConversation;
  writer?: StepContext['saveNativeCheckpoint'];
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
  closing?: Promise<void>;
};
export interface ClaudeSessionTurn {
  mode: 'start' | 'follow-up' | 'resume' | 'fork';
  runId: string;
  sourceRunId?: string;
  input: TextRequest;
  admit(signal?: AbortSignal): Promise<ClaudeSessionAdmission>;
  open(
    admission: ClaudeSessionAdmission,
    input: TextRequest,
    options: ClaudeSessionOptions,
  ): Promise<ClaudeConversation>;
  preview?(
    context: StepContext,
    stepId: string,
  ): { onDelta(text: string): void; finish(): Promise<void> };
}
export interface ClaudeSessionTurnResult {
  runId: string;
  response: TextResponse | null;
  interrupted: boolean;
  nativeSession: NativeSessionRef | null;
}
export const claudeSessionRunId = (projectId: string, commandId: string) =>
  `claude-${digest({ projectId, commandId })}`;
const stepKey = (prefix: string, commandId: string) =>
  `${prefix}:${digest(commandId).slice(0, 40)}`;
const scope = (input: TextRequest): Json => ({
  engine: 'claude-code',
  projectId: input.projectId,
  threadId: input.threadId,
  model: input.model,
  accountRoute: input.accountRoute,
  instructions: input.instructions,
});
const terminal = (run: HarnessRun) =>
  ['completed', 'cancelled', 'failed', 'reconcile_required'].includes(run.state);
const waitDefinition = (id: string): StepDefinition => ({
  id,
  version: '1',
  kind: 'wait',
  effect: 'pure',
  input: { reason: 'awaiting-user-input' },
  cost: 0,
  maxAttempts: 2,
  destination: 'local',
});

/** A capability driver over RunService. Only live transport handles are held here. */
export class ClaudeSessionRuns {
  private closed = false;
  private readonly owner = `claude-session-${randomUUID()}`;
  private readonly connections = new Map<string, Connection>();
  private readonly active = new Map<
    string,
    {
      commandId: string;
      intent: string;
      controller: AbortController;
      promise: Promise<ClaudeSessionTurnResult>;
    }
  >();
  private readonly forkLocks = new Set<string>();
  private readonly closing = new Set<Promise<void>>();
  private readonly cleanupFailures: unknown[] = [];
  private readonly lifetimeMs: number;
  constructor(
    private readonly runs: RunService,
    options: { connectionLifetimeMs?: number } = {},
  ) {
    const lifetime = options.connectionLifetimeMs ?? 30 * 60_000;
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 30 * 60_000)
      throw new Error('Native connection lifetime must be positive and at most 30 minutes.');
    this.lifetimeMs = lifetime;
  }
  private dispose(runId: string, connection: Connection, reason?: unknown): Promise<void> {
    if (connection.closing) return connection.closing;
    if (this.connections.get(runId) === connection) this.connections.delete(runId);
    connection.writer = undefined;
    clearTimeout(connection.timer);
    connection.detach?.();
    const closed = connection.session.close(reason);
    connection.closing = closed;
    this.closing.add(closed);
    void closed.then(
      () => this.closing.delete(closed),
      (error) => {
        this.closing.delete(closed);
        this.cleanupFailures.push(error);
      },
    );
    return closed;
  }

  async get(projectId: string, runId: string): Promise<HarnessRun> {
    const run = await this.runs.get(runId);
    if (run.projectId !== projectId || run.capabilityId !== CLAUDE_SESSION_CAPABILITY.id)
      throw new HarnessError(
        'unknown_run',
        'This native conversation was not found in this project.',
      );
    return run;
  }
  private checkpoint(run: HarnessRun): ClaudeSessionCheckpoint | undefined {
    const saved = [...run.steps]
      .reverse()
      .find((step) => step.intent.kind === 'model' && step.nativeCheckpoint)?.nativeCheckpoint;
    return saved
      ? claudeCheckpointSchema.parse(validateClaudeNativeCheckpoint(saved).payload)
      : undefined;
  }
  async status(projectId: string, runId: string) {
    const run = await this.get(projectId, runId);
    const checkpoint = this.checkpoint(run);
    return {
      runId,
      state: run.state,
      connected: this.connections.has(runId),
      requestedModel: checkpoint?.requestedModel ?? null,
      reportedModel: checkpoint?.reportedModel ?? null,
      nativeSession:
        checkpoint?.nativeSessionId && checkpoint.reportedModel
          ? {
              providerId: 'claude-code',
              lineageId: checkpoint.lineageId,
              opaqueRef: checkpoint.nativeSessionId,
            }
          : null,
    };
  }
  request(request: ClaudeSessionTurn): Promise<ClaudeSessionTurnResult> {
    if (this.closed)
      return Promise.reject(
        new EngineError('SESSION_CLOSED', 'The native runtime is shutting down.'),
      );
    const intent = digest({
      scope: scope(request.input),
      prompt: request.input.prompt,
      documents: request.input.documents,
      requestId: request.input.requestId,
      mode: request.mode,
      sourceRunId: request.sourceRunId ?? null,
    });
    const pending = this.active.get(request.runId);
    if (pending) {
      if (pending.commandId === request.input.requestId && pending.intent === intent)
        return pending.promise;
      return Promise.reject(
        new EngineError('SESSION_BUSY', 'This conversation already has a turn in progress.'),
      );
    }
    if (this.forkLocks.has(request.runId))
      return Promise.reject(new EngineError('SESSION_BUSY', 'This conversation is being forked.'));
    if (request.mode === 'fork') {
      if (
        !request.sourceRunId ||
        this.active.has(request.sourceRunId) ||
        this.forkLocks.has(request.sourceRunId)
      )
        return Promise.reject(
          new EngineError('SESSION_BUSY', 'Fork requires an idle source conversation.'),
        );
      this.forkLocks.add(request.sourceRunId);
    }
    const controller = new AbortController();
    const admitted = {
      ...request,
      input: {
        ...request.input,
        signal: AbortSignal.any([
          controller.signal,
          ...(request.input.signal ? [request.input.signal] : []),
        ]),
      },
    };
    const promise = this.drive(admitted).finally(() => {
      controller.abort();
      this.active.delete(request.runId);
      if (request.sourceRunId) this.forkLocks.delete(request.sourceRunId);
    });
    this.active.set(request.runId, {
      commandId: request.input.requestId,
      intent,
      controller,
      promise,
    });
    return promise;
  }
  private async resolveWaits(runId: string, projectId: string) {
    const run = await this.get(projectId, runId);
    for (const step of run.steps.filter((s) => s.state === 'waiting_event'))
      await this.runs.step(
        runId,
        this.owner,
        waitDefinition(step.intent.stepId),
        () => ({ inputReceived: true }),
        localHarnessPrincipal(projectId),
      );
  }
  private async park(runId: string, projectId: string, commandId: string) {
    const run = await this.get(projectId, runId);
    if (
      terminal(run) ||
      run.steps.some((step) => step.state === 'running' || step.state === 'waiting_event')
    )
      return;
    try {
      await this.runs.step(
        runId,
        this.owner,
        waitDefinition(stepKey('input', commandId)),
        () => {
          throw new Suspended('event', 'Waiting for explicit input.');
        },
        localHarnessPrincipal(projectId),
      );
    } catch (error) {
      if (!(error instanceof Suspended && error.reason === 'event')) throw error;
    }
  }
  private async drive(request: ClaudeSessionTurn): Promise<ClaudeSessionTurnResult> {
    const { input, runId } = request;
    const principal = localHarnessPrincipal(input.projectId);
    let run: HarnessRun | undefined;
    try {
      run = await this.get(input.projectId, runId);
    } catch (error) {
      if (!(error instanceof HarnessError && error.code === 'unknown_run')) throw error;
    }
    let restore: ClaudeSessionCheckpoint | undefined;
    if (!run && request.mode === 'start') {
      run = await this.runs.start({
        id: runId,
        projectId: input.projectId,
        tenantId: principal.tenantId,
        principal,
        capability: CLAUDE_SESSION_CAPABILITY,
        input: scope(input),
        budget: { units: 128, modelCalls: 128, toolCalls: 384, wallMs: null },
      });
    } else if (!run && request.mode === 'fork') {
      const parent = await this.get(input.projectId, request.sourceRunId!);
      if (terminal(parent) || digest(parent.input) !== digest(scope(input)))
        throw new EngineError(
          'SESSION_MISMATCH',
          'Fork requires the same idle project, thread, model and instructions.',
        );
      restore = this.checkpoint(parent);
      if (!restore?.nativeSessionId || restore.state !== 'idle' || !parent.steps.length)
        throw new EngineError(
          'RECONCILE_REQUIRED',
          'The source native conversation is not ready to fork.',
          true,
        );
      // Empty pure prefix: no provider observations, permissions or hidden state are copied.
      run = await this.runs.fork(parent.id, runId, parent.steps[0].intent.stepId, principal);
    }
    if (!run)
      throw new HarnessError('unknown_run', 'Resume or follow-up needs an existing conversation.');
    if (request.mode === 'fork' && run.parentRunId !== request.sourceRunId)
      throw new EngineError(
        'SESSION_MISMATCH',
        'This fork command belongs to a different source run.',
      );
    if (terminal(run))
      throw new EngineError(
        'RECONCILE_REQUIRED',
        'This run is settled or requires reconciliation; it cannot accept new work.',
        true,
      );
    if (digest(run.input) !== digest(scope(input)))
      throw new EngineError('SESSION_MISMATCH', 'The native conversation scope changed.');
    await this.runs.claim(runId, this.owner, 35 * 60_000);
    const turnId = stepKey('turn', input.requestId);
    const turnDefinition: StepDefinition = {
      id: turnId,
      version: '1',
      kind: 'model',
      effect: 'read',
      name: 'Claude native turn',
      input: {
        engine: 'claude-code',
        requestId: input.requestId,
        prompt: input.prompt,
        documents: input.documents,
        mode: request.mode,
        sourceRunId: request.sourceRunId ?? null,
      },
      destination: 'external',
      cost: 1,
      maxAttempts: 1,
    };
    const previous = run.steps.find((step) => step.intent.stepId === turnId);
    if (previous?.state === 'succeeded')
      return this.runs.step(
        runId,
        this.owner,
        turnDefinition,
        () => {
          throw new Error('A completed turn must replay.');
        },
        principal,
      );
    if (request.mode === 'fork') {
      const pinned = run.steps.find(
        (step) => step.intent.stepId === 'fork:source',
      )?.nativeCheckpoint;
      if (pinned)
        restore = claudeCheckpointSchema.parse(validateClaudeNativeCheckpoint(pinned).payload);
      if (!restore)
        throw new EngineError(
          'SESSION_INVALID',
          'This fork has no durable source reference. Start a new fork command.',
        );
      const source = await this.get(input.projectId, request.sourceRunId!);
      if (terminal(source) || digest(this.checkpoint(source)) !== digest(restore))
        throw new EngineError(
          'SESSION_MISMATCH',
          'The fork source changed after admission. Start a new fork command.',
        );
      await this.runs.step(
        runId,
        this.owner,
        {
          id: 'fork:source',
          version: '1',
          kind: 'tool',
          effect: 'read',
          destination: 'local',
          cost: 0,
          maxAttempts: 1,
          input: { sourceRunId: request.sourceRunId!, checkpointHash: digest(restore) },
        },
        async (context) => {
          await context.saveNativeCheckpoint!({
            v: 1,
            providerId: 'claude-code',
            payload: restore!,
          });
          return { pinned: true };
        },
        principal,
      );
    }
    if (request.mode === 'start' && run.steps.some((step) => step.intent.kind === 'model'))
      throw new EngineError('SESSION_EXISTS', 'Use follow-up for an existing conversation.');
    restore ??= this.checkpoint(run);
    if (restore && restore.state !== 'idle')
      throw new EngineError('RECONCILE_REQUIRED', 'The native turn outcome is uncertain.', true);
    if (request.mode === 'follow-up' && !this.connections.has(runId))
      throw new EngineError(
        'RESUME_REQUIRED',
        'Explicitly resume this conversation after its process closes.',
      );
    if (request.mode === 'resume' && !restore?.nativeSessionId)
      throw new EngineError(
        'SESSION_INVALID',
        'This conversation has no confirmed native session to resume.',
      );
    await this.resolveWaits(runId, input.projectId);
    const admission = await this.runs.step(
      runId,
      this.owner,
      {
        id: stepKey('admit', input.requestId),
        version: '1',
        kind: 'tool',
        effect: 'read',
        name: 'Native session admission',
        input: { engine: 'claude-code', model: input.model, accountRoute: input.accountRoute },
        destination: 'local',
        cost: 0,
        maxAttempts: 3,
      },
      () => request.admit(input.signal),
      principal,
    );
    if (request.mode === 'resume' && this.connections.has(runId)) {
      await this.dispose(runId, this.connections.get(runId)!);
    }
    let response: ClaudeSessionTurnResult;
    try {
      response = await this.runs.step<ClaudeSessionTurnResult>(
        runId,
        this.owner,
        turnDefinition,
        async (context) => {
          const save = context.saveNativeCheckpoint;
          if (!save)
            throw new HarnessError(
              'invalid_checkpoint',
              'The runtime does not support native checkpoints.',
            );
          let connection = this.connections.get(runId);
          if (!connection) {
            let owned: Connection | undefined;
            const session = await request.open(
              admission,
              { ...input, signal: undefined, onDelta: undefined, onPreview: undefined },
              {
                observedVersion: admission.version,
                restore,
                fork: request.mode === 'fork',
                onCheckpoint: async (checkpoint, signal) => {
                  const writer = owned?.writer;
                  if (!writer || this.connections.get(runId) !== owned || signal.aborted)
                    throw new HarnessError(
                      'stale_attempt',
                      'No running attempt owns this checkpoint callback.',
                    );
                  return writer({ v: 1, providerId: 'claude-code', payload: checkpoint }, signal);
                },
              },
            );
            if (this.closed || context.signal.aborted || input.signal?.aborted) {
              await session.close();
              throw new EngineError('CANCELLED', 'The native process was stopped before dispatch.');
            }
            connection = { session };
            owned = connection;
            this.connections.set(runId, connection);
            const endOwned = () => {
              void this.dispose(runId, owned!, context.signal.reason);
            };
            context.signal.addEventListener('abort', endOwned, { once: true });
            connection.detach = () => context.signal.removeEventListener('abort', endOwned);
            connection.timer = setTimeout(() => {
              void this.dispose(
                runId,
                owned!,
                new EngineError('TIMEOUT', 'The native connection reached its lifetime limit.'),
              );
            }, this.lifetimeMs);
            connection.timer.unref();
          }
          connection.writer = save;
          const preview = request.preview?.(context, turnId);
          try {
            let result: TextResponse | null = null;
            let interrupted = false;
            try {
              result = await connection.session.turn({
                ...input,
                signal: AbortSignal.any([context.signal, ...(input.signal ? [input.signal] : [])]),
                onDelta: preview?.onDelta,
              });
              if (
                result.projectId !== input.projectId ||
                result.threadId !== input.threadId ||
                result.requestId !== input.requestId ||
                result.version !== admission.version
              )
                throw new EngineError(
                  'IDENTITY_MISMATCH',
                  'The native response did not match this request.',
                  true,
                );
            } catch (error) {
              if (
                error instanceof EngineError &&
                error.code === 'CANCELLED' &&
                connection.session.checkpoint.state === 'idle'
              )
                interrupted = true;
              else throw error;
            }
            await preview?.finish();
            context.reportOrigin?.({
              protocolVersion: 1,
              mode: 'direct',
              engine: { id: 'claude-code', version: admission.version },
              model: {
                requested: input.model,
                reported: connection.session.checkpoint.reportedModel,
                source: connection.session.checkpoint.reportedModel ? 'runtime' : 'not-recorded',
              },
              accountRoute: input.accountRoute,
            });
            return {
              runId,
              response: result,
              interrupted,
              nativeSession: connection.session.nativeSession,
            };
          } catch (error) {
            await this.dispose(runId, connection, error);
            throw error;
          } finally {
            connection.writer = undefined;
          }
        },
        principal,
      );
    } catch (error) {
      const connection = this.connections.get(runId);
      if (connection) await this.dispose(runId, connection, error);
      throw error;
    }
    await this.park(runId, input.projectId, input.requestId);
    return response;
  }
  async control(
    projectId: string,
    runId: string,
    commandId: string,
    command: 'interrupt' | 'close',
  ) {
    const run = await this.get(projectId, runId);
    if (terminal(run) && command === 'close') {
      const connection = this.connections.get(runId);
      if (connection) await this.dispose(runId, connection);
      return { commandId, command, acknowledged: true, turnCompleted: false, nativeSession: null };
    }
    if (terminal(run))
      throw new EngineError('RECONCILE_REQUIRED', 'This run is settled or uncertain.', true);
    await this.runs.claim(runId, this.owner, 35 * 60_000);
    const definition: StepDefinition = {
      id: stepKey('control', commandId),
      version: '1',
      kind: 'tool',
      effect: 'read',
      name: `Claude ${command}`,
      input: { command, commandId },
      cost: 0,
      destination: 'local',
      maxAttempts: 1,
    };
    if (
      run.steps.some((step) => step.intent.stepId === definition.id && step.state === 'succeeded')
    )
      return this.runs.step(
        runId,
        this.owner,
        definition,
        () => {
          throw new Error('A control receipt must replay.');
        },
        localHarnessPrincipal(projectId),
      );
    const connection = this.connections.get(runId);
    if (!connection)
      throw new EngineError('SESSION_CLOSED', 'The native process is already closed.');
    if (command === 'interrupt' && !this.active.has(runId))
      throw new EngineError('SESSION_IDLE', 'No native turn is running.');
    if (!this.active.has(runId)) await this.resolveWaits(runId, projectId);
    const receipt = await this.runs.step(
      runId,
      this.owner,
      definition,
      async () => {
        if (command === 'interrupt') await connection.session.interrupt();
        else {
          await this.dispose(runId, connection);
        }
        return {
          commandId,
          command,
          acknowledged: true,
          turnCompleted: false,
          nativeSession: connection.session.nativeSession,
        };
      },
      localHarnessPrincipal(projectId),
    );
    await this.park(runId, projectId, commandId);
    return receipt;
  }
  async recover(run: HarnessRun) {
    if (run.capabilityId === CLAUDE_SESSION_CAPABILITY.id && !terminal(run))
      await this.runs.recover(run.id, localHarnessPrincipal(run.projectId));
  }
  async closeAll() {
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort();
    const closed = await Promise.allSettled(
      [...this.connections].map(([runId, value]) => this.dispose(runId, value)),
    );
    await Promise.allSettled([...this.active.values()].map((value) => value.promise));
    await Promise.allSettled([...this.closing]);
    const failure = closed.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (this.cleanupFailures.length) throw this.cleanupFailures[0];
  }
}
