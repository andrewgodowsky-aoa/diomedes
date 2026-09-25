import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountStateView, AccountsOffView } from '../shared/accounts';
import { api } from './api';
import { Brand, Button } from './components';
import './accounts.css';

/**
 * Nobody reaches the app without signing in. The host refuses every other
 * route with `sign_in_required` until then; this draws the sign-in screen on
 * that answer, and remounts the app for each person so nothing one person
 * loaded is ever on screen for the next.
 */

interface AccountContextValue {
  state: AccountStateView;
  /** Ask the account service again: businesses, roles and plans. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  apply: (state: AccountStateView) => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

/** The signed-in account, or null outside the gate (tests that render parts of the app alone). */
export function useAccount(): AccountContextValue | null {
  return useContext(AccountContext);
}

/** Raised by `api()` when the host answers `sign_in_required`. */
export const SIGN_IN_REQUIRED_EVENT = 'nectovia:sign-in-required';
/** Asks the app to open Settings at a named section. */
export const OPEN_SETTINGS_EVENT = 'nectovia:open-settings';

export function openAccountSettings() {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: 'Account' }));
}

const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export function AccountGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountStateView | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const view = await api<AccountStateView | AccountsOffView>('/account');
      if ('off' in view) setOff(true);
      else setState(view);
      setError('');
    } catch (e) {
      setError(message(e, 'Nectovia could not reach its local service.'));
    }
  }, []);
  useEffect(() => {
    void load();
    const ended = () => void load();
    window.addEventListener(SIGN_IN_REQUIRED_EVENT, ended);
    return () => window.removeEventListener(SIGN_IN_REQUIRED_EVENT, ended);
  }, [load]);

  // A host without accounts (an embedded test server) asks no one to sign in, so neither does this.
  if (off) return <>{children}</>;
  if (!state)
    return (
      <div className="initial-state">
        <Brand />
        <p className="prose">{error || 'Opening Nectovia...'}</p>
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </div>
    );
  if (!state.signedIn || !state.person) return <SignIn state={state} onSignedIn={setState} onRetry={load} />;
  const value: AccountContextValue = {
    state,
    apply: setState,
    refresh: async () => setState(await api<AccountStateView>('/account/refresh', 'POST', {})),
    signOut: async () => setState(await api<AccountStateView>('/account/sign-out', 'POST', {})),
  };
  return (
    <AccountContext.Provider value={value}>
      <Fragment key={state.person.id}>{children}</Fragment>
    </AccountContext.Provider>
  );
}

function SignIn({
  state,
  onSignedIn,
  onRetry,
}: {
  state: AccountStateView;
  onSignedIn: (state: AccountStateView) => void;
  onRetry: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'sign-in' | 'create'>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(state.protectedStorage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remembered, setRemembered] = useState(state.remembered);
  const passwordRef = useRef<HTMLInputElement>(null);
  const backend = state.backend;

  const run = async (action: () => Promise<AccountStateView>) => {
    setBusy(true);
    setError('');
    try {
      onSignedIn(await action());
    } catch (e) {
      setError(message(e, 'Signing in did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(() =>
      mode === 'create'
        ? api<AccountStateView>('/account/sign-up', 'POST', { name, email, password, remember })
        : api<AccountStateView>('/account/sign-in', 'POST', { email, password, remember }),
    );
  };
  const choose = (account: AccountStateView['remembered'][number]) => {
    if (account.canResume) {
      void run(() => api<AccountStateView>('/account/resume', 'POST', { personId: account.personId }));
      return;
    }
    setMode('sign-in');
    setEmail(account.email);
    setPassword('');
    setTimeout(() => passwordRef.current?.focus(), 0);
  };
  const forget = async (personId: string) => {
    try {
      const next = await api<AccountStateView>('/account/forget', 'POST', { personId });
      setRemembered(next.remembered);
    } catch (e) {
      setError(message(e, 'That account could not be removed from this computer.'));
    }
  };

  return (
    <div className="account-screen">
      <div className="account-card">
        <Brand />
        <h1>{mode === 'create' ? 'Create your Nectovia account' : 'Sign in to Nectovia'}</h1>
        {backend.kind === 'faux' && (
          <p className="account-banner" role="note">
            <strong>{backend.label}.</strong> Accounts, businesses and plans here are test data kept on this
            computer. Nothing here was bought, and no real person or business is behind them.
          </p>
        )}
        {backend.kind === 'unavailable' ? (
          <>
            <p className="prose" role="alert">
              {backend.reason ?? 'The account service is not available.'}
            </p>
            <Button onClick={() => void onRetry()}>Try again</Button>
          </>
        ) : backend.signIn === 'browser' ? (
          <p className="prose" role="alert">
            This account service signs people in through the browser, which this build does not open
            yet.
          </p>
        ) : (
          <>
            {mode === 'sign-in' && remembered.length > 0 && (
              <section className="account-chooser" aria-label="Accounts on this computer">
                <p className="caption">Accounts on this computer</p>
                {remembered.map((account) => (
                  <div key={account.personId} className="account-choice">
                    <button type="button" disabled={busy} onClick={() => choose(account)}>
                      <strong>{account.name}</strong>
                      <span className="caption">{account.email}</span>
                      <span className="account-choice-action">
                        {account.canResume ? 'Continue' : 'Enter password'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="link"
                      aria-label={`Remove ${account.email} from this computer`}
                      onClick={() => void forget(account.personId)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </section>
            )}
            <form className="account-form" onSubmit={submit}>
              {mode === 'create' && (
                <label>
                  <span>Your name</span>
                  <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} required maxLength={120} />
                </label>
              )}
              <label>
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  autoComplete="username"
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  maxLength={320}
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  ref={passwordRef}
                  type="password"
                  value={password}
                  autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === 'create' ? 10 : 1}
                  maxLength={256}
                />
              </label>
              <label className="account-remember">
                <input
                  type="checkbox"
                  checked={remember && state.protectedStorage}
                  disabled={!state.protectedStorage}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>
                  Keep me signed in on this computer
                  <span className="caption">
                    {state.protectedStorage
                      ? "Your sign-in is sealed by this computer's protected storage and never kept as text. Sign out to end it."
                      : 'This copy of Nectovia cannot protect a kept sign-in, so you will enter your password next time.'}
                  </span>
                </span>
              </label>
              {error && (
                <p className="account-error" role="alert">
                  {error}
                </p>
              )}
              <Button tone="primary" type="submit" disabled={busy}>
                {busy ? 'One moment...' : mode === 'create' ? 'Create account' : 'Sign in'}
              </Button>
            </form>
            <p className="caption">
              {mode === 'create' ? 'Already have an account? ' : 'New to Nectovia? '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode(mode === 'create' ? 'sign-in' : 'create');
                  setError('');
                }}
              >
                {mode === 'create' ? 'Sign in' : 'Create an account'}
              </button>
            </p>
            {backend.demo && mode === 'sign-in' && (
              <details className="account-demo">
                <summary>Demo accounts</summary>
                <p className="caption">
                  Every demo account's password is <span className="mono">{backend.demo.password}</span>.
                </p>
                {backend.demo.accounts.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    className="account-demo-row"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(backend.demo!.password);
                    }}
                  >
                    <strong>{account.name}</strong>
                    <span className="caption">{account.label}</span>
                  </button>
                ))}
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
