import type { FundingRepository, FundingTransaction } from '../../src/funding.js';
import { emptyFundingState, StateFundingTransaction } from '../../src/faux/funding-state.js';

/**
 * TEST ONLY. Transactions that interleave one repository call at a time over
 * one shared ledger, the way separate Worker isolates would reach one
 * database. Each lock that is switched on is a real mutex released only when
 * its transaction ends, like pg_advisory_xact_lock; a lock switched off is a
 * no-op, so two callers can both read before either writes. It does not
 * prove PostgreSQL itself.
 */
export class InterleavingFundingRepository implements FundingRepository {
  private readonly state = emptyFundingState();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    companyLock?: boolean;
    organizationLock?: boolean;
    /** Replace the conditional dispatch update with an unconditional one, to show a test has teeth. */
    unconditionalDispatch?: boolean;
  } = {}) {}

  snapshot() {
    return structuredClone(this.state);
  }

  private async acquire(key: string): Promise<() => void> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, prior.then(() => mine));
    await prior;
    return release;
  }

  async transaction<T>(action: (tx: FundingTransaction) => Promise<T>): Promise<T> {
    const held: (() => void)[] = [];
    const inner = new StateFundingTransaction(this.state);
    const tx = new Proxy(inner, {
      get: (target, name) => {
        const value = Reflect.get(target, name);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          // Let the other transaction take a step first.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (name === 'lockOrganization') {
            if (this.options.organizationLock ?? true) held.push(await this.acquire(`organization:${String(args[0])}:${String(args[1])}`));
            return undefined;
          }
          if (name === 'lockCompany') {
            if (this.options.companyLock ?? true) held.push(await this.acquire('company'));
            return undefined;
          }
          if (name === 'claimDispatch' && this.options.unconditionalDispatch) {
            const attempt = await target.attempt(String(args[0]), String(args[1]));
            if (attempt) await target.saveAttempt({ ...attempt, dispatchedAt: String(args[2]) });
            return true;
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    try {
      return await action(tx);
    } finally {
      for (const release of held) release();
    }
  }
}
