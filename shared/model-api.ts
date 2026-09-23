/**
 * Model-API routes: a provider's API reached with the company's own credential,
 * rather than an engine installed on this computer. They are deliberately not
 * `ExternalEngine`s: nothing is discovered, installed, bound or signed in to,
 * and every place that handles a route must say what it does with these.
 */
export const MODEL_API_ROUTES = ['aws-bedrock', 'azure-openai', 'openrouter'] as const;
export type ModelApiRoute = (typeof MODEL_API_ROUTES)[number];

export const isModelApiRoute = (value: unknown): value is ModelApiRoute =>
  typeof value === 'string' && (MODEL_API_ROUTES as readonly string[]).includes(value);

export const MODEL_API_NAMES: Record<ModelApiRoute, string> = {
  'aws-bedrock': 'AWS Bedrock (GPT-5.6 Luna)',
  'azure-openai': 'Azure OpenAI',
  openrouter: 'OpenRouter',
};

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
