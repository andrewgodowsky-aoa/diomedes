/**
 * What AI setup shows for the Azure OpenAI and OpenRouter model-API routes,
 * computed from the host's own views (`GET /api/ai/model-api/azure-openai` and
 * `/openrouter`). Pure, so every sentence a person reads here is testable
 * without a browser. The AWS card has its own module (`aws-bedrock-view.ts`);
 * the money and spend-limit rules are shared from there, not copied.
 *
 * The request bodies are exactly the ones `server/engines/provider-routes.ts`
 * accepts. The format rules for names (resource, deployment, model id,
 * endpoint) live on the host alone: this module checks only what is missing,
 * and the host's refusal sentence is shown as it arrives.
 */
import type {
  AzureConnectionView,
  DeclaredRatesView,
  ModelApiReadiness,
  OpenRouterConnectionView,
} from '../shared/model-api';
import { routeDisplayName } from '../shared/engines';
import { usd } from './aws-bedrock-view';

export const PROVIDER_MIN_KEY_LENGTH = 20;

export type ProviderView = AzureConnectionView | OpenRouterConnectionView;

export interface ProviderStateRow {
  key: 'connection' | 'key' | 'limit' | 'route';
  label: string;
  text: string;
  value: 'ok' | 'waiting' | 'blocked';
}

/** One line naming what the saved connection points at. */
export function connectionSummary(view: ProviderView): string | null {
  if (!view.connection) return null;
  if (view.route === 'azure-openai') {
    const c = (view as AzureConnectionView).connection!;
    const models = c.deployments.map((entry) => `${entry.model} → ${entry.deployment}`).join(', ');
    return `${c.resource} · ${models}`;
  }
  const c = (view as OpenRouterConnectionView).connection!;
  return c.models.map((entry) => `${entry.id} (${entry.upstreams.join(', ')})`).join(', ');
}

/** The four facts a person needs before sending, in the order they are set up. */
export function providerStateRows(view: ProviderView, nowMs = Date.now()): ProviderStateRow[] {
  const connection = view.connection;
  const spend = view.spend;
  const expiresAt = connection?.credential.expiresAt ? Date.parse(connection.credential.expiresAt) : null;
  return [
    {
      key: 'connection',
      label: view.route === 'azure-openai' ? 'Azure resource' : 'Allowed models',
      text: connectionSummary(view) ?? 'Not connected',
      value: connection ? 'ok' : 'waiting',
    },
    {
      key: 'key',
      label: 'API key',
      text: !connection
        ? view.protectedStorage
          ? 'None saved'
          : 'Protected storage is not available here'
        : connection.credential.expired
          ? 'Expired: enter a new key'
          : expiresAt !== null
            ? `Saved, expires ${new Date(expiresAt).toLocaleString()}${expiresAt - nowMs < 24 * 3_600_000 ? ' (soon)' : ''}`
            : 'Saved, no expiry given',
      value: !connection ? (view.protectedStorage ? 'waiting' : 'blocked') : connection.credential.expired ? 'blocked' : 'ok',
    },
    {
      key: 'limit',
      label: 'Spend limit',
      text: !spend
        ? 'Not set'
        : spend.capMicroUsd === 0
          ? 'Not approved: nothing can be sent'
          : `${usd(spend.capMicroUsd)} approved, ${usd(spend.availableMicroUsd)} left`,
      value: !spend || spend.capMicroUsd === 0 ? 'waiting' : spend.availableMicroUsd > 0 ? 'ok' : 'blocked',
    },
    {
      key: 'route',
      label: 'Route',
      text: view.enabled ? 'On' : 'Off',
      value: view.enabled ? 'ok' : 'waiting',
    },
  ];
}

/** Prices as the owner reads them on a price page: dollars per million tokens. */
export interface RatesInput {
  input: string;
  output: string;
  /** Empty when the provider does not price it. */
  cacheRead: string;
  cacheWrite: string;
  source: string;
}

export const emptyRates = (): RatesInput => ({ input: '', output: '', cacheRead: '', cacheWrite: '', source: '' });

/** A saved price back into the form, so replacing a key does not mean retyping every price. */
export function ratesInputFrom(rates: DeclaredRatesView): RatesInput {
  const dollars = (micro: number | null) => (micro === null ? '' : String(micro / 1_000_000));
  return {
    input: dollars(rates.input),
    output: dollars(rates.output),
    cacheRead: dollars(rates.cacheRead),
    cacheWrite: dollars(rates.cacheWrite),
    source: rates.source,
  };
}

