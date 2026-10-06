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
  Destination,
  HarnessPrincipal,
  HarnessRun,
  Json,
  ModelRequest,
  ModelResponse,
  ModelResult,
  PortableMessage,
  ProviderTranscriptRef,
} from '../../shared/harness.js';
import { applicationOrigin, directOrigin } from '../../shared/attribution.js';
import { z } from 'zod';
import { routingReceiptSchema, type HardRestrictions } from '../../shared/routing-policy.js';
import { checkedSourceRules, copy, digest, HarnessError, units } from './policy.js';
import { RunService, Suspended } from './run-service.js';
import type { ToolRegistry } from './tools.js';
import { commandGate, type AdapterRouteContract } from '../../shared/adapter-contract.js';
import { LOCAL_MODEL_ROUTE } from '../../shared/local-model.js';

export interface ModelAdapter {
  id: string;
  /** Host-bound serialization allowance; only the local adapter declares a larger envelope. */
  preparedRequestMaxBytes?: number;
  version: string;
  /** The host must authorize external inference before dispatch and result acceptance. */
  destination?: Destination;
  /**
   * The route descriptor this adapter is bound to. The loop does not trust a
   * model that cannot say what it is: an adapter without a valid contract, or
   * one whose route declares `start` unsupported, is refused at construction.
   */
  contract: AdapterRouteContract;
  capabilities(): AdapterCapabilities;
  /**
   * `stream`, when given, receives the answer's text as it is produced (H16
   * stream-time rules). It observes only: nothing it does changes the answer.
   */
  complete(request: ModelRequest, signal: AbortSignal, stream?: ModelStreamSink): Promise<ModelResult>;
  /** Set only by a binding that intersects source rules before external inference. */
  enforcesSourceRestrictions?: true;
  /** Trusted context assembly runs in a durable pure step before final model authorization. */
  prepare?(request: ModelRequest, signal: AbortSignal): Promise<ModelRequest>;
  /** May refuse a stale prepared context; must not alter its already frozen bytes. */
  validatePrepared?(request: ModelRequest): Promise<void>;
  /** After-output inspection is supported for final text, never stream-time interception. */
  inspect?(request: ModelRequest, text: string, signal: AbortSignal): Promise<ModelInspection>;
}

