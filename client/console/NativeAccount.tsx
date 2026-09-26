import { useEffect, useState } from 'react';
import type { NativeAccountState } from '../../shared/native-auth';
import { useAccount } from '../AccountGate';
import { Button } from '../components';

/** Account entry only; a WorkOS identity does not activate a Business workspace. */
export function NativeAccount() {
  const bridge = window.__authkit_electron;
  // Where the account service signs people in through WorkOS, this sign-in is the account itself,
  // shown and signed out of in Settings, so it is not offered here a second time.
  const signedInThroughBrowser = useAccount()?.state.backend.signIn === 'browser';
  const [state, setState] = useState<NativeAccountState>({
    status: 'unavailable',
    account: null,
    message: 'Checking account sign-in.',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let revision = 0;
    const remove = bridge.onAuthChange((next) => {
      revision++;
      if (active) setState(next);
    });
    const removeError = bridge.onAuthError(() => {
      if (active) setError('Sign-in could not finish. Try again.');
    });
    const initial = revision;
    void bridge
      .getUser()
      .then((result) => {
        if (active && revision === initial) {
          if (result.ok) setState(result.data);
          else
            setState({
              status: 'unavailable',
              account: null,
              message: 'Account sign-in is unavailable.',
            });
        }
      })
      .catch(() => {
        if (active) setError('Account sign-in is unavailable.');
      });
    return () => {
      active = false;
      remove();
      removeError();
    };
  }, [bridge]);
  if (!bridge || signedInThroughBrowser) return null;
  const run = async (action: 'signIn' | 'signOut') => {
    setBusy(true);
    setError('');
    try {
      const result = await bridge[action]();
      if (!result.ok) setError(result.error.message);
    } catch {
      setError('Account sign-in is unavailable.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ws-section" aria-label="Account sign-in">
      <h3>Account</h3>
      {state.account && (
        <p className="caption" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          {state.account.name}
        </p>
      )}
      <p className="caption">
        {state.status === 'signed-in'
          ? 'Signed in to WorkOS. Business workspace access is not connected on this installation.'
          : state.message || 'Sign in to your account. Personal stays on this computer.'}
      </p>
      {state.status === 'signed-out' && (
        <Button disabled={busy} onClick={() => void run('signIn')}>
          Sign in with browser
        </Button>
      )}
      {(state.status === 'signed-in' || state.status === 'signing-in') && (
        <Button disabled={busy} onClick={() => void run('signOut')}>
          {state.status === 'signing-in' ? 'Cancel sign-in' : 'Sign out'}
        </Button>
      )}
      {error && (
        <p className="caption" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
