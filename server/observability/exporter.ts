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
 * PH-01 ships the queue with a memory sink, which records the exact batch bodies a transport
 * would send (without `api_key`). The PostHog transport is PH-02's.
 */
import type { Observation } from '../../shared/observability.js';
import type { ObservationDenial, ObservationScope, ScopeRecheck } from './eligibility.js';
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
});

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

export interface BoundedExporterOptions {
  readonly sink: ObservationSink;
  readonly scopes: ScopeRecheckPort;
  readonly clock?: () => number;
  readonly limits?: Partial<ExporterLimits>;
  /** A periodic flush, unref'd. Tests turn it off and flush by hand. */
  readonly timer?: boolean;
}

/** `{"batch":[` + events + `]}`: the bytes `encodeBatch` would produce for the same events. */
const BATCH_OVERHEAD = Buffer.byteLength('{"batch":[]}');

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
      if (this.queue.length >= this.limits.queueEvents || this.queuedBytes + bytes > this.limits.queueBytes)
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
    let removed = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      let end = true;
      try {
        end = ended(item.scope);
      } catch {
        end = true;
      }
      if (!end) continue;
      this.queue.splice(index, 1);
      this.queuedBytes -= item.bytes;
      this.dropped[reason] += 1;
      removed += 1;
    }
    return removed;
  }

  health(): ObservationHealth {
    return {
      state: this.state(),
      enqueued: this.enqueued,
      exported: this.exported,
      dropped: { ...this.dropped },
      denied: this.options.scopes.denials(),
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
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
    return this.options.sink.kind === 'memory' ? 'memory' : 'exporting';
  }

  protected drop(reason: DropReason) {
    this.dropped[reason] += 1;
  }

  protected live(scope: ObservationScope) {
    try {
      return this.options.scopes.recheck(scope).live;
    } catch {
      return false;
    }
  }

  /** Expire, recheck, then send batches until the queue is empty or the deadline passes. */
  protected async drain(deadlineMs: number): Promise<void> {
    const started = this.clock();
    this.expire();
    this.dropEnded();
    while (this.queue.length > 0 && this.clock() - started < deadlineMs) {
      const batch = this.takeBatch();
      if (batch.length === 0) break;
      const body = `{"batch":[${batch.map((item) => item.text).join(',')}]}`;
      const result = await this.send(body, Math.max(1, deadlineMs - (this.clock() - started)));
      this.settle(batch, result);
    }
  }

  /** One batch out. PH-01 drops a failed batch; PH-02 retries it. */
  protected settle(batch: readonly Queued[], result: SinkResult) {
    if (result.ok) {
      this.exported += batch.length;
      return;
    }
    this.lastFailure = result.failure;
    this.dropped.rejected += batch.length;
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
  protected takeBatch(): Queued[] {
    const batch: Queued[] = [];
    let bytes = BATCH_OVERHEAD;
    const checked = new Map<ObservationScope, boolean>();
    while (this.queue.length > 0 && batch.length < this.limits.batchEvents) {
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

  protected requeue(batch: readonly Queued[]) {
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      this.queue.unshift(batch[index]);
      this.queuedBytes += batch[index].bytes;
    }
  }

  private expire() {
    const now = this.clock();
    const before = this.queue.length;
    while (this.queue.length > 0 && now - this.queue[0].enqueuedAt > this.limits.maxAgeMs) {
      const item = this.queue.shift() as Queued;
      this.queuedBytes -= item.bytes;
    }
    this.dropped.expired += before - this.queue.length;
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
