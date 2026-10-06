import { useCallback, useEffect, useRef, useState } from 'react';
import {
  creditsFor,
  formatCredits,
  type MicroUsd,
  type PurchasedUsageState,
  type UsageProjection,
  type UsageState,
} from '../../shared/managed-usage';
import type { Membership, WorkspaceView } from '../../shared/workspaces';
import { HEADLINE_STEPS } from '../../shared/credit-purchases';
import { BOUGHT_CREDITS_LAST, BUSINESS_CREDITS_NEED_PLAN } from '../../shared/access';
import { useAccount } from '../AccountGate';
import { api } from '../api';
import { Button } from '../components';
import { PurchasedCreditsView, canSeePurchasedCredits, loadPersonalPurchasedUsage, loadPurchasedUsage } from './PurchasedCredits';
import { useNectoviaUsage } from './NectoviaUsage';
import { usageBarModel, type UsageTone } from './nectovia-usage-model';
import { INITIAL_FLOW, createPurchaseFlow, formatPrice, formatUsd, maxCreditsFor, type CreditStep, type FlowState, type PurchaseFlow } from './credit-purchase-flow';
import './usage-center.css';

/**
 * Settings, Usage: how much of this month's included credits the business has used, a bar that changes
 * colour as they wind down, the credits it bought, and a way to buy more.
 *
 * Only an owner or an admin of the selected business sees it; the server refuses everyone else too, so
 * leaving it out is a courtesy and not the protection. Customers read credits here. The one place a
 * dollar figure appears is the price of a purchase, before it is made and after it is paid, and that
 * figure is always the account service's quote and never worked out in this file. The one exception
 * is the buy box's published price line beside a ready quote: ten of the steps the service quoted
 * ("$130 buys 1,000 credits."), display arithmetic on the service's own step, never a total. Where usage can't be
 * read there is one plain line and nothing to buy: an absent balance is not a zero one.
 */

/** The selected business and the signed-in person's place in it, when that place may see this screen. */
export function usageCenterTarget(
  view: WorkspaceView | null,
): { organizationId: string; membership: Membership } | null {
  if (!view || view.active.kind !== 'business') return null;
  const id = view.active.organizationId;
  const found = view.organizations.find((item) => item.organization.id === id);
  if (!found || !canSeePurchasedCredits(found.membership)) return null;
  return { organizationId: id, membership: found.membership };
}

export const creditsText = (amount: MicroUsd) => {
  const text = formatCredits(amount);
  return `${text} ${text === '1' ? 'credit' : 'credits'}`;
};

/** "800 of 1,000 credits used this month": what is settled against what the month granted. */
export function usageMeterText(projection: UsageProjection): string {
  const granted = formatCredits(projection.grantedMicroUsd);
  return `${formatCredits(projection.settledMicroUsd)} of ${granted} ${granted === '1' ? 'credit' : 'credits'} used this month`;
}

/** The theme's own ok, warning and danger fills; the first is the bar's plain colour. */
const FILL_CLASS: Record<UsageTone, string> = { ok: '', warning: 'signal', danger: 'fault' };

const UNREADABLE: Record<'loading' | 'not-connected' | 'unavailable', string> = {
  loading: 'Checking usage.',
  'not-connected': 'Usage can’t be shown until you’re signed in.',
  unavailable: 'Usage isn’t available right now.',
};

function windingDown(projection: UsageProjection, tone: UsageTone | null): string | null {
  if (projection.availableMicroUsd === 0) return 'Your monthly credits are used up.';
  if (tone === 'danger') return 'Your monthly credits are almost gone.';
  if (tone === 'warning') return 'Your monthly credits are running low.';
  return null;
}

