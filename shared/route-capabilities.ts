/**
 * Route capabilities and the owner's cache setting.
 *
 * A capability record says what one model can do on one route, endpoint and wire protocol, and
 * where each fact comes from: a cited declaration, a route check that observed it, or nothing.
 * Nothing is guessed from a model's name. Observed facts come from route check receipts
 * (`route-qualification.ts`) and lapse with them: a receipt that no longer qualifies the exact
 * identity contributes nothing.
 *
 * The cache setting is the owner's choice per route: the provider's default behaviour, off, or an
 * explicit prefix. Off is a request shape, not a promise. It counts as verified only when a route
 * check that sent that shape saw no cache read or write tokens on the same identity. `store: false`
 * keeps no response object at the provider and says nothing about prompt caching.
 */
import { z } from 'zod';
import {
  QUALIFICATION_PROTOCOLS,
  receiptQualifies,
  type QualificationIdentity,
  type QualificationProtocol,
  type RouteQualificationReceipt,
} from './route-qualification.js';

export const ROUTE_CAPABILITIES_VERSION = 1 as const;

// --- the cache setting ------------------------------------------------------------------------

export const CACHE_POLICIES = ['provider-default', 'off', 'explicit-prefix'] as const;
export type CachePolicy = (typeof CACHE_POLICIES)[number];
export const cachePolicySchema = z.enum(CACHE_POLICIES);
/** A route whose owner never chose keeps today's behaviour: whatever the provider does by default. */
export const DEFAULT_CACHE_POLICY: CachePolicy = 'provider-default';

/** The Settings key a route's cache setting lives under, beside `${route}Model`. */
export const cachePolicyKey = (route: string) => `${route}CachePolicy`;

export function readCachePolicy(
  services: Readonly<Record<string, boolean | string>> | undefined,
  route: string,
): CachePolicy {
  const parsed = cachePolicySchema.safeParse(services?.[cachePolicyKey(route)]);
  return parsed.success ? parsed.data : DEFAULT_CACHE_POLICY;
}

/** The only explicit lifetime the providers this build reaches accept. */
export const EXPLICIT_CACHE_TTL = '30m' as const;

/**
 * Where a protocol's SDK model reads prompt cache options and part breakpoints. The Chat
 * Completions model reads both under `openai` whatever the provider instance is called; the
 * Responses model reads them under `azure` for an Azure provider and `openai` otherwise. A
 * breakpoint under the wrong name is dropped without a warning, so this is decided here once.
 */
export type CacheNamespace = 'openai' | 'azure';
export function cacheNamespace(route: string, protocol: QualificationProtocol): CacheNamespace {
  return protocol === 'openai-responses' && route === 'azure-openai' ? 'azure' : 'openai';
}

/** The request fields one cache setting adds. Nothing else about the request changes. */
export interface CacheRequest {
  policy: CachePolicy;
  /** Merged into the binding's provider options under `cacheNamespace(...)`. */
  options: {
    promptCacheKey?: string;
    promptCacheOptions?: { mode: 'implicit' | 'explicit'; ttl?: typeof EXPLICIT_CACHE_TTL };
  };
  /** The breakpoint that marks the end of the stable prefix. Only explicit-prefix sets one. */
  breakpoint: { mode: 'explicit' } | null;
}

/** An explicit prefix needs its scoped key; the other settings carry none. */
export type CacheRequestInput =
  | { policy: 'provider-default' | 'off' }
  | { policy: 'explicit-prefix'; key: string };

/**
 * The request shape for one setting, or null when an explicit-prefix key is not a derived key.
 * The server turns null into a route refusal before anything is sent; shared code never throws.
 * - provider-default: nothing is added; any reuse is the provider's own.
 * - off: explicit mode and no breakpoint, so no block is eligible for caching; no key, so no
 *   routing hint survives the request either.
 * - explicit-prefix: a scoped key, explicit mode with the 30-minute lifetime, and one breakpoint
 *   at the end of the stable prefix.
 */
export function cacheRequest(input: CacheRequestInput): CacheRequest | null {
  switch (input.policy) {
    case 'provider-default':
      return { policy: input.policy, options: {}, breakpoint: null };
    case 'off':
      return { policy: input.policy, options: { promptCacheOptions: { mode: 'explicit' } }, breakpoint: null };
    case 'explicit-prefix':
      if (!CACHE_KEY_PATTERN.test(input.key)) return null;
      return {
        policy: input.policy,
        options: { promptCacheKey: input.key, promptCacheOptions: { mode: 'explicit', ttl: EXPLICIT_CACHE_TTL } },
        breakpoint: { mode: 'explicit' },
      };
  }
}

/**
 * What a cache key is derived from. The key is a hash of these, made on the server, so it never
 * carries a tenant, connection or model name in clear, and no two tenants, routes, connection
 * generations or models share one.
 */
