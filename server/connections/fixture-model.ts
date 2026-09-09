import type { Json, ModelRequest } from '../../shared/harness.js';
import type { ModelAdapter } from '../harness/native-agent.js';

const registered = new WeakSet<ModelAdapter>();

/** Host-only synthetic composition. Registration is not a code execution sandbox. */
export function connectionFixtureModel(
  input: Json,
  observe: (request: ModelRequest) => void = () => {},
  options: { connectionId?: string; erroneous?: boolean } = {},
): ModelAdapter {
  const adapter: ModelAdapter = {
    id: 'connections-fixture-model',
    version: '1',
    capabilities: () => ({
      engineId: 'connections-fixture-model',
      engineVersion: '1',
      protocolVersion: '1',
      modelCalls: 'enforced',
      toolCalls: 'enforced',
      filesystemWrites: 'unsupported',
      networkEgress: 'unsupported',
      approvals: 'enforced',
      resumability: 'enforced',
      cancellability: 'enforced',
      checkpointGranularity: 'step',
      notes: ['Scripted fixture only; no external model call.'],
    }),
    complete: async (request) => {
      observe(request);
      if (request.messages.some((message) => message.role === 'tool'))
        return {
          response: {
            type: 'final',
            text: options.erroneous && !request.messages.some((message) =>
              message.role === 'user' && message.text?.includes('Correction required'))
              ? 'The untracked item has 12 units remaining.'
              : 'Menu availability checked. Some quantities are not tracked; no ingredient count was inferred.',
          },
        };
      return {
        response: {
          type: 'tool',
          name: 'conn_toast_get_item_availability',
          input: { runId: request.runId, connectionId: options.connectionId ?? 'toast-group', input },
        },
      };
    },
  };
  registered.add(adapter);
  return adapter;
}

export function isConnectionFixtureModel(adapter: ModelAdapter): boolean {
  return registered.has(adapter);
}
