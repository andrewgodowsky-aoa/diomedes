/**
 * The OpenCode native session transport (H04): one `opencode serve` process
 * kept alive across the turns of a Diomedes conversation, driving one OpenCode
 * session whose id is saved durably through the host's native checkpoint.
 *
 * It implements the same `PersistentTextAdapter` contract the Claude
 * stream-json session does (`server/engines/contract.ts`), so the one
 * RunService-backed driver (`server/harness/claude-session-run.ts`) owns turn
 * records, replay, fork lineage and recovery for both. Nothing here writes a
 * run record; the driver persists every checkpoint this class hands it.
 *
 * What survives a restart is OpenCode's own session store. The isolated server
 * keeps the person's own `XDG_DATA_HOME`, which is where opencode v1.18.4
 * keeps sessions, so a later server can find a saved session by its id. When
 * OpenCode answers that the id no longer exists, the next message starts a
 * fresh session and the checkpoint says so (`origin: 'restarted-fresh'`); any
 * other failure to reach it is a failure, never a silent fresh start.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SetupStage } from '../../shared/engines.js';
import type { NativeSessionRef } from '../../shared/contract-revision.js';
import { digest } from '../harness/policy.js';
import { contextMessage, type TextRequest, type TextResponse } from './contract.js';
import { EngineError, stopped, text } from './process.js';
import { readAccessOf, readScopeDigest, type ReadScope } from './read-scope.js';

type Json = Record<string, unknown>;
const opaqueId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * How the saved native session came to be. `restarted-fresh` is the truthful
 * record of a resume that could not be honoured: OpenCode no longer had the
 * session, so a new one was started and nothing earlier was carried into it.
 */
export const OPENCODE_SESSION_ORIGINS = ['started', 'resumed', 'restarted-fresh', 'forked'] as const;

export const openCodeCheckpointSchema = z.strictObject({
  version: z.literal(1),
  engine: z.literal('opencode'),
  nativeSessionId: opaqueId.nullable(),
  lineageId: z.string().uuid(),
  parentSessionId: opaqueId.nullable(),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  cliVersion: z.string().min(1).max(80),
  accountRoute: z.string().min(1).max(200),
  requestedModel: z.string().min(1).max(200),
  /** `providerID/modelID` exactly as OpenCode reported it on the last answer. */
  reportedModel: z.string().min(1).max(200).nullable(),
  instructionDigest: sha,
  scopeDigest: z.string().min(1).max(80),
  state: z.enum(['idle', 'busy', 'uncertain']),
  origin: z.enum(OPENCODE_SESSION_ORIGINS),
  /** The session id a resume asked for and OpenCode no longer had. Only with `restarted-fresh`. */
  lostSessionId: opaqueId.nullable(),
  /** The last assistant message OpenCode completed in this session: a fork point. */
  lastAssistantMessageId: opaqueId.nullable(),
  turns: z.number().int().nonnegative().max(100_000),
});
export type OpenCodeSessionCheckpoint = z.infer<typeof openCodeCheckpointSchema>;

export interface OpenCodeSessionOptions {
  observedVersion: string;
  restore?: OpenCodeSessionCheckpoint;
  fork?: boolean;
  /** Resolve only after the host has durably saved this checkpoint. */
  onCheckpoint(checkpoint: OpenCodeSessionCheckpoint, signal: AbortSignal): Promise<void>;
}

/** The server a session runs on. Opaque to the session beyond what it passes back. */
export interface OpenCodeServer {
  base: string;
  auth: string;
  directory?: string;
}
/**
 * What the adapter lends a session: its own launch, request, admission and
 * stream-reading code, so a kept session holds exactly the boundary a single
 * turn holds. Supplied by `OpenCodeAdapter.openSession`; never by a caller.
 */
