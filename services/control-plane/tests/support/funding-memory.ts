import type { FundingRepository, FundingTransaction } from '../../src/funding.js';
import { emptyFundingState, StateFundingTransaction } from '../../src/faux/funding-state.js';

/**
 * TEST ONLY. Serializes transactions the way one organization lock would and
 * can simulate a COMMIT whose outcome the caller never learns. It does not
 * prove PostgreSQL locking, durability or isolation.
 */
export class FundingMemoryRepository implements FundingRepository {
  private state = emptyFundingState();
  private tail: Promise<void> = Promise.resolve();
  private commitFailure: 'after-apply' | 'before-apply' | null = null;
  inTransaction = false;
  transactionsStarted = 0;

  /** The next COMMIT reports failure; `after-apply` means it actually landed. */
  failNextCommit(mode: 'after-apply' | 'before-apply') { this.commitFailure = mode; }
  snapshot() { return structuredClone(this.state); }

  async transaction<T>(action: (tx: FundingTransaction) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => { release = done; });
    await prior;
    this.inTransaction = true;
    this.transactionsStarted++;
    try {
      const draft = structuredClone(this.state);
      const result = await action(new StateFundingTransaction(draft));
      const failure = this.commitFailure;
      this.commitFailure = null;
      if (failure !== 'before-apply') this.state = draft;
      if (failure) throw new Error('The commit outcome is unknown.');
      return structuredClone(result);
    } finally {
      this.inTransaction = false;
      release();
    }
  }
}
