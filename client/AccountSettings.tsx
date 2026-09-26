import { useCallback, useEffect, useState } from 'react';
import { FEATURE_LABELS } from '../shared/access';
import type { AccountStateView, AccountWorkspaceView } from '../shared/accounts';
import type { PhoneRelayChange, PhoneRelayView } from '../shared/phone-relay';
import type { MemberRole } from '../shared/workspaces';
import { api } from './api';
import { useAccount } from './AccountGate';
import { Button } from './components';

/**
 * Settings, Account: who is signed in, and each business they belong to as
 * their role sees it. A Business owner sees the plan and manages everyone. A
 * Manager invites and removes Employees. An Employee sees whether the business
 * includes the Nectovia Agent and nothing about billing. The account service
 * decides every one of these; this page only asks.
 */

interface Roster {
  organizationId: string;
  you: { personId: string; role: MemberRole };
  people: { personId: string; name: string; role: MemberRole; state: string; joinedAt: string | null }[];
  invitations: { id: string; role: MemberRole; email: string | null; createdAt: string; expiresAt: string }[] | null;
}

const ROLE_NAMES: Record<MemberRole, string> = { owner: 'Business owner', admin: 'Manager', member: 'Employee' };
const FEATURE_NAMES: Record<string, string> = FEATURE_LABELS;
const day = (value: string | null) =>
  value ? new Date(value).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : null;
