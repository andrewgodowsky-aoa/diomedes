/**
 * scripts/funding-permissions.sql against the SQL the managed gateway actually
 * runs as cp_funding.
 *
 * 1. The gateway runs its funding paths over the faux cloud's store, through a
 *    recording repository: a first call in a new month (so the month's credit
 *    is allocated), a retry naming its parent, a settled call under the company
 *    ceiling, a provider 429 (released), a provider 500 (parked uncertain), a
 *    replay, and a read of an attempt. Every FundingTransaction call is kept
 *    with its arguments.
 * 2. Every recorded call is replayed on PostgresFundingTransaction over a
 *    recording SQL client, so the statements are exactly the ones Postgres
 *    would receive, and each statement is reduced to the privileges it needs.
 * 3. The needs and the grant file must match both ways: a write without a
 *    grant fails, and so does a grant nothing uses.
 *
 * A guard reads the gateway's and FundingService's source for every funding
 * call on the gateway's paths, in every branch, and fails if the scenarios in
 * step 1 do not reach them all, so a write added in an untested branch cannot
 * slip past step 3.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import { FundingService, type FundingRepository } from '../src/funding.js';
import { PostgresFundingTransaction } from '../src/funding-postgres.js';
import { ManagedInferenceService } from '../src/managed-inference.js';
import { MANAGED_PROVIDERS, bedrockResponsesCaller, scriptedResponsesFetch } from '../src/managed-providers.js';
import type { SqlClient } from '../src/postgres.js';
import { providerSpy, readAll, type ProviderRequest } from './support/managed.js';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const FUNDING_SQL = read('../scripts/funding-permissions.sql');
const RUNTIME_SQL = read('../scripts/runtime-permissions.sql');
const GATEWAY_SOURCE = read('../src/managed-inference.ts');
const FUNDING_SOURCE = read('../src/funding.ts');

/** The migration 002/003 funding tables. */
const FUNDING_TABLES = ['credit_periods', 'funded_jobs', 'funded_job_refs', 'job_cap_requests', 'funding_accounts',
  'funding_reservations', 'funding_settlements', 'credit_adjustments', 'credit_topups'];

// --- the grant file --------------------------------------------------------------------------

interface TablePrivileges { select: boolean; insert: boolean; update: Set<string> }
interface GrantFile { revokedSchema: boolean; schemaUsage: boolean; revokedTables: boolean; tables: Map<string, TablePrivileges> }