export function UsageCenterBar({ state, now }: { state: UsageState; now: number }) {
  if (state.state !== 'ready') {
    return (
      <section className="uc-section" aria-label="Agent usage">
        <h2>Agent usage</h2>
        <p className="uc-line" role="status">
          {UNREADABLE[state.state]}
        </p>
      </section>
    );
  }
  const model = usageBarModel(state, now);
  const projection = state.projection;
  const granted = creditsFor(projection.grantedMicroUsd);
  if (model.meter === null || granted === 0) {
    return (
      <section className="uc-section" aria-label="Agent usage">
        <h2>Agent usage</h2>
        <p className="uc-line">No monthly credits this month.</p>
      </section>
    );
  }
  const label = usageMeterText(projection);
  const tone = model.tone ?? 'ok';
  const held = (projection.pendingMicroUsd + projection.uncertainMicroUsd) as MicroUsd;
  const note = windingDown(projection, model.tone);
  return (
    <section className="uc-section" aria-label="Agent usage">
      <h2>Agent usage</h2>
      <div
        className="uc-meter"
        role="meter"
        aria-label="Monthly credits used"
        aria-valuemin={0}
        aria-valuemax={granted}
        aria-valuenow={Math.min(creditsFor(projection.settledMicroUsd), granted)}
        aria-valuetext={label}
        data-tone={tone}
      >
        <span className={`usage-fill uc-fill ${FILL_CLASS[tone]}`.trim()} style={{ width: `${model.meter}%` }} />
      </div>
      <p className="uc-meter-text">{label}</p>
      {note && <p className={`uc-note ${tone}`}>{note}</p>}
      {held > 0 && (
        <p className="caption uc-held">
          {formatCredits(held)} {formatCredits(held) === '1' ? 'credit is' : 'credits are'} reserved for work in flight.
        </p>
      )}
      <p className={model.stale ? 'caption uc-when uc-stale' : 'caption uc-when'}>
        {[model.resets, model.freshness].filter(Boolean).join(' · ')}
      </p>
    </section>
  );
}

const credits = (value: number) => `${value.toLocaleString('en-US')} ${value === 1 ? 'credit' : 'credits'}`;

/** "$130 buys 1,000 credits.": ten of the quoted steps, the way prices are published. Both figures are the service's. */
export const headlineText = (step: CreditStep) =>
  `${formatPrice(step.cents * HEADLINE_STEPS)} buys ${credits(step.credits * HEADLINE_STEPS)}.`;

/** Who a buy box buys for: a business, or the signed-in person's own Personal work. */
export type BuyPayer = 'business' | 'person';

