import { useEffect, useRef, useState } from 'react';
import { formatCredits, micro, type PurchasedUsageState } from '../../shared/managed-usage';
import { canSeePurchasedUsage, type Membership } from '../../shared/workspaces';
import { api } from '../api';

/**
 * The credits a business bought outright, for the people who run it.
 *
 * Only an owner or an admin sees this; the server refuses everyone else too, so leaving the
 * section out is a courtesy and not the protection. Amounts are credits and never dollars. When
 * the account service can't say, there are no numbers at all: an absent balance is not a zero one.
 */

/** The same rule the server applies. Anyone else gets no section and no request. */
export const canSeePurchasedCredits = (membership: Membership | null | undefined) =>
  canSeePurchasedUsage(membership);

type Read = <T>(path: string) => Promise<T>;

/** One read of the bought balance, or nothing at all, without a request, for a person who may not see it. */
export async function loadPurchasedUsage(
  organizationId: string,
  membership: Membership | null | undefined,
  read: Read = api,
): Promise<PurchasedUsageState | null> {
  if (!canSeePurchasedCredits(membership)) return null;
  return read<PurchasedUsageState>(`/workspace/organizations/${organizationId}/allowance/purchased`);
}

const credits = (value: number) => {
  const text = formatCredits(micro(value));
  return `${text} ${text === '1' ? 'credit' : 'credits'}`;
};

export function PurchasedCreditsView({ state }: { state: PurchasedUsageState }) {
  return (
    <section className="ws-purchased" aria-label="Credits you bought">
      <h4>Credits you bought</h4>
      {state.state === 'ready' ? (
        <dl className="ws-facts ws-allowance">
          <div>
            <dt>Bought</dt>
            <dd className="mono">{credits(state.balance.purchasedMicroUsd)}</dd>
          </div>
          <div>
            <dt>Reserved for work in flight</dt>
            <dd className="mono">{credits(state.balance.heldMicroUsd)}</dd>
          </div>
          <div>
            <dt>Used</dt>
            <dd className="mono">{credits(state.balance.settledMicroUsd)}</dd>
          </div>
          <div>
            <dt>Available</dt>
            <dd className="mono">{credits(Math.max(0, state.balance.availableMicroUsd))}</dd>
          </div>
        </dl>
      ) : (
        <p className="caption ws-boundary">{state.reason}</p>
      )}
      <p className="caption">Your included monthly usage isn’t part of this.</p>
    </section>
  );
}

export function PurchasedCredits({
  organizationId,
  membership,
  report,
}: {
  organizationId: string;
  membership: Membership;
  report(error: unknown): void;
}) {
  const [state, setState] = useState<PurchasedUsageState | null>(null);
  const reportRef = useRef(report);
  reportRef.current = report;
  const allowed = canSeePurchasedCredits(membership);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    loadPurchasedUsage(organizationId, membership)
      .then((next) => {
        if (live) setState(next);
      })
      .catch((error) => reportRef.current(error));
    return () => {
      live = false;
    };
    // The role is what gates the read, not the membership object's identity.
  }, [organizationId, allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!allowed || !state) return null;
  return <PurchasedCreditsView state={state} />;
}
