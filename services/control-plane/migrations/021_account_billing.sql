-- Subscription checkout attempts and revocable customer developer keys. No credentials or live settings.
CREATE TABLE control_plane.subscription_accounts (
  customer_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider='stripe'),
  organization_id text NOT NULL,
  tenant_id text NOT NULL,
  suspended boolean NOT NULL DEFAULT false,
  attempt jsonb,
  projection jsonb NOT NULL DEFAULT '[]',
  source_event_id text,
  PRIMARY KEY(customer_id,environment),
  FOREIGN KEY(provider,customer_id,organization_id,tenant_id)
    REFERENCES control_plane.billing_customers(provider,customer_id,organization_id,tenant_id),
  FOREIGN KEY(tenant_id,provider,source_event_id)
    REFERENCES control_plane.webhook_inbox(tenant_id,provider,event_id),
  CHECK(jsonb_typeof(projection)='array')
);
CREATE FUNCTION control_plane.guard_subscription_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.customer_id,NEW.environment,NEW.provider,NEW.organization_id,NEW.tenant_id)
    IS DISTINCT FROM (OLD.customer_id,OLD.environment,OLD.provider,OLD.organization_id,OLD.tenant_id)
    OR (OLD.suspended AND NOT NEW.suspended) THEN
    RAISE EXCEPTION 'Subscription ownership and risk holds cannot be rewritten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_account_guard BEFORE UPDATE ON control_plane.subscription_accounts
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_subscription_account();

CREATE TABLE control_plane.developer_keys (
  id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES control_plane.persons(id),
  key_hash text NOT NULL UNIQUE CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  scope_id text NOT NULL REFERENCES control_plane.billing_scopes(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  identity_generation integer NOT NULL CHECK(identity_generation>=0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  record jsonb NOT NULL,
  FOREIGN KEY(issuer,subject,person_id) REFERENCES control_plane.external_subjects(issuer,subject,person_id),
  CHECK((record->>'id'=id AND record->>'personId'=person_id AND record->>'hash'=key_hash
    AND record->'scope'->>'id'=scope_id AND record->>'issuer'=issuer AND record->>'subject'=subject
    AND (record->>'identityGeneration')::integer=identity_generation AND (record->>'expiresAt')::timestamptz=expires_at) IS TRUE)
);
CREATE INDEX developer_keys_person ON control_plane.developer_keys(person_id);
CREATE FUNCTION control_plane.guard_developer_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Developer keys may only be revoked once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER developer_key_guard BEFORE UPDATE ON control_plane.developer_keys
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_developer_key();
REVOKE ALL ON control_plane.subscription_accounts,control_plane.developer_keys FROM PUBLIC;
