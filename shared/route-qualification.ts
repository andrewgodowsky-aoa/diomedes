/**
 * Route qualification receipts: what a bounded set of live checks observed on one exact
 * model-API route, recorded so that "the code supports this provider" and "this route was seen
 * to work, within its limits, on this account" stay different facts.
 *
 * A receipt binds every observation to the exact identity it was made on: the route, the saved
 * connection id and revision, the endpoint, the Azure deployment where there is one, the
 * logical model, the wire protocol, the SDK pair and the rate card. A changed connection
 * revision, model, protocol or card is a different identity, so an older receipt simply stops
 * qualifying it; nothing is migrated or re-labelled.
 *
 * The verdicts are derived once, by the runner, from the checks it ran. Other code reads the
 * verdicts and never re-derives them from the detail sentences. A receipt is evidence of what
 * was observed, never a guarantee about later calls: the output bound in particular is the
 * provider's observed accounting for one bounded request, which is why it expires.
 */
import { z } from 'zod';

export const ROUTE_QUALIFICATION_VERSION = 1 as const;
/** How long a receipt qualifies its exact identity. Provider behaviour changes without notice. */
export const QUALIFICATION_VALID_DAYS = 30;

/** The routes a receipt can describe today: the owner's own keyed provider routes. */
export const QUALIFIABLE_ROUTES = ['aws-bedrock', 'azure-openai'] as const;
export type QualifiableRoute = (typeof QUALIFIABLE_ROUTES)[number];

/** Wire protocols, named as the desktop routes name them (`*_PROTOCOL` constants). */
export const QUALIFICATION_PROTOCOLS = ['openai-responses', 'openai-chat-completions'] as const;
export type QualificationProtocol = (typeof QUALIFICATION_PROTOCOLS)[number];

/**
 * The checks, in run order. Each is one or two real provider calls with a small output limit.
 * - short-answer: one plain question, a complete answer, reported usage.
 * - output-bound: a request built to provoke long reasoning under a tiny output limit; the
 *   reported billed output (reasoning included) must not exceed the limit.
 * - tool-round-trip: the model asks for the one offered read tool, then answers from its result.
 * - cache-default: the same long stable prefix twice; did the provider read a cache by default?
 * - cache-off: the same prefix twice with the provider's no-cache configuration; was nothing read
 *   from or written to a cache?
 */
export const QUALIFICATION_CHECKS = [
  'short-answer',
  'output-bound',
  'tool-round-trip',
  'cache-default',
  'cache-off',
] as const;
export type QualificationCheckId = (typeof QUALIFICATION_CHECKS)[number];

/** `unsupported`: the provider refused the request shape (4xx with an error body); `not-run`: skipped. */
export const QUALIFICATION_OUTCOMES = ['passed', 'failed', 'unsupported', 'not-run'] as const;
export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number];

const iso = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const qualificationUsageSchema = z.strictObject({
  inputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  /** Billed output, reasoning included, exactly as the provider reported it. */
  outputTokens: count,
  reasoningTokens: count,
});
export type QualificationUsage = z.infer<typeof qualificationUsageSchema>;

/** One provider exchange inside a check. Identifiers and counts only; never text or a credential. */
export const qualificationCallSchema = z.strictObject({
  /** HTTP status the provider answered with; null when nothing came back. */
  status: z.number().int().min(100).max(599).nullable(),
  providerRequestId: z.string().max(200).nullable(),
  responseId: z.string().max(200).nullable(),
  /** The model field of the provider's own response, recorded beside the requested model. */
  reportedModel: z.string().max(200).nullable(),
  /** How the exchange ended, as the route's classifier read it. */
  finish: z.enum(['completed', 'tool-call', 'incomplete', 'refused', 'error', 'cancelled', 'not-sent']),
  /** The provider's stated reason for an incomplete answer, e.g. `max_output_tokens`. */
  incompleteReason: z.string().max(100).nullable(),
  /** The output limit this exchange was sent with. */
  maxOutputTokens: count,
  usage: qualificationUsageSchema.nullable(),
  /** A bounded provider or route error, never a credential or a request body. */
  error: z.strictObject({ code: z.string().max(100).nullable(), message: z.string().max(500) }).nullable(),
  /** What the route's own spend ledger recorded for this exchange. Null when it recorded nothing. */
  ledger: z
    .strictObject({ state: z.enum(['released', 'settled', 'uncertain', 'pending']), microUsd: count })
    .nullable(),
  elapsedMs: count,
});
export type QualificationCall = z.infer<typeof qualificationCallSchema>;

export const qualificationCheckSchema = z.strictObject({
  id: z.enum(QUALIFICATION_CHECKS),
  outcome: z.enum(QUALIFICATION_OUTCOMES),
  /** One plain sentence: what was observed. Shown to the owner as written. */
  detail: z.string().min(1).max(500),
  calls: z.array(qualificationCallSchema).max(4),
});
export type QualificationCheck = z.infer<typeof qualificationCheckSchema>;

