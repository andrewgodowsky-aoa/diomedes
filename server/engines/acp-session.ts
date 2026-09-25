/**
 * The kept ACP conversation (H05): one Diomedes conversation continuing one ACP
 * session across its turns, for every ACP route (Cursor and Devin today). It is
 * written once over the shared client (`acp-client.ts`) and reached through each
 * adapter's `openSession`, so it implements the same `PersistentTextAdapter`
 * contract the Claude and OpenCode sessions do, and the one RunService-backed
 * driver (`server/harness/claude-session-run.ts`) owns its turn records, replay
 * and restart recovery. Nothing here writes a run record; the driver persists
 * every checkpoint this class hands it.
 *
 * Each turn is still one owned ACP process, as on the single-turn text route.
 * What carries the conversation is the agent's own session store: the process
 * runs in a private root that belongs to the conversation and outlives the
 * turn, the ACP session id is saved durably before the prompt is sent, and the
 * next turn — including the first one after a Diomedes restart — continues it
 * with `session/load`. An agent that does not advertise `loadSession` gets a
 * fresh session every turn and the turn says so; nothing is claimed carried.
 *
 * A person's Stop sends `session/cancel`, waits a bounded time for the agent to
 * end the prompt, then ends the process tree; the checkpoint records which of
 * those happened. A permission ask or a plan the agent presents for approval is
 * a question for a person: it goes to the host's `approvals` (a Need), and the
 * answer goes back to the agent. Nothing is approved automatically; a question
 * nobody answers in time ends the turn safely.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { NativeSessionRef } from '../../shared/contract-revision.js';
import { digest } from '../harness/policy.js';
import {
  acpRejectOutcome,
  type AcpAnswer,
  type AcpKeep,
  type AcpOpenOrigin,
  type AcpProfile,
} from './acp-client.js';
import {
  contextMessage,
  type EngineAsk,
  type TextRequest,
  type TextResponse,
} from './contract.js';
import { EngineError, record, stopped, text } from './process.js';
import { readAccessOf, readScopeDigest } from './read-scope.js';

type Json = Record<string, unknown>;
const opaqueId = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

export const ACP_SESSION_ENGINES = ['cursor', 'devin'] as const;
export type AcpSessionEngine = (typeof ACP_SESSION_ENGINES)[number];

/**
 * How the saved ACP session came to be on its latest turn. `recovered`: Diomedes
 * restarted while a turn was running and the saved session id was kept for the
 * next `session/load`; the turn that was running is recorded as not completed.
 */
export const ACP_SESSION_ORIGINS = [
  'started',
  'loaded',
  'load-unsupported',
  'restarted-fresh',
  'recovered',
] as const;

export const acpCheckpointSchema = z.strictObject({
  version: z.literal(1),
  engine: z.enum(ACP_SESSION_ENGINES),
  nativeSessionId: opaqueId.nullable(),
  lineageId: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  cliVersion: z.string().min(1).max(80),
  accountRoute: z.string().min(1).max(200),
  requestedModel: z.string().min(1).max(256),
  /** The model the agent reported for the last answer, or the requested id it accepted. */
  reportedModel: z.string().min(1).max(256).nullable(),
  instructionDigest: sha,
  scopeDigest: z.string().min(1).max(80),
  state: z.enum(['idle', 'busy', 'uncertain']),
  origin: z.enum(ACP_SESSION_ORIGINS),
  /** What the agent's `initialize` advertised on the latest turn; null before the first. */
  loadSession: z.boolean().nullable(),
  /** The session id a load asked for and the agent no longer had. Only with `restarted-fresh`. */
  lostSessionId: opaqueId.nullable(),
  /** The command a restart interrupted. Only with `recovered`; never resent. */
  interruptedRequestId: z.string().min(1).max(200).nullable(),
  /** How the latest Stop ended: the agent acknowledged session/cancel, or the process was ended. */
  lastStop: z.enum(['acknowledged', 'killed']).nullable(),
  turns: z.number().int().nonnegative().max(100_000),
});
export type AcpSessionCheckpoint = z.infer<typeof acpCheckpointSchema>;

