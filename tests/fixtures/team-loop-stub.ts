/**
 * A scriptable stub model-API route for H14 team host tests. It stands in for
 * Google Vertex AI's admission and adapter only, and hands each call to a
 * script chosen by what the call is for: the lead loop, a worker or the
 * advisor. Model steps are marked external, as the real route's are. No
 * network is touched and nothing is spent.
 */
import type { ModelRequest, ModelResult } from '../../shared/harness.js';
import type { LoopModelRoutes } from '../../server/harness/capabilities/native-loop.js';
import { VERTEX_MODEL_CONTRACT } from '../../server/harness/vertex-model-adapter.js';

export const TEAM_STUB_ACCOUNT_ROUTE = 'google-vertex:stub-connection@r1';
export const TEAM_STUB_MODEL = 'stub-gemini';
export const TEAM_STUB_REPORTED = 'stub-gemini-001';

export type Purpose = 'loop' | 'delegate' | 'worker' | 'advisor';
export type Script = (call: ModelRequest, context: { runId: string; purpose: Purpose; signal: AbortSignal }) => Promise<Omit<ModelResult, 'transcript'>> | Omit<ModelResult, 'transcript'>;

export interface StubLog {
  readonly calls: { purpose: Purpose; runId: string; at: number; done: number | null }[];
}

export function teamRoutes(scripts: Partial<Record<Purpose, Script>>, log: StubLog = { calls: [] }): LoopModelRoutes {
  return {
    admit: async () => ({ model: TEAM_STUB_MODEL, accountRoute: TEAM_STUB_ACCOUNT_ROUTE }),
    adapter: async (route, request, stop) => ({
      id: route,
      version: 'stub-1',
      contract: VERTEX_MODEL_CONTRACT,
      destination: 'external',
      capabilities: () => ({
        engineId: route,
        engineVersion: 'stub-1',
        protocolVersion: 'stub',
        modelCalls: 'enforced',
        toolCalls: 'enforced',
        filesystemWrites: 'unsupported',
        networkEgress: 'enforced',
        approvals: 'unsupported',
        resumability: 'observed',
        cancellability: 'observed',
        checkpointGranularity: 'step',
        notes: ['A test stub; no provider.'],
      }),
      async complete(call, signal): Promise<ModelResult> {
        const purpose = request.purpose as Purpose;
        const entry = { purpose, runId: request.runId, at: Date.now(), done: null as number | null };
        log.calls.push(entry);
        const script = scripts[purpose];
        if (!script) throw new Error(`No stub script for ${purpose}.`);
        const result = await script(call, { runId: request.runId, purpose, signal: AbortSignal.any([signal, stop]) });
        entry.done = Date.now();
        return {
          ...result,
          transcript: {
            providerId: route,
            modelId: TEAM_STUB_REPORTED,
            lineageId: `stub-${request.runId}`,
            opaqueRef: `stub-${log.calls.length}`,
            prefixHash: `stub-${call.messages.length}`,
          },
        };
      },
    }),
  };
}

/** Wait for `ms`, or reject when the call is aborted. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export const toolResults = (call: ModelRequest) => call.messages.filter((message) => message.role === 'tool');
