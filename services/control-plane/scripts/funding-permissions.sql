-- REVIEW TEMPLATE ONLY. Run as the schema owner on an approved isolated DB.
-- Provision the login cp_funding and its secret separately; this creates no role.
-- Grant no ownership, CREATE, DELETE, TRUNCATE or credential-table access.
-- cp_funding is the managed gateway's funding login (FUNDING_DATABASE_URL), the
-- separately reviewed role runtime-permissions.sql leaves funding writes to. It
-- may run exactly what PostgresFundingRepository (src/funding-postgres.ts)
-- executes on the gateway's paths in src/managed-inference.ts: FundingService
-- openJob, allocatePeriod (the month's credit, on the first call that needs it),
-- reserve, markDispatched, settle, releaseRefused and markUncertain, and the
-- direct reads period, attempt and settlement. tests/funding-permissions.test.ts
-- replays those paths and fails when this list and that SQL differ either way.
-- Account, identity, session, grant, admission and routing tables stay with the
-- Worker login (DATABASE_URL); the gateway reads them there.
-- Nothing else is needed: these tables have no sequences, triggers or row
-- security, foreign-key checks run as the table owner, and pg_advisory_xact_lock
-- and hashtextextended are executable by PUBLIC.
REVOKE ALL ON SCHEMA control_plane FROM cp_funding;
GRANT USAGE ON SCHEMA control_plane TO cp_funding;
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM cp_funding;
-- credit_periods. SELECT: period(), "SELECT * FROM control_plane.credit_periods
-- WHERE tenant_id=$1 AND organization_id=$2 AND period_id=$3" (the gateway's
-- period check, allocatePeriod, reserve). INSERT: savePeriod(), "INSERT INTO
-- control_plane.credit_periods(...) VALUES (...)" (allocatePeriod).
GRANT SELECT, INSERT ON control_plane.credit_periods TO cp_funding;
-- funded_jobs. SELECT: job(), "SELECT * FROM control_plane.funded_jobs WHERE
-- tenant_id=$1 AND root_job_id=$2 FOR UPDATE" (openJob, reserve). INSERT:
-- saveJob(), "INSERT INTO control_plane.funded_jobs(...)" (openJob). UPDATE on
-- three columns: saveJob()'s "ON CONFLICT (tenant_id,root_job_id) DO UPDATE SET
-- cap_micro_usd=...,cap_generation=...,state=...". It also satisfies job()'s
-- FOR UPDATE, which needs UPDATE on at least one column.
GRANT SELECT, INSERT ON control_plane.funded_jobs TO cp_funding;
GRANT UPDATE (cap_micro_usd, cap_generation, state) ON control_plane.funded_jobs TO cp_funding;
-- funded_job_refs. SELECT: jobRef(), "SELECT * FROM control_plane.funded_job_refs
-- WHERE tenant_id=$1 AND run_ref=$2" (openJob). INSERT: saveJobRef(), "INSERT
-- INTO control_plane.funded_job_refs(tenant_id,run_ref,root_job_id)" (openJob).
GRANT SELECT, INSERT ON control_plane.funded_job_refs TO cp_funding;
-- funding_reservations. SELECT: attempt(), "SELECT ... FROM
-- control_plane.funding_reservations WHERE tenant_id=$1 AND reservation_id=$2
-- FOR UPDATE" (reserve, markDispatched, settle, releaseRefused, markUncertain,
-- GET /managed/v1/attempts/:id); the pending, uncertain and held sums in
-- periodTotals() and topUpTotals(), jobUsed() and companySpend() (reserve).
-- INSERT: saveAttempt(), "INSERT INTO control_plane.funding_reservations(...)"
-- (reserve). UPDATE on four columns: saveAttempt()'s "ON CONFLICT
-- (tenant_id,reservation_id) DO UPDATE SET state=...,dispatched_at=...,
-- resolved_at=...,uncertain_reason=..." (settle, releaseRefused, markUncertain),
-- and claimDispatch(), "UPDATE control_plane.funding_reservations SET
-- dispatched_at=$3 WHERE tenant_id=$1 AND reservation_id=$2 AND state='pending'
-- AND dispatched_at IS NULL" (markDispatched). Also attempt()'s FOR UPDATE. No
-- amount, route, rate or period column can be rewritten.
GRANT SELECT, INSERT ON control_plane.funding_reservations TO cp_funding;
GRANT UPDATE (state, dispatched_at, resolved_at, uncertain_reason) ON control_plane.funding_reservations TO cp_funding;
-- funding_settlements. SELECT: settlement(), "SELECT ... FROM
-- control_plane.funding_settlements WHERE tenant_id=$1 AND reservation_id=$2"
-- (settle, GET /managed/v1/attempts/:id); the settled sums in periodTotals() and
-- topUpTotals(), jobUsed()'s join and companySpend() (reserve). INSERT:
-- saveSettlement(), "INSERT INTO control_plane.funding_settlements(...)" (settle).
-- Never UPDATE: a settlement is written once.
GRANT SELECT, INSERT ON control_plane.funding_settlements TO cp_funding;
-- credit_adjustments and credit_topups: SELECT only, for the correction sums in
-- periodTotals() and the purchased sum in topUpTotals() (reserve).
GRANT SELECT ON control_plane.credit_adjustments, control_plane.credit_topups TO cp_funding;
-- Not granted, because the gateway never runs them: job_cap_requests (cap
-- requests and decisions), INSERT on credit_adjustments (recordCorrection) and on
-- credit_topups (recordTopUp), and funding_accounts. Staff grant allocation and
-- staff funding corrections run on the Worker login and are still refused there.
