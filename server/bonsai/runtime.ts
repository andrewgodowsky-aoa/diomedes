import {
  findLocalProfile,
  localModelCatalog,
  localProfileRefusal,
  LOCAL_MODEL_UNKNOWN_PROFILE,
  type LocalModelDescriptor,
  type LocalModelProfile,
  type LocalModelStatus,
} from '../../shared/local-model.js';
import type { LocalModelSetup, LocalModelSource } from './descriptor.js';

/**
 * The runtime's own refusals for work on a profile that isn't running. The host script answers an
 * inference acquire (`-NoStart`) with these same sentences (resources/bonsai-host.ps1).
 */
export const LOCAL_MODEL_NOT_RUNNING = "The local model isn't running. Start it first.";
export const localModelOtherProfile = (running: string, wanted: string) =>
  `The local model is running its ${running} profile, not ${wanted}. Start ${wanted} first.`;
/**
 * The server runs, but on a context no profile declares or one it did not report, so the profile
 * is unknown. Work that names a profile waits for that profile's Start.
 */
export const localModelUnknownProfile = (context: number | null | undefined, wanted: string) =>
  context
    ? `The local model is running with ${context.toLocaleString('en-US')} tokens of context, which matches none of its profiles. Start ${wanted} first.`
    : `The local model did not report its context size, so its profile is unknown. Start ${wanted} first.`;
/** Nothing is set up here. The host's own detail names the folder; this sentence does not. */
export const LOCAL_MODEL_NOT_INSTALLED = "The local model isn't installed on this computer.";
export { LOCAL_MODEL_UNKNOWN_PROFILE };

