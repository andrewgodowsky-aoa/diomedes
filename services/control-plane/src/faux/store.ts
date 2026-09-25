/**
 * The faux cloud's database: one JSON document standing in for Neon.
 *
 * It implements the three repository seams the real adapters implement —
 * `AccountRepository`, `CommercialRepository` and `FundingRepository` — plus the
 * faux identity state, so every service above it runs its production code.
 * Swapping to Neon is choosing `PostgresRepository`, `PostgresCommercialRepository`
 * and `PostgresFundingRepository` instead; nothing above the seam changes.
 *
 * Every transaction (of any of the four kinds) takes one process-wide lock,
 * works on a draft, validates the draft against the record schemas, and only
 * then replaces the state and writes the file (temp file + rename). A throw
 * leaves both the state and the file untouched. This models serializable
 * transactions for one process; it is not a multi-process database, and two
 * processes must never open one file (the faux cloud server holds a lock file).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Membership, Organization, Person } from '../../../../shared/workspaces.js';
import {
  admissionRecordSchema,
  auditEventSchema,
  featureGrantSchema,
  operatorSchema,
  routeEntrySchema,
  tierPolicySchema,
  type AdmissionRecord,
  type AuditEvent,
  type CommercialRepository,
  type CommercialTransaction,
  type FeatureGrant,
  type Operator,
  type RouteEntry,
  type TierPolicy,
} from '../commercial.js';
import { accountStateSchema, emptyAccountState, type AccountRepository, type AccountState, type AccountTransaction } from '../domain.js';
import type { FundingRepository, FundingTransaction } from '../funding.js';
import { StateTransaction } from '../state-transaction.js';
import { emptyFundingState, StateFundingTransaction, type FundingState } from './funding-state.js';
import { emptyFauxIdentity, fauxIdentityStateSchema, type FauxIdentityState } from './identity.js';

export interface CommercialState {
  grants: FeatureGrant[];
  accessRevisions: Record<string, { tenantId: string; revision: number }>;
  routes: RouteEntry[];
  policies: TierPolicy[];
  operators: Operator[];
  audit: AuditEvent[];
  admissions: AdmissionRecord[];
}

export interface FauxCloudState {
  v: 1;
  /** Marks the file as the faux cloud's, so it is never mistaken for a real export. */
  faux: true;
  createdAt: string;
  seeded: string | null;
  accounts: AccountState;
  identity: FauxIdentityState;
  commercial: CommercialState;
  funding: FundingState;
}

/** The append-only logs keep their newest entries up to this many. */
const LOG_LIMIT = 20_000;

const commercialSchema = z.strictObject({
  grants: z.array(featureGrantSchema).max(100_000),
  accessRevisions: z.record(z.string(), z.strictObject({ tenantId: z.string(), revision: z.number().int().min(0) })),
  routes: z.array(routeEntrySchema).max(500),
  policies: z.array(tierPolicySchema).max(10_000),
  operators: z.array(operatorSchema).max(1_000),
  audit: z.array(auditEventSchema).max(LOG_LIMIT),
  admissions: z.array(admissionRecordSchema).max(LOG_LIMIT),
});

export function emptyFauxCloudState(now = new Date().toISOString()): FauxCloudState {
  return {
    v: 1,
    faux: true,
    createdAt: now,
    seeded: null,
    accounts: emptyAccountState(),
    identity: emptyFauxIdentity(),
    commercial: { grants: [], accessRevisions: {}, routes: [], policies: [], operators: [], audit: [], admissions: [] },
    funding: emptyFundingState(),
  };
}

function validate(state: FauxCloudState): FauxCloudState {
  // Keep the append-only logs bounded, oldest first out, before validation.
  const cap = LOG_LIMIT;
  if (state.commercial.admissions.length > cap) state.commercial.admissions = state.commercial.admissions.slice(-cap);
  if (state.commercial.audit.length > cap) state.commercial.audit = state.commercial.audit.slice(-cap);
  return {
    v: 1,
    faux: true,
    createdAt: z.iso.datetime().parse(state.createdAt),
    seeded: state.seeded === null ? null : z.string().max(64).parse(state.seeded),
    accounts: accountStateSchema.parse(state.accounts),
    identity: fauxIdentityStateSchema.parse(state.identity),
    commercial: commercialSchema.parse(state.commercial) as CommercialState,
    funding: state.funding,
  };
}

