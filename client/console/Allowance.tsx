import { useEffect, useRef, useState } from 'react';
import {
  CHARGE_KIND_TEXT,
  RATE_CARD_V1,
  chargeKindsBy,
  formatMoney,
  type AllowanceView,
} from '../../shared/managed-usage';
import { ApiError, api } from '../api';

/**
 * What managed model access is, and what this installation can honestly say
 * about it.
 *
 * There is no price on this screen. The plan definition carries a candidate
 * figure so the ledger has a concrete shape to be built against, and a figure
 * nobody has approved, drawn in the product, would read as an offer. The panel
 * says what the allowance means and what would come out of it; the number
 * arrives when there is a plan to attach it to.
 *
 * Where no entitlement exists the numbers are absent rather than zero. A drawn
 * balance of zero says "you have spent your allowance", which is a different
 * and untrue statement.
 */

/** The two sentences the rate card can produce about itself. */
function coverage(): { included: string; excluded: string } {
  const grouped = chargeKindsBy(RATE_CARD_V1);
  const list = (kinds: readonly string[]) => {
    const labels = kinds.map((kind) => CHARGE_KIND_TEXT[kind as keyof typeof CHARGE_KIND_TEXT]);
    if (labels.length < 2) return labels.join('');
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  };
  return { included: list(grouped.included), excluded: list(grouped.excluded) };
}

export function Allowance({
  organizationId,
  report,
}: {
  organizationId: string;
  report(error: unknown): void;
}) {
  const [view, setView] = useState<AllowanceView | null>(null);
  // A caller's inline `report` is a new function each render; depending on one
  // would re-run this effect forever. Same reason, same shape, as `useWorkspace`.
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    let live = true;
    api<AllowanceView>(`/workspace/organizations/${organizationId}/allowance`)
      .then((next) => {
        if (live) setView(next);
      })
      .catch((error) => {
        // A host with no allowance surface is a fact about the build, not an
        // error to put in front of a person: the contract already says what
        // managed access means, and the panel draws that either way. Anything
        // else is a real failure and is reported — a catch that swallows every
        // error equally is how a bug becomes a permanent loading state.
        if (error instanceof ApiError && error.status === 404) return;
        reportRef.current(error);
      });
    return () => {
      live = false;
    };
  }, [organizationId]);

  const { included, excluded } = coverage();
  const summary = view?.summary ?? null;

  return (
    <section className="ws-section">
      <h3>Managed model access</h3>
      <p className="caption ws-reason">{view?.meaning ?? ALLOWANCE_TEXT}</p>

      {summary ? (
        <dl className="ws-facts ws-allowance">
          <div>
            <dt>Left this period</dt>
            <dd className="mono">{formatMoney(summary.availableMicroUsd)}</dd>
          </div>
          <div>
            <dt>Held for work in flight</dt>
            <dd className="mono">{formatMoney(summary.pendingMicroUsd)}</dd>
          </div>
          {summary.uncertainMicroUsd > 0 && (
            <div>
              <dt>Held, outcome not yet known</dt>
              <dd className="mono">{formatMoney(summary.uncertainMicroUsd)}</dd>
              {/* The one number people ask about. Say why it is not back. */}
              <dd className="ws-why">
                These calls may already have cost money upstream. The hold stays until the provider
                says what happened, so nothing is spent twice and counted once.
              </dd>
            </div>
          )}
          <div>
            <dt>Used</dt>
            <dd className="mono">{formatMoney(summary.settledMicroUsd)}</dd>
          </div>
          {summary.withdrawalsMicroUsd > 0 && (
            <div>
              <dt>Taken back</dt>
              <dd className="mono">{formatMoney(summary.withdrawalsMicroUsd)}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="caption ws-boundary">
          {view?.unavailableReason ?? UNREACHABLE_TEXT}
        </p>
      )}

      {summary?.exhausted && (
        <p className="ws-error" role="status">
          This period’s allowance is used up. New managed calls stop here. Waiting for the next
          period, a purchase, or a route this business already permits are the choices — nothing
          switches on its own.
        </p>
      )}

      <dl className="ws-facts">
        <div>
          <dt>Comes out of it</dt>
          <dd>{included}.</dd>
        </div>
        <div>
          <dt>Does not</dt>
          <dd>{excluded}.</dd>
          <dd className="ws-why">
            A provider-run tool has no price anyone can know before the call, so it cannot be held
            against a limit. It stays available on a business’s own provider key, where the business
            holds a risk it can see.
          </dd>
        </div>
      </dl>

      <p className="caption ws-rate-card">
        Rates recorded as{' '}
        <span className="mono lc">{view?.rateCardVersion ?? RATE_CARD_V1.version}</span>. Anything
        already charged keeps the rates it was charged under.
      </p>
    </section>
  );
}

/** Drawn from the contract when the host has no allowance surface to ask. */
const ALLOWANCE_TEXT =
  'Managed model access is a USD allowance for model usage, debited by the upstream charges your work actually incurs under a recorded rate card. It is not withdrawable money, not credit on a provider account, not a fixed number of words, and not a guaranteed number of jobs.';

const UNREACHABLE_TEXT =
  'This installation has no entitlement service, so there is no allowance to show and no managed usage to bill. What follows is what such an allowance would cover, so it can be read before there is anything to buy.';
