/**
 * The exporter port and its bounded queue (PH-00 contract 2.5, 4.6-4.8).
 *
 * `enqueue` is synchronous and O(1) apart from building one small event: it never awaits, never
 * throws and never blocks the run that produced the observation. A slow or failing sink costs
 * telemetry, never work: the queue is capped in events, bytes and age, and every drop is counted
 * by reason in `health()`, which stays on this machine.
 *
 * Every event's scope is rechecked when it is enqueued and again immediately before its batch is
 * sent. A scope that fails (sign-out, another person, a workspace switch, an entitlement that
 * ended, an organization no longer internal) has its queued events dropped, never relabelled.
 *
 * Sinks: memory (the exact batch bodies a transport would send, without `api_key`) and the
 * PostHog transport (PH-02), which alone adds the key. A paid sink also has a gate: funding and a
 * daily budget, both off unless the operator sets them. A failed send is retried with backoff at
 * most three times, ahead of anything newer; three failures in a row pause export.
 */
import type { Observation } from '../../shared/observability.js';
import { isCalendarDay, type ObservationDenial, type ObservationScope, type ScopeRecheck } from './eligibility.js';
import { encodeEvent, toWireEvent } from './wire.js';

export type DropReason =
  | 'observation-off'
  | 'oversized'
  | 'queue-full'
  | 'scope-ended'
  | 'expired'
  | 'rejected'
  | 'retries-exhausted'
  | 'retry-after-too-long'
  | 'budget'
  | 'funding'
  | 'shutdown'
  | 'encode-failed';
export const DROP_REASONS: readonly DropReason[] = Object.freeze([
  'observation-off',
  'oversized',
  'queue-full',
  'scope-ended',
  'expired',
  'rejected',
  'retries-exhausted',
  'retry-after-too-long',
  'budget',
  'funding',
  'shutdown',
  'encode-failed',
]);

export type SinkFailure = 'network' | 'timeout' | 'http-429' | 'http-4xx' | 'http-5xx';

export interface ObservationHealth {
  readonly state: 'off' | 'memory' | 'exporting' | 'paused' | 'disabled:funding' | 'disabled:budget';
  readonly enqueued: number;
  readonly exported: number;
  readonly dropped: Readonly<Record<DropReason, number>>;
  readonly denied: Readonly<Partial<Record<ObservationDenial, number>>>;
  readonly queued: number;
  readonly queuedBytes: number;
  readonly lastFailure: SinkFailure | null;
}

export interface ObservationExporter {
  /** Synchronous; never throws, never awaits I/O, never blocks the caller. */
  enqueue(observation: Observation, scope: ObservationScope): void;
  /** Resolves by the deadline even when the sink hangs. */
  flush(deadlineMs?: number): Promise<void>;
  /** Drops queued events whose scope matches; returns how many. */
  discard(ended: (scope: ObservationScope) => boolean, reason: DropReason): number;
  /** Local only; never enqueued as an observation. */
  health(): ObservationHealth;
  close(deadlineMs?: number): Promise<void>;
}

/** What a sink answers for one batch body. */
export type SinkResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: SinkFailure; readonly retryAfterMs: number | null };

export interface ObservationSink {
  readonly kind: 'memory' | 'posthog';
  send(body: string, signal: AbortSignal): Promise<SinkResult>;
}

/** The exact UTF-8 bodies a transport would send, minus `api_key`. For tests and `memory` mode. */
export class MemoryObservationSink implements ObservationSink {
  readonly kind = 'memory' as const;
  readonly batches: string[] = [];
  /** Bodies kept; the oldest is forgotten first, so `memory` mode stays bounded. */
  constructor(private readonly limit = 1_000) {}
  async send(body: string): Promise<SinkResult> {
    this.batches.push(body);
    while (this.batches.length > this.limit) this.batches.shift();
    return { ok: true };
  }
}

/** What the exporter needs from the scope registry. */
export interface ScopeRecheckPort {
  recheck(scope: ObservationScope): ScopeRecheck;
  denials(): Readonly<Partial<Record<ObservationDenial, number>>>;
}

