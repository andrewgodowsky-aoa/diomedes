-- NC-2026-09-22.1 Phase C: funded parent-job accounting. This extends the 002
-- funding seams; it is code and tests only. No production migration, payment
-- request, grant writer route or model dispatch is authorized by this file.
-- Amounts are integer micro-USD. One credit is 100000 micro-USD.

-- One month's credit grant, bound to the verified entitlement grant it came from.
CREATE TABLE control_plane.credit_periods (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  period_id text NOT NULL CHECK (period_id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  plan_id text NOT NULL,
  rate_card_version text NOT NULL,
  granted_micro_usd bigint NOT NULL CHECK (granted_micro_usd BETWEEN 0 AND 9007199254740991),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source_grant_id text NOT NULL,
  allocated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,period_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  FOREIGN KEY (tenant_id,source_grant_id) REFERENCES control_plane.entitlement_grants(tenant_id,grant_id),
  CHECK (ends_at > starts_at)
);

-- A root job and its finite cap. Children and retries attach to the root.
CREATE TABLE control_plane.funded_jobs (
  tenant_id text NOT NULL,
  root_job_id text NOT NULL,
  organization_id text NOT NULL,
  run_ref text NOT NULL,
  cap_micro_usd bigint NOT NULL CHECK (cap_micro_usd BETWEEN 1 AND 9007199254740991),
  cap_generation integer NOT NULL CHECK (cap_generation >= 0),
  state text NOT NULL CHECK (state IN ('open','closed')),
  opened_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,root_job_id),
  UNIQUE (tenant_id,root_job_id,organization_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id)
);
CREATE TABLE control_plane.funded_job_refs (
  tenant_id text NOT NULL,
  run_ref text NOT NULL,
  root_job_id text NOT NULL,
  PRIMARY KEY (tenant_id,run_ref),
  FOREIGN KEY (tenant_id,root_job_id) REFERENCES control_plane.funded_jobs(tenant_id,root_job_id)
);
CREATE TABLE control_plane.job_cap_requests (
  tenant_id text NOT NULL,
  request_id text NOT NULL,
  organization_id text NOT NULL,
  root_job_id text NOT NULL,
  requested_cap_micro_usd bigint NOT NULL CHECK (requested_cap_micro_usd BETWEEN 1 AND 9007199254740991),
  requested_by text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','approved','declined')),
  requested_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  PRIMARY KEY (tenant_id,request_id),
  FOREIGN KEY (tenant_id,root_job_id,organization_id) REFERENCES control_plane.funded_jobs(tenant_id,root_job_id,organization_id),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL))
);

-- Each funding reservation becomes one paid attempt under a root job, bound to
-- the period it was reserved in and the rate snapshot it is priced under.
-- These columns are NOT NULL: applying this to a table that already holds
-- 002-shaped rows fails loudly rather than inventing their job or period.
ALTER TABLE control_plane.funding_reservations
  ALTER COLUMN account_id DROP NOT NULL,
  ADD COLUMN organization_id text NOT NULL,
  ADD COLUMN root_job_id text NOT NULL,
  ADD COLUMN period_id text NOT NULL,
  ADD COLUMN kind text NOT NULL,
  ADD COLUMN route text NOT NULL,
  ADD COLUMN request_digest text NOT NULL,
  ADD COLUMN rate_snapshot jsonb NOT NULL,
  ADD COLUMN monthly_hold_micro_usd bigint NOT NULL CHECK (monthly_hold_micro_usd BETWEEN 0 AND 9007199254740991),
  ADD COLUMN topup_hold_micro_usd bigint NOT NULL CHECK (topup_hold_micro_usd BETWEEN 0 AND 9007199254740991),
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN uncertain_reason text,
  ADD CONSTRAINT funding_reservations_hold_split CHECK (monthly_hold_micro_usd + topup_hold_micro_usd = reserved_micro_usd),
  ADD CONSTRAINT funding_reservations_resolved CHECK ((state IN ('pending','uncertain')) = (resolved_at IS NULL)),
  ADD CONSTRAINT funding_reservations_period FOREIGN KEY (tenant_id,organization_id,period_id)
    REFERENCES control_plane.credit_periods(tenant_id,organization_id,period_id),
  ADD CONSTRAINT funding_reservations_job FOREIGN KEY (tenant_id,root_job_id,organization_id)
    REFERENCES control_plane.funded_jobs(tenant_id,root_job_id,organization_id);
CREATE INDEX funding_reservations_period_state ON control_plane.funding_reservations(tenant_id,organization_id,period_id,state);
CREATE INDEX funding_reservations_job ON control_plane.funding_reservations(tenant_id,root_job_id);

-- A settlement debits the period its reservation was made in.
ALTER TABLE control_plane.funding_settlements
  ADD COLUMN organization_id text NOT NULL,
  ADD COLUMN period_id text NOT NULL,
  ADD COLUMN monthly_debit_micro_usd bigint NOT NULL CHECK (monthly_debit_micro_usd BETWEEN 0 AND 9007199254740991),
  ADD COLUMN topup_debit_micro_usd bigint NOT NULL CHECK (topup_debit_micro_usd BETWEEN 0 AND 9007199254740991),
  ADD COLUMN usage jsonb NOT NULL,
  ADD COLUMN reconciled_from text NOT NULL CHECK (reconciled_from IN ('response','provider-report')),
  ADD CONSTRAINT funding_settlements_debit_split CHECK (monthly_debit_micro_usd + topup_debit_micro_usd = allowance_debit_micro_usd),
  ADD CONSTRAINT funding_settlements_period FOREIGN KEY (tenant_id,organization_id,period_id)
    REFERENCES control_plane.credit_periods(tenant_id,organization_id,period_id);
CREATE INDEX funding_settlements_period ON control_plane.funding_settlements(tenant_id,organization_id,period_id,settled_at);

-- Company-funded corrections and reconciliation withdrawals, as their own rows.
CREATE TABLE control_plane.credit_adjustments (
  tenant_id text NOT NULL,
  adjustment_id text NOT NULL,
  organization_id text NOT NULL,
  period_id text NOT NULL,
  reason text NOT NULL CHECK (reason = 'correction'),
  direction text NOT NULL CHECK (direction IN ('grant','withdraw')),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 9007199254740991),
  attempt_ref text,
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 500),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,adjustment_id),
  FOREIGN KEY (tenant_id,organization_id,period_id) REFERENCES control_plane.credit_periods(tenant_id,organization_id,period_id)
);

-- Purchased top-ups, separate from the monthly grant and never period-bound.
CREATE TABLE control_plane.credit_topups (
  tenant_id text NOT NULL,
  topup_id text NOT NULL,
  organization_id text NOT NULL,
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 9007199254740991),
  provider text NOT NULL CHECK (provider = 'stripe'),
  source_event_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,topup_id),
  UNIQUE (tenant_id,provider,source_event_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  FOREIGN KEY (tenant_id,provider,source_event_id) REFERENCES control_plane.webhook_inbox(tenant_id,provider,event_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