export interface AcpSessionOptions {
  observedVersion: string;
  restore?: AcpSessionCheckpoint;
  fork?: boolean;
  /** Resolve only after the host has durably saved this checkpoint. */
  onCheckpoint(checkpoint: AcpSessionCheckpoint, signal: AbortSignal): Promise<void>;
}

/**
 * What an ACP adapter lends a kept conversation: its own turn, run exactly as
 * its single-turn `generate` runs one — the same launch, workspace policy,
 * authentication, mode confirmation, model admission and read boundary — but
 * inside the conversation's root and continuing its session.
 */
export interface AcpTurnRunner {
  readonly engine: AcpSessionEngine;
  readonly profile: AcpProfile;
  readonly accountRoute: string;
  /** Whether the adapter runs a read policy on read turns; without one no tool call can be allowed. */
  readonly reads: boolean;
  /** The request checks `generate` makes before any process starts. Throws to refuse. */
  admit(input: TextRequest): void;
  /** The conversation's private root, under the adapter's own working folder. */
  root(lineageId: string): string;
  /** One turn under `keep`. Resolves with the answer and the version the CLI reported. */
  run(input: TextRequest, keep: AcpTurnKeep): Promise<{ response: TextResponse; version: string }>;
}

/** The kept session a turn runs under, plus what the adapter's turn policy reads from it. */
export interface AcpTurnKeep extends AcpKeep {
  /** Called once the session is reached and before the prompt is sent. */
  beforePrompt(): Promise<void>;
  /** Tool calls a person approved on this turn: the read policy accepts exactly these. */
  readonly approvedCalls: ReadonlySet<string>;
  /** Whether a person approved the agent's plan on this turn. */
  plans(): boolean;
}

/** How long a Stop waits for the agent to acknowledge session/cancel before the process is ended. */
export const ACP_CANCEL_WAIT_MS = 3_000;
/** Tool kinds a person may be asked to allow once. Everything else cannot be honoured on this route. */
const ASKABLE_KINDS = ['fetch', 'think'];

const continuityDetail = (
  name: string,
  origin: AcpOpenOrigin | 'recovered',
  interrupted: boolean,
): string | null => {
  const restart = interrupted
    ? 'Diomedes restarted while an earlier message was being answered; that message was not completed or resent. '
    : '';
  if (origin === 'load-unsupported')
    return `${restart}${name} does not offer to continue a saved session, so this message started a fresh ${name} session. Earlier messages in this conversation were not carried into it.`;
  if (origin === 'restarted-fresh')
    return `${restart}${name} no longer had the saved session, so this message started a fresh ${name} session. Earlier messages in this conversation were not carried into it.`;
  if (interrupted) return `${restart}This conversation continued from ${name}'s saved session.`;
  return null;
};

