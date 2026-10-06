-- Credit prices by tier (Model B, 2026-10-05). Code and tests only: no production migration is
-- authorized by this file, and no price is written by it.
--
-- A credit is priced by tier, never by route. credit_price_tables holds every version of the price
-- table Diomedes staff publish: each tier's charge in ledger units per million tokens (100,000 units
-- are one credit), and the ceiling (micro-USD of provider cost per credit charged) every route bound to
-- a tier must stay under. Versions are append-only: a change is a new version, and every call keeps the
-- version it was held under. The values live only in this table, never in the repository.
--
-- funding_reservations.charge_snapshot is the tier charge an attempt was held under. The hold and the
-- debit are priced from it; rate_snapshot keeps pricing the provider's cost, which the settlement keeps
-- recording in its existing provider_cost_micro_usd column beside allowance_debit_micro_usd. Attempts
-- reserved before this migration have a null charge_snapshot and settle at provider cost, as before.
-- The funding login's grants (scripts/funding-permissions.sql) need no change: INSERT on the table
-- covers the new column, and the column is not in its UPDATE list, so a charge is never rewritten.
--
-- Apply after 016 and 017: the migration runner takes each version from the file name's number and
-- refuses a gap.

CREATE TABLE control_plane.credit_price_tables (
  version bigint PRIMARY KEY CHECK (version >= 1),
  published_at timestamptz NOT NULL,
  published_by text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  CHECK ((record->>'version')::bigint = version),
  CHECK (record->>'publishedBy' = published_by),
  CHECK (record ?& ARRAY['v','version','ceilingMicroUsdPerCredit','tiers','note','publishedAt','publishedBy']),
  CHECK ((record->>'ceilingMicroUsdPerCredit')::bigint BETWEEN 1 AND 100000),
  CHECK (record->'tiers' ?& ARRAY['efficient','focused','thorough'])
);
CREATE FUNCTION control_plane.refuse_price_table_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published credit price tables are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER credit_price_table_append_only BEFORE UPDATE OR DELETE ON control_plane.credit_price_tables
  FOR EACH ROW EXECUTE FUNCTION control_plane.refuse_price_table_rewrite();

ALTER TABLE control_plane.funding_reservations
  ADD COLUMN charge_snapshot jsonb
    CHECK (charge_snapshot IS NULL OR (jsonb_typeof(charge_snapshot) = 'object'
      AND charge_snapshot ?& ARRAY['version','tier','tableVersion','ceilingMicroUsdPerCredit','inputMicroUsdPerMillion',
        'outputMicroUsdPerMillion','cacheReadMicroUsdPerMillion','cacheWriteMicroUsdPerMillion']
      AND charge_snapshot->>'tier' IN ('efficient','focused','thorough')));

REVOKE ALL ON control_plane.credit_price_tables FROM PUBLIC;
