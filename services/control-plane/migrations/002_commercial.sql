-- Storage seams for later B04/B05/B06. No payment requests, money mutation API,
-- entitlement grants or execution authority are implemented by this migration.
CREATE TABLE control_plane.billing_customers (
  provider text NOT NULL CHECK (provider = 'stripe'),
  customer_id text NOT NULL,
  organization_id text NOT NULL,
  tenant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, customer_id),
  UNIQUE (provider, organization_id),
  UNIQUE (provider, customer_id, organization_id, tenant_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id)
);
CREATE TABLE control_plane.webhook_inbox (
  provider text NOT NULL,
  event_id text NOT NULL,
  customer_id text NOT NULL,
  organization_id text NOT NULL,
  tenant_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','quarantined')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider,event_id),
  UNIQUE (tenant_id,provider,event_id),
  FOREIGN KEY (provider,customer_id,organization_id,tenant_id)
    REFERENCES control_plane.billing_customers(provider,customer_id,organization_id,tenant_id),
  CHECK (octet_length(payload::text) <= 524288),
  CHECK ((state='processed') = (processed_at IS NOT NULL))
);
CREATE INDEX webhook_pending ON control_plane.webhook_inbox(state,received_at);
CREATE TABLE control_plane.subscriptions (
  tenant_id text NOT NULL,
  provider text NOT NULL,
  subscription_id text NOT NULL,
  organization_id text NOT NULL,
  customer_id text NOT NULL,
  status text NOT NULL,
  projection jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,provider,subscription_id),
  UNIQUE (provider,subscription_id),
  FOREIGN KEY (provider,customer_id,organization_id,tenant_id)
    REFERENCES control_plane.billing_customers(provider,customer_id,organization_id,tenant_id)
);
CREATE TABLE control_plane.entitlement_grants (
  tenant_id text NOT NULL,
  grant_id text NOT NULL,
  organization_id text NOT NULL,
  provider text NOT NULL,
  source_event_id text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','revoked','expired')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  projection jsonb NOT NULL,
  PRIMARY KEY (tenant_id,grant_id),
  UNIQUE (tenant_id,provider,source_event_id,kind),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id),
  FOREIGN KEY (tenant_id,provider,source_event_id) REFERENCES control_plane.webhook_inbox(tenant_id,provider,event_id),
  CHECK (valid_until > valid_from)
);
CREATE TABLE control_plane.funding_accounts (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  organization_id text NOT NULL,
  currency text NOT NULL CHECK (currency='USD'),
  available_micro_usd bigint NOT NULL CHECK (available_micro_usd BETWEEN 0 AND 9007199254740991),
  generation integer NOT NULL CHECK (generation >= 0),
  PRIMARY KEY (tenant_id,account_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id)
);
CREATE TABLE control_plane.funding_reservations (
  tenant_id text NOT NULL,
  reservation_id text NOT NULL,
  account_id text NOT NULL,
  existing_run_ref text NOT NULL,
  existing_parent_task_ref text,
  rate_card_version text NOT NULL,
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('pending','uncertain','settled','released','written-off')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,reservation_id),
  FOREIGN KEY (tenant_id,account_id) REFERENCES control_plane.funding_accounts(tenant_id,account_id)
);
CREATE TABLE control_plane.funding_settlements (
  tenant_id text NOT NULL,
  reservation_id text NOT NULL,
  provider_receipt_ref text NOT NULL,
  provider_cost_micro_usd bigint NOT NULL CHECK (provider_cost_micro_usd BETWEEN 0 AND 9007199254740991),
  allowance_debit_micro_usd bigint NOT NULL CHECK (allowance_debit_micro_usd BETWEEN 0 AND 9007199254740991),
  invoice_micro_usd bigint NOT NULL CHECK (invoice_micro_usd BETWEEN 0 AND 9007199254740991),
  settled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,reservation_id),
  UNIQUE (tenant_id,provider_receipt_ref),
  FOREIGN KEY (tenant_id,reservation_id) REFERENCES control_plane.funding_reservations(tenant_id,reservation_id)
);
CREATE TABLE control_plane.connector_references (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  organization_id text NOT NULL,
  provider text NOT NULL,
  opaque_reference text NOT NULL,
  scope jsonb NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,connection_id),
  FOREIGN KEY (organization_id,tenant_id) REFERENCES control_plane.organizations(id,tenant_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
