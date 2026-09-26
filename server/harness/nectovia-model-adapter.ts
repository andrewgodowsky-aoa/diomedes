/**
 * The Nectovia route as a `ModelAdapter` for the existing native loop, on the
 * shared model-API adapter. One streamed Responses call per model step to the
 * account service's gateway, as the signed-in person, under the admission the
 * Agent gate recorded for this work.
 *
 * The loop, the tools, approvals, context, evidence and the local spend guard
 * are Nectovia's own, exactly as on every model-API route. The gateway supplies
 * the next step and meters it; it never runs a tool.
 */
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import { NECTOVIA_ROUTE } from '../../shared/model-api.js';
import { admitJobStep, CONVERSATION_LIMITS, type RespondLimits, type StreamSinks } from '../engines/model-api-core.js';
import {
  NECTOVIA_CONTRACT,
  NECTOVIA_PROTOCOL,
  NECTOVIA_SDK,
  nectoviaLimits,
  respondNectovia,
  type ManagedAdmission,
  type NectoviaAccount,
} from '../engines/nectovia.js';
import type { ModelRateCard, SpendExposure } from '../spend-exposure.js';
import { createModelApiAdapter, modelApiContract } from './model-api-adapter.js';
import type { ModelTranscripts } from './model-transcripts.js';
import type { ModelAdapter } from './native-agent.js';
import { digest } from './policy.js';

export const NECTOVIA_MODEL_CONTRACT: AdapterRouteContract = modelApiContract({
  routeId: NECTOVIA_ROUTE,
  sdk: NECTOVIA_SDK,
  protocol: NECTOVIA_PROTOCOL,
  label: 'Nectovia',
});

export interface NectoviaModelAdapterOptions extends StreamSinks {
  base: string;
  account: Pick<NectoviaAccount, 'refreshPolicy'>;
  connectionId: string;
  model: string;
  managed: ManagedAdmission;
  /** The session's bearer token for this turn. */
  token: string;
  card: ModelRateCard;
  /** The local guard: this computer's ledger, held to the job's cap. */
  exposure: SpendExposure;
  transcripts: ModelTranscripts;
  instructions: string;
  effort: 'low' | 'medium' | 'high';
  limits?: RespondLimits;
  transport?: typeof globalThis.fetch;
  now?: () => Date;
}

export function createNectoviaModelAdapter(options: NectoviaModelAdapterOptions): ModelAdapter & { profileHash: string } {
  const limits = nectoviaLimits(options.limits ?? CONVERSATION_LIMITS);
  const { managed } = options;
  return createModelApiAdapter({
    route: NECTOVIA_ROUTE,
    prefix: 'nectovia',
    label: 'Nectovia',
    sdk: NECTOVIA_SDK,
    protocol: NECTOVIA_PROTOCOL,
    contract: NECTOVIA_MODEL_CONTRACT,
    connectionId: options.connectionId,
    revision: 1,
    requestedModel: options.model,
    // Everything that decides what a call means, so saved context cannot cross a business, a
    // model, a tier or a mode. The month's guard connection is not part of it: a turn that runs
    // across midnight on the first is still one turn.
    profile: {
      route: NECTOVIA_ROUTE,
      contract: NECTOVIA_CONTRACT,
      sdk: NECTOVIA_SDK,
      gateway: `${options.base}/managed/v1`,
      organizationId: managed.organizationId,
      model: options.model,
      tier: managed.tier,
      instructions: digest(options.instructions),
      effort: options.effort,
      limits,
      rateCard: options.card.version,
    },
    transcripts: options.transcripts,
    notes: [
      'One streamed Responses call per model step to the account service’s managed gateway, store:false, SDK retries off, one tool call at most; tools are descriptors run only by the harness.',
      'The session’s bearer token and the Agent admission are attached only to the gateway’s responses path; redirects are refused. No provider credential exists on this computer.',
      'The gateway meters each call against the business’s credits; the local ledger is a guard, never the balance.',
      'Stopping a call closes the HTTP read and leaves its local hold uncertain until the gateway’s record settles it.',
    ],
    sinks: { onDelta: options.onDelta, onToolActivity: options.onToolActivity },
    admitStep: (call) =>
      admitJobStep({
        prefix: 'nectovia',
        connectionId: options.connectionId,
        exposure: options.exposure,
        card: options.card,
        instructions: options.instructions,
        limits,
        ...call,
      }),
    respond: (call) =>
      respondNectovia({
        base: options.base,
        account: options.account,
        connectionId: options.connectionId,
        model: options.model,
        managed,
        token: options.token,
        card: options.card,
        exposure: options.exposure,
        instructions: options.instructions,
        effort: options.effort,
        limits,
        transport: options.transport,
        now: options.now,
        ...call,
      }),
  });
}
