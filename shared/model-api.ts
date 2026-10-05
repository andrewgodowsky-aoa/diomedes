import { lunaLabel, type LunaModelId } from './luna-models.js';
import type { CacheAccount, CachePolicy, RouteCapability } from './route-capabilities.js';
import type { QualificationProtocol, RouteQualificationReceipt } from './route-qualification.js';

/** The Luna model ids the desktop route sends and the one kept for older policies. */
const MANAGED_LUNA_ID = 'us.openai.gpt-5.6-luna' satisfies LunaModelId;
const GPT6_LUNA_ID = 'us.openai.gpt-6-luna' satisfies LunaModelId;

/**
 * Model-API routes: a provider's API reached with the company's own credential,
 * rather than an engine installed on this computer. They are deliberately not
 * `ExternalEngine`s: nothing is discovered, installed, bound or signed in to,
 * and every place that handles a route must say what it does with these.
 */
/**
 * The provider routes: a provider's API reached with a company credential. Only these can be a
 * route entry in the account service (`routeEntrySchema.provider`), and only these are the
 * owner's tools in AI setup.
 */
export const MODEL_API_PROVIDERS = ['aws-bedrock', 'azure-openai', 'openrouter', 'google-vertex'] as const;
export type ModelApiProvider = (typeof MODEL_API_PROVIDERS)[number];
/**
 * Nectovia's managed route (contract `nectovia-managed/1`,
 * docs/implementation/2026-09-25-managed-inference-gateway.md). On this computer it runs like any
 * model-API route, but it is not a provider: the account service's gateway pays for each call and
 * meters it, and no provider credential exists on this computer for it.
 */
export const NECTOVIA_ROUTE = 'nectovia' as const;
// The local model (route id 'bonsai', kept from its first release) uses the native Agent's model
// interface, but runs on this computer and is never a cloud provider or payer.
export const MODEL_API_ROUTES = [...MODEL_API_PROVIDERS, NECTOVIA_ROUTE, 'bonsai'] as const;
export type ModelApiRoute = (typeof MODEL_API_ROUTES)[number];

export const isModelApiRoute = (value: unknown): value is ModelApiRoute =>
  typeof value === 'string' && (MODEL_API_ROUTES as readonly string[]).includes(value);
export const isModelApiProvider = (value: unknown): value is ModelApiProvider =>
  typeof value === 'string' && (MODEL_API_PROVIDERS as readonly string[]).includes(value);
/**
 * The model routes a team role may run on: the provider routes and the local model on this
 * computer. The Agent Team grant, its host and the member bindings all ask this one list.
 */
export const TEAM_MODEL_ROUTES = [...MODEL_API_PROVIDERS, 'bonsai'] as const;
export type TeamModelRoute = (typeof TEAM_MODEL_ROUTES)[number];
export const isTeamModelRoute = (value: unknown): value is TeamModelRoute =>
  typeof value === 'string' && (TEAM_MODEL_ROUTES as readonly string[]).includes(value);

export const MODEL_API_NAMES: Record<ModelApiRoute, string> = {
  'aws-bedrock': `AWS Bedrock (${lunaLabel(MANAGED_LUNA_ID)})`,
  'azure-openai': 'Azure OpenAI',
  openrouter: 'OpenRouter',
  'google-vertex': 'Google Vertex AI (Gemini 3.8 Flash)',
  nectovia: 'Nectovia',
  bonsai: 'Local model',
};

/**
 * The owner's temporary managed selection while GPT-6 Luna's AWS access is unresolved:
 * the US Geo inference profile, its rate card and Nectovia's own output cap. Kept in one place so
 * the owner's AWS route and the Nectovia route's local guard price a call alike.
 */
export const MANAGED_LUNA = {
  model: MANAGED_LUNA_ID,
  label: lunaLabel(MANAGED_LUNA_ID),
  rateCard: 'aws-bedrock-gpt-5.6-luna-us-2026-09-28.1',
  /** Whole micro-USD per million tokens. */
  rates: { input: 220_000, cacheRead: 22_000, cacheWrite: 275_000, output: 1_320_000 },
  longRates: { input: 440_000, cacheRead: 44_000, cacheWrite: 550_000, output: 1_980_000 },
  /** Nectovia's own limit on one answer's output, not a claim about the model's maximum. */
  maxOutputTokens: 16_000,
  /** The gateway refuses input past this bound rather than guess a long-context price. */
  maxInputTokens: 272_000,
  source:
    'AWS Bedrock GPT-5.6 Luna agreement offer-bklbyf2ewuawu, US Geo standard prices per 1M tokens, checked 2026-09-28. Estimate only.',
} as const;

