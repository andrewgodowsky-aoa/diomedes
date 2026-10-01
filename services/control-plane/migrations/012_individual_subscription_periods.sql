-- DIO-128: Individual billing periods are subscription-anniversary months in UTC.
-- Apply as migration owner after 011. Migrations 001-011 and every existing row
-- are preserved: historical YYYY-MM periods keep their ids, amounts, sources,
-- reservations and settlements. No period is allocated, repriced or rewritten.
--
-- A new Individual term is one row with period id 'individual:<UTC start>',
-- funded by exactly the person grant whose record names that term
-- (record->'billingCycle'). Its bounds are the anchor plus whole months, which
-- PostgreSQL's month arithmetic clamps to a shorter month's end exactly as
-- shared/individual-period.ts does.

-- Historical calendar months remain valid ids. Only an Individual row may use
-- the term form; the trigger below checks that the id names its own start.
ALTER TABLE control_plane.credit_periods DROP CONSTRAINT credit_periods_period_id_check;
ALTER TABLE control_plane.credit_periods ADD CONSTRAINT credit_periods_period_id_shape CHECK (
  period_id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  OR (plan_id='individual' AND period_id ~ '^individual:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
);

-- The boundary `months` whole months after a subscription's anchor, in UTC.
CREATE FUNCTION control_plane.individual_period_boundary(anchor timestamptz, offset_months integer) RETURNS timestamptz
  LANGUAGE sql STABLE STRICT SET search_path=pg_catalog AS $$
  SELECT ((anchor AT TIME ZONE 'UTC') + make_interval(months => offset_months)) AT TIME ZONE 'UTC'
$$;
REVOKE ALL ON FUNCTION control_plane.individual_period_boundary(timestamptz,integer) FROM PUBLIC;

-- Supersedes 011's calendar-only validation. The same narrowly scoped reader:
-- it locks the authorizing grant and billing account against concurrent
-- revocation, and neither issues grants nor changes access.
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
      AND g.record->'features' ? 'nectovia-agent'
      AND (g.record->'features' ? 'managed-inference'
        OR g.record->'features' ?& ARRAY['nectovia-agent','maintained-profiles','owner-rules','phone-relay'])
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

-- New holds bind to the Individual period they were reserved in, and are never
-- sent after it ends. Once a monthly term covers a moment, a calendar row on the
-- same account funds no new hold. Re-saving an existing reservation (release,
-- settlement, reconciliation) is never blocked, so late settlement still lands
-- on its original payer and period under 011's foreign key.
CREATE FUNCTION control_plane.check_individual_reservation_period() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog,control_plane AS $$
DECLARE
  funded record;
BEGIN
  IF TG_OP='INSERT' AND EXISTS (SELECT 1 FROM control_plane.funding_reservations r
      WHERE r.tenant_id=NEW.tenant_id AND r.reservation_id=NEW.reservation_id) THEN
    RETURN NEW;
  END IF;
  SELECT p.plan_id, p.period_id, p.starts_at, p.ends_at INTO funded FROM control_plane.credit_periods p
    WHERE p.tenant_id=NEW.tenant_id AND p.organization_id=NEW.organization_id AND p.period_id=NEW.period_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF funded.plan_id NOT IN ('individual','individual-agreement') THEN
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF funded.period_id LIKE 'individual:%' THEN
      IF NEW.created_at < funded.starts_at OR NEW.created_at >= funded.ends_at THEN
        RAISE EXCEPTION 'An Individual hold binds to the billing period it is reserved in' USING ERRCODE='23514';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM control_plane.credit_periods c
        WHERE c.tenant_id=NEW.tenant_id AND c.organization_id=NEW.organization_id AND c.period_id LIKE 'individual:%'
          AND c.starts_at <= NEW.created_at AND NEW.created_at < c.ends_at) THEN
      RAISE EXCEPTION 'A monthly Individual term funds this time; earlier funding is kept for settlement only' USING ERRCODE='23514';
    END IF;
    IF NEW.dispatched_at IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.dispatched_at IS NULL OR OLD.dispatched_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF funded.plan_id='individual' AND NEW.dispatched_at >= funded.ends_at THEN
    RAISE EXCEPTION 'An Individual hold is not sent after its billing period ends' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_plane.check_individual_reservation_period() FROM PUBLIC;
CREATE TRIGGER individual_reservation_period BEFORE INSERT OR UPDATE OF dispatched_at ON control_plane.funding_reservations
  FOR EACH ROW EXECUTE FUNCTION control_plane.check_individual_reservation_period();

-- Existing cp_runtime/cp_funding grants remain sufficient: the reservation
-- check reads only funding rows cp_funding already reads. No funding, identity,
-- consent, history or schema permission is widened by this migration.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
