-- Customer access, company routing and staff administration (2026-09-25).
-- Code and tests only: no production migration, grant, price or route is
-- authorized by this file.
--
-- Feature grants say what a business may use; funding stays in the 002/003
-- tables. A subscription-sourced feature grant names its verified entitlement
-- grant in `reference`; staff-issued grants (service agreements, internal
-- test accounts) have no webhook behind them, so monthly credits now bind to
-- the feature grant that funded them rather than to the Stripe-only table.

CREATE TABLE control_plane.feature_grants (
  tenant_id text NOT NULL,
  grant_id text NOT NULL,
  organization_id text NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (tenant_id,grant_id),
  UNIQUE (grant_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (record->>'id' = grant_id AND record->>'organizationId' = organization_id AND record->>'tenantId' = tenant_id),
  CHECK (record->>'state' IN ('active','revoked')),
  CHECK ((record->>'state' = 'revoked') = (record->>'revokedAt' IS NOT NULL)),
  CHECK ((record->>'validUntil')::timestamptz > (record->>'validFrom')::timestamptz),
  CHECK (record ?& ARRAY['v','id','organizationId','tenantId','planId','features','source','reference','note',
    'validFrom','validUntil','state','issuedAt','issuedBy','revokedAt','revokedBy','revokedReason'])
);
CREATE INDEX feature_grants_organization ON control_plane.feature_grants(organization_id);

-- A revoked grant's revocation is a tombstone, as sessions' are.
CREATE FUNCTION control_plane.guard_feature_grant_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.grant_id, NEW.organization_id) IS DISTINCT FROM (OLD.tenant_id, OLD.grant_id, OLD.organization_id)
    OR (OLD.record->>'state' = 'revoked' AND NEW.record IS DISTINCT FROM OLD.record)
    OR (NEW.record - ARRAY['state','revokedAt','revokedBy','revokedReason']) IS DISTINCT FROM
       (OLD.record - ARRAY['state','revokedAt','revokedBy','revokedReason']) THEN
    RAISE EXCEPTION 'A feature grant only changes by being revoked once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER feature_grant_tombstone BEFORE UPDATE ON control_plane.feature_grants
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_feature_grant_update();

-- Monotonic per organization, bumped with every grant change, so a reader can
-- tell a stale access view from a current one.
CREATE TABLE control_plane.organization_access (
  organization_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id)
);

ALTER TABLE control_plane.credit_periods DROP CONSTRAINT credit_periods_tenant_id_source_grant_id_fkey;
ALTER TABLE control_plane.credit_periods
  ADD CONSTRAINT credit_periods_feature_grant_fkey FOREIGN KEY (tenant_id,source_grant_id)
    REFERENCES control_plane.feature_grants(tenant_id,grant_id);

-- Single-use invitation codes, stored as hashes. Separate from the
-- subject-bound invitations of 001, which are unchanged.
CREATE TABLE control_plane.invitation_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  organization_id text NOT NULL REFERENCES control_plane.organizations(id),
  invited_by text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  CHECK (record->>'codeHash' = code_hash AND record->>'organizationId' = organization_id AND record->>'invitedBy' = invited_by),
  CHECK (record->>'role' IN ('owner','admin','member')),
  CHECK ((record->>'redeemedAt' IS NULL) = (record->>'redeemedBy' IS NULL)),
  CHECK (record ?& ARRAY['codeHash','organizationId','role','email','invitedBy','inviterGeneration','createdAt','expiresAt','redeemedAt','redeemedBy','revokedAt'])
);
CREATE INDEX invitation_codes_organization ON control_plane.invitation_codes(organization_id);

-- The company route registry. Identifiers only; nothing here opens a provider account.
CREATE TABLE control_plane.route_entries (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.:_-]{0,127}$'),
  record jsonb NOT NULL,
  CHECK (record->>'id' = id),
  CHECK (record->>'provider' IN ('aws-bedrock','azure-openai','openrouter','google-vertex')),
  CHECK (record->>'status' IN ('qualified','unqualified','retired')),
  CHECK (record ?& ARRAY['v','id','provider','model','label','region','processing','status','evidence','revision','updatedAt','updatedBy'])
);

-- Published tier policies. Append-only: a rollback is a new revision.
CREATE TABLE control_plane.tier_policies (
  revision bigint PRIMARY KEY CHECK (revision >= 1),
  record jsonb NOT NULL,
  CHECK ((record->>'revision')::bigint = revision),
  CHECK (record->>'kind' IN ('seed','publish','rollback')),
  CHECK (record ?& ARRAY['v','revision','tiers','kind','basedOn','note','publishedAt','publishedBy'])
);
CREATE FUNCTION control_plane.refuse_policy_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published tier policies are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER tier_policy_append_only BEFORE UPDATE OR DELETE ON control_plane.tier_policies
  FOR EACH ROW EXECUTE FUNCTION control_plane.refuse_policy_rewrite();

-- Diomedes staff. A customer role never appears here.
CREATE TABLE control_plane.operators (
  person_id text PRIMARY KEY REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  CHECK (record->>'personId' = person_id),
  CHECK (record->>'role' IN ('support','billing','routing','admin')),
  CHECK (record->>'state' IN ('active','disabled')),
  CHECK (record ?& ARRAY['v','personId','role','state','addedAt','addedBy','updatedAt','updatedBy'])
);

CREATE TABLE control_plane.ops_audit (
  id text PRIMARY KEY,
  at timestamptz NOT NULL,
  actor_person_id text NOT NULL REFERENCES control_plane.persons(id),
  organization_id text REFERENCES control_plane.organizations(id),
  record jsonb NOT NULL,
  CHECK (record->>'id' = id AND record->>'actorPersonId' = actor_person_id),
  CHECK ((record->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK (record ?& ARRAY['id','at','actorPersonId','actorRole','action','organizationId','targetKind','targetId','reason','detail'])
);
CREATE INDEX ops_audit_at ON control_plane.ops_audit(at DESC);
CREATE INDEX ops_audit_organization ON control_plane.ops_audit(organization_id, at DESC);
CREATE FUNCTION control_plane.refuse_audit_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The staff audit log is append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER ops_audit_append_only BEFORE UPDATE OR DELETE ON control_plane.ops_audit
  FOR EACH ROW EXECUTE FUNCTION control_plane.refuse_audit_rewrite();

-- Every Agent admission decision and what it was pinned to.
CREATE TABLE control_plane.agent_admissions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  organization_id text NOT NULL,
  person_id text NOT NULL REFERENCES control_plane.persons(id),
  at timestamptz NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (record->>'id' = id AND record->>'organizationId' = organization_id AND record->>'personId' = person_id AND record->>'tenantId' = tenant_id),
  CHECK (record->>'decision' IN ('admitted','refused'))
);
CREATE INDEX agent_admissions_organization ON control_plane.agent_admissions(organization_id, at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
