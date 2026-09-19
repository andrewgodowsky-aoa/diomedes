import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExternalEngine, IntegrationStatus } from '../../shared/types.js';
import { ENGINE_NAMES, EXTERNAL_ENGINES, type EngineConnection } from '../../shared/engines.js';
import { createDiscovery } from '../discovery.js';
import { recordEngineCatalog } from '../models.js';
import { ClaudeAdapter, CLAUDE_VERSION } from './claude.js';
import { OpenCodeAdapter } from './opencode.js';
import { OmpAdapter } from './omp.js';
import { CursorAdapter, cursorCommand, resolveCursorEntry } from './cursor.js';
import { DevinAdapter } from './devin.js';
import { managedBinary, verifyManagedBinary } from './install.js';
import { capture, engineEnvironment, EngineError } from './process.js';
import {
  commandGate,
  previewSink,
  type PreviewRejection,
} from '../../shared/adapter-contract.js';
import type { TextEngineAdapter, TextRequest, TextResponse } from './contract.js';
import { HarnessError } from '../harness/policy.js';
import {
  TEXT_DISPATCH_STEP,
  textRunId,
  type TextDispatch,
} from '../harness/text-route.js';

function recordShimError(error: unknown): boolean {
  return (
    (error instanceof EngineError && error.code === 'UNSUPPORTED_SHIM') ||
    (error instanceof Error && 'code' in error && error.code === 'ENOENT')
  );
}

