/**
 * The zero-budget vendor decision — the B00 rail.
 *
 * The selected tiers permit zero new fixed monthly spend; actual account
 * plans are unverified. Variable fees, including Stripe processing, Billing
 * and dispute fees, require approval; unapproved variable spend is zero. The
 * rejected add-ons are listed by name so a later proposal has to argue for
 * them rather than discovering them on an invoice.
 *
 * This file is data, not provisioning. Naming a vendor here creates no
 * account, no credential and no spend; it records the only vendors the
 * contract admits, so a route or configuration naming any other one is a
 * policy violation rather than a surprise.
 */
import { micro, type MicroUsd } from '../../../shared/managed-usage.js';

export type VendorRole =
  | 'marketing-hosting'
  | 'control-plane-runtime'
  | 'identity'
  | 'database'
  | 'payments'
  | 'app-hosting';

/** A dated primary source — the vendor's own page, not a third-party summary. */
export interface VendorSource {
  readonly label: string;
  readonly url: string;
  /** The date the page was read, ISO. A source older than the decision is stale evidence. */
  readonly asOf: string;
}

export interface VendorEntry {
  readonly vendor: string;
  readonly role: VendorRole;
  /** The selected tier's product name, for a reviewer to price-check. */
  readonly tier: string;
  /** Whether this vendor is on the admitted rail today. */
  readonly selected: boolean;
  /** New fixed spend admitted per month, not an observed account bill. */
  readonly monthlyFixedMicroUsd: MicroUsd;
  /** What the contract actually consumes from this vendor. */
  readonly features: readonly string[];
  /**
   * The finite limits of the selected tier, in the vendor's own published
   * terms. An unlimited claim is not a limit; every entry names the number or
   * the constraint that ends the free ride.
   */
  readonly limits: readonly string[];
  /** The fee model — fixed vs variable and who a variable fee attaches to. */
  readonly fees: string;
  /** Paid capabilities considered and explicitly rejected at this revision. */
  readonly rejectedAddOns: readonly string[];
  /**
   * The vendor's own primary pages this decision was read against. Dated, so
   * a reviewer can tell stale evidence from current terms.
   */
  readonly sources: readonly VendorSource[];
  /**
   * Whether a live account was observed while this decision was written. No
   * account was provisioned or inspected for this contract, so selected
   * vendors are 'unverified' — naming a vendor provisions nothing.
   */
  readonly accountState: 'verified' | 'unverified' | 'not-selected';
}

