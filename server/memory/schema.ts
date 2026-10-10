/** A separate ledger family. Existing Store and RunStore files are not migrated. */
export const MEMORY_SQLITE_SCHEMA_VERSION = 1;
export const MEMORY_SQLITE_APPLICATION_ID = 0x4e434d31;

const scope = 'tenant_id, workspace_id, scope_ref';
const scopeColumns = 'tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope_ref TEXT NOT NULL';
const entryKey = `${scope}, kind, id, revision`;

/** Only empty, unversioned databases may enter this initial schema. */
export const MEMORY_SQLITE_INITIAL_SCHEMA = `
CREATE TABLE memory_schema (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  name TEXT NOT NULL,
  digest TEXT NOT NULL
) STRICT;
CREATE TABLE memory_scopes (
  ${scopeColumns},
  identity_generation INTEGER NOT NULL CHECK(identity_generation >= 0),
  access_epoch INTEGER NOT NULL CHECK(access_epoch >= 0),
  deletion_epoch INTEGER NOT NULL CHECK(deletion_epoch >= 0),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  PRIMARY KEY (${scope})
) STRICT;
CREATE TABLE memory_entries (
  ${scopeColumns},
  kind TEXT NOT NULL CHECK(kind IN ('record', 'entity', 'conflict')),
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  recorded_at TEXT NOT NULL,
  identity_generation INTEGER NOT NULL CHECK(identity_generation >= 0),
  access_epoch INTEGER NOT NULL CHECK(access_epoch >= 0),
  deletion_epoch INTEGER NOT NULL CHECK(deletion_epoch >= 0),
  payload TEXT NOT NULL,
  PRIMARY KEY (${entryKey}),
  UNIQUE (${scope}, sequence),
  FOREIGN KEY (${scope}) REFERENCES memory_scopes (${scope})
) STRICT;
CREATE TABLE memory_heads (
  ${scopeColumns}, kind TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (${scope}, kind, id),
  FOREIGN KEY (${entryKey}) REFERENCES memory_entries (${entryKey})
) STRICT;
CREATE TABLE memory_sources (
  ${scopeColumns}, kind TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_id TEXT NOT NULL, source_revision TEXT, locator TEXT NOT NULL, source_json TEXT NOT NULL,
  PRIMARY KEY (${entryKey}, ordinal),
  FOREIGN KEY (${entryKey}) REFERENCES memory_entries (${entryKey})
) STRICT;
CREATE INDEX memory_source_lookup ON memory_sources (${scope}, source_id, source_revision, locator);
CREATE TABLE memory_dependencies (
  ${scopeColumns}, kind TEXT NOT NULL CHECK(kind = 'record'), id TEXT NOT NULL,
  revision INTEGER NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind = 'record'),
  target_id TEXT NOT NULL, target_revision INTEGER NOT NULL,
  PRIMARY KEY (${entryKey}, target_id, target_revision),
  FOREIGN KEY (${entryKey}) REFERENCES memory_entries (${entryKey}),
  FOREIGN KEY (${scope}, target_kind, target_id, target_revision)
    REFERENCES memory_entries (${entryKey})
) STRICT;
CREATE TABLE memory_entity_links (
  ${scopeColumns}, kind TEXT NOT NULL CHECK(kind = 'record'), id TEXT NOT NULL,
  revision INTEGER NOT NULL, entity_kind TEXT NOT NULL CHECK(entity_kind = 'entity'), entity_id TEXT NOT NULL,
  PRIMARY KEY (${entryKey}),
  FOREIGN KEY (${entryKey}) REFERENCES memory_entries (${entryKey}),
  FOREIGN KEY (${scope}, entity_kind, entity_id) REFERENCES memory_heads (${scope}, kind, id)
) STRICT;
CREATE TABLE memory_aliases (
  ${scopeColumns}, kind TEXT NOT NULL CHECK(kind = 'entity'), id TEXT NOT NULL,
  revision INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0), alias TEXT NOT NULL,
  PRIMARY KEY (${entryKey}, ordinal),
  FOREIGN KEY (${entryKey}) REFERENCES memory_entries (${entryKey})
) STRICT;
CREATE INDEX memory_alias_lookup ON memory_aliases (${scope}, alias);
CREATE TABLE memory_conflict_claims (
  ${scopeColumns}, kind TEXT NOT NULL CHECK(kind = 'conflict'), id TEXT NOT NULL,
  revision INTEGER NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind = 'record'),
  target_id TEXT NOT NULL, target_revision INTEGER NOT NULL,
  PRIMARY KEY (${entryKey}, target_id, target_revision),
  FOREIGN KEY (${entryKey}) REFERENCES memory_entries (${entryKey}),
  FOREIGN KEY (${scope}, target_kind, target_id, target_revision) REFERENCES memory_entries (${entryKey})
) STRICT;
CREATE TABLE memory_commands (
  ${scopeColumns}, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  sequence INTEGER NOT NULL, receipt_json TEXT NOT NULL,
  PRIMARY KEY (${scope}, command_id),
  UNIQUE (${scope}, sequence),
  FOREIGN KEY (${scope}, sequence) REFERENCES memory_entries (${scope}, sequence)
) STRICT;
CREATE TABLE memory_events (
  ${scopeColumns}, sequence INTEGER NOT NULL, command_id TEXT NOT NULL, event_json TEXT NOT NULL,
  PRIMARY KEY (${scope}, sequence),
  UNIQUE (${scope}, command_id),
  FOREIGN KEY (${scope}, sequence) REFERENCES memory_entries (${scope}, sequence),
  FOREIGN KEY (${scope}, command_id) REFERENCES memory_commands (${scope}, command_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE memory_acknowledgements (
  ${scopeColumns}, consumer_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence >= 0),
  PRIMARY KEY (${scope}, consumer_id),
  FOREIGN KEY (${scope}) REFERENCES memory_scopes (${scope})
) STRICT;
${['memory_entries', 'memory_sources', 'memory_dependencies', 'memory_entity_links',
  'memory_aliases', 'memory_conflict_claims', 'memory_commands', 'memory_events', 'memory_schema']
  .map(table => `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'immutable_memory'); END;
  CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'immutable_memory'); END;`).join('\n')}
CREATE TRIGGER memory_epochs_monotonic BEFORE UPDATE ON memory_scopes
WHEN NEW.identity_generation < OLD.identity_generation OR NEW.access_epoch < OLD.access_epoch
  OR NEW.deletion_epoch < OLD.deletion_epoch OR NEW.sequence < OLD.sequence
BEGIN SELECT RAISE(ABORT, 'revoked_epoch'); END;
CREATE TRIGGER memory_ack_monotonic BEFORE UPDATE ON memory_acknowledgements
WHEN NEW.sequence < OLD.sequence
BEGIN SELECT RAISE(ABORT, 'revision_conflict'); END;
`;
