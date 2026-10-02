-- REVIEW TEMPLATE ONLY. Schema owner, approved isolated database only.
-- Provision cp_staff_funding separately. STAFF_FUNDING_DATABASE_URL must name
-- this same database. No ownership, CREATE, UPDATE, DELETE, TRUNCATE, credentials,
-- grant mutation, top-up purchase, dispatch, reservation or settlement authority.
-- The staff service rechecks operator authority under the shared staff lock;
-- organization and grant reads verify the target. One transaction writes the
-- period or correction and its immutable Operations receipt.
REVOKE ALL ON SCHEMA control_plane FROM cp_staff_funding;
GRANT USAGE ON SCHEMA control_plane TO cp_staff_funding;
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM cp_staff_funding;
GRANT SELECT ON control_plane.operators, control_plane.organizations,
  control_plane.feature_grants TO cp_staff_funding;
GRANT SELECT, INSERT ON control_plane.credit_periods,
  control_plane.credit_adjustments, control_plane.ops_audit TO cp_staff_funding;
