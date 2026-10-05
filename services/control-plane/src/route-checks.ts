/**
 * Gateway route checks (DIO-217): the five route checks of `shared/route-qualification.ts`, run by
 * Operations on one saved managed route through the gateway's own provider call
 * (`callManagedProvider`, the call customer requests take), with the Worker's company credential
 * for the route's approved connection. `POST /ops/routes/:id/checks` (`shared/gateway-route-checks.ts`).
 *
 * The checks, their prompts and their output limits are the desktop's own
 * (`shared/route-qualification-plan.ts`), and each judges what the desktop's judges. The path is the
 * gateway's: every call is a gateway Responses body sent on the route's binding, read back from the
 * stream the gateway normalizes for customers, with the usage reading settlement uses, and priced the
 * way settlement prices it (`nectovia-usage/1`).
 *
 * There is no customer, so there is no hold. The run is bounded before anything is sent: every planned
 * call's estimate on the route's own prices, the same estimate a customer call is held at. It is refused
 * when that bound, company spend and earlier route checks together would pass the company spend ceiling,
 * and it is recorded in one `ops_audit` row with its receipt and its spend. Customer holds do not count
 * that row: the funding login cannot read `ops_audit`. Two runs at once can each pass the check, so the
 * ceiling can be passed by at most one run's bound.
 *
 * The gateway sends no cache setting, so the no-cache check cannot be made here: it is recorded as
 * unsupported, with no call. Nothing here writes the route.
 */
import { staffCan } from '../../../shared/access.js';
import {
  ROUTE_CHECKS_AUDIT_ACTION,
  ROUTE_CHECKS_REFUSALS,
  ROUTE_CHECKS_SCOPE_KEY,
  type RouteChecksInput,
  type RouteChecksRefusal,
  type RouteChecksResult,
} from '../../../shared/gateway-route-checks.js';
import { micro, usageCost, type MicroUsd, type RateSnapshot } from '../../../shared/managed-usage.js';
import {
  CACHE_PREFIX,
  CHECK_OUTPUT_TOKENS,
  INSTRUCTIONS,
  LOOKUP_FACT_TOOL,
  OUTPUT_BOUND_ASK,
  OUTPUT_BOUND_TOKENS,
  SHORT_ANSWER,
  TOOL_ASK,
  TOOL_KEY,
  TOOL_VALUE,
} from '../../../shared/route-qualification-plan.js';
import {
  QUALIFICATION_CHECKS,
  QUALIFICATION_VALID_DAYS,
  ROUTE_QUALIFICATION_VERSION,
  receiptQualifies,
  routeQualificationReceiptSchema,
  type QualifiableRoute,
  type QualificationCall,
  type QualificationCheck,
  type QualificationCheckId,
  type QualificationIdentity,
  type QualificationOutcome,
  type QualificationProtocol,
  type QualificationUsage,
  type QualificationVerdicts,
  type RouteQualificationReceipt,
} from '../../../shared/route-qualification.js';
import { bindingProblems, estimateRouteCost, type ModelBinding, type ProviderConnection } from '../../../shared/routing-policy.js';
import { inputTokenBound } from '../../../shared/token-bound.js';
import { normalizeUsage } from '../../../shared/usage-contract.js';
import type { AccountService } from './account-service.js';
import type { AuditEvent, CommercialRepository, RouteEntry } from './commercial.js';
import { AccountError } from './errors.js';
import { RELEASABLE_REFUSALS, type FundingRepository } from './funding.js';
import { PostgresFundingTransaction } from './funding-postgres.js';
import { approvedConnections, callManagedProvider, connectionCredential, providerBody, providerEndpoint } from './managed-bindings.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  providerMessage,
  responsesUsage,
  scrubbed,
  spendControls,
  validateResponsesBody,
  type ResponsesBody,
} from './managed-inference.js';
import { BindingError, sseObjects } from './managed-normalization.js';
import { inTransaction, type ClientFactory } from './postgres.js';

type Item = Record<string, unknown>;
const isObject = (value: unknown): value is Item => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const clip = (value: string | null, max: number) => (value === null ? null : Array.from(value).slice(0, max).join(''));
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;
const DAY_MS = 86_400_000;

/** A saved route with the binding the checks run on. */
export type CheckedRoute = RouteEntry & { binding: ModelBinding };

/** The receipt's sdk field: the gateway's own call, not a desktop SDK. */
export const GATEWAY_ROUTE_CHECKS_SDK = 'nectovia-gateway callManagedProvider';
/** The effort every call asks for when its route reasons. */
export const ROUTE_CHECKS_EFFORT = 'low' as const;
/** What the no-cache check says: there is no request to make through the gateway. */
export const CACHE_OFF_UNSUPPORTED = 'The gateway sends no cache setting, so this route cannot make a no-cache request.';
/**
 * The tool round trip's second call carries the model's tool call back. The plan cannot know those
 * bytes, so it allows this many in their place, as the desktop's plan does. The real call is sent
 * only when its own estimate stays inside the planned one.
 */
const ANSWER_ALLOWANCE_BYTES = 16 * CHECK_OUTPUT_TOKENS;