export interface OpenCodeTransport<S extends OpenCodeServer = OpenCodeServer> {
  start(scope?: ReadScope): Promise<S>;
  stop(server: S, primary?: unknown): Promise<void>;
  request(
    server: S,
    route: string,
    init: RequestInit,
    signal: AbortSignal,
    stage: SetupStage,
  ): Promise<Response>;
  json(response: Response, stage: SetupStage): Promise<Json>;
  admitModel(server: S, signal: AbortSignal, model: string): Promise<void>;
  sessionBody(input: TextRequest, selection: Selection, scope?: ReadScope): Json;
  promptBody(input: TextRequest, selection: Selection, scope: ReadScope | undefined, prompt: string): Json;
  readTurn(
    eventResponse: Response,
    turn: {
      sessionId: string;
      selection: Selection;
      input: TextRequest;
      scope?: ReadScope;
      earlier?: ReadonlySet<string>;
    },
  ): Promise<{ text: string; assistantMessageId: string; reportedModel: string }>;
  /** Runs `work` under the request budget and the caller's signal, stamping failures with `stage`. */
  bounded<T>(
    signal: AbortSignal | undefined,
    stage: () => SetupStage,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  parseSelection(model: string): Selection;
  accountRoute: string;
}
type Selection = { providerID: string; modelID: string };

/** How long an abort is given to reach OpenCode, and how long idle is waited for after it. */
const ABORT_MS = 3_000;
const SETTLE_MS = 3_000;

const sessionIdOf = (value: Json) => text(value.id) || text(value.sessionID);

/**
 * The one sentence a person reads when a resume could not be honoured. It names
 * what happened and what it means; it never claims the earlier turns went along.
 */
export const RESTARTED_FRESH_DETAIL =
  'OpenCode no longer had the saved session, so this message started a fresh OpenCode session. Earlier messages in this conversation were not carried into it.';

export class OpenCodeNativeSession<S extends OpenCodeServer = OpenCodeServer> {
  private active?: {
    id: string;
    digest: string;
    promise: Promise<TextResponse>;
    controller: AbortController;
  };
  private closing?: Promise<void>;
  private closed = false;
  /** Assistant messages this process has seen completed, so a later turn never reads them as its own. */
  private readonly answered = new Set<string>();
  constructor(
    private readonly transport: OpenCodeTransport<S>,
    private readonly server: S,
    private saved: OpenCodeSessionCheckpoint,
    private readonly scope: ReadScope | undefined,
    private readonly persist: OpenCodeSessionOptions['onCheckpoint'],
  ) {
    if (saved.lastAssistantMessageId) this.answered.add(saved.lastAssistantMessageId);
  }
  get checkpoint(): OpenCodeSessionCheckpoint {
    return structuredClone(this.saved);
  }
  get nativeSession(): NativeSessionRef | null {
    return this.saved.nativeSessionId
      ? { providerId: 'opencode', lineageId: this.saved.lineageId, opaqueRef: this.saved.nativeSessionId }
      : null;
  }
  /**
   * How this open reached its session, for the person: null when it simply
   * continued or started one, and a sentence when a resume could not be honoured.
   */
  get continuity(): { origin: OpenCodeSessionCheckpoint['origin']; detail: string | null } {
    return {
      origin: this.saved.origin,
      detail: this.saved.origin === 'restarted-fresh' ? RESTARTED_FRESH_DETAIL : null,
    };
  }
  /** Whether a turn is running now. A follow-up while it is must wait; the driver queues it. */
  get busy(): boolean {
    return this.active !== undefined;
  }
  private async save() {
    // A stuck host persistence callback must not keep a stop or a shutdown pending forever.
    const signal = AbortSignal.timeout(10_000);
    await this.persist(this.checkpoint, signal);
  }
  private route(suffix = '') {
    return `/session/${encodeURIComponent(this.saved.nativeSessionId!)}${suffix}`;
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
      throw new EngineError('SESSION_MISMATCH', 'This input does not match the OpenCode session scope.');
    const requestDigest = digest(prompt);
    if (this.active?.id === input.requestId) {
      if (this.active.digest !== requestDigest)
        throw new EngineError('IDEMPOTENCY_CONFLICT', 'This request identity has different content.');
      return this.active.promise;
    }
    if (this.closed || this.saved.state === 'uncertain' || !this.saved.nativeSessionId)
      throw new EngineError('RECONCILE_REQUIRED', 'The OpenCode session is closed or uncertain.', true);
    if (this.active)
      throw new EngineError('SESSION_BUSY', 'OpenCode is still answering the previous message.');
    const controller = new AbortController();
    const promise = this.run(input, prompt, controller).finally(() => {
      if (this.active?.controller === controller) this.active = undefined;
    });
    this.active = { id: input.requestId, digest: requestDigest, promise, controller };
    return promise;
  }
  private async run(input: TextRequest, prompt: string, controller: AbortController): Promise<TextResponse> {
    const selection = this.transport.parseSelection(input.model);
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    this.saved = { ...this.saved, state: 'busy' };
    await this.save();
    let stage: SetupStage = 'model-list';
    let eventResponse: Response | undefined;
    try {
      const result = await this.transport.bounded(
        signal,
        () => stage,
        async (bounded) => {
          await this.transport.admitModel(this.server, bounded, input.model);
          stage = 'stream';
          eventResponse = await this.transport.request(
            this.server,
            '/event',
            { headers: { Accept: 'text/event-stream' } },
            bounded,
            'stream',
          );
          stage = 'dispatch';
          await this.transport.request(
            this.server,
            this.route('/prompt_async'),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(this.transport.promptBody(input, selection, this.scope, prompt)),
            },
            bounded,
            'dispatch',
          );
          stage = 'stream';
          return this.transport.readTurn(eventResponse, {
            sessionId: this.saved.nativeSessionId!,
            selection,
            input,
            scope: this.scope,
            earlier: this.answered,
          });
        },
      );
      this.answered.add(result.assistantMessageId);
      this.saved = {
        ...this.saved,
        state: 'idle',
        reportedModel: result.reportedModel,
        lastAssistantMessageId: result.assistantMessageId,
        turns: this.saved.turns + 1,
      };
      await this.save();
      return {
        text: result.text,
        model: input.model,
        version: this.saved.cliVersion,
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
      };
    } catch (error) {
      // Nothing is left running in OpenCode on Diomedes' behalf: the turn is
      // aborted there, then idle is confirmed rather than assumed. Only a
      // confirmed idle session stays resumable.
      const idle = stage === 'model-list' ? true : await this.settle();
      this.saved = { ...this.saved, state: idle ? 'idle' : 'uncertain' };
      await this.save().catch(() => undefined);
      if (signal.aborted && !(error instanceof EngineError && error.code === 'TIMEOUT')) throw stopped();
      throw error;
    } finally {
      await eventResponse?.body?.cancel().catch(() => {
        /* The body is already bounded and no longer needed. */
      });
    }
  }
  /** Aborts the session's running work in OpenCode and reports whether it then read as idle. */
  private async settle(): Promise<boolean> {
    try {
      await this.transport.request(
        this.server,
        this.route('/abort'),
        { method: 'POST' },
        AbortSignal.timeout(ABORT_MS),
        'cleanup',
      );
    } catch {
      return false;
    }
    const until = Date.now() + SETTLE_MS;
    for (;;) {
      try {
        const status = await this.transport.json(
          await this.transport.request(this.server, '/session/status', {}, AbortSignal.timeout(ABORT_MS), 'cleanup'),
          'cleanup',
        );
        // opencode lists only sessions that are doing something; absent is idle.
        const own = status[this.saved.nativeSessionId!] as Json | undefined;
        if (!own || text(own.type) === 'idle') return true;
      } catch {
        return false;
      }
      if (Date.now() > until) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  /** Stops the running turn, if any. The session itself stays open and resumable. */
  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.promise.catch(() => undefined);
  }
  /**
   * Ends the owned server. The OpenCode session is kept in OpenCode's own
   * store, so a known idle session can be explicitly resumed later.
   */
  close(reason?: unknown): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.active?.controller.abort(reason);
      await this.active?.promise.catch(() => undefined);
      await this.transport.stop(this.server, reason);
    })();
    return this.closing;
  }
}

