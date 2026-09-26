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
export const MODEL_API_ROUTES = [...MODEL_API_PROVIDERS, NECTOVIA_ROUTE] as const;
export type ModelApiRoute = (typeof MODEL_API_ROUTES)[number];

export const isModelApiRoute = (value: unknown): value is ModelApiRoute =>
  typeof value === 'string' && (MODEL_API_ROUTES as readonly string[]).includes(value);
export const isModelApiProvider = (value: unknown): value is ModelApiProvider =>
  typeof value === 'string' && (MODEL_API_PROVIDERS as readonly string[]).includes(value);

export const MODEL_API_NAMES: Record<ModelApiRoute, string> = {
  'aws-bedrock': 'AWS Bedrock (GPT-6 Luna)',
  'azure-openai': 'Azure OpenAI',
  openrouter: 'OpenRouter',
  'google-vertex': 'Google Vertex AI (Gemini 3.8 Flash)',
  nectovia: 'Nectovia',
};

/**
 * GPT-6 Luna on Bedrock, as the managed gateway's provider registry lists it (contract section 4):
 * the US Geo inference profile, its rate card and Nectovia's own output cap. Kept in one place so
 * the owner's AWS route and the Nectovia route's local guard price a call alike.
 */
export const GPT6_LUNA = {
  model: 'us.openai.gpt-6-luna',
  label: 'GPT-6 Luna',
  rateCard: 'aws-bedrock-gpt-6-luna-us-2026-09-25.1',
  /** Whole micro-USD per million tokens. */
  rates: { input: 110_000, cacheRead: 11_000, cacheWrite: 137_500, output: 550_000 },
  /** Nectovia's own limit on one answer's output, not a claim about the model's maximum. */
  maxOutputTokens: 16_000,
  /** The gateway refuses input past this bound rather than guess a long-context price. */
  maxInputTokens: 272_000,
  source:
    'AWS Bedrock model card, OpenAI GPT-6 Luna, US Geo profile list prices per 1M tokens, checked 2026-09-25. Estimate only.',
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

/** What `GET /api/ai/model-api/openrouter` returns. Identifiers and state only, never a credential. */
export interface OpenRouterConnectionView {
  route: 'openrouter';
  configured: boolean;
  protectedStorage: boolean;
  enabled: boolean;
  connection: {
    id: string;
    endpoint: string;
    /** The allow-list: each model and the only upstream endpoints it may run on. */
    models: { id: string; upstreams: string[]; rates: DeclaredRatesView }[];
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
