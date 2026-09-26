-- Phone relay, steps 1 and 2 (2026-09-26): the computers a business lets its
-- people reach from a phone. Code and tests only: no production migration is
-- authorized by this file.
--
-- A row is written when a Business owner or Manager turns on "Reach this
-- computer from your phone" on a desktop. The desktop makes an Ed25519 key,
-- keeps its signing half in that computer's protected storage, and proves it
-- on every connect; this table holds only the public half. Turning it off,
-- signing out or an owner's revocation writes revoked_at: the row stays as a
-- tombstone and is never deleted, and a revoked device can never connect
-- again. Whether a computer is connected right now lives in the relay hub,
-- not here; last_seen_at is when the hub last had it.

CREATE TABLE control_plane.relay_devices (
  tenant_id text NOT NULL,
  device_id text NOT NULL,
  organization_id text NOT NULL,
  person_id text NOT NULL REFERENCES control_plane.persons(id),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text REFERENCES control_plane.persons(id),
  last_seen_at timestamptz,
  PRIMARY KEY (tenant_id,device_id),
  UNIQUE (device_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  CHECK (device_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX relay_devices_organization ON control_plane.relay_devices(organization_id, created_at);

-- Who registered which key for which business never changes. A revocation is
-- written once and freezes the row; until then only last_seen_at moves, and
-- only forward.
CREATE FUNCTION control_plane.guard_relay_device_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.device_id, NEW.organization_id, NEW.person_id, NEW.public_key, NEW.label, NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id, OLD.device_id, OLD.organization_id, OLD.person_id, OLD.public_key, OLD.label, OLD.created_at)
    OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by, NEW.last_seen_at)
      IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.last_seen_at))
    OR (OLD.last_seen_at IS NOT NULL AND (NEW.last_seen_at IS NULL OR NEW.last_seen_at < OLD.last_seen_at)) THEN
    RAISE EXCEPTION 'A relay device only changes by being seen, or by being revoked once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER relay_device_tombstone BEFORE UPDATE ON control_plane.relay_devices
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_relay_device_update();

REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
