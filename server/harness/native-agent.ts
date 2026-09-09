/**
 * The bounded native loop: model step, then either a final answer or one
 * registered tool step, repeated at most `maxTurns` times. Both kinds of step
 * go through the same run service, so a completed trajectory replays from its
 * persisted observations and never calls the provider again.
 *
 * The provider is injected. The fixture adapter used in tests is scripted; a
 * real adapter must keep its own opaque transcript and return it as a
 * `ProviderTranscriptRef`, which the loop records apart from the portable
 * messages. No adapter for a real provider is verified by this module.
 */
import type {
  AdapterCapabilities,
  HarnessPrincipal,
  Json,
  ModelRequest,
  ModelResponse,
  ModelResult,
  PortableMessage,
} from '../../shared/harness.js';
import { copy, HarnessError, units } from './policy.js';
import { RunService, Suspended } from './run-service.js';
import type { ToolRegistry } from './tools.js';

export interface ModelAdapter {
  id: string;
  version: string;
  capabilities(): AdapterCapabilities;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}

function validResponse(value: unknown): value is ModelResponse {
  const r = value as Partial<ModelResponse> | null;
  if (!r || typeof r !== 'object') return false;
  if (r.type === 'final') return typeof (r as { text?: unknown }).text === 'string';
  if (r.type === 'tool') return typeof (r as { name?: unknown }).name === 'string' && 'input' in r;
  return false;
}

export class NativeAgent {
  constructor(
    private readonly runtime: RunService,
    private readonly adapter: ModelAdapter,
    private readonly tools: ToolRegistry,
  ) {
    if (
      !adapter ||
      typeof adapter.id !== 'string' ||
      !adapter.id ||
      typeof adapter.version !== 'string' ||
      !adapter.version ||
      typeof adapter.complete !== 'function' ||
      typeof adapter.capabilities !== 'function'
    )
      throw new HarnessError('invalid_adapter', 'A versioned model adapter is required.');
  }

  async run(
    runId: string,
    owner: string,
    prompt: string,
    principal: HarnessPrincipal,
    options: { maxTurns?: number } = {},
  ): Promise<string> {
    const maxTurns = options.maxTurns ?? 8;
    if (units(maxTurns, 'Turn limit') === 0)
      throw new HarnessError('invalid_turns', 'A positive turn limit is required.');
    const messages: PortableMessage[] = [{ role: 'user', text: prompt }];
    // The run's capability, not the registry, decides which tools this loop may offer.
    const allowed = new Set((await this.runtime.get(runId)).capabilityTools);
    const descriptors = this.tools.describe().filter((tool) => allowed.has(tool.name));
    try {
      for (let i = 0; i < maxTurns; i++) {
        const observed = await this.runtime.step<{ response: ModelResponse }>(
          runId,
          owner,
          {
            id: `model:${i}`,
            version: this.adapter.version,
            kind: 'model',
            effect: 'read',
            name: this.adapter.id,
            cost: 1,
            input: { provider: this.adapter.id, messages: copy(messages), tools: descriptors } as unknown as Json,
          },
          async ({ signal }) => {
            const run = await this.runtime.get(runId);
            const result = await this.adapter.complete(
              {
                runId,
                capabilityId: run.capabilityId,
                messages: copy(messages),
                tools: descriptors,
                transcript: run.transcripts[this.adapter.id] ?? null,
              },
              signal,
            );
            if (!result || !validResponse(result.response))
              throw new HarnessError('invalid_model_response', 'Invalid model response schema.');
            if (result.transcript)
              await this.runtime.recordTranscript(runId, owner, this.adapter.id, result.transcript);
            return { response: result.response, usage: result.usage ?? null };
          },
          principal,
        );
        const response = observed.response;
        if (!validResponse(response))
          throw new HarnessError('invalid_model_response', 'Invalid model response schema.');
        if (response.type === 'final') {
          await this.runtime.complete(runId, owner, { text: response.text });
          return response.text;
        }
        // Effect, permission, approval and cost come from the registry, never from the model.
        if (!allowed.has(response.name))
          throw new HarnessError(
            'tool_not_in_capability',
            `Unknown tool for this capability: ${response.name}.`,
          );
        const tool = this.tools.get(response.name);
        const input = this.tools.validate(response.name, response.input) as Json;
        const output = await this.runtime.step<Json>(
          runId,
          owner,
          {
            id: `tool:${i}`,
            version: tool.version,
            kind: 'tool',
            effect: tool.effect,
            name: tool.name,
            cost: tool.cost,
            permission: tool.permission,
            approval: tool.approval,
            destination: tool.destination,
            trustedInputRequired: tool.trustedInputRequired,
            label: tool.label ?? null,
            input,
          },
          (context) => tool.execute({ ...context, input: context.input }),
          principal,
        );
        messages.push({ role: 'assistant', tool: response.name, input });
        messages.push({ role: 'tool', name: response.name, output });
      }
      throw new HarnessError('turn_limit', 'Agent turn limit reached.');
    } catch (error) {
      if (!(error instanceof Suspended)) {
        try {
          await this.runtime.fail(runId, owner, error);
        } catch {
          // A stale or cancelled run keeps whatever state the service already holds.
        }
      }
      throw error;
    }
  }
}