const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export function AccountSettings() {
  const account = useAccount();
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  if (!account) return <p className="prose">Accounts are not on in this copy of Nectovia.</p>;
  const { state } = account;
  const refresh = async () => {
    setError('');
    try {
      await account.refresh();
    } catch (e) {
      setError(message(e, 'The account service could not be reached.'));
    }
  };
  const redeem = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const joined = await api<{ account: AccountStateView }>('/account/invitation-codes/redeem', 'POST', { code });
      account.apply(joined.account);
      setCode('');
    } catch (e) {
      setError(message(e, 'That invitation code did not work.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="account-settings">
      <p className="prose">
        Signed in as <strong>{state.person?.name}</strong> ({state.person?.email}).
      </p>
      <p className="caption">
        {state.backend.label}
        {state.backend.kind === 'faux' ? '. Test data on this computer; nothing here was bought.' : '.'}{' '}
        {state.remember
          ? 'This computer keeps your sign-in, sealed by its protected storage.'
          : 'This computer does not keep your sign-in; you will enter your password next time.'}
      </p>
      <div className="button-row">
        <Button onClick={() => void refresh()}>Check again</Button>
        <Button onClick={() => void account.signOut()}>Sign out</Button>
      </div>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      <h2>Your businesses</h2>
      {state.workspaces.length === 0 && (
        <p className="prose">
          You do not belong to a business yet. Personal work uses your own AI tools directly; the Nectovia
          Agent works for a business whose plan includes it.
        </p>
      )}
      {state.workspaces.map((workspace) => (
        <BusinessCard key={workspace.organization.id} workspace={workspace} onChanged={refresh} />
      ))}
      <h2>Join a business</h2>
      <form className="account-inline-form" onSubmit={(e) => void redeem(e)}>
        <label>
          <span>Invitation code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={40}
          />
        </label>
        <Button type="submit" disabled={busy || !code.trim()}>
          Join
        </Button>
      </form>
    </div>
  );
}

function BusinessCard({ workspace, onChanged }: { workspace: AccountWorkspaceView; onChanged: () => Promise<void> }) {
  const { access, capabilities } = workspace;
  const agent = access?.agent;
  return (
    <section className="service account-business" aria-label={workspace.organization.name}>
      <div className="row">
        <h3>{workspace.organization.name}</h3>
        <span className="caption">{workspace.roleLabel}</span>
      </div>
      {!access ? (
        <p className="caption">The account service has not answered for this business yet.</p>
      ) : (
        <p className="prose">
          {agent?.included ? 'This business includes the Nectovia Agent.' : agent?.reason}
        </p>
      )}
      {capabilities.seePlan && access && (
        <div className="account-plan">
          <p>
            <strong>Plan:</strong> {access.planLabel ?? 'None'}
            {access.state !== 'none' && access.state !== 'active' ? ` (${access.state})` : ''}
            {access.validUntil ? `, until ${day(access.validUntil)}` : ''}
          </p>
          {access.features.length > 0 && (
            <p className="caption">Includes: {access.features.map((feature) => FEATURE_NAMES[feature] ?? feature).join(', ')}.</p>
          )}
          {access.grants && access.grants.length > 0 && (
            <ul className="account-grants">
              {access.grants.map((grant) => (
                <li key={grant.id}>
                  {grant.planLabel ?? 'Access'}: {grant.state}
                  {grant.validUntil ? `, until ${day(grant.validUntil)}` : ''}
                </li>
              ))}
            </ul>
          )}
          <p className="caption">Plans are changed by Diomedes Systems. Reply to your invoice or write to hello@diomedes.net.</p>
        </div>
      )}
      <PhoneRelayRow organizationId={workspace.organization.id} />
      {capabilities.managePeople === 'nobody' ? (
        <p className="caption">A Manager or the Business owner invites people to this business.</p>
      ) : (
        <People workspace={workspace} onChanged={onChanged} />
      )}
    </section>
  );
}

/** The row's one line: this computer's name and its state, or the one sentence that explains it. */
function phoneRelayLine(view: PhoneRelayView): string {
  if (view.sentence) return view.sentence;
  // Steps 1 and 2 of the phone relay list the computer as online; a phone can't reach it yet.
  if (view.state === 'reachable') return `${view.label} is connected and shows as online.`;
  if (view.state === 'connecting') return `Connecting ${view.label} to the relay…`;
  return `Your phone will see this computer as ${view.label}.`;
}

/**
 * "Reach this computer from your phone" as one answer draws it: the switch and one line, or only
 * the reason when the business's plan leaves phone access out.
 */
export function PhoneRelaySwitch({
  view,
  busy = false,
  error = '',
  onChange,
}: {
  view: PhoneRelayView;
  busy?: boolean;
  error?: string;
  onChange?: (enabled: boolean) => void;
}) {
  if (!view.included && !view.enabled) return <p className="caption">{view.sentence}</p>;
  const alert = error !== '' || view.state === 'error';
  return (
    <div className="account-phone-relay">
      <label className="account-phone-relay-switch">
        <input
          type="checkbox"
          role="switch"
          checked={view.enabled}
          disabled={busy || !view.canChange}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <span>Reach this computer from your phone</span>
      </label>
      <p className={alert ? 'account-error' : 'caption'} role={alert ? 'alert' : undefined}>
        {error || phoneRelayLine(view)}
      </p>
    </div>
  );
}

/**
 * The setting for one business. Only a Business owner or a Manager can turn it on, and only when
 * the plan includes phone access. While it's on, this computer dials out to the business's relay;
 * it never listens. Turning it off removes this computer's record.
 */
function PhoneRelayRow({ organizationId }: { organizationId: string }) {
  const path = `/account/organizations/${encodeURIComponent(organizationId)}/phone-relay`;
  const [view, setView] = useState<PhoneRelayView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setView(await api<PhoneRelayView>(path));
    } catch {
      setView(null);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  const enabled = view?.enabled === true;
  // While it's on, the connection can change at any moment: look again every few seconds.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [enabled, load]);
  if (!view) return null;
  const change = async (next: boolean) => {
    setBusy(true);
    setError('');
    try {
      setView(await api<PhoneRelayView>(path, 'PUT', { enabled: next } satisfies PhoneRelayChange));
    } catch (e) {
      setError(message(e, 'That change did not go through.'));
      await load();
    } finally {
      setBusy(false);
    }
  };
  return <PhoneRelaySwitch view={view} busy={busy} error={error} onChange={(next) => void change(next)} />;
}

function People({ workspace, onChanged }: { workspace: AccountWorkspaceView; onChanged: () => Promise<void> }) {
  const organizationId = workspace.organization.id;
  const owner = workspace.capabilities.managePeople === 'everyone';
  const [roster, setRoster] = useState<Roster | null>(null);
  const [role, setRole] = useState<MemberRole>('member');
  const [email, setEmail] = useState('');
  const [issued, setIssued] = useState<{ code: string; role: MemberRole; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setRoster(await api<Roster>(`/account/organizations/${encodeURIComponent(organizationId)}/roster`));
    } catch (e) {
      setError(message(e, 'The people in this business could not be read.'));
    }
  }, [organizationId]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(message(e, 'That change did not go through.'));
    }
  };
  const invite = (event: React.FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const created = await api<{ code: string; role: MemberRole; expiresAt: string }>(
        `/account/organizations/${encodeURIComponent(organizationId)}/invitation-codes`,
        'POST',
        { role: owner ? role : 'member', email: email.trim() || null, days: 7 },
      );
      setIssued(created);
      setEmail('');
    });
  };
  const change = (personId: string, next: { role: MemberRole; state: 'active' | 'revoked' }) =>
    act(async () => {
      await api(`/account/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(personId)}`, 'PATCH', next);
      if (personId === roster?.you.personId) await onChanged();
    });
  const mayChange = (person: Roster['people'][number]) =>
    person.personId !== roster?.you.personId && person.state === 'active' && (owner || person.role === 'member');
  return (
    <div className="account-people">
      <h4>People</h4>
      {roster && (
        <table className="account-roster">
          <tbody>
            {roster.people.map((person) => (
              <tr key={person.personId}>
                <td>
                  {person.name}
                  {person.personId === roster.you.personId ? ' (you)' : ''}
                </td>
                <td>
                  {owner && mayChange(person) ? (
                    <select
                      aria-label={`Role for ${person.name}`}
                      value={person.role}
                      onChange={(e) => void change(person.personId, { role: e.target.value as MemberRole, state: 'active' })}
                    >
                      {(Object.keys(ROLE_NAMES) as MemberRole[]).map((value) => (
                        <option key={value} value={value}>
                          {ROLE_NAMES[value]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    ROLE_NAMES[person.role]
                  )}
                </td>
                <td className="caption">{person.state === 'active' ? '' : person.state}</td>
                <td>
                  {mayChange(person) && (
                    <button type="button" className="link" onClick={() => void change(person.personId, { role: person.role, state: 'revoked' })}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="account-inline-form" onSubmit={invite}>
        {owner ? (
          <label>
            <span>Invite as</span>
            <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
              <option value="member">Employee</option>
              <option value="admin">Manager</option>
              <option value="owner">Business owner</option>
            </select>
          </label>
        ) : (
          <p className="caption">As a Manager you invite Employees.</p>
        )}
        <label>
          <span>Their email (optional)</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />
        </label>
        <Button type="submit">Create invitation code</Button>
      </form>
      {issued && (
        <p className="account-code" role="status">
          Give this code to the person you are inviting as {ROLE_NAMES[issued.role]}:{' '}
          <span className="mono">{issued.code}</span>. It works once, until {day(issued.expiresAt)}, and is not
          shown again.
        </p>
      )}
      {roster?.invitations && roster.invitations.length > 0 && (
        <>
          <p className="caption">Open invitations</p>
          <ul className="account-grants">
            {roster.invitations.map((invitation) => (
              <li key={invitation.id}>
                {ROLE_NAMES[invitation.role]}
                {invitation.email ? ` for ${invitation.email}` : ''}, until {day(invitation.expiresAt)}{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    void act(() =>
                      api(
                        `/account/organizations/${encodeURIComponent(organizationId)}/invitation-codes/${invitation.id}/revoke`,
                        'POST',
                        {},
                      ),
                    )
                  }
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