const contains = (value: string, query: string) => value.toLowerCase().includes(query);
/** Newest first; rows written in the same millisecond keep their write order, latest first. */
const newestFirst = <T extends { at: string }>(rows: T[]) =>
  [...rows].reverse().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

class FauxCommercialTransaction implements CommercialTransaction {
  constructor(private readonly state: FauxCloudState) {}
  private get c() { return this.state.commercial; }
  async lockOrganization() {}
  async grants(organizationId: string) { return this.c.grants.filter((row) => row.organizationId === organizationId); }
  async saveGrant(row: FeatureGrant) {
    const index = this.c.grants.findIndex((old) => old.id === row.id);
    if (index < 0) this.c.grants.push(row);
    else {
      const old = this.c.grants[index];
      // The same rule the Postgres trigger enforces: revoked once, never edited otherwise.
      const { state: _a, revokedAt: _b, revokedBy: _c, revokedReason: _d, ...before } = old;
      const { state: _e, revokedAt: _f, revokedBy: _g, revokedReason: _h, ...after } = row;
      if (old.state === 'revoked' || JSON.stringify(before) !== JSON.stringify(after))
        throw new Error('A feature grant only changes by being revoked once.');
      this.c.grants[index] = row;
    }
  }
  async accessRevision(organizationId: string) { return this.c.accessRevisions[organizationId]?.revision ?? 0; }
  async bumpAccessRevision(organizationId: string, tenantId: string) {
    const next = (this.c.accessRevisions[organizationId]?.revision ?? 0) + 1;
    this.c.accessRevisions[organizationId] = { tenantId, revision: next };
    return next;
  }
  async routes() { return [...this.c.routes]; }
  async saveRoute(row: RouteEntry) {
    const index = this.c.routes.findIndex((old) => old.id === row.id);
    if (index < 0) this.c.routes.push(row); else this.c.routes[index] = row;
  }
  async lockPolicy() {}
  async policy(revision?: number) {
    if (revision !== undefined) return this.c.policies.find((row) => row.revision === revision);
    return [...this.c.policies].sort((a, b) => b.revision - a.revision)[0];
  }
  async policies(limit: number) { return [...this.c.policies].sort((a, b) => b.revision - a.revision).slice(0, limit); }
  async savePolicy(row: TierPolicy) {
    if (this.c.policies.some((old) => old.revision === row.revision)) throw new Error('Published tier policies are append-only.');
    this.c.policies.push(row);
  }
  async operator(personId: string) { return this.c.operators.find((row) => row.personId === personId); }
  async operators() { return [...this.c.operators]; }
  async saveOperator(row: Operator) {
    const index = this.c.operators.findIndex((old) => old.personId === row.personId);
    if (index < 0) this.c.operators.push(row); else this.c.operators[index] = row;
  }
  async audit(row: AuditEvent) { this.c.audit.push(row); }
  async auditLog(input: { organizationId?: string; limit: number }) {
    return newestFirst(this.c.audit.filter((row) => !input.organizationId || row.organizationId === input.organizationId)).slice(0, input.limit);
  }
  async saveAdmission(row: AdmissionRecord) { this.c.admissions.push(row); }
  async admissions(organizationId: string, limit: number) {
    return newestFirst(this.c.admissions.filter((row) => row.organizationId === organizationId)).slice(0, limit);
  }
  private subjectOf(personId: string) {
    const row = this.state.accounts.subjects.find((item) => item.personId === personId);
    if (!row) throw new Error('Account storage is inconsistent.');
    return row;
  }
  async organizations(query: string, limit: number) {
    return this.state.accounts.organizations
      .filter((row) => !query || contains(row.record.name, query) || row.record.id === query)
      .sort((a, b) => a.record.name.localeCompare(b.record.name))
      .slice(0, limit)
      .map((row) => ({
        organization: row.record as Organization,
        activeMembers: this.state.accounts.memberships.filter((item) => item.record.organizationId === row.record.id && item.record.state === 'active').length,
      }));
  }
  async organizationRecord(id: string) {
    return this.state.accounts.organizations.find((row) => row.record.id === id)?.record as Organization | undefined;
  }
  async roster(organizationId: string) {
    return this.state.accounts.memberships
      .filter((row) => row.record.organizationId === organizationId)
      .map((row) => {
        const person = this.state.accounts.persons.find((item) => item.id === row.record.personId);
        if (!person) throw new Error('Account storage is inconsistent.');
        const subject = this.subjectOf(person.id);
        return { membership: row.record as Membership, person: person as Person, issuer: subject.issuer, subject: subject.subject };
      });
  }
  async people(query: string, limit: number) {
    return this.state.accounts.persons
      .filter((row) => !query || contains(row.name, query) || row.id === query || this.emailOf(row.id)?.includes(query))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((person) => {
        const subject = this.subjectOf(person.id);
        return {
          person: person as Person,
          issuer: subject.issuer,
          subject: subject.subject,
          memberships: this.state.accounts.memberships.filter((row) => row.record.personId === person.id).map((row) => row.record as Membership),
        };
      });
  }
  /** The faux directory lets staff search by email too; the SQL adapter searches names only. */
  private emailOf(personId: string) {
    const subject = this.state.accounts.subjects.find((item) => item.personId === personId);
    return subject ? this.state.identity.users.find((row) => row.subject === subject.subject)?.email : undefined;
  }
  async person(personId: string) {
    const person = this.state.accounts.persons.find((row) => row.id === personId);
    if (!person) return undefined;
    const subject = this.subjectOf(personId);
    return { person: person as Person, issuer: subject.issuer, subject: subject.subject };
  }
}

