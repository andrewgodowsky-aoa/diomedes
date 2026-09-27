import { useState, type ReactNode } from 'react';
import { FREE_ABILITIES, PAID_ABILITIES, type PlanNoticeChoice } from '../../shared/access';
import type { AccountPlanView, AccountStateView } from '../../shared/accounts';
import { useAccount } from '../AccountGate';
import { api } from '../api';

/**
 * The free version (Andrew, 2026-09-27). A person with no paid plan keeps the harness on their own
 * AI tools; only the Nectovia parts are paid. The host decides when this shows
 * (`AccountPlanView.notice`) and keeps the person's choice, so nothing here is remembered locally.
 */

/**
 * The person's plan when they're on the free version, and null otherwise: a paid plan, a business
 * whose access hasn't been read yet, or no account service at all (accounts off). A locked place
 * reads this to offer a plan instead of telling someone to switch to a business.
 */
export function useFreePlan(): AccountPlanView | null {
  const plan = useAccount()?.state.plan;
  return plan?.agent === 'free' ? plan : null;
}

/**
 * Opens the plans page in the system browser. In the desktop app the window-open handler hands the
 * address to the shell (desktop/main.mjs); in a browser it's a new tab.
 */
export function PlansLink({
  plan,
  className = 'send ready',
  children = 'Sign up for a plan',
}: {
  plan: AccountPlanView;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <a className={className} href={plan.plansUrl} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export interface FreePlanNoticeProps {
  plan: AccountPlanView;
  busy?: boolean;
  error?: string;
  onChoice(choice: PlanNoticeChoice): void;
}

/** The notice itself: what's free, what a plan adds, and the three choices. */
export function FreePlanNotice({ plan, busy = false, error = '', onChoice }: FreePlanNoticeProps) {
  const choose = (choice: PlanNoticeChoice) => {
    if (!busy) onChoice(choice);
  };
  return (
    <section className="dio-plan" aria-label="Free version">
      <h2>You're on the free version</h2>
      <p>The Nectovia Agent is part of a paid plan. Your projects, task board and own AI tools keep working.</p>
      <div className="dio-plan-lists">
        <div>
          <h3>Free</h3>
          <ul>
            {FREE_ABILITIES.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>With a plan</h3>
          <ul>
            {PAID_ABILITIES.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      {error && (
        <p className="dio-plan-error" role="alert">
          {error}
        </p>
      )}
      <div className="dio-row">
        <PlansLink plan={plan} />
        <button type="button" className="send" aria-disabled={busy || undefined} onClick={() => choose('later')}>
          Remind me later
        </button>
        <button type="button" className="send" aria-disabled={busy || undefined} onClick={() => choose('never')}>
          Don't remind me again
        </button>
      </div>
    </section>
  );
}

/**
 * The notice for the signed-in person, while the host says to show it. A choice is sent to the host
 * and its answer replaces the shared account view, so the notice goes away everywhere at once. A
 * failed send keeps the notice and says why.
 */
export function AccountPlanNotice() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const plan = account?.state.plan;
  if (!account || !plan?.notice) return null;
  const choose = async (choice: PlanNoticeChoice) => {
    setBusy(true);
    setError('');
    try {
      account.apply(await api<AccountStateView>('/account/plan-notice', 'POST', { choice }));
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : 'That choice could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return <FreePlanNotice plan={plan} busy={busy} error={error} onChoice={(choice) => void choose(choice)} />;
}