/**
 * Published direct-AWS catalog identity and US Geo Standard prices. This row does not
 * qualify an account or a provider exchange, and never changes the managed Luna selection.
 * K3 is sent over Chat Completions, and only under a current route
 * check receipt for the exact connection revision, model, protocol and rate card
 * (`shared/route-qualification.ts`): nobody has verified for every account that its billed
 * reasoning plus output stays inside the limit a request is sent with.
 */
export const AWS_KIMI_K3 = {
  model: 'us.moonshotai.kimi-k3',
  label: 'Kimi K3',
  rateCard: 'aws-bedrock-kimi-k3-us-standard-2026-10-01.1',
  /** Whole micro-USD per million tokens; cache writes cost more than ordinary input. */
  rates: { input: 3_300_000, cacheRead: 330_000, cacheWrite: 4_125_000, output: 16_500_000 },
  source:
    'AWS Bedrock Kimi K3, US Geo Standard prices per 1M tokens, checked 2026-10-01. https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html . Estimate only; account access and billed output bounds are unverified.',
} as const;

/** The direct owner's setup choices only; no Global profile or alternate region is implied. */
export const AWS_DIRECT_MODELS = [MANAGED_LUNA, AWS_KIMI_K3] as const;
export const AWS_DIRECT_MODEL_IDS = [MANAGED_LUNA.model, AWS_KIMI_K3.model] as const;
export type AwsDirectModelId = (typeof AWS_DIRECT_MODEL_IDS)[number];

/**
 * The wire protocol each direct AWS model is sent over, named as the route checks name it.
 * Luna speaks Responses; Kimi K3 speaks Chat Completions, which AWS recommends for it.
 */
export const AWS_MODEL_PROTOCOLS: Readonly<Record<AwsDirectModelId, QualificationProtocol>> = Object.freeze({
  [MANAGED_LUNA.model]: 'openai-responses',
  [AWS_KIMI_K3.model]: 'openai-chat-completions',
});

/** A direct AWS model's protocol, or null for an id that is not a direct AWS selection. */
export function awsModelProtocol(modelId: string): QualificationProtocol | null {
  return Object.hasOwn(AWS_MODEL_PROTOCOLS, modelId) ? AWS_MODEL_PROTOCOLS[modelId as AwsDirectModelId] : null;
}

/**
 * Visible in setup and admission while K3 has no qualifying route check on the saved connection.
 * Catalog recognition never removes it; only a current receipt for the exact identity does.
 */
export const AWS_KIMI_K3_REFUSAL =
  'Kimi K3 needs a passing route check on this connection before it sends. Run the route checks in AI setup.';

/** Compatibility for policies published before versioned routing; no new qualification is implied. */
export const GPT6_LUNA = {
  model: GPT6_LUNA_ID, label: lunaLabel(GPT6_LUNA_ID), rateCard: 'aws-bedrock-gpt-6-luna-us-2026-09-25.1',
  rates: { input: 110_000, cacheRead: 11_000, cacheWrite: 137_500, output: 550_000 },
  maxOutputTokens: 16_000, maxInputTokens: 272_000,
  source: 'Legacy published AWS Bedrock GPT-6 Luna US Geo price snapshot, 2026-09-25. Estimate only.',
} as const;

/**
 * What `GET /api/ai/nectovia` returns: whether the Nectovia route can answer now, the model each
 * tier runs as the account service published it, and whether this app was launched with the
 * company's provider tools. Never a balance: the account service's ledger is the only one.
 */
export interface NectoviaRouteView {
  route: 'nectovia';
  /** True when the app was launched with `DIOMEDES_OWNER_ROUTES=1`: the provider cards show. */
  ownerRoutes: boolean;
  /** Null when a message would be sent; otherwise why it would be refused, in words. */
  refusal: { code: string; reason: string } | null;
  /** The published model for each tier, or null for a tier with no route. */
  tiers: Record<'efficient' | 'focused' | 'thorough', { model: string; label: string } | null> | null;
  policyRevision: number | null;
}