export class FauxCloudStore {
  private state: FauxCloudState;
  private tail: Promise<void> = Promise.resolve();
  readonly accounts: AccountRepository;
  readonly commercial: CommercialRepository;
  readonly funding: FundingRepository;

  private constructor(private readonly file: string | null, state: FauxCloudState) {
    this.state = state;
    this.accounts = { transaction: (action) => this.run((draft) => action(new StateTransaction(draft.accounts)) as Promise<never>) };
    this.commercial = { transaction: (action) => this.run((draft) => action(new FauxCommercialTransaction(draft))) };
    this.funding = { transaction: (action) => this.run((draft) => action(new StateFundingTransaction(draft.funding))) };
  }

  /** Open (or create) a store. `file: null` keeps it in memory, for tests. */
  static async open(file: string | null, now = new Date().toISOString()): Promise<FauxCloudStore> {
    if (file === null) return new FauxCloudStore(null, emptyFauxCloudState(now));
    let state: FauxCloudState;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as FauxCloudState;
      if (raw?.faux !== true || raw.v !== 1) throw new Error(`${file} is not a faux cloud store.`);
      state = validate(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = emptyFauxCloudState(now);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await FauxCloudStore.write(file, state);
    }
    return new FauxCloudStore(file, state);
  }

  private static async write(file: string, state: FauxCloudState) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), 'utf8');
    await fs.rename(temp, file);
  }

  /** One serialized transaction over a draft of the whole state. */
  async run<T>(action: (draft: FauxCloudState) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => { release = done; });
    await prior;
    try {
      const draft = structuredClone(this.state);
      const result = await action(draft);
      if (JSON.stringify(draft) !== JSON.stringify(this.state)) {
        draft.accounts.revision++;
        const next = validate(draft);
        if (this.file) await FauxCloudStore.write(this.file, next);
        this.state = next;
      }
      return structuredClone(result);
    } finally {
      release();
    }
  }

  /** The identity state as of now. Readers never see an uncommitted draft. */
  async identity(): Promise<FauxIdentityState> {
    await this.tail;
    return structuredClone(this.state.identity);
  }

  /** A read-only copy, for diagnostics and tests. */
  snapshot(): FauxCloudState {
    return structuredClone(this.state);
  }
}
