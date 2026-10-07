/**
 * The kept ChatGPT conversation (spec 3.2): one Diomedes conversation continuing one Codex
 * thread across its turns, on the shared native conversation driver
 * (`server/harness/claude-session-run.ts`) as the Claude, OpenCode and ACP sessions are. Nothing
 * here writes a run record; the driver persists every checkpoint this class hands it.
 *
 * The conversation owns one app-server process at a time (`CodexConversationPort` in
 * server/integrations.ts), started for its read scope and never shared with another
 * conversation. The process ends after `CODEX_SESSION_IDLE_MS` without a turn, because the
 * app-server keeps each thread's MCP servers until it exits. Nothing depends on it staying warm:
 * the thread id is saved durably before `turn/start`, and a turn on a new process continues the
 * thread with `thread/resume`.
 *
 * Diomedes runs its own proven Codex runtime and never gates on its version (2026-09-23): a
 * runtime that changed since the last turn continues the saved thread, and a thread Codex can't
 * continue starts fresh and says so. A person's Stop sends `turn/interrupt`, waits a bounded time
 * for Codex to end the turn, then ends the process tree; the checkpoint records which happened.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NativeSessionRef } from '../../shared/contract-revision.js';
import { digest } from '../harness/policy.js';
import type { CodexConversationPort, CodexConversationProcess, CodexForkAnswer } from '../integrations.js';
import { contextMessage, type TextRequest, type TextResponse } from './contract.js';
import { EngineError, stopped } from './process.js';
import { readAccessOf, readScopeDigest, type ReadScope } from './read-scope.js';

/** How long a Stop waits for Codex to end the turn after `turn/interrupt` before the process ends. */
export const CODEX_INTERRUPT_WAIT_MS = 3_000;
/** How long a conversation's process stays open without a turn. */
export const CODEX_SESSION_IDLE_MS = 300_000;
/** The account route a ChatGPT conversation is admitted under; the account itself is checked every turn. */
export const CODEX_ACCOUNT_ROUTE = 'codex:chatgpt';
/**
 * How the latest turn reached its thread. `recovered`: Diomedes restarted while a turn was
 * running and the saved thread was kept for the next `thread/resume`; the running message is
 * recorded as not completed.
 */
export const CODEX_SESSION_ORIGINS = ['started', 'resumed', 'restarted-fresh', 'forked', 'recovered'] as const;
type CodexSessionOrigin = (typeof CODEX_SESSION_ORIGINS)[number];

const opaqueId = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

export const codexCheckpointSchema = z.strictObject({
  version: z.literal(1),
  /** The Codex thread this conversation continues; null until the first turn opens one. */
  nativeSessionId: opaqueId.nullable(),
  /** Shared by a conversation and its forks, as the Claude and OpenCode sessions share theirs. */
  lineageId: z.string().uuid(),
  /** For a fork, the thread Codex copied it from. */
  parentSessionId: opaqueId.nullable(),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  /** The runtime that last served the thread. Recorded, never compared. */
  cliVersion: z.string().min(1).max(80),
  accountRoute: z.literal(CODEX_ACCOUNT_ROUTE),
  /** The ChatGPT account this conversation runs on, as a nonsecret hash; null before the first check. */
  account: z.string().regex(/^openai:chatgpt:[a-f0-9]{64}$/).nullable(),
  requestedModel: z.string().min(1).max(256),
  /** The model Codex reported for the last answer. */
  reportedModel: z.string().min(1).max(256).nullable(),
  /** The reasoning effort the last turn asked for; null when it asked for none. Recorded, never compared. */
  effort: z.string().min(1).max(40).nullable(),
  instructionDigest: sha,
  scopeDigest: z.string().min(1).max(80),
  state: z.enum(['idle', 'busy', 'uncertain']),
  origin: z.enum(CODEX_SESSION_ORIGINS),
  /** The thread a resume asked for and Codex no longer had. Only with `restarted-fresh`. */
  lostThreadId: opaqueId.nullable(),
  /** The command a restart interrupted. Only with `recovered`; never resent. */
  interruptedRequestId: z.string().min(1).max(200).nullable(),
  /** How the latest Stop ended: Codex acknowledged turn/interrupt, or the process was ended. */
  lastStop: z.enum(['acknowledged', 'killed']).nullable(),
  turns: z.number().int().nonnegative().max(100_000),
});
export type CodexSessionCheckpoint = z.infer<typeof codexCheckpointSchema>;

