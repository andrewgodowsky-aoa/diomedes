/**
 * Per-member monthly credit limits, raise requests and who used what (migration 014).
 *
 * The control plane is the one authority. `FundingService.reserve` and `FundingService.holdPurchased`
 * enforce a member's limit under the organization lock, in the same transaction that holds the credits,
 * so no desktop can skip it and no two concurrent steps can both slip under it. This module holds
 * everything else a limit needs: the settings an owner or admin changes, the member's ask for more, an
 * owner's or admin's answer, and the usage reads. The pure rules are the shared contract in
 * `shared/credit-allotments.ts`.
 *
 * Two classes. `MemberLimits` takes verified ids and a verified role and runs the funding
 * transactions; it never reads a membership. `MemberLimitsService` is the authenticated surface:
 * membership first, the same assertion every workspace read uses, then the roster for the roles of
 * the people a change is about. Nothing in a request body names a tenant, an organization, a person
 * to act as, or a figure the server should believe about usage.
 *
 * A raise is finite and is never a standing change:
 *  - one job: the job may spend up to its own cap past the member's limit, and nothing else may;
 *  - the month: the approver chooses how much is added, and it lapses when the period rolls over.
 * Bought credits lift a member past their limit only when the approval says so.
 *
 * Per team waits for departments (DIO-122). The seam is the `scope_kind` column on a request and the
 * `subject_kind` column on a limit: both accept only `person` and `role` today, and a team is one
 * more value, with its own resolver, in a later migration. No team is built here.
 */
import { z } from 'zod';
import {
  MAX_MONEY_MICRO_USD,
  micro,
  periodIdFor,
  subtractMoney,
  sumMoney,
  type MicroUsd,
} from '../../../shared/managed-usage.js';
import {
  LIMITABLE_ROLES,
  LIMIT_MODES,
  LIMIT_REQUEST_KINDS,
  effectiveLimit,
  defaultLimitFor,
  type LimitMode,
  type LimitableRole,
  type LimitRequestKind,
  type LimitRequestState,
  type LimitRequestView,
  type LimitSetting,
  type LimitSubject,
  type MemberUsageView,
  type MyCreditUsage,
} from '../../../shared/credit-allotments.js';
import type { MemberRole } from '../../../shared/workspaces.js';
import type { AccountService } from './account-service.js';
import { FundingError, requireId, requireMoney, type FundingRepository, type FundingTransaction } from './funding.js';

// --- rows ------------------------------------------------------------------------------------

/** One limit a business has set: for a role, or for one person. */
export interface MemberLimitRow {
  tenantId: string;
  organizationId: string;
  subjectKind: 'role' | 'person';
  /** A role name, or a person id. */
  subjectId: string;
  mode: LimitMode;
  /** Present exactly when the mode is `limit`. */
  limitMicroUsd: MicroUsd | null;
  updatedBy: string;
  updatedAt: string;
}

/** Who sees what, per business. Defaults apply until an owner changes them. */
export interface AllotmentSettingsRow {
  tenantId: string;
  organizationId: string;
  /** A member may read their own usage against their own limit. */
  membersSeeOwnUsage: boolean;
  /** An admin may read who used what. An owner always may. */
  adminsSeeMemberUsage: boolean;
  updatedBy: string;
  updatedAt: string;
}

export const DEFAULT_ALLOTMENT_SETTINGS = Object.freeze({ membersSeeOwnUsage: true, adminsSeeMemberUsage: true });

/** A member's ask for more, and the answer. A request is not an approval and changes nothing. */
export interface LimitRequestRow {
  tenantId: string;
  organizationId: string;
  requestId: string;
  /** Today always `person`: a team is a later value (DIO-122). */
  scopeKind: 'person';
  personId: string;
  /** The asker's role when they asked, so an admin never decides an admin's or an owner's request. */
  requesterRole: MemberRole;
  kind: LimitRequestKind;
  rootJobId: string | null;
  state: LimitRequestState;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** Set on approval: what the approval adds to the limit. */
  extraMicroUsd: MicroUsd | null;
  allowPurchased: boolean;
  /** Set on a month approval: the period it covers. */
  periodId: string | null;
}