/** Statements with comments removed and whitespace collapsed. */
function statements(sql: string): string[] {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join(' ')
    .split(';').map((statement) => statement.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

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

/** Reads a permissions template. Anything but the four accepted shapes is an error, never skipped. */
function parseGrants(sql: string, role: string): GrantFile {
  const file: GrantFile = { revokedSchema: false, schemaUsage: false, revokedTables: false, tables: new Map() };
  for (const statement of statements(sql)) {
    if (statement === `REVOKE ALL ON SCHEMA control_plane FROM ${role}`) { file.revokedSchema = true; continue; }
    if (statement === `GRANT USAGE ON SCHEMA control_plane TO ${role}`) { file.schemaUsage = true; continue; }
    if (statement === `REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM ${role}`) { file.revokedTables = true; continue; }
    const grant = /^GRANT (.+?) ON (control_plane\.\w+(?:, control_plane\.\w+)*) TO (\w+)$/.exec(statement);
    if (!grant || grant[3] !== role) throw new Error(`Unrecognized statement: ${statement}`);
    const tables = grant[2].split(',').map((table) => table.trim().replace(/^control_plane\./, ''));
    for (const privilege of topLevel(grant[1])) {
      const parsed = /^(SELECT|INSERT|UPDATE)(?: \(([a-z_]+(?:, [a-z_]+)*)\))?$/.exec(privilege);
      if (!parsed || (parsed[1] !== 'UPDATE' && parsed[2])) throw new Error(`Unrecognized privilege "${privilege}" in: ${statement}`);
      for (const table of tables) {
        const entry = file.tables.get(table) ?? { select: false, insert: false, update: new Set<string>() };
        if (parsed[1] === 'SELECT') entry.select = true;
        if (parsed[1] === 'INSERT') entry.insert = true;
        if (parsed[1] === 'UPDATE') for (const column of parsed[2] ? parsed[2].split(', ') : ['*']) entry.update.add(column);
        file.tables.set(table, entry);
      }
    }
  }
  return file;
}

// --- what a statement needs --------------------------------------------------------------------

type Need =
  | { table: string; privilege: 'SELECT' | 'INSERT'; source: string }
  | { table: string; privilege: 'UPDATE'; columns: string[]; source: string }
  /** A row lock (FOR UPDATE) needs UPDATE on at least one column. */
  | { table: string; privilege: 'LOCK'; source: string };

const tablesIn = (sql: string) => [...sql.matchAll(/\bcontrol_plane\.(\w+)/g)].map((match) => match[1]);
const setColumns = (list: string) => topLevel(list).map((assignment) => assignment.split('=')[0].trim());

/**
 * The privileges one statement needs (PostgreSQL's GRANT, INSERT, UPDATE and
 * SELECT reference pages). A statement shape this does not know fails the test.
 */
function needsOf(sql: string, source: string): Need[] {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || /^SET LOCAL \w+ = '[^']*'$/.test(text)) return [];
  if (text === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))') return [];
  let match: RegExpExecArray | null;
  if ((match = /^INSERT INTO control_plane\.(\w+) ?\(/.exec(text))) {
    const table = match[1];
    const needs: Need[] = [{ table, privilege: 'INSERT', source }];
    const conflict = / ON CONFLICT \([^)]*\) DO UPDATE SET (.+?)(?: WHERE .*)?$/.exec(text);
    if (conflict) needs.push({ table, privilege: 'UPDATE', columns: setColumns(conflict[1]), source });
    else if (/ ON CONFLICT /.test(text)) throw new Error(`Unrecognized ON CONFLICT: ${text}`);
    // The conflict target, the SET expressions and RETURNING read the table; a sub-select reads its own.
    if (conflict || / RETURNING /.test(text)) needs.push({ table, privilege: 'SELECT', source });
    for (const other of tablesIn(text).filter((name) => name !== table)) needs.push({ table: other, privilege: 'SELECT', source });
    return needs;
  }
  if ((match = /^UPDATE control_plane\.(\w+) SET (.+?) WHERE /.exec(text))) {
    const table = match[1];
    return [{ table, privilege: 'UPDATE', columns: setColumns(match[2]), source },
      ...[...new Set(tablesIn(text))].map((name): Need => ({ table: name, privilege: 'SELECT', source }))];
  }
  if (/^SELECT /.test(text)) {
    const tables = [...new Set(tablesIn(text))];
    if (!tables.length) throw new Error(`A SELECT that reads no table: ${text}`);
    const needs: Need[] = tables.map((table) => ({ table, privilege: 'SELECT', source }));
    if (/ FOR (UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/.test(text)) needs.push(...tables.map((table): Need => ({ table, privilege: 'LOCK', source })));
    return needs;
  }
  throw new Error(`Unrecognized statement; name its privilege here and in funding-permissions.sql: ${text}`);
}

/** One line per table, in a fixed order, so a failure reads as a diff of the grant file. */
function describeTables(tables: Map<string, TablePrivileges>): string[] {
  return [...tables.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([table, entry]) => {
    const privileges = [entry.select && 'SELECT', entry.insert && 'INSERT',
      entry.update.size && `UPDATE (${[...entry.update].sort().join(', ')})`].filter(Boolean);
    return `${table}: ${privileges.join(', ')}`;
  });
}

// --- the gateway's paths, statically --------------------------------------------------------------

const names = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map((match) => match[1]));

/** The text inside the parentheses that open at `open`. */
function parenthesized(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '(') depth++;
    if (text[at] === ')' && --depth === 0) return text.slice(open + 1, at);
  }
  throw new Error('Unbalanced parentheses in the gateway source.');
}

