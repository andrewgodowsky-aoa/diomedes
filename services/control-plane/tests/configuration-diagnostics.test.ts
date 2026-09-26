import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, configuration } from '../src/config.js';
import { createHandler } from '../src/worker.js';
import { validEnv } from './support/fixtures.js';

// A secret can't be read back once it is set, so a refused configuration names the
// setting and the rule it broke in the Worker's log. Never the value.

const PASSWORD = 'fixture_password';
const DB = validEnv.DATABASE_URL;
const FUNDING = DB.replace('cp_runtime:', 'cp_funding:');

function refusal(env: Record<string, unknown>) {
  try { configuration(env); } catch (error) { return error; }
  throw new Error('The configuration was accepted.');
}

describe('a refused configuration names its setting and rule', () => {
  it.each<[string, Record<string, unknown>, string, string]>([
    ['no DATABASE_URL', { DATABASE_URL: undefined }, 'DATABASE_URL', 'missing'],
    ['a DATABASE_URL with a trailing newline', { DATABASE_URL: `${DB}\n` }, 'DATABASE_URL', 'whitespace'],
    ['a psql command instead of the URL', { DATABASE_URL: `psql '${DB}'` }, 'DATABASE_URL', 'not-a-url'],
    ['an .env line instead of the URL', { DATABASE_URL: `DATABASE_URL=${DB}` }, 'DATABASE_URL', 'not-a-url'],
    ['postgres:// instead of postgresql://', { DATABASE_URL: DB.replace('postgresql:', 'postgres:') }, 'DATABASE_URL', 'scheme'],
    ['a host outside Neon', { DATABASE_URL: DB.replace('ep-fixture.us-east-2.aws.neon.tech', 'db.example.com') }, 'DATABASE_URL', 'host'],
    ['the owner login', { DATABASE_URL: DB.replace('cp_runtime:', 'neondb_owner:') }, 'DATABASE_URL', 'login'],
    ['a short password', { DATABASE_URL: DB.replace(PASSWORD, 'short') }, 'DATABASE_URL', 'password-length'],
    ['no sslmode', { DATABASE_URL: DB.replace('?sslmode=require', '') }, 'DATABASE_URL', 'sslmode'],
    ['an extra parameter', { DATABASE_URL: `${DB}&options=x` }, 'DATABASE_URL', 'parameters'],
    ['another port', { DATABASE_URL: DB.replace('.neon.tech/', '.neon.tech:6543/') }, 'DATABASE_URL', 'port'],
    ['a key with an = in it', { WORKOS_API_KEY: 'sk_test_fixture_only_no_service_calls==' }, 'WORKOS_API_KEY', 'format'],
    ['a live key on staging', { WORKOS_API_KEY: 'sk_live_fixture_only_no_service_calls' }, 'WORKOS_API_KEY', 'test-key-required'],
    ['no WorkOS key', { WORKOS_API_KEY: '' }, 'WORKOS_API_KEY', 'missing'],
    ['a malformed client', { WORKOS_CLIENT_ID: 'client' }, 'WORKOS_CLIENT_ID', 'format'],
    ['an unparseable issuer', { WORKOS_ISSUER: 'api.workos.com' }, 'WORKOS_ISSUER', 'not-a-url'],
    ['an unknown environment', { ENVIRONMENT: 'dev' }, 'ENVIRONMENT', 'value'],
    ['an origin with a path', { ALLOWED_ORIGINS: 'http://127.0.0.1:8791/app' }, 'ALLOWED_ORIGINS', 'origin'],
  ])('%s', (_name, change, setting, rule) => {
    const error = refusal({ ...validEnv, ...change });
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).problem).toEqual({ setting, rule });
    expect((error as Error).message).toBe('Account service configuration is unavailable.');
  });

  it.each<[string, string, string]>([
    ['a psql command', `psql '${FUNDING}'`, 'not-a-url'],
    ['the Worker login', DB, 'login'],
    ['another database', FUNDING.replace('/neondb?', '/otherdb?'), 'other-database'],
    ['a padded URL', ` ${FUNDING}`, 'whitespace'],
  ])('names why FUNDING_DATABASE_URL is off with %s, without refusing the account routes', (_name, value, rule) => {
    const config = configuration({ ...validEnv, FUNDING_DATABASE_URL: value });
    expect(config.fundingDatabaseUrl).toBeNull();
    expect(config.fundingProblem).toBe(rule);
  });

  it('names nothing when an optional setting is simply unset', () => {
    const config = configuration(validEnv);
    expect(config.fundingProblem).toBeUndefined();
    expect(config.staffProblem).toBeUndefined();
  });
});

describe('the Worker logs the setting and rule, never the value', () => {
  const request = (path: string) => new Request(`http://127.0.0.1:8791${path}`, { headers: { authorization: 'Bearer opaque' } });

  it('on the account routes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await createHandler()(request('/account/session'), { ...validEnv, DATABASE_URL: DB.replace('postgresql:', 'postgres:') });
    expect(response.status).toBe(503);
    const lines = errors.mock.calls.map(([line]) => String(line));
    expect(lines).toContain(JSON.stringify({ event: 'control-plane-unavailable', setting: 'DATABASE_URL', rule: 'scheme' }));
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it('on the managed gateway', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = 'sk_test_fixture_only_no_service_calls==';
    const response = await createHandler()(new Request('http://127.0.0.1:8791/managed/v1/responses', { method: 'POST' }), { ...validEnv, WORKOS_API_KEY: key });
    expect(response.status).toBe(503);
    const lines = errors.mock.calls.map(([line]) => String(line));
    expect(lines).toContain(JSON.stringify({ event: 'managed-configuration-unavailable', setting: 'WORKOS_API_KEY', rule: 'format' }));
    expect(lines.join('\n')).not.toContain(key);
  });

  it('on the staff routes, naming the staff setting', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = 'sk_test_fixture staff key';
    const env = { ...validEnv, STAFF_WORKOS_CLIENT_ID: 'client_fixture_staff', STAFF_WORKOS_API_KEY: key };
    expect((await createHandler()(request('/ops/me'), env)).status).toBe(503);
    const lines = errors.mock.calls.map(([line]) => String(line));
    expect(lines).toContain(JSON.stringify({ event: 'staff-identity-unavailable', setting: 'STAFF_WORKOS_API_KEY', rule: 'format' }));
    expect(lines).toContain(JSON.stringify({ event: 'control-plane-unavailable', setting: 'STAFF_WORKOS_API_KEY', rule: 'format' }));
    expect(lines.join('\n')).not.toContain(key);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
