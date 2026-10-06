// W00 runtime capability probe only. No product store, app profile or migration.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(':memory:');
const checks = [];
try {
  database.exec('CREATE TABLE fixture (tenant TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (tenant, id))');
  const insert = database.prepare('INSERT INTO fixture VALUES (?, ?, ?)');
  insert.run('synthetic-A', 'same-id', 'Keep the correction.');
  insert.run('synthetic-B', 'same-id', 'Independent source.');
  assert.equal(database.prepare('SELECT count(*) AS n FROM fixture').get().n, 2);
  checks.push('composite tenant and record key');
  assert.throws(() => insert.run('synthetic-A', 'same-id', 'Duplicate'));
  checks.push('duplicate key refused');
  database.exec('BEGIN');
  insert.run('synthetic-A', 'uncommitted', 'Rollback probe');
  database.exec('ROLLBACK');
  assert.equal(database.prepare('SELECT count(*) AS n FROM fixture WHERE id = ?').get('uncommitted').n, 0);
  checks.push('transaction rollback');
  database.exec('CREATE VIRTUAL TABLE fixture_text USING fts5(body)');
  database.prepare('INSERT INTO fixture_text VALUES (?)').run('Correction: approval is pending.');
  assert.equal(database.prepare('SELECT count(*) AS n FROM fixture_text WHERE fixture_text MATCH ?').get('correction').n, 1);
  checks.push('FTS5 available');
  process.stdout.write(JSON.stringify({
    kind: 'runtime-capability-probe', driver: 'node:sqlite', platform: process.platform, arch: process.arch,
    node: process.versions.node, electron: process.versions.electron ?? null,
    sqlite: database.prepare('SELECT sqlite_version() AS version').get().version,
    passed: checks.length, failed: 0, checks,
    scope: 'In-memory runtime probe only; not packaged-app, persistence/crash, macOS or W01 qualification.',
  }, null, 2) + '\n');
} finally {
  database.close();
}
