import { accountStateSchema, emptyAccountState, type AccountRepository, type AccountTransaction } from '../../src/domain.js';
import { StateTransaction } from '../../src/state-transaction.js';

/** TEST ONLY. Models serializability; it does not prove SQL, durability or Workers CPU. */
export class MemoryRepository implements AccountRepository {
  private state = emptyAccountState();
  private tail: Promise<void> = Promise.resolve();
  inTransaction = false;
  snapshot() { return structuredClone(this.state); }
  async transaction<T>(action: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => { release = done; });
    await prior;
    this.inTransaction = true;
    try {
      const draft = structuredClone(this.state);
      const result = await action(new StateTransaction(draft));
      draft.revision++;
      this.state = accountStateSchema.parse(draft);
      return structuredClone(result);
    } finally { this.inTransaction = false; release(); }
  }
}
