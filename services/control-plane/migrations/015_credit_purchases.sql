-- Credit purchases (2026-10-01, DIO-161 slice 1): an owner or admin buys more credits for their business
-- through Stripe Checkout. This table is the row a purchase lives in from the moment it is asked for until
-- Stripe says what happened to it. Code and tests only: no production migration is authorized by this file.
--
-- Credits are bought in whole steps of 100. The amount charged is fixed when the purchase is created, from
-- the Worker's price setting, and is kept here in cents. The credits granted are kept in the top-up row
-- (credit_topups, in micro-USD) the paid event records; the two join by purchase id, because the top-up's id
-- is the purchase id. A purchase is paid only by a verified Stripe event that names this purchase's own
-- checkout session and carries this row's own amount, and a top-up is recorded in that same transaction.
--
-- This migration is additive only: one table and one index. It drops and alters nothing, and in particular it
-- keeps the reference from a top-up to the webhook inbox (003: credit_topups.source_event_id references
-- webhook_inbox, whose rows reference billing_customers, 002). A top-up can therefore exist only for a verified
-- Stripe event stored in the inbox. The inbox row and the business's one Stripe customer are written first, by the
-- Worker's login (cp_runtime) on the verified paid event; the funding login (cp_funding) then marks the purchase
-- paid and records the top-up that names that event, and has no privilege on the inbox or the customers, so it
-- cannot make bought credits on its own. The verified event id is also kept on the purchase row (stripe_event_id,
-- unique), so one event can pay one purchase.
--
-- The credits check is a sanity bound, looser than the code's cap on purpose: the cap
-- (shared/credit-purchases.ts) can be raised without a migration, and the amount check
-- (99999999 cents, the most one card charge can be) is the one that has to hold.
--
-- Apply after 011, 012, 013 and 014. The migration runner takes each version from the file name's number.

CREATE TABLE control_plane.credit_purchases (
  tenant_id text NOT NULL,
  purchase_id text NOT NULL CHECK (purchase_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  organization_id text NOT NULL,
  person_id text NOT NULL REFERENCES control_plane.persons(id),
  credits integer NOT NULL CHECK (credits BETWEEN 100 AND 1000000 AND credits % 100 = 0),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999),
  currency text NOT NULL CHECK (currency = 'usd'),
  stripe_checkout_session_id text UNIQUE CHECK (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  state text NOT NULL CHECK (state IN ('pending','paid','expired','failed')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  stripe_event_id text UNIQUE CHECK (stripe_event_id IS NULL OR stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,128}$'),
  PRIMARY KEY (tenant_id,purchase_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK ((state = 'pending') = (resolved_at IS NULL)),
  CHECK (state <> 'pending' OR stripe_event_id IS NULL),
  CHECK (state <> 'paid' OR (stripe_event_id IS NOT NULL AND stripe_checkout_session_id IS NOT NULL))
);
CREATE INDEX credit_purchases_organization ON control_plane.credit_purchases(tenant_id,organization_id,created_at);

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
