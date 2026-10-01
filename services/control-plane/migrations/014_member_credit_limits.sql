-- Per-member monthly credit limits (Andrew, 2026-10-01). Additive only: four new tables, and nothing
-- in 002 to 013 changes. Code and tests only: no production migration is authorized by this file.
--
-- A business has one shared credit pool. Each member also has a monthly limit on how much of it they
-- may use, always on and reset with the plan period. A limit comes from the member's role, with a
-- per-person override; the default is read from the plan in code, so no figure is stored here that
-- nobody decided. When a member's work would pass their limit it stops and asks an owner or admin,
-- who may approve one job or raise that person's month, and may let the approval use credits the
-- business bought. Amounts are integer micro-USD.
--
-- credit_attempt_people records which person a funded attempt was reserved for. It is a side table
-- so funding_reservations, a hot table other lanes touch, is not altered. A person's usage is what
-- their attempts and their purchased-usage holds (013) hold or have settled in the period. Attempts
-- reserved before this migration name nobody, so they count against nobody's limit.
--
-- The seam for teams (DIO-122) is subject_kind on a limit and scope_kind on a request: both accept
-- only today's values, and a team is one more value in a later migration. No team is built here.
--
-- Apply after 011, 012 and 013. The migration runner takes each version from the file name's number.

CREATE TABLE control_plane.credit_attempt_people (
  tenant_id text NOT NULL,
  reservation_id text NOT NULL,
  organization_id text NOT NULL,
  person_id text NOT NULL,
  PRIMARY KEY (tenant_id,reservation_id),
  FOREIGN KEY (tenant_id,reservation_id) REFERENCES control_plane.funding_reservations(tenant_id,reservation_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id)
);
CREATE INDEX credit_attempt_people_person ON control_plane.credit_attempt_people(tenant_id,organization_id,person_id);

CREATE TABLE control_plane.credit_member_limits (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('role','person')),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 128),
  mode text NOT NULL CHECK (mode IN ('limit','unlimited','inherit')),
  limit_micro_usd bigint CHECK (limit_micro_usd BETWEEN 0 AND 9007199254740991),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id,subject_kind,subject_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK ((mode = 'limit') = (limit_micro_usd IS NOT NULL)),
  CHECK (subject_kind <> 'role' OR subject_id IN ('member','admin'))
);

CREATE TABLE control_plane.credit_allotment_settings (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  members_see_own_usage boolean NOT NULL,
  admins_see_member_usage boolean NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,organization_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id)
);

CREATE TABLE control_plane.credit_limit_requests (
  tenant_id text NOT NULL,
  request_id text NOT NULL,
  organization_id text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('person')),
  person_id text NOT NULL,
  requester_role text NOT NULL CHECK (requester_role IN ('owner','admin','member')),
  kind text NOT NULL CHECK (kind IN ('job','month')),
  root_job_id text,
  state text NOT NULL CHECK (state IN ('pending','approved','denied')),
  requested_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  extra_micro_usd bigint CHECK (extra_micro_usd BETWEEN 1 AND 9007199254740991),
  allow_purchased boolean NOT NULL,
  period_id text CHECK (period_id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  PRIMARY KEY (tenant_id,request_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  FOREIGN KEY (tenant_id,root_job_id,organization_id) REFERENCES control_plane.funded_jobs(tenant_id,root_job_id,organization_id),
  CHECK ((kind = 'job') = (root_job_id IS NOT NULL)),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK ((state = 'approved') = (extra_micro_usd IS NOT NULL)),
  CHECK (state = 'approved' OR allow_purchased = false),
  CHECK ((kind = 'month' AND state = 'approved') = (period_id IS NOT NULL))
);
CREATE INDEX credit_limit_requests_person ON control_plane.credit_limit_requests(tenant_id,organization_id,person_id,state);
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
