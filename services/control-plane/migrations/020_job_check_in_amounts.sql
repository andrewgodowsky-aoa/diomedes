-- Job check-in amounts (Andrew, 2026-10-05). Code and tests only: no production migration is
-- authorized by this file, and no amount is written by it.
--
-- A job is never cut off mid-call or mid-write. What a tier's amount bounds is how far a job runs
-- before it checks in and asks whether to keep going (shared/job-check-ins.ts). The amount for a
-- job is the business's own setting, else the defaults Diomedes staff publish, else the code
-- default; this migration stores the first two.
--
-- job_check_in_defaults holds every version of the staff defaults: each tier's amount in whole
-- credits. Versions are append-only (a change is a new version), like credit_price_tables.
-- job_check_in_overrides holds one business's own amounts, one row each, set by its owners and
-- admins. A tier left out of the record uses the defaults. Both are read by the gateway when a job is
-- opened, so the account service is the authority on every hold.
--
-- funded_jobs.tier is the tier a root job was opened under, so a Keep going raises that job by its
-- own tier's amount and never by one a request names. Jobs opened before this migration have none,
-- and a Keep going on one is refused.
--
-- Apply after 016 to 019: the migration runner takes each version from the file name's number and
-- refuses a gap. Numbers are assigned at merge, in merge order.

CREATE TABLE control_plane.job_check_in_defaults (
  version bigint PRIMARY KEY CHECK (version >= 1),
  published_at timestamptz NOT NULL,
  published_by text NOT NULL REFERENCES control_plane.persons(id),
  record jsonb NOT NULL,
  CHECK ((record->>'version')::bigint = version),
  CHECK (record->>'publishedBy' = published_by),
  CHECK (record ?& ARRAY['v','version','amounts','note','publishedAt','publishedBy']),
  CHECK (record->'amounts' ?& ARRAY['efficient','focused','thorough'])
);
CREATE FUNCTION control_plane.refuse_job_check_in_defaults_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published job check-in defaults are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER job_check_in_defaults_append_only BEFORE UPDATE OR DELETE ON control_plane.job_check_in_defaults
  FOR EACH ROW EXECUTE FUNCTION control_plane.refuse_job_check_in_defaults_rewrite();

CREATE TABLE control_plane.job_check_in_overrides (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  record jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (record ?& ARRAY['tenantId','organizationId','amounts','updatedBy','updatedAt']),
  CHECK (record->'amounts' ?& ARRAY['efficient','focused','thorough'])
);

ALTER TABLE control_plane.funded_jobs
  ADD COLUMN tier text CHECK (tier IS NULL OR tier IN ('efficient','focused','thorough'));

REVOKE ALL ON control_plane.job_check_in_defaults FROM PUBLIC;
REVOKE ALL ON control_plane.job_check_in_overrides FROM PUBLIC;
