import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { NativeSessionRef } from '../../shared/contract-revision.js';
import { contextMessage, type TextRequest, type TextResponse } from './contract.js';
import { EngineError, record, stopped, type EngineProcess } from './process.js';
import {
  claudeControlResponse,
  claudeInitAllowed,
  claudeObserveTools,
  claudePermission,
  claudeWebHelperModel,
} from './claude.js';
import { readScopeDigest } from './read-scope.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function claudeFailure(value: unknown): EngineError {
  const text = JSON.stringify(value);
  if (/rate.?limit|usage.?limit|quota|overloaded/i.test(text))
    return new EngineError(
      'USAGE_LIMIT',
      'Claude Code reported a usage or service limit. No account or model was substituted.',
      true,
    );
  if (/auth|login|sign.?in|unauthorized/i.test(text))
    return new EngineError(
      'AUTH_REQUIRED',
      'Claude Code needs sign-in. Use its sign-in action, then recheck.',
      true,
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'Claude Code could not complete this request. No automatic retry was sent.',
    true,
  );
}
export function sameClaudeModel(requested: string, reported: string) {
  return (
    requested === reported ||
    (['sonnet', 'opus', 'haiku'].includes(requested) && reported.startsWith(`claude-${requested}-`))
  );
}
export const claudeCheckpointSchema = z.strictObject({
  version: z.literal(1),
  nativeSessionId: z.string().uuid().nullable(),
  lineageId: z.string().uuid(),
  parentSessionId: z.string().uuid().nullable(),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4000),
  cliVersion: z.string().min(1).max(80),
  accountDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestedModel: z.string().min(1).max(200),
  reportedModel: z.string().min(1).max(200).nullable(),
  instructionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * The read scope the session was opened with (`readScopeDigest`). Absent on
   * checkpoints written before read tools existed, which read as text-only.
   */
  scopeDigest: z.string().min(1).max(80).optional(),
  state: z.enum(['idle', 'busy', 'uncertain']),
  requests: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(128),
  results: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(128),
});
/** Metadata only. Native transcripts remain with Claude, never translated into portable context. */
export type ClaudeSessionCheckpoint = z.infer<typeof claudeCheckpointSchema>;
export interface ClaudeSessionOptions {
  observedVersion: string;
  restore?: ClaudeSessionCheckpoint;
  fork?: boolean;
  /** Resolve only after the existing runtime has durably saved this checkpoint. */
  onCheckpoint: (checkpoint: ClaudeSessionCheckpoint, signal: AbortSignal) => Promise<void>;
}

export function prepareClaudeSession(
  input: TextRequest,
  options: ClaudeSessionOptions,
  account: Record<string, unknown>,
  cwd: string,
  version: string,
  expectedAccount?: string,
) {
  if (options.observedVersion !== version)
    throw new EngineError('VERSION_MISMATCH', 'Claude Code session compatibility needs review.');
  if (input.accountRoute !== 'claude-code:claude.ai')
    throw new EngineError('ACCOUNT_CHANGED', 'Recheck the selected Claude account route.');
  const identity = typeof account.accountId === 'string' ? account.accountId : account.email;
  if (typeof identity !== 'string' || !identity)
    throw new EngineError('AUTH_UNKNOWN', 'Claude Code did not identify its signed-in account.');
  const accountDigest = digest(JSON.stringify([identity, account.orgId ?? null]));
  if (expectedAccount && expectedAccount !== accountDigest)
    throw new EngineError(
      'ACCOUNT_CHANGED',
      'The Claude account changed. Recheck before continuing.',
    );
  const instructionDigest = digest(input.instructions);
  let checkpoint: ClaudeSessionCheckpoint = {
    version: 1,
    nativeSessionId: randomUUID(),
    lineageId: randomUUID(),
    parentSessionId: null,
    projectId: input.projectId,
    threadId: input.threadId,
    cwd: path.resolve(cwd),
    cliVersion: version,
    accountDigest,
    requestedModel: input.model,
    reportedModel: null,
    instructionDigest,
    scopeDigest: readScopeDigest(input.readScope),
    state: 'idle',
    requests: [],
    results: [],
  };
  if (options.restore) {
    const parsed = claudeCheckpointSchema.safeParse(options.restore);
    if (!parsed.success)
      throw new EngineError('SESSION_INVALID', 'The native session reference is corrupt.');
    const saved = parsed.data;
    if (saved.state !== 'idle' || !saved.nativeSessionId)
      throw new EngineError(
        'RECONCILE_REQUIRED',
        'The previous native turn has an unknown outcome. It was not resent.',
        true,
      );
    if (
      saved.accountDigest !== accountDigest ||
      saved.projectId !== input.projectId ||
      (!options.fork && saved.threadId !== input.threadId) ||
      saved.cwd !== checkpoint.cwd ||
      saved.cliVersion !== version ||
      saved.requestedModel !== input.model ||
      saved.instructionDigest !== instructionDigest ||
      (saved.scopeDigest ?? 'text-only') !== readScopeDigest(input.readScope)
    )
      throw new EngineError(
        'SESSION_MISMATCH',
        'The native session account, project, model, version or instructions changed.',
      );
    checkpoint = options.fork
      ? {
          ...checkpoint,
          nativeSessionId: null,
          lineageId: saved.lineageId,
          parentSessionId: saved.nativeSessionId,
        }
      : saved;
  } else if (options.fork)
    throw new EngineError('SESSION_INVALID', 'Fork needs an existing native session.');
  const args = ['--model', input.model];
  if (options.restore) {
    args.push('--resume', options.restore.nativeSessionId!);
    if (options.fork) args.push('--fork-session');
  } else args.push('--session-id', checkpoint.nativeSessionId!);
  return { checkpoint, args };
}

