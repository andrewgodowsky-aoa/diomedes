import { useCallback, useEffect, useState } from 'react';
import {
  LEGACY_ROUTING_CONSENT, PROFILE_FLOORS, ROUTING_CONSENT_VERSION, restrictionsCover,
  type AccountScope, type HardRestrictions, type RoutingPreference, type ResolvedRoutingSnapshot,
} from '../../shared/routing-policy';
import { api } from '../api';
import { Button } from '../components';

interface View { scope: AccountScope; preference: RoutingPreference | null; canEdit: boolean;
  routing: { resolved?: ResolvedRoutingSnapshot } | null }
type Profile = RoutingPreference['profile'];
const descriptions: Record<Profile, string> = {
  'lowest-cost': 'Use the least expensive AI that can do the job, never above the price of our usual pick.',
  balanced: 'Prefer providers that don\'t store your content, then US processing. Otherwise, use another AI that can do the job.',
  strict: 'Require US ingress, decryption and processing, verified zero provider content retention, and no training. If no verified route is available, the request stops.',
};
/** What each profile's floor enforces, in the same words the account accepts (NC-SETUP-2026-10-02.1). */
const limits: Record<Profile, string> = {
  'lowest-cost': 'Nothing is used for training. Requests can run outside the US. A provider may store content under its own terms, or hold it for a few minutes to answer faster.',
  balanced: 'Nothing is used for training. Requests can run outside the US. A provider may store content under its own terms, or hold it for a few minutes to answer faster.',
  strict: 'Requests stay in the US. Providers can\'t hold your content, even for a few minutes. Nothing is used for training.',
};

/** Names what saving `after` gives up from the accepted `before`, or null when nothing loosens. */
function loosened(before: HardRestrictions, after: HardRestrictions): string | null {
  if (restrictionsCover(after, before)) return null;
  const countries = (before.ingressCountries !== null && after.ingressCountries === null) ||
    (before.processingCountries !== null && after.processingCountries === null);
  const storage = (before.zeroRetention && !after.zeroRetention) || (before.transientCache === 'forbid' && after.transientCache === 'approved');
  if (countries && storage) return 'Saving this lets requests run outside the US and lets providers store content.';
  if (countries) return 'Saving this lets requests run outside the US.';
  if (storage) return 'Saving this lets providers store content.';
  return 'Saving this removes limits you accepted before.';
}

/** Customer consent is saved by the account service. Operations can only read it. */
export function RoutingPreferences({ projectId = null }: { projectId?: string | null }) {
  return <ScopeRoutingPreferences key={projectId ?? 'individual'} projectId={projectId} />;
}

function ScopeRoutingPreferences({ projectId }: { projectId: string | null }) {
  const [view, setView] = useState<View | null>(null), [profile, setProfile] = useState<Profile>('strict');
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
      // The profile's floor is exactly what the account accepts and what the service enforces.
      await api(endpoint, 'POST', { scope: view.scope, baseRevision: view.preference?.revision ?? 0, profile,
        restrictions: PROFILE_FLOORS[profile], exceptions: [], consentVersion: ROUTING_CONSENT_VERSION, acknowledge: true });
      await load(); setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'The preference could not be saved.'); }
    finally { setBusy(false); }
  };
  const relaxation = view?.preference ? loosened(view.preference.restrictions, PROFILE_FLOORS[profile]) : null;
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
        <p className="caption">A retry on another AI counts toward your spending limit too.</p>
        <p className="caption">{limits[profile]} Your account and source limits always apply.</p>
        {relaxation && <p className="caption" role="note">{relaxation}</p>}
        <label><input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} /> I accept this profile and the privacy limits shown here for this account.</label>
        <div className="button-row"><Button type="submit" disabled={!acknowledge || busy}>{busy ? 'Saving...' : 'Save routing preference'}</Button></div>
      </fieldset>
      {!view.canEdit && <p className="caption">Only this account's owner or administrator can change these settings.</p>}
      {view.preference && <p className="caption">Accepted {new Date(view.preference.acceptedAt).toLocaleString()}. Preference revision {view.preference.revision}.</p>}
      {view.preference?.consentVersion === LEGACY_ROUTING_CONSENT && <p className="caption">This choice was saved under earlier rules. Save it again to use the rules shown here.</p>}
      {view.routing?.resolved && <p className="caption">{view.routing.resolved.inherited ? 'Uses the company routing defaults.' : 'Uses routing configured for this account.'} Changes take effect at the next safe request.</p>}
      {saved && <p role="status">Routing preference saved.</p>}
    </form>}
  </section>;
}
