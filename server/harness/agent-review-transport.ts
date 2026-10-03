/** Direct Decisions transport, admitted and metered on the caller's original root hold. */
import { z } from 'zod';
import { INVENTORY_REVIEW_MAX_INPUT_TOKENS } from '../../shared/agent-review.js';
import { MAX_EVALUATION_RESPONSE_BYTES } from '../../shared/evaluation.js';
import { checkEvaluationRequest, type ProviderQuestion } from '../../shared/evaluation-wire.js';
import {
  ceilingCost, reportedCostMicroUsd, validateRateCard, SpendExposureError,
  type ExposureReservation, type ModelRateCard, type SpendExposure,
} from '../spend-exposure.js';
import type { AgentReviewTransport, AgentReviewTransportBinding } from './agent-review.js';
import {
  EvaluationTransportError, openRouterEvaluationPort, type EvaluationPortCall,
} from './evaluation-adapter.js';
import { digest } from './policy.js';

export interface AgentReviewProviderPolicy {
  only: string[];
  allow_fallbacks: false;
  require_parameters: true;
  data_collection: 'deny';
  zdr?: boolean;
}
/** Supplied by the host's current account qualification, never inferred from a public listing. */
export interface AgentReviewQualification {
  id: string;
  source: string;
  rateCard: ModelRateCard;
  inputFramingTokens: number;
}
export interface AgentReviewTransportAdmission {
  binding: AgentReviewTransportBinding;
  apiKey: string;
  provider: AgentReviewProviderPolicy;
  qualification: AgentReviewQualification | null;
}
export interface AgentReviewTransportOptions {
  binding: AgentReviewTransportBinding;
  ledger: SpendExposure;
  stateDigest: string;
  resolveCurrent(signal: AbortSignal): Promise<AgentReviewTransportAdmission>;
  fetch?: typeof globalThis.fetch;
  loadSdk?: Parameters<typeof openRouterEvaluationPort>[0]['loadSdk'];
}

const text = z.string().min(1).max(200).refine(value => value.trim().length > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  grantId: text, rootRunId: text, projectId: text, taskId: text,
  rootJobId: z.string().regex(/^job-[a-f0-9]{40}$/), stepId: text,
  route: z.literal('openrouter'), connectionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  modelId: z.literal('typesafe/jev-1.13'), accountId: text,
  accountRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  accountDigest: hash, dataPolicyDigest: hash,
  maxInputTokens: z.number().int().positive().max(INVENTORY_REVIEW_MAX_INPUT_TOKENS), maxCalls: z.literal(1),
});
const providerSchema = z.strictObject({
  only: z.array(text).min(1).max(32).refine(value => new Set(value).size === value.length),
  allow_fallbacks: z.literal(false), require_parameters: z.literal(true),
  data_collection: z.literal('deny'), zdr: z.boolean().optional(),
});
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const utf8 = new TextEncoder();
const invalid = (message: string): never => { throw new EvaluationTransportError('invalid_transport', message); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function checkedBinding(value: unknown): AgentReviewTransportBinding {
  const checked = bindingSchema.safeParse(value);
  if (!checked.success) return invalid('The direct review needs an exact account/root binding and an input bound no greater than 5,000.');
  return Object.freeze(checked.data);
}
function checkedRequest(call: EvaluationPortCall, binding: AgentReviewTransportBinding, stateDigest: string) {
  const limits = { maxTotalTokens: binding.maxInputTokens, maxStatePlusLongestQuestionTokens: binding.maxInputTokens };
  let checked = checkEvaluationRequest({ state: call.state, questions: call.questions }, limits, 'strict');
  if (checked.ok) checked = checkEvaluationRequest(JSON.parse(JSON.stringify(checked.request)), limits, 'strict');
  if (!checked.ok) throw new EvaluationTransportError(
    checked.code === 'request_too_large' ? 'request_too_large'
      : checked.code === 'unsupported_field' ? 'unsupported_question_type' : 'invalid_transport',
    checked.message,
  );
  if (digest(JSON.stringify(checked.request.state)) !== stateDigest)
    return invalid('The direct review state differs from the admitted source and report digest.');
  return checked.request;
}
function wireQuestions(questions: Readonly<Record<string, ProviderQuestion>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
    question.type === 'boolean'
      ? { type: 'noul', instructions: question.instructions,
          ...(question.criteria?.true == null && question.criteria?.false == null ? {} : { criteria: question.criteria }) }
      : question,
  ]));
}
function withinBound(body: string, qualification: AgentReviewQualification, binding: AgentReviewTransportBinding): void {
  if (utf8.encode(body).byteLength + qualification.inputFramingTokens > binding.maxInputTokens)
    throw new EvaluationTransportError('request_too_large', 'The complete Decisions body and qualified input framing exceed the approved review bound.');
}

