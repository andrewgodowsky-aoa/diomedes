-- B01 account records only. No operational Tasks, Runs, History or credentials.
CREATE TABLE control_plane.persons (
  id text PRIMARY KEY,
  record jsonb NOT NULL,
  CHECK (record->>'id' = id AND record->>'assurance' = 'hosted'),
  CHECK (record ?& ARRAY['id','name','assurance','createdAt','v'])
);
CREATE TABLE control_plane.external_subjects (
  issuer text NOT NULL,
  subject text NOT NULL,
  person_id text NOT NULL UNIQUE REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  PRIMARY KEY (issuer, subject),
  UNIQUE (issuer, subject, person_id),
  CHECK (record->>'issuer' = issuer AND record->>'subject' = subject AND record->>'personId' = person_id),
  CHECK (record ?& ARRAY['issuer','subject','personId','verifiedAt','identityGeneration'])
);
CREATE TABLE control_plane.sessions (
  issuer text NOT NULL,
  session_id text NOT NULL,
  subject text NOT NULL,
  person_id text NOT NULL,
  principal_id text NOT NULL UNIQUE,
  record jsonb NOT NULL,
  PRIMARY KEY (issuer, session_id),
  FOREIGN KEY (issuer,subject,person_id) REFERENCES control_plane.external_subjects(issuer,subject,person_id),
  CHECK (record->>'issuer' = issuer AND record->>'sessionId' = session_id AND record->>'subject' = subject
    AND record->>'personId' = person_id AND record->>'principalId' = principal_id),
  CHECK (record ?& ARRAY['issuer','sessionId','subject','personId','principalId','expiresAt','revokedAt'])
);
CREATE FUNCTION control_plane.guard_session_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.issuer, NEW.session_id, NEW.subject, NEW.person_id, NEW.principal_id)
      IS DISTINCT FROM (OLD.issuer, OLD.session_id, OLD.subject, OLD.person_id, OLD.principal_id)
    OR (OLD.record->>'revokedAt' IS NOT NULL AND NEW.record->>'revokedAt' IS DISTINCT FROM OLD.record->>'revokedAt') THEN
    RAISE EXCEPTION 'Session identity and revocation tombstones are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_tombstone BEFORE UPDATE ON control_plane.sessions
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_session_update();
CREATE TABLE control_plane.organizations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  UNIQUE (id, tenant_id),
  CHECK (record->>'id' = id AND record->>'tenantId' = tenant_id AND record->>'createdBy' = created_by AND record->>'identitySource' = 'hosted'),
  CHECK (record ?& ARRAY['id','tenantId','createdBy','identitySource','name','industry','createdAt','v'])
);
CREATE TABLE control_plane.memberships (
  organization_id text NOT NULL REFERENCES control_plane.organizations(id),
  person_id text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  PRIMARY KEY (organization_id, person_id),
  CHECK (record->>'organizationId' = organization_id AND record->>'personId' = person_id),
  CHECK (record->>'role' IN ('owner','admin','member') AND record->>'state' IN ('invited','active','revoked')),
  CHECK ((record->>'state' = 'revoked') = (record->>'revokedAt' IS NOT NULL)),
  CHECK (record->>'state' <> 'active' OR record->>'joinedAt' IS NOT NULL),
  CHECK (record ?& ARRAY['organizationId','personId','role','state','invitedAt','joinedAt','revokedAt','revokedReason','v'])
);
CREATE INDEX memberships_person ON control_plane.memberships(person_id, organization_id);
CREATE TABLE control_plane.invitations (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  organization_id text NOT NULL REFERENCES control_plane.organizations(id),
  invited_by text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  CHECK (record->>'tokenHash' = token_hash AND record->>'organizationId' = organization_id AND record->>'invitedBy' = invited_by),
  CHECK ((record->>'redeemedAt' IS NULL) = (record->>'redeemedBy' IS NULL)),
  CHECK (record ?& ARRAY['tokenHash','organizationId','issuer','subject','role','invitedBy','inviterGeneration','createdAt','expiresAt','redeemedAt','redeemedBy'])
);
CREATE INDEX invitations_organization ON control_plane.invitations(organization_id);
CREATE TABLE control_plane.account_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES control_plane.organizations(id),
  actor_person_id text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  CHECK (record->>'id' = id AND record->>'actorPersonId' = actor_person_id),
  CHECK ((record->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK (record ?& ARRAY['id','organizationId','actorPersonId','at','kind','targetId'])
);
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
