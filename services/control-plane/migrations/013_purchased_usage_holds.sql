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
-- A hold is a lease (Andrew, 2026-10-01: a stale hold releases on its own "as long as its accurate").
-- Only the person holding it knows whether the work is still running, so the holder renews it:
-- lease_until is stamped from the service's own clock when the hold is made and moved forward only by
-- a renewal. A held row whose lease has lapsed stops counting as held and is moved to released by the
-- next write or read under the organization lock, with released_by='expiry' (a person's own release
-- is released_by='person'). If the work finishes after that, a late settle moves an expiry-released hold
-- to settled and clears released_by, and records against the business only what is free to hold at that
-- moment (never more than the debit given or the amount held), so the bought balance never goes below
-- zero. The rest of what was asked is covered by Diomedes and kept internally in absorbed_micro_usd: it
-- is never part of the top-up balance and appears in no customer answer. A settle on a live hold records
-- the debit as given and absorbs nothing. Debit plus absorbed is what the holder asked to settle, which
-- is what a replay of the same settlement is compared with. A hold the person released cannot be settled.
-- No job runs a sweep; nothing here is timed by the database.
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
  absorbed_micro_usd bigint NOT NULL DEFAULT 0 CHECK (absorbed_micro_usd >= 0),
  state text NOT NULL CHECK (state IN ('held','settled','released')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  lease_until timestamptz NOT NULL,
  released_by text,
  PRIMARY KEY (tenant_id,hold_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (debit_micro_usd + absorbed_micro_usd <= amount_micro_usd),
  CHECK ((state = 'held') = (resolved_at IS NULL)),
  CHECK (state = 'settled' OR debit_micro_usd = 0),
  CHECK (released_by IN ('person','expiry')),
  CHECK ((state = 'released') = (released_by IS NOT NULL))
);
CREATE INDEX credit_topup_holds_organization_state ON control_plane.credit_topup_holds(tenant_id,organization_id,state);
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