export class AcpNativeSession {
  private active?: {
    id: string;
    digest: string;
    promise: Promise<TextResponse>;
    controller: AbortController;
  };
  private closed = false;
  private latest: { origin: AcpOpenOrigin | 'recovered'; interrupted: boolean } | null = null;
  constructor(
    private readonly runner: AcpTurnRunner,
    private saved: AcpSessionCheckpoint,
    private readonly persist: AcpSessionOptions['onCheckpoint'],
  ) {}
  get checkpoint(): AcpSessionCheckpoint {
    return structuredClone(this.saved);
  }
  get nativeSession(): NativeSessionRef | null {
    return this.saved.nativeSessionId
      ? {
          providerId: this.runner.engine,
          lineageId: this.saved.lineageId,
          opaqueRef: this.saved.nativeSessionId,
        }
      : null;
  }
  /**
   * How the latest turn reached its session, for the person. Read on every turn
   * (`continuityPerTurn`): an agent without `loadSession` starts fresh each time,
   * and each of those turns says so.
   */
  get continuity(): { origin: string; detail: string | null } {
    const latest = this.latest ?? { origin: this.saved.origin, interrupted: false };
    return {
      origin: latest.origin,
      detail: continuityDetail(this.runner.profile.name, latest.origin, latest.interrupted),
    };
  }
  readonly continuityPerTurn = true;
  get busy(): boolean {
    return this.active !== undefined;
  }
  private async save() {
    const signal = AbortSignal.timeout(10_000);
    await this.persist(this.checkpoint, signal);
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
      throw new EngineError(
        'SESSION_MISMATCH',
        `This input does not match the ${this.runner.profile.name} session scope.`,
      );
    const requestDigest = digest(prompt);
    if (this.active?.id === input.requestId) {
      if (this.active.digest !== requestDigest)
        throw new EngineError('IDEMPOTENCY_CONFLICT', 'This request identity has different content.');
      return this.active.promise;
    }
    if (this.closed || this.saved.state !== 'idle')
      throw new EngineError(
        'RECONCILE_REQUIRED',
        `The ${this.runner.profile.name} session is closed or its last turn is uncertain.`,
        true,
      );
    if (this.active)
      throw new EngineError(
        'SESSION_BUSY',
        `${this.runner.profile.name} is still answering the previous message.`,
      );
    this.runner.admit(input);
    const controller = new AbortController();
    const promise = this.run(input, controller).finally(() => {
      if (this.active?.controller === controller) this.active = undefined;
    });
    this.active = { id: input.requestId, digest: requestDigest, promise, controller };
    return promise;
  }
  private async run(input: TextRequest, controller: AbortController): Promise<TextResponse> {
    const name = this.runner.profile.name;
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    const interrupted = this.saved.origin === 'recovered' && this.saved.interruptedRequestId !== null;
    const approvedCalls = new Set<string>();
    let planApproved = false;
    const facts: AcpKeep['facts'] = {};
    let prompted = false;
    const keep: AcpTurnKeep = {
      root: this.runner.root(this.saved.lineageId),
      ...(this.saved.nativeSessionId ? { resume: this.saved.nativeSessionId } : {}),
      cancelWaitMs: ACP_CANCEL_WAIT_MS,
      facts,
      approvedCalls,
      plans: () => planApproved,
      ask: input.approvals
        ? (method, params) =>
            askPerson(this.runner, input, method, params, signal, {
              approveCall: (id) => approvedCalls.add(id),
              approvePlan: () => {
                planApproved = true;
              },
            })
        : undefined,
      beforePrompt: async () => {
        const origin = facts.origin ?? 'started';
        this.saved = {
          ...this.saved,
          nativeSessionId: facts.sessionId ?? null,
          origin,
          loadSession: facts.loadSession ?? null,
          lostSessionId:
            origin === 'restarted-fresh' ? (this.saved.nativeSessionId ?? null) : null,
          // Saved before the prompt: a restart from here on finds this session id.
          state: 'busy',
        };
        prompted = true;
        await this.save();
      },
    };
    try {
      const { response, version } = await this.runner.run({ ...input, signal }, keep);
      if (version !== this.saved.cliVersion)
        throw new EngineError(
          'SESSION_MISMATCH',
          `${name} reported version ${version} during the turn; this conversation was opened with ${this.saved.cliVersion}.`,
          true,
        );
      this.latest = { origin: this.saved.origin, interrupted };
      this.saved = {
        ...this.saved,
        state: 'idle',
        reportedModel: response.model,
        interruptedRequestId: null,
        lastStop: null,
        turns: this.saved.turns + 1,
      };
      await this.save();
      return response;
    } catch (error) {
      if (prompted) {
        const stop = facts.stop ?? null;
        // A turn a person stopped leaves the session where the agent keeps it. Otherwise an
        // agent that can load its own record is continued from that record next time; one
        // that cannot leaves an outcome nobody can read back, which is never resumed.
        this.saved = {
          ...this.saved,
          state: stop || this.saved.loadSession ? 'idle' : 'uncertain',
          lastStop: stop,
          interruptedRequestId: null,
        };
        this.latest = { origin: this.saved.origin, interrupted };
        await this.save().catch(() => undefined);
      }
      if (signal.aborted && !(error instanceof EngineError && error.code === 'TIMEOUT'))
        throw facts.stop ? Object.assign(stopped(), { stopOutcome: facts.stop }) : stopped();
      throw error;
    }
  }
  /** Stops the running turn, if any: session/cancel, a bounded wait, then the process ends. */
  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.promise.catch(() => undefined);
  }
  /**
   * Closes the conversation's transport. There is no process between turns; a
   * running turn is stopped. The agent's session store stays in the private root
   * so a confirmed session can be explicitly resumed later.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.interrupt();
  }
}

/**
 * Put one agent request to a person, or return undefined when it is not one a
 * person is asked about (the client then declines it as the text route does).
 * A plan the agent presents for approval is always asked. A permission ask is
 * asked only on a read turn and only for a kind this route can honour once
 * allowed (`fetch`, `think`) — the read policy then accepts exactly that call.
 * Edits, commands, deletions, moves and mode switches are never asked: allowing
 * them would reach past the recorded writer, so they stay declined.
 */
