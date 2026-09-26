/**
 * The PostHog transport (PH-00 contract 4.7, PH-02): one POST of one batch to `/batch/`.
 *
 * The capture key is added here, at send, and nowhere else: the queue and the memory sink never
 * hold it. The body is the exporter's `{"batch":[...]}` with `api_key` first, byte-equal to
 * `JSON.stringify({ api_key, batch })`. Redirects are refused, so the key goes to the configured
 * origin or nowhere. The answer is classified and never read beyond its status and `Retry-After`.
 *
 * The exporter owns the deadline, retries, backoff, the circuit, the budget and funding.
 */
import type { ObservationSink, SinkResult } from './exporter.js';

export interface PostHogTransportOptions {
  /** An https origin, from operator configuration only. */
  readonly host: string;
  readonly captureKey: string;
  /** Tests pass a fake. Production uses the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/** `{"batch":[...]}` → `{"api_key":"…","batch":[...]}`. */
export function withApiKey(body: string, captureKey: string): string {
  if (!body.startsWith('{"batch":')) throw new Error('A PostHog batch body starts with its batch.');
  return `{"api_key":${JSON.stringify(captureKey)},${body.slice(1)}`;
}

/** Seconds, or an HTTP date, as milliseconds from now. Anything else is no instruction. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class PostHogTransport implements ObservationSink {
  readonly kind = 'posthog' as const;
  private readonly url: string;

  constructor(private readonly options: PostHogTransportOptions) {
    const origin = new URL(options.host);
    if (origin.protocol !== 'https:' || origin.username || origin.password)
      throw new Error('The PostHog host must be an https origin.');
    this.url = `${origin.origin}/batch/`;
  }

  async send(body: string, signal: AbortSignal): Promise<SinkResult> {
    const post = this.options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await post(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: withApiKey(body, this.options.captureKey),
        signal,
        redirect: 'error',
      });
    } catch {
      return { ok: false, failure: signal.aborted ? 'timeout' : 'network', retryAfterMs: null };
    }
    try {
      await response.body?.cancel();
    } catch {
      // The answer's body is never read.
    }
    if (response.status >= 200 && response.status < 300) return { ok: true };
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), (this.options.now ?? Date.now)());
    if (response.status === 429) return { ok: false, failure: 'http-429', retryAfterMs };
    if (response.status >= 500) return { ok: false, failure: 'http-5xx', retryAfterMs };
    return { ok: false, failure: 'http-4xx', retryAfterMs: null };
  }
}
