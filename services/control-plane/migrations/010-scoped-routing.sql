-- Operations-controlled routing, following immutable Individual migration 009.
-- Apply as migration owner, never from a request.
-- Existing policy bytes and balances are retained. No route, qualification,
-- Individual subscription, credit or customer consent is invented here.

CREATE TABLE control_plane.billing_scopes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('organization','individual')),
  organization_id text,
  person_id text REFERENCES control_plane.persons(id),
  record jsonb,
  UNIQUE(id,tenant_id),
  UNIQUE(person_id),
  FOREIGN KEY(organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (((kind='organization' AND organization_id IS NOT NULL AND organization_id=id AND person_id IS NULL AND record IS NULL)
      OR (kind='individual' AND organization_id IS NULL AND person_id IS NOT NULL AND tenant_id=person_id
          AND id LIKE 'individual_%' AND record IS NOT NULL AND record->>'id'=id AND record->>'tenantId'=tenant_id AND record->>'personId'=person_id)) IS TRUE)
);
INSERT INTO control_plane.billing_scopes(id,tenant_id,kind,organization_id)
  SELECT id,tenant_id,'organization',id FROM control_plane.organizations;

-- Existing 009 grant holders must be discoverable by Operations before they
-- open setup. These are identities only: preserve every grant and balance.
WITH holders AS (SELECT DISTINCT person_id FROM control_plane.person_feature_grants),
identities AS (
  SELECT 'individual_' || gen_random_uuid()::text AS id, p.id AS person_id, p.record->>'name' AS name
    FROM control_plane.persons p JOIN holders h ON h.person_id=p.id
)
INSERT INTO control_plane.billing_scopes(id,tenant_id,kind,person_id,record)
  SELECT id,person_id,'individual',person_id,jsonb_build_object(
    'id',id,'tenantId',person_id,'personId',person_id,'name',name,'state','active',
    'createdAt',to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM identities;

-- Preserve 009's person records and append-only history. New scoped admissions
-- can bind to a billing account; historical Personal admissions keep NULL here.
ALTER TABLE control_plane.personal_agent_admissions ADD COLUMN billing_account_id text
  GENERATED ALWAYS AS (record->>'billingAccountId') STORED;
ALTER TABLE control_plane.personal_agent_admissions ADD CONSTRAINT personal_admission_billing_scope
  FOREIGN KEY(billing_account_id,tenant_id) REFERENCES control_plane.billing_scopes(id,tenant_id);

CREATE FUNCTION control_plane.register_organization_billing_scope() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control_plane AS $$
BEGIN
  INSERT INTO control_plane.billing_scopes(id,tenant_id,kind,organization_id) VALUES(NEW.id,NEW.tenant_id,'organization',NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_plane.register_organization_billing_scope() FROM PUBLIC;
CREATE TRIGGER organization_billing_scope AFTER INSERT ON control_plane.organizations
  FOR EACH ROW EXECUTE FUNCTION control_plane.register_organization_billing_scope();

-- The historical organization_id column is the ledger account id. Its tenant
-- key and every reservation/job relation stay intact; Individual has no org row.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.conrelid::regclass AS tbl,c.conname
    FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='control_plane.organizations'::regclass
      AND c.conrelid IN ('control_plane.billing_customers'::regclass,'control_plane.entitlement_grants'::regclass,
        'control_plane.funding_accounts'::regclass,'control_plane.credit_periods'::regclass,
        'control_plane.funded_jobs'::regclass,'control_plane.credit_topups'::regclass,
        'control_plane.feature_grants'::regclass,'control_plane.organization_access'::regclass,
        'control_plane.agent_admissions'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.tbl,item.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY(organization_id,tenant_id) REFERENCES control_plane.billing_scopes(id,tenant_id)',item.tbl,item.conname);
  END LOOP;
END $$;

ALTER TABLE control_plane.tier_policies ADD COLUMN scope_key text NOT NULL DEFAULT 'global';
ALTER TABLE control_plane.tier_policies DROP CONSTRAINT tier_policies_pkey;
ALTER TABLE control_plane.tier_policies ADD PRIMARY KEY(scope_key,revision);
ALTER TABLE control_plane.tier_policies ADD CONSTRAINT tier_policy_scope CHECK (
  ((scope_key='global' AND (record->'scope' IS NULL OR record->'scope'->>'kind'='global')) OR
  (record->'scope'->>'kind' IN ('organization','individual') AND scope_key=(record->'scope'->>'kind')||':'||(record->'scope'->>'id'))) IS TRUE
);

-- NC-SETUP's sole customer routing preference record, append-only with explicit
-- consent attribution. Routing staff cannot write it through the Operations API.
CREATE TABLE control_plane.account_routing_preferences (
  scope_key text NOT NULL,
  revision bigint NOT NULL CHECK(revision > 0),
  account_id text NOT NULL REFERENCES control_plane.billing_scopes(id),
  accepted_by text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  PRIMARY KEY(scope_key,revision),
  CHECK((record->'scope'->>'id'=account_id AND (record->>'revision')::bigint=revision
    AND record->>'acceptedBy'=accepted_by
    AND record->'scope'->>'kind' IN ('organization','individual')
    AND scope_key=(record->'scope'->>'kind')||':'||account_id) IS TRUE)
);
CREATE FUNCTION control_plane.reject_routing_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Routing history is append-only'; END $$;
REVOKE ALL ON FUNCTION control_plane.reject_routing_history_change() FROM PUBLIC;
CREATE TRIGGER immutable_routing_preferences BEFORE UPDATE OR DELETE ON control_plane.account_routing_preferences
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_routing_history_change();
REVOKE ALL ON control_plane.billing_scopes,control_plane.account_routing_preferences FROM PUBLIC;
-- Apply the separately reviewed runtime-permissions.sql after this migration.
-- Schema migration does not provision or alter the deployment's runtime roles.

CREATE TABLE control_plane.routing_job_constraints (
  scope_key text NOT NULL, job_id text NOT NULL, restrictions jsonb NOT NULL CHECK(jsonb_typeof(restrictions)='array'),
  PRIMARY KEY(scope_key,job_id)
);
CREATE TABLE control_plane.managed_route_circuits (
  route_id text NOT NULL REFERENCES control_plane.route_entries(id), route_revision bigint NOT NULL,
  until_at timestamptz NOT NULL, reason text NOT NULL, PRIMARY KEY(route_id,route_revision)
);
REVOKE ALL ON control_plane.routing_job_constraints,control_plane.managed_route_circuits FROM PUBLIC;
CREATE FUNCTION control_plane.enforce_routing_constraints() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope_key<>OLD.scope_key OR NEW.job_id<>OLD.job_id OR NOT NEW.restrictions @> OLD.restrictions THEN
    RAISE EXCEPTION 'Job source restrictions cannot be removed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER monotone_routing_constraints BEFORE UPDATE ON control_plane.routing_job_constraints
  FOR EACH ROW EXECUTE FUNCTION control_plane.enforce_routing_constraints();
REVOKE ALL ON FUNCTION control_plane.enforce_routing_constraints() FROM PUBLIC;

-- Roll back behavior by publishing an explicitly disabled/single-route policy
-- or republishing an eligible prior revision. Do not down-migrate away receipts,
-- consent or Individual accounts after writes; keep this additive schema.