export interface CodexSessionOptions {
  observedVersion: string;
  restore?: CodexSessionCheckpoint;
  fork?: boolean;
  /** Resolve only after the host has durably saved this checkpoint. */
  onCheckpoint(checkpoint: CodexSessionCheckpoint, signal: AbortSignal): Promise<void>;
}
export interface CodexSessionTuning {
  idleMs: number;
  interruptWaitMs: number;
}

const ACCOUNT_CHANGED =
  "Codex is signed in to a different ChatGPT account than this conversation started with, so it can't continue here. Sign in to the earlier account, or start a new conversation.";

const continuityDetail = (origin: CodexSessionOrigin, interrupted: boolean): string | null => {
  const restart = interrupted
    ? "Nectovia restarted while an earlier message was being answered. That message wasn't completed or sent again. "
    : '';
  if (origin === 'restarted-fresh')
    return `${restart}Codex no longer had this conversation's thread, so this message started a new one. Earlier messages weren't carried into it.`;
  if (interrupted) return `${restart}This conversation continued from Codex's saved thread.`;
  return null;
};

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

/**
 * A failure from the port as the `EngineError` every kept-session route renders (409 with its
 * code). Read by `code` alone, so this module never imports server/integrations.ts at run time.
 */
export function codexSessionError(error: unknown, sent: boolean): unknown {
  if (error instanceof EngineError || !(error instanceof Error)) return error;
  const code = codeOf(error);
  if (typeof code !== 'string') return error;
  return new EngineError(code, error.message, sent, code === 'CHATGPT_REQUIRED' ? 'provider-auth' : undefined);
}

interface Live {
  process: CodexConversationProcess;
  /** The thread opened on this process; null until a turn opens or resumes it here. */
  thread: string | null;
  /** The model Codex reported when it opened the thread here. */
  model: string | null;
}
interface Active {
  id: string;
  digest: string;
  controller: AbortController;
  promise: Promise<TextResponse>;
  /** Codex's id for the running turn, once it acknowledged `turn/start`. */
  turnId: string | null;
  /** Set when a Stop had to end the process. */
  killed: boolean;
}