export const qualificationVerdictsSchema = z.strictObject({
  /** short-answer passed. */
  answers: z.boolean(),
  /** bounded: reported billed output never exceeded the limit it was sent with. */
  outputBound: z.enum(['bounded', 'exceeded', 'unknown']),
  /** one-call: a single offered tool was called with valid arguments and its result was used. */
  tools: z.enum(['one-call', 'failed', 'unknown']),
  /** caches: the second identical request reported cache-read tokens with no cache controls sent. */
  cacheDefault: z.enum(['caches', 'no-cache-observed', 'unknown']),
  /** verified: with the no-cache configuration, neither request read or wrote any cache tokens. */
  cacheOff: z.enum(['verified', 'not-verified', 'unsupported', 'unknown']),
});
export type QualificationVerdicts = z.infer<typeof qualificationVerdictsSchema>;

export const routeQualificationReceiptSchema = z
  .strictObject({
    v: z.literal(ROUTE_QUALIFICATION_VERSION),
    id: z.string().regex(/^rq_[a-z0-9]{8,40}$/),
    createdAt: iso,
    validUntil: iso,
    route: z.enum(QUALIFIABLE_ROUTES),
    connectionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    connectionRevision: z.number().int().min(1),
    /** The route's base URL, never with a key, query or credential in it. */
    endpoint: z.string().url().max(300),
    /** The Azure deployment the logical model is addressed by; null on other routes. */
    deployment: z.string().max(128).nullable(),
    /** The logical model the connection asks for (an AWS Geo profile, an Azure logical model). */
    model: z.string().min(1).max(200),
    /** Distinct models the provider reported serving the calls, in the order first seen. */
    servedModels: z.array(z.string().max(200)).max(8),
    protocol: z.enum(QUALIFICATION_PROTOCOLS),
    sdk: z.string().min(1).max(200),
    effort: z.enum(['low', 'medium', 'high']),
    rateCard: z.string().min(1).max(300),
    checks: z.array(qualificationCheckSchema).min(1).max(QUALIFICATION_CHECKS.length),
    verdicts: qualificationVerdictsSchema,
    /** The run's spend on the route's own ledger. Uncertain amounts stay uncertain until reconciled. */
    spend: z.strictObject({ settledMicroUsd: count, uncertainMicroUsd: count }),
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.validUntil) <= Date.parse(value.createdAt))
      ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'A receipt must expire after it was made.' });
    const ids = value.checks.map((check) => check.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['checks'], message: 'Each check appears once.' });
  });
export type RouteQualificationReceipt = z.infer<typeof routeQualificationReceiptSchema>;

/** The exact identity a caller wants to use. Every field must match the receipt's. */
export interface QualificationIdentity {
  route: QualifiableRoute;
  connectionId: string;
  connectionRevision: number;
  model: string;
  protocol: QualificationProtocol;
  rateCard: string;
  /** The Azure deployment; null elsewhere. */
  deployment: string | null;
}

/**
 * Whether a receipt qualifies this exact identity for ordinary use now: same identity, not
 * expired, it answered, its billed output stayed inside the limit, and a tool round trip worked.
 * Cache verdicts do not decide use; a no-cache policy reads `cacheOff` itself.
 */
export function receiptQualifies(
  receipt: RouteQualificationReceipt | null | undefined,
  identity: QualificationIdentity,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!receipt) return { ok: false, reason: 'No route check has been recorded for this connection.' };
  if (
    receipt.route !== identity.route ||
    receipt.connectionId !== identity.connectionId ||
    receipt.connectionRevision !== identity.connectionRevision ||
    receipt.model !== identity.model ||
    receipt.protocol !== identity.protocol ||
    receipt.rateCard !== identity.rateCard ||
    receipt.deployment !== identity.deployment
  )
    return { ok: false, reason: 'The recorded route check was made on a different connection, model or price. Run the checks again.' };
  if (!(Date.parse(receipt.validUntil) > now))
    return { ok: false, reason: 'The recorded route check has expired. Run the checks again.' };
  if (!receipt.verdicts.answers) return { ok: false, reason: 'The route check did not get a complete answer.' };
  if (receipt.verdicts.outputBound !== 'bounded')
    return {
      ok: false,
      reason:
        receipt.verdicts.outputBound === 'exceeded'
          ? 'The route check saw billed output above the limit it was sent with.'
          : 'The route check could not confirm that billed output stays inside the limit.',
    };
  if (receipt.verdicts.tools !== 'one-call')
    return { ok: false, reason: 'The route check could not complete a tool round trip.' };
  return { ok: true };
}
