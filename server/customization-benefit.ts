/**
 * The customization benefit included with a paid plan, as a ledger.
 *
 * A paid organization gets one "we will design it with you" engagement. That is
 * a promise with money behind it, so it is recorded the way money is recorded
 * here — the same shape as `server/billing-events.ts`, one file per
 * organization under `data/benefits/`, written through `jsonWrite`, and beside
 * it on purpose so the two are read together.
 *
 * Four rules do the work, and each one exists because of a way this goes wrong:
 *
 * **The benefit is consumed once.** `accepted` is terminal and sets `consumed`.
 * Reinstalling, a new profile, a new member or a second request cannot mint a
 * second engagement, because what a grant is keyed on is the organization, not
 * the request.
 *
 * **A repeat is not a second event.** Every transition carries an idempotency
 * key, remembered as `step:key`. The same key on the same step changes nothing
 * and reports so — a retried request after a dropped connection is the ordinary
 * case, not a new engagement. The step is part of what is remembered because a
 * caller that derives one key per engagement, rather than one per request,
 * would otherwise find its second genuine step silently swallowed as a retry.
 *
 * **A failed draft costs nothing.** `fail` returns a drafted engagement to
 * `eligible` and clears what it was about. The benefit was promised and not
 * delivered, so it is still owed.
 *
 * **Restoring an older theme revision is not a delivery.** Nothing in
 * `server/themes.ts` calls into this module, and nothing here watches theme
 * storage: a revision restore moves a pack and touches no benefit record. That
 * is a claim about absence, so `tests/customization-benefit.test.ts` asserts the
 * record is byte-identical across a restore rather than trusting the reading.
 *
 * This is not a spend gate and not a billing system. It records where one
 * engagement stands; whether the organization may ask for it at all is the
 * entitlement question, answered by `server/customization-gate.ts` at the
 * route before anything here is called.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { jsonWrite, readJson, type Store } from './store.js';

/**
 * Where one engagement stands.
 *
 * `delivered` is not a state: delivery is what acceptance records, and a
 * separate state for it would let a record say delivered-but-not-accepted,
 * which is exactly the claim nobody should be able to make. `deliveredAt` is
 * stamped by `accept`.
 */
export type BenefitState = 'eligible' | 'requested' | 'draft' | 'customer_review' | 'accepted';

export type BenefitStep = 'request' | 'draft' | 'review' | 'accept' | 'fail';

/** The state a step may be applied from, and where it lands. */
const TRANSITIONS: Readonly<Record<BenefitStep, { from: BenefitState; to: BenefitState }>> =
  Object.freeze({
    request: { from: 'eligible', to: 'requested' },
    draft: { from: 'requested', to: 'draft' },
    review: { from: 'draft', to: 'customer_review' },
    accept: { from: 'customer_review', to: 'accepted' },
    // A draft that did not work out. The benefit is still owed, so the record
    // goes back to eligible and forgets what the attempt was about.
    fail: { from: 'draft', to: 'eligible' },
  });

export interface BenefitView {
  readonly v: 1;
  readonly organizationId: string;
  readonly state: BenefitState;
  /** Monotonic; one per applied transition. A repeat does not advance it. */
  readonly sequence: number;
  /** True once the engagement was accepted. Terminal. */
  readonly consumed: boolean;
  readonly engagementId: string | null;
  readonly themeId: string | null;
  readonly themeRevision: number | null;
  readonly actor: string | null;
  readonly requestedAt: string | null;
  readonly draftedAt: string | null;
  readonly reviewStartedAt: string | null;
  readonly acceptedAt: string | null;
  readonly deliveredAt: string | null;
  readonly lastFailedAt: string | null;
  readonly lastFailureReason: string | null;
}

/**
 * The stored shape. `BenefitView` is what leaves this module and is readonly on
 * purpose; the record itself is the mutable working copy, and `seen` never
 * leaves — a list of every retry key is this service's business, not a caller's.
 */
type Record_ = { -readonly [K in keyof BenefitView]: BenefitView[K] } & {
  /**
   * Every idempotency key applied, as `step:key`, so a retry is applied at most
   * once and the same key on a different step is still its own event.
   */
  seen: string[];
};

const empty = (organizationId: string): Record_ => ({
  v: 1,
  organizationId,
  state: 'eligible',
  sequence: 0,
  consumed: false,
  engagementId: null,
  themeId: null,
  themeRevision: null,
  actor: null,
  requestedAt: null,
  draftedAt: null,
  reviewStartedAt: null,
  acceptedAt: null,
  deliveredAt: null,
  lastFailedAt: null,
  lastFailureReason: null,
  seen: [],
});