export interface ExporterLimits {
  readonly eventBytes: number;
  readonly queueEvents: number;
  readonly queueBytes: number;
  readonly maxAgeMs: number;
  readonly batchEvents: number;
  readonly batchBytes: number;
  readonly flushEveryMs: number;
  readonly sendDeadlineMs: number;
  readonly shutdownMs: number;
  /** Sends of one batch, the first included. */
  readonly attempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  /** A longer `Retry-After` drops the batch rather than holding the queue. */
  readonly retryAfterCapMs: number;
  /** Consecutive failed sends that pause export. */
  readonly circuitFailures: number;
  readonly pauseMs: number;
}
export const EXPORTER_LIMITS: ExporterLimits = Object.freeze({
  eventBytes: 8 * 1024,
  queueEvents: 1_000,
  queueBytes: 8 * 1024 * 1024,
  maxAgeMs: 60 * 60 * 1000,
  batchEvents: 50,
  batchBytes: 256 * 1024,
  flushEveryMs: 10_000,
  sendDeadlineMs: 5_000,
  shutdownMs: 2_000,
  attempts: 3,
  backoffBaseMs: 1_000,
  backoffCapMs: 30_000,
  retryAfterCapMs: 60_000,
  circuitFailures: 3,
  pauseMs: 5 * 60 * 1000,
});

/**
 * What a paid destination may spend (PH-02). Absent for the memory sink. `fundedUntil` is the last
 * UTC day the vendor benefit is known to cover; null or past sends nothing and keeps nothing.
 * `dailyEvents` is the pilot's cap per UTC day; zero, the default, sends nothing.
 */
export interface ExportGate {
  readonly fundedUntil: string | null;
  readonly dailyEvents: number;
}

const emptyDrops = (): Record<DropReason, number> =>
  Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>;

/** Observation is off: nothing is built, queued or sent. Counts what it was offered. */
export class NoopObservationExporter implements ObservationExporter {
  private readonly dropped = emptyDrops();
  enqueue(): void {
    this.dropped['observation-off'] += 1;
  }
  async flush(): Promise<void> {}
  discard(): number {
    return 0;
  }
  health(): ObservationHealth {
    return {
      state: 'off',
      enqueued: 0,
      exported: 0,
      dropped: { ...this.dropped },
      denied: {},
      queued: 0,
      queuedBytes: 0,
      lastFailure: null,
    };
  }
  async close(): Promise<void> {}
}

interface Queued {
  readonly text: string;
  readonly bytes: number;
  readonly scope: ObservationScope;
  readonly enqueuedAt: number;
}

/** A batch that failed and waits to be sent again, ahead of anything newer. */
interface InFlight {
  batch: Queued[];
  readonly attempts: number;
  readonly notBefore: number;
}

export interface BoundedExporterOptions {
  readonly sink: ObservationSink;
  readonly scopes: ScopeRecheckPort;
  readonly clock?: () => number;
  readonly limits?: Partial<ExporterLimits>;
  /** A periodic flush, unref'd. Tests turn it off and flush by hand. */
  readonly timer?: boolean;
  /** Funding and the daily budget. Required for a paid sink; absent for memory. */
  readonly gate?: ExportGate | null;
  /** The backoff jitter's source, in [0, 1). Tests fix it. */
  readonly random?: () => number;
}

/** `{"batch":[` + events + `]}`: the bytes `encodeBatch` would produce for the same events. */
const BATCH_OVERHEAD = Buffer.byteLength('{"batch":[]}');
const DAY_MS = 86_400_000;

export class BoundedObservationExporter implements ObservationExporter {
  protected readonly limits: ExporterLimits;
  protected readonly clock: () => number;
  protected readonly queue: Queued[] = [];
  protected queuedBytes = 0;
  protected readonly dropped = emptyDrops();
  protected enqueued = 0;
  protected exported = 0;
  protected lastFailure: SinkFailure | null = null;
  protected closed = false;
  private inflight: InFlight | null = null;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private budgetDay = '';
  private sentToday = 0;
  private flushing: Promise<void> | null = null;
  private kicked = false;
  private readonly interval: ReturnType<typeof setInterval> | null;

  constructor(protected readonly options: BoundedExporterOptions) {
    this.limits = { ...EXPORTER_LIMITS, ...options.limits };
    this.clock = options.clock ?? Date.now;
    this.interval =
      options.timer === false ? null : setInterval(() => void this.flush().catch(() => undefined), this.limits.flushEveryMs);
    this.interval?.unref?.();
  }

