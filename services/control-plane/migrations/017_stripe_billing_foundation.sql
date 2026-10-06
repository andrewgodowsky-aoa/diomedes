-- Stripe billing foundation (2026-10-05, slice 1): the schema the test and live guard, the inbox state, the event
-- router, the credit rates and the billing system actor stand on. Code and tests only: no production migration is
-- authorized by this file, and it is applied to accounts_staging with main's runner before the code that needs it merges.
--
-- NUMBERING. This is 017 because draft #196 holds 016. The runner (src/migrations.ts) takes each version from the file
-- name's number and refuses a list that is not 1..n with no gap, and refuses a history that is not a prefix of the list. So
-- 017 cannot be applied to any database until 016 is in the list before it, and a database that applied 017 first could never
-- accept 016 afterwards. Listing 017 without 016 would make the runner refuse the whole list, so scripts/migrate.ts does not
-- list it yet. Whichever of the two merges second adds its entry there, 016 before 017.
--
-- 1. ENVIRONMENT. billing_customers, webhook_inbox and credit_purchases each gain `environment` ('test' or 'live'). Every
-- existing row is a test row (nothing live has ever run), so the column is added NOT NULL DEFAULT 'test', which backfills
-- them. The default stays so a writer that predates the column (PostgresRepository.recordVerifiedWebhook, which has no
-- caller) still writes a test row; every writer in this slice names the environment. The one unique that has to differ by
-- environment is a business's customer: it may have one test customer and one live one, so UNIQUE (provider, organization_id)
-- becomes UNIQUE (provider, environment, organization_id). Customer, event and session ids stay unique on their own (Stripe's
-- ids do not repeat between modes) because credit_topups and entitlement_grants reference the inbox by event id and have no
-- environment column.
--
-- 2. INBOX STATE. An event is stored before it is applied and then marked. 'ignored' joins the states: an event of a type
-- nothing handles is stored and marked ignored. Such an event may name no business we know (a product event, say), so the
-- customer, business and tenant columns may be null, all three or none (a composite foreign key is not checked when a column
-- is null, and credit_topups can still reference only a row that has all three). The existing rule that a row has processed_at
-- exactly when it is 'processed' is kept, so a quarantined or ignored row keeps a null processed_at.
--
-- 3. CREDIT RATES. credit_purchases stores the rate the server chose at quote time: rate_credits credits for rate_cents cents,
-- per step. The credits, the rate and the amount are tied by a check, so a row cannot say it bought credits at a price it was
-- not charged. 015 priced every row as whole steps of 100 credits, so its rows backfill to rate_credits = 100 and
-- rate_cents = amount_cents / (credits / 100), which is exact. 015's check that credits are a multiple of 100 goes, since a
-- plan's step need not be 100 credits.
--
-- 4. THE BILLING SYSTEM ACTOR. ops_audit.actor_person_id references persons, and feature_grants records name who issued them,
-- so the reserved actor src/billing-system.ts names gets one persons row. It has no external subject, membership or operators
-- row, so nothing can sign in as it.

ALTER TABLE control_plane.billing_customers ADD COLUMN environment text NOT NULL DEFAULT 'test' CHECK (environment IN ('test','live'));
ALTER TABLE control_plane.webhook_inbox ADD COLUMN environment text NOT NULL DEFAULT 'test' CHECK (environment IN ('test','live'));
ALTER TABLE control_plane.credit_purchases ADD COLUMN environment text NOT NULL DEFAULT 'test' CHECK (environment IN ('test','live'));

-- The business's one customer is now one per environment. The old unique is found by its columns, not its generated name.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'control_plane.billing_customers'::regclass AND c.contype = 'u'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey))
        = ARRAY['organization_id','provider']::text[]
  LOOP
    EXECUTE format('ALTER TABLE control_plane.billing_customers DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;
ALTER TABLE control_plane.billing_customers ADD CONSTRAINT billing_customers_environment_organization_key UNIQUE (provider, environment, organization_id);

-- The inbox: an event may be stored without a business, and 'ignored' is a state.
ALTER TABLE control_plane.webhook_inbox ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE control_plane.webhook_inbox ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE control_plane.webhook_inbox ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE control_plane.webhook_inbox ADD CONSTRAINT webhook_inbox_attribution_whole
  CHECK ((customer_id IS NULL) = (organization_id IS NULL) AND (customer_id IS NULL) = (tenant_id IS NULL));
-- 002's state check is found by what it says, not its generated name.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'control_plane.webhook_inbox'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%quarantined%'
  LOOP
    EXECUTE format('ALTER TABLE control_plane.webhook_inbox DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;
ALTER TABLE control_plane.webhook_inbox ADD CONSTRAINT webhook_inbox_state_check CHECK (state IN ('pending','processed','quarantined','ignored'));

-- The rate each purchase was priced at.
ALTER TABLE control_plane.credit_purchases ADD COLUMN rate_cents integer;
ALTER TABLE control_plane.credit_purchases ADD COLUMN rate_credits integer;
UPDATE control_plane.credit_purchases SET rate_credits = 100, rate_cents = (amount_cents / (credits / 100))::integer;
ALTER TABLE control_plane.credit_purchases ALTER COLUMN rate_cents SET NOT NULL;
ALTER TABLE control_plane.credit_purchases ALTER COLUMN rate_credits SET NOT NULL;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'control_plane.credit_purchases'::regclass AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%credits%' AND pg_get_constraintdef(c.oid) LIKE '%100%' AND pg_get_constraintdef(c.oid) NOT LIKE '%rate_%'
  LOOP
    EXECUTE format('ALTER TABLE control_plane.credit_purchases DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;
ALTER TABLE control_plane.credit_purchases ADD CONSTRAINT credit_purchases_credits_range CHECK (credits BETWEEN 1 AND 1000000);
ALTER TABLE control_plane.credit_purchases ADD CONSTRAINT credit_purchases_rate_positive CHECK (rate_cents BETWEEN 1 AND 99999999 AND rate_credits BETWEEN 1 AND 1000000);
ALTER TABLE control_plane.credit_purchases ADD CONSTRAINT credit_purchases_rate_whole_steps
  CHECK (credits % rate_credits = 0 AND amount_cents = (credits / rate_credits)::bigint * rate_cents);

-- The billing system actor.
INSERT INTO control_plane.persons(id, record)
  VALUES ('billing-system', '{"v":1,"id":"billing-system","name":"Billing system","assurance":"hosted","createdAt":"2026-10-05T00:00:00.000Z"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
