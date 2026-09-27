-- Organization setup, ORG-01 (2026-09-26): each business's intake, kept for the
-- organization rather than on the one computer that answered it. Code and
-- tests only: no production migration is authorized by this file.
--
-- A row is one revision of the business setup record (the questionnaire's
-- answers, where it resumes and its state), written by an active Business
-- owner or Manager. A write names the revision it was made from, so the next
-- revision is exactly one more, and two computers saving at once conflict
-- instead of overwriting each other. Rows are never updated or deleted: a
-- correction, a resumed draft and an owner transfer each add a revision, and
-- the whole history stays. The record describes the business; it grants no
-- access, spending or membership, and it holds no credentials (the service
-- refuses an answer that looks like one).

CREATE TABLE control_plane.organization_setups (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  record jsonb NOT NULL,
  written_at timestamptz NOT NULL,
  written_by text NOT NULL REFERENCES control_plane.persons(id),
  PRIMARY KEY (tenant_id,organization_id,revision),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (jsonb_typeof(record) = 'object' AND record->>'v' = '1'),
  CHECK (record->'setup'->>'organizationId' = organization_id AND record->'setup'->>'tenantId' = tenant_id),
  CHECK (pg_column_size(record) <= 65536)
);
CREATE INDEX organization_setups_latest ON control_plane.organization_setups(organization_id, revision DESC);

-- A revision is written once. Nothing rewrites or removes one.
CREATE FUNCTION control_plane.refuse_organization_setup_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'An organization setup revision is written once and never changed' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER organization_setup_append_only BEFORE UPDATE OR DELETE ON control_plane.organization_setups
  FOR EACH ROW EXECUTE FUNCTION control_plane.refuse_organization_setup_change();

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
