-- Staff keys (2026-09-26). Diomedes staff sign in to the Operations app with a
-- personal key instead of a WorkOS session. The app makes the key on the staff
-- member's own computer and keeps it there; this table holds only its SHA-256,
-- which an admin registers. The key id is the subject the account service maps
-- to a person, so the person, operator, session and audit rows are the ones a
-- WorkOS sign-in used. Customers still sign in through WorkOS.

CREATE TABLE control_plane.staff_keys (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  key_id text NOT NULL UNIQUE CHECK (key_id = 'staff_key_' || left(key_hash, 16)),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email text CHECK (email IS NULL OR length(email) BETWEEN 3 AND 320),
  created_at timestamptz NOT NULL,
  created_by text REFERENCES control_plane.persons(id),
  revoked_at timestamptz
);

-- A withdrawn key stays withdrawn: only revoked_at may change, and only once.
CREATE FUNCTION control_plane.guard_staff_key_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.key_hash, NEW.key_id, NEW.name, NEW.email, NEW.created_at, NEW.created_by)
       IS DISTINCT FROM (OLD.key_hash, OLD.key_id, OLD.name, OLD.email, OLD.created_at, OLD.created_by)
     OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'A staff key only changes by being withdrawn once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER staff_key_tombstone BEFORE UPDATE ON control_plane.staff_keys
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_staff_key_update();

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