export class CodexNativeSession {
  private active?: Active;
  private live?: Live;
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private latest: { origin: CodexSessionOrigin; interrupted: boolean } | null = null;
  constructor(
    private readonly port: CodexConversationPort,
    private saved: CodexSessionCheckpoint,
    private readonly scope: ReadScope | undefined,
    private readonly persist: CodexSessionOptions['onCheckpoint'],
    private readonly tuning: CodexSessionTuning,
  ) {}
  get checkpoint(): CodexSessionCheckpoint {
    return structuredClone(this.saved);
  }
  get nativeSession(): NativeSessionRef | null {
    return this.saved.nativeSessionId
      ? { providerId: 'codex', lineageId: this.saved.lineageId, opaqueRef: this.saved.nativeSessionId }
      : null;
  }
  /**
   * How the latest turn reached its thread, for the person. Read on every turn
   * (`continuityPerTurn`): a resume Codex couldn't honour is said on the turn it happened.
   */
  get continuity(): { origin: string; detail: string | null } {
    const latest = this.latest ?? { origin: this.saved.origin, interrupted: false };
    return { origin: latest.origin, detail: continuityDetail(latest.origin, latest.interrupted) };
  }
  readonly continuityPerTurn = true;
  get busy(): boolean {
    return this.active !== undefined;
  }
  private async save() {
    // A stuck host persistence callback must not keep a Stop or a shutdown pending forever.
    await this.persist(this.checkpoint, AbortSignal.timeout(10_000));
  }
  async turn(input: TextRequest): Promise<TextResponse> {
    const prompt = contextMessage(input);
    if (!input.requestId || input.requestId.length > 200)
      throw new EngineError('REQUEST_INVALID', 'A bounded request identity is required.');
    if (
      input.projectId !== this.saved.projectId ||
      input.threadId !== this.saved.threadId ||
      input.model !== this.saved.requestedModel ||
      input.accountRoute !== this.saved.accountRoute ||
      digest(input.instructions) !== this.saved.instructionDigest ||
      readScopeDigest(input.readScope) !== this.saved.scopeDigest
    )
      throw new EngineError('SESSION_MISMATCH', 'This input does not match the Codex conversation scope.');
    const requestDigest = digest(prompt);
    if (this.active?.id === input.requestId) {
      if (this.active.digest !== requestDigest)
        throw new EngineError('IDEMPOTENCY_CONFLICT', 'This request identity has different content.');
      return this.active.promise;
    }
    if (this.closed || this.saved.state !== 'idle')
      throw new EngineError('RECONCILE_REQUIRED', 'The Codex conversation is closed or its last turn is uncertain.', true);
    if (this.active) throw new EngineError('SESSION_BUSY', 'Codex is still answering the previous message.');
    // Before anything is awaited: the idle timer can't end the process this turn is about to use.
    this.disarm();
    const active: Active = {
      id: input.requestId,
      digest: requestDigest,
      controller: new AbortController(),
      promise: Promise.resolve() as unknown as Promise<TextResponse>,
      turnId: null,
      killed: false,
    };
    this.active = active;
    active.promise = this.run(input, prompt, active).finally(() => {
      if (this.active === active) this.active = undefined;
      this.arm();
    });
    return active.promise;
  }
  private async run(input: TextRequest, prompt: string, active: Active): Promise<TextResponse> {
    const signal = AbortSignal.any([active.controller.signal, ...(input.signal ? [input.signal] : [])]);
    const interrupted = this.saved.origin === 'recovered' && this.saved.interruptedRequestId !== null;
    let sent = false;
    try {
      const live = await this.connect(signal);
      let origin: CodexSessionOrigin = 'resumed';
      let lost: string | null = null;
      if (live.thread === null) {
        const opened = await live.process.thread({
          scope: this.scope,
          model: input.model,
          ...(input.effort ? { effort: input.effort } : {}),
          instructions: input.instructions,
          ...(this.saved.nativeSessionId ? { resume: this.saved.nativeSessionId } : {}),
          signal,
        });
        live.thread = opened.threadId;
        live.model = opened.model;
        origin = opened.origin;
        lost = opened.lost;
      }
      if (signal.aborted) throw stopped();
      this.saved = {
        ...this.saved,
        nativeSessionId: live.thread,
        cliVersion: live.process.version,
        effort: input.effort ?? null,
        origin,
        lostThreadId: lost,
        // Saved before turn/start: a restart from here on finds this thread.
        state: 'busy',
      };
      await this.save();
      sent = true;
      if (signal.aborted) throw stopped();
      const answer = await live.process.turn({
        threadId: live.thread,
        prompt,
        ...(input.effort ? { effort: input.effort } : {}),
        scope: this.scope,
        // Only while a thinking sink listens: the protocol carries the setting to later turns.
        summaries: Boolean(input.onReasoningDelta),
        signal,
        onDelta: input.onDelta,
        onToolActivity: input.onToolActivity,
        onReasoningDelta: input.onReasoningDelta,
        onTurn: (turnId) => {
          active.turnId = turnId;
        },
      });
      this.latest = { origin, interrupted };
      this.saved = {
        ...this.saved,
        state: 'idle',
        reportedModel: answer.model ?? live.model ?? this.saved.reportedModel,
        interruptedRequestId: null,
        lastStop: null,
        turns: this.saved.turns + 1,
      };
      await this.save();
      return {
        text: answer.text,
        // A selection is not runtime evidence (decision 8). Empty means Codex did not report a model.
        model: answer.model ?? live.model ?? '',
        version: live.process.version,
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
      };
    } catch (error) {
      const stop = codeOf(error) === 'TURN_INTERRUPTED' ? 'acknowledged' : active.killed ? 'killed' : null;
      // A process whose turn failed or was ended isn't reused; one that acknowledged a Stop is.
      if (stop !== 'acknowledged') await this.drop();
      if (sent) {
        // Codex keeps the thread's rollout whatever became of the turn. After a Stop the next
        // message continues it; a failed turn is uncertain, so the driver holds the run for
        // reconciliation and the conversation's next message starts a new lineage and thread.
        this.latest = { origin: this.saved.origin, interrupted };
        this.saved = { ...this.saved, state: 'idle', lastStop: stop, interruptedRequestId: null };
        await this.save().catch(() => undefined);
      }
      if (stop || signal.aborted) throw Object.assign(stopped(), { stopOutcome: stop ?? 'killed' });
      throw codexSessionError(error, sent);
    }
  }
  /**
   * The conversation's process: the live one, or a new one when the idle timer or an exit ended
   * the last. The ChatGPT account is checked every time; a different one never continues it.
   */
  private async connect(signal?: AbortSignal): Promise<Live> {
    this.disarm();
    if (!this.live || this.live.process.closed) {
      // An updater can retire an otherwise live process. Close it before opening
      // the replacement, then resume the saved native thread on the current build.
      await this.live?.process.close();
      this.live = undefined;
      const opened = await this.port.open(this.scope, signal);
      if (signal?.aborted || this.closed) {
        await opened.close().catch(() => undefined);
        throw stopped();
      }
      this.live = { process: opened, thread: null, model: null };
    }
    const account = await this.live.process.account();
    if (this.saved.account === null) this.saved = { ...this.saved, account };
    else if (account !== this.saved.account)
      throw new EngineError('ACCOUNT_CHANGED', ACCOUNT_CHANGED, false, 'provider-auth');
    return this.live;
  }
  /**
   * Before a turn is recorded, sending nothing to a model: opens a process when the idle timer
   * ended the last one, and refuses an account other than the one this conversation began with.
   * The turn itself resumes the thread.
   */
  async verify(): Promise<void> {
    if (this.closed || this.active) return;
    try {
      await this.connect();
    } catch (error) {
      await this.drop();
      throw codexSessionError(error, false);
    } finally {
      this.arm();
    }
  }
  /**
   * A person's Stop (H03): `turn/interrupt`, a bounded wait for Codex to end the turn, then the
   * process ends. Before Codex has acknowledged the turn there's nothing to interrupt, so the
   * process ends at once: nothing is left half sent or running, and the saved thread stays.
   */
  async stop(graceMs: number = this.tuning.interruptWaitMs): Promise<'interrupted' | 'killed'> {
    const active = this.active;
    if (!active) throw new EngineError('SESSION_IDLE', 'No Codex turn is running.');
    const live = this.live;
    if (active.turnId && live?.thread && !live.process.closed) {
      const acknowledged = await live.process
        .interrupt(live.thread, active.turnId, Math.min(graceMs, this.tuning.interruptWaitMs))
        .catch(() => false);
      if (acknowledged) {
        await active.promise.catch(() => undefined);
        return 'interrupted';
      }
    }
    active.killed = true;
    active.controller.abort();
    await this.drop();
    await active.promise.catch(() => undefined);
    return 'killed';
  }
  /** Stops the running turn, if any, as a Stop does. */
  async interrupt(): Promise<void> {
    await this.stop().catch(() => undefined);
  }
  /** Ends the conversation's process. The thread stays in Codex's store for an explicit resume. */
  async close(): Promise<void> {
    this.closed = true;
    this.disarm();
    if (this.active) await this.stop().catch(() => undefined);
    await this.drop();
  }
  /** Ends the process after the idle time without a turn. The next turn opens one and resumes. */
  private arm() {
    this.disarm();
    const live = this.live;
    if (this.closed || this.active || !live) return;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (this.active || this.live !== live) return;
      // Keep ownership if cleanup fails; the next connect or explicit close retries it.
      void live.process.close().then(() => {
        if (this.live === live) this.live = undefined;
      }).catch(() => undefined);
    }, this.tuning.idleMs);
  }
  private disarm() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
  }
  /** Ends the live process, if any. The thread stays in Codex's store for the next turn. */
  private async drop() {
    const live = this.live;
    await live?.process.close();
    if (this.live === live) this.live = undefined;
  }
}

