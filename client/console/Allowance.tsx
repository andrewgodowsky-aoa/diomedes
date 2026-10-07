import { useEffect, useRef, useState } from 'react';
import {
  ALLOWANCE_MEANING,
  CHARGE_KIND_TEXT,
  RATE_CARD_V1,
  chargeKindsBy,
  formatMoney,
  type AllowanceView,
} from '../../shared/managed-usage';
import type { Membership } from '../../shared/workspaces';
import { ApiError, api } from '../api';
import { PurchasedCredits } from './PurchasedCredits';

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
  membership,
  report,
}: {
  organizationId: string;
  /** The signed-in person's own membership in this business, as the workspace view carries it. */
  membership: Membership;
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
  // The plan's sentence comes from the contract whether or not the host answered, so the
  // fallback can never say something the served wording does not.
  const meaning = <p className="caption ws-reason">{view?.meaning ?? ALLOWANCE_MEANING}</p>;

  return (
    <section className="ws-section">
      <h3>Nectovia AI usage</h3>

      {summary ? (
        <>
          {meaning}
          <dl className="ws-facts ws-allowance">
            <div>
              <dt>Left this period</dt>
              <dd className="mono">{formatMoney(summary.availableMicroUsd)}</dd>
            </div>
            <div>
              <dt>Reserved for ongoing work</dt>
              <dd className="mono">{formatMoney(summary.pendingMicroUsd)}</dd>
            </div>
            {summary.uncertainMicroUsd > 0 && (
              <div>
                <dt>Held, outcome not yet known</dt>
                <dd className="mono">{formatMoney(summary.uncertainMicroUsd)}</dd>
                {/* The one number people ask about. Say why it is not back. */}
                <dd className="ws-why">
                  These requests may have been charged. This amount stays reserved until the
                  service confirms the outcome.
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
        </>
      ) : (
        // With no allowance the host's reason comes first, so the plan's sentence after it reads
        // as a description of a plan and never as a claim about this build (0.1.8 review).
        <>
          <p className="caption ws-boundary">{view?.unavailableReason ?? UNREACHABLE_TEXT}</p>
          {meaning}
        </>
      )}

      {summary?.exhausted && (
        <p className="ws-error" role="status">
          This period’s allowance is used up. New Nectovia requests are stopped.
          Buy more usage or choose a connection this business
          permits to continue before the next period.
        </p>
      )}

      <dl className="ws-facts">
        <div>
          <dt>Comes out of it</dt>
          <dd>{included}.</dd>
        </div>
        <div>
          <dt>Excluded</dt>
          <dd>{excluded}.</dd>
          <dd className="ws-why">
            These tools have no known price before use. Use your business’s own provider account
            and accept the charges there.
          </dd>
        </div>
      </dl>

      <PurchasedCredits organizationId={organizationId} membership={membership} report={report} />

      <p className="caption ws-rate-card">
        Rates recorded as{' '}
        <span className="mono lc">{view?.rateCardVersion ?? RATE_CARD_V1.version}</span>. Anything
        already charged keeps the rates it was charged under.
      </p>
    </section>
  );
}

/** The host's reason when it has no allowance surface to ask. */
const UNREACHABLE_TEXT =
  "This installation can't show or bill Nectovia AI usage. The plan details describe what it would cover.";
