import { bonsaiProfile, type BonsaiProfile, type BonsaiStatus } from '../../shared/bonsai.js';

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
  /** Serializes with other apps, checks ownership, starts if needed and holds the lease until release. */
  acquire(profile: BonsaiProfile): Promise<BonsaiLease>;
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

  private failure(error: unknown): BonsaiStatus {
    return { installed: !(error instanceof BonsaiError && error.state === 'missing'), state: error instanceof BonsaiError ? error.state : 'error',
      mode: null, owned: false, detail: error instanceof Error ? error.message : 'Bonsai could not be checked.' };
  }

  async use<T>(model: string, signal: AbortSignal, work: (profile: BonsaiProfile, signal: AbortSignal) => Promise<T>): Promise<T> {
    const profile = bonsaiProfile(model);
    if (!profile) throw new BonsaiError('error', 'Choose a configured Bonsai profile. Nothing was sent.');
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
        this.current = { state: 'starting', installed: true, mode: profile.mode, owned: false,
          detail: `Starting ${profile.name}.` };
        lease = await this.host.acquire(profile);
        signal.throwIfAborted();
        if (lease.status.state !== 'ready' || lease.status.mode !== profile.mode)
          throw new BonsaiError('error', 'Bonsai is not ready in the selected profile. Nothing was sent.');
        this.current = { ...lease.status, state: 'busy', detail: `${profile.name} is in use.` };
        const active = lease.signal ? AbortSignal.any([signal, lease.signal]) : signal;
        active.throwIfAborted();
        return await work(profile, active);
      } catch (error) {
        if (!signal.aborted) this.current = this.failure(error);
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

  wake(model: string, signal: AbortSignal): Promise<BonsaiStatus> {
    return this.use(model, signal, async profile => ({ state: 'ready', installed: true,
      mode: profile.mode, owned: this.current?.owned ?? false, detail: `${profile.name} is ready.` }));
  }
}
