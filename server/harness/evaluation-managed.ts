/**
 * The preflight on company-managed inference: a business conversation on the
 * `nectovia` route asks its typed evaluation through the account service's
 * gateway (`POST {accountService}/managed/v1/evaluations`, contract
 * docs/implementation/2026-09-26-jev-managed-evaluations.md), which pays the
 * provider with the company's key and debits the business's credits.
 *
 * Nothing is connected on this computer for it. Each preflight is its own job:
 * admitted through the Agent gate as managed conversation work pinned to that
 * job, held on this computer's guard for the business's month (the same ledger
 * the Nectovia route holds its calls on), and sent once as the signed-in person
 * with the session's bearer token. The gateway checks everything again and says
 * what became of its hold, and that receipt is the preflight's charge.
 *
 * Who resolves the local hold: this port makes it before anything leaves and
 * releases it whenever nothing was charged; the advisor's charge sink
 * (`recordManagedCharge`) settles it, or marks it uncertain, from the receipt.
 * Before the request leaves, every failure is a refusal that sent nothing. After
 * it may have left, any outcome the gateway did not name is an uncertain charge.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AccessFeature } from '../../shared/access.js';
import {
  EVALUATION_OUTPUT_TOKENS_PER_QUESTION,
  EVALUATION_ROUTE_LIMITS,
  UNPROVEN_ROUTE_LIMITS,
} from '../../shared/evaluation-wire.js';
import type { EvaluationProfile } from '../../shared/evaluation.js';
import { approvedJobCap } from '../../shared/job-caps.js';
import type { JobTier } from '../../shared/managed-usage.js';
import { NECTOVIA_ROUTE } from '../../shared/model-api.js';
import { inputTokenBound } from '../../shared/token-bound.js';
import { AGENT_SIGN_IN_REQUIRED, type AdmittedAgentWork, type AgentGatePort } from '../accounts/agent-gate.js';
import { EngineError } from '../engines/process.js';
import {
  ensureNectoviaGuard,
  NECTOVIA_SIGN_IN,
  nectoviaConnectionId,
  usageClassFor,
  type NectoviaAccount,
} from '../engines/nectovia.js';
import { jobKeyFor } from '../job-caps.js';
import {
  ceilingCost,
  usageCost,
  type ExposureReservation,
  type ModelRateCard,
  type SpendExposure,
} from '../spend-exposure.js';
import {
  EvaluationTransportError,
  type EvaluationPort,
  type EvaluationReceipt,
  type EvaluationTransportCode,
} from './evaluation-adapter.js';
import { EVALUATION_PRICE_JEV_113_OPENROUTER } from './evaluation-price.js';
import {
  createJevAdvisor,
  type JevAdvisor,
  type PreflightChargeRecord,
  type PreflightThresholds,
} from './jev-advisor.js';

export const MANAGED_EVALUATION_PORT_ID = 'nectovia-managed-evaluation';
/** The feature every Diomedes-funded call needs, the preflight included (shared/access.ts). */
export const MANAGED_INFERENCE_FEATURE: AccessFeature = 'managed-inference';
/** The gateway's own sentence for a plan without included AI usage. */
export const MANAGED_EVALUATION_NOT_INCLUDED = 'Included AI usage is part of a Business plan, so nothing was sent.';
/** The most of the gateway's answer this computer reads. The validator keeps 65,536 bytes of it. */
const MAX_ANSWER_BYTES = 262_144;
/** Statuses at which the gateway's own error body, with no charge named, means it held and sent nothing. */
const GATEWAY_PRE_DISPATCH = new Set([400, 401, 402, 403, 404, 405, 413, 415, 422, 429, 503]);