/** One person's usage in one period, from the rows that name them. */
export interface MemberUsageRow {
  personId: string;
  includedMicroUsd: MicroUsd;
  purchasedMicroUsd: MicroUsd;
  /** Of included and purchased together, what is held for work still running. */
  heldMicroUsd: MicroUsd;
}

/** Which person a funded attempt was reserved for. Written in the reserving transaction. */
export interface AttemptPersonRow {
  tenantId: string;
  attemptId: string;
  organizationId: string;
  personId: string;
}

export const ZERO_USAGE = Object.freeze({
  includedMicroUsd: micro(0),
  purchasedMicroUsd: micro(0),
  heldMicroUsd: micro(0),
});

export const usageView = (row: Pick<MemberUsageRow, 'includedMicroUsd' | 'purchasedMicroUsd' | 'heldMicroUsd'>): MemberUsageView => ({
  usedMicroUsd: row.includedMicroUsd + row.purchasedMicroUsd,
  includedMicroUsd: row.includedMicroUsd,
  purchasedMicroUsd: row.purchasedMicroUsd,
  heldMicroUsd: row.heldMicroUsd,
});

export const settingOf = (row: MemberLimitRow): LimitSetting => ({
  subjectKind: row.subjectKind, subjectId: row.subjectId, mode: row.mode, limitMicroUsd: row.limitMicroUsd,
});

export const requestView = (row: LimitRequestRow): LimitRequestView => ({
  requestId: row.requestId, personId: row.personId, kind: row.kind, jobId: row.rootJobId, state: row.state,
  requestedAt: row.requestedAt, decidedAt: row.decidedAt, decidedBy: row.decidedBy,
  extraMicroUsd: row.extraMicroUsd, allowPurchased: row.allowPurchased, periodId: row.periodId,
});

// --- the answers -----------------------------------------------------------------------------

export interface LimitsView {
  organizationId: string;
  periodId: string;
  /** The plan this month's credit came from, or null when no month is funded yet. */
  planId: string | null;
  /** What a member is held to when nothing is set. Null when no month is funded: nothing is guessed. */
  defaultMemberLimitMicroUsd: number | null;
  roles: { role: 'member' | 'admin'; mode: LimitMode; limitMicroUsd: number | null; effectiveMicroUsd: number | null; source: 'role' | 'default' }[];
  people: { personId: string; mode: LimitMode; limitMicroUsd: number | null }[];
  settings: { membersSeeOwnUsage: boolean; adminsSeeMemberUsage: boolean };
}

export interface MemberUsageReport {
  organizationId: string;
  periodId: string;
  startsAt: string;
  resetsAt: string;
  members: {
    personId: string;
    role: MemberRole | null;
    usage: MemberUsageView;
    /** Null means no limit beyond the shared pool. */
    limitMicroUsd: number | null;
    limitSource: 'person' | 'role' | 'default';
    /** What approvals added this month. */
    raisedByMicroUsd: number;
  }[];
}

export interface Actor {
  personId: string;
  role: MemberRole;
}

/** Owners and admins, the only roles that manage limits. The role comes from a verified membership. */
const manages = (role: MemberRole) => role === 'owner' || role === 'admin';
const notAuthorized = () => new FundingError(403, 'Only an owner or an admin can do that.', 'not_authorized');
const ownerOnly = () => new FundingError(403, 'Only an owner can set limits for an admin or another owner.', 'owner_required');

const topUpAvailable = (totals: { purchasedMicroUsd: MicroUsd; heldMicroUsd: MicroUsd; settledMicroUsd: MicroUsd }) =>
  subtractMoney(totals.purchasedMicroUsd, sumMoney([totals.heldMicroUsd, totals.settledMicroUsd]));

async function currentPeriod(tx: FundingTransaction, tenantId: string, organizationId: string, at: string) {
  const periodId = periodIdFor(at);
  return { periodId, period: await tx.period(tenantId, organizationId, periodId) };
}