/** A bounded protocol connection, not a second durable run or permission authority. */
export class ClaudeNativeSession {
  private active?: Promise<TextResponse>;
  private activeRequest?: { id: string; digest: string };
  private interruptPending?: {
    id: string;
    resolve: () => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private interrupted = false;
  private closing?: Promise<void>;
  private closed = false;
  private initialized = false;
  private dispatched = false;
  constructor(
    private readonly process: { child: EngineProcess; close: (primary?: unknown) => Promise<void> },
    private saved: ClaudeSessionCheckpoint,
    private readonly persist: ClaudeSessionOptions['onCheckpoint'],
    private readonly recheckAccount: (signal?: AbortSignal) => Promise<void>,
    private readonly controller: AbortController,
  ) {}
  get checkpoint(): ClaudeSessionCheckpoint {
    return structuredClone(this.saved);
  }
  get nativeSession(): NativeSessionRef | null {
    return this.saved.nativeSessionId && this.saved.reportedModel
      ? {
          providerId: 'claude-code',
          lineageId: this.saved.lineageId,
          opaqueRef: this.saved.nativeSessionId,
        }
      : null;
  }
  private async save() {
    // A stuck host persistence callback must not keep cancellation or shutdown pending forever.
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]);
    signal.throwIfAborted();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(stopped());
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([this.persist(this.checkpoint, signal), cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async turn(input: TextRequest): Promise<TextResponse> {
    const prompt = contextMessage(input);
    if (!input.requestId || input.requestId.length > 200)
      throw new EngineError('REQUEST_INVALID', 'A bounded request identity is required.');
    if (
      input.projectId !== this.saved.projectId ||
      input.threadId !== this.saved.threadId ||
      input.model !== this.saved.requestedModel ||
      digest(input.instructions) !== this.saved.instructionDigest ||
      (this.saved.scopeDigest ?? 'text-only') !== readScopeDigest(input.readScope) ||
      input.accountRoute !== 'claude-code:claude.ai'
    )
      throw new EngineError(
        'SESSION_MISMATCH',
        'This input does not match the native session scope.',
      );
    const requestDigest = digest(prompt);
    if (this.activeRequest?.id === input.requestId) {
      if (this.activeRequest.digest !== requestDigest)
        throw new EngineError(
          'IDEMPOTENCY_CONFLICT',
          'This request identity has different content.',
        );
      return this.active!;
    }
    if (this.closed || this.saved.state === 'uncertain')
      throw new EngineError(
        'RECONCILE_REQUIRED',
        'The native connection is closed or uncertain.',
        true,
      );
    if (this.active || this.interruptPending)
      throw new EngineError(
        'SESSION_BUSY',
        'Queue the follow-up in the existing runtime until this turn ends.',
      );
    if (this.saved.requests.some((r) => r.id === input.requestId))
      throw new EngineError(
        'DUPLICATE_REQUEST',
        'Read the recorded run outcome; this native request was already sent.',
      );
    if (this.saved.requests.length >= 128)
      throw new EngineError(
        'SESSION_LIMIT',
        'This connection reached its bounded turn limit. Start a new authorized conversation.',
      );
    this.activeRequest = { id: input.requestId, digest: requestDigest };
    this.active = this.run(input, prompt, this.activeRequest);
    try {
      return await this.active;
    } finally {
      this.active = undefined;
      this.activeRequest = undefined;
    }
  }
  private async run(
    input: TextRequest,
    prompt: string,
    request: { id: string; digest: string },
  ): Promise<TextResponse> {
    const abort = () => {
      this.controller.abort();
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    let dispatched = false;
    const openCalls = new Map<string, string>();
    let webUsed = false;
    try {
      if (input.signal?.aborted) throw stopped();
      await this.recheckAccount(
        AbortSignal.any([this.controller.signal, ...(input.signal ? [input.signal] : [])]),
      );
      this.saved.state = 'busy';
      this.saved.requests.push(request);
      await this.save();
      if (this.closed || this.controller.signal.aborted) throw stopped();
      this.interrupted = false;
      this.process.child.send({
        type: 'user',
        uuid: randomUUID(),
        session_id: this.saved.nativeSessionId ?? '',
        parent_tool_use_id: null,
        message: { role: 'user', content: prompt },
      });
      dispatched = true;
      this.dispatched = true;
      for (;;) {
        const frame = await this.process.child.next();
        if (frame.type === 'control_request') {
          const request = record(frame.request);
          if (request.subtype === 'can_use_tool' && typeof frame.request_id === 'string') {
            // This turn's own scope and grant answer it, before the tool runs.
            const answer = await claudePermission(input.readScope, request, this.saved.cwd);
            this.process.child.send(claudeControlResponse(frame.request_id, answer));
            if (answer.behavior === 'deny')
              throw new EngineError(
                'POLICY_MISMATCH',
                `Claude Code ${answer.message}; the read-only request was stopped.`,
                true,
              );
            continue;
          }
          if (typeof frame.request_id === 'string')
            this.process.child.send({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: {
                  behavior: 'deny',
                  message: 'Permission prompts and callbacks are disabled on this route.',
                  interrupt: true,
                },
              },
            });
          throw new EngineError('POLICY_MISMATCH', 'Claude requested a disabled capability.', true);
        }
        if (frame.type === 'control_response') {
          const response = record(frame.response);
          const pending = this.interruptPending;
          if (pending && pending.id === response.request_id) {
            this.interruptPending = undefined;
            clearTimeout(pending.timer);
            if (response.subtype === 'success') pending.resolve();
            else {
              const error = claudeFailure(response);
              pending.reject(error);
              throw error;
            }
          }
          continue;
        }
        if (frame.parent_tool_use_id != null)
          throw new EngineError(
            'POLICY_MISMATCH',
            'An unexpected child observation cannot authorize this text route.',
            true,
          );
        if (frame.type === 'system' && frame.subtype === 'init') {
          if (typeof frame.model === 'string') this.saved.reportedModel = frame.model;
          if (
            !claudeInitAllowed(input.readScope, frame) ||
            typeof frame.model !== 'string' ||
            !sameClaudeModel(input.model, frame.model) ||
            typeof frame.session_id !== 'string' ||
            !z.string().uuid().safeParse(frame.session_id).success ||
            (this.saved.nativeSessionId !== null &&
              this.saved.nativeSessionId !== frame.session_id) ||
            this.saved.parentSessionId === frame.session_id
          )
            throw new EngineError(
              'POLICY_MISMATCH',
              'Claude reported a different session, model or tool policy.',
              true,
            );
          this.saved.nativeSessionId = frame.session_id;
          this.initialized = true;
          await this.save();
        }
        if (frame.type === 'assistant') {
          const message = record(frame.message);
          if (typeof message.model === 'string' && !sameClaudeModel(input.model, message.model)) {
            this.saved.reportedModel = message.model;
            throw new EngineError('POLICY_MISMATCH', 'Claude reported a model reroute.', true);
          }
          if (
            !input.readScope &&
            Array.isArray(message.content) &&
            message.content.some((part) => record(part).type === 'tool_use')
          )
            throw new EngineError('POLICY_MISMATCH', 'Claude attempted a disabled tool.', true);
        }
        if (frame.type === 'assistant' || frame.type === 'user')
          if (claudeObserveTools(input.readScope, frame, input.onToolActivity, openCalls))
            webUsed = true;
        if (frame.type === 'stream_event' && this.initialized && !this.interrupted) {
          if (frame.session_id !== undefined && frame.session_id !== this.saved.nativeSessionId)
            throw new EngineError(
              'PROTOCOL_ERROR',
              'Output belongs to another native session.',
              true,
            );
          const delta = record(record(frame.event).delta);
          if (delta.type === 'text_delta' && typeof delta.text === 'string')
            input.onDelta?.(delta.text);
        }
        if (frame.type !== 'result') continue;
        if (typeof frame.uuid !== 'string')
          throw new EngineError(
            'PROTOCOL_ERROR',
            'Claude returned an unidentifiable result.',
            true,
          );
        const resultDigest = digest(JSON.stringify(frame));
        const previous = this.saved.results.find((result) => result.id === frame.uuid);
        if (previous) {
          if (previous.digest !== resultDigest)
            throw new EngineError(
              'PROTOCOL_ERROR',
              'Claude reused a result identity with different content.',
              true,
            );
          continue;
        }
        if (!this.initialized || frame.session_id !== this.saved.nativeSessionId)
          throw new EngineError(
            'PROTOCOL_ERROR',
            'Claude did not identify the completed conversation.',
            true,
          );
        if (frame.is_error === true || frame.subtype !== 'success')
          throw claudeFailure(frame.errors ?? frame);
        if (
          Object.keys(record(frame.modelUsage)).some(
            (model) =>
              !sameClaudeModel(input.model, model) &&
              !(input.readScope && webUsed && claudeWebHelperModel(model)),
          )
        )
          throw new EngineError(
            'POLICY_MISMATCH',
            'Claude reported an unexpected model call.',
            true,
          );
        if (typeof frame.result !== 'string' || (!this.interrupted && !frame.result.trim()))
          throw new EngineError(
            'PROTOCOL_ERROR',
            'Claude did not return a complete text result.',
            true,
          );
        this.saved.results.push({ id: frame.uuid, digest: resultDigest });
        this.saved.state = 'idle';
        this.dispatched = false;
        await this.save();
        if (this.interrupted) throw stopped();
        return {
          text: frame.result,
          model: this.saved.reportedModel!,
          version: this.saved.cliVersion,
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
        };
      }
    } catch (error) {
      if (
        !(error instanceof EngineError && error.code === 'CANCELLED' && this.saved.state === 'idle')
      ) {
        this.saved.state = 'uncertain';
        let saveError: unknown;
        try {
          if (!this.controller.signal.aborted) await this.save();
        } catch (failure) {
          saveError = failure;
        }
        await this.close(error);
        if (saveError)
          throw new EngineError(
            'CHECKPOINT_FAILED',
            'The native outcome could not be durably recorded.',
            dispatched,
          );
      }
      throw error;
    } finally {
      this.dispatched = false;
      input.signal?.removeEventListener('abort', abort);
    }
  }
  async interrupt(): Promise<void> {
    if (!this.active || !this.dispatched || this.closed || this.saved.state !== 'busy')
      throw new EngineError('SESSION_IDLE', 'No native turn is running.');
    if (this.interruptPending)
      throw new EngineError(
        'INTERRUPT_PENDING',
        'An interrupt is already awaiting acknowledgment.',
      );
    this.interrupted = true;
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.interruptPending = undefined;
        reject(new EngineError('TIMEOUT', 'Claude did not acknowledge interrupt.', true));
        this.controller.abort();
      }, 5000);
      this.interruptPending = { id, resolve, reject, timer };
      try {
        this.process.child.send({
          type: 'control_request',
          request_id: id,
          request: { subtype: 'interrupt' },
        });
      } catch (error) {
        clearTimeout(timer);
        this.interruptPending = undefined;
        reject(error);
        this.controller.abort();
      }
    });
  }
  close(primary?: unknown): Promise<void> {
    this.closed = true;
    if (this.saved.state === 'busy') this.saved.state = 'uncertain';
    this.controller.abort();
    if (this.interruptPending) {
      clearTimeout(this.interruptPending.timer);
      this.interruptPending.reject(primary ?? stopped());
      this.interruptPending = undefined;
    }
    this.closing ??= this.process.close(primary);
    return this.closing;
  }
}
