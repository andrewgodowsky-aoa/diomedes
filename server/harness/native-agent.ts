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
  ProviderTranscriptRef,
} from '../../shared/harness.js';
import { z } from 'zod';
import { copy, digest, HarnessError, units } from './policy.js';
import { RunService, Suspended } from './run-service.js';
import type { ToolRegistry } from './tools.js';

export interface ModelAdapter {
  id: string;
  version: string;
  capabilities(): AdapterCapabilities;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
  /** Trusted context assembly runs in a durable pure step before final model authorization. */
  prepare?(request: ModelRequest, signal: AbortSignal): Promise<ModelRequest>;
  /** May refuse a stale prepared context; must not alter its already frozen bytes. */
  validatePrepared?(request: ModelRequest): Promise<void>;
  /** After-output inspection is supported for final text, never stream-time interception. */
  inspect?(request: ModelRequest, text: string, signal: AbortSignal): Promise<ModelInspection>;
}

export interface ModelInspection {
  action: 'verified' | 'correct' | 'refuse';
  message: string;
  rules: { id: string; version: number }[];
}
const inspectionSchema = z.strictObject({
  action: z.enum(['verified', 'correct', 'refuse']),
  message: z.string().max(4000),
  rules: z
    .array(z.strictObject({ id: z.string().max(80), version: z.number().int().positive() }))
    .max(30),
});