export class MemberLimits {
  private readonly now: () => number;

  constructor(private readonly repository: FundingRepository, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private at() {
    return new Date(this.now()).toISOString();
  }

  /** Who may set a limit for whom. An admin reaches members only; an owner reaches everyone. */
  private assertMayLimit(actor: Actor, targetRole: MemberRole | LimitableRole) {
    if (!manages(actor.role)) throw notAuthorized();
    if (actor.role === 'admin' && targetRole !== 'member') throw ownerOnly();
  }

  /** The limits a business has set, the default under them, and who sees what. Owners and admins only. */
  async limits(input: { tenantId: string; organizationId: string; actor: Actor }): Promise<LimitsView> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    if (!manages(input.actor.role)) throw notAuthorized();
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const { periodId, period } = await currentPeriod(tx, tenantId, organizationId, at);
      const rows = await tx.memberLimits(tenantId, organizationId);
      const settings = await tx.allotmentSettings(tenantId, organizationId);
      const monthly = period?.grantedMicroUsd ?? null;
      const settingsList = rows.map(settingOf);
      return {
        organizationId, periodId, planId: period?.planId ?? null,
        defaultMemberLimitMicroUsd: period ? defaultLimitFor({ role: 'member', planId: period.planId, monthlyGrantMicroUsd: period.grantedMicroUsd }) : null,
        roles: LIMITABLE_ROLES.map((role) => {
          const row = rows.find((item) => item.subjectKind === 'role' && item.subjectId === role);
          const effective = monthly === null || !period
            ? { limitMicroUsd: null, source: 'default' as const }
            : effectiveLimit({ role, personId: '-', settings: settingsList.filter((item) => item.subjectKind === 'role'), planId: period.planId, monthlyGrantMicroUsd: period.grantedMicroUsd });
          return { role, mode: row?.mode ?? 'inherit', limitMicroUsd: row?.limitMicroUsd ?? null,
            effectiveMicroUsd: effective.limitMicroUsd, source: effective.source === 'default' ? 'default' as const : 'role' as const };
        }),
        people: rows.filter((row) => row.subjectKind === 'person' && row.mode !== 'inherit')
          .map((row) => ({ personId: row.subjectId, mode: row.mode, limitMicroUsd: row.limitMicroUsd })),
        settings: { membersSeeOwnUsage: settings?.membersSeeOwnUsage ?? DEFAULT_ALLOTMENT_SETTINGS.membersSeeOwnUsage,
          adminsSeeMemberUsage: settings?.adminsSeeMemberUsage ?? DEFAULT_ALLOTMENT_SETTINGS.adminsSeeMemberUsage },
      };
    });
  }

  /**
   * Set, or clear, one limit. Idempotent: setting what is already set changes nothing. `target` is
   * the role of the person a per-person limit is for, read by the caller from the roster.
   */
  async setLimit(input: {
    tenantId: string; organizationId: string; actor: Actor; subject: LimitSubject; targetRole: MemberRole | null;
    mode: LimitMode; limitMicroUsd: number | null;
  }): Promise<MemberLimitRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    requireId(input.actor.personId, 'person');
    if (!(LIMIT_MODES as readonly string[]).includes(input.mode)) throw new FundingError(422, 'A limit is a number of credits, unlimited, or inherited.', 'invalid_request');
    const subjectId = input.subject.kind === 'role' ? input.subject.role : requireId(input.subject.personId, 'person');
    if (input.subject.kind === 'role') {
      if (!(LIMITABLE_ROLES as readonly string[]).includes(input.subject.role)) throw new FundingError(422, 'A limit can be set for members and admins.', 'invalid_request');
      this.assertMayLimit(input.actor, input.subject.role);
    } else {
      if (!input.targetRole) throw new FundingError(404, 'That person is not a member of this business.', 'unknown_member');
      this.assertMayLimit(input.actor, input.targetRole);
    }
    let limit: MicroUsd | null = null;
    if (input.mode === 'limit') limit = requireMoney(input.limitMicroUsd, 'the limit', false);
    else if (input.limitMicroUsd !== null) throw new FundingError(422, 'Only a limit has an amount.', 'invalid_amount');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const rows = await tx.memberLimits(tenantId, organizationId);
      const existing = rows.find((row) => row.subjectKind === input.subject.kind && row.subjectId === subjectId);
      if (existing && existing.mode === input.mode && existing.limitMicroUsd === limit) return existing;
      const row: MemberLimitRow = { tenantId, organizationId, subjectKind: input.subject.kind, subjectId, mode: input.mode,
        limitMicroUsd: limit, updatedBy: input.actor.personId, updatedAt: at };
      await tx.saveMemberLimit(row);
      return row;
    });
  }

  /** Change who sees what. An owner only. */
  async setSettings(input: { tenantId: string; organizationId: string; actor: Actor; membersSeeOwnUsage?: boolean; adminsSeeMemberUsage?: boolean }): Promise<AllotmentSettingsRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    if (input.actor.role !== 'owner') throw new FundingError(403, 'Only an owner can change who sees usage.', 'owner_required');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.allotmentSettings(tenantId, organizationId);
      const row: AllotmentSettingsRow = {
        tenantId, organizationId,
        membersSeeOwnUsage: input.membersSeeOwnUsage ?? existing?.membersSeeOwnUsage ?? DEFAULT_ALLOTMENT_SETTINGS.membersSeeOwnUsage,
        adminsSeeMemberUsage: input.adminsSeeMemberUsage ?? existing?.adminsSeeMemberUsage ?? DEFAULT_ALLOTMENT_SETTINGS.adminsSeeMemberUsage,
        updatedBy: input.actor.personId, updatedAt: at,
      };
      if (existing && existing.membersSeeOwnUsage === row.membersSeeOwnUsage && existing.adminsSeeMemberUsage === row.adminsSeeMemberUsage) return existing;
      await tx.saveAllotmentSettings(row);
      return row;
    });
  }

  /**
   * The caller's own usage against their own limit this month, and their own requests. Never the
   * pool and never anyone else. A member whose business turned this off is told it is not shown.
   */
  async mine(input: { tenantId: string; organizationId: string; actor: Actor }): Promise<MyCreditUsage> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const personId = requireId(input.actor.personId, 'person');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const settings = await tx.allotmentSettings(tenantId, organizationId);
      if (input.actor.role === 'member' && !(settings?.membersSeeOwnUsage ?? DEFAULT_ALLOTMENT_SETTINGS.membersSeeOwnUsage))
        return { state: 'hidden', organizationId, reason: 'This business doesn’t show members their usage.' } as const;
      const { periodId, period } = await currentPeriod(tx, tenantId, organizationId, at);
      if (!period)
        return { state: 'unavailable', organizationId, reason: 'No credit grant is recorded for this month, so there is no usage to show.' } as const;
      const usage = (await tx.memberUsage(tenantId, organizationId, period, personId, at))[0] ?? { personId, ...ZERO_USAGE };
      const eff = effectiveLimit({ role: input.actor.role, personId, settings: (await tx.memberLimits(tenantId, organizationId)).map(settingOf),
        planId: period.planId, monthlyGrantMicroUsd: period.grantedMicroUsd });
      const requests = await tx.limitRequests(tenantId, organizationId, { personId });
      const raisedBy = requests.filter((row) => row.state === 'approved' && row.kind === 'month' && row.periodId === periodId)
        .reduce((sum, row) => sum + (row.extraMicroUsd ?? 0), 0);
      return {
        state: 'ready', organizationId, periodId, resetsAt: period.endsAt, usage: usageView(usage),
        limitMicroUsd: eff.limitMicroUsd, raisedByMicroUsd: raisedBy,
        requests: requests.slice(-20).map(requestView),
      } as const;
    });
  }

  /**
   * Who used what this month, by member, in micro-USD. Owners and admins; an owner can turn it off
   * for admins. `people` are the business's roster, so a member who used nothing still appears.
   */
  async report(input: { tenantId: string; organizationId: string; actor: Actor; people: readonly { personId: string; role: MemberRole }[] }): Promise<MemberUsageReport | { state: 'unavailable'; reason: string }> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    if (!manages(input.actor.role)) throw notAuthorized();
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      const settings = await tx.allotmentSettings(tenantId, organizationId);
      if (input.actor.role === 'admin' && !(settings?.adminsSeeMemberUsage ?? DEFAULT_ALLOTMENT_SETTINGS.adminsSeeMemberUsage))
        throw new FundingError(403, 'This business shows member usage to its owners only.', 'not_authorized');
      const { periodId, period } = await currentPeriod(tx, tenantId, organizationId, at);
      if (!period) return { state: 'unavailable', reason: 'No credit grant is recorded for this month, so there is no usage to show.' } as const;
      const used = await tx.memberUsage(tenantId, organizationId, period, null, at);
      const rows = (await tx.memberLimits(tenantId, organizationId)).map(settingOf);
      const requests = await tx.limitRequests(tenantId, organizationId, { state: 'approved' });
      const ids = new Set([...input.people.map((p) => p.personId), ...used.map((row) => row.personId)]);
      return {
        organizationId, periodId, startsAt: period.startsAt, resetsAt: period.endsAt,
        members: [...ids].map((personId) => {
          const role = input.people.find((p) => p.personId === personId)?.role ?? null;
          const usage = used.find((row) => row.personId === personId) ?? { personId, ...ZERO_USAGE };
          const eff = role ? effectiveLimit({ role, personId, settings: rows, planId: period.planId, monthlyGrantMicroUsd: period.grantedMicroUsd })
            : { limitMicroUsd: null, source: 'default' as const };
          return { personId, role, usage: usageView(usage), limitMicroUsd: eff.limitMicroUsd, limitSource: eff.source,
            raisedByMicroUsd: requests.filter((row) => row.personId === personId && row.kind === 'month' && row.periodId === periodId)
              .reduce((sum, row) => sum + (row.extraMicroUsd ?? 0), 0) };
        }),
      };
    });
  }

  /**
   * A member asks for more: for one job, or for the month. The server sizes nothing: a job is raised
   * by that job's own cap when it is approved, and a month by what the approver chooses. A second
   * ask for the same thing while one is open returns the open one. Idempotent by request id.
   */
  async ask(input: { tenantId: string; organizationId: string; requestId: string; actor: Actor; kind: LimitRequestKind; jobId: string | null }): Promise<LimitRequestRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const requestId = requireId(input.requestId, 'request');
    const personId = requireId(input.actor.personId, 'person');
    if (!(LIMIT_REQUEST_KINDS as readonly string[]).includes(input.kind)) throw new FundingError(422, 'Ask for one job, or for the month.', 'invalid_request');
    const rootJobId = input.kind === 'job' ? requireId(input.jobId, 'job') : null;
    if (input.kind === 'month' && input.jobId !== null) throw new FundingError(422, 'A request for the month doesn’t name a job.', 'invalid_request');
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const existing = await tx.limitRequest(tenantId, requestId);
      if (existing) {
        if (existing.organizationId !== organizationId || existing.personId !== personId || existing.kind !== input.kind || existing.rootJobId !== rootJobId)
          throw new FundingError(409, 'That request id is already used for a different request.', 'limit_request_conflict');
        return existing;
      }
      if (rootJobId !== null) {
        const job = await tx.job(tenantId, rootJobId);
        if (!job || job.organizationId !== organizationId) throw new FundingError(404, 'That job was not found for this business.', 'unknown_job');
      }
      const mine = await tx.limitRequests(tenantId, organizationId, { personId });
      const same = mine.find((row) => row.kind === input.kind && row.rootJobId === rootJobId && (row.state === 'pending' || (row.kind === 'job' && row.state === 'approved')));
      if (same) return same;
      const row: LimitRequestRow = { tenantId, organizationId, requestId, scopeKind: 'person', personId, requesterRole: input.actor.role, kind: input.kind,
        rootJobId, state: 'pending', requestedAt: at, decidedBy: null, decidedAt: null, extraMicroUsd: null, allowPurchased: false, periodId: null };
      await tx.saveLimitRequest(row);
      return row;
    });
  }

  /** Requests, newest last. An owner or admin sees every one; anyone else sees only their own. */
  async requests(input: { tenantId: string; organizationId: string; actor: Actor; state?: LimitRequestState }): Promise<LimitRequestRow[]> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const all = manages(input.actor.role);
    return this.repository.transaction(async (tx) => tx.limitRequests(tenantId, organizationId, {
      ...(all ? {} : { personId: requireId(input.actor.personId, 'person') }), ...(input.state ? { state: input.state } : {}),
    }));
  }

  /**
   * An owner or admin approves or denies a pending request. An owner decides any; an admin decides
   * a member's, never their own and never another admin's or an owner's. Approving one job adds that
   * job's own cap to the member's limit for that job. Approving the month adds what the approver
   * chose, for this period only. `allowPurchased` lets the approval draw on bought credits, and is
   * refused when none are free. A decision is final: asking again returns what was decided.
   */
  async decide(input: { tenantId: string; organizationId: string; requestId: string; actor: Actor; approve: boolean; extraMicroUsd?: number; allowPurchased?: boolean }): Promise<LimitRequestRow> {
    const tenantId = requireId(input.tenantId, 'tenant');
    const organizationId = requireId(input.organizationId, 'organization');
    const requestId = requireId(input.requestId, 'request');
    requireId(input.actor.personId, 'person');
    if (!manages(input.actor.role)) throw notAuthorized();
    const at = this.at();
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(tenantId, organizationId);
      const request = await tx.limitRequest(tenantId, requestId);
      if (!request || request.organizationId !== organizationId)
        throw new FundingError(404, 'That request was not found for this business.', 'unknown_limit_request');
      if (input.actor.role === 'admin' && (request.requesterRole !== 'member' || request.personId === input.actor.personId))
        throw new FundingError(403, 'Only an owner can decide a request from an admin or another owner, or from yourself.', 'owner_required');
      if (request.state !== 'pending') return request;
      if (!input.approve) {
        const denied: LimitRequestRow = { ...request, state: 'denied', decidedBy: input.actor.personId, decidedAt: at };
        await tx.saveLimitRequest(denied);
        return denied;
      }
      let extra: MicroUsd;
      let periodId: string | null = null;
      if (request.kind === 'job') {
        const job = await tx.job(tenantId, request.rootJobId!);
        if (!job || job.organizationId !== organizationId) throw new FundingError(404, 'That job was not found for this business.', 'unknown_job');
        extra = job.capMicroUsd;
      } else {
        if (input.extraMicroUsd === undefined) throw new FundingError(422, 'Say how many credits to add for the month.', 'invalid_amount');
        extra = requireMoney(input.extraMicroUsd, 'the credits to add');
        if (extra > MAX_MONEY_MICRO_USD) throw new FundingError(422, 'That amount is too large.', 'invalid_amount');
        periodId = periodIdFor(at);
      }
      const allowPurchased = input.allowPurchased === true;
      if (allowPurchased && topUpAvailable(await tx.topUpTotals(tenantId, organizationId, at)) === 0)
        throw new FundingError(402, 'No bought credits are free to approve.', 'no_purchased_usage');
      const approved: LimitRequestRow = { ...request, state: 'approved', decidedBy: input.actor.personId, decidedAt: at, extraMicroUsd: extra, allowPurchased, periodId };
      await tx.saveLimitRequest(approved);
      return approved;
    });
  }
}

