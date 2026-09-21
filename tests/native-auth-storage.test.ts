import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@workos/authkit-electron';

vi.mock('electron', () => ({
  app: {},
  safeStorage: {},
  ipcMain: {},
  BrowserWindow: {},
  shell: {},
}));
import { createNativeTokenStorage } from '../desktop/native-auth-storage';

const session = {
  accessToken: 'access-fixture',
  refreshToken: 'refresh-fixture',
  user: { id: 'user_a' },
} as Session;

export function storageFixture() {
  const values = new Map<string, unknown>();
  const store = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: (key: string) => {
      values.delete(key);
    },
  };
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (text: string) => Buffer.from([...text].reverse().join('')),
    decryptString: (bytes: Buffer) => [...bytes.toString()].reverse().join(''),
  };
  return { values, store, safeStorage };
}

describe('native SDK storage boundary', () => {
  beforeEach(() => vi.useRealTimers());

  it('keeps session and PKCE material encrypted and survives a new storage instance', async () => {
    const fixture = storageFixture();
    const first = createNativeTokenStorage(fixture);
    await first.run(async () => {
      first.sdk.setSession(session);
      first.sdk.setPendingVerifier('sealed-fixture', 'sealed-fixture');
    });
    expect(JSON.stringify([...fixture.values])).not.toContain('refresh-fixture');
    expect(JSON.stringify([...fixture.values])).not.toContain('access-fixture');
    expect(JSON.stringify([...fixture.values])).not.toContain('sealed-fixture');
    const reopened = createNativeTokenStorage(fixture);
    expect(await reopened.run(async () => reopened.sdk.getSession())).toEqual(session);
    expect(await reopened.run(async () => reopened.sdk.takePendingVerifier('sealed-fixture'))).toBe(
      'sealed-fixture',
    );
    expect(
      await reopened.run(async () => reopened.sdk.takePendingVerifier('sealed-fixture')),
    ).toBeNull();
  });

  it('fails closed for missing encryption and Linux basic_text', async () => {
    const fixture = storageFixture();
    fixture.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const storage = createNativeTokenStorage(fixture);
    await expect(storage.run(async () => storage.sdk.setSession(session))).rejects.toThrow(
      'Secure storage',
    );
    expect(fixture.values.size).toBe(0);
    fixture.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    fixture.safeStorage.getSelectedStorageBackend = () => 'basic_text';
    await expect(storage.run(async () => storage.sdk.getOrCreateCookiePassword())).rejects.toThrow(
      'Secure storage',
    );
  });

  it('expires verifiers after ten minutes and keeps at most one pending login', async () => {
    vi.useFakeTimers();
    const storage = createNativeTokenStorage(storageFixture());
    await storage.run(async () => {
      storage.sdk.setPendingVerifier('old', 'old');
      storage.sdk.setPendingVerifier('new', 'new');
      expect(storage.sdk.takePendingVerifier('old')).toBeNull();
      vi.advanceTimersByTime(600_001);
      expect(storage.sdk.takePendingVerifier('new')).toBeNull();
    });
  });

  it('logout invalidates durable pending callbacks and late asynchronous writes', async () => {
    const fixture = storageFixture();
    const storage = createNativeTokenStorage(fixture);
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const late = storage.run(async () => {
      storage.sdk.setPendingVerifier('old-state', 'old-state');
      await wait;
      storage.sdk.setSession(session);
    });
    storage.invalidate();
    resume();
    await expect(late).rejects.toThrow('changed');
    const reopened = createNativeTokenStorage(fixture);
    await reopened.run(async () => {
      expect(reopened.sdk.getSession()).toBeNull();
      expect(reopened.sdk.takePendingVerifier('old-state')).toBeNull();
    });
  });

  it('refuses plaintext records and makes failed durable cancellation unusable', async () => {
    const fixture = storageFixture();
    fixture.values.set('session', 'plain:' + JSON.stringify(session));
    const storage = createNativeTokenStorage(fixture);
    expect(await storage.run(async () => storage.sdk.getSession())).toBeNull();
    fixture.store.delete = () => {
      throw new Error('disk failure with refresh-fixture');
    };
    expect(() => storage.invalidate()).toThrow('Secure storage could not cancel sign-in.');
    await expect(storage.run(async () => storage.sdk.setSession(session))).rejects.toThrow(
      'changed',
    );
  });
});