  enqueue(observation: Observation, scope: ObservationScope): void {
    try {
      if (this.closed) return this.drop('shutdown');
      // Unfunded or over today's budget: nothing is kept for later, so nothing is backfilled.
      if (this.unfunded()) return this.drop('funding');
      if (this.budgetLeft() <= 0) return this.drop('budget');
      if (!this.live(scope)) return this.drop('scope-ended');
      let text: string;
      try {
        text = encodeEvent(toWireEvent(observation));
      } catch {
        return this.drop('encode-failed');
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      // Dropped whole, never truncated: a cut event could end mid-value.
      if (bytes > this.limits.eventBytes) return this.drop('oversized');
      // The caps count a batch waiting to be sent again: it is still held on this machine.
      const waiting = this.waiting();
      if (
        this.queue.length + waiting.events >= this.limits.queueEvents ||
        this.queuedBytes + waiting.bytes + bytes > this.limits.queueBytes
      )
        return this.drop('queue-full');
      this.queue.push({ text, bytes, scope, enqueuedAt: this.clock() });
      this.queuedBytes += bytes;
      this.enqueued += 1;
      if (this.queue.length >= this.limits.batchEvents) this.kick();
    } catch {
      this.drop('encode-failed');
    }
  }

  flush(deadlineMs = this.limits.sendDeadlineMs): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain(deadlineMs)
      .catch(() => undefined)
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  discard(ended: (scope: ObservationScope) => boolean, reason: DropReason): number {
    const matches = (item: Queued) => {
      try {
        return ended(item.scope);
      } catch {
        return true;
      }
    };
    let removed = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (!matches(item)) continue;
      this.queue.splice(index, 1);
      this.queuedBytes -= item.bytes;
      this.dropped[reason] += 1;
      removed += 1;
    }
    if (this.inflight) {
      const kept = this.inflight.batch.filter((item) => !matches(item));
      const gone = this.inflight.batch.length - kept.length;
      this.dropped[reason] += gone;
      removed += gone;
      this.inflight.batch = kept;
      if (kept.length === 0) this.inflight = null;
    }
    return removed;
  }

  health(): ObservationHealth {
    const waiting = this.waiting();
    return {
      state: this.state(),
      enqueued: this.enqueued,
      exported: this.exported,
      dropped: { ...this.dropped },
      denied: this.options.scopes.denials(),
      queued: this.queue.length + waiting.events,
      queuedBytes: this.queuedBytes + waiting.bytes,
      lastFailure: this.lastFailure,
    };
  }