/**
 * Opens (or reopens) the session a conversation runs on. Fresh, resumed, or
 * forked from a saved idle session; a resume OpenCode cannot honour becomes a
 * fresh session that says so. Nothing is dispatched to a model here.
 */
export async function openOpenCodeSession<S extends OpenCodeServer>(
  transport: OpenCodeTransport<S>,
  input: TextRequest,
  options: OpenCodeSessionOptions,
): Promise<OpenCodeNativeSession<S>> {
  if (input.accountRoute !== transport.accountRoute)
    throw new EngineError(
      'ACCOUNT_CHANGED',
      'The selected OpenCode account route changed. Recheck before sending.',
      false,
      'provider-auth',
    );
  const selection = transport.parseSelection(input.model);
  const scope = input.readScope;
  if (scope && readAccessOf(scope) === 'project')
    throw new EngineError(
      'POLICY_MISMATCH',
      'OpenCode cannot read the whole project folder, because its reads cannot be checked before they run. Choose the documents to include instead.',
      false,
      'dispatch',
    );
  const restore = options.restore ? openCodeCheckpointSchema.parse(options.restore) : undefined;
  const scopeDigest = readScopeDigest(scope);
  if (options.fork && !restore)
    throw new EngineError('SESSION_INVALID', 'A fork needs a saved OpenCode session to start from.');
  if (restore) {
    if (
      restore.projectId !== input.projectId ||
      restore.threadId !== input.threadId ||
      restore.requestedModel !== input.model ||
      restore.accountRoute !== input.accountRoute ||
      restore.instructionDigest !== digest(input.instructions) ||
      restore.scopeDigest !== scopeDigest
    )
      throw new EngineError('SESSION_MISMATCH', 'The saved OpenCode session belongs to a different scope.');
    if (restore.cliVersion !== options.observedVersion)
      throw new EngineError(
        'SESSION_MISMATCH',
        `This OpenCode session was saved by OpenCode ${restore.cliVersion}; ${options.observedVersion} is installed now. Start a new conversation.`,
      );
    if (restore.state !== 'idle')
      throw new EngineError('RECONCILE_REQUIRED', 'The saved OpenCode turn outcome is uncertain.', true);
    if (!restore.nativeSessionId)
      throw new EngineError('SESSION_INVALID', 'This conversation has no confirmed OpenCode session.');
  }
  const base: OpenCodeSessionCheckpoint = {
    version: 1,
    engine: 'opencode',
    nativeSessionId: null,
    lineageId: restore?.lineageId ?? randomUUID(),
    parentSessionId: null,
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
    lostSessionId: null,
    lastAssistantMessageId: null,
    turns: 0,
  };
  const server = await transport.start(scope);
  let stage: SetupStage = 'model-list';
  try {
    const saved = await transport.bounded(undefined, () => stage, async (signal) => {
      await transport.admitModel(server, signal, input.model);
      stage = 'dispatch';
      const create = async () => {
        const created = await transport.json(
          await transport.request(
            server,
            '/session',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(transport.sessionBody(input, selection, scope)),
            },
            signal,
            'dispatch',
          ),
          'dispatch',
        );
        const id = sessionIdOf(created);
        if (!opaqueId.safeParse(id).success)
          throw new EngineError('PROTOCOL_ERROR', 'OpenCode did not return a usable session id.', true, 'dispatch');
        return id;
      };
      if (!restore) return { ...base, nativeSessionId: await create() };
      const sourceId = restore.nativeSessionId!;
      const found = await lookup(transport, server, sourceId, signal);
      if (options.fork) {
        if (!found)
          throw new EngineError(
            'SESSION_INVALID',
            'OpenCode no longer has the session this conversation would fork from, so no fork was started.',
          );
        let forked: Json;
        try {
          forked = await transport.json(
            await transport.request(
              server,
              `/session/${encodeURIComponent(sourceId)}/fork`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // No message id: the fork keeps every message the source holds.
                body: JSON.stringify({}),
              },
              signal,
              'dispatch',
            ),
            'dispatch',
          );
        } catch (error) {
          if (error instanceof EngineError && error.code === 'NOT_FOUND')
            throw new EngineError(
              'COMMAND_UNSUPPORTED',
              'This OpenCode build did not accept a fork of that session, so no fork was started.',
            );
          throw error;
        }
        const id = sessionIdOf(forked);
        if (!opaqueId.safeParse(id).success || id === sourceId)
          throw new EngineError('PROTOCOL_ERROR', 'OpenCode did not return a new forked session id.', true, 'dispatch');
        return {
          ...base,
          nativeSessionId: id,
          parentSessionId: sourceId,
          origin: 'forked' as const,
          reportedModel: restore.reportedModel,
          lastAssistantMessageId: restore.lastAssistantMessageId,
        };
      }
      if (found)
        return {
          ...restore,
          cliVersion: options.observedVersion,
          origin: 'resumed' as const,
          lostSessionId: null,
        };
      return {
        ...base,
        nativeSessionId: await create(),
        origin: 'restarted-fresh' as const,
        lostSessionId: sourceId,
      };
    });
    return new OpenCodeNativeSession(transport, server, openCodeCheckpointSchema.parse(saved), scope, options.onCheckpoint);
  } catch (error) {
    await transport.stop(server, error).catch(() => undefined);
    throw error;
  }
}

/** Whether OpenCode still has a session. Only a clear "not found" is false; anything else throws. */
async function lookup<S extends OpenCodeServer>(
  transport: OpenCodeTransport<S>,
  server: S,
  id: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const found = await transport.json(
      await transport.request(server, `/session/${encodeURIComponent(id)}`, {}, signal, 'dispatch'),
      'dispatch',
    );
    return sessionIdOf(found) === id;
  } catch (error) {
    if (error instanceof EngineError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}
