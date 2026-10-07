/**
 * What AI setup shows for the AWS Bedrock model-API route, computed from the
 * host's view alone (`GET /api/ai/model-api/aws-bedrock`). Pure, so every
 * sentence a person reads here is testable without a browser.
 */
import {
  AWS_DIRECT_MODEL_IDS,
  AWS_DIRECT_MODELS,
  MANAGED_LUNA,
  type AwsConnectionView,
  type RouteQualificationView,
} from '../shared/model-api';
import type {
  QualificationCheckId,
  QualificationOutcome,
  RouteQualificationReceipt,
} from '../shared/route-qualification';

export const AWS_ACCOUNT_PATTERN = /^\d{12}$/;
export const AWS_MIN_KEY_LENGTH = 20;
export const AWS_MAX_CAP_USD = 100;

/** Micro-dollars as a person reads them: cents, or tenths of a cent when smaller. */
export function usd(micro: number): string {
  const dollars = micro / 1_000_000;
  const digits = micro !== 0 && Math.abs(dollars) < 0.01 ? 4 : 2;
  return `$${dollars.toFixed(digits)}`;
}

export interface AwsStateRow {
  key: 'connection' | 'key' | 'limit' | 'route';
  label: string;
  text: string;
  value: 'ok' | 'waiting' | 'blocked';
}

/** The four facts a person needs before sending, in the order they are set up. */
export function awsStateRows(view: AwsConnectionView, nowMs = Date.now()): AwsStateRow[] {
  const connection = view.connection;
  const spend = view.spend;
  const expiresAt = connection?.credential.expiresAt ? Date.parse(connection.credential.expiresAt) : null;
  return [
    {
      key: 'connection',
      label: 'AWS account',
      text: connection ? `${connection.account} · ${connection.region} · ${connection.model}` : 'Not connected',
      value: connection ? 'ok' : 'waiting',
    },
    {
      key: 'key',
      label: 'API key',
      text: !connection
        ? view.protectedStorage
          ? 'None saved'
          : 'Protected storage is not available here'
        : connection.credential.expired
          ? 'Expired: enter a new key'
          : expiresAt !== null
            ? `Saved, expires ${new Date(expiresAt).toLocaleString()}${expiresAt - nowMs < 24 * 3_600_000 ? ' (soon)' : ''}`
            : 'Saved, no expiry given',
      value: !connection ? (view.protectedStorage ? 'waiting' : 'blocked') : connection.credential.expired ? 'blocked' : 'ok',
    },
    {
      key: 'limit',
      label: 'Spend limit',
      text: !spend
        ? 'Not set'
        : spend.capMicroUsd === 0
          ? 'Approval required'
          : `${usd(spend.capMicroUsd)} approved, ${usd(spend.availableMicroUsd)} left`,
      value: !spend || spend.capMicroUsd === 0 ? 'waiting' : spend.availableMicroUsd > 0 ? 'ok' : 'blocked',
    },
    {
      key: 'route',
      label: 'Route',
      text: view.enabled ? (view.next ? `Blocked: ${view.next}` : 'On') : 'Off',
      value: view.enabled ? (view.next ? 'blocked' : 'ok') : 'waiting',
    },
  ];
}

export interface AwsConnectInput {
  accountId: string;
  /** Omission retains the existing Luna default; an explicit identity is never substituted. */
  model?: string;
  apiKey: string;
  /** A `datetime-local` value, or empty for none. */
  expiresLocal: string;
  consent: boolean;
}

/** The connect body, or the one sentence that says what is missing. The key is never echoed. */
export function awsConnectBody(input: AwsConnectInput, nowMs = Date.now()):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string } {
  const accountId = input.accountId.replace(/[\s-]/g, '');
  if (!AWS_ACCOUNT_PATTERN.test(accountId)) return { ok: false, message: 'Enter the 12-digit AWS account number.' };
  const model = input.model ?? MANAGED_LUNA.model;
  if (!AWS_DIRECT_MODEL_IDS.some((candidate) => candidate === model))
    return { ok: false, message: 'Choose a listed AWS Bedrock model for the US processing route.' };
  const apiKey = input.apiKey.trim();
  if (apiKey.length < AWS_MIN_KEY_LENGTH) return { ok: false, message: 'Paste the Bedrock API key for this account.' };
  let expiresAt: string | null = null;
  if (input.expiresLocal) {
    const at = Date.parse(input.expiresLocal);
    if (!Number.isFinite(at)) return { ok: false, message: 'Enter the key’s expiry as a date and time, or leave it empty.' };
    if (at <= nowMs + 60_000) return { ok: false, message: 'That key has already expired. Create a new one in AWS.' };
    expiresAt = new Date(at).toISOString();
  }
  if (!input.consent)
    return { ok: false, message: 'Confirm that conversations and chosen files may be sent to AWS under this account.' };
  return {
    ok: true,
    body: { accountId, region: 'us-east-1', model, apiKey, expiresAt, consent: true },
  };
}

/** The spend-limit body in whole cents, or the sentence that says why not. */
export function awsLimitBody(dollars: string, consent: boolean):
  | { ok: true; body: { capUsd: number; consent: true } }
  | { ok: false; message: string } {
  const value = Number(dollars);
  if (!dollars.trim() || !Number.isFinite(value) || value < 0 || value > AWS_MAX_CAP_USD)
    return { ok: false, message: `Enter an amount from $0 to $${AWS_MAX_CAP_USD}.` };
  const capUsd = Math.round(value * 100) / 100;
  if (Math.abs(capUsd - value) > 1e-9) return { ok: false, message: 'Use whole cents.' };
  if (!consent) return { ok: false, message: 'Confirm the limit before saving it.' };
  return { ok: true, body: { capUsd, consent: true } };
}