export const TESTED_VERSIONS: Record<ExternalEngine, string> = {
  'claude-code': CLAUDE_VERSION,
  opencode: '1.18.4',
  'oh-my-pi': '18.0.6',
  cursor: '2026.08.11',
  devin: '3000.10.23',
};
export interface EngineServiceDeps {
  discover(): Promise<IntegrationStatus[]>;
  version(file: string, signal?: AbortSignal): Promise<string>;
  adapter(engine: ExternalEngine, file: string, cwd: string): TextEngineAdapter;
  /**
   * The preview contract's redaction: any secret the caller knows is in scope
   * for this engine's deltas. Applied before the frame is measured or emitted.
   */
  redactFor?(engine: ExternalEngine): (text: string) => string;
}
const blank = (engine: ExternalEngine): EngineConnection => ({
  engine,
  installation: 'not-checked',
  compatibility: 'unknown',
  authentication: 'unknown',
  accountRoute: null,
  models: [],
  checkedAt: null,
  detail: 'Check this computer to find installed tools.',
  usage: { state: 'unknown', checkedAt: null },
});
export class EngineService {
  private readonly connections = new Map(EXTERNAL_ENGINES.map((id) => [id, blank(id)]));
  private readonly deps: EngineServiceDeps;
  private discovering?: Promise<EngineConnection[]>;
  private checks = new Map<ExternalEngine, Promise<EngineConnection>>();
  private readonly nativeDiscovery: boolean;
  private running = new Map<string, AbortController>();
  /**
   * The host's runtime seam. External turns do not call an adapter here;
   * they run through the harness RunService under a durable run, its lease
   * fence and its egress authorization. The app attaches the host's
   * `TextRouteRuntime.request` after the harness host exists.
   */
  dispatch?: TextDispatch;
  constructor(
    readonly root: string,
    deps: Partial<EngineServiceDeps> = {},
  ) {
    this.nativeDiscovery = !deps.discover;
    this.deps = {
      discover: async () => (await createDiscovery().discover()).engines,
      version: async (file, signal) => {
        const command =
          path.basename(file) === 'index.js'
            ? cursorCommand(file, ['--version'])
            : { file, args: ['--version'] };
        const result = await capture({
          ...command,
          cwd: root,
          env: engineEnvironment(),
          signal,
          timeoutMs: 5000,
          maxBytes: 4096,
        });
        if (result.code !== 0)
          throw new EngineError(
            'VERSION_UNKNOWN',
            'The tool could not report its version. Check its dependencies.',
          );
        const match = result.stdout.match(/\b\d+\.\d+\.\d+\b/);
        if (!match)
          throw new EngineError('VERSION_UNKNOWN', 'The installed version could not be verified.');
        return match[0];
      },
      adapter: (engine, file, cwd) => {
        if (engine === 'claude-code') return new ClaudeAdapter(file, cwd);
        if (engine === 'opencode') return new OpenCodeAdapter(file, cwd);
        if (engine === 'cursor') return new CursorAdapter(file, cwd);
        if (engine === 'devin') return new DevinAdapter(file, cwd);
        return new OmpAdapter(file, cwd);
      },
      ...deps,
    };
  }
  status(): EngineConnection[] {
    return EXTERNAL_ENGINES.map((id) => structuredClone(this.connections.get(id)!));
  }
  private save(value: EngineConnection) {
    this.connections.set(value.engine, value);
    recordEngineCatalog({
      engine: value.engine,
      models: value.authentication === 'signed-in' ? value.models : [],
      detail: value.detail,
    });
    return structuredClone(value);
  }
  async discover(consent: boolean): Promise<EngineConnection[]> {
    if (!consent)
      throw new EngineError(
        'CONSENT_REQUIRED',
        'Confirm the local discovery disclosure before checking this computer.',
      );
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      await fs.mkdir(this.root, { recursive: true });
      const found = await this.deps.discover();
      for (const id of EXTERNAL_ENGINES) {
        let hit = found.find((row) => row.id === id && row.found);
        if (!hit && this.nativeDiscovery && id !== 'cursor' && id !== 'devin') {
          const file = managedBinary(this.root, id);
          try {
            await fs.access(file);
            await verifyManagedBinary(this.root, id);
            const version = await this.deps.version(file);
            hit = {
              ...this.integration(id, false),
              id,
              found: true,
              location: file,
              installedVersion: version,
            };
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
              throw error;
          }
        }
        if (hit?.location && id === 'opencode' && /\.cmd$/i.test(hit.location)) {
          const native = path.join(
            path.dirname(hit.location),
            'node_modules',
            'opencode-ai',
            'bin',
            'opencode.exe',
          );
          try {
            await fs.access(native);
            hit = { ...hit, location: native };
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
              throw error;
          }
        }
        if (hit?.location && id === 'cursor' && /\.(cmd|bat)$/i.test(hit.location)) {
          try {
            hit = { ...hit, location: await resolveCursorEntry(hit.location) };
          } catch (error) {
            if (recordShimError(error)) hit = { ...hit, installedVersion: undefined };
            else throw error;
          }
        }
        const old = this.connections.get(id)!;
        // A fresh inventory cannot retain readiness across changed binaries.
        if (
          hit &&
          hit.location === old.location &&
          hit.installedVersion === old.version &&
          old.authentication === 'signed-in'
        )
          continue;
        this.save({
          ...blank(id),
          installation: hit ? 'found' : 'missing',
          compatibility:
            hit?.installedVersion === TESTED_VERSIONS[id]
              ? 'supported'
              : hit
                ? 'unsupported'
                : 'unknown',
          ...(hit?.location ? { location: hit.location } : {}),
          ...(hit?.installedVersion ? { version: hit.installedVersion } : {}),
          checkedAt: new Date().toISOString(),
          detail: !hit
            ? 'Install this tool to connect it.'
            : hit.installedVersion !== TESTED_VERSIONS[id]
              ? `This adapter was checked with ${TESTED_VERSIONS[id]}. The installed version needs compatibility review.`
              : 'Found a compatible installation. Check sign-in and models next.',
        });
      }
      return this.status();
    })();
    try {
      return await this.discovering;
    } finally {
      this.discovering = undefined;
    }
  }
  async check(engine: ExternalEngine, signal?: AbortSignal): Promise<EngineConnection> {
    if (this.checks.has(engine))
      throw new EngineError(
        'REQUEST_ACTIVE',
        'This service is already being checked. Wait for that check before starting another request.',
      );
    const job = this.inspect(engine, signal);
    this.checks.set(engine, job);
    try {
      return await job;
    } finally {
      this.checks.delete(engine);
    }
  }
  private async inspect(engine: ExternalEngine, signal?: AbortSignal) {
    const saved = this.connections.get(engine)!;
    if (saved.installation !== 'found' || !saved.location)
      throw new EngineError('NOT_INSTALLED', 'The tool was not found. Check this computer again.');
    if (saved.compatibility !== 'supported')
      throw new EngineError(
        'UNSUPPORTED_VERSION',
        `Use the reviewed ${TESTED_VERSIONS[engine]} version before connecting this route.`,
      );
    try {
      if (
        engine !== 'cursor' &&
        engine !== 'devin' &&
        path.resolve(saved.location) === path.resolve(managedBinary(this.root, engine))
      )
        await verifyManagedBinary(this.root, engine);
      const version = await this.deps.version(saved.location, signal);
      if (version !== TESTED_VERSIONS[engine])
        throw new EngineError(
          'UNSUPPORTED_VERSION',
          'The tool changed version. Check compatibility before sending.',
        );
      const cwd = path.join(this.root, engine);
      await fs.mkdir(cwd, { recursive: true });
      const result = await this.deps.adapter(engine, saved.location, cwd).inspect(signal);
      return this.save({ ...saved, ...result, checkedAt: new Date().toISOString() });
    } catch (error) {
      this.save({
        ...saved,
        authentication:
          error instanceof EngineError && error.code === 'AUTH_REQUIRED' ? 'signed-out' : 'unknown',
        models: [],
        accountRoute: null,
        compatibility:
          error instanceof EngineError && error.code === 'UNSUPPORTED_VERSION'
            ? 'unsupported'
            : saved.compatibility,
        checkedAt: new Date().toISOString(),
        detail:
          error instanceof EngineError
            ? error.message
            : 'The connection could not be checked. Recheck its installation, network and sign-in.',
      });
      throw error;
    }
  }
  selection(engine: ExternalEngine, model: string) {
    const state = this.connections.get(engine)!;
    if (
      state.authentication !== 'signed-in' ||
      state.compatibility !== 'supported' ||
      !state.accountRoute
    )
      throw new EngineError('AUTH_REQUIRED', 'Check sign-in before selecting this service.');
    if (!state.checkedAt || Date.now() - Date.parse(state.checkedAt) > 300_000)
      throw new EngineError('STALE_STATUS', 'Recheck this connection before selecting it.');
    if (!state.models.some((row) => row.slug === model))
      throw new EngineError(
        'MODEL_UNAVAILABLE',
        'The selected model is no longer offered. Choose a model after rechecking.',
      );
    return { engine, model, accountRoute: state.accountRoute };
  }
  integration(engine: ExternalEngine, enabled: boolean): IntegrationStatus {
    const value = this.connections.get(engine)!;
    const fresh = !!value.checkedAt && Date.now() - Date.parse(value.checkedAt) < 300_000;
    const ready =
      value.installation === 'found' &&
      value.compatibility === 'supported' &&
      value.authentication === 'signed-in' &&
      value.models.length > 0 &&
      fresh;
    return {
      id: engine,
      name: ENGINE_NAMES[engine],
      kind: 'online',
      found: value.installation === 'found',
      available: ready,
      enabled,
      status: ready
        ? 'Ready'
        : value.installation === 'not-checked'
          ? 'Not checked'
          : value.installation === 'missing'
            ? 'Not installed'
            : value.compatibility === 'unsupported'
              ? 'Compatibility check needed'
              : value.authentication === 'signed-out'
                ? 'Sign in required'
                : 'Check connection',
      detail: fresh ? value.detail : 'Recheck this connection before use.',
      signIn: value.authentication === 'signed-out' ? 'not-signed-in' : value.authentication,
      adapter: 'ready',
      installedVersion: value.version,
      provenVersion: TESTED_VERSIONS[engine],
      location: value.location,
      capabilities: ready ? ['ask', 'plan', 'work-proposals'] : [],
      disclosure: [
        'Selected text is sent to the chosen service using its native account route.',
        engine === 'cursor'
          ? 'Cursor denies tools through native permissions and stops on tool events; this is not an operating-system sandbox.'
          : engine === 'devin'
            ? 'Devin runs in ask mode with project deny rules and stops on tool events; its own MCP configuration still loads. This is not an operating-system sandbox.'
            : 'Tools are disabled by the engine configuration; this is not an operating-system sandbox.',
        'Diomedes reviews exact file proposals through its existing approvals and History.',
        'Usage remaining is unknown unless reported by the provider.',
      ],
    };
  }
  /**
   * One admitted external text turn. Admission runs inside the run's recorded
   * `text:admission` step; the provider transport runs inside the fenced
   * `text:dispatch` step. Preview frames are stamped with the run, step,
   * attempt and fence of the attempt that produced them.
   */
  async generate(
    engine: ExternalEngine,
    input: TextRequest,
  ): Promise<TextResponse & { runId: string }> {
    const key = `${input.projectId}:${input.threadId}`;
    if (this.running.has(key))
      throw new EngineError(
        'REQUEST_ACTIVE',
        'This thread already has a request in progress. Wait for it or cancel it.',
      );
    const dispatch = this.dispatch;
    if (!dispatch)
      throw new EngineError(
        'RUNTIME_UNAVAILABLE',
        'The harness runtime seam is not attached to this service.',
        true,
      );
    const controller = new AbortController();
    this.running.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    try {
      if (input.onDelta)
        throw new EngineError(
          'PREVIEW_CONTRACT',
          'Preview frames reach the caller through onPreview; the raw adapter sink is not caller-facing.',
          true,
        );
      const runId = textRunId(input.projectId, input.requestId);
      const previewFailures: PreviewRejection[] = [];
      const outcome = await dispatch<TextAdmission, TextResponse>({
        runId,
        intent: {
          engine,
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
          model: input.model,
          accountRoute: input.accountRoute,
          prompt: input.prompt,
          instructions: input.instructions,
          documents: input.documents,
          effort: input.effort ?? null,
        },
        signal,
        admit: async () => {
          await this.discover(true);
          await this.check(engine, signal);
          const selected = this.selection(engine, input.model);
          if (selected.accountRoute !== input.accountRoute)
            throw new EngineError(
              'ACCOUNT_CHANGED',
              'The sign-in route changed. Select it again before sending.',
            );
          const value = this.connections.get(engine)!;
          const adapter = this.deps.adapter(
            engine,
            value.location!,
            path.join(this.root, engine),
          );
          // The descriptor the adapter carries is operative: dispatch only
          // what the route declares, only for the proven build.
          if (adapter.id !== engine)
            throw new EngineError(
              'CONTRACT_MISMATCH',
              `The ${engine} route was handed an adapter identifying as ${adapter.id}.`,
              true,
            );
          const gate = commandGate(adapter.contract, 'start');
          if (!gate.admitted)
            throw new EngineError(
              gate.code === 'command_unsupported' ? 'COMMAND_UNSUPPORTED' : 'CONTRACT_INVALID',
              gate.reason,
              true,
            );
          if (
            adapter.contract.routeId !== engine ||
            adapter.contract.engine.version !== TESTED_VERSIONS[engine]
          )
            throw new EngineError(
              'CONTRACT_MISMATCH',
              'The adapter descriptor does not name this route and its proven build.',
              true,
            );
          return {
            engine,
            location: value.location!,
            model: selected.model,
            accountRoute: selected.accountRoute,
          } satisfies TextAdmission;
        },
        send: async (context, admission) => {
          const adapter = this.deps.adapter(
            engine,
            admission.location,
            path.join(this.root, engine),
          );
          // Stamp the attempt, then check its current durable ownership at
          // publication. Transport cancellation alone cannot fence a preview.
          const attemptSignal = AbortSignal.any([signal, context.signal]);
          let accepting = true;
          let pending = Promise.resolve();
          let publicationFailure: { error: unknown } | undefined;
          const onDelta = previewSink({
            identity: {
              projectId: input.projectId,
              threadId: input.threadId,
              requestId: input.requestId,
              runId,
              stepId: TEXT_DISPATCH_STEP,
              attempt: context.attempt,
              fence: context.fence,
            },
            redact: this.deps.redactFor?.(engine),
            onPreview: (frame) => {
              if (!accepting || publicationFailure) return;
              pending = pending
                .then(async () => {
                  if (publicationFailure) return;
                  await context.publishPreview(() => {
                    if (!attemptSignal.aborted) input.onPreview?.(frame);
                  });
                })
                .catch((error: unknown) => {
                  publicationFailure = { error };
                });
            },
            onInvalid: (failure) => previewFailures.push(failure),
            signal: attemptSignal,
          });
          let result: TextResponse;
          try {
            result = await adapter.generate({ ...input, signal: attemptSignal, onDelta });
          } finally {
            accepting = false;
            // Drain ordered publications before the step can commit or fail.
            await pending;
          }
          if (publicationFailure) throw publicationFailure.error;
          if (attemptSignal.aborted)
            throw new EngineError(
              'CANCELLED',
              'The request was stopped. No late response was saved.',
              true,
            );
          if (
            result.projectId !== input.projectId ||
            result.threadId !== input.threadId ||
            result.requestId !== input.requestId ||
            result.version !== TESTED_VERSIONS[engine]
          )
            throw new EngineError(
              'IDENTITY_MISMATCH',
              'The engine response did not match this request. No response was saved.',
              true,
            );
          if (previewFailures.length)
            throw new EngineError('OUTPUT_LIMIT', previewFailures[0].reason, true);
          return result;
        },
      });
      return { ...outcome.result, runId: outcome.run.id };
    } catch (error) {
      throw seamError(error);
    } finally {
      // Invalidate callbacks retained by a transport after either outcome.
      // A settled request must not publish previews into a later request.
      controller.abort();
      this.running.delete(key);
    }
  }
  close() {
    for (const controller of this.running.values()) controller.abort();
  }
}