export interface CacheKeyScope {
  /** The principal's tenant; `local` on a computer with no tenant. */
  tenantId: string;
  route: string;
  connectionId: string;
  connectionRevision: number;
  model: string;
}
/** Below every provider's ceiling for a cache key. Derived keys are `dio1-` and 40 hex digits. */
export const CACHE_KEY_MAX = 64;
export const CACHE_KEY_PATTERN = /^dio1-[a-f0-9]{40}$/;

/** A system message as the SDK accepts it, without importing the SDK into shared code. */
export interface SystemPart {
  role: 'system';
  content: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Where the breakpoints went, so the run record says what was actually marked: the stable prefix,
 * or the whole instructions. With `-and-files`, a second breakpoint marks the end of the host's
 * reads of the files attached to a conversation message, which lead its messages.
 */
export type CacheMark =
  | 'stable-prefix'
  | 'whole-instructions'
  | 'stable-prefix-and-files'
  | 'whole-instructions-and-files'
  | null;

/** The mark once the host's reads of the attached files carry a breakpoint as well. */
export function withFilesMarked(marked: CacheMark): CacheMark {
  if (marked === 'stable-prefix') return 'stable-prefix-and-files';
  if (marked === 'whole-instructions') return 'whole-instructions-and-files';
  return marked;
}

/**
 * The system text one request sends, and what it marked. With no breakpoint it is the
 * instructions exactly as today. With one, the stable prefix goes first as its own part carrying
 * the breakpoint and the rest follows as a second part, so a later turn whose variable part
 * differs still reuses the prefix. When the caller passes no stable prefix, or it is not a prefix
 * of the instructions, the breakpoint goes on the whole text and the mark says so: reuse then
 * holds only while the whole text is unchanged.
 */
export function systemParts(
  instructions: string,
  stablePrefix: string | null,
  request: CacheRequest,
  namespace: CacheNamespace,
): { system: string | SystemPart[]; marked: CacheMark } {
  if (!request.breakpoint) return { system: instructions, marked: null };
  const mark = (content: string): SystemPart => ({
    role: 'system',
    content,
    providerOptions: { [namespace]: { promptCacheBreakpoint: request.breakpoint } },
  });
  if (!stablePrefix || !instructions.startsWith(stablePrefix))
    return { system: [mark(instructions)], marked: 'whole-instructions' };
  const rest = instructions.slice(stablePrefix.length).replace(/^\n+/, '');
  return {
    system: rest ? [mark(stablePrefix), { role: 'system', content: rest }] : [mark(stablePrefix)],
    marked: 'stable-prefix',
  };
}

// --- the capability record ----------------------------------------------------------------------

export const FACT_SOURCES = ['declared', 'observed', 'not-known'] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

const fact = <T extends z.ZodTypeAny>(value: T) =>
  z.strictObject({
    value: value.nullable(),
    source: z.enum(FACT_SOURCES),
    /** A citation (a URL or a document and its date), a receipt id, or why nothing is known. */
    evidence: z.string().min(1).max(300),
  });
const tokens = z.number().int().positive().max(100_000_000);

export const routeCapabilitySchema = z.strictObject({
  v: z.literal(ROUTE_CAPABILITIES_VERSION),
  route: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  endpoint: z.string().url().max(300),
  protocol: z.enum(QUALIFICATION_PROTOCOLS),
  contextTokens: fact(tokens),
  outputTokens: fact(tokens),
  tools: fact(z.boolean()),
  /** What the model can do. This build still sends one tool call at a time (`BUILD_REFUSALS`). */
  parallelToolCalls: fact(z.boolean()),
  /** What the model can do. This build still asks for text answers only (`BUILD_REFUSALS`). */
  structuredOutput: fact(z.boolean()),
  images: fact(z.boolean()),
  reasoning: fact(z.boolean()),
  cache: z.strictObject({
    /** From the receipt's cache-default check. */
    byDefault: z.enum(['caches', 'no-cache-observed', 'unknown']),
    /** From the receipt's cache-off check: the `off` request shape on this exact identity. */
    off: z.enum(['verified', 'not-verified', 'unsupported', 'unknown']),
    explicitPrefix: fact(z.boolean()),
    /** The shortest prefix the provider caches at all. */
    minimumTokens: fact(tokens),
  }),
  /** The receipt the observed facts came from; null when none qualifies this identity now. */
  receiptId: z.string().nullable(),
});
export type RouteCapability = z.infer<typeof routeCapabilitySchema>;
export type CapabilityFact<T> = { value: T | null; source: FactSource; evidence: string };

/** What this build sends on every route, whatever the model can do. A change here is a decision. */
export const BUILD_REFUSALS = {
  parallelToolCalls: 'This build sends one tool call at a time.',
  structuredOutput: 'This build asks for text answers only.',
} as const;

/**
 * Facts a cited source declares for one route and model. A fact with no source is left out, never
 * filled with a guess: the record then says it is not known.
 */
export interface DeclaredCapabilities {
  contextTokens?: CapabilityFact<number>;
  outputTokens?: CapabilityFact<number>;
  tools?: CapabilityFact<boolean>;
  parallelToolCalls?: CapabilityFact<boolean>;
  structuredOutput?: CapabilityFact<boolean>;
  images?: CapabilityFact<boolean>;
  reasoning?: CapabilityFact<boolean>;
  explicitPrefix?: CapabilityFact<boolean>;
  minimumCacheTokens?: CapabilityFact<number>;
}

const unknownFact = <T>(what: string): CapabilityFact<T> => ({
  value: null,
  source: 'not-known',
  evidence: `No cited source or route check states the ${what}.`,
});

/**
 * One identity's record: the declared facts, overlaid by what a receipt that qualifies this exact
 * identity now observed. Tools and reasoning can be observed; windows, images and explicit-prefix
 * support stay declared, because no route check measures them.
 */
export function capabilityRecord(input: {
  identity: QualificationIdentity;
  endpoint: string;
  declared: DeclaredCapabilities;
  receipt: RouteQualificationReceipt | null;
  now: number;
}): RouteCapability {
  const { identity, declared } = input;
  const receipt = input.receipt && receiptQualifies(input.receipt, identity, input.now).ok ? input.receipt : null;
  const observed = <T>(value: T): CapabilityFact<T> => ({
    value,
    source: 'observed',
    evidence: `Route check ${receipt!.id}, ${receipt!.createdAt}.`,
  });
  const reasoningSeen = receipt?.checks.some((check) =>
    check.calls.some((call) => (call.usage?.reasoningTokens ?? 0) > 0),
  );
  return routeCapabilitySchema.parse({
    v: ROUTE_CAPABILITIES_VERSION,
    route: identity.route,
    model: identity.model,
    endpoint: input.endpoint,
    protocol: identity.protocol,
    contextTokens: declared.contextTokens ?? unknownFact('context window'),
    outputTokens: declared.outputTokens ?? unknownFact('output limit'),
    // A qualifying receipt has, by definition, completed one tool round trip.
    tools: receipt ? observed(true) : (declared.tools ?? unknownFact('tool support')),
    parallelToolCalls: declared.parallelToolCalls ?? unknownFact('parallel tool call support'),
    structuredOutput: declared.structuredOutput ?? unknownFact('structured output support'),
    images: declared.images ?? unknownFact('image input support'),
    reasoning: reasoningSeen ? observed(true) : (declared.reasoning ?? unknownFact('reasoning support')),
    cache: {
      byDefault: receipt?.verdicts.cacheDefault ?? 'unknown',
      off: receipt?.verdicts.cacheOff ?? 'unknown',
      explicitPrefix: declared.explicitPrefix ?? unknownFact('explicit prefix caching support'),
      minimumTokens: declared.minimumCacheTokens ?? unknownFact('minimum cacheable prefix'),
    },
    receiptId: receipt?.id ?? null,
  });
}

/**
 * What the run record says about caching for one request: the setting, whether `off` is verified
 * on this identity, and one plain sentence.
 */
export interface CacheAccount {
  policy: CachePolicy;
  /** For `off`: whether a qualifying route check saw no cache tokens with that request shape. */
  offVerified: boolean | null;
  /** For `explicit-prefix`: what the breakpoint actually marked on this request. */
  marked: CacheMark;
  note: string;
}

export function cacheAccount(policy: CachePolicy, record: RouteCapability | null, marked: CacheMark): CacheAccount {
  switch (policy) {
    case 'provider-default':
      return {
        policy,
        offVerified: null,
        marked: null,
        note:
          record?.cache.byDefault === 'caches'
            ? 'Caching is the provider’s default. A route check saw it reuse a repeated prefix.'
            : 'Caching is left to the provider’s default. No cache directive is sent.',
      };
    case 'off': {
      const verified = record?.cache.off === 'verified';
      return {
        policy,
        offVerified: verified,
        marked: null,
        note: verified
          ? 'Caching is off. A route check on this connection saw no cache reads or writes with this setting.'
          : 'Caching is set to off. No route check on this connection has confirmed it yet.',
      };
    }
    case 'explicit-prefix':
      return {
        policy,
        offVerified: null,
        marked,
        note:
          marked === 'stable-prefix'
            ? 'The stable start of the instructions is marked for caching for 30 minutes, under a key kept to this business and route.'
            : marked === 'stable-prefix-and-files'
              ? 'The stable start of the instructions and the attached files read before the message are marked for caching for 30 minutes, under a key kept to this business and route.'
              : marked === 'whole-instructions-and-files'
                ? 'The whole instructions and the attached files read before the message are marked for caching for 30 minutes, so reuse holds only while the instructions stay the same.'
                : 'The whole instructions are marked for caching for 30 minutes, so reuse holds only while they stay the same.',
      };
  }
}
