import { z } from 'zod';
import { billingView } from '../../../shared/account-billing.js';
import { PLAN_TEMPLATES } from '../../../shared/access.js';
import { INDIVIDUAL_PLAN } from '../../../shared/individual-plan.js';
import { inTransaction, type ClientFactory, type SqlClient } from './postgres.js';
import { PostgresCommercialTransaction } from './commercial-postgres.js';
import { featureGrantSchema, personFeatureGrantSchema, type FeatureGrant, type PersonFeatureGrant } from './commercial.js';
import { BILLING_SYSTEM_ACTOR, BILLING_SYSTEM_ROLE } from './billing-system.js';
import { AccountError } from './errors.js';
import type { StripeMode } from './stripe-events.js';
import type { SubscriptionStore, SubscriptionOwner, CheckoutAttempt, PaidSubscription } from './subscriptions.js';

const attemptShape = z.object({ id: z.string(), planId: z.string(), createdAt: z.number(), sessionId: z.string().nullable(), url: z.string().nullable() });
export class PostgresSubscriptions implements SubscriptionStore {
  constructor(private readonly factory: ClientFactory, private readonly now = Date.now) {}
  private async lock(client: SqlClient, customer: string, mode: StripeMode) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`subscription:${mode}:${customer}`]);
  }
  owner(customer: string, mode: StripeMode) {
    return inTransaction(this.factory, async client => {
      const row = (await client.query('SELECT customer_id,organization_id,tenant_id,person_id FROM control_plane.billing_customers WHERE provider=$1 AND customer_id=$2 AND environment=$3', ['stripe', customer, mode])).rows[0];
      return row ? { customerId: String(row.customer_id), organizationId: String(row.organization_id), tenantId: String(row.tenant_id), personId: row.person_id === null ? null : String(row.person_id) } : null;
    });
  }
  view(customer: string, mode: StripeMode) {
    return inTransaction(this.factory, async client => {
      const row = (await client.query('SELECT projection FROM control_plane.subscription_accounts WHERE customer_id=$1 AND environment=$2', [customer, mode])).rows[0];
      return billingView.shape.subscriptions.parse(row?.projection ?? []);
    });
  }
  private async ensure(client: SqlClient, owner: SubscriptionOwner, mode: StripeMode) {
    await client.query('INSERT INTO control_plane.subscription_accounts(customer_id,environment,organization_id,tenant_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [owner.customerId, mode, owner.organizationId, owner.tenantId]);
  }
  attempt(owner: SubscriptionOwner, mode: StripeMode, planId: string, now: number) {
    return inTransaction(this.factory, async client => {
      await this.lock(client, owner.customerId, mode);
      await this.ensure(client, owner, mode);
      const row = (await client.query('SELECT attempt,suspended FROM control_plane.subscription_accounts WHERE customer_id=$1 AND environment=$2', [owner.customerId, mode])).rows[0];
      if (row.suspended) throw new AccountError(409, 'Billing needs review. Contact Diomedes.');
      if (row.attempt) return attemptShape.parse(row.attempt);
      const attempt: CheckoutAttempt = { id: `subscription_checkout_${crypto.randomUUID()}`, planId, createdAt: now, sessionId: null, url: null };
      await client.query('UPDATE control_plane.subscription_accounts SET attempt=$3::jsonb WHERE customer_id=$1 AND environment=$2', [owner.customerId, mode, JSON.stringify(attempt)]);
      return attempt;
    });
  }
  complete(customer: string, mode: StripeMode, attemptId: string, sessionId: string, url: string) {
    return inTransaction(this.factory, async client => {
      await this.lock(client, customer, mode);
      const result = await client.query(`UPDATE control_plane.subscription_accounts SET attempt=attempt || $4::jsonb
        WHERE customer_id=$1 AND environment=$2 AND attempt->>'id'=$3 AND (attempt->>'sessionId' IS NULL OR attempt->>'sessionId'=$5) RETURNING customer_id`,
      [customer, mode, attemptId, JSON.stringify({ sessionId, url }), sessionId]);
      if (result.rows.length !== 1) throw new AccountError(409, 'The payment request changed. Refresh billing.');
    });
  }
  expire(customer: string, mode: StripeMode, attemptId: string) {
    return inTransaction(this.factory, async client => {
      await this.lock(client, customer, mode);
      await client.query("UPDATE control_plane.subscription_accounts SET attempt=NULL WHERE customer_id=$1 AND environment=$2 AND attempt->>'id'=$3", [customer, mode, attemptId]);
    });
  }
  reconcile(owner: SubscriptionOwner, mode: StripeMode, eventId: string, suspended: boolean, read: () => Promise<PaidSubscription[]>) {
    return inTransaction(this.factory, async client => {
      await this.lock(client, owner.customerId, mode);
      await this.ensure(client, owner, mode);
      const proof = (await client.query('SELECT customer_id,organization_id,tenant_id,environment FROM control_plane.webhook_inbox WHERE provider=$1 AND event_id=$2', ['stripe', eventId])).rows[0];
      if (!proof || proof.customer_id !== owner.customerId || proof.organization_id !== owner.organizationId || proof.tenant_id !== owner.tenantId || proof.environment !== mode)
        throw new AccountError(409, 'The subscription event does not belong to this account.');
      const stored = (await client.query('SELECT suspended FROM control_plane.subscription_accounts WHERE customer_id=$1 AND environment=$2', [owner.customerId, mode])).rows[0];
      const held = suspended || stored.suspended === true;
      const paid = held ? [] : await read();
      const at = new Date(this.now()).toISOString(), tx = new PostgresCommercialTransaction(client);
      if (owner.personId) await tx.lockPerson(owner.personId); else await tx.lockOrganization(owner.organizationId);
      const prior: Array<FeatureGrant | PersonFeatureGrant> = owner.personId ? await tx.personGrants(owner.personId) : await tx.grants(owner.organizationId);
      const prefix = `stripe:${mode}:${owner.customerId}:`;
      const current = paid.filter(row => (row.planId === 'individual') === !!owner.personId && Date.parse(row.validUntil) > this.now());
      const references = new Set(current.map(row => `${prefix}${row.invoiceId}`));
      const save = async (row: FeatureGrant | PersonFeatureGrant, revoked: boolean) => {
        if ('personId' in row) { await tx.savePersonGrant(personFeatureGrantSchema.parse(row)); await tx.bumpPersonAccessRevision(row.personId, row.tenantId); }
        else { await tx.saveGrant(featureGrantSchema.parse(row)); await tx.bumpAccessRevision(owner.organizationId, owner.tenantId); }
        await tx.audit({ id: `audit_${crypto.randomUUID()}`, at, actorPersonId: BILLING_SYSTEM_ACTOR, actorRole: BILLING_SYSTEM_ROLE,
          action: owner.personId ? (revoked ? 'person-grant.revoked' : 'person-grant.issued') : (revoked ? 'grant.revoked' : 'grant.issued'),
          organizationId: owner.personId ? null : owner.organizationId, targetKind: owner.personId ? 'person-grant' : 'grant', targetId: row.id,
          reason: revoked ? 'Stripe subscription is no longer paid or billing needs review.' : 'Verified paid Stripe subscription period.',
          detail: { eventId, environment: mode, reference: row.reference, personId: owner.personId, validFrom: row.validFrom, validUntil: row.validUntil } });
      };
      for (const row of prior) if (row.issuedBy === BILLING_SYSTEM_ACTOR && row.reference.startsWith(prefix) && row.state === 'active' && !references.has(row.reference)) {
        await save({ ...row, state: 'revoked', revokedAt: at, revokedBy: BILLING_SYSTEM_ACTOR, revokedReason: 'Stripe billing state changed.' }, true);
      }
      for (const period of current) {
        const reference = `${prefix}${period.invoiceId}`;
        // A manual or risk revocation is a tombstone. Replayed events cannot revive it.
        if (prior.some(row => row.reference === reference)) continue;
        if (prior.some(row => row.state === 'active' && !row.reference.startsWith(prefix) && Date.parse(row.validFrom) < Date.parse(period.validUntil) && Date.parse(row.validUntil) > Date.parse(period.validFrom)))
          throw new AccountError(409, 'An existing access agreement needs reconciliation before this subscription can grant access.');
        const plan = period.planId === 'individual' ? INDIVIDUAL_PLAN : PLAN_TEMPLATES.find(row => row.id === period.planId);
        if (!plan) throw new AccountError(409, 'This subscription plan is unknown.');
        const common = { v: 1 as const, id: `grant_${crypto.randomUUID()}`, tenantId: owner.tenantId, planId: period.planId, features: [...plan.features], source: 'subscription' as const,
          reference, note: 'Verified Stripe invoice', validFrom: period.validFrom, validUntil: period.validUntil, state: 'active' as const, issuedAt: at, issuedBy: BILLING_SYSTEM_ACTOR,
          revokedAt: null, revokedBy: null, revokedReason: null };
        await save(owner.personId ? { ...common, personId: owner.personId, billingCycle: period.billingCycle } : { ...common, organizationId: owner.organizationId }, false);
      }
      const projection = current.map(row => ({ id: row.id, planId: row.planId,
        status: prior.some(grant => grant.reference === `${prefix}${row.invoiceId}` && grant.state === 'revoked') ? 'review' : 'active', validUntil: row.validUntil }));
      await client.query('UPDATE control_plane.subscription_accounts SET suspended=$3,projection=$4::jsonb,source_event_id=$5 WHERE customer_id=$1 AND environment=$2', [owner.customerId, mode, held, JSON.stringify(projection), eventId]);
    });
  }
}