// --- the authenticated surface -----------------------------------------------------------------

const idText = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const microUsd = z.number().int().nonnegative().max(MAX_MONEY_MICRO_USD);

export const setLimitInput = z.strictObject({
  subject: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('role'), role: z.enum(['member', 'admin']) }),
    z.strictObject({ kind: z.literal('person'), personId: idText }),
  ]),
  mode: z.enum(['limit', 'unlimited', 'inherit']),
  limitMicroUsd: microUsd.nullable().default(null),
});
export const setSettingsInput = z.strictObject({
  membersSeeOwnUsage: z.boolean().optional(),
  adminsSeeMemberUsage: z.boolean().optional(),
}).refine((value) => value.membersSeeOwnUsage !== undefined || value.adminsSeeMemberUsage !== undefined, 'Change at least one setting.');
export const askRaiseInput = z.strictObject({
  requestId: idText,
  kind: z.enum(['job', 'month']),
  jobId: idText.nullable().default(null),
});
export const decideRaiseInput = z.strictObject({
  approve: z.boolean(),
  extraMicroUsd: microUsd.optional(),
  allowPurchased: z.boolean().optional(),
});

/**
 * The account service's side of limits: membership verified first, then the funding transaction as
 * the organization's own tenant and the verified person. A body never names either.
 */