export function BuyCreditsView({
  state,
  onInput,
  onBuy,
  onReset,
  payer = 'business',
}: {
  state: FlowState;
  onInput(text: string): void;
  onBuy(): void;
  onReset(): void;
  payer?: BuyPayer;
}) {
  const { quote, purchase } = state;
  const noPlan = state.onPlan === false;
  // The published price sits with a quote that has answered, before anything is bought: the one time dollars show here.
  const priced = purchase.phase === 'idle' && quote.state === 'ready';
  // The step is the one the account service quoted for this business; until it has, the field takes any whole number.
  const step = state.step?.credits ?? 1;
  const held = purchase.phase === 'starting' || purchase.phase === 'waiting';
  const form = purchase.phase === 'idle' || held;
  return (
    <section className="uc-section uc-buy" aria-label="Buy credits">
      <h2>Buy credits</h2>
      {priced && state.step && <p className="uc-line uc-price">{headlineText(state.step)}</p>}
      {priced && noPlan && state.planStep && <p className="caption uc-plan-price">On a plan, {headlineText(state.planStep)}</p>}
      {noPlan && payer === 'business' && <p className="caption uc-needs-plan">{BUSINESS_CREDITS_NEED_PLAN}</p>}
      <p className="caption uc-lasts">{BOUGHT_CREDITS_LAST}</p>
      {form && (
        <label className="uc-field">
          <span>Credits to buy</span>
          <input
            type="number"
            inputMode="numeric"
            min={step}
            max={maxCreditsFor(step)}
            step={step}
            value={state.input}
            disabled={held}
            onChange={(event) => onInput(event.target.value)}
          />
        </label>
      )}
      {purchase.phase === 'idle' && (
        <>
          <p className="uc-line" aria-live="polite">
            {quote.state === 'ready'
              ? `${credits(quote.credits)} for ${formatUsd(quote.amountCents)} at the current usage rate`
              : quote.state === 'loading'
                ? 'Working out the total.'
                : quote.message}
          </p>
          <div className="button-row">
            <Button tone="primary" disabled={quote.state !== 'ready'} onClick={onBuy}>
              Buy
            </Button>
          </div>
        </>
      )}
      {purchase.phase === 'starting' && (
        <>
          <p className="uc-line" role="status">
            Starting your payment.
          </p>
          <div className="button-row">
            <Button tone="primary" disabled>
              Buy
            </Button>
          </div>
        </>
      )}
      {purchase.phase === 'waiting' && (
        <>
          <p className="uc-line" role="status">
            Waiting for your payment for {credits(purchase.credits)}.
          </p>
          <div className="button-row">
            <a href={purchase.checkoutUrl} target="_blank" rel="noreferrer">
              Open the payment page
            </a>
            <Button tone="quiet" onClick={onReset}>
              Stop waiting
            </Button>
          </div>
        </>
      )}
      {purchase.phase === 'paid' && (
        <>
          <p className="uc-line" role="status">
            Paid {formatUsd(purchase.amountCents)}. {credits(purchase.credits)} were added.
          </p>
          <div className="button-row">
            <Button onClick={onReset}>Buy more</Button>
          </div>
        </>
      )}
      {(purchase.phase === 'expired' || purchase.phase === 'failed' || purchase.phase === 'error') && (
        <>
          <p className="uc-line" role="status">
            {purchase.phase === 'expired'
              ? 'That payment window closed before it was paid.'
              : purchase.phase === 'failed'
                ? 'The payment didn’t go through.'
                : purchase.message}
          </p>
          <div className="button-row">
            <Button onClick={onReset}>Try again</Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Everything the screen shows, from the answers it has. Nothing past the bar while usage can't be read. */
export function UsageCenterView({
  usage,
  now,
  purchased,
  buy,
  onInput,
  onBuy,
  onReset,
}: {
  usage: UsageState;
  now: number;
  purchased: PurchasedUsageState | null;
  buy: FlowState;
  onInput(text: string): void;
  onBuy(): void;
  onReset(): void;
}) {
  return (
    <div className="usage-center">
      <UsageCenterBar state={usage} now={now} />
      {usage.state === 'ready' && (
        <>
          {purchased && <PurchasedCreditsView state={purchased} />}
          <BuyCreditsView state={buy} onInput={onInput} onBuy={onBuy} onReset={onReset} />
        </>
      )}
    </div>
  );
}

/**
 * Opens a payment page in the system browser. The flow has already checked the address against the
 * processor's own; the desktop shell checks it again before it leaves the app (desktop/main.mjs).
 */
function openPaymentPage(url: string) {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // The waiting line carries the link too.
  }
}

/** One buy flow for one payer: a business, or (null) the person's own Personal work. A new payer gets a new flow; leaving the screen ends it. */
function useCreditPurchase(organizationId: string | null, onPaid: () => void) {
  const [flow, setFlow] = useState<PurchaseFlow | null>(null);
  const [state, setState] = useState<FlowState | null>(null);
  const paid = useRef(onPaid);
  paid.current = onPaid;
  useEffect(() => {
    const next = createPurchaseFlow({
      organizationId,
      read: api,
      open: openPaymentPage,
      onPaid: () => paid.current(),
    });
    const off = next.subscribe(setState);
    setFlow(next);
    setState(next.getState());
    next.start();
    return () => {
      off();
      next.dispose();
      setFlow(null);
      setState(null);
    };
  }, [organizationId]);
  return { flow, state };
}

function UsageCenterPanel({
  organizationId,
  membership,
  report,
}: {
  organizationId: string;
  membership: Membership;
  report(error: unknown): void;
}) {
  const { state: usage, now, refresh } = useNectoviaUsage(organizationId, report);
  const [purchased, setPurchased] = useState<PurchasedUsageState | null>(null);
  const [reads, setReads] = useState(0);
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    let live = true;
    loadPurchasedUsage(organizationId, membership)
      .then((next) => {
        if (live) setPurchased(next);
      })
      .catch((error) => reportRef.current(error));
    return () => {
      live = false;
    };
    // The role is what gates the read, not the membership object's identity.
  }, [organizationId, reads, membership.role]); // eslint-disable-line react-hooks/exhaustive-deps

  // A paid purchase changes both: the bought balance, and what is left to use.
  const paid = useCallback(() => {
    setReads((count) => count + 1);
    refresh();
  }, [refresh]);
  const { flow, state } = useCreditPurchase(organizationId, paid);

  return (
    <UsageCenterView
      usage={usage}
      now={now}
      purchased={purchased}
      buy={state ?? INITIAL_FLOW}
      onInput={(text) => flow?.setInput(text)}
      onBuy={() => void flow?.buy()}
      onReset={() => flow?.reset()}
    />
  );
}

/**
 * Settings, Usage in Personal (pay as you go, DIO-219): the credits the signed-in person bought for their own work, and a
 * way to buy more. The account service resolves who is buying and prices it from their own plan, if they have one; nothing
 * here names a person or a business. While the balance can't be read there is one plain line and nothing to buy.
 */
export function PersonalUsageView({
  purchased,
  buy,
  onInput,
  onBuy,
  onReset,
}: {
  purchased: PurchasedUsageState | null;
  buy: FlowState;
  onInput(text: string): void;
  onBuy(): void;
  onReset(): void;
}) {
  return (
    <div className="usage-center">
      {purchased === null ? (
        <p className="uc-line" role="status">
          Checking your credits.
        </p>
      ) : (
        <PurchasedCreditsView state={purchased} caption={null} />
      )}
      {purchased?.state === 'ready' && <BuyCreditsView state={buy} onInput={onInput} onBuy={onBuy} onReset={onReset} payer="person" />}
    </div>
  );
}

function PersonalUsagePanel({ report }: { report(error: unknown): void }) {
  const [purchased, setPurchased] = useState<PurchasedUsageState | null>(null);
  const [reads, setReads] = useState(0);
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    let live = true;
    loadPersonalPurchasedUsage()
      .then((next) => {
        if (live) setPurchased(next);
      })
      .catch((error) => reportRef.current(error));
    return () => {
      live = false;
    };
  }, [reads]);
  // Credits bought without a plan open Nectovia (pay as you go, DIO-245), so a paid purchase reads the account again too:
  // the switch and the ask row follow it without a restart. A failed read leaves them as they were.
  const refreshAccount = useAccount()?.refresh;
  const paid = useCallback(() => {
    setReads((count) => count + 1);
    void refreshAccount?.().catch(() => undefined);
  }, [refreshAccount]);
  const { flow, state } = useCreditPurchase(null, paid);
  return (
    <PersonalUsageView
      purchased={purchased}
      buy={state ?? INITIAL_FLOW}
      onInput={(text) => flow?.setInput(text)}
      onBuy={() => void flow?.buy()}
      onReset={() => flow?.reset()}
    />
  );
}

export function PersonalUsage({ report }: { report(error: unknown): void }) {
  return <PersonalUsagePanel report={report} />;
}

export function UsageCenter({
  organizationId,
  membership,
  report,
}: {
  organizationId: string;
  membership: Membership;
  report(error: unknown): void;
}) {
  if (!canSeePurchasedCredits(membership)) return null;
  return <UsageCenterPanel key={organizationId} organizationId={organizationId} membership={membership} report={report} />;
}
