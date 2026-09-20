import { AsyncLocalStorage } from 'node:async_hooks';
import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';
import { createDefaultStorage, type TokenStorage } from '@workos/authkit-electron';
import type { KeyValueStoreLike, SafeStorageLike } from '@workos/authkit-electron/internals';

type SecureStorage = SafeStorageLike & { getSelectedStorageBackend?(): string };
export type NativeTokenStorage = ReturnType<typeof createNativeTokenStorage>;

/** SDK encryption and TTL, with one pending ceremony and revocable async writes. */
export function createNativeTokenStorage(
  options: {
    safeStorage?: SecureStorage;
    store?: KeyValueStoreLike;
    name?: string;
  } = {},
) {
  const secure = options.safeStorage ?? safeStorage;
  // This dedicated store never contains Personal settings/history or other SDK users.
  const store =
    options.store ?? new ElectronStore({ name: options.name ?? 'diomedes-native-auth' });
  const context = new AsyncLocalStorage<number>();
  let generation = 0;
  let disposed = false;
  let failed = false;
  let consumed = 0;
  function assertAvailable() {
    if (
      failed ||
      !secure.isEncryptionAvailable() ||
      secure.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw new Error('Secure storage is unavailable.');
  }
  function assertCurrent() {
    if (failed || disposed || context.getStore() !== generation)
      throw new Error('The account session changed.');
  }
  const base = createDefaultStorage({ store, safeStorage: secure, allowPlaintext: false });
  function persist<T>(action: () => T): T {
    try {
      return action();
    } catch {
      failed = true;
      throw new Error('Secure storage could not save the account session.');
    }
  }
  const sdk: TokenStorage = {
    getSession() {
      assertCurrent();
      assertAvailable();
      return base.getSession();
    },
    setSession(value) {
      assertCurrent();
      assertAvailable();
      persist(() => base.setSession(value));
    },
    clearSession() {
      assertCurrent();
      persist(() => base.clearSession());
    },
    getOrCreateCookiePassword() {
      assertCurrent();
      assertAvailable();
      return persist(() => base.getOrCreateCookiePassword());
    },
    setPendingVerifier(key, value) {
      assertCurrent();
      assertAvailable();
      // SDK 0.1.2's documented storage uses this namespace. Keep this adapter
      // and its pinned-version tests together; no other store is ever touched.
      persist(() => {
        store.delete('pendingVerifiers');
        base.setPendingVerifier(key, value);
      });
    },
    takePendingVerifier(key) {
      assertCurrent();
      assertAvailable();
      const verifier = persist(() => base.takePendingVerifier(key));
      if (verifier) consumed++;
      return verifier;
    },
  };
  return {
    sdk,
    assertAvailable,
    get generation() {
      return generation;
    },
    get consumed() {
      return consumed;
    },
    async run<T>(action: () => Promise<T>): Promise<T> {
      const epoch = generation;
      return context.run(epoch, async () => {
        assertCurrent();
        const result = await action();
        assertCurrent();
        return result;
      });
    },
    invalidate() {
      generation++;
      // Advance first: even if the durable deletion fails, old work cannot write.
      try {
        store.delete('pendingVerifiers');
      } catch {
        failed = true;
        throw new Error('Secure storage could not cancel sign-in.');
      }
    },
    dispose() {
      generation++;
      disposed = true;
    },
  };
}