const PROTOCOLS: Partial<Record<ModelBinding['protocol'], QualificationProtocol>> = {
  responses: 'openai-responses',
  'chat-completions': 'openai-chat-completions',
};
const LABELS: Record<QualifiableRoute, string> = { 'aws-bedrock': 'AWS', 'azure-openai': 'Azure' };
const isQualifiable = (provider: string): provider is QualifiableRoute => provider === 'aws-bedrock' || provider === 'azure-openai';

/** Dollars as a person reads them, to the cent, rounded up. */
const centsUp = (microUsd: number) => `$${(Math.ceil(microUsd / 10_000) / 100).toFixed(2)}`;

const refusal = (code: RouteChecksRefusal, message: string) => new AccountError(ROUTE_CHECKS_REFUSALS[code], message, code);

// --- the plan ---------------------------------------------------------------------------

export interface PlannedRouteCheck {
  check: QualificationCheckId;
  /** The call's place in its check, from 1. */
  n: number;
  body: ResponsesBody;
  /** The most this call may spend: the gateway's estimate for it, as a customer call is held. */
  boundMicroUsd: MicroUsd;
}

export interface RouteChecksPlan {
  shortAnswer: PlannedRouteCheck;
  outputBound: PlannedRouteCheck;
  toolAsk: PlannedRouteCheck;
  /** Planned with an allowance in place of the model's tool call; sent with the real one. */
  toolAnswer: PlannedRouteCheck;
  cacheDefault: readonly [PlannedRouteCheck, PlannedRouteCheck];
  /** Every planned call's bound together: the most one run can spend. */
  boundMicroUsd: MicroUsd;
}

const userMessage = (content: string): Item => ({ role: 'user', content });
const lookupFact = (): Item => ({
  type: 'function', name: LOOKUP_FACT_TOOL.name, description: LOOKUP_FACT_TOOL.description, parameters: LOOKUP_FACT_TOOL.parameters,
});
const toolCall = (call: { callId: string; name: string; arguments: string }): Item =>
  ({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments });
const toolResult = (callId: string): Item => ({ type: 'function_call_output', call_id: callId, output: JSON.stringify({ value: TOOL_VALUE }) });

/**
 * One call as a gateway Responses body: the instructions, the input, the tool where the check offers
 * it, the output limit, and low reasoning effort when the route reasons. Null when the body is not one
 * the gateway accepts from a customer.
 */
function checkBody(route: CheckedRoute, instructions: string, input: Item[], maxOutputTokens: number, tools: boolean): ResponsesBody | null {
  const checked = validateResponsesBody({
    model: route.model,
    instructions,
    input,
    ...(tools ? { tools: [lookupFact()] } : {}),
    max_output_tokens: maxOutputTokens,
    ...(route.binding.capabilities.reasoning ? { reasoning: { effort: ROUTE_CHECKS_EFFORT } } : {}),
  });
  return checked.ok ? checked.body : null;
}

/**
 * The gateway's own bound for one call: the estimate a customer call is held at (`runScoped`), on
 * the larger of the body's and the provider request's input bounds and the call's output limit at
 * the dearest output or reasoning price, and never less than one micro-USD.
 */
export function callBoundMicroUsd(route: CheckedRoute, connection: ProviderConnection, body: ResponsesBody, allowanceBytes = 0): MicroUsd {
  const messages = body.input.length;
  const own = inputTokenBound(byteLength(JSON.stringify(body)) + allowanceBytes, messages);
  const sent = inputTokenBound(byteLength(providerBody(route, connection, body)) + allowanceBytes, messages);
  const estimate = estimateRouteCost(route.binding.price, { inputTokens: Math.max(own, sent), outputTokens: body.max_output_tokens ?? 0 });
  return micro(Math.max(1, estimate));
}

/**
 * Every call a run can make, each with its bound. Throws the provider binding's own refusal
 * (`BindingError`) when the route cannot take one of them, such as an output limit below the checks'.
 */
export function planRouteChecks(route: CheckedRoute, connection: ProviderConnection): RouteChecksPlan {
  const planned = (check: QualificationCheckId, n: number, instructions: string, input: Item[], maxOutputTokens: number, tools: boolean, allowanceBytes = 0) => {
    const body = checkBody(route, instructions, input, maxOutputTokens, tools);
    if (!body) throw new BindingError('invalid_check_body', 'A check request is not one the gateway accepts.');
    return { check, n, body, boundMicroUsd: callBoundMicroUsd(route, connection, body, allowanceBytes) };
  };
  const placeholder = { callId: 'call_planned', name: LOOKUP_FACT_TOOL.name, arguments: JSON.stringify({ key: TOOL_KEY }) };
  const shortAnswer = planned('short-answer', 1, INSTRUCTIONS, [userMessage(SHORT_ANSWER)], CHECK_OUTPUT_TOKENS, false);
  const outputBound = planned('output-bound', 1, INSTRUCTIONS, [userMessage(OUTPUT_BOUND_ASK)], OUTPUT_BOUND_TOKENS, false);
  const toolAsk = planned('tool-round-trip', 1, INSTRUCTIONS, [userMessage(TOOL_ASK)], CHECK_OUTPUT_TOKENS, true);
  const toolAnswer = planned('tool-round-trip', 2, INSTRUCTIONS,
    [userMessage(TOOL_ASK), toolCall(placeholder), toolResult(placeholder.callId)], CHECK_OUTPUT_TOKENS, true, ANSWER_ALLOWANCE_BYTES);
  // The cache check sends no cache field at all, exactly as an ordinary call goes out.
  const cacheDefault = [1, 2].map((n) => planned('cache-default', n, CACHE_PREFIX, [userMessage(SHORT_ANSWER)], CHECK_OUTPUT_TOKENS, false)) as
    [PlannedRouteCheck, PlannedRouteCheck];
  const calls = [shortAnswer, outputBound, toolAsk, toolAnswer, ...cacheDefault];
  return { shortAnswer, outputBound, toolAsk, toolAnswer, cacheDefault, boundMicroUsd: micro(calls.reduce((sum, call) => sum + call.boundMicroUsd, 0)) };
}