export const VENDOR_ALLOWLIST: readonly VendorEntry[] = Object.freeze([
  {
    vendor: 'cloudflare-workers-assets',
    role: 'marketing-hosting',
    tier: 'Workers static assets (existing source configuration)',
    selected: true,
    monthlyFixedMicroUsd: micro(0),
    features: ['marketing site hosting', 'TLS', 'CDN'],
    limits: [
      'static asset requests are free; dynamic requests consume the Workers allowance',
      'Workers Free: 100,000 dynamic requests per day, 10 ms CPU per invocation',
      'D1 and email usage require separate account and quota verification',
    ],
    fees: 'Free static assets; actual account plan and D1/email usage unverified. No hosting migration authorized.',
    rejectedAddOns: [],
    sources: [
      {
        label: 'Cloudflare Workers pricing',
        url: 'https://developers.cloudflare.com/workers/platform/pricing/',
        asOf: '2026-09-17',
      },
      {
        label: 'Cloudflare developer platform plans',
        url: 'https://www.cloudflare.com/plans/developer-platform/',
        asOf: '2026-09-16',
      },
    ],
    accountState: 'unverified',
  },
  {
    vendor: 'cloudflare-workers',
    role: 'control-plane-runtime',
    tier: 'Workers Free',
    selected: true,
    monthlyFixedMicroUsd: micro(0),
    features: [
      'Web Fetch-compatible control-plane worker',
      'scheduled-free request handling',
      'Workers KV/D1 free allowances if later admitted by a work order',
    ],
    limits: [
      '100,000 requests per day',
      '10 ms CPU time per invocation on the free plan',
      'KV/D1 allowances only if a later work order admits them',
    ],
    fees: 'Free tier: 100k requests/day. Paid plan ($5/mo) is rejected.',
    rejectedAddOns: [
      'Workers Paid plan',
      'Queues/Streams paid usage',
      'any per-request paid addon',
    ],
    sources: [
      {
        label: 'Cloudflare Workers limits',
        url: 'https://developers.cloudflare.com/workers/platform/limits/',
        asOf: '2026-09-16',
      },
      {
        label: 'Cloudflare Workers pricing',
        url: 'https://developers.cloudflare.com/workers/platform/pricing/',
        asOf: '2026-09-16',
      },
    ],
    accountState: 'unverified',
  },
  {
    vendor: 'workos-authkit',
    role: 'identity',
    tier: 'AuthKit Free',
    selected: true,
    monthlyFixedMicroUsd: micro(0),
    features: [
      'hosted OIDC sign-in (issuer/subject for verifySubject)',
      'hosted user management up to the free MAU allowance',
      'PKCE / hosted callback flow',
    ],
    limits: [
      'AuthKit free for the first one million monthly active users',
      'paid add-ons (SSO, SCIM, custom domain, audit retention) excluded by this contract',
    ],
    fees: 'Free up to the published MAU allowance; paid add-ons rejected below.',
    rejectedAddOns: [
      'custom domain (paid)',
      'SSO / SAML',
      'SCIM directory sync',
      'audit-log retention product',
      'organization-level paid features',
    ],
    sources: [
      {
        label: 'WorkOS pricing',
        url: 'https://workos.com/pricing',
        asOf: '2026-09-16',
      },
      {
        label: 'WorkOS AuthKit documentation',
        url: 'https://workos.com/docs/authkit',
        asOf: '2026-09-16',
      },
    ],
    accountState: 'unverified',
  },
  {
    vendor: 'neon',
    role: 'database',
    tier: 'Neon Free',
    selected: true,
    monthlyFixedMicroUsd: micro(0),
    features: [
      'serverless Postgres for hosted control-plane state',
      'branch-per-environment within the free allowance',
    ],
    limits: [
      '0.5 GB storage per project',
      '100 CU-hours per project per month; up to 2 CU',
      '100 projects; 10 branches per project; 5 GB public transfer per project per month',
    ],
    fees: 'Free tier compute/storage allowances; Launch/Scale paid tiers rejected.',
    rejectedAddOns: ['Launch paid tier', 'Scale paid tier', 'paid read replicas'],
    sources: [
      {
        label: 'Neon pricing',
        url: 'https://neon.com/pricing',
        asOf: '2026-09-16',
      },
      {
        label: 'Neon plan limits documentation',
        url: 'https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md',
        asOf: '2026-09-17',
      },
    ],
    accountState: 'unverified',
  },
  {
    vendor: 'stripe',
    role: 'payments',
    tier: 'Test mode first',
    selected: true,
    monthlyFixedMicroUsd: micro(0),
    features: [
      'test-mode checkout and invoicing while nothing is sold',
      'Billing webhook events reconciled as billing events',
    ],
    limits: [
      'test mode only — live-mode charges are refused until a funded plan exists',
      'no automatic top-ups or stored spend authority',
      'processing, disputes, currency conversion and Billing are distinct charges',
    ],
    fees: 'US domestic cards: 2.9% + USD 0.30 per successful transaction. Billing pay-as-you-go: 0.7% of Billing volume, additional to processing; no fixed monthly commitment. Disputes, international cards, conversion and optional products can add fees. Test mode only here; live use requires explicit approval.',
    rejectedAddOns: [
      'live-mode charges before a sellable plan exists',
      'Stripe Tax / Billing annual commitments / optional paid extras',
      'automatic top-ups',
    ],
    sources: [
      {
        label: 'Stripe pricing',
        url: 'https://stripe.com/us/pricing',
        asOf: '2026-09-17',
      },
      {
        label: 'Stripe Billing pricing',
        url: 'https://stripe.com/billing/pricing',
        asOf: '2026-09-17',
      },
      {
        label: 'Stripe test mode documentation',
        url: 'https://docs.stripe.com/test-mode',
        asOf: '2026-09-16',
      },
    ],
    accountState: 'unverified',
  },
  {
    vendor: 'vercel',
    role: 'app-hosting',
    tier: 'not selected',
    selected: false,
    monthlyFixedMicroUsd: micro(0),
    features: [],
    limits: [],
    fees: 'Recorded as an optional future adapter only; the commercial app surface stays out of this rail.',
    rejectedAddOns: ['Vercel Pro', 'Vercel Connect', 'any per-seat billing'],
    sources: [
      {
        label: 'Vercel pricing',
        url: 'https://vercel.com/pricing',
        asOf: '2026-09-16',
      },
    ],
    accountState: 'not-selected',
  },
]);

/**
 * The only spend policy this revision admits. Deep-frozen: nothing mutable
 * may point at a different number.
 */
export const SPEND_POLICY = Object.freeze({
  /** New committed monthly spend: USD 0. */
  newFixedSpendMicroUsd: micro(0),
  /** Metered spend without an explicit per-use approval: USD 0. */
  unapprovedVariableSpendMicroUsd: micro(0),
  automaticTopUps: false,
  newAnnualCommitments: false,
  /** Transaction fees attach to settled revenue, never to allowance or profit. */
  transactionFeesChargedTo: 'revenue',
} as const);

export type SpendPolicy = typeof SPEND_POLICY;

export type SpendOverride =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: string };

/**
 * A proposed spend-policy change is a refusal record, not a mutation. A
 * questionnaire answer, a model's output, a settings record and a request
 * field are all `unknown` here — none of them is a spend decision, and the
 * only policy that exists is the contract default above.
 */
export function applySpendOverride(_proposed: unknown): SpendOverride {
  return {
    applied: false,
    reason:
      'This revision admits exactly one spend policy — the USD 0 contract default. A questionnaire answer, model output or settings record is not a spend decision.',
  };
}