type Parsed<T> = { ok: true; body: T } | { ok: false; message: string };

export interface RatesBody {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number | null;
  cacheWriteUsdPerMillion: number | null;
  source: string;
}

/** The host's `rates` object, or the sentence that says which price is missing. */
export function ratesBody(rates: RatesInput, what: string): Parsed<RatesBody> {
  const required = (value: string) => {
    const n = Number(value);
    return value.trim() && Number.isFinite(n) && n > 0 ? n : null;
  };
  const optional = (value: string) => {
    if (!value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const input = required(rates.input);
  const output = required(rates.output);
  if (input === null || output === null)
    return { ok: false, message: `Enter the input and output prices for ${what}, in dollars per million tokens.` };
  const cacheRead = optional(rates.cacheRead);
  const cacheWrite = optional(rates.cacheWrite);
  if (cacheRead === undefined || cacheWrite === undefined)
    return { ok: false, message: `Enter the cache prices for ${what} as dollar amounts, or leave them empty.` };
  if (!rates.source.trim()) return { ok: false, message: `Say where the prices for ${what} come from.` };
  return {
    ok: true,
    body: {
      inputUsdPerMillion: input,
      outputUsdPerMillion: output,
      cacheReadUsdPerMillion: cacheRead,
      cacheWriteUsdPerMillion: cacheWrite,
      source: rates.source.trim(),
    },
  };
}

/** A `datetime-local` value as the host's ISO expiry, or why it cannot be used. */
export function expiryBody(expiresLocal: string, nowMs = Date.now()): Parsed<string | null> {
  if (!expiresLocal) return { ok: true, body: null };
  const at = Date.parse(expiresLocal);
  if (!Number.isFinite(at)) return { ok: false, message: 'Enter the key’s expiry as a date and time, or leave it empty.' };
  if (at <= nowMs + 60_000) return { ok: false, message: 'That key has already expired. Create a new one.' };
  return { ok: true, body: new Date(at).toISOString() };
}

export interface AzureDeploymentInput {
  model: string;
  deployment: string;
  reasoning: boolean;
  rates: RatesInput;
}

export const emptyAzureDeployment = (): AzureDeploymentInput => ({
  model: '',
  deployment: '',
  reasoning: true,
  rates: emptyRates(),
});

export interface AzureConnectInput {
  resourceName: string;
  deployments: AzureDeploymentInput[];
  apiKey: string;
  expiresLocal: string;
  consent: boolean;
}

/** The Azure connect body, or the one sentence that says what is missing. The key is never echoed. */
export function azureConnectBody(input: AzureConnectInput, nowMs = Date.now()): Parsed<Record<string, unknown>> {
  const resourceName = input.resourceName.trim();
  if (!resourceName) return { ok: false, message: 'Enter the Azure OpenAI resource name.' };
  if (input.deployments.length === 0) return { ok: false, message: 'Add at least one deployment.' };
  const deployments: Record<string, unknown>[] = [];
  for (const [index, entry] of input.deployments.entries()) {
    const what = entry.model.trim() || `deployment ${index + 1}`;
    if (!entry.model.trim() || !entry.deployment.trim())
      return { ok: false, message: `Name the model and the deployment for ${what}.` };
    const rates = ratesBody(entry.rates, what);
    if (!rates.ok) return rates;
    deployments.push({
      model: entry.model.trim(),
      deployment: entry.deployment.trim(),
      reasoning: entry.reasoning,
      rates: rates.body,
    });
  }
  const apiKey = input.apiKey.trim();
  if (apiKey.length < PROVIDER_MIN_KEY_LENGTH) return { ok: false, message: 'Paste the API key for this Azure OpenAI resource.' };
  const expiry = expiryBody(input.expiresLocal, nowMs);
  if (!expiry.ok) return expiry;
  if (!input.consent)
    return { ok: false, message: 'Confirm that conversations and chosen files may be sent to this Azure OpenAI resource.' };
  return { ok: true, body: { resourceName, deployments, apiKey, expiresAt: expiry.body, consent: true } };
}

/** The saved Azure connection back into the form, without the key. */
export function azureInputFrom(view: AzureConnectionView | null): Pick<AzureConnectInput, 'resourceName' | 'deployments'> {
  const c = view?.connection;
  if (!c) return { resourceName: '', deployments: [emptyAzureDeployment()] };
  return {
    resourceName: c.resource,
    deployments: c.deployments.map((entry) => ({
      model: entry.model,
      deployment: entry.deployment,
      reasoning: entry.reasoning,
      rates: ratesInputFrom(entry.rates),
    })),
  };
}

export interface OpenRouterModelInput {
  id: string;
  /** Endpoint names separated by commas or spaces. */
  upstreams: string;
  rates: RatesInput;
}

export const emptyOpenRouterModel = (): OpenRouterModelInput => ({ id: '', upstreams: '', rates: emptyRates() });

export interface OpenRouterConnectInput {
  models: OpenRouterModelInput[];
  apiKey: string;
  expiresLocal: string;
  consent: boolean;
}

export const splitList = (value: string) =>
  [...new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean))];