export class MemberLimitsService {
  constructor(
    private readonly accounts: Pick<AccountService, 'membership' | 'roster'>,
    private readonly funding: Pick<MemberLimits, 'limits' | 'setLimit' | 'setSettings' | 'mine' | 'report' | 'ask' | 'requests' | 'decide'>,
  ) {}

  private async actor(token: string, organizationId: string) {
    const snapshot = await this.accounts.membership(token, organizationId);
    return {
      tenantId: snapshot.organization.tenantId, organizationId: snapshot.organization.id,
      actor: { personId: snapshot.person.id, role: snapshot.membership.role } satisfies Actor,
    };
  }

  limits(token: string, organizationId: string) {
    return this.actor(token, organizationId).then((who) => this.funding.limits(who));
  }

  async setLimit(token: string, organizationId: string, input: z.infer<typeof setLimitInput>) {
    const who = await this.actor(token, organizationId);
    let targetRole: MemberRole | null = null;
    if (input.subject.kind === 'person') {
      // The target's role comes from the roster, read as the actor, never from the request.
      const target = input.subject.personId;
      const roster = await this.accounts.roster(token, organizationId);
      targetRole = roster.people.find((row) => row.personId === target && row.state === 'active')?.role ?? null;
    }
    return this.funding.setLimit({ ...who, subject: input.subject, targetRole, mode: input.mode, limitMicroUsd: input.limitMicroUsd });
  }