const NOT_SENT = {
  cancelled: 'The preflight was cancelled before it was sent. Nothing was charged.',
  noBusiness: 'This preflight names no business, so nothing was sent.',
  otherBusiness: 'This conversation belongs to another business, so nothing was sent.',
  guard: "Nectovia's safety limit on this computer for this business's month has been reached, so nothing was sent.",
  hold: 'This computer could not hold the preflight on its spending guard, so nothing was sent.',
  refused: 'The model service refused this preflight before answering. Nothing was charged.',
  busy: "Nectovia's model service is busy or unavailable right now. Nothing was charged.",
} as const;

const UNCERTAIN = {
  lost: 'The preflight may have reached the service before it failed or was cancelled, so the charge is held until it is reconciled.',
  unnamed: 'The service answered without saying what the preflight cost, so the charge is held until it is reconciled.',
  unreadable: 'The service settled the preflight, but its receipt could not be read here, so the charge is held until it is reconciled.',
  gateway: 'The service sent the preflight and could not say what it cost, so the charge is held until it is reconciled.',
} as const;

/**
 * This computer's price for a managed evaluation: the gateway's own terms for the model it
 * sends to (services/control-plane/src/managed-providers.ts, EVALUATION_PROVIDER), which are
 * the desktop's published OpenRouter terms for Jev 1.13. Input, cache reads and cache writes at
 * one rate; output at nothing. One band: the route's context is 32,000 tokens.
 */
export function managedEvaluationRateCard(): ModelRateCard {
  const price = EVALUATION_PRICE_JEV_113_OPENROUTER;
  const rates = {
    input: price.inputMicroUsdPerMillion,
    cacheWrite: price.inputMicroUsdPerMillion,
    cacheRead: price.inputMicroUsdPerMillion,
    output: price.outputMicroUsdPerMillion,
  };
  return {
    version: price.version,
    route: NECTOVIA_ROUTE,
    modelId: price.modelId,
    source: `${price.source}. Nectovia's local guard; the account service's ledger is the authority.`,
    shortContextMaxInputTokens: EVALUATION_ROUTE_LIMITS.maxStateTokens,
    short: rates,
    long: { ...rates },
  };
}

export interface ManagedEvaluationOptions {
  /** The account session as the Nectovia route sees it: its address, sign-in, token and transport. */
  readonly account: Pick<NectoviaAccount, 'base' | 'signedIn' | 'token' | 'fetch'>;
  /** The one entitlement seam (`AccountSessionService.includes`), read as the session last saw it. */
  readonly includes: (organizationId: string, feature: AccessFeature) => boolean;
  /** The Agent gate. Each preflight is admitted as managed conversation work, pinned to its own job. */
  readonly gate: AgentGatePort;
  /** The tier a preflight in this thread is metered at: the thread's own. */
  readonly tierOf: (projectId: string, threadId: string | null) => JobTier;
  /** This computer's spend ledger, where the Nectovia route keeps its local guard. */
  readonly exposure: SpendExposure;
  readonly now?: () => Date;
  /** A fresh job id for each preflight. Tests pin it. */
  readonly jobId?: () => string;
}

/** The shapes the gateway refuses on the wire, refused here before anything is serialized. */
function managedRefuses(question: EvaluationProfile['questions'][number]): string | null {
  if (question.type === 'score' && question.levels.some((level) => level === null))
    return `Every level of ${question.id} needs a description on this route.`;
  if (question.type === 'boolean' && (question.whenTrue === null) !== (question.whenFalse === null))
    return `${question.id} describes both answers on this route, or neither.`;
  return null;
}

const readError = (text: string | null): { code: string; message: string } | null => {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const error = value?.error;
    return error && typeof error.code === 'string' && typeof error.message === 'string'
      ? { code: error.code, message: error.message }
      : null;
  } catch {
    return null;
  }
};

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError('The answer is larger than this computer reads.');
    }
    parts.push(value);
  }
  const whole = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(whole);
}

/**
 * A step before anything is sent that does not itself watch the signal (an admission or a token
 * refresh on the account service), abandoned when the preflight is. What it was doing may finish
 * on its own; nothing it does is a charge.
 */
