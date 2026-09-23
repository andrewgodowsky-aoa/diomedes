-- nectovia-usage/1 and the usage class. Code and tests only: no production
-- migration, pricing or plan is authorized by this file.
--
-- Every paid attempt records what it is for, so each class's debit rule can be
-- decided on its own. NOT NULL with no default: applying this to a table that
-- already holds attempts fails loudly rather than inventing their class.
ALTER TABLE control_plane.funding_reservations
  ADD COLUMN usage_class text NOT NULL
    CHECK (usage_class IN ('included-chat','metered-work','worker','automation'));

-- A settlement's usage is the normalized nectovia-usage/1 record, with the
-- provider's raw usage evidence carried beside the counts.
ALTER TABLE control_plane.funding_settlements
  ADD CONSTRAINT funding_settlements_usage_contract CHECK (usage->>'contract' = 'nectovia-usage/1');
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
