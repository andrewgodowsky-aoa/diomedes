import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError, absent } from '../paths.js';
import { jsonWrite, type Store } from '../store.js';
import {
  accountStateSchema,
  emptyAccountState,
  type AccountRepository,
  type AccountState,
} from './account-contract.js';

/**
 * Development adapter, using the existing exclusively owned data directory and
 * Store queue. This is not the B01 cloud database or a multi-process SQL adapter.
 */
export class FileAccountRepository implements AccountRepository {
  readonly filePath: string;
  readonly scope: string;

  constructor(private readonly store: Store) {
    this.filePath = path.join(store.dataDir, 'business', 'accounts-v1.json');
    this.scope = path.resolve(this.filePath);
  }

  private async load(): Promise<AccountState> {
    let bytes: string;
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > 32 * 1024 * 1024)
        throw new ApiError(503, 'Account storage requires operator review.');
      bytes = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (absent(error)) return emptyAccountState();
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(bytes);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ApiError(503, 'Account storage is unreadable; recovery is required.');
    }
    const result = accountStateSchema.safeParse(data);
    if (!result.success)
      throw new ApiError(503, 'Account storage version or relationships are invalid.');
    return result.data;
  }

  read<T>(action: (state: AccountState) => T | Promise<T>): Promise<T> {
    return this.store.locked(async () => action(await this.load()));
  }

  transact<T>(action: (state: AccountState) => T | Promise<T>): Promise<T> {
    return this.store.locked(async () => {
      const state = await this.load();
      const before = JSON.stringify(state);
      // Portable state operations are awaited under this same Store lock.
      // Provider verification must complete before entering transact().
      const result = await action(state);
      if (JSON.stringify(state) !== before) {
        state.revision++;
        const parsed = accountStateSchema.safeParse(state);
        if (!parsed.success)
          throw new ApiError(503, 'Account transaction violated the storage contract.');
        if (Buffer.byteLength(JSON.stringify(parsed.data)) > 32 * 1024 * 1024)
          throw new ApiError(503, 'Account storage capacity requires operator review.');
        await jsonWrite(this.filePath, parsed.data);
      }
      return structuredClone(result);
    });
  }
}
