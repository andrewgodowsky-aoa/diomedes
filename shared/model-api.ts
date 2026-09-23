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
  spend: {
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
  } | null;
  /** The one thing to do next, when something blocks sending. */
  next: string | null;
}
