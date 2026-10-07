import { useEffect, useState } from 'react';
import { z } from 'zod';
import { allowedBillingUrl, billingView, developerKeyView, type BillingAction, type BillingView, type DeveloperKeyView } from '../shared/account-billing';
import type { AccountWorkspaceView } from '../shared/accounts';
import { api } from './api';
import { Button } from './components';

const call = (input: BillingAction) => api<unknown>('/account/billing/action', 'POST', input);
export function AccountBilling({ workspaces }: { workspaces: AccountWorkspaceView[] }) {
  const [scope, setScope] = useState('');
  const [view, setView] = useState<BillingView | null>(null);
  const [keys, setKeys] = useState<DeveloperKeyView[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [destination, setDestination] = useState('');
  const organizationId = scope || null;
  useEffect(() => {
    setView(null); setSecret(''); setDestination(''); setMessage('');
  }, [organizationId]);
  const act = async (task: () => Promise<void>) => {
    setBusy(true); setMessage(''); setDestination('');
    try { await task(); } catch (error) { setMessage(error instanceof Error ? error.message : 'This request could not be completed.'); }
    finally { setBusy(false); }
  };
  const payment = async (action: 'checkout' | 'portal') => {
    const answer = z.object({ url: z.string() }).parse(await call(action === 'portal' ? { action, organizationId } : { action, organizationId, planId: scope ? 'business' : 'individual', individualEligible: eligible }));
    if (!allowedBillingUrl(answer.url)) throw new Error('The billing page could not be verified.');
    setDestination(answer.url);
  };
  const loadKeys = async () => setKeys(z.object({ keys: z.array(developerKeyView) }).parse(await call({ action: 'keys' })).keys);
  return <section aria-label="Billing and developer API">
    <h2>Billing and developer API</h2>
    <label>Account <select value={scope} disabled={busy} onChange={event => setScope(event.target.value)}>
      <option value="">Your own Personal work</option>
      {workspaces.filter(workspace => ['owner', 'admin'].includes(workspace.role)).map(workspace => <option key={workspace.organization.id} value={workspace.organization.id}>{workspace.organization.name}</option>)}
    </select></label>
    {view?.mode === 'test' && <p className="caption">Stripe test mode. These payments are for testing.</p>}
    {view?.subscriptions.map(subscription => <p key={subscription.id}>{subscription.planId}: {subscription.status}{subscription.validUntil ? ` through ${new Date(subscription.validUntil).toLocaleDateString()}` : ''}</p>)}
    {!scope && <label><input type="checkbox" checked={eligible} onChange={event => setEligible(event.target.checked)} /> I am buying for my own work, not a business entity or sole proprietorship. Freelancers are eligible.</label>}
    <div className="button-row">
      <Button disabled={busy || (!scope && !eligible) || !view?.plans.some(plan => plan.id === (scope ? 'business' : 'individual') && plan.available)} onClick={() => void act(() => payment('checkout'))}>Start {scope ? 'Business' : 'Individual'}</Button>
      <Button disabled={busy || !view?.portalAvailable} onClick={() => void act(() => payment('portal'))}>Manage payment details and invoices</Button>
      <Button disabled={busy} onClick={() => void act(async () => setView(billingView.parse(await call({ action: 'read', organizationId }))))}>{view ? 'Refresh billing' : 'Load billing'}</Button>
    </div>
    <p className="caption">Stripe shows the price before you pay. Managed plans need an agreed scope and price; Starter needs its three-payment agreement. See plans above to arrange either.</p>
    {destination && <p><a href={destination} target="_blank" rel="noreferrer">Continue to Stripe</a>. Return here and refresh after paying.</p>}
    <h3>Developer keys</h3>
    <p className="prose">Use paid AI from your own server. A key uses this account's credits and spending limits. Keep it private; it is shown once.</p>
    <form onSubmit={event => { event.preventDefault(); void act(async () => {
      setSecret('');
      const created = z.object({ secret: z.string(), key: developerKeyView }).parse(await call({ action: 'create-key', organizationId, name, expiresInDays: 90 }));
      setSecret(created.secret); setKeys(previous => [created.key, ...previous.filter(key => key.id !== created.key.id)]); setName('');
    }); }}>
      <label>Key name <input value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoComplete="off" /></label>
      <Button type="submit" disabled={busy || !name.trim()}>Create key for 90 days</Button>
      <Button type="button" disabled={busy} onClick={() => void act(loadKeys)}>Show my keys</Button>
    </form>
    {secret && <div><label>Copy and save this key now <textarea readOnly value={secret} autoComplete="off" spellCheck={false} /></label><Button onClick={() => setSecret('')}>I've saved it</Button></div>}
    <ul>{keys.map(key => <li key={key.id}>{key.name} ({key.prefix}...), {key.scope.kind}: {key.scope.id}. {key.revokedAt ? 'Revoked' : `Expires ${new Date(key.expiresAt).toLocaleDateString()}`}
      {!key.revokedAt && <Button disabled={busy} onClick={() => void act(async () => { await call({ action: 'revoke-key', id: key.id }); setSecret(''); await loadKeys(); })}>Revoke {key.name}</Button>}
    </li>)}</ul>
    {message && <p role="status">{message}</p>}
  </section>;
}