/** What `GET /api/ai/model-api/aws-bedrock` returns. Identifiers and state only, never a credential. */
export interface AwsConnectionView {
  route: 'aws-bedrock';
  configured: boolean;
  /** False in a server without OS-protected storage (plain development server). */
  protectedStorage: boolean;
  enabled: boolean;
  connection: {
    id: string;
    account: string;
    accountEvidence: string;
    region: string;
    endpoint: string;
    model: string;
    processing: string;
    credential: { kind: string; fingerprint: string; savedAt: string; expiresAt: string | null; expired: boolean };
    revision: number;
    accountRoute: string;
  } | null;
  spend: ModelApiSpendView | null;
  /** The one thing to do next, when something blocks sending. */
  next: string | null;
}

/** A route's spend ledger for one connection, as Settings shows it. Estimates, never an invoice. */
export interface ModelApiSpendView {
  rateCard: string;
  capMicroUsd: number;
  settledMicroUsd: number;
  pendingMicroUsd: number;
  uncertainMicroUsd: number;
  writtenOffMicroUsd: number;
  availableMicroUsd: number;
  note: string;
  /** The most recent holds, newest first: one per paid call, so each can be inspected or reconciled. */
  recent: {
    id: string;
    state: string;
    runId: string;
    stepId: string;
    maxMicroUsd: number;
    settledMicroUsd: number | null;
    usage: {
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      reasoningTokens: number;
    } | null;
    providerRequestId: string | null;
    createdAt: string;
    uncertainReason: string | null;
  }[];
}

/** An owner-declared price, in micro-USD per million tokens. */
export interface DeclaredRatesView {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  source: string;
  declaredAt: string;
}

interface CredentialView {
  kind: string;
  fingerprint: string;
  savedAt: string;
  expiresAt: string | null;
  expired: boolean;
}

/** What `GET /api/ai/model-api/azure-openai` returns. Identifiers and state only, never a credential. */
export interface AzureConnectionView {
  route: 'azure-openai';
  configured: boolean;
  protectedStorage: boolean;
  enabled: boolean;
  connection: {
    id: string;
    resource: string;
    endpoint: string;
    apiVersion: string;
    /** Each logical model and the deployment that serves it. */
    deployments: { model: string; deployment: string; reasoning: boolean; rates: DeclaredRatesView }[];
    credential: CredentialView;
    revision: number;
    accountRoute: string;
  } | null;
  spend: ModelApiSpendView | null;
  next: string | null;
}

/**
 * What `GET /api/ai/model-api/<route>/qualification` and `POST .../qualify` return for the
 * route's current connection and one logical model: the newest route check receipt and what it
 * means now. Identifiers, counts and sentences only; never a key, a prompt or an answer. A failed
 * call's error may quote the provider's own error message, bounded and with the key removed: the
 * checks' prompts are fixed and carry no person's content.
 */
export interface RouteQualificationView {
  route: 'aws-bedrock' | 'azure-openai';
  /** The logical model checked: the AWS connection's model, or one Azure deployment's model. */
  model: string | null;
  /** The Azure deployment that serves the model; null elsewhere. */
  deployment: string | null;
  /** The newest receipt for this connection and model. It may describe an older revision. */
  receipt: RouteQualificationReceipt | null;
  /** Whether that receipt qualifies the current connection, model, protocol and price now. */
  qualifies: boolean;
  /** Why it does not, in one sentence. Null when it does. */
  reason: string | null;
  /** Whether this model sends only under a qualifying receipt (Kimi K3 today). */
  required: boolean;
  /** Why a run cannot start now, in one sentence. Null when it can. */
  blocked: string | null;
  /** The most every planned check together can hold on the spend limit. Null with no connection. */
  ceilingMicroUsd: number | null;
  /** True while route checks are running on this route. */
  running: boolean;
}

/**
 * One model's capability record on a route with the owner's cache setting (DIO-215), and what a
 * conversation turn's context record would say about caching under the current setting.
 */
export interface RouteCacheModelView {
  model: string;
  /** The Azure deployment that serves the model; null elsewhere. */
  deployment: string | null;
  capability: RouteCapability;
  preview: CacheAccount;
}

/** What `GET` and `PUT /api/ai/model-api/<route>/cache-policy` return. Never a cache key or its scope. */
export interface RouteCachePolicyView {
  route: 'aws-bedrock' | 'azure-openai';
  policy: CachePolicy;
  /** False until the owner chooses; the provider's default applies until then. */
  chosen: boolean;
  /** One entry per model the connection serves; empty with no connection. */
  models: RouteCacheModelView[];
}

