-- Individual plans (2026-09-28): a person's own subscription, issued to a
-- person and never to an organization. Code and tests only: no production
-- migration, grant or price is authorized by this file.
--
-- A person has no tenant of their own, so a person's rows carry the person's
-- id as their tenant id. Included usage stays organization-funded (002/003);
-- funding a person is a later migration, so nothing here touches funding.

CREATE TABLE control_plane.person_feature_grants (
  tenant_id text NOT NULL,
  grant_id text NOT NULL,
  person_id text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  PRIMARY KEY (tenant_id,grant_id),
  UNIQUE (grant_id),
  CHECK (tenant_id = person_id),
  CHECK (record->>'id' = grant_id AND record->>'personId' = person_id AND record->>'tenantId' = tenant_id),
  CHECK (record->>'state' IN ('active','revoked')),
  CHECK ((record->>'state' = 'revoked') = (record->>'revokedAt' IS NOT NULL)),
  CHECK ((record->>'validUntil')::timestamptz > (record->>'validFrom')::timestamptz),
  CHECK (record ?& ARRAY['v','id','personId','tenantId','planId','features','source','reference','note',
    'validFrom','validUntil','state','issuedAt','issuedBy','revokedAt','revokedBy','revokedReason'])
);
CREATE INDEX person_feature_grants_person ON control_plane.person_feature_grants(person_id);

-- A revoked grant's revocation is a tombstone, as a business grant's is.
CREATE FUNCTION control_plane.guard_person_feature_grant_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.grant_id, NEW.person_id) IS DISTINCT FROM (OLD.tenant_id, OLD.grant_id, OLD.person_id)
    OR (OLD.record->>'state' = 'revoked' AND NEW.record IS DISTINCT FROM OLD.record)
    OR (NEW.record - ARRAY['state','revokedAt','revokedBy','revokedReason']) IS DISTINCT FROM
       (OLD.record - ARRAY['state','revokedAt','revokedBy','revokedReason']) THEN
    RAISE EXCEPTION 'A feature grant only changes by being revoked once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER person_feature_grant_tombstone BEFORE UPDATE ON control_plane.person_feature_grants
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_person_feature_grant_update();

-- Monotonic per person, bumped with every Individual grant change.
CREATE TABLE control_plane.person_access (
  person_id text PRIMARY KEY REFERENCES control_plane.persons(id),
  tenant_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  CHECK (tenant_id = person_id)
);

-- Admissions of Personal work under an Individual plan. Business admissions
-- stay in agent_admissions, whose organization_id is unchanged and NOT NULL.
CREATE TABLE control_plane.personal_agent_admissions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  person_id text NOT NULL REFERENCES control_plane.persons(id),
  at timestamptz NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  CHECK (tenant_id = person_id),
  CHECK (record->>'id' = id AND record->>'personId' = person_id AND record->>'tenantId' = tenant_id),
  CHECK (record->>'decision' IN ('admitted','refused')),
  CHECK (NOT (record ? 'organizationId'))
);
CREATE INDEX personal_agent_admissions_person ON control_plane.personal_agent_admissions(person_id, at DESC);
CREATE FUNCTION control_plane.refuse_personal_admission_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Personal Agent admissions are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER personal_agent_admission_append_only BEFORE UPDATE OR DELETE ON control_plane.personal_agent_admissions
  FOR EACH ROW EXECUTE FUNCTION control_plane.refuse_personal_admission_rewrite();

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
