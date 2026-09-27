/**
 * What a SQL adapter's statements need, against what scripts/runtime-permissions.sql
 * grants the Worker login (cp_runtime). Protocol only: nothing here runs
 * PostgreSQL. Shared by the adapter tests that check their tables both ways:
 * every privilege an adapter uses is granted, and nothing granted goes unused.
 */
import { readFileSync } from 'node:fs';
import type { SqlClient } from '../../src/postgres.js';

/** A file of this package, named relative to tests/ as a test file would, with LF line endings. */
export const read = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** A client that records every statement and its bound values, answering from `rows`. */
export function recording(rows: (sql: string, values: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client: SqlClient = {
    async connect() {},
    async query(sql, values = []) {
      calls.push({ sql, values });
      const result = rows(sql, values);
      return { rows: result, rowCount: result.length };
    },
    async end() {},
  };
  return { client, factory: () => client, calls };
}

export interface Privileges { select: boolean; insert: boolean; update: Set<string> }

/** Split at commas outside parentheses. */
function topLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** cp_runtime's table grants. Statements other than table GRANTs (the schema and revoke lines) are not table grants. */
export function runtimeGrants(sql: string): Map<string, Privileges> {
  const tables = new Map<string, Privileges>();
  const statements = sql.split('\n').map((line) => line.replace(/--.*$/, '')).join(' ')
    .split(';').map((statement) => statement.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const statement of statements) {
    const grant = /^GRANT (.+?) ON (control_plane\.\w+(?:, control_plane\.\w+)*) TO cp_runtime$/.exec(statement);
    if (!grant) continue;
    for (const table of grant[2].split(',').map((name) => name.trim().replace(/^control_plane\./, ''))) {
      const entry = tables.get(table) ?? { select: false, insert: false, update: new Set<string>() };
      for (const privilege of topLevel(grant[1])) {
        const parsed = /^(SELECT|INSERT|UPDATE)(?: \(([a-z_]+(?:, [a-z_]+)*)\))?$/.exec(privilege);
        if (!parsed) throw new Error(`Unrecognized privilege "${privilege}" in: ${statement}`);
        if (parsed[1] === 'SELECT') entry.select = true;
        if (parsed[1] === 'INSERT') entry.insert = true;
        if (parsed[1] === 'UPDATE') for (const column of parsed[2] ? parsed[2].split(', ') : ['*']) entry.update.add(column);
      }
      tables.set(table, entry);
    }
  }
  return tables;
}

/** What each recorded statement needs, per table (PostgreSQL's GRANT, INSERT, UPDATE and SELECT pages). */
export function needs(statements: string[]): Map<string, Privileges> {
  const tables = new Map<string, Privileges>();
  const entry = (table: string) => {
    const found = tables.get(table) ?? { select: false, insert: false, update: new Set<string>() };
    tables.set(table, found);
    return found;
  };
  for (const text of statements) {
    let match: RegExpExecArray | null;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || /^SET LOCAL \w+ = '[^']*'$/.test(text)) continue;
    if (text === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))') continue;
    if (text === 'SELECT id FROM control_plane.organizations WHERE id=$1 FOR UPDATE') {
      entry('organizations').select = true;
      entry('organizations').update.add('*');
      continue;
    }
    if ((match = /^INSERT INTO control_plane\.(\w+)\(/.exec(text))) {
      if (/ ON CONFLICT | RETURNING /.test(text)) throw new Error(`Name what this needs: ${text}`);
      entry(match[1]).insert = true;
    } else if ((match = /^UPDATE control_plane\.(\w+) SET (.+?) WHERE /.exec(text))) {
      for (const assignment of topLevel(match[2])) entry(match[1]).update.add(assignment.split('=')[0].trim());
      // The WHERE clause and RETURNING read the row.
      entry(match[1]).select = true;
    } else if ((match = /^SELECT .+? FROM control_plane\.(\w+) WHERE /.exec(text))) {
      if (/ FOR (UPDATE|SHARE)\b| JOIN /.test(text)) throw new Error(`Name what this needs: ${text}`);
      entry(match[1]).select = true;
    } else throw new Error(`Unrecognized statement: ${text}`);
  }
  return tables;
}

export const describePrivileges = (entry: Privileges | undefined) =>
  entry && { select: entry.select, insert: entry.insert, update: [...entry.update].sort() };