/** Prompt cancellation does not depend on the fetch or SDK honoring AbortSignal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason ?? new DOMException('Review stopped.', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    // Observe both outcomes even after cancellation; late completion cannot settle anything.
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

interface ReportedResponse {
  costUsd?: number;
  reportedModel: string | null;
  providerRequestId: string | null;
}
async function responseEvidence(response: Response, signal: AbortSignal): Promise<ReportedResponse | null> {
  // The SDK also reads this response. Bound the independent receipt copy and never retain its answers.
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_EVALUATION_RESPONSE_BYTES) return null;
      parts.push(next.value);
    }
    signal.throwIfAborted();
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { content.set(part, offset); offset += part.byteLength; }
    const raw: unknown = JSON.parse(new TextDecoder().decode(content));
    if (!isRecord(raw)) return null;
    const usage = isRecord(raw.usage) ? raw.usage : {};
    let costUsd: number | undefined;
    if (typeof usage.cost === 'number') {
      try { reportedCostMicroUsd(usage.cost); costUsd = usage.cost; } catch { /* Invalid is unknown, never zero. */ }
    }
    return {
      ...(costUsd === undefined ? {} : { costUsd }),
      reportedModel: typeof raw.model === 'string' && raw.model.trim() && raw.model.length <= 200 ? raw.model : null,
      providerRequestId: typeof raw.id === 'string' && raw.id.trim() && raw.id.length <= 200 ? raw.id : null,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* An aborted read can still be unwinding. */ }
  }
}

