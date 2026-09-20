-- REVIEW TEMPLATE ONLY. Run as the schema owner on an approved isolated DB.
-- Provision the login cp_runtime and its secret separately; this creates no role.
-- Grant no ownership, CREATE, DELETE, TRUNCATE or credential-table access.
REVOKE ALL ON SCHEMA control_plane FROM cp_runtime;
GRANT USAGE ON SCHEMA control_plane TO cp_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM cp_runtime;
GRANT SELECT, INSERT ON control_plane.persons, control_plane.external_subjects,
  control_plane.account_events TO cp_runtime;
GRANT SELECT, INSERT, UPDATE ON control_plane.sessions, control_plane.organizations,
  control_plane.memberships, control_plane.invitations TO cp_runtime;
-- B01 runtime does not yet consume the later commercial tables. A separately
-- reviewed receiver role can receive only the inbox/customer privileges it needs.