export class LocalModelError extends Error {
  constructor(readonly state: LocalModelStatus['state'], message: string) {
    super(message);
    this.name = 'LocalModelError';
  }
}
export interface LocalModelLease {
  status: LocalModelStatus;
  signal?: AbortSignal;
  release(): Promise<void>;
}
export interface LocalModelHost {
  /** The model's live identity, read from its own server. It starts nothing. */
  inspect(descriptor: LocalModelDescriptor): Promise<LocalModelStatus>;
  /**
   * Serializes with other apps, checks ownership and holds the lease until release. Only
   * `start: true` may start the worker or switch its profile; that is the person's explicit
   * Start. Without it a worker that is not already running the profile is refused as
   * `unloaded`, so a send, an Automatic run or a Routine never wakes the model.
   */
  acquire(profile: LocalModelProfile, options: { start?: boolean } | undefined, descriptor: LocalModelDescriptor): Promise<LocalModelLease>;
}
/** What one use of the model runs on: the descriptor it was admitted under and its server's answer. */
export interface LocalModelBinding {
  descriptor: LocalModelDescriptor;
  status: LocalModelStatus;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** How long one host check answers repeat questions while this app is not using the model. */
export const LOCAL_MODEL_STATUS_TTL_MS = 10_000;
const NOT_SET: LocalModelStatus = { state: 'missing', installed: false, mode: null, owned: false, detail: 'No local model folder is set.' };

/**
 * The local model this computer has, and one queue for selection and inference. What it is comes
 * from the folder's descriptor, read again whenever it changes, and from its running server.
 * Cancellation never kills a shared startup or somebody else's model.
 */
export class LocalModelRuntime {
  private tail: Promise<void> = Promise.resolve();
  private current: LocalModelStatus | null = null;
  /** The last host check while idle, and the one running, each for the descriptor it read. */
  private checked: { at: number; key: string; status: LocalModelStatus } | null = null;
  private checking: { key: string; status: Promise<LocalModelStatus> } | null = null;
  /** Moves whenever this app starts or uses the model, so a check begun before that is never kept. */
  private generation = 0;
  constructor(
    private readonly source: LocalModelSource,
    private readonly host: LocalModelHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** What the folder holds now: nothing, a refusal, or a descriptor. */
  setup(): LocalModelSetup {
    return this.source.read();
  }

  /** The descriptor this computer has now, or null when none is set up. */
  descriptor(): LocalModelDescriptor | null {
    const setup = this.source.read();
    return setup.kind === 'ready' ? setup.descriptor : null;
  }

  /** Set up here: a folder whose descriptor passed every check. Running is a separate question. */
  configured(): boolean {
    return this.source.read().kind === 'ready';
  }

  /** The profile a slug names, including one saved before profiles came from the descriptor. */
  profile(model: unknown): LocalModelProfile | undefined {
    return findLocalProfile(this.descriptor(), model);
  }

  /**
   * The catalogue as the last check left it: the descriptor's profiles, named for the model the
   * server listed. It asks the host nothing.
   */
  catalog(): LocalModelProfile[] {
    const setup = this.source.read();
    if (setup.kind !== 'ready') return [];
    const known = this.current ?? (this.checked?.key === setup.key ? this.checked.status : null);
    return localModelCatalog(setup.descriptor, known);
  }

  /**
   * The model's state. While this app is using it, that use answers. Otherwise a host check
   * answers repeat questions for `LOCAL_MODEL_STATUS_TTL_MS`, and questions asked while one runs
   * share it. `fresh` asks the host again: a person's refresh, or the row reading again after a
   * Start. A changed folder or descriptor is never answered from a check of the old one.
   */
  async status(options: { fresh?: boolean } = {}): Promise<LocalModelStatus> {
    const setup = this.source.read();
    if (setup.kind === 'none') return { ...NOT_SET };
    if (setup.kind === 'invalid') return { state: 'error', installed: false, mode: null, owned: false, detail: setup.detail };
    if (this.current) return { ...this.current };
    const key = setup.key;
    if (!options.fresh && this.checked?.key === key && this.now() - this.checked.at < LOCAL_MODEL_STATUS_TTL_MS)
      return { ...this.checked.status };
    if (!options.fresh && this.checking?.key === key) return { ...(await this.checking.status) };
    const generation = this.generation;
    const checking = { key, status: this.host.inspect(setup.descriptor).catch((error: unknown) => this.failure(error)) };
    this.checking = checking;
    try {
      const status = await checking.status;
      if (generation === this.generation) this.checked = { at: this.now(), key, status };
      return { ...status };
    } finally {
      if (this.checking === checking) this.checking = null;
    }
  }

  /** A start or a use changes what the host would say: forget the last check and any running one. */
  private moved() {
    this.generation += 1;
    this.checked = null;
    this.checking = null;
  }

  /**
   * Why work on this profile would be refused now, in the runtime's own words, or null when it is the
   * profile running. Running means ready or busy, as the integration reports it. Reads the status
   * only: it never starts or switches the worker.
   */
  async refusal(model: string | null): Promise<string | null> {
    const descriptor = this.descriptor();
    if (!descriptor) return LOCAL_MODEL_NOT_INSTALLED;
    const profile = findLocalProfile(descriptor, model);
    if (!profile) return localProfileRefusal(model);
    const status = await this.status();
    if (!status.installed) return LOCAL_MODEL_NOT_INSTALLED;
    const running = status.state === 'ready' || status.state === 'busy';
    if (running && status.mode === profile.mode) return null;
    if (running && status.mode) return localModelOtherProfile(status.mode, profile.mode);
    return running ? localModelUnknownProfile(status.contextTokens, profile.mode) : LOCAL_MODEL_NOT_RUNNING;
  }

  private failure(error: unknown): LocalModelStatus {
    return { installed: !(error instanceof LocalModelError && error.state === 'missing'), state: error instanceof LocalModelError ? error.state : 'error',
      mode: null, owned: false, detail: error instanceof Error ? error.message : 'The local model could not be checked.' };
  }

  /**
   * Runs `work` on the profile's worker. Inference never starts one: only `wake`, the person's
   * explicit Start, passes `start: true`.
   */
  async use<T>(model: string, signal: AbortSignal,
    work: (profile: LocalModelProfile, signal: AbortSignal, binding: LocalModelBinding) => Promise<T>,
    options: { start?: boolean } = {}): Promise<T> {
    const descriptor = this.descriptor();
    if (!descriptor) throw new LocalModelError('missing', LOCAL_MODEL_NOT_INSTALLED);
    const profile = findLocalProfile(descriptor, model);
    if (!profile) throw new LocalModelError('error', localProfileRefusal(model));
    const start = options.start === true;
    signal.throwIfAborted();
    const before = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    // The queued operation owns unlock even when its caller stops waiting.
    const operation = (async () => {
      await before;
      let lease: LocalModelLease | undefined;
      this.moved();
      try {
        signal.throwIfAborted();
        if (start) this.current = { state: 'starting', installed: true, mode: profile.mode, owned: false,
          detail: `Starting ${profile.name}.` };
        lease = await this.host.acquire(profile, { start }, descriptor);
        signal.throwIfAborted();
        if (lease.status.state !== 'ready' || lease.status.mode !== profile.mode)
          throw new LocalModelError('error', 'The local model is not ready in the selected profile.');
        const served = lease.status.model ?? descriptor.model;
        this.current = { ...lease.status, state: 'busy', detail: `${served} ${profile.mode} is in use.` };
        const active = lease.signal ? AbortSignal.any([signal, lease.signal]) : signal;
        active.throwIfAborted();
        return await work(profile, active, { descriptor, status: { ...lease.status } });
      } catch (error) {
        // A worker that is simply not running is not a failure to remember: the next status
        // reads the host again, so starting it outside the app shows at once.
        if (!signal.aborted) this.current = error instanceof LocalModelError && error.state === 'unloaded'
          ? null : this.failure(error);
        throw error;
      } finally {
        try { await lease?.release(); }
        finally {
          if (signal.aborted || this.current?.state === 'busy' || this.current?.state === 'starting') this.current = null;
          this.moved();
          unlock();
        }
      }
    })();
    return abortable(operation, signal);
  }

  /** The person's explicit Start: the one call that may start the worker or switch its profile. */
  wake(model: string, signal: AbortSignal): Promise<LocalModelStatus> {
    return this.use(model, signal, async (profile, _signal, { descriptor, status }) => {
      const served = status.model ?? descriptor.model;
      return { state: 'ready', installed: true, mode: profile.mode, model: served,
        contextTokens: status.contextTokens ?? profile.contextTokens, owned: status.owned,
        detail: `${served} ${profile.mode} is ready.` };
    }, { start: true });
  }
}