  async close(deadlineMs = this.limits.shutdownMs): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, deadlineMs);
      timer.unref?.();
    });
    await Promise.race([this.flush(deadlineMs), deadline]);
    this.closed = true;
    this.discard(() => true, 'shutdown');
  }

  protected state(): ObservationHealth['state'] {
    if (this.unfunded()) return 'disabled:funding';
    if (this.options.gate && this.budgetLeft() <= 0) return 'disabled:budget';
    if (this.pausedUntil > this.clock()) return 'paused';
    return this.options.sink.kind === 'memory' ? 'memory' : 'exporting';
  }

  protected drop(reason: DropReason, count = 1) {
    this.dropped[reason] += count;
  }

  protected live(scope: ObservationScope) {
    try {
      return this.options.scopes.recheck(scope).live;
    } catch {
      return false;
    }
  }

  /** Funding ends at the close of its last UTC day. No gate: a memory sink, never funded or charged. */
  private unfunded(): boolean {
    const gate = this.options.gate;
    if (!gate) return false;
    if (!gate.fundedUntil || !isCalendarDay(gate.fundedUntil)) return true;
    const end = Date.parse(`${gate.fundedUntil}T00:00:00.000Z`) + DAY_MS;
    return !(this.clock() < end);
  }

  /** Events this process may still send today (UTC). */
  private budgetLeft(): number {
    const gate = this.options.gate;
    if (!gate) return Number.POSITIVE_INFINITY;
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    if (today !== this.budgetDay) {
      this.budgetDay = today;
      this.sentToday = 0;
    }
    return Math.max(0, gate.dailyEvents - this.sentToday);
  }

  /** Expire, recheck, then send: a waiting retry first, then new batches, until empty or the deadline. */
  protected async drain(deadlineMs: number): Promise<void> {
    const started = this.clock();
    if (this.unfunded()) {
      this.discard(() => true, 'funding');
      return;
    }
    this.expire();
    this.dropEnded();
    while (this.clock() - started < deadlineMs) {
      if (this.pausedUntil > this.clock()) break;
      // A batch waiting for a retry ages like the queue: past the limit it is dropped, never sent late.
      this.expire();
      let entry = this.inflight;
      if (entry) {
        if (this.clock() < entry.notBefore) break;
        // Rechecked again before it is sent again.
        const checked = new Map<ObservationScope, boolean>();
        const kept = entry.batch.filter((item) => {
          let live = checked.get(item.scope);
          if (live === undefined) checked.set(item.scope, (live = this.live(item.scope)));
          if (!live) this.dropped['scope-ended'] += 1;
          return live;
        });
        if (kept.length === 0) {
          this.inflight = null;
          continue;
        }
        entry.batch = kept;
      } else {
        if (this.queue.length === 0) break;
        const left = this.budgetLeft();
        if (left <= 0) {
          this.discard(() => true, 'budget');
          break;
        }
        const batch = this.takeBatch(Math.min(left, this.limits.batchEvents));
        if (batch.length === 0) continue;
        // Counted when first sent, so an answer that never came back still counts against the cap.
        this.sentToday += batch.length;
        entry = { batch, attempts: 0, notBefore: 0 };
        this.inflight = entry;
      }
      const body = `{"batch":[${entry.batch.map((item) => item.text).join(',')}]}`;
      const result = await this.send(body, Math.max(1, deadlineMs - (this.clock() - started)));
      this.settle(entry, result);
    }
  }

  /** One send's answer: done, dropped, or held to be sent again after a backoff. */
  protected settle(entry: InFlight, result: SinkResult) {
    if (result.ok) {
      this.exported += entry.batch.length;
      this.consecutiveFailures = 0;
      this.inflight = null;
      return;
    }
    this.lastFailure = result.failure;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.limits.circuitFailures) {
      this.pausedUntil = this.clock() + this.limits.pauseMs;
      this.consecutiveFailures = 0;
    }
    const attempts = entry.attempts + 1;
    const give = (reason: DropReason) => {
      this.drop(reason, entry.batch.length);
      this.inflight = null;
    };
    if (result.failure === 'http-4xx') return give('rejected');
    if (result.retryAfterMs !== null && result.retryAfterMs > this.limits.retryAfterCapMs) return give('retry-after-too-long');
    if (attempts >= this.limits.attempts) return give('retries-exhausted');
    const jitter = 0.5 + 0.5 * Math.min(1, Math.max(0, (this.options.random ?? Math.random)()));
    const backoff = Math.min(this.limits.backoffCapMs, this.limits.backoffBaseMs * 2 ** (attempts - 1)) * jitter;
    this.inflight = { batch: entry.batch, attempts, notBefore: this.clock() + (result.retryAfterMs ?? backoff) };
  }

  protected async send(body: string, deadlineMs: number): Promise<SinkResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SinkResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, failure: 'timeout', retryAfterMs: null });
      }, deadlineMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        this.options.sink.send(body, controller.signal).catch((): SinkResult => ({ ok: false, failure: 'network', retryAfterMs: null })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Oldest first, up to the event and byte caps; every event's scope rechecked just before it goes. */
  protected takeBatch(maxEvents: number): Queued[] {
    const batch: Queued[] = [];
    let bytes = BATCH_OVERHEAD;
    const checked = new Map<ObservationScope, boolean>();
    while (this.queue.length > 0 && batch.length < maxEvents) {
      const next = this.queue[0];
      const separator = batch.length > 0 ? 1 : 0;
      if (batch.length > 0 && bytes + separator + next.bytes > this.limits.batchBytes) break;
      this.queue.shift();
      this.queuedBytes -= next.bytes;
      let live = checked.get(next.scope);
      if (live === undefined) checked.set(next.scope, (live = this.live(next.scope)));
      if (!live) {
        this.dropped['scope-ended'] += 1;
        continue;
      }
      batch.push(next);
      bytes += separator + next.bytes;
    }
    return batch;
  }

  /** Past the age limit, whether queued or waiting to be sent again: dropped, never sent late. */
  private expire() {
    const now = this.clock();
    const old = (item: Queued) => now - item.enqueuedAt > this.limits.maxAgeMs;
    const before = this.queue.length;
    while (this.queue.length > 0 && old(this.queue[0])) {
      const item = this.queue.shift() as Queued;
      this.queuedBytes -= item.bytes;
    }
    this.dropped.expired += before - this.queue.length;
    if (this.inflight) {
      const kept = this.inflight.batch.filter((item) => !old(item));
      this.dropped.expired += this.inflight.batch.length - kept.length;
      this.inflight.batch = kept;
      if (kept.length === 0) this.inflight = null;
    }
  }

  /** The batch held for a retry: counted against the queue's caps and in `health()`. */
  private waiting(): { events: number; bytes: number } {
    const batch = this.inflight?.batch ?? [];
    return { events: batch.length, bytes: batch.reduce((sum, item) => sum + item.bytes, 0) };
  }

  private dropEnded() {
    const checked = new Map<ObservationScope, boolean>();
    this.discard((scope) => {
      let live = checked.get(scope);
      if (live === undefined) checked.set(scope, (live = this.live(scope)));
      return !live;
    }, 'scope-ended');
  }

  private kick() {
    if (this.kicked) return;
    this.kicked = true;
    queueMicrotask(() => {
      this.kicked = false;
      void this.flush().catch(() => undefined);
    });
  }
}
