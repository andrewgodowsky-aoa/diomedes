import { useCallback, useEffect, useState } from 'react';
import { STRICT_RESTRICTIONS, type AccountScope, type RoutingPreference, type ResolvedRoutingSnapshot } from '../../shared/routing-policy';
import { api } from '../api';
import { Button } from '../components';

interface View { scope: AccountScope; preference: RoutingPreference | null; canEdit: boolean;
  routing: { resolved?: ResolvedRoutingSnapshot } | null }
const descriptions = {
  'lowest-cost': 'Choose capable, available models within your accepted privacy settings, at or below the approved reference price. Every attempt still counts against the same spending limit.',
  balanced: 'Prefer US processing with no provider retention or training. Other routes require your previously accepted exceptions and savings or quality conditions.',
  strict: 'Require US ingress, decryption and processing, verified zero provider content retention, and no training. If no verified route is available, the request stops.',
};

/** Customer consent is saved by the account service. Operations can only read it. */
export function RoutingPreferences({ projectId = null }: { projectId?: string | null }) {
  return <ScopeRoutingPreferences key={projectId ?? 'individual'} projectId={projectId} />;
}

function ScopeRoutingPreferences({ projectId }: { projectId: string | null }) {
  const [view, setView] = useState<View | null>(null), [profile, setProfile] = useState<RoutingPreference['profile']>('strict');
  const [acknowledge, setAcknowledge] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const endpoint = `/account/routing${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`;
  const load = useCallback(async () => {
    const answer = await api<View>(endpoint);
    setView(answer); setProfile(answer.preference?.profile ?? 'strict'); setAcknowledge(false);
  }, [endpoint]);
  useEffect(() => { let active = true; setView(null); setError('');
    void api<View>(endpoint).then(answer => { if (active) { setView(answer); setProfile(answer.preference?.profile ?? 'strict'); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Routing settings could not be read.'); });
    return () => { active = false; };
  }, [endpoint]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!view || !view.canEdit || !acknowledge) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      // Choosing a ranking never relaxes a previously accepted hard restriction. Strict
      // adds its fixed requirements; existing destination/retention allowlists remain.
      const restrictions = view.preference?.restrictions ?? STRICT_RESTRICTIONS;
      await api(endpoint, 'POST', { scope: view.scope, baseRevision: view.preference?.revision ?? 0, profile,
        restrictions: profile === 'strict' ? { ...restrictions, zeroRetention: true, noTraining: true, ingressCountries: ['US'], processingCountries: ['US'] } : restrictions,
        exceptions: view.preference?.exceptions ?? [], consentVersion: 'NC-SETUP-2026-09-27.1', acknowledge: true });
      await load(); setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'The preference could not be saved.'); }
    finally { setBusy(false); }
  };
  return <section className="account-routing" aria-label="AI routing and privacy">
    <h2>AI routing and privacy</h2>
    {error && <p className="account-error" role="alert">{error}</p>}
    {!view && !error && <p>Reading this account's settings...</p>}
    {view && <form onSubmit={e => void save(e)}>
      <p className="caption">{view.scope.kind === 'individual' ? 'Your Individual account' : 'The active business account'}</p>
      <p className="prose">These settings apply to model requests and their backups. Application history and work you choose to save remain in your workspace.</p>
      <fieldset disabled={busy || !view.canEdit}>
        <legend>How Nectovia chooses a model</legend>
        {(['lowest-cost', 'balanced', 'strict'] as const).map(value => <label key={value} style={{ display: 'block', marginBlock: 12 }}>
          <input type="radio" name="routing-profile" value={value} checked={profile === value} onChange={() => { setProfile(value); setAcknowledge(false); setSaved(false); }} />{' '}
          <strong>{value === 'lowest-cost' ? 'Lowest cost' : value === 'balanced' ? 'Balanced' : 'Strict'}</strong>
          <span className="caption" style={{ display: 'block', marginLeft: 24 }}>{descriptions[value]}</span>
        </label>)}
        <p className="caption">Changing the choice above keeps your existing destination and retention limits. New accounts start with US processing and zero provider retention. Any broader exception needs a separate, explicit acceptance.</p>
        <p className="caption">Accepted processing countries: {profile === 'strict' || !view.preference ? 'US' : view.preference.restrictions.processingCountries?.join(', ') ?? 'no account country restriction'}.
          {' '}Provider retention: {profile === 'strict' || (view.preference?.restrictions.zeroRetention ?? true) ? 'zero content retention required' : 'only documented, policy-eligible retention'}.
          {' '}Your account and source limits always apply.</p>
        <label><input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} /> I accept this profile and the privacy limits shown here for this account.</label>
        <div className="button-row"><Button type="submit" disabled={!acknowledge || busy}>{busy ? 'Saving...' : 'Save routing preference'}</Button></div>
      </fieldset>
      {!view.canEdit && <p className="caption">Only this account's owner or administrator can change these settings.</p>}
      {view.preference && <p className="caption">Accepted {new Date(view.preference.acceptedAt).toLocaleString()}. Preference revision {view.preference.revision}.</p>}
      {view.routing?.resolved && <p className="caption">{view.routing.resolved.inherited ? 'Uses the company routing defaults.' : 'Uses routing configured for this account.'} Changes take effect at the next safe request.</p>}
      {saved && <p role="status">Routing preference saved.</p>}
    </form>}
  </section>;
}