/**
 * Opens a kept ChatGPT conversation: a new one, one restored from its saved checkpoint, or a
 * fork of one. The conversation's process is opened and its account checked before this
 * returns, so a refusal here is known not sent. The first turn opens or resumes the thread.
 */
export async function openCodexSession(
  port: CodexConversationPort,
  input: TextRequest,
  options: CodexSessionOptions,
  tuning: Partial<CodexSessionTuning> = {},
): Promise<CodexNativeSession> {
  if (input.accountRoute !== CODEX_ACCOUNT_ROUTE)
    throw new EngineError(
      'ACCOUNT_CHANGED',
      'The selected ChatGPT account route changed. Recheck before sending.',
      false,
      'provider-auth',
    );
  const scope = input.readScope;
  if (scope && readAccessOf(scope) === 'project')
    throw new EngineError(
      'POLICY_MISMATCH',
      "Codex can't read the whole project folder, because its reads can't be checked before they run. Choose the documents to include instead.",
      false,
      'dispatch',
    );
  const restore = options.restore ? codexCheckpointSchema.parse(options.restore) : undefined;
  const scopeDigest = readScopeDigest(scope);
  if (options.fork && !restore)
    throw new EngineError('SESSION_INVALID', 'A fork needs a saved Codex conversation to start from.');
  if (restore) {
    if (
      restore.projectId !== input.projectId ||
      // A fork may continue under a new Diomedes thread; everything else stays the source's.
      (!options.fork && restore.threadId !== input.threadId) ||
      restore.requestedModel !== input.model ||
      restore.accountRoute !== input.accountRoute ||
      restore.instructionDigest !== digest(input.instructions) ||
      restore.scopeDigest !== scopeDigest
    )
      throw new EngineError('SESSION_MISMATCH', 'The saved Codex conversation belongs to a different scope.');
    // No version gate (2026-09-23): a runtime that changed since this was saved continues it.
    if (restore.state !== 'idle')
      throw new EngineError('RECONCILE_REQUIRED', 'The saved Codex turn outcome is uncertain.', true);
    if (!restore.nativeSessionId)
      throw new EngineError('SESSION_INVALID', 'This conversation has no confirmed Codex thread.');
  }
  let saved: CodexSessionCheckpoint = restore ?? {
    version: 1,
    nativeSessionId: null,
    lineageId: randomUUID(),
    parentSessionId: null,
    projectId: input.projectId,
    threadId: input.threadId,
    cliVersion: options.observedVersion,
    accountRoute: CODEX_ACCOUNT_ROUTE,
    account: null,
    requestedModel: input.model,
    reportedModel: null,
    effort: null,
    instructionDigest: digest(input.instructions),
    scopeDigest,
    state: 'idle',
    origin: 'started',
    lostThreadId: null,
    interruptedRequestId: null,
    lastStop: null,
    turns: 0,
  };
  if (restore && options.fork) {
    if (!restore.account)
      throw new EngineError('SESSION_INVALID', 'This saved conversation has no confirmed ChatGPT account to fork.');
    let forked: CodexForkAnswer;
    try {
      forked = await port.fork(restore.nativeSessionId!, restore.account);
    } catch (error) {
      throw codexSessionError(error, false);
    }
    if (forked.state !== 'forked') throw new EngineError('COMMAND_UNSUPPORTED', forked.reason);
    saved = {
      ...restore,
      nativeSessionId: forked.threadId,
      parentSessionId: restore.nativeSessionId,
      threadId: input.threadId,
      cliVersion: forked.version,
      reportedModel: forked.model ?? restore.reportedModel,
      origin: 'forked',
      lostThreadId: null,
      interruptedRequestId: null,
      lastStop: null,
      turns: 0,
    };
  }
  const session = new CodexNativeSession(port, saved, scope, options.onCheckpoint, {
    idleMs: tuning.idleMs ?? CODEX_SESSION_IDLE_MS,
    interruptWaitMs: tuning.interruptWaitMs ?? CODEX_INTERRUPT_WAIT_MS,
  });
  await session.verify();
  return session;
}

/**
 * What a restart makes of a checkpoint whose turn was running (the H01 durable-record rule): a
 * confirmed thread is kept for the next `thread/resume` and the running message is named as not
 * completed; without one, nothing can continue. Pure: the driver applies it.
 */
export function recoverCodexCheckpoint(
  saved: CodexSessionCheckpoint,
  interruptedRequestId: string | null,
): { resume: CodexSessionCheckpoint } | { refuse: string } {
  if (saved.state === 'busy' && saved.nativeSessionId)
    return { resume: { ...saved, state: 'idle', origin: 'recovered', interruptedRequestId } };
  return {
    refuse:
      "Nectovia restarted while Codex was answering. The saved thread couldn't be confirmed, so this conversation couldn't resume. Start again.",
  };
}
