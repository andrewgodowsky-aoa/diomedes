/**
 * A stub model-API route for Diomedes loop host tests. It stands in for Google
 * Vertex AI's admission and adapter only, so the host's delegation, Stop and
 * recovery paths can be driven without a provider. Its model steps are marked
 * external, exactly as the real route's are, so an in-flight call at a crash is
 * parked for reconciliation and never resent. No network is touched.
 */
import type { ModelResult } from '../../shared/harness.js';
import type { LoopModelRoutes } from '../../server/harness/capabilities/native-loop.js';
import { VERTEX_MODEL_CONTRACT } from '../../server/harness/vertex-model-adapter.js';

export const STUB_ACCOUNT_ROUTE = 'google-vertex:stub-connection@r1';
export const STUB_MODEL = 'stub-gemini';
export const STUB_REPORTED_MODEL = 'stub-gemini-001';

export function stubRoutes(behaviour: 'answer' | 'hang', calls: string[] = []): LoopModelRoutes {
  return {
    admit: async () => ({ model: STUB_MODEL, accountRoute: STUB_ACCOUNT_ROUTE }),
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
        calls.push(`${request.purpose}:${request.runId}`);
        if (behaviour === 'hang')
          await new Promise((_resolve, reject) => {
            const abort = () => reject(new Error('aborted'));
            signal.addEventListener('abort', abort, { once: true });
            stop.addEventListener('abort', abort, { once: true });
          });
        const transcript = {
          providerId: route,
          modelId: STUB_REPORTED_MODEL,
          lineageId: `stub-${request.runId}`,
          opaqueRef: `stub-${calls.length}`,
          prefixHash: `stub-${call.messages.length}`,
        };
        const outputs = call.messages.filter((message) => message.role === 'tool');
        const named = call.messages[0]?.text?.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/)?.[0] ?? 'README.md';
        if (!outputs.length && call.tools.some((tool) => tool.name === 'read_project_file'))
          return { response: { type: 'tool', name: 'read_project_file', input: { path: named } }, transcript };
        const text = (outputs[0]?.output as { text?: string } | undefined)?.text ?? '';
        return {
          response: { type: 'final', text: `${named}: ${text.split('\n').find((line) => line.trim()) ?? 'nothing readable'}` },
          transcript,
        };
      },
    }),
  };
}