function askPerson(
  runner: AcpTurnRunner,
  input: TextRequest,
  method: string,
  params: unknown,
  signal: AbortSignal,
  approve: { approveCall(id: string): void; approvePlan(): void },
): Promise<AcpAnswer> | undefined {
  const { profile } = runner;
  const approvals = input.approvals;
  if (!approvals) return undefined;
  const stop = (answer: 'expired' | 'cancelled') =>
    answer === 'expired'
      ? new EngineError(
          'APPROVAL_EXPIRED',
          `${profile.name} asked for approval and nobody answered in time, so the request was stopped. Nothing was approved.`,
          true,
        )
      : stopped();
  const ask = (question: EngineAsk, onGoAhead: () => Json, onDecline: () => Json) =>
    approvals(question, signal).then(
      (answer): AcpAnswer =>
        answer === 'go-ahead'
          ? { result: onGoAhead() }
          : answer === 'declined'
            ? { result: onDecline() }
            : { result: { outcome: { outcome: 'cancelled' } }, stop: stop(answer) },
    );
  if (profile.planMethod && method === profile.planMethod && profile.planAccepted) {
    const plan = record(params);
    const title =
      text(plan.title) ||
      text(plan.name) ||
      text(plan.overview) ||
      text(plan.plan) ||
      `${profile.name} proposed a plan`;
    return ask(
      { kind: 'plan', engine: runner.engine, title: title.slice(0, 300) },
      () => {
        approve.approvePlan();
        return profile.planAccepted!(params);
      },
      () => record(profile.declineResult?.(method, params) ?? acpRejectOutcome(params)),
    );
  }
  if (method !== 'session/request_permission' || !runner.reads || !input.readScope)
    return undefined;
  const call = record(record(params).toolCall);
  const id = text(call.toolCallId);
  const kind = text(call.kind);
  if (!id || id.length > 200 || !ASKABLE_KINDS.includes(kind)) return undefined;
  const options = Array.isArray(record(params).options)
    ? (record(params).options as unknown[]).map(record)
    : [];
  const allow = options.find(
    (option) => option.kind === 'allow_once' && typeof option.optionId === 'string',
  );
  if (!allow) return undefined;
  const url = text(record(call.rawInput).url);
  const title =
    text(call.title).slice(0, 200) ||
    (url ? `Open ${url.slice(0, 200)}` : `${profile.name} wants to use ${kind}`);
  return ask(
    { kind: 'permission', engine: runner.engine, title, toolKind: kind },
    () => {
      approve.approveCall(id);
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    },
    () => acpRejectOutcome(params),
  );
}

/**
 * Opens a kept ACP conversation: a new one, or one restored from its saved
 * checkpoint. No process starts here; the first turn starts one and continues
 * the saved session with `session/load`.
 */
