-- REVIEW TEMPLATE ONLY. Run as the schema owner on an approved isolated DB.
-- Provision the login cp_funding and its secret separately; this creates no role.
-- Grant no ownership, CREATE, DELETE, TRUNCATE or credential-table access.
-- cp_funding is the managed gateway's funding login (FUNDING_DATABASE_URL), the
-- separately reviewed role runtime-permissions.sql leaves funding writes to. It
-- may run exactly what PostgresFundingRepository (src/funding-postgres.ts)
-- executes on the gateway's paths in src/managed-inference.ts: FundingService
-- openJob, allocatePeriod (the month's credit, on the first call that needs it),
-- reserve, markDispatched, settle, releaseRefused and markUncertain, and the
-- direct reads period, attempt and settlement. It also runs the purchased-usage
-- holds (013) and the credit purchases (015: src/credit-purchases.ts, and the
-- top-up a verified payment records). tests/funding-permissions.test.ts
-- replays those paths and fails when this list and that SQL differ either way.
-- A top-up references webhook_inbox (003), checked as the table owner, so the
-- verified event it names is stored first, on the Worker login (runtime-permissions.sql),
-- and this login is granted neither webhook_inbox nor billing_customers: it cannot
-- make bought credits without an event the receiver stored.
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
-- 019 pay as you go (DIO-219): when no billing period funds a person's own Personal work, reserve writes the
-- scope's one bought-credits row (plan_id and period_id 'bought-credits', granted 0, no source) with this same
-- savePeriod() INSERT, and the gateway reads the person's bought balance with topUpTotals()'s SELECTs below.
-- No grant changes.
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
-- 013 credit_topup_holds: the holds a person asked for against credits their business bought
-- outright (POST /account/organizations/:id/purchased-usage/holds, /settlements, /releases and /renewals,
-- src/funding.ts PurchasedUsageService, and the held and settled sums every reserve reads in topUpTotals()).
-- SELECT: topUpHold(), "SELECT * FROM control_plane.credit_topup_holds WHERE tenant_id=$1 AND hold_id=$2 FOR UPDATE",
-- and the two sums in topUpTotals(). INSERT: saveTopUpHold(). UPDATE on six columns: its "ON CONFLICT
-- (tenant_id,hold_id) DO UPDATE SET debit_micro_usd=...,absorbed_micro_usd=...,state=...,resolved_at=...,lease_until=...,
-- released_by=..." (settle, late settle, release, renew), expireTopUpHolds()'s "UPDATE ... SET state='released',released_by='expiry',
-- resolved_at=$3 WHERE ... state='held' AND lease_until <= $3" (the lazy release of a lapsed lease, run under the
-- organization lock by every purchased-hold read and write), and topUpHold()'s FOR UPDATE. No amount, person,
-- digest, organization or creation-time column can be rewritten, and lease_until is only ever moved by a renewal.
GRANT SELECT, INSERT ON control_plane.credit_topup_holds TO cp_funding;
GRANT UPDATE (debit_micro_usd, absorbed_micro_usd, state, resolved_at, lease_until, released_by) ON control_plane.credit_topup_holds TO cp_funding;
-- 014 credit_attempt_people: which person each funded attempt was reserved for. INSERT: saveAttemptPerson(),
-- "INSERT INTO control_plane.credit_attempt_people(...)" (reserve, for a member's attempt). SELECT: the join in
-- memberUsage() that every limited member's reserve reads. Written once; never UPDATE.
GRANT SELECT, INSERT ON control_plane.credit_attempt_people TO cp_funding;
-- 014 credit_member_limits: the monthly limits an owner or admin set, for a role or one person
-- (POST /account/organizations/:id/credit-limits, src/member-limits.ts MemberLimits). SELECT: memberLimits(),
-- "SELECT * FROM control_plane.credit_member_limits WHERE tenant_id=$1 AND organization_id=$2 ...", which reserve
-- reads for every member. INSERT: saveMemberLimit(). UPDATE on four columns: its "ON CONFLICT
-- (tenant_id,organization_id,subject_kind,subject_id) DO UPDATE SET mode=...,limit_micro_usd=...,updated_by=...,
-- updated_at=...". No subject column can be rewritten.
GRANT SELECT, INSERT ON control_plane.credit_member_limits TO cp_funding;
GRANT UPDATE (mode, limit_micro_usd, updated_by, updated_at) ON control_plane.credit_member_limits TO cp_funding;
-- 014 credit_allotment_settings: who sees what, per business (POST .../credit-limits/settings). SELECT:
-- allotmentSettings(). INSERT and UPDATE on four columns: saveAllotmentSettings(), "ON CONFLICT
-- (tenant_id,organization_id) DO UPDATE SET members_see_own_usage=...,admins_see_member_usage=...,updated_by=...,updated_at=...".
GRANT SELECT, INSERT ON control_plane.credit_allotment_settings TO cp_funding;
GRANT UPDATE (members_see_own_usage, admins_see_member_usage, updated_by, updated_at) ON control_plane.credit_allotment_settings TO cp_funding;
-- 014 credit_limit_requests: a member's ask for more, and an owner's or admin's answer
-- (POST .../credit-limit-requests and .../decision). SELECT: limitRequest(), limitRequests(), and
-- approvedAllowances(), which reserve reads for every limited member. INSERT: saveLimitRequest(). UPDATE on six
-- columns: its "ON CONFLICT (tenant_id,request_id) DO UPDATE SET state=...,decided_by=...,decided_at=...,
-- extra_micro_usd=...,allow_purchased=...,period_id=..." (the decision). The member, kind, job and time asked
-- can't be rewritten.
GRANT SELECT, INSERT ON control_plane.credit_limit_requests TO cp_funding;
GRANT UPDATE (state, decided_by, decided_at, extra_micro_usd, allow_purchased, period_id) ON control_plane.credit_limit_requests TO cp_funding;
-- 015 credit_purchases: a purchase of credits through Stripe Checkout, from the pending row an owner or an admin
-- asks for (POST /account/organizations/:id/credit-purchases, src/credit-purchases.ts CreditPurchaseService) to the
-- verified Stripe event that pays, expires or fails it (POST /billing/stripe/webhook, StripeWebhookService), all
-- through FundingService startCreditPurchase, attachCheckoutSession, failCreditPurchase, readCreditPurchase and
-- resolveCreditPurchase. SELECT: creditPurchase(), "SELECT * FROM control_plane.credit_purchases WHERE tenant_id=$1
-- AND purchase_id=$2 FOR UPDATE", and creditPurchaseBySession(), "... WHERE stripe_checkout_session_id=$1". INSERT:
-- saveCreditPurchase(). UPDATE on four columns: its "ON CONFLICT (tenant_id,purchase_id) DO UPDATE SET
-- stripe_checkout_session_id=...,state=...,resolved_at=...,stripe_event_id=..." (the session Stripe made, then
-- paid, expired or failed), and creditPurchase()'s FOR UPDATE. No amount, credit count, person, business or
-- creation-time column can be rewritten.
GRANT SELECT, INSERT ON control_plane.credit_purchases TO cp_funding;
GRANT UPDATE (stripe_checkout_session_id, state, resolved_at, stripe_event_id) ON control_plane.credit_purchases TO cp_funding;
-- 019: a person's purchase for their own Individual billing scope (POST /account/credit-purchases) runs the same
-- statements; its row names that scope and its tenant, the person. No grant changes.
-- 009 Individual agreements allocate the same credit_periods through the
-- existing funding writer. Scope, consent, routing and staff records remain
-- on cp_runtime; foreign-key checks need no extra cp_funding table grants.
-- credit_adjustments: SELECT only, for the correction sums in periodTotals() (reserve).
GRANT SELECT ON control_plane.credit_adjustments TO cp_funding;
-- credit_topups. SELECT: topUp(), "SELECT * FROM control_plane.credit_topups WHERE tenant_id=$1 AND topup_id=$2"
-- (resolveCreditPurchase, through recordTopUpWithin), and the purchased sum in topUpTotals() (reserve). INSERT:
-- saveTopUp(), "INSERT INTO control_plane.credit_topups(...)" (resolveCreditPurchase: the credits a verified payment
-- bought, with the purchase's id as the top-up's own). Never UPDATE: a top-up is written once.
GRANT SELECT, INSERT ON control_plane.credit_topups TO cp_funding;
-- Not granted, because nothing on this login runs them: job_cap_requests (cap
-- requests and decisions), INSERT on credit_adjustments (recordCorrection), and
-- funding_accounts. Staff grant allocation and staff funding corrections run on
-- the Worker login and are still refused there.