type Hold = NonNullable<AwsConnectionView['spend']>['recent'][number];

/** One line per paid call: what it cost, or why the cost is not known yet. */
export function holdSentence(hold: Hold): string {
  const tokens = hold.usage
    ? `${hold.usage.inputTokens.toLocaleString()} in, ${hold.usage.outputTokens.toLocaleString()} out`
    : null;
  switch (hold.state) {
    case 'settled':
      return `${usd(hold.settledMicroUsd ?? 0)}${tokens ? ` · ${tokens}` : ''}`;
    case 'pending':
      return `In progress · up to ${usd(hold.maxMicroUsd)} held`;
    case 'uncertain':
      return `Cost unknown · ${usd(hold.maxMicroUsd)} held until you record it${hold.uncertainReason ? ` · ${hold.uncertainReason}` : ''}`;
    case 'released':
      return 'Not sent · nothing held';
    case 'written-off':
      return `Accepted at ${usd(hold.maxMicroUsd)}`;
    default:
      return hold.state;
  }
}

export const AWS_ROUTE_NAME = 'AWS Bedrock';

/**
 * Whether a thread's picker offers AWS, and if not, the one sentence that says
 * why. It is offered only when the host reports nothing blocking a send, so the
 * menu never offers a route that admission would refuse.
 */
export function awsPickerState(view: AwsConnectionView | null): { offered: boolean; note: string | null } {
  if (!view || !view.connection) return { offered: false, note: null };
  if (!view.enabled) return { offered: false, note: null };
  if (view.next) return { offered: false, note: `${AWS_ROUTE_NAME} is on but not ready: ${view.next}` };
  return { offered: true, note: null };
}

/** Whether AWS is the route new work takes. Connecting never makes it so by itself. */
export function awsIsDefault(services: Record<string, unknown> | undefined): boolean {
  return services?.defaultEngine === 'aws-bedrock';
}

// --- route checks (shared with the Azure card) -------------------------------------------

/** The most something can hold, rounded up to the cent: an "at most" never understates. */
export const usdUp = (micro: number) => `$${(Math.ceil(micro / 10_000) / 100).toFixed(2)}`;

const CHECK_LABELS: Record<QualificationCheckId, string> = {
  'short-answer': 'Short answer',
  'output-bound': 'Output limit',
  'tool-round-trip': 'Tool round trip',
  'cache-default': 'Caching by default',
  'cache-off': 'Caching off',
};
const OUTCOME_WORDS: Record<QualificationOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  unsupported: 'Not supported',
  'not-run': 'Not run',
};

export interface RouteCheckLine {
  id: QualificationCheckId;
  label: string;
  outcome: QualificationOutcome;
  text: string;
}

/** One line per check in the newest receipt: its outcome and what it observed, as recorded. */
export function routeCheckLines(receipt: RouteQualificationReceipt | null): RouteCheckLine[] {
  return (receipt?.checks ?? []).map((check) => ({
    id: check.id,
    label: CHECK_LABELS[check.id],
    outcome: check.outcome,
    // A check that did not run already says so in its own words.
    text: check.outcome === 'not-run' ? check.detail : `${OUTCOME_WORDS[check.outcome]} · ${check.detail}`,
  }));
}

/** What the route checks mean for this connection now, in one sentence. Null before anything is connected. */
export function qualificationSentence(view: RouteQualificationView | null): string | null {
  if (!view?.model) return null;
  if (!view.qualifies) return view.reason;
  if (view.required) {
    const name = AWS_DIRECT_MODELS.find((entry) => entry.model === view.model)?.label ?? view.model;
    return `${name} can send on this connection.`;
  }
  return view.deployment ? 'The route checks passed for this deployment.' : 'The route checks passed on this connection.';
}

/** When the newest run happened, which models answered it and what it spent. */
export function routeCheckSummary(receipt: RouteQualificationReceipt | null): string | null {
  if (!receipt) return null;
  const served = receipt.servedModels.length ? `served by ${receipt.servedModels.join(', ')}` : 'no model reported';
  const unknown = receipt.spend.uncertainMicroUsd ? `, ${usd(receipt.spend.uncertainMicroUsd)} not yet known` : '';
  return `Last run ${new Date(receipt.createdAt).toLocaleString()} · ${served} · ${usd(receipt.spend.settledMicroUsd)} spent${unknown}`;
}

/** What a run sends and the most it can hold, said before it starts. */
export function routeChecksCaption(view: RouteQualificationView | null): string {
  const scope = view?.deployment ? 'this deployment' : 'this connection';
  const hold = view?.ceilingMicroUsd != null ? ` They hold at most ${usdUp(view.ceilingMicroUsd)} of the spend limit.` : '';
  return `Up to eight short requests through ${scope}, billed as usual.${hold}`;
}

/**
 * Whether a run can start from this screen, and if not, the one sentence that says why. A run
 * this screen started shows Stop instead, so it needs no reason.
 */
export function routeCheckRunState(
  view: RouteQualificationView | null,
  runningHere: boolean,
): { canRun: boolean; reason: string | null } {
  if (runningHere || !view) return { canRun: false, reason: null };
  return view.blocked ? { canRun: false, reason: view.blocked } : { canRun: true, reason: null };
}