/** The durable admission record — what the admission step is allowed to persist. */
interface TextAdmission {
  engine: ExternalEngine;
  location: string;
  model: string;
  accountRoute: string;
}

/**
 * The runtime seam's errors surface in the service's own vocabulary. A
 * cancelled or parked run is a request outcome, not a transport fault; an
 * unattributed runtime failure is internal and never presented as provider
 * behaviour.
 */
function seamError(error: unknown): unknown {
  if (!(error instanceof HarnessError)) return error;
  const { code, message } = error;
  if (code === 'run_cancelled' || code === 'step_cancelled')
    return new EngineError(
      'CANCELLED',
      'The request was stopped. No late response was saved.',
      true,
    );
  if (
    code === 'reconcile_required' ||
    code === 'stale_lease' ||
    code === 'stale_attempt'
  )
    // The dispatch may have reached the provider; the record stays uncertain.
    return new EngineError(
      'DISPATCH_UNCERTAIN',
      `The dispatch outcome could not be confirmed. ${message}`,
      true,
    );
  // A dispatch-phase denial is a refusal: the provider never saw the request.
  // (A result-phase denial surfaces earlier as the parked reconcile_required.)
  if (code === 'egress_denied')
    return new EngineError('ROUTE_REFUSED', message, true);
  if (code === 'lease_busy' || (code === 'blocked' && /in flight/.test(message)))
    return new EngineError(
      'REQUEST_ACTIVE',
      'This request already has a dispatch in progress.',
      true,
    );
  if (code === 'input_mismatch' || code === 'run_id_collision')
    return new EngineError('IDENTITY_MISMATCH', message, true);
  if (code === 'request_failed')
    return new EngineError('PROVIDER_ERROR', message, true);
  return new EngineError('RUNTIME_UNAVAILABLE', message, true);
}