function validatePrepared(before: ModelRequest, after: ModelRequest): ModelRequest {
  const json = z.json().parse(after);
  if (
    JSON.stringify(json).length > 262144 ||
    after.runId !== before.runId ||
    after.capabilityId !== before.capabilityId ||
    digest(after.transcript) !== digest(before.transcript) ||
    !Array.isArray(after.messages) ||
    !Array.isArray(after.tools) ||
    after.tools.some((tool) => !before.tools.some((original) => digest(tool) === digest(original)))
  )
    throw new HarnessError(
      'invalid_prepared_context',
      'Context assembly cannot change scope, transcript or tool authority.',
    );
  return copy(after);
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
    options: { maxTurns?: number; maxCorrections?: number } = {},
  ): Promise<string> {
    const maxTurns = options.maxTurns ?? 8;
    if (units(maxTurns, 'Turn limit') === 0)
      throw new HarnessError('invalid_turns', 'A positive turn limit is required.');
    const messages: PortableMessage[] = [{ role: 'user', text: prompt }];
    // The run's capability, not the registry, decides which tools this loop may offer.
    const allowed = new Set((await this.runtime.get(runId)).capabilityTools);
    const descriptors = this.tools.describe().filter((tool) => allowed.has(tool.name));
    const maxCorrections = units(options.maxCorrections ?? 1, 'Correction limit');
    if (maxCorrections > 3)
      throw new HarnessError(
        'invalid_correction_limit',
        'At most three corrective reasoning steps are supported.',
      );
    let corrections = 0;
    const initial = await this.runtime.get(runId);
    const savedContext = initial.steps.find((step) => step.intent.stepId === 'context:0');
    const savedModel = initial.steps.find((step) => step.intent.stepId === 'model:0');
    const transcriptSchema = z.strictObject({
      providerId: z.string(),
      modelId: z.string().nullable(),
      lineageId: z.string(),
      opaqueRef: z.string(),
      prefixHash: z.string(),
    });
    const savedInput = savedContext?.intent.input;
    const savedOutput = savedModel?.output;
    let transcript: ProviderTranscriptRef | null = initial.transcripts[this.adapter.id] ?? null;
    if (
      savedInput &&
      typeof savedInput === 'object' &&
      !Array.isArray(savedInput) &&
      'transcript' in savedInput
    )
      transcript = transcriptSchema.nullable().parse(savedInput.transcript);
    else if (
      savedOutput &&
      typeof savedOutput === 'object' &&
      !Array.isArray(savedOutput) &&
      'inputTranscript' in savedOutput
    )
      transcript = transcriptSchema.nullable().parse(savedOutput.inputTranscript);
    else if (savedModel && transcript)
      throw new HarnessError(
        'legacy_transcript_replay',
        'This older trajectory has no per-step transcript reference; it requires reconciliation.',
      );
    try {
      for (let i = 0; i < maxTurns; i++) {
        const run = await this.runtime.get(runId);
        const original: ModelRequest = {
          runId,
          capabilityId: run.capabilityId,
          messages: copy(messages),
          tools: copy(descriptors),
          transcript: copy(transcript),
        };
        const prepare = this.adapter.prepare?.bind(this.adapter);
        const effective = prepare
          ? validatePrepared(
              original,
              await this.runtime.step<ModelRequest>(
                runId,
                owner,
                {
                  id: `context:${i}`,
                  version: this.adapter.version,
                  kind: 'transform',
                  effect: 'pure',
                  name: 'prepare_model_context',
                  input: z.json().parse(original),
                  cost: 0,
                },
                async ({ signal }) =>
                  validatePrepared(original, await prepare(copy(original), signal)),
                principal,
              ),
            )
          : original;
        // Validation can deny replay after a rule or authority change. It never rewrites the saved context.
        await this.adapter.validatePrepared?.(copy(effective));
        const observed = await this.runtime.step<{
          response: ModelResponse;
          transcript?: ProviderTranscriptRef;
        }>(
          runId,
          owner,
          {
            id: `model:${i}`,
            version: this.adapter.version,
            kind: 'model',
            effect: 'read',
            name: this.adapter.id,
            cost: 1,
            input: prepare
              ? z.json().parse({ provider: this.adapter.id, request: effective })
              : ({
                  provider: this.adapter.id,
                  messages: copy(messages),
                  tools: descriptors,
                } as unknown as Json),
          },
          async ({ signal }) => {
            await this.adapter.validatePrepared?.(copy(effective));
            const result = await this.adapter.complete(copy(effective), signal);
            if (!result || !validResponse(result.response))
              throw new HarnessError('invalid_model_response', 'Invalid model response schema.');
            return {
              response: result.response,
              usage: result.usage ?? null,
              ...(result.transcript
                ? {
                    transcript: transcriptSchema.parse(result.transcript),
                    inputTranscript: copy(effective.transcript),
                  }
                : {}),
            };
          },
          principal,
        );
        if (observed.transcript) {
          transcript = transcriptSchema.parse(observed.transcript);
          // Advance from this exact saved observation, never from the run's latest ref.
          // A crash before this convenience index update replays the saved step first.
          const current = await this.runtime.get(runId);
          const latest = current.steps
            .filter(
              (step) =>
                step.intent.kind === 'model' &&
                step.intent.name === this.adapter.id &&
                step.state === 'succeeded',
            )
            .at(-1);
          if (
            latest?.intent.stepId === `model:${i}` &&
            digest(current.transcripts[this.adapter.id] ?? null) !== digest(transcript)
          )
            await this.runtime.recordTranscript(runId, owner, this.adapter.id, transcript);
        }
        const response = observed.response;
        if (!validResponse(response))
          throw new HarnessError('invalid_model_response', 'Invalid model response schema.');
        if (response.type === 'final') {
          const inspect = this.adapter.inspect?.bind(this.adapter);
          if (inspect) {
            const inspection = inspectionSchema.parse(
              await this.runtime.step<ModelInspection>(
                runId,
                owner,
                {
                  id: `inspection:${i}`,
                  version: this.adapter.version,
                  kind: 'transform',
                  effect: 'pure',
                  name: 'inspect_model_output',
                  cost: 0,
                  input: z.json().parse({
                    request: effective,
                    text: response.text,
                    corrections,
                    maxCorrections,
                  }),
                },
                async ({ signal }) =>
                  inspectionSchema.parse(await inspect(copy(effective), response.text, signal)),
                principal,
              ),
            );
            if (inspection.action === 'refuse')
              throw new HarnessError('verification_failed', inspection.message);
            if (inspection.action === 'correct') {
              if (++corrections > maxCorrections)
                throw new HarnessError(
                  'correction_limit',
                  'Verification still fails after the bounded correction.',
                );
              messages.push({ role: 'assistant', text: response.text });
              messages.push({ role: 'user', text: `Correction required: ${inspection.message}` });
              continue;
            }
          }
          await this.runtime.complete(runId, owner, { text: response.text });
          return response.text;
        }
        // Effect, permission, approval and cost come from the registry, never from the model.
        const offered = effective.tools.find((descriptor) => descriptor.name === response.name);
        const current = this.tools
          .describe()
          .find((descriptor) => descriptor.name === response.name);
        if (
          !allowed.has(response.name) ||
          !offered ||
          !current ||
          digest(offered) !== digest(current)
        )
          throw new HarnessError(
            'tool_not_in_context',
            `Unknown tool for this final model context: ${response.name}.`,
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