  async setSettings(token: string, organizationId: string, input: z.infer<typeof setSettingsInput>) {
    return this.funding.setSettings({ ...(await this.actor(token, organizationId)), ...input });
  }

  mine(token: string, organizationId: string) {
    return this.actor(token, organizationId).then((who) => this.funding.mine(who));
  }

  async report(token: string, organizationId: string) {
    const who = await this.actor(token, organizationId);
    if (!manages(who.actor.role)) throw notAuthorized();
    const roster = await this.accounts.roster(token, organizationId);
    return this.funding.report({ ...who, people: roster.people.filter((row) => row.state === 'active').map((row) => ({ personId: row.personId, role: row.role })) });
  }

  async ask(token: string, organizationId: string, input: z.infer<typeof askRaiseInput>) {
    const who = await this.actor(token, organizationId);
    return requestView(await this.funding.ask({ ...who, requestId: input.requestId, kind: input.kind, jobId: input.jobId }));
  }

  async requests(token: string, organizationId: string) {
    const who = await this.actor(token, organizationId);
    return { organizationId, requests: (await this.funding.requests(who)).map(requestView) };
  }

  async decide(token: string, organizationId: string, requestId: string, input: z.infer<typeof decideRaiseInput>) {
    const who = await this.actor(token, organizationId);
    return requestView(await this.funding.decide({ ...who, requestId, approve: input.approve,
      ...(input.extraMicroUsd === undefined ? {} : { extraMicroUsd: input.extraMicroUsd }), ...(input.allowPurchased === undefined ? {} : { allowPurchased: input.allowPurchased }) }));
  }
}
