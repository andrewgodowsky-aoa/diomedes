-- DIO-128: only a complete Individual offer funds automatic monthly credits.
-- The complete legacy four-feature template remains eligible; the current five-feature
-- superset is eligible too. Agent plus managed inference, or any missing legacy feature,
-- is a limited override and cannot authorize a fresh included-credit allocation.
--
-- Additive function replacement after the accepted 013, 014 and 015 migrations.
-- The migration manifest contains the actual contiguous 001..016 sequence.
-- Never rewrite applied 001..015, relax history hashes or skip a version.
-- No historical grant, billing term, credit, hold, settlement, purchase or agreement
-- is rewritten or reclaimed. Existing balances and late settlements are preserved.
-- The 012 owner, security-definer/search-path settings, grant/account locks, identity,
-- state/date/amount checks, verified term bounds, overlap protection and ACL remain.
-- Source and local disposable qualification only; no production migration authorized.

CREATE OR REPLACE FUNCTION control_plane.check_individual_period_source() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control_plane AS $$
DECLARE
  term jsonb;
BEGIN
  IF NEW.source_person_grant_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT g.record->'billingCycle' INTO term FROM control_plane.person_feature_grants g
    JOIN control_plane.billing_scopes b ON b.person_id=g.person_id AND b.tenant_id=g.tenant_id
    WHERE g.tenant_id=NEW.tenant_id AND g.grant_id=NEW.source_person_grant_id
      AND b.kind='individual' AND b.id=NEW.organization_id AND b.record->>'state'='active'
      AND g.record->>'planId'='individual' AND g.record->>'state'='active'
      AND g.record->>'revokedAt' IS NULL
      AND (g.record->>'validFrom')::timestamptz <= NEW.allocated_at
      AND (g.record->>'validUntil')::timestamptz > NEW.allocated_at
      AND g.record->'features' ?& ARRAY['nectovia-agent','maintained-profiles','owner-rules','phone-relay']
    FOR SHARE OF g,b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Individual funding requires a current person grant on its own billing scope' USING ERRCODE='23514';
  END IF;
  IF NEW.granted_micro_usd <> 100000000 THEN
    RAISE EXCEPTION 'Individual funding is exactly 1000 credits' USING ERRCODE='23514';
  END IF;

  IF NEW.period_id LIKE 'individual:%' THEN
    -- Exactly the verified term its source grant names, recorded during that term.
    -- IS DISTINCT FROM throughout, so a missing field refuses rather than reading as NULL.
    IF term IS NULL OR jsonb_typeof(term) IS DISTINCT FROM 'object' OR term->>'policy' IS DISTINCT FROM 'subscription-month-v1'
      OR jsonb_typeof(term->'index') IS DISTINCT FROM 'number' OR jsonb_typeof(term->'anchorAt') IS DISTINCT FROM 'string'
      OR (term->>'startsAt')::timestamptz IS DISTINCT FROM NEW.starts_at OR (term->>'endsAt')::timestamptz IS DISTINCT FROM NEW.ends_at
      OR control_plane.individual_period_boundary((term->>'anchorAt')::timestamptz, (term->>'index')::integer) IS DISTINCT FROM NEW.starts_at
      OR control_plane.individual_period_boundary((term->>'anchorAt')::timestamptz, (term->>'index')::integer + 1) IS DISTINCT FROM NEW.ends_at
      OR NEW.period_id IS DISTINCT FROM 'individual:' || to_char(NEW.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR NEW.allocated_at < NEW.starts_at OR NEW.allocated_at >= NEW.ends_at THEN
      RAISE EXCEPTION 'Individual funding is exactly the verified billing period its grant names' USING ERRCODE='23514';
    END IF;
    -- One term funds any moment. Serialized on the ledger's own billing-scope lock.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('["funding",%s,%s]', to_json(NEW.tenant_id)::text, to_json(NEW.organization_id)::text), 0));
    IF EXISTS (SELECT 1 FROM control_plane.credit_periods p
        WHERE p.tenant_id=NEW.tenant_id AND p.organization_id=NEW.organization_id
          AND p.period_id LIKE 'individual:%' AND p.period_id<>NEW.period_id
          AND p.starts_at < NEW.ends_at AND NEW.starts_at < p.ends_at) THEN
      RAISE EXCEPTION 'Individual billing periods may not overlap' USING ERRCODE='23514';
    END IF;
  ELSE
    -- 011's calendar month, kept for grants issued before monthly terms only.
    IF term IS NOT NULL
      OR NEW.period_id <> to_char(NEW.allocated_at AT TIME ZONE 'UTC','YYYY-MM')
      OR NEW.starts_at <> date_trunc('month',NEW.allocated_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      OR NEW.ends_at <> (date_trunc('month',NEW.allocated_at AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC' THEN
      RAISE EXCEPTION 'Individual funding is exactly 1000 credits for the current UTC month' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_plane.check_individual_period_source() FROM PUBLIC;