const FUNDING_SERVICE = FUNDING_SOURCE.slice(FUNDING_SOURCE.indexOf('export class FundingService'), FUNDING_SOURCE.indexOf('export class UsageService'));
const memberStart = (name: string) => new RegExp(`^  (?:private )?(?:async )?${name}\\(`, 'm');

/** A FundingService member's body: from its signature to the class-level closing brace. */
function memberBody(name: string): string {
  const start = memberStart(name).exec(FUNDING_SERVICE);
  if (!start) throw new Error(`FundingService.${name} was not found.`);
  return FUNDING_SERVICE.slice(start.index, FUNDING_SERVICE.indexOf('\n  }\n', start.index));
}

/** Every FundingTransaction method a FundingService member can call, through its private helpers too. */
function transactionCalls(name: string, seen = new Set<string>()): Set<string> {
  const calls = new Set<string>();
  if (seen.has(name)) return calls;
  seen.add(name);
  const body = memberBody(name);
  for (const call of names(body, /\btx\.(\w+)\(/g)) calls.add(call);
  for (const helper of names(body, /\bthis\.(\w+)\(/g))
    if (memberStart(helper).test(FUNDING_SERVICE)) for (const call of transactionCalls(helper, seen)) calls.add(call);
  return calls;
}

/** FundingService methods the gateway calls, and the FundingTransaction calls it makes itself through fundingReads. */
const GATEWAY_SERVICE_CALLS = names(GATEWAY_SOURCE, /this\.options\.funding\.(\w+)\(/g);
const GATEWAY_DIRECT_READS = new Set([...GATEWAY_SOURCE.matchAll(/this\.options\.fundingReads\.transaction\(/g)]
  .flatMap((match) => [...names(parenthesized(GATEWAY_SOURCE, match.index + match[0].length - 1), /\btx\.(\w+)\(/g)]));
const STATIC_TRANSACTION_CALLS = new Set([...GATEWAY_SERVICE_CALLS].flatMap((name) => [...transactionCalls(name)]).concat([...GATEWAY_DIRECT_READS]));

// --- the gateway's paths, run -------------------------------------------------------------------

const LUNA = MANAGED_PROVIDERS[0];

/** Wraps each method so its name (and arguments) are recorded before it runs on the real object. */
function recorded<T extends object>(target: T, record: (method: string, args: unknown[]) => void): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        record(String(property), args);
        return (value as (...values: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

async function runGatewayPaths() {
  let clock = Date.parse('2026-09-25T12:00:00.000Z');
  const now = () => clock;
  const scripted = scriptedResponsesFetch({ now });
  let answer = (request: ProviderRequest): Response | Promise<Response> =>
    scripted(request.url, { method: 'POST', headers: request.headers, body: request.rawBody });
  const spy = providerSpy((request) => answer(request));
  const cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000, managed: { transport: spy.fetch } });
  const { organizations } = await seedDemo(cloud);
  const organizationId = organizations!.juniper;
  // The seed funded September only; October's credit is allocated by the first call that needs it.
  clock = Date.parse('2026-10-02T09:00:00.000Z');

  const transactionLog: { method: string; args: unknown[] }[] = [];
  const serviceLog = new Set<string>();
  const repository: FundingRepository = {
    transaction: (action) => cloud.store.funding.transaction((tx) =>
      action(recorded(tx, (method, args) => transactionLog.push({ method, args: structuredClone(args) })))),
  };
  const funding = recorded(new FundingService(repository, { now }), (method) => serviceLog.add(method));
  const gateway = new ManagedInferenceService({
    accounts: cloud.accounts, commercial: cloud.store.commercial, funding, fundingReads: repository,
    caller: bedrockResponsesCaller(spy.fetch), now,
  });
  const env = { BEDROCK_API_KEY: 'ABSK-permissions-fixture', MANAGED_SPEND_CEILING_MICRO_USD: '100000000' };

  const signIn = await cloud.handle(new Request('http://faux/auth/sign-in', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS.employee.email, password: FAUX_DEMO_PASSWORD }),
  }));
  const token = (await signIn.json()).accessToken as string;
  const admission = await cloud.commercial.admitAgent(token, organizationId, { surface: 'conversation', routeKind: 'managed', rootJobId: 'run-1' });
  const ask = async (attempt: string, parent?: string) => {
    const response = await gateway.respond(new Request('http://127.0.0.1:8791/managed/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'x-nectovia-organization': organizationId, 'x-nectovia-admission': admission.admissionId, 'x-nectovia-job': 'run-1',
        'x-nectovia-attempt': attempt, 'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'included-chat',
        'x-nectovia-policy-revision': '1', ...(parent ? { 'x-nectovia-parent-attempt': parent } : {}),
      },
      body: JSON.stringify({ model: LUNA.model, input: [{ role: 'user', content: 'Hello.' }], store: false, stream: true }),
    }), env);
    await readAll(response.body);
    await gateway.idle();
    return response.status;
  };

  const statuses = {
    first: await ask('run-1:1'),
    retry: await ask('run-1:2', 'run-1:1'),
    busy: await (async () => {
      answer = () => Response.json({ error: { message: 'Slow down.' } }, { status: 429 });
      return ask('run-1:3');
    })(),
    failed: await (async () => {
      answer = () => new Response('upstream failure', { status: 500 });
      return ask('run-1:4');
    })(),
    replayed: await ask('run-1:1'),
    read: (await gateway.attempt(new Request('http://127.0.0.1:8791/managed/v1/attempts/run-1:1', {
      headers: { authorization: `Bearer ${token}`, 'x-nectovia-organization': organizationId },
    }), 'run-1:1')).status,
  };
  const states = Object.fromEntries(cloud.store.snapshot().funding.attempts.map((row) => [row.id, row.state]));
  const periods = cloud.store.snapshot().funding.periods.filter((row) => row.organizationId === organizationId).map((row) => row.periodId);
  return { statuses, states, periods, providerCalls: spy.calls.length, transactionLog, serviceLog };
}