// --- the receipt's identity -------------------------------------------------------------

/** The exact identity a receipt from this route binds, or null when the checks cannot describe it. */
export function routeCheckIdentity(route: CheckedRoute, connection: ProviderConnection): QualificationIdentity | null {
  const protocol = PROTOCOLS[route.binding.protocol];
  if (!isQualifiable(connection.provider) || !protocol) return null;
  return {
    route: connection.provider,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    model: route.model,
    protocol,
    rateCard: route.binding.price.version,
    deployment: connection.provider === 'azure-openai' ? route.binding.deployment : null,
  };
}

/** `rq_` and 24 random lowercase hex characters. */
export function newReceiptId(): string {
  return `rq_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const SKELETON_VERDICTS: QualificationVerdicts = {
  answers: false,
  outputBound: 'unknown',
  tools: 'unknown',
  cacheDefault: 'unknown',
  cacheOff: 'unsupported',
};

function receiptHead(route: CheckedRoute, connection: ProviderConnection, identity: QualificationIdentity, id: string, createdAt: number) {
  return {
    v: ROUTE_QUALIFICATION_VERSION,
    id,
    createdAt: new Date(createdAt).toISOString(),
    validUntil: new Date(createdAt + QUALIFICATION_VALID_DAYS * DAY_MS).toISOString(),
    route: identity.route,
    connectionId: identity.connectionId,
    connectionRevision: identity.connectionRevision,
    endpoint: providerEndpoint(route, connection),
    deployment: identity.deployment,
    model: identity.model,
    protocol: identity.protocol,
    sdk: GATEWAY_ROUTE_CHECKS_SDK,
    effort: ROUTE_CHECKS_EFFORT,
    rateCard: identity.rateCard,
  };
}

/** Whether the identity makes a valid receipt, checked before anything is spent on it. */
export function receiptIdentityValid(route: CheckedRoute, connection: ProviderConnection, identity: QualificationIdentity, id: string, createdAt: number): boolean {
  return routeQualificationReceiptSchema.safeParse({
    ...receiptHead(route, connection, identity, id, createdAt),
    servedModels: [],
    checks: QUALIFICATION_CHECKS.map((check) => ({ id: check, outcome: 'not-run', detail: 'Not run.', calls: [] })),
    verdicts: SKELETON_VERDICTS,
    spend: { settledMicroUsd: 0, uncertainMicroUsd: 0 },
  }).success;
}

// --- one run ----------------------------------------------------------------------------

export interface RouteChecksRun {
  route: CheckedRoute;
  connection: ProviderConnection;
  credential: string;
  plan: RouteChecksPlan;
  /**
   * The provider transport. Only ever passed to `callManagedProvider` and called as a plain
   * function, never as a member, so a bare global fetch would work; the Worker wraps it anyway.
   */
  transport: typeof globalThis.fetch;
  receiptId: string;
  now?: () => number;
  /** How long the provider may stay silent: before it answers, and between events. */
  idleTimeoutMs?: number;
}

export interface RouteChecksOutcome {
  receipt: RouteQualificationReceipt;
  boundMicroUsd: number;
  spentMicroUsd: number;
  uncertainMicroUsd: number;
}

/** What one call came back with, beside the call the receipt records. */
interface Sent {
  call: QualificationCall;
  dispatched: boolean;
  status: number | null;
  terminal: 'completed' | 'incomplete' | null;
  incompleteReason: string | null;
  usage: QualificationUsage | null;
  /** The visible answer of a completed exchange; empty when there is none. */
  text: string;
  tools: { callId: string; name: string; arguments: string }[];
  /** Why the exchange gave no usable outcome; null when it ended with one. */
  code: string | null;
}

/** Settle for the first of a promise or a deadline; the deadline runs `onTimeout` and rejects. */
function within<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('The provider went silent.'));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const PROVIDER_REQUEST_ID_HEADERS = ['x-amzn-requestid', 'x-request-id', 'request-id', 'apim-request-id'];

/** The route's prices as settlement reads them. */
function rateOf(price: ModelBinding['price']): RateSnapshot {
  return {
    version: price.version,
    inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: price.outputMicroUsdPerMillion,
    reasoningMicroUsdPerMillion: price.reasoningMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: price.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: price.cacheWriteMicroUsdPerMillion,
    requestFeeMicroUsd: price.requestFeeMicroUsd,
    longContext: price.longContext,
  };
}

/**
 * Runs the checks on one route and returns the receipt, validated, with the run's spend. Never
 * retries a call. A call that fails before it is sent spends nothing; one the provider refused with a
 * status it does not bill (the gateway's releasable refusals) spends nothing; one that reported usage
 * is priced from it; any other sent call is uncertain at its bound.
 */
export async function runRouteChecks(run: RouteChecksRun): Promise<RouteChecksOutcome> {
  const { route, connection, credential, plan } = run;
  const transport = run.transport;
  const now = run.now ?? Date.now;
  const idleTimeoutMs = run.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const identity = routeCheckIdentity(route, connection);
  if (!identity) throw new BindingError('protocol_unsupported', 'The route checks cover Bedrock and Azure OpenAI routes on the Responses and Chat Completions protocols only.');
  const label = LABELS[identity.route];
  const rate = rateOf(route.binding.price);
  const createdAt = now();
  const scrub = (value: string) => scrubbed(value, credential);

  const send = async (planned: PlannedRouteCheck, body: ResponsesBody = planned.body, bound: number = planned.boundMicroUsd): Promise<Sent> => {
    const started = now();
    const abort = new AbortController();
    let timedOut = false;
    const onTimeout = () => { timedOut = true; abort.abort(); };
    let dispatched = false;
    // Marks the moment the request leaves: from here on a failure may have been billed.
    const tracked = ((input: RequestInfo | URL, init?: RequestInit) => { dispatched = true; return transport(input, init); }) as typeof globalThis.fetch;
    let response: Response | null = null;
    let failure: { code: string; message: string } | null = null;
    let terminal: Item | null = null;
    let terminalType = '';
    try {
      response = await within(callManagedProvider({ route, connection, credential, body, signal: abort.signal, scopeKey: ROUTE_CHECKS_SCOPE_KEY }, tracked),
        idleTimeoutMs, onTimeout);
    } catch (error) {
      failure = !dispatched
        ? { code: error instanceof BindingError ? error.code : 'not_sent', message: error instanceof BindingError ? error.message : 'The gateway did not send this request.' }
        : timedOut ? { code: 'timeout', message: `${label} did not answer within the time limit.` }
          : { code: 'transport_failed', message: 'The request may have reached the provider, but no answer came back.' };
    }
    let status: number | null = response?.status ?? null;
    if (response && !response.ok) {
      const message = await within(providerMessage(response, credential), idleTimeoutMs, onTimeout).catch(() => null);
      failure = { code: status! >= 400 && status! < 500 ? 'provider_refused' : 'provider_error', message: message ?? `${label} answered HTTP ${status}.` };
    } else if (response) {
      if (!response.body) failure = { code: 'empty_stream', message: 'The provider returned no stream.' };
      else {
        const events = sseObjects(response.body);
        try {
          for (;;) {
            const next = await within(events.next(), idleTimeoutMs, onTimeout);
            if (next.done) break;
            const event = next.value;
            if ((event.type === 'response.completed' || event.type === 'response.incomplete') && isObject(event.response)) {
              terminal = event.response;
              terminalType = event.type;
            }
          }
        } catch (error) {
          abort.abort();
          void events.return(undefined).catch(() => undefined);
          if (!terminal)
            failure = timedOut ? { code: 'timeout', message: `${label} went silent in the middle of its answer.` }
              : error instanceof BindingError ? { code: error.code, message: error.message }
                : { code: 'stream_failed', message: 'The answer stream broke before it finished.' };
        }
        if (!terminal && !failure) failure = { code: 'incomplete_stream', message: 'The answer stream ended without a final outcome.' };
      }
    }
    if (!dispatched) status = null;

    const usageReport = terminal && isObject(terminal.usage) ? normalizeUsage(responsesUsage(terminal.usage)) : null;
    const usage: QualificationUsage | null = usageReport?.state === 'known'
      ? {
          inputTokens: usageReport.usage.inputTokens,
          cacheReadTokens: usageReport.usage.cacheReadTokens,
          cacheWriteTokens: usageReport.usage.cacheWriteTokens,
          outputTokens: usageReport.usage.outputTokens,
          reasoningTokens: usageReport.usage.reasoningTokens,
        }
      : null;
    const output = terminal ? list(terminal.output).filter(isObject) : [];
    const parts = output.filter((item) => item.type === 'message').flatMap((item) => list(item.content).filter(isObject));
    const answer = parts.filter((part) => part.type === 'output_text').map((part) => text(part.text)).join('');
    const refused = parts.some((part) => part.type === 'refusal');
    const tools = output.filter((item) => item.type === 'function_call')
      .map((item) => ({ callId: text(item.call_id), name: text(item.name), arguments: text(item.arguments) }));
    const incompleteReason = terminalType === 'response.incomplete' && isObject(terminal?.incomplete_details) ? text(terminal.incomplete_details.reason) || null : null;
    const outcome: Sent['terminal'] = terminalType === 'response.completed' ? 'completed' : terminalType === 'response.incomplete' ? 'incomplete' : null;
    const finish: QualificationCall['finish'] = !dispatched ? 'not-sent'
      : outcome === 'completed' ? (tools.length ? 'tool-call' : refused ? 'refused' : 'completed')
        : outcome === 'incomplete' ? (incompleteReason === 'content_filter' ? 'refused' : 'incomplete')
          : status !== null && status >= 400 && status < 500 ? 'refused' : 'error';
    let ledger: QualificationCall['ledger'] = null;
    if (dispatched) {
      if (status !== null && !response!.ok && RELEASABLE_REFUSALS.includes(status)) ledger = { state: 'released', microUsd: 0 };
      else if (usage) {
        try { ledger = { state: 'settled', microUsd: usageCost(rate, usage) }; }
        catch { ledger = { state: 'uncertain', microUsd: bound }; }
      } else ledger = { state: 'uncertain', microUsd: bound };
    }
    const requestId = response ? PROVIDER_REQUEST_ID_HEADERS.map((name) => response!.headers.get(name)).find((value) => !!value) ?? null : null;
    const call: QualificationCall = {
      status: status !== null && status >= 100 && status <= 599 ? status : null,
      providerRequestId: clip(requestId, 200),
      responseId: clip(terminal && typeof terminal.id === 'string' ? terminal.id : null, 200),
      reportedModel: clip(terminal && typeof terminal.model === 'string' ? terminal.model : null, 200),
      finish,
      incompleteReason: clip(incompleteReason, 100),
      maxOutputTokens: body.max_output_tokens ?? 0,
      usage,
      error: terminal ? null : failure ? { code: clip(failure.code, 100), message: scrub(failure.message).slice(0, 500) } : null,
      ledger,
      elapsedMs: Math.max(0, now() - started),
    };
    return { call, dispatched, status: call.status, terminal: outcome, incompleteReason, usage, text: answer, tools, code: terminal ? null : failure?.code ?? null };
  };

  /** One plain sentence for a call that did not give its check what it needed. */
  const failure = (sent: Sent): string => {
    if (!sent.dispatched) return 'The gateway did not send this request.';
    if (sent.code === 'timeout') return `${label} did not finish within the time limit.`;
    if (sent.status === 401 || sent.status === 403) return `${label} refused the key (HTTP ${sent.status}).`;
    if (sent.status !== null && sent.status >= 500) return `${label} answered with a server error (HTTP ${sent.status}).`;
    if (sent.status !== null && sent.status >= 400) return `${label} refused the request (HTTP ${sent.status}).`;
    if (sent.status !== null && sent.status >= 300) return `${label} answered with a redirect (HTTP ${sent.status}). The gateway does not follow redirects.`;
    if (sent.status === null) return `No answer came back from ${label}.`;
    if (sent.code === 'served_model_mismatch') return `${label} reported serving a model this route does not name.`;
    if (sent.code !== null && sent.terminal === null) return 'The answer stream broke before it finished.';
    if (sent.terminal === 'incomplete')
      return sent.incompleteReason === 'max_output_tokens'
        ? 'The answer stopped at its output limit before it was complete.'
        : 'The answer stopped before it was complete.';
    if (!sent.usage) return `${label} did not report usage.`;
    return 'The answer could not be used.';
  };
  /** A request shape the provider refused with its own sentence: the statuses the gateway reads it for. */
  const refusedShape = (sent: Sent) => sent.status === 400 || sent.status === 413 || sent.status === 422;
  const unacceptableTool = (sent: Sent) => sent.code === 'parallel_tools' || sent.code === 'invalid_tool_stream';
  const check = (id: QualificationCheckId, outcome: QualificationOutcome, detail: string, calls: Sent[]): QualificationCheck => ({
    id, outcome, detail: detail.slice(0, 500), calls: calls.map((sent) => sent.call),
  });

  const verdicts: QualificationVerdicts = { ...SKELETON_VERDICTS };
  const runners: Record<QualificationCheckId, () => Promise<{ check: QualificationCheck; stop?: string }>> = {
    'short-answer': async () => {
      const sent = await send(plan.shortAnswer);
      const final = sent.terminal === 'completed' && sent.tools.length === 0;
      if (final && /\bok\b/i.test(sent.text) && sent.usage) {
        verdicts.answers = true;
        return { check: check('short-answer', 'passed', 'Answered OK in full, with usage reported.', [sent]) };
      }
      const detail = final && /\bok\b/i.test(sent.text) ? `${label} did not report usage.`
        : final ? 'Answered in full, but not with the word OK.'
          : sent.terminal === 'completed' ? 'Asked for a tool instead of answering.' : failure(sent);
      // A first check that fails on the key, the network, a redirect or a server error ends the run.
      const stop = sent.status === 401 || sent.status === 403 ? `Not run: ${label} refused the key on the first check.`
        : sent.status !== null && sent.status >= 500 ? `Not run: ${label} answered the first check with a server error.`
          : sent.status !== null && sent.status >= 300 && sent.status < 400 ? `Not run: ${label} answered the first check with a redirect.`
            : sent.dispatched && sent.status === null ? `Not run: no answer came back from ${label} on the first check.`
              : undefined;
      return { check: check('short-answer', 'failed', detail, [sent]), stop };
    },
    'output-bound': async () => {
      const sent = await send(plan.outputBound);
      const counted = sent.terminal === 'completed' || (sent.terminal === 'incomplete' && sent.incompleteReason === 'max_output_tokens');
      const reported = (usage: QualificationUsage) =>
        `Reported ${usage.outputTokens} billed output tokens, reasoning included, for a limit of ${OUTPUT_BOUND_TOKENS}.`;
      if (sent.usage && sent.usage.outputTokens > OUTPUT_BOUND_TOKENS) {
        verdicts.outputBound = 'exceeded';
        return { check: check('output-bound', 'failed', reported(sent.usage), [sent]) };
      }
      if (sent.usage && counted) {
        verdicts.outputBound = 'bounded';
        return { check: check('output-bound', 'passed', reported(sent.usage), [sent]) };
      }
      if (refusedShape(sent)) return { check: check('output-bound', 'unsupported', `${label} refused the request (HTTP ${sent.status}).`, [sent]) };
      return { check: check('output-bound', 'failed', `${failure(sent)} The output bound could not be read.`, [sent]) };
    },
    'tool-round-trip': async () => {
      const first = await send(plan.toolAsk);
      const asked = first.terminal === 'completed' && first.tools.length === 1 ? first.tools[0] : null;
      let args: unknown = null;
      try { args = asked ? JSON.parse(asked.arguments) : null; } catch { args = null; }
      if (!asked || asked.name !== LOOKUP_FACT_TOOL.name || !isObject(args) || args.key !== TOOL_KEY || Object.keys(args).length !== 1) {
        if (first.terminal === 'completed') {
          verdicts.tools = 'failed';
          const detail = first.tools.length > 1 ? 'Asked for a tool call this check cannot accept.'
            : !asked ? 'Answered without calling the offered tool.'
              : asked.name !== LOOKUP_FACT_TOOL.name ? 'Called a tool that was not offered.'
                : 'Called the tool with arguments other than the key alpha.';
          return { check: check('tool-round-trip', 'failed', detail, [first]) };
        }
        if (unacceptableTool(first)) {
          verdicts.tools = 'failed';
          return { check: check('tool-round-trip', 'failed', 'Asked for a tool call this check cannot accept.', [first]) };
        }
        if (refusedShape(first)) {
          verdicts.tools = 'failed';
          return { check: check('tool-round-trip', 'unsupported', `${label} refused the request with the tool (HTTP ${first.status}).`, [first]) };
        }
        return { check: check('tool-round-trip', 'failed', failure(first), [first]) };
      }
      // The second call carries the model's own tool call back, with the tool's result.
      const body = checkBody(route, INSTRUCTIONS, [userMessage(TOOL_ASK), toolCall(asked), toolResult(asked.callId)], CHECK_OUTPUT_TOKENS, true);
      let bound: number | null = null;
      try { bound = body ? callBoundMicroUsd(route, connection, body) : null; } catch { bound = null; }
      if (!body || bound === null || bound > plan.toolAnswer.boundMicroUsd) {
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'failed', 'Asked for a tool call this check cannot accept.', [first]) };
      }
      const second = await send(plan.toolAnswer, body, bound);
      const calls = [first, second];
      if (second.terminal === 'completed' && second.tools.length === 0) {
        if (second.text.includes(TOOL_VALUE)) {
          verdicts.tools = 'one-call';
          return { check: check('tool-round-trip', 'passed', 'Called lookup_fact with the key alpha, then answered from its result.', calls) };
        }
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'failed', 'Called the tool, but the answer did not use its result.', calls) };
      }
      if (second.terminal === 'completed') {
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'failed', 'Asked for a tool again instead of answering from the result.', calls) };
      }
      if (unacceptableTool(second)) {
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'failed', 'Asked for a tool call this check cannot accept.', calls) };
      }
      if (refusedShape(second)) {
        verdicts.tools = 'failed';
        return { check: check('tool-round-trip', 'unsupported', `${label} refused the tool result (HTTP ${second.status}).`, calls) };
      }
      return { check: check('tool-round-trip', 'failed', failure(second), calls) };
    },
    'cache-default': async () => {
      const first = await send(plan.cacheDefault[0]);
      // The second request is sent only when the first was processed: otherwise nothing could be cached.
      if (!first.usage) return { check: check('cache-default', 'failed', failure(first), [first]) };
      const second = await send(plan.cacheDefault[1]);
      const calls = [first, second];
      const a = first.usage;
      const b = second.usage;
      verdicts.cacheDefault =
        b && b.cacheReadTokens > 0 ? 'caches' : b && a.cacheReadTokens === 0 && b.cacheReadTokens === 0 ? 'no-cache-observed' : 'unknown';
      // This check observes; it does not judge. It passes when both requests completed with usage.
      if (first.terminal !== 'completed' || second.terminal !== 'completed' || !b)
        return { check: check('cache-default', 'failed', first.terminal === 'completed' ? failure(second) : failure(first), calls) };
      return {
        check: check(
          'cache-default',
          'passed',
          verdicts.cacheDefault === 'caches'
            ? `The second identical request read ${b.cacheReadTokens} input tokens from a cache.`
            : verdicts.cacheDefault === 'no-cache-observed'
              ? 'Neither identical request read from a cache.'
              : 'Both requests completed, and the first already read from a cache.',
          calls,
        ),
      };
    },
    // The gateway sends no cache field of any kind, so there is no no-cache request to make.
    'cache-off': async () => ({ check: check('cache-off', 'unsupported', CACHE_OFF_UNSUPPORTED, []) }),
  };

  const checks: QualificationCheck[] = [];
  let skip: string | null = null;
  for (const id of QUALIFICATION_CHECKS) {
    if (skip && id !== 'cache-off') {
      checks.push(check(id, 'not-run', skip, []));
      continue;
    }
    const ran = await runners[id]();
    checks.push(ran.check);
    if (ran.stop) skip = ran.stop;
  }

  const calls = checks.flatMap((entry) => entry.calls);
  const servedModels = [...new Set(calls.map((call) => call.reportedModel).filter((model): model is string => !!model))].slice(0, 8);
  const sum = (state: 'settled' | 'uncertain') =>
    calls.reduce((total, call) => total + (call.ledger?.state === state ? call.ledger.microUsd : 0), 0);
  const spentMicroUsd = sum('settled');
  const uncertainMicroUsd = sum('uncertain');
  const receipt = routeQualificationReceiptSchema.parse({
    ...receiptHead(route, connection, identity, run.receiptId, createdAt),
    servedModels,
    checks,
    verdicts,
    spend: { settledMicroUsd: spentMicroUsd, uncertainMicroUsd },
  });
  return { receipt, boundMicroUsd: plan.boundMicroUsd, spentMicroUsd, uncertainMicroUsd };
}

// --- spend before a run -------------------------------------------------------------------

/** What has already been spent against the company spend ceiling, read before a run. */
export interface RouteCheckSpend {
  /** Company spend as the gateway's ceiling counts it, and what earlier route checks spent or left uncertain, in micro-USD. */
  read(): Promise<{ companyMicroUsd: number; routeChecksMicroUsd: number }>;
}

/** Every earlier run's spent and uncertain amounts, from its audit row's detail. */
const ROUTE_CHECK_SPEND_SQL = `SELECT COALESCE(SUM(COALESCE((record->'detail'->>'spentMicroUsd')::bigint,0)
    + COALESCE((record->'detail'->>'uncertainMicroUsd')::bigint,0)),0) AS route_checks
  FROM control_plane.ops_audit WHERE record->>'action'=$1`;

function storedMicroUsd(value: unknown): number {
  const count = typeof value === 'string' ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Stored route check spend is not a safe whole number of micro-USD.');
  return count;
}

/**
 * On the Worker login (cp_runtime), which may read the funding rows and the audit rows: company spend
 * with the funding repository's own query, and earlier route checks from their audit rows.
 */
export function postgresRouteCheckSpend(factory: ClientFactory): RouteCheckSpend {
  return {
    read: () => inTransaction(factory, async (client) => ({
      companyMicroUsd: await new PostgresFundingTransaction(client).companySpend(),
      routeChecksMicroUsd: storedMicroUsd((await client.query(ROUTE_CHECK_SPEND_SQL, [ROUTE_CHECKS_AUDIT_ACTION])).rows[0]?.route_checks ?? 0),
    })),
  };
}

/** What earlier route checks spent or left uncertain, from their audit rows. */
export function routeCheckSpendOf(rows: readonly AuditEvent[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.action !== ROUTE_CHECKS_AUDIT_ACTION) continue;
    for (const value of [row.detail.spentMicroUsd, row.detail.uncertainMicroUsd])
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) total += value;
  }
  return total;
}

/** The same sums over repositories that keep their rows in memory: the faux cloud's store. */
export function stateRouteCheckSpend(funding: FundingRepository, commercial: CommercialRepository): RouteCheckSpend {
  return {
    read: async () => ({
      companyMicroUsd: await funding.transaction((tx) => tx.companySpend()),
      routeChecksMicroUsd: routeCheckSpendOf(await commercial.transaction((tx) => tx.auditLog({ limit: 1_000_000 }))),
    }),
  };
}

// --- the endpoint ---------------------------------------------------------------------------

export interface RouteChecksOptions {
  /** The staff sign-in: the bearer is a staff key. */
  accounts: Pick<AccountService, 'signIn'>;
  /** Routes, the staff table and the audit rows, on the Worker login. */
  commercial: CommercialRepository;
  spend: RouteCheckSpend;
  /** The provider transport (see `RouteChecksRun.transport`). */
  transport: typeof globalThis.fetch;
  now?: () => number;
  idleTimeoutMs?: number;
  receiptId?: () => string;
}

const ROUTE_ID = /^[a-z0-9][a-z0-9.:_-]{0,127}$/;

/**
 * The Worker's route checks transport: workerd's global fetch, looked up and called at each call as
 * a plain function. A fetch kept on an object and called as its member throws "Illegal invocation"
 * in workerd. The runtime smoke drives the endpoint through this same function.
 */
export const workerFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

/** `POST /ops/routes/:id/checks`. Staff with `routes.write` only. */
export class RouteChecksService {
  private readonly now: () => number;
  constructor(private readonly options: RouteChecksOptions) {
    this.now = options.now ?? Date.now;
  }

  private async staff(token: string) {
    const session = await this.options.accounts.signIn(token);
    const operator = await this.options.commercial.transaction((tx) => tx.operator(session.person.id));
    if (!operator || operator.state !== 'active') throw refusal('forbidden', 'This account is not a Diomedes staff account.');
    if (!staffCan(operator.role, 'routes.write')) throw refusal('forbidden', 'Routing permission is required.');
    return { person: session.person, operator };
  }

  /** The route's connection, credential and receipt identity, or the refusal that stops the run before anything is sent. */
  private target(route: RouteEntry, env: Readonly<Record<string, unknown>>) {
    if (route.status === 'retired') throw refusal('route_not_checkable', 'This route is retired, so it cannot be checked.');
    const binding = route.binding;
    if (!binding) throw refusal('route_not_checkable', 'This route has no model binding to check.');
    const checked: CheckedRoute = { ...route, binding };
    let connections: ProviderConnection[];
    try { connections = approvedConnections(env); } catch { connections = []; }
    const connection = connections.find((entry) => entry.id === binding.connectionId);
    if (!connection) throw refusal('route_not_checkable', 'This route’s connection is not an approved company connection.');
    if (binding.connectionRevision !== connection.revision)
      throw refusal('route_not_checkable', 'This route is bound to another revision of its connection. Save it on the current revision first.');
    if (!isQualifiable(connection.provider)) throw refusal('protocol_unsupported', 'The route checks cover Amazon Bedrock and Azure OpenAI routes only.');
    if (!PROTOCOLS[binding.protocol]) throw refusal('protocol_unsupported', 'The route checks cover the Responses and Chat Completions protocols only.');
    const problem = bindingProblems(checked, connection)[0];
    if (problem) throw refusal('route_not_checkable', problem.message);
    if (binding.price.inputMicroUsdPerMillion <= 0 || binding.price.outputMicroUsdPerMillion <= 0)
      throw refusal('price_missing', 'This route’s price record has no input or output price, so the checks cannot be bounded.');
    return { route: checked, connection, identity: routeCheckIdentity(checked, connection)! };
  }

  private async preflight(boundMicroUsd: number, env: Readonly<Record<string, unknown>>) {
    let ceiling: number | null;
    try {
      ceiling = spendControls(env).ceilingMicroUsd;
    } catch {
      throw new AccountError(503, 'The company spend ceiling setting cannot be read.');
    }
    if (ceiling === null) return;
    const spent = await this.options.spend.read();
    if (spent.companyMicroUsd + spent.routeChecksMicroUsd + boundMicroUsd > ceiling)
      throw refusal('company_ceiling',
        `The checks could spend up to ${centsUp(boundMicroUsd)}. With company spend and earlier route checks, that would pass the company spend ceiling.`);
  }

  async run(token: string, address: string, input: RouteChecksInput, env: Readonly<Record<string, unknown>>): Promise<RouteChecksResult> {
    const actor = await this.staff(token);
    let routeId: string | null;
    try { routeId = decodeURIComponent(address); } catch { routeId = null; }
    const route = routeId !== null && ROUTE_ID.test(routeId)
      ? (await this.options.commercial.transaction((tx) => tx.routes())).find((entry) => entry.id === routeId)
      : undefined;
    if (!route) throw refusal('unknown_route', 'That route was not found.');
    if (route.revision !== input.baseRevision) throw refusal('route_changed', 'Someone changed this route since you opened it. Reload and try again.');
    const target = this.target(route, env);
    let plan: RouteChecksPlan;
    try {
      plan = planRouteChecks(target.route, target.connection);
    } catch (error) {
      if (error instanceof BindingError) throw refusal('route_not_checkable', `The checks cannot be sent on this route. ${error.message}`);
      throw error;
    }
    const receiptId = (this.options.receiptId ?? newReceiptId)();
    if (!receiptIdentityValid(target.route, target.connection, target.identity, receiptId, this.now()))
      throw refusal('route_not_checkable', 'This route cannot be recorded as a route check.');
    const credential = connectionCredential(target.connection, env);
    if (!credential) throw refusal('credential_unavailable', `The Worker secret ${target.connection.secretRef} for this connection is not set or not usable.`);
    await this.preflight(plan.boundMicroUsd, env);

    const outcome = await runRouteChecks({
      route: target.route, connection: target.connection, credential, plan, transport: this.options.transport,
      receiptId, now: this.now, idleTimeoutMs: this.options.idleTimeoutMs,
    });
    const { receipt } = outcome;
    const auditId = `audit_${crypto.randomUUID()}`;
    const evidence = `Route checks ${receipt.id}, audit ${auditId}, ${receipt.createdAt.slice(0, 10)}.`;
    const spend = { boundMicroUsd: outcome.boundMicroUsd, spentMicroUsd: outcome.spentMicroUsd, uncertainMicroUsd: outcome.uncertainMicroUsd };
    try {
      await this.options.commercial.transaction((tx) => tx.audit({
        id: auditId, at: new Date(this.now()).toISOString(), actorPersonId: actor.person.id, actorRole: actor.operator.role,
        action: ROUTE_CHECKS_AUDIT_ACTION, organizationId: null, targetKind: 'route', targetId: route.id, reason: evidence,
        detail: { receipt, routeRevision: route.revision, ...spend },
      }));
    } catch {
      // The calls were made and may have been billed: their spend is kept in the log, never the credential.
      console.error(JSON.stringify({ event: 'route-checks-audit-unwritten', routeId: route.id, receiptId: receipt.id, ...spend }));
      throw new AccountError(500, `The route checks ran, but their record could not be saved. Their receipt is ${receipt.id}.`);
    }
    return {
      routeId: route.id,
      routeRevision: route.revision,
      receipt,
      auditId,
      evidence,
      qualifies: receiptQualifies(receipt, target.identity, this.now()),
      ...spend,
    };
  }
}
