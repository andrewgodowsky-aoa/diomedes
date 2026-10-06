-- REVIEW TEMPLATE ONLY. Run as the schema owner on an approved isolated DB.
-- Provision the login cp_runtime and its secret separately; this creates no role.
-- Grant no ownership, CREATE, DELETE, TRUNCATE or credential-table access.
REVOKE ALL ON SCHEMA control_plane FROM cp_runtime;
GRANT USAGE ON SCHEMA control_plane TO cp_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM cp_runtime;
GRANT SELECT, INSERT ON control_plane.persons, control_plane.external_subjects,
  control_plane.account_events TO cp_runtime;
GRANT SELECT, INSERT, UPDATE ON control_plane.sessions, control_plane.organizations,
  control_plane.memberships, control_plane.invitations TO cp_runtime;
-- 007 phone relay (2026-09-26): the device records the relay routes register,
-- list and revoke, and the relay hub rechecks every 20 seconds. A revocation
-- is a tombstone (revoked_at, revoked_by), never a DELETE, and last_seen_at is
-- the only other column the Worker may move; the key and who registered it
-- cannot be rewritten. The rechecks also read memberships, sessions and
-- feature_grants, which this file grants too.
GRANT SELECT, INSERT ON control_plane.relay_devices TO cp_runtime;
GRANT UPDATE (revoked_at, revoked_by, last_seen_at) ON control_plane.relay_devices TO cp_runtime;
-- 008 organization setup (2026-09-26): each business's setup revisions. The
-- Worker reads the newest and appends the next; a revision is never updated or
-- deleted (the table's trigger refuses both), so it gets no UPDATE. A write
-- rechecks the writer's membership, which the grants above already cover.
GRANT SELECT, INSERT ON control_plane.organization_setups TO cp_runtime;
-- The later commercial tables (subscriptions, entitlement grants) are not consumed by the
-- Worker yet. The inbox and customer tables are, for one path only: the credit purchase
-- receiver and the purchase (src/credit-purchases.ts) use them. A purchase makes the
-- business's one Stripe customer before its first Checkout Session, through
-- PostgresRepository.ensureCustomer: under the business's advisory lock (a function any
-- role may call, so it needs no grant) it reads the stored customer and, when there is
-- none, stores the one Stripe made. The receiver stores each verified paid Stripe event
-- through PostgresRepository.recordVerifiedPayment, under the same lock, and stores an
-- event of a type nothing handles, marked ignored, through recordIgnoredEvent (016 lets an
-- inbox row carry no business). All of these are plain SELECT and INSERT statements, with no
-- row lock or DELETE: an event or a customer is written once and never rewritten. The one
-- thing that moves afterwards is an inbox event's state: markEvent (016) takes a pending
-- event to processed or quarantined with one UPDATE of state and processed_at, which is
-- why this login holds UPDATE on those two columns of webhook_inbox and nothing else of it.
-- The funding login (cp_funding) is not granted these tables, so it cannot make a top-up
-- (which references a stored event) on its own. tests/payment-ledger-permissions.test.ts
-- replays all of them and fails when these lines and those statements differ either way.
-- recordVerifiedWebhook, the older seam with no caller, takes a FOR KEY SHARE row lock on
-- billing_customers, which needs UPDATE on one column; it is not granted here and stays
-- with a separately reviewed receiver role.
GRANT SELECT, INSERT ON control_plane.billing_customers, control_plane.webhook_inbox TO cp_runtime;
GRANT UPDATE (state, processed_at) ON control_plane.webhook_inbox TO cp_runtime;
-- NC-2026-09-22.1: the Worker's usage projection only reads funding rows.
GRANT SELECT ON control_plane.credit_periods, control_plane.funding_reservations,
  control_plane.funding_settlements, control_plane.credit_adjustments,
  control_plane.credit_topups, control_plane.credit_topup_holds TO cp_runtime;
-- Funding writes (reserve, dispatch, settle, grants, top-ups, cap decisions)
-- belong to a separately reviewed runtime role, never to the Worker login.
-- 005 customer access (2026-09-25): what the Worker's customer-access, Agent
-- admission and /ops/* routes run, and nothing more. The upserts (ON CONFLICT
-- DO UPDATE) need UPDATE. Policies, the staff audit and admissions are
-- append-only: INSERT without UPDATE, and their triggers refuse rewrites anyway.
-- Funding stays with the reviewed funding role above: until it exists, a staff
-- grant is issued but its month's included credits are not allocated (the answer
-- says so), and a staff funding correction is refused.
GRANT SELECT, INSERT, UPDATE ON control_plane.invitation_codes, control_plane.feature_grants,
  control_plane.organization_access, control_plane.route_entries, control_plane.operators TO cp_runtime;
GRANT SELECT, INSERT ON control_plane.tier_policies, control_plane.ops_audit,
  control_plane.agent_admissions TO cp_runtime;
-- 006 staff keys (2026-09-26): the Worker only reads a key's hash to sign staff
-- in. Registering and withdrawing keys is the schema owner's, for now.
GRANT SELECT ON control_plane.staff_keys TO cp_runtime;
-- 010 scoped routing: Individual identities and customer consent append through
-- the account service. FOR SHARE needs UPDATE on one column; kind cannot change
-- to another value without violating the billing scope's identity constraint.
GRANT SELECT, INSERT ON control_plane.billing_scopes,
  control_plane.account_routing_preferences TO cp_runtime;
GRANT UPDATE (kind) ON control_plane.billing_scopes TO cp_runtime;
GRANT SELECT, INSERT ON control_plane.routing_job_constraints,
  control_plane.managed_route_circuits TO cp_runtime;
GRANT UPDATE (restrictions) ON control_plane.routing_job_constraints TO cp_runtime;
GRANT UPDATE (until_at, reason) ON control_plane.managed_route_circuits TO cp_runtime;
-- 009 Individual plans (2026-09-28): a person's own grants and access
-- revision, as feature_grants and organization_access are granted above (the
-- upserts need UPDATE; the grant trigger still allows only a revoke-once).
-- Personal admissions are append-only, like agent_admissions.
GRANT SELECT, INSERT, UPDATE ON control_plane.person_feature_grants, control_plane.person_access TO cp_runtime;
GRANT SELECT, INSERT ON control_plane.personal_agent_admissions TO cp_runtime;
