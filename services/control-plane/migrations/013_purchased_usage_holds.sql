-- Purchased-usage holds (2026-10-01): credits a business bought outright (credit_topups), kept
-- aside for a person who asked to reserve them. Additive only: one new table, and nothing in 002
-- to 010 changes. Code and tests only: no production migration is authorized by this file.
--
-- This is not a funded attempt. It has no root job, no billing period and no rate, because
-- nothing is sent to a provider: a hold keeps bought credits aside, and is settled to a debit on
-- the top-up balance or released. It never draws on a month's included grant.
-- The top-up balance is credit_topups less these holds while held, less these debits once
-- settled, and less the funded attempts' top-up holds and debits (see topUpTotals).
-- Amounts are integer micro-USD.
--
-- Apply after 011 and 012. The migration runner takes each version from the file name's number,
-- so it refuses 013 until 011 and 012 are in the list before it.

CREATE TABLE control_plane.credit_topup_holds (
  tenant_id text NOT NULL,
  hold_id text NOT NULL,
  organization_id text NOT NULL,
  person_id text NOT NULL,
  request_digest text NOT NULL CHECK (char_length(request_digest) BETWEEN 1 AND 200),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 9007199254740991),
  debit_micro_usd bigint NOT NULL CHECK (debit_micro_usd BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('held','settled','released')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id,hold_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (debit_micro_usd <= amount_micro_usd),
  CHECK ((state = 'held') = (resolved_at IS NULL)),
  CHECK (state = 'settled' OR debit_micro_usd = 0)
);
CREATE INDEX credit_topup_holds_organization_state ON control_plane.credit_topup_holds(tenant_id,organization_id,state);
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
