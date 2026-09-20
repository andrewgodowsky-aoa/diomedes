/** Display state only. This is never a verified subject or workspace grant. */
export type NativeAccountState = {
  status: 'unavailable' | 'signed-out' | 'signing-in' | 'signed-in';
  account: { id: string; name: string } | null;
  message: string;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Narrow view of the official preload, with token methods deliberately absent. */
export interface NativeAccountBridge {
  getUser(): Promise<Result<NativeAccountState>>;
  signIn(): Promise<Result<null>>;
  signOut(): Promise<Result<null>>;
  onAuthChange(callback: (state: NativeAccountState) => void): () => void;
  onAuthError(callback: (error: { code: string; message: string }) => void): () => void;
}

declare global {
  interface Window {
    __authkit_electron?: NativeAccountBridge;
  }
}