/** Replays each recorded call on the SQL adapter and returns the statements it sent. */
async function replay(log: readonly { method: string; args: unknown[] }[]) {
  const sent: { method: string; sql: string }[] = [];
  for (const call of log) {
    const statements: string[] = [];
    const client: SqlClient = {
      async connect() {},
      async end() {},
      async query(sql) { statements.push(sql); return { rows: [], rowCount: 1 }; },
    };
    const tx = new PostgresFundingTransaction(client) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    if (typeof tx[call.method] !== 'function') throw new Error(`PostgresFundingTransaction has no ${call.method}.`);
    // An empty answer may not parse into a row; only the statement sent matters here.
    await tx[call.method](...call.args).catch(() => undefined);
    if (!statements.length) throw new Error(`${call.method} sent no statement.`);
    sent.push(...statements.map((sql) => ({ method: call.method, sql })));
  }
  return sent;
}

// --- the tests -------------------------------------------------------------------------------------

describe('cp_funding (scripts/funding-permissions.sql)', () => {
  const grants = parseGrants(FUNDING_SQL, 'cp_funding');

  it('is a review template in the runtime template’s shape: schema usage only, everything revoked first, three privileges at most', () => {
    expect(FUNDING_SQL.split('\n').slice(0, 3)).toEqual([
      '-- REVIEW TEMPLATE ONLY. Run as the schema owner on an approved isolated DB.',
      '-- Provision the login cp_funding and its secret separately; this creates no role.',
      '-- Grant no ownership, CREATE, DELETE, TRUNCATE or credential-table access.',
    ]);
    expect(grants).toMatchObject({ revokedSchema: true, schemaUsage: true, revokedTables: true });
    const code = statements(FUNDING_SQL).join(';\n');
    expect(code).not.toMatch(/\b(DELETE|TRUNCATE|CREATE|OWNER|ALTER|REFERENCES|TRIGGER|MAINTAIN|PRIVILEGES|OPTION|EXECUTE|cp_runtime)\b/);
    for (const table of grants.tables.keys()) expect(FUNDING_TABLES).toContain(table);
  });

  it('grants exactly what PostgresFundingRepository runs on the gateway’s paths, and nothing else', async () => {
    const run = await runGatewayPaths();
    // The scenarios did what they are for.
    expect(run.statuses).toEqual({ first: 200, retry: 200, busy: 429, failed: 503, replayed: 409, read: 200 });
    expect(run.states).toEqual({ 'run-1:1': 'settled', 'run-1:2': 'settled', 'run-1:3': 'released', 'run-1:4': 'uncertain' });
    expect(run.periods).toEqual(['2026-09', '2026-10']);
    expect(run.providerCalls).toBe(4);

    // Every funding call the gateway's source can make, in any branch, was run.
    expect([...run.serviceLog].sort()).toEqual([...GATEWAY_SERVICE_CALLS].sort());
    expect([...new Set(run.transactionLog.map((call) => call.method))].sort()).toEqual([...STATIC_TRANSACTION_CALLS].sort());

    const sent = await replay(run.transactionLog);
    const needs = sent.flatMap((statement) => needsOf(statement.sql, statement.method));
    const required = new Map<string, TablePrivileges>();
    for (const need of needs) {
      const entry = required.get(need.table) ?? { select: false, insert: false, update: new Set<string>() };
      if (need.privilege === 'SELECT') entry.select = true;
      if (need.privilege === 'INSERT') entry.insert = true;
      if (need.privilege === 'UPDATE') for (const column of need.columns) entry.update.add(column);
      required.set(need.table, entry);
    }
    // Both ways: a statement without its grant fails, and so does a grant no statement uses.
    expect(describeTables(grants.tables)).toEqual(describeTables(required));
    // A row lock needs UPDATE on at least one column of the table it locks.
    const unlockable = needs.filter((need) => need.privilege === 'LOCK' && !grants.tables.get(need.table)?.update.size);
    expect(unlockable).toEqual([]);
    // The list, as the owner reviews it.
    expect(describeTables(grants.tables)).toEqual([
      'credit_adjustments: SELECT',
      'credit_periods: SELECT, INSERT',
      'credit_topups: SELECT',
      'funded_job_refs: SELECT, INSERT',
      'funded_jobs: SELECT, INSERT, UPDATE (cap_generation, cap_micro_usd, state)',
      'funding_reservations: SELECT, INSERT, UPDATE (dispatched_at, resolved_at, state, uncertain_reason)',
      'funding_settlements: SELECT, INSERT',
    ]);
  });

  it('fails a write without a grant, and a statement it cannot read', () => {
    const needs = needsOf('INSERT INTO control_plane.credit_adjustments(tenant_id,adjustment_id) VALUES ($1,$2)', 'saveAdjustment');
    expect(needs).toEqual([{ table: 'credit_adjustments', privilege: 'INSERT', source: 'saveAdjustment' }]);
    expect(grants.tables.get('credit_adjustments')?.insert).toBe(false);
    expect(needsOf("UPDATE control_plane.funding_reservations SET reserved_micro_usd=$3 WHERE tenant_id=$1 AND reservation_id=$2", 'rewrite'))
      .toContainEqual({ table: 'funding_reservations', privilege: 'UPDATE', columns: ['reserved_micro_usd'], source: 'rewrite' });
    expect(grants.tables.get('funding_reservations')?.update.has('reserved_micro_usd')).toBe(false);
    expect(() => needsOf('DELETE FROM control_plane.funding_reservations WHERE tenant_id=$1', 'delete')).toThrow(/Unrecognized statement/);
    expect(() => parseGrants('GRANT DELETE ON control_plane.funding_reservations TO cp_funding;', 'cp_funding')).toThrow(/Unrecognized privilege/);
    expect(() => parseGrants('GRANT SELECT ON control_plane.persons TO cp_runtime;', 'cp_funding')).toThrow(/Unrecognized statement/);
  });

  it('leaves the Worker login cp_runtime able only to read funding rows', () => {
    const runtime = parseGrants(RUNTIME_SQL, 'cp_runtime');
    for (const table of FUNDING_TABLES) {
      const entry = runtime.tables.get(table);
      if (entry) expect({ table, insert: entry.insert, update: [...entry.update] }).toEqual({ table, insert: false, update: [] });
    }
    expect(RUNTIME_SQL).toContain('belong to a separately reviewed runtime role, never to the Worker login.');
  });
});
