import { bonsaiProfile, type BonsaiMode, type BonsaiProfile, type BonsaiStatus } from '../../shared/bonsai.js';

/**
 * The runtime's own refusals for work on a profile that isn't running. The host script answers an
 * inference acquire (`-NoStart`) with these same sentences (resources/bonsai-host.ps1).
 */
export const LOCAL_MODEL_NOT_RUNNING = "The local model isn't running. Start it first.";
export const localModelOtherProfile = (running: BonsaiMode, wanted: BonsaiMode) =>
  `The local model is running its ${running} profile, not ${wanted}. Start ${wanted} first.`;
/** Nothing is installed here. The host's own detail names the product; this sentence does not. */
export const LOCAL_MODEL_NOT_INSTALLED = "The local model isn't installed on this computer.";
export const LOCAL_MODEL_UNKNOWN_PROFILE = 'Choose a local model profile.';

export class BonsaiError extends Error {
  constructor(readonly state: BonsaiStatus['state'], message: string) {
    super(message);
    this.name = 'BonsaiError';
  }
}
export interface BonsaiLease {
  status: BonsaiStatus;
  signal?: AbortSignal;
  release(): Promise<void>;
}
export interface BonsaiHost {
  inspect(): Promise<BonsaiStatus>;
  /**
   * Serializes with other apps, checks ownership and holds the lease until release. Only
   * `start: true` may start the worker or switch its profile; that is the person's explicit
   * Start. Without it a worker that is not already running the profile is refused as
   * `unloaded`, so a send, an Automatic run or a Routine never wakes the model.
   */
  acquire(profile: BonsaiProfile, options?: { start?: boolean }): Promise<BonsaiLease>;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One queue for selection and inference. Cancellation never kills a shared startup or somebody else's model. */
export class BonsaiRuntime {
  private tail: Promise<void> = Promise.resolve();
  private current: BonsaiStatus | null = null;
  constructor(private readonly host: BonsaiHost) {}

  async status(): Promise<BonsaiStatus> {
    if (this.current) return { ...this.current };
    try { return await this.host.inspect(); }
    catch (error) { return this.failure(error); }
  }

  /**
   * Why work on this profile would be refused now, in the runtime's own words, or null when it is the
   * profile running. Running means ready or busy, as the integration reports it. Reads the status
   * only: it never starts or switches the worker.
   */
  async refusal(model: string | null): Promise<string | null> {
    const profile = bonsaiProfile(model);
    if (!profile) return LOCAL_MODEL_UNKNOWN_PROFILE;
    const status = await this.status();
    if (!status.installed) return LOCAL_MODEL_NOT_INSTALLED;
    const running = status.state === 'ready' || status.state === 'busy';
    if (running && status.mode === profile.mode) return null;
    return running && status.mode ? localModelOtherProfile(status.mode, profile.mode) : LOCAL_MODEL_NOT_RUNNING;
  }

  private failure(error: unknown): BonsaiStatus {
    return { installed: !(error instanceof BonsaiError && error.state === 'missing'), state: error instanceof BonsaiError ? error.state : 'error',
      mode: null, owned: false, detail: error instanceof Error ? error.message : 'Bonsai could not be checked.' };
  }

  /**
   * Runs `work` on the profile's worker. Inference never starts one: only `wake`, the person's
   * explicit Start, passes `start: true`.
   */
  async use<T>(model: string, signal: AbortSignal, work: (profile: BonsaiProfile, signal: AbortSignal) => Promise<T>,
    options: { start?: boolean } = {}): Promise<T> {
    const profile = bonsaiProfile(model);
    if (!profile) throw new BonsaiError('error', 'Choose a configured Bonsai profile. Nothing was sent.');
    const start = options.start === true;
    signal.throwIfAborted();
    const before = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    // The queued operation owns unlock even when its caller stops waiting.
    const operation = (async () => {
      await before;
      let lease: BonsaiLease | undefined;
      try {
        signal.throwIfAborted();
        if (start) this.current = { state: 'starting', installed: true, mode: profile.mode, owned: false,
          detail: `Starting ${profile.name}.` };
        lease = await this.host.acquire(profile, { start });
        signal.throwIfAborted();
        if (lease.status.state !== 'ready' || lease.status.mode !== profile.mode)
          throw new BonsaiError('error', 'Bonsai is not ready in the selected profile. Nothing was sent.');
        this.current = { ...lease.status, state: 'busy', detail: `${profile.name} is in use.` };
        const active = lease.signal ? AbortSignal.any([signal, lease.signal]) : signal;
        active.throwIfAborted();
        return await work(profile, active);
      } catch (error) {
        // A worker that is simply not running is not a failure to remember: the next status
        // reads the host again, so starting it outside the app shows at once.
        if (!signal.aborted) this.current = error instanceof BonsaiError && error.state === 'unloaded'
          ? null : this.failure(error);
        throw error;
      } finally {
        try { await lease?.release(); }
        finally {
          if (signal.aborted || this.current?.state === 'busy' || this.current?.state === 'starting') this.current = null;
          unlock();
        }
      }
    })();
    return abortable(operation, signal);
  }

  /** The person's explicit Start: the one call that may start the worker or switch its profile. */
  wake(model: string, signal: AbortSignal): Promise<BonsaiStatus> {
    return this.use(model, signal, async profile => ({ state: 'ready', installed: true,
      mode: profile.mode, owned: this.current?.owned ?? false, detail: `${profile.name} is ready.` }), { start: true });
  }
}