export async function openAcpSession(
  runner: AcpTurnRunner,
  input: TextRequest,
  options: AcpSessionOptions,
): Promise<AcpNativeSession> {
  const name = runner.profile.name;
  if (input.accountRoute !== runner.accountRoute)
    throw new EngineError(
      'ACCOUNT_CHANGED',
      `The selected ${name} account route changed. Recheck before sending.`,
      false,
      'provider-auth',
    );
  if (options.fork)
    throw new EngineError('COMMAND_UNSUPPORTED', `${name} conversations cannot be forked.`);
  const scope = input.readScope;
  if (scope && readAccessOf(scope) === 'project')
    throw new EngineError(
      'POLICY_MISMATCH',
      `${name} cannot read the whole project folder, because its reads cannot be checked before they run. Choose the documents to include instead.`,
      false,
      'dispatch',
    );
  const restore = options.restore ? acpCheckpointSchema.parse(options.restore) : undefined;
  const scopeDigest = readScopeDigest(scope);
  if (restore) {
    if (
      restore.engine !== runner.engine ||
      restore.projectId !== input.projectId ||
      restore.threadId !== input.threadId ||
      restore.requestedModel !== input.model ||
      restore.accountRoute !== input.accountRoute ||
      restore.instructionDigest !== digest(input.instructions) ||
      restore.scopeDigest !== scopeDigest
    )
      throw new EngineError(
        'SESSION_MISMATCH',
        `The saved ${name} session belongs to a different scope.`,
      );
    if (restore.cliVersion !== options.observedVersion)
      throw new EngineError(
        'SESSION_MISMATCH',
        `This ${name} session was saved by ${name} ${restore.cliVersion}; ${options.observedVersion} is installed now. Start a new conversation.`,
      );
    if (restore.state !== 'idle')
      throw new EngineError(
        'RECONCILE_REQUIRED',
        `The saved ${name} turn outcome is uncertain.`,
        true,
      );
    if (!restore.nativeSessionId)
      throw new EngineError(
        'SESSION_INVALID',
        `This conversation has no confirmed ${name} session.`,
      );
  }
  const saved: AcpSessionCheckpoint = restore ?? {
    version: 1,
    engine: runner.engine,
    nativeSessionId: null,
    lineageId: randomUUID(),
    projectId: input.projectId,
    threadId: input.threadId,
    cliVersion: options.observedVersion,
    accountRoute: input.accountRoute,
    requestedModel: input.model,
    reportedModel: null,
    instructionDigest: digest(input.instructions),
    scopeDigest,
    state: 'idle',
    origin: 'started',
    loadSession: null,
    lostSessionId: null,
    interruptedRequestId: null,
    lastStop: null,
    turns: 0,
  };
  return new AcpNativeSession(runner, saved, options.onCheckpoint);
}

/** The conversation's private root: under the adapter's folder, named by its lineage only. */
export const acpSessionRoot = (cwd: string, engine: AcpSessionEngine, lineageId: string) => {
  if (!z.string().uuid().safeParse(lineageId).success)
    throw new EngineError('SESSION_INVALID', 'The saved conversation lineage is malformed.');
  return path.join(cwd, `.diomedes-${engine}-sessions`, lineageId);
};

/**
 * What a restart makes of a checkpoint whose turn was running (H05, the H01
 * durable-record rule): a session the agent can load is kept for the next
 * `session/load` and the running command is named as not completed; anything
 * else cannot be continued and says so. Pure: the driver applies it.
 */
export function recoverAcpCheckpoint(
  saved: AcpSessionCheckpoint,
  interruptedRequestId: string | null,
): { resume: AcpSessionCheckpoint } | { refuse: string } {
  const name = saved.engine === 'cursor' ? 'Cursor' : 'Devin';
  if (saved.state === 'busy' && saved.nativeSessionId && saved.loadSession === true)
    return {
      resume: {
        ...saved,
        state: 'idle',
        origin: 'recovered',
        interruptedRequestId,
      },
    };
  return {
    refuse:
      saved.loadSession === false
        ? `Diomedes restarted while ${name} was answering, and ${name} cannot continue a saved session, so this conversation couldn't resume. Start again.`
        : `Diomedes restarted while ${name} was answering, and no ${name} session was confirmed to continue, so this conversation couldn't resume. Start again.`,
  };
}
