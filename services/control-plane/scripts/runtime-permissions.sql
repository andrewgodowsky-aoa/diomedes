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
-- B01 runtime does not yet consume the later commercial tables. A separately
-- reviewed receiver role can receive only the inbox/customer privileges it needs.
-- NC-2026-09-22.1: the Worker's usage projection only reads funding rows.
GRANT SELECT ON control_plane.credit_periods, control_plane.funding_reservations,
  control_plane.funding_settlements, control_plane.credit_adjustments,
  control_plane.credit_topups TO cp_runtime;
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
