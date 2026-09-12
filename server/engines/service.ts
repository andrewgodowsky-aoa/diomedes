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
import { managedBinary, verifyManagedBinary } from './install.js';
import { capture, engineEnvironment, EngineError } from './process.js';
import type { TextEngineAdapter, TextRequest } from './contract.js';

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
};
export interface EngineServiceDeps {
  discover(): Promise<IntegrationStatus[]>;
  version(file: string, signal?: AbortSignal): Promise<string>;
  adapter(engine: ExternalEngine, file: string, cwd: string): TextEngineAdapter;
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
        if (!hit && this.nativeDiscovery && id !== 'cursor') {
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
          : 'Tools are disabled by the engine configuration; this is not an operating-system sandbox.',
        'Diomedes reviews exact file proposals through its existing approvals and History.',
        'Usage remaining is unknown unless reported by the provider.',
      ],
    };
  }
  async generate(engine: ExternalEngine, input: TextRequest) {
    const key = `${input.projectId}:${input.threadId}`;
    if (this.running.has(key))
      throw new EngineError(
        'REQUEST_ACTIVE',
        'This thread already has a request in progress. Wait for it or cancel it.',
      );
    const controller = new AbortController();
    this.running.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    try {
      await this.discover(true);
      await this.check(engine, signal);
      const selected = this.selection(engine, input.model);
      if (selected.accountRoute !== input.accountRoute)
        throw new EngineError(
          'ACCOUNT_CHANGED',
          'The sign-in route changed. Select it again before sending.',
        );
      const value = this.connections.get(engine)!;
      const result = await this.deps
        .adapter(engine, value.location!, path.join(this.root, engine))
        .generate({ ...input, signal });
      if (signal.aborted)
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
      return result;
    } finally {
      this.running.delete(key);
    }
  }
  close() {
    for (const controller of this.running.values()) controller.abort();
  }
}