export interface BenefitStepInput {
  readonly organizationId: string;
  readonly step: BenefitStep;
  /** The retry key. The same key twice is the same event, not a second one. */
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly at: string;
  readonly engagementId?: string;
  readonly themeId?: string;
  readonly themeRevision?: number;
  readonly reason?: string;
}

export type BenefitResult =
  | { readonly applied: true; readonly view: BenefitView }
  | { readonly applied: false; readonly code: string; readonly reason: string; readonly view: BenefitView };

const view = (record: Record_): BenefitView => {
  const { seen: _seen, ...rest } = record;
  return { ...rest };
};

export class CustomizationBenefitLedger {
  private readonly records = new Map<string, Record_>();

  constructor(private readonly store: Store) {}

  private get root() {
    return path.join(this.store.dataDir, 'benefits');
  }
  private file(organizationId: string) {
    return path.join(this.root, `${organizationId}.json`);
  }

  /**
   * Nothing is read eagerly, for the same reason the billing processor reads
   * nothing eagerly: one file per organization is the tenant boundary made
   * structural, and holding every customer in memory buys nothing.
   */
  async init(): Promise<void> {
    this.records.clear();
  }

  private async recordFor(organizationId: string): Promise<Record_> {
    const held = this.records.get(organizationId);
    if (held) return held;
    const loaded = await readJson<Record_>(this.file(organizationId), () => empty(organizationId));
    loaded.seen ??= [];
    loaded.organizationId = organizationId;
    this.records.set(organizationId, loaded);
    return loaded;
  }

  async read(organizationId: string): Promise<BenefitView> {
    return view(await this.recordFor(organizationId));
  }

  async apply(input: BenefitStepInput): Promise<BenefitResult> {
    const record = await this.recordFor(input.organizationId);
    const move = TRANSITIONS[input.step];
    if (!move)
      return {
        applied: false,
        code: 'benefit_unknown_step',
        reason: `There is no ${String(input.step)} step in the customization benefit.`,
        view: view(record),
      };

    // A key already applied *to this step* is the same event arriving twice.
    // Answering with the current state — and not an error — is what makes a
    // retry safe.
    const seenKey = `${input.step}:${input.idempotencyKey}`;
    if (record.seen.includes(seenKey))
      return {
        applied: false,
        code: 'benefit_already_applied',
        reason: 'This step was already recorded. Sending it again changes nothing.',
        view: view(record),
      };

    if (record.consumed)
      return {
        applied: false,
        code: 'benefit_consumed',
        reason:
          'The included customization engagement for this business has been delivered and accepted. There is one, and it is used.',
        view: view(record),
      };

    if (record.state !== move.from)
      return {
        applied: false,
        code: 'benefit_invalid_transition',
        reason: `The customization benefit is ${record.state}, and ${input.step} follows ${move.from}.`,
        view: view(record),
      };

    record.state = move.to;
    record.sequence += 1;
    record.actor = input.actor;

    switch (input.step) {
      case 'request':
        record.engagementId = input.engagementId?.trim() || randomUUID();
        record.requestedAt = input.at;
        record.themeId = null;
        record.themeRevision = null;
        record.lastFailedAt = null;
        record.lastFailureReason = null;
        break;
      case 'draft':
        record.themeId = input.themeId ?? null;
        record.themeRevision = input.themeRevision ?? null;
        record.draftedAt = input.at;
        break;
      case 'review':
        record.reviewStartedAt = input.at;
        break;
      case 'accept':
        record.acceptedAt = input.at;
        // Delivery is what acceptance records. The two are one fact.
        record.deliveredAt = input.at;
        record.consumed = true;
        break;
      case 'fail':
        // Still owed: the engagement identity and what it was about are
        // cleared, and the record is eligible again.
        record.engagementId = null;
        record.themeId = null;
        record.themeRevision = null;
        record.draftedAt = null;
        record.reviewStartedAt = null;
        record.requestedAt = null;
        record.lastFailedAt = input.at;
        record.lastFailureReason = input.reason?.trim() || 'The draft was not delivered.';
        break;
    }

    record.seen.push(seenKey);
    await this.persist(input.organizationId, record);
    return { applied: true, view: view(record) };
  }

  private async persist(organizationId: string, record: Record_) {
    this.records.set(organizationId, record);
    await jsonWrite(this.file(organizationId), record);
  }
}