/** The OpenRouter connect body, or the one sentence that says what is missing. The key is never echoed. */
export function openRouterConnectBody(input: OpenRouterConnectInput, nowMs = Date.now()): Parsed<Record<string, unknown>> {
  if (input.models.length === 0) return { ok: false, message: 'Allow at least one model.' };
  const models: Record<string, unknown>[] = [];
  for (const [index, entry] of input.models.entries()) {
    const what = entry.id.trim() || `model ${index + 1}`;
    if (!entry.id.trim()) return { ok: false, message: `Enter the model id for ${what}, such as vendor/model.` };
    const upstreams = splitList(entry.upstreams);
    if (upstreams.length === 0) return { ok: false, message: `Name at least one endpoint ${what} may run on.` };
    const rates = ratesBody(entry.rates, what);
    if (!rates.ok) return rates;
    models.push({ id: entry.id.trim(), upstreams, rates: rates.body });
  }
  const apiKey = input.apiKey.trim();
  if (apiKey.length < PROVIDER_MIN_KEY_LENGTH) return { ok: false, message: 'Paste the OpenRouter API key.' };
  const expiry = expiryBody(input.expiresLocal, nowMs);
  if (!expiry.ok) return expiry;
  if (!input.consent)
    return { ok: false, message: 'Confirm that conversations and chosen files may be sent to OpenRouter under this key.' };
  return { ok: true, body: { models, apiKey, expiresAt: expiry.body, consent: true } };
}

/** The saved OpenRouter allow-list back into the form, without the key. */
export function openRouterInputFrom(view: OpenRouterConnectionView | null): Pick<OpenRouterConnectInput, 'models'> {
  const c = view?.connection;
  if (!c) return { models: [emptyOpenRouterModel()] };
  return {
    models: c.models.map((entry) => ({
      id: entry.id,
      upstreams: entry.upstreams.join(', '),
      rates: ratesInputFrom(entry.rates),
    })),
  };
}

/**
 * The offline readiness answer as lines: each check the host ran, failed ones
 * first. The host's own note travels with it unchanged.
 */
export function readinessLines(readiness: ModelApiReadiness): { id: string; ok: boolean; text: string }[] {
  return [...readiness.checks]
    .sort((a, b) => Number(a.ok) - Number(b.ok))
    .map((check) => ({ id: check.id, ok: check.ok, text: check.detail }));
}

/**
 * The models a thread's picker offers on this route: one per Azure deployment or allowed
 * OpenRouter model. `where` is what serves it: the deployment, or the only endpoints it may use.
 */
export function providerModels(view: ProviderView | null): { slug: string; where: string }[] {
  if (!view?.connection) return [];
  if (view.route === 'azure-openai')
    return (view as AzureConnectionView).connection!.deployments.map((entry) => ({
      slug: entry.model,
      where: entry.deployment,
    }));
  return (view as OpenRouterConnectionView).connection!.models.map((entry) => ({
    slug: entry.id,
    where: entry.upstreams.join(', '),
  }));
}

/**
 * Whether a thread's picker offers this route, and if not, the one sentence
 * that says why. The same rule as AWS: offered only when the host reports
 * nothing blocking a send, so the menu never offers a route admission refuses.
 */
export function providerPickerState(view: ProviderView | null): { offered: boolean; note: string | null } {
  if (!view || !view.connection) return { offered: false, note: null };
  if (!view.enabled) return { offered: false, note: null };
  if (view.next) return { offered: false, note: `${routeDisplayName(view.route)} is on but not ready: ${view.next}` };
  return { offered: true, note: null };
}

/** Whether this route is the one new work takes. Connecting never makes it so by itself. */
export function providerIsDefault(route: ProviderView['route'], services: Record<string, unknown> | undefined): boolean {
  return services?.defaultEngine === route;
}
