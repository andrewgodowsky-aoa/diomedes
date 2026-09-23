/**
 * The Google Vertex AI route as a `ModelAdapter` for the existing native loop,
 * on the shared model-API adapter. One streamed `generateContent` call per
 * model step to the project's global endpoint, for Gemini 3.8 Flash.
 *
 * This is a native Nectovia route: the loop, the tools, approvals, context,
 * evidence and spend are Nectovia's own. Gemini supplies the next step and
 * nothing else; it never runs a tool.
 */
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import {
  GOOGLE_VERTEX_PROTOCOL,
  GOOGLE_VERTEX_ROUTE,
  GOOGLE_VERTEX_SDK,
  respondVertex,
  vertexConnectionSchema,
  type VertexConnection,
} from '../engines/google-vertex.js';
import { CONVERSATION_LIMITS, type CallExposure, type RespondLimits, type StreamSinks } from '../engines/model-api-core.js';
import type { ModelRateCard } from '../spend-exposure.js';
import { createModelApiAdapter, modelApiContract } from './model-api-adapter.js';
import type { ModelTranscripts } from './model-transcripts.js';
import type { ModelAdapter } from './native-agent.js';
import { digest } from './policy.js';

export const VERTEX_MODEL_CONTRACT: AdapterRouteContract = modelApiContract({
  routeId: GOOGLE_VERTEX_ROUTE,
  sdk: GOOGLE_VERTEX_SDK,
  protocol: GOOGLE_VERTEX_PROTOCOL,
  label: 'Google',
});

export interface VertexModelAdapterOptions extends StreamSinks {
  connection: VertexConnection;
  /** A short-lived access token minted for this turn from the verified ADC file. */
  secret: string;
  card: ModelRateCard;
  exposure: CallExposure;
  transcripts: ModelTranscripts;
  instructions: string;
  effort: 'low' | 'medium' | 'high';
  limits?: RespondLimits;
  transport?: typeof globalThis.fetch;
  now?: () => Date;
}

export function createVertexModelAdapter(options: VertexModelAdapterOptions): ModelAdapter & { profileHash: string } {
  const connection = Object.freeze(vertexConnectionSchema.parse(options.connection));
  const limits = options.limits ?? CONVERSATION_LIMITS;
  return createModelApiAdapter({
    route: GOOGLE_VERTEX_ROUTE,
    prefix: 'vertex',
    label: 'Google Vertex AI',
    sdk: GOOGLE_VERTEX_SDK,
    protocol: GOOGLE_VERTEX_PROTOCOL,
    contract: VERTEX_MODEL_CONTRACT,
    connectionId: connection.id,
    revision: connection.revision,
    requestedModel: connection.model,
    // Everything that decides what a call means, so saved context cannot cross a project,
    // location, model, credential, price or mode. A continuation from another route is a
    // different profile by construction.
    profile: {
      route: GOOGLE_VERTEX_ROUTE,
      sdk: GOOGLE_VERTEX_SDK,
      connectionId: connection.id,
      revision: connection.revision,
      projectId: connection.projectId,
      location: connection.location,
      baseUrl: connection.baseUrl,
      model: connection.model,
      payer: connection.payer,
      credential: connection.credential.fingerprint,
      instructions: digest(options.instructions),
      effort: options.effort,
      limits,
      rateCard: options.card.version,
    },
    transcripts: options.transcripts,
    notes: [
      'One streamed generateContent call per model step to the project’s global Vertex endpoint, for gemini-3.8-flash only; SDK retries off, one function call at most; tools are function declarations run only by the harness.',
      'A short-lived token minted from the verified Application Default Credentials file is attached only to that endpoint, with the project as x-goog-user-project; redirects are refused.',
      'The reported model is Vertex’s modelVersion, recorded beside the requested model and the project.',
      'Stopping a call closes the HTTP read. It does not prove Google stopped processing, so the spend hold stays uncertain.',
    ],
    sinks: { onDelta: options.onDelta, onToolActivity: options.onToolActivity },
    respond: (call) =>
      respondVertex({
        connection,
        secret: options.secret,
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