function unlessCancelled<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new EvaluationTransportError('transport_unavailable', NOT_SENT.cancelled));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new EvaluationTransportError('transport_unavailable', NOT_SENT.cancelled));
    signal.addEventListener('abort', stop, { once: true });
    step.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

const wholeHeader = (value: string | null): number | null =>
  value !== null && /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

/**
 * A gateway refusal that held and sent nothing, as the preflight's refusal code. The meaning is
 * kept: a plan or membership refusal is `not_included`, an oversized request `request_too_large`,
 * a body this build should never have sent `invalid_transport`, and everything else (sign-in,
 * credits, an unavailable route) `transport_unavailable`. The gateway's sentences are neutral,
 * so they pass through.
 */
function preDispatchCode(code: string): EvaluationTransportCode {
  switch (code) {
    case 'not_a_member':
    case 'agent_not_included':
      return 'not_included';
    case 'request_too_large':
      return 'request_too_large';
    case 'unsupported_field':
    case 'invalid_body':
    case 'invalid_header':
    case 'invalid_request':
      return 'invalid_transport';
    case 'evaluation_provider_policy':
      return 'provider_policy';
    default:
      return 'transport_unavailable';
  }
}

/**
 * The evaluation port for a business conversation on company-managed inference. It asks for the
 * route's model (Jev 1.13); what answered comes back in the reply, named by the provider.
 */