/** No ledger, payer, credential or qualification is created by this factory. */
export function createAgentReviewTransport(options: AgentReviewTransportOptions): AgentReviewTransport {
  const binding = checkedBinding(options.binding);
  const ledger = options.ledger;
  const stateDigest = options.stateDigest;
  if (!hash.safeParse(stateDigest).success || typeof options.resolveCurrent !== 'function')
    return invalid('The direct review needs its admitted state digest and a current host resolver.');
  if (!ledger || ledger.jobScope?.id !== binding.rootJobId)
    return invalid('The direct review must use the supplied ledger scoped to its original root job.');
  const transportFetch = options.fetch ?? globalThis.fetch;
  if (typeof transportFetch !== 'function') return invalid('The direct review has no HTTP transport.');
  const limits = Object.freeze({ maxTotalTokens: binding.maxInputTokens, maxStatePlusLongestQuestionTokens: binding.maxInputTokens });

  async function current(signal: AbortSignal): Promise<AgentReviewTransportAdmission & { qualification: AgentReviewQualification }> {
    signal.throwIfAborted();
    const resolved = await options.resolveCurrent(signal);
    signal.throwIfAborted();
    if (!resolved || digest(checkedBinding(resolved.binding)) !== digest(binding) || ledger.jobScope?.id !== binding.rootJobId)
      return invalid('The live review account, policy or root binding changed.');
    if (typeof resolved.apiKey !== 'string' || !resolved.apiKey.trim() || /[\r\n]/.test(resolved.apiKey))
      return invalid('The direct review needs the explicitly admitted account credential.');
    const policy = providerSchema.safeParse(resolved.provider);
    if (!policy.success || digest(policy.data) !== binding.dataPolicyDigest)
      return invalid('The direct review downstream policy differs from its admitted private policy.');
    const given = resolved.qualification;
    if (!given || !text.safeParse(given.id).success || typeof given.source !== 'string' || !given.source.trim() || given.source.length > 2_000 ||
        !Number.isSafeInteger(given.inputFramingTokens) || given.inputFramingTokens < 0 || given.inputFramingTokens > binding.maxInputTokens)
      return invalid('The direct review has no current account-qualified pricing and input framing bound.');
    let rateCard: ModelRateCard;
    try { rateCard = validateRateCard(given.rateCard); } catch { return invalid('The direct review qualified rate card cannot be used.'); }
    if (rateCard.route !== binding.route || rateCard.modelId !== binding.modelId || rateCard.short.output !== 0 || rateCard.long.output !== 0)
      return invalid('Decisions has no proven output cap; both qualified output rates must be zero on the exact review route.');
    return { binding, apiKey: resolved.apiKey, provider: policy.data,
      qualification: { id: given.id, source: given.source, inputFramingTokens: given.inputFramingTokens, rateCard } };
  }

  return Object.freeze({
    binding, ledger,
    port: Object.freeze({
      id: 'openrouter-evaluation', version: '1', requestedModel: binding.modelId, scripted: false,
      supports: Object.freeze(['choice', 'score', 'boolean'] as const), limits,
      async evaluate(call: EvaluationPortCall): Promise<unknown> {
        call.signal.throwIfAborted();
        const request = checkedRequest(call, binding, stateDigest);
        const admitted = await current(call.signal);
        const expectedBody = { model: binding.modelId, provider: admitted.provider, state: request.state, questions: wireQuestions(request.questions) };
        withinBound(JSON.stringify(expectedBody), admitted.qualification, binding);
        const dispatch: {
          hold: ExposureReservation | null; sent: boolean; receipt: ReportedResponse | null;
          reservation: Promise<ExposureReservation> | null; finished: boolean; entered: boolean;
          refusal: EvaluationTransportError | SpendExposureError | null;
        } = { hold: null, sent: false, receipt: null, reservation: null, finished: false, entered: false, refusal: null };
        const active = () => {
          call.signal.throwIfAborted();
          if (dispatch.finished) return invalid('The review SDK attempt has already ended.');
        };
        const ensureCurrent = async () => {
          const live = await current(call.signal);
          if (live.apiKey !== admitted.apiKey || digest(live.provider) !== digest(admitted.provider) ||
              digest(live.qualification) !== digest(admitted.qualification))
            return invalid('The review account credential, downstream policy or qualification changed before dispatch.');
        };
        const guardedFetch: typeof globalThis.fetch = async (url, init) => {
          try {
            active();
            if (dispatch.entered) return invalid('The review SDK tried more than one HTTP dispatch.');
            dispatch.entered = true;
            if (String(url) !== ENDPOINT || init?.method !== 'POST' || typeof init.body !== 'string')
              return invalid('The review SDK tried an unadmitted endpoint, method or body.');
            const headers = new Headers(init.headers);
            if (headers.get('authorization') !== `Bearer ${admitted.apiKey}` || headers.has('x-provider-api-keys') ||
                [...headers.keys()].some(key => !['authorization', 'content-type', 'user-agent'].includes(key)))
              return invalid('The review SDK credential or request headers differ from the admitted direct route.');
            const bodyText = init.body;
            let body: unknown;
            try { body = JSON.parse(bodyText); } catch { return invalid('The review SDK did not serialize a JSON Decisions request.'); }
            // Check the actual bytes, including duplicate fields or content discarded by JSON parsing.
            if (JSON.stringify(body) !== bodyText || digest(body) !== digest(expectedBody))
              return invalid('The actual review model, policy, state or questions differ from the admitted request.');
            withinBound(bodyText, admitted.qualification, binding);
            await ensureCurrent(); // Includes changes while the SDK was loading.
            active();
            dispatch.reservation = ledger.reserve({
              connectionId: binding.connectionId, route: binding.route, modelId: binding.modelId,
              card: admitted.qualification.rateCard,
              attempt: { runId: binding.rootRunId, stepId: binding.stepId, attempt: 1, requestDigest: digest(bodyText) },
              maxMicroUsd: ceilingCost(admitted.qualification.rateCard, { maxInputTokens: binding.maxInputTokens, maxOutputTokens: 0 }),
              singleAttempt: true,
            });
            dispatch.hold = await dispatch.reservation;
            active();
            await ensureCurrent(); // A queued disk write must not disclose on stale admission.
            active();
            dispatch.sent = true;
            const response = await transportFetch(ENDPOINT, {
              method: 'POST', headers, body: bodyText, signal: call.signal, redirect: 'error',
            });
            dispatch.receipt = await responseEvidence(response, call.signal);
            return response;
          } catch (error) {
            // SDK HTTP helpers can wrap a host refusal; retain its exact pre-dispatch code.
            if (error instanceof EvaluationTransportError || error instanceof SpendExposureError) dispatch.refusal = error;
            throw error;
          }
        };
        const port = openRouterEvaluationPort({
          apiKey: admitted.apiKey, modelId: binding.modelId, provider: { ...admitted.provider },
          limits, fetch: guardedFetch, ...(options.loadSdk ? { loadSdk: options.loadSdk } : {}),
        });
        let raw: unknown;
        let failure: unknown;
        let failed = false;
        try { raw = await abortable(port.evaluate({ ...call, state: request.state, questions: request.questions }), call.signal); }
        catch (error) { failure = dispatch.refusal ?? error; failed = true; }
        dispatch.finished = true;
        // A Stop during the queued write must still resolve the persisted hold; it never sends afterward.
        if (dispatch.reservation) {
          try { dispatch.hold = await dispatch.reservation; } catch { /* The original reservation refusal is preserved. */ }
        }
        const { hold, sent, receipt } = dispatch;
        if (hold) {
          if (!sent) await ledger.release(hold.id, 'The review was refused before HTTP dispatch.');
          else if (!call.signal.aborted && receipt?.costUsd !== undefined && receipt.reportedModel === binding.modelId)
            await ledger.settleReportedCost(hold.id, {
              jobId: binding.rootJobId, card: admitted.qualification.rateCard,
              microUsd: reportedCostMicroUsd(receipt.costUsd), costUsd: receipt.costUsd,
              providerRequestId: receipt.providerRequestId, reportedModel: receipt.reportedModel,
            });
          else await ledger.markUncertain(hold.id,
            call.signal.aborted ? 'Review stopped before a known response could be accepted.'
              : 'The review cost or answering model is unknown or differs from its qualification.',
            !call.signal.aborted && receipt?.costUsd !== undefined ? {
              jobId: binding.rootJobId, card: admitted.qualification.rateCard, costUsd: receipt.costUsd,
              providerRequestId: receipt.providerRequestId, reportedModel: receipt.reportedModel,
            } : undefined);
        }
        if (failed) throw failure;
        call.signal.throwIfAborted();
        return raw;
      },
    }),
  });
}