/** What `GET /api/ai/model-api/<route>/capabilities` returns: one model's record, null with no connection. */
export interface RouteCapabilityView {
  route: 'aws-bedrock' | 'azure-openai';
  model: string | null;
  deployment: string | null;
  capability: RouteCapability | null;
}

/** What `GET /api/ai/model-api/openrouter` returns. Identifiers and state only, never a credential. */
export interface OpenRouterReasoningView {
  /** Configured capability only; no live provider qualification is implied. */
  supported: ('low' | 'medium' | 'high')[];
  source: string;
}

export interface OpenRouterConnectionView {
  route: 'openrouter';
  configured: boolean;
  protectedStorage: boolean;
  enabled: boolean;
  connection: {
    id: string;
    endpoint: string;
    /** The allow-list: each model and the only upstream endpoints it may run on. */
    models: { id: string; upstreams: string[]; rates: DeclaredRatesView; reasoning?: OpenRouterReasoningView }[];
    dataCollection: 'deny';
    allowFallbacks: false;
    credential: CredentialView;
    revision: number;
    accountRoute: string;
  } | null;
  spend: ModelApiSpendView | null;
  next: string | null;
}

/**
 * What `GET /api/ai/model-api/google-vertex` returns. Identifiers and state only: never a token,
 * a refresh token, a key or the contents of the Application Default Credentials file.
 */
export interface VertexConnectionView {
  route: 'google-vertex';
  configured: boolean;
  enabled: boolean;
  /** What this computer offers, found without sending anything. Finding it grants nothing. */
  detected: {
    adc: boolean;
    source: string | null;
    namedBy: string | null;
    quotaProject: string | null;
  };
  connection: {
    id: string;
    projectId: string;
    location: 'global';
    endpoint: string;
    model: 'gemini-3.8-flash';
    processing: string;
    /** Who Google bills: the project the request names. */
    payer: { kind: 'google-cloud-project'; projectId: string };
    credential:
      | {
          kind: 'google-adc';
          source: string;
          namedBy: string;
          fingerprint: string;
          principal: string | null;
          quotaProject: string | null;
          savedAt: string;
          /** False when the ADC file on this computer is no longer the one that was verified. */
          matches: boolean;
        }
      | {
          /** A key from the billed project, in protected storage. Nothing about it is shown. */
          kind: 'google-api-key';
          savedAt: string;
          /** False when protected storage is not available to use it. */
          matches: boolean;
        };
    rateCard: { version: string; source: string; stale: boolean; message: string | null };
    revision: number;
    accountRoute: string;
    /** The last call Vertex answered on this connection, from the ledger. */
    lastVerified: { at: string; state: string; providerRequestId: string | null } | null;
  } | null;
  spend: ModelApiSpendView | null;
  /**
   * Five figures that are never merged. Only the gross estimate comes from this
   * computer; the others are an expectation, or live in Google's billing account.
   */
  accounting: VertexAccountingView | null;
  next: string | null;
}

export interface VertexAccountingView {
  /** Who pays Google for these calls: the owner's own project, not Nectovia credits. */
  payer: { kind: 'owner-google-cloud-project'; projectId: string };
  /** Settled calls at Google's standard rate: the conservative provider-cost bound. */
  grossEstimateMicroUsd: number;
  /** Calls whose cost is not yet known (pending or uncertain), also at the standard rate. */
  unresolvedEstimateMicroUsd: number;
  /** What Google's pricing footnote says may come back later. Never subtracted from anything. */
  expectedPromotion: {
    status: 'expected-unconfirmed';
    percent: number;
    appliesThrough: string;
    stacksWithFreeTrial: 'unknown';
    expectedMicroUsd: number;
    source: string;
  };
  /** Credits Google actually applied. Only the billing account knows; this computer never does. */
  confirmedCredits: { known: false; where: string };
  /** Nectovia credits debited for these calls. Zero on the owner route: the owner's project pays. */
  customerDebitMicroUsd: 0;
  /** The invoice is Google's, in the billing account; this is where to read it. */
  invoice: { known: false; where: string };
}

/**
 * What `POST /api/ai/model-api/<route>/test` returns: an offline readiness check of the saved
 * connection, key and spend limit. It never sends a request to the provider, so it proves the
 * setup is complete, not that the provider accepts the key.
 */
export interface ModelApiReadiness {
  route: ModelApiRoute;
  ready: boolean;
  sent: false;
  checks: { id: string; ok: boolean; detail: string }[];
  note: string;
}