export function managedEvaluationPort(options: ManagedEvaluationOptions): EvaluationPort {
  const now = options.now ?? (() => new Date());
  const newJob = options.jobId ?? (() => `preflight-${randomUUID()}`);
  const card = managedEvaluationRateCard();
  return {
    id: MANAGED_EVALUATION_PORT_ID,
    version: '1',
    requestedModel: card.modelId,
    scripted: false,
    supports: ['choice', 'score', 'boolean'],
    limits: UNPROVEN_ROUTE_LIMITS,
    refuses: managedRefuses,
    async evaluate(call) {
      const refuse = (code: EvaluationTransportCode, message: string) => new EvaluationTransportError(code, message);
      const receipt = (given: EvaluationReceipt) => call.onReceipt?.(given);

      // --- before anything leaves: every failure is a refusal that sent nothing ---
      if (call.signal.aborted) throw refuse('transport_unavailable', NOT_SENT.cancelled);
      const scope = call.scope;
      if (!scope) throw refuse('invalid_transport', NOT_SENT.noBusiness);
      const organizationId = scope.tenant;
      if (!options.account.signedIn()) throw refuse('transport_unavailable', NECTOVIA_SIGN_IN);
      // The session's current access: a plan without included usage is refused without a round trip.
      if (!options.includes(organizationId, MANAGED_INFERENCE_FEATURE))
        throw refuse('not_included', MANAGED_EVALUATION_NOT_INCLUDED);

      const rootJobId = newJob();
      let admitted: AdmittedAgentWork;
      try {
        admitted = await unlessCancelled(
          options.gate.check({
            phase: 'admit',
            surface: 'conversation',
            projectId: scope.project,
            rootJobId,
            routeKind: 'managed',
          }),
          call.signal,
        );
      } catch (error) {
        if (error instanceof EvaluationTransportError) throw error;
        if (call.signal.aborted) throw refuse('transport_unavailable', NOT_SENT.cancelled);
        const message = error instanceof Error && error.message ? error.message : NECTOVIA_SIGN_IN;
        const unknown = (error as { refusalCode?: unknown })?.refusalCode === 'entitlement_unknown';
        const signIn = error instanceof EngineError && error.code === AGENT_SIGN_IN_REQUIRED;
        throw refuse(unknown || signIn || !(error instanceof EngineError) ? 'transport_unavailable' : 'not_included', message);
      }
      if (admitted.organizationId !== organizationId) throw refuse('not_included', NOT_SENT.otherBusiness);
      if (call.signal.aborted) throw refuse('transport_unavailable', NOT_SENT.cancelled);

      const tier = options.tierOf(scope.project, scope.thread);
      const body = JSON.stringify({ state: call.state, questions: call.questions });
      const questions = Object.keys(call.questions).length;
      const connectionId = nectoviaConnectionId(organizationId, now());
      let hold: ExposureReservation;
      try {
        if ((await ensureNectoviaGuard(options.exposure, connectionId, admitted.planId)).availableMicroUsd <= 0)
          throw refuse('transport_unavailable', NOT_SENT.guard);
        hold = await options.exposure.reserve({
          connectionId,
          route: card.route,
          modelId: card.modelId,
          card,
          attempt: {
            runId: rootJobId,
            stepId: 'preflight',
            attempt: 1,
            requestDigest: createHash('sha256').update(body).digest('hex'),
          },
          // The gateway's own bound: every input token the body can carry at the dearest input
          // rate, and a few output tokens a question at the output rate.
          maxMicroUsd: ceilingCost(card, {
            maxInputTokens: inputTokenBound(Buffer.byteLength(body), questions),
            maxOutputTokens: questions * EVALUATION_OUTPUT_TOKENS_PER_QUESTION,
          }),
          job: { id: jobKeyFor(scope.project, rootJobId), capMicroUsd: approvedJobCap(tier) },
        });
      } catch (error) {
        if (error instanceof EvaluationTransportError) throw error;
        throw refuse('transport_unavailable', error instanceof Error && error.message ? error.message : NOT_SENT.hold);
      }
      const release = (reason: string) => options.exposure.release(hold.id, reason).then(() => undefined, () => undefined);
      let token: string;
      try {
        token = await unlessCancelled(options.account.token(), call.signal);
      } catch (error) {
        await release('The preflight was not sent: it was cancelled, or the session had no current sign-in.');
        if (error instanceof EvaluationTransportError) throw error;
        throw refuse('transport_unavailable', NECTOVIA_SIGN_IN);
      }
      if (call.signal.aborted) {
        await release('The preflight was cancelled before it was sent.');
        throw refuse('transport_unavailable', NOT_SENT.cancelled);
      }

      // --- the request may leave from here: an outcome the gateway does not name is uncertain ---
      const uncertain = (reason: string, rateCard: string | null = null) =>
        receipt({ state: 'uncertain', attemptId: hold.id, rateCard, reason });
      let response: Response;
      try {
        response = await (options.account.fetch ?? globalThis.fetch)(`${options.account.base}/managed/v1/evaluations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'x-nectovia-organization': organizationId,
            'x-nectovia-admission': admitted.admissionId,
            'x-nectovia-job': rootJobId,
            'x-nectovia-attempt': hold.id,
            'x-nectovia-tier': tier,
            'x-nectovia-usage-class': usageClassFor('conversation'),
          },
          body,
          signal: call.signal,
          redirect: 'manual',
        });
      } catch (error) {
        uncertain(UNCERTAIN.lost);
        throw error instanceof Error ? error : new Error(UNCERTAIN.lost);
      }
      let text: string | null;
      try {
        text = await readCapped(response, MAX_ANSWER_BYTES);
      } catch {
        text = null;
      }
      const charged = response.headers.get('x-nectovia-charge');
      const rateCard = response.headers.get('x-nectovia-rate-card');
      const said = readError(text);

      if (charged === 'released') {
        await release('The service released this preflight before any model answered. Nothing was charged.');
        receipt({ state: 'released', attemptId: hold.id });
        if (said?.code === 'evaluation_provider_policy') throw refuse('provider_policy', said.message);
        throw refuse(said?.code === 'provider_refused' ? 'invalid_transport' : 'transport_unavailable',
          said?.code === 'provider_refused' ? NOT_SENT.refused : NOT_SENT.busy);
      }
      if (charged === null) {
        // The gateway's own refusal before its dispatch commit held and sent nothing.
        if (said && GATEWAY_PRE_DISPATCH.has(response.status) && !['attempt_in_flight', 'attempt_replayed'].includes(said.code)) {
          await release(`The service refused the preflight before sending it (${said.code}). Nothing was charged.`);
          throw refuse(preDispatchCode(said.code), said.message);
        }
        uncertain(UNCERTAIN.unnamed);
        throw new Error(UNCERTAIN.unnamed);
      }
      if (charged === 'settled') {
        const microUsd = wholeHeader(response.headers.get('x-nectovia-charge-micro-usd'));
        const inputTokens = wholeHeader(response.headers.get('x-nectovia-input-tokens'));
        const outputTokens = wholeHeader(response.headers.get('x-nectovia-output-tokens'));
        if (microUsd === null || inputTokens === null || outputTokens === null || !rateCard) uncertain(UNCERTAIN.unreadable, rateCard);
        else receipt({ state: 'settled', attemptId: hold.id, microUsd, rateCard, usage: { inputTokens, outputTokens } });
      } else uncertain(UNCERTAIN.gateway, rateCard);

      // Paid for, or held as uncertain: the answer is used only when it came back whole.
      if (response.status !== 200 || text === null) throw new Error(said?.message ?? UNCERTAIN.gateway);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new EvaluationTransportError('answer_rejected', 'The service answered, but its answer could not be read.');
      }
    },
  };
}

/**
 * The advisor's charge sink for the managed port: the gateway's receipt, recorded on the hold
 * the port made for it in the Nectovia route's ledger. A settled receipt settles the hold at the
 * gateway's terms when this computer prices the same usage at the same amount; anything else
 * (another rate card, a different amount, usage the ledger refuses) is held as uncertain with
 * the reason, never settled at a figure the two ledgers disagree on. Released holds were already
 * released by the port.
 */
export async function recordManagedCharge(exposure: SpendExposure, record: PreflightChargeRecord): Promise<void> {
  const receipt = record.receipt;
  if (!receipt || receipt.state === 'released') return;
  const hold = exposure.get(receipt.attemptId);
  if (!hold || hold.state !== 'pending') return;
  const card = managedEvaluationRateCard();
  const park = (reason: string) => exposure.markUncertain(hold.id, reason).then(() => undefined);
  if (receipt.state === 'uncertain') return park(receipt.reason);
  const usage = {
    inputTokens: receipt.usage.inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: receipt.usage.outputTokens,
    reasoningTokens: 0,
  };
  if (receipt.rateCard !== card.version)
    return park(`The service charged this preflight under ${receipt.rateCard}, which this version of the app does not price.`);
  try {
    const local = usageCost(card, usage).microUsd;
    if (local !== receipt.microUsd)
      return park(`The service charged ${receipt.microUsd} micro-USD and this computer prices the same usage at ${local}.`);
    await exposure.settle(hold.id, { usage, card, providerRequestId: record.provenance?.providerRequestId ?? receipt.attemptId });
  } catch (error) {
    await park(
      `The service's receipt could not be settled here: ${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => undefined);
  }
}

export interface ManagedJevAdvisorOptions extends ManagedEvaluationOptions {
  readonly thresholds?: PreflightThresholds;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly clock?: () => Date;
}

/**
 * The preflight advisor for business conversations on company-managed inference. The same
 * advisor as any route (the same questions, rules, thresholds and guarantees), on the managed
 * port, with the gateway's receipt recorded before the advice is returned.
 */
export function createManagedJevAdvisor(options: ManagedJevAdvisorOptions): JevAdvisor {
  const port = managedEvaluationPort(options);
  const writes = new Set<Promise<void>>();
  const advisor = createJevAdvisor({
    port,
    recordCharge: (record) => {
      const write: Promise<void> = recordManagedCharge(options.exposure, record)
        .catch(() => undefined)
        .finally(() => writes.delete(write));
      writes.add(write);
    },
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return {
    async preflight(input, signal) {
      const advice = await advisor.preflight(input, signal);
      await Promise.all([...writes]);
      return advice;
    },
  };
}
