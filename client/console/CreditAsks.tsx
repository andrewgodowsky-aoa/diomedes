import { useEffect, useRef, useState } from 'react';
import { creditAmount } from '../../shared/managed-usage';
import { canManageMemberLimits, type Membership } from '../../shared/workspaces';
import { ApiError, api } from '../api';
import { Button } from '../components';

/**
 * The asks for more credits a business's members have made, for the people who answer them.
 *
 * Only an owner or an admin sees this section, and the service decides again who may read and who may
 * answer: it lists every ask to them and only their own to anyone else. Leaving the section out for a
 * member is a courtesy and not the protection. An ask for one job is approved as it stands; the
 * service sizes it. An ask for the month needs the credits the approver chooses to add, and that figure
 * is theirs and never the member's. Credits, never dollars.
 */

/** The same rule the server applies. Anyone else gets no section and no request. */
export const canSeeCreditAsks = (membership: Membership | null | undefined) => canManageMemberLimits(membership);

export interface CreditAsk {
  requestId: string;
  personId: string;
  kind: 'job' | 'month';
  jobId: string | null;
  state: 'pending' | 'approved' | 'denied';
  requestedAt: string;
}

type Read = <T>(path: string) => Promise<T>;
type Send = <T>(path: string, method: 'POST', body: unknown) => Promise<T>;

const base = (organizationId: string) => `/workspace/organizations/${encodeURIComponent(organizationId)}/credit-limit-requests`;

/** The asks waiting for an answer, or nothing at all, without a request, for a person who may not answer them. */
export async function loadCreditAsks(
  organizationId: string,
  membership: Membership | null | undefined,
  read: Read = api,
): Promise<CreditAsk[] | null> {
  if (!canSeeCreditAsks(membership)) return null;
  const answer = await read<{ requests: CreditAsk[] }>(base(organizationId));
  return answer.requests.filter((ask) => ask.state === 'pending');
}

export interface CreditAskDecision {
  approve: boolean;
  /** For a month's ask: the credits the approver chose to add. Never the member's figure. */
  credits?: number;
  allowPurchased?: boolean;
}

/** One answer. The figure in it is the approver's own choice; the service validates and applies it. */
export function decideCreditAsk(
  organizationId: string,
  requestId: string,
  decision: CreditAskDecision,
  send: Send = api as Send,
) {
  return send(`${base(organizationId)}/${encodeURIComponent(requestId)}/decision`, 'POST', {
    approve: decision.approve,
    ...(decision.credits === undefined ? {} : { extraMicroUsd: creditAmount(decision.credits) }),
    ...(decision.allowPurchased ? { allowPurchased: true } : {}),
  });
}

/** Nobody is signed in to an account service: there is nothing to list, and that is not a failure to report. */
const signedOut = (error: unknown) => error instanceof ApiError && error.status === 401;

const who = (role: string | undefined) => (role === 'admin' ? 'An admin' : role === 'owner' ? 'An owner' : 'A member');

function Ask({
  ask,
  role,
  busy,
  onDecide,
}: {
  ask: CreditAsk;
  role: string | undefined;
  busy: boolean;
  onDecide(decision: CreditAskDecision): void;
}) {
  const [credits, setCredits] = useState('');
  const [bought, setBought] = useState(false);
  const amount = Number(credits);
  const month = ask.kind === 'month';
  const ready = !month || (credits.trim() !== '' && Number.isFinite(amount) && amount > 0);
  return (
    <li className="ws-ask">
      <p>
        {who(role)} asked for more {month ? 'this month' : 'on one job'}.
      </p>
      {month && (
        <label className="caption">
          Credits to add
          <input
            type="number"
            min="1"
            inputMode="numeric"
            value={credits}
            disabled={busy}
            onChange={(event) => setCredits(event.target.value)}
          />
        </label>
      )}
      <label className="caption">
        <input type="checkbox" checked={bought} disabled={busy} onChange={(event) => setBought(event.target.checked)} />
        Let it use credits this business bought
      </label>
      <div className="ws-actions">
        <Button
          tone="primary"
          disabled={busy || !ready}
          onClick={() =>
            onDecide({ approve: true, ...(month ? { credits: amount } : {}), ...(bought ? { allowPurchased: true } : {}) })
          }
        >
          Approve
        </Button>
        <Button tone="quiet" disabled={busy} onClick={() => onDecide({ approve: false })}>
          Decline
        </Button>
      </div>
    </li>
  );
}

export function CreditAsksView({
  asks,
  roles,
  busy = false,
  onDecide,
}: {
  asks: CreditAsk[];
  /** A person's role, where the roster is shown to this reader. Nobody is named. */
  roles: Record<string, string>;
  busy?: boolean;
  onDecide(requestId: string, decision: CreditAskDecision): void;
}) {
  return (
    <section className="ws-section ws-asks" aria-label="Asks for more credits">
      <h4>Asks for more credits</h4>
      {asks.length === 0 ? (
        <p className="caption">No credit requests.</p>
      ) : (
        <ul className="ws-asks-list">
          {asks.map((ask) => (
            <Ask
              key={ask.requestId}
              ask={ask}
              role={roles[ask.personId]}
              busy={busy}
              onDecide={(decision) => onDecide(ask.requestId, decision)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CreditAsks({
  organizationId,
  membership,
  members,
  report,
}: {
  organizationId: string;
  membership: Membership;
  members?: { personId: string; role: string }[];
  report(error: unknown): void;
}) {
  const [asks, setAsks] = useState<CreditAsk[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reportRef = useRef(report);
  reportRef.current = report;
  const allowed = canSeeCreditAsks(membership);

  const read = () =>
    loadCreditAsks(organizationId, membership)
      .then(setAsks)
      .catch((error) => {
        if (!signedOut(error)) reportRef.current(error);
      });

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    loadCreditAsks(organizationId, membership)
      .then((next) => {
        if (live) setAsks(next);
      })
      .catch((error) => {
        if (!signedOut(error)) reportRef.current(error);
      });
    return () => {
      live = false;
    };
    // The role is what gates the read, not the membership object's identity.
  }, [organizationId, allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!allowed || !asks) return null;
  const roles = Object.fromEntries((members ?? []).map((member) => [member.personId, member.role]));
  return (
    <CreditAsksView
      asks={asks}
      roles={roles}
      busy={busy}
      onDecide={(requestId, decision) => {
        setBusy(true);
        decideCreditAsk(organizationId, requestId, decision)
          .catch((error) => reportRef.current(error))
          .then(read)
          .finally(() => setBusy(false));
      }}
    />
  );
}
