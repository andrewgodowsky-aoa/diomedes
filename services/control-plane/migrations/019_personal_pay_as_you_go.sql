-- Personal pay as you go (2026-10-05, DIO-219, lane C of Model B): a person buys credits for their own Personal work, and the
-- Nectovia Agent works for them there while their own bought balance is above zero. Code and tests only: no production migration
-- is authorized by this file, and it is applied to accounts_staging with main's runner before the code that needs it merges.
--
-- NUMBERING. Reserved as 019 (016 is draft #196, 017 is slice 1, 018 is lane B). The runner refuses a gap in its list and a history
-- that is not a prefix of it, so scripts/migrate.ts does not list this file yet; numbers are assigned at merge, in merge order.
-- Apply after 017.
--
-- 1. A PERSON AS THE PAYER. A person's own billing scope is their Individual billing scope (010: kind 'individual', id
-- 'individual_...', tenant_id = person_id). 015 still points credit_purchases at organizations, from before 010 moved the other
-- ledger tables to billing_scopes, so a purchase for a person's scope could not be stored. It now points at billing_scopes, like
-- credit_topups and billing_customers already do. A purchase for an Individual scope is always bought by that scope's own person:
-- a business never pays for personal work, and nobody buys into another person's scope.
--
-- 2. A STRIPE CUSTOMER MAPPED TO A PERSON, ONE PER ENVIRONMENT. billing_customers gains person_id, generated from the row itself
-- (the scope's tenant, which is its person, when the scope is an Individual one; null for a business), so no writer names it and
-- the receiver's INSERT statements do not change. A composite reference to billing_scopes(id, tenant_id, person_id) proves the
-- person is the scope's own, and a partial unique index keeps one customer per person in each environment.
--
-- 3. BOUGHT CREDITS WITH NO BILLING PERIOD. Every reservation names a credit_periods row (003). A person with no plan has no
-- billing period, so a reservation for them draws on bought credits only and binds to the scope's one bought-credits row:
-- plan_id 'bought-credits', period_id 'bought-credits', granted 0, no source grant. It never funds anything itself (granted is
-- always 0), it never ends inside the life of the product, and only an Individual scope may have one, so a business without a
-- plan is never funded this way. 011's source check and 012's period id shape are widened for exactly this row. The funding
-- login already holds INSERT on credit_periods, so no grant changes.

-- 1. The payer of a purchase is a billing scope.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'control_plane.credit_purchases'::regclass AND c.contype = 'f'
      AND c.confrelid = 'control_plane.organizations'::regclass
  LOOP
    EXECUTE format('ALTER TABLE control_plane.credit_purchases DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;
ALTER TABLE control_plane.credit_purchases ADD CONSTRAINT credit_purchases_payer_scope
  FOREIGN KEY (organization_id, tenant_id) REFERENCES control_plane.billing_scopes(id, tenant_id);
ALTER TABLE control_plane.credit_purchases ADD CONSTRAINT credit_purchases_person_buys_own_scope
  CHECK (organization_id NOT LIKE 'individual\_%' OR person_id = tenant_id);

-- 2. A person's Stripe customer.
ALTER TABLE control_plane.billing_scopes ADD CONSTRAINT billing_scopes_person_key UNIQUE (id, tenant_id, person_id);
ALTER TABLE control_plane.billing_customers ADD COLUMN person_id text
  GENERATED ALWAYS AS (CASE WHEN organization_id LIKE 'individual\_%' THEN tenant_id END) STORED;
ALTER TABLE control_plane.billing_customers ADD CONSTRAINT billing_customers_person_scope
  FOREIGN KEY (organization_id, tenant_id, person_id) REFERENCES control_plane.billing_scopes(id, tenant_id, person_id);
CREATE UNIQUE INDEX billing_customers_person_environment ON control_plane.billing_customers(provider, environment, person_id)
  WHERE person_id IS NOT NULL;

-- 3. The bought-credits row.
ALTER TABLE control_plane.credit_periods DROP CONSTRAINT credit_periods_period_id_shape;
ALTER TABLE control_plane.credit_periods ADD CONSTRAINT credit_periods_period_id_shape CHECK (
  period_id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  OR (plan_id='individual' AND period_id ~ '^individual:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
  OR (plan_id='bought-credits' AND period_id='bought-credits')
);
ALTER TABLE control_plane.credit_periods DROP CONSTRAINT credit_periods_source_kind;
ALTER TABLE control_plane.credit_periods ADD CONSTRAINT credit_periods_source_kind CHECK (
  (plan_id='individual' AND source_person_grant_id IS NOT NULL AND source_grant_id IS NULL)
  OR (plan_id='bought-credits' AND source_person_grant_id IS NULL AND source_grant_id IS NULL)
  OR (plan_id NOT IN ('individual','bought-credits') AND source_person_grant_id IS NULL AND source_grant_id IS NOT NULL)
);
ALTER TABLE control_plane.credit_periods ADD CONSTRAINT credit_periods_bought_credits_row CHECK (
  plan_id<>'bought-credits' OR (granted_micro_usd=0 AND organization_id LIKE 'individual\_%')
);

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
