-- DIO-128: use the existing ledger for the approved Individual monthly allowance.
-- Apply as migration owner after 010. No data is allocated, repriced or rewritten here.
-- The ledger's historical organization_id remains the immutable billing-scope id.

ALTER TABLE control_plane.credit_periods
  ALTER COLUMN source_grant_id DROP NOT NULL,
  ADD COLUMN source_person_grant_id text,
  ADD CONSTRAINT credit_periods_person_grant_fkey FOREIGN KEY (tenant_id,source_person_grant_id)
    REFERENCES control_plane.person_feature_grants(tenant_id,grant_id),
  ADD CONSTRAINT credit_periods_source_kind CHECK (
    (plan_id='individual' AND source_person_grant_id IS NOT NULL AND source_grant_id IS NULL)
    OR (plan_id<>'individual' AND source_person_grant_id IS NULL AND source_grant_id IS NOT NULL)
  );

-- Account-scoped agreements and Business grants must belong to the actual payer,
-- even when two scopes share a tenant. Retain the original source FK as well.
ALTER TABLE control_plane.feature_grants ADD CONSTRAINT feature_grants_scope_key
  UNIQUE(tenant_id,grant_id,organization_id);
ALTER TABLE control_plane.credit_periods ADD CONSTRAINT credit_periods_account_source_fkey
  FOREIGN KEY(tenant_id,source_grant_id,organization_id)
  REFERENCES control_plane.feature_grants(tenant_id,grant_id,organization_id);

-- cp_funding has no grant/identity privileges. This narrowly scoped trigger reads
-- the authoritative grant, locks it against concurrent revocation until commit,
-- and validates its billing identity. It neither issues grants nor changes access.
CREATE FUNCTION control_plane.check_individual_period_source() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control_plane AS $$
BEGIN
  IF NEW.source_person_grant_id IS NOT NULL THEN
    PERFORM 1 FROM control_plane.person_feature_grants g
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
    IF NEW.granted_micro_usd <> 100000000
      OR NEW.period_id <> to_char(NEW.allocated_at AT TIME ZONE 'UTC','YYYY-MM')
      OR NEW.starts_at <> date_trunc('month',NEW.allocated_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      OR NEW.ends_at <> (date_trunc('month',NEW.allocated_at AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC' THEN
      RAISE EXCEPTION 'Individual funding is exactly 1000 credits for the current UTC month' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_plane.check_individual_period_source() FROM PUBLIC;
CREATE TRIGGER individual_period_source BEFORE INSERT ON control_plane.credit_periods
  FOR EACH ROW EXECUTE FUNCTION control_plane.check_individual_period_source();

-- A settlement must retain both payer and period from its reservation. Merely
-- naming another valid period is insufficient. Existing rows are validated.
ALTER TABLE control_plane.funding_reservations ADD CONSTRAINT funding_reservation_payer_period_key
  UNIQUE(tenant_id,reservation_id,organization_id,period_id);
ALTER TABLE control_plane.funding_settlements ADD CONSTRAINT funding_settlement_original_payer_period
  FOREIGN KEY(tenant_id,reservation_id,organization_id,period_id)
  REFERENCES control_plane.funding_reservations(tenant_id,reservation_id,organization_id,period_id);

-- Existing cp_runtime/cp_funding column grants remain sufficient. No funding,
-- identity, consent, history or schema permissions are widened by this migration.