/** Where a model step's streamed text goes while it is produced. */
export interface ModelStreamSink {
  onDelta(text: string): void;
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

export function validatePrepared(before: ModelRequest, after: ModelRequest, maxBytes?: number): ModelRequest {
  const parsed = z.json().safeParse(after);
  if (!parsed.success) throw new HarnessError('invalid_prepared_context', 'Context assembly must return bounded plain JSON.');
  const json = parsed.data;
  const prior = checkedSourceRules('invalid_prepared_context', before.sourceRestrictions ?? []);
  const following = checkedSourceRules('invalid_prepared_context', after.sourceRestrictions ?? []);
  if (prior.some(rule => !following.some(next => digest(next) === digest(rule))))
    throw new HarnessError('invalid_prepared_context', 'Context assembly cannot remove a source privacy restriction.');
  const serialized = JSON.stringify(json);
  if (maxBytes === undefined ? serialized.length > 262144 :
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 24_000_000 || Buffer.byteLength(serialized) > maxBytes)
    throw new HarnessError('invalid_prepared_context', 'The prepared context exceeds this route\'s request size limit.');
  if (
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

/** Only host labels and the trusted context step can attach source restrictions.
 * A tool's content/result is data, never a policy declaration. During replay,
 * later observations cannot rewrite an earlier step's immutable input.
 */
export function sourceRules(run: HarnessRun, before = run.steps.length): HardRestrictions[] {
  const sets: unknown[] = [];
  for (const step of run.steps.slice(0, before)) {
    if (step.intent.label?.sourceRestrictions) sets.push(step.intent.label.sourceRestrictions);
    if (step.intent.kind === 'model') {
      const input = step.intent.input;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        if (input.sourceRestrictions !== undefined) sets.push(input.sourceRestrictions);
        const request = input.request;
        if (request && typeof request === 'object' && !Array.isArray(request) && request.sourceRestrictions !== undefined)
          sets.push(request.sourceRestrictions);
      }
    }
    if (step.intent.kind === 'transform' && step.intent.name === 'prepare_model_context' && step.state === 'succeeded') {
      const output = step.output;
      if (output && typeof output === 'object' && !Array.isArray(output) && output.sourceRestrictions !== undefined)
        sets.push(output.sourceRestrictions);
    }
  }
  return checkedSourceRules('invalid_lineage', ...sets);
}

export function validResponse(value: unknown): value is ModelResponse {
  const r = value as Partial<ModelResponse> | null;
  if (!r || typeof r !== 'object') return false;
  if (r.type === 'final') return typeof (r as { text?: unknown }).text === 'string';
  if (r.type === 'tool') return typeof (r as { name?: unknown }).name === 'string' && 'input' in r;
  return false;
}

/**
 * Scripted local work is an application action, never model authorship.
 * The fixture adapter and the synthetic test adapter named `fixture` are both
 * fixed scripts; every other adapter id is treated as a direct engine whose
 * reported model comes only from its transcript reference.
 */
export function isScriptedAdapter(id: string): boolean {
  return id === 'native-fixture' || id === 'fixture';
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
    // The descriptor the adapter carries is operative: a route that cannot
    // say `start` is supported never drives the loop.
    const gate = commandGate(adapter.contract, 'start');
    if (!gate.admitted)
      throw new HarnessError(
        gate.code === 'command_unsupported' ? 'unsupported_command' : 'invalid_adapter',
        gate.code === 'command_unsupported'
          ? gate.reason
          : 'A model adapter must carry a valid route contract descriptor.',
      );
  }

  async run(
    runId: string,
    owner: string,
    prompt: string,
    principal: HarnessPrincipal,
    options: { maxTurns?: number; maxCorrections?: number; sourceRestrictions?: HardRestrictions[] } = {},
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
      let inherited = checkedSourceRules('invalid_source_restrictions', options.sourceRestrictions ?? []);
      const ancestors = new Set([initial.id]);
      let parent = initial.parentRunId;
      while (parent) {
        if (ancestors.has(parent) || ancestors.size >= 32) throw new HarnessError('invalid_lineage', 'Source restriction ancestry cannot be verified.');
        ancestors.add(parent);
        const record = await this.runtime.get(parent);
        if (record.tenantId !== initial.tenantId) throw new HarnessError('cross_tenant', 'Source ancestry belongs to another tenant.');
        if (record.projectId !== initial.projectId) throw new HarnessError('cross_project', 'Source ancestry belongs to another project.');
        inherited = checkedSourceRules('invalid_lineage', inherited, sourceRules(record));
        parent = record.parentRunId;
      }
      for (let i = 0; i < maxTurns; i++) {
        const run = await this.runtime.get(runId);
        const boundary = run.steps.findIndex(step => step.intent.stepId === `context:${i}` || step.intent.stepId === `model:${i}`);
        const restrictions = checkedSourceRules('invalid_lineage', inherited, sourceRules(run, boundary < 0 ? run.steps.length : boundary));
        const original: ModelRequest = {
          runId,
          capabilityId: run.capabilityId,
          messages: copy(messages),
          tools: copy(descriptors),
          transcript: copy(transcript),
          ...(restrictions.length ? { sourceRestrictions: restrictions } : {}),
        };
        const prepare = this.adapter.prepare?.bind(this.adapter);
        const maxBytes = this.adapter.contract.routeId === LOCAL_MODEL_ROUTE ? this.adapter.preparedRequestMaxBytes : undefined;
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
                  origin: applicationOrigin(),
                },
                async ({ signal }) =>
                  validatePrepared(original, await prepare(copy(original), signal), maxBytes),
                principal,
              ),
              maxBytes,
            )
          : original;
        if (effective.sourceRestrictions?.length && this.adapter.destination === 'external' && !this.adapter.enforcesSourceRestrictions)
          throw new HarnessError('source_policy_unverified', 'This external adapter cannot enforce the source privacy restrictions.');
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
            destination: this.adapter.destination ?? 'local',
            input: prepare
              ? z.json().parse({ provider: this.adapter.id, request: effective })
              : ({
                  provider: this.adapter.id,
                  messages: copy(messages),
                  tools: descriptors,
                  ...(effective.sourceRestrictions?.length ? { sourceRestrictions: effective.sourceRestrictions } : {}),
                } as unknown as Json),
          },
          async ({ signal, reportOrigin }) => {
            await this.adapter.validatePrepared?.(copy(effective));
            const result = await this.adapter.complete(copy(effective), signal);
            if (!result || !validResponse(result.response))
              throw new HarnessError('invalid_model_response', 'Invalid model response schema.');
            const managed = result.managed === undefined ? null : routingReceiptSchema.safeParse(result.managed);
            if (managed && !managed.success)
              throw new HarnessError('invalid_managed_receipt', 'The managed attempt receipt cannot be verified.');
            // Provenance comes only from adapter/runtime metadata here: the
            // transcript model id when the adapter reports one, never from
            // generated prose or a model-returned JSON self-identification.
            // Scripted adapters stay application actions.
            if (reportOrigin) {
              if (isScriptedAdapter(this.adapter.id)) reportOrigin(applicationOrigin());
              else {
                const reported = result.transcript?.modelId ?? null;
                reportOrigin(
                  directOrigin({
                    engine: this.adapter.id,
                    reportedModel: reported,
                    version: this.adapter.version,
                  }),
                );
              }
            }
            return {
              response: result.response,
              usage: result.usage ?? null,
              ...(managed?.success ? { managed: managed.data } : {}),
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
                  origin: applicationOrigin(),
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
        const input = this.tools.validate(response.name, response.input) as Json;
        // H12: the one mediated path: targets contained, effect intent recorded before the handler.
        const output = await this.tools.dispatch<Json>(this.runtime, {
          runId,
          owner,
          principal,
          stepId: `tool:${i}`,
          name: response.name,
          input,
          origin: applicationOrigin(),
        });
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
