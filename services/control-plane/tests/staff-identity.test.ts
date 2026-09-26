import { describe, expect, it } from 'vitest';
import type { AccountService } from '../src/account-service.js';
import { ConfigurationError, configuration, identityFor, type AccountPool } from '../src/config.js';
import { AccountError } from '../src/errors.js';
import type { ManagedInferenceService } from '../src/managed-inference.js';
import { createHandler } from '../src/worker.js';
import { validEnv } from './support/fixtures.js';

// Which pool a route belongs to: /ops/* is staff, every other route is customer.
// Staff sign in with staff keys since 2026-09-26 (tests/staff-keys.test.ts). The staff
// WorkOS environment settings below are still parsed, but /ops/* no longer reads them.

const STAFF_CLIENT = 'client_fixture_staff';
const STAFF_KEY = 'sk_test_fixture_staff_only_no_calls';
const staffEnv = { ...validEnv, STAFF_WORKOS_CLIENT_ID: STAFF_CLIENT, STAFF_WORKOS_API_KEY: STAFF_KEY };

const request = (method: string, path: string, token = 'opaque') =>
  new Request(`http://127.0.0.1:8791${path}`, { method, headers: { authorization: `Bearer ${token}` } });

describe('the staff environment in configuration', () => {
  const base = configuration(validEnv);

  it('is off unless both staff values are set, and never changes the customer environment', () => {
    expect(base.staffIdentity).toBeNull();
    expect(configuration(staffEnv)).toEqual({
      ...base,
      staffIdentity: { clientId: STAFF_CLIENT, issuer: validEnv.WORKOS_ISSUER, audience: validEnv.WORKOS_TOKEN_AUDIENCE, apiKey: STAFF_KEY },
    });
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ['no client', { STAFF_WORKOS_CLIENT_ID: undefined }, 'STAFF_WORKOS_CLIENT_ID', 'missing'],
    ['the blank client the wrangler files ship', { STAFF_WORKOS_CLIENT_ID: '' }, 'STAFF_WORKOS_CLIENT_ID', 'missing'],
    ['no key', { STAFF_WORKOS_API_KEY: undefined }, 'STAFF_WORKOS_API_KEY', 'missing'],
    ['a blank key', { STAFF_WORKOS_API_KEY: '' }, 'STAFF_WORKOS_API_KEY', 'missing'],
    ['a malformed client', { STAFF_WORKOS_CLIENT_ID: 'staff' }, 'STAFF_WORKOS_CLIENT_ID', 'format'],
    ['a padded client', { STAFF_WORKOS_CLIENT_ID: ` ${STAFF_CLIENT}` }, 'STAFF_WORKOS_CLIENT_ID', 'whitespace'],
    ['a client ending in a newline', { STAFF_WORKOS_CLIENT_ID: `${STAFF_CLIENT}\n` }, 'STAFF_WORKOS_CLIENT_ID', 'whitespace'],
    ['a non-string client', { STAFF_WORKOS_CLIENT_ID: 42 }, 'STAFF_WORKOS_CLIENT_ID', 'missing'],
    ['a malformed key', { STAFF_WORKOS_API_KEY: 'placeholder' }, 'STAFF_WORKOS_API_KEY', 'format'],
    ['a live key outside production', { STAFF_WORKOS_API_KEY: 'sk_live_fixture_staff_only_no_calls' }, 'STAFF_WORKOS_API_KEY', 'test-key-required'],
    ['the customer environment’s client', { STAFF_WORKOS_CLIENT_ID: validEnv.WORKOS_CLIENT_ID }, 'STAFF_WORKOS_CLIENT_ID', 'same-as-customer'],
    ['the customer environment’s key', { STAFF_WORKOS_API_KEY: validEnv.WORKOS_API_KEY }, 'STAFF_WORKOS_API_KEY', 'same-as-customer'],
  ])('is off with %s, names why, and the customer environment still reads', (_name, change, setting, rule) => {
    const config = configuration({ ...staffEnv, ...change });
    expect(config.staffIdentity).toBeNull();
    expect(config.staffProblem).toEqual({ setting, rule });
    expect({ ...config, staffProblem: undefined }).toEqual(base);
    expect(() => identityFor(config, 'staff')).toThrow(expect.objectContaining({ problem: { setting, rule } }));
  });

  it('takes a live key only in production, as the customer key does', () => {
    const live = 'sk_live_fixture_staff_only_no_calls';
    const production = { ...staffEnv, ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'https://accounts.diomedes.net', STAFF_WORKOS_API_KEY: live };
    expect(configuration(production).staffIdentity?.apiKey).toBe(live);
  });

  it('verifies each pool against its own environment, and refuses staff without one', () => {
    const config = configuration(staffEnv);
    expect(identityFor(config, 'customer')).toBe(config.identity);
    expect(identityFor(config, 'staff')).toBe(config.staffIdentity);
    expect(identityFor(base, 'customer')).toBe(base.identity);
    expect(() => identityFor(base, 'staff')).toThrow(ConfigurationError);
  });
});

describe('which environment a route verifies against', () => {
  it.each([
    ['GET', '/ops/me', 'staff'],
    ['GET', '/ops/customers', 'staff'],
    ['POST', '/ops/routing/publish', 'staff'],
    ['GET', '/ops/staff', 'staff'],
    ['POST', '/ops/session/revoke', 'staff'],
    ['GET', '/account/session', 'customer'],
    ['POST', '/account/session/revoke', 'customer'],
    ['POST', '/account/organizations/org_1/agent-admissions', 'customer'],
    ['GET', '/account/routing-policy', 'customer'],
  ])('%s %s is %s', async (method, path, pool) => {
    const pools: AccountPool[] = [];
    const handler = createHandler((_config, chosen) => { pools.push(chosen); throw new AccountError(401, 'Stopped after the pool was chosen.'); });
    expect((await handler(request(method, path), staffEnv)).status).toBe(401);
    expect(pools).toEqual([pool]);
  });

  it.each([
    ['POST', '/managed/v1/responses'],
    ['GET', '/managed/v1/attempts/attempt_1'],
  ])('the managed gateway (%s %s) is customer', async (method, path) => {
    const pools: AccountPool[] = [];
    const managed = { respond: async () => new Response('ok'), attempt: async () => new Response('ok') } as unknown as ManagedInferenceService;
    const handler = createHandler((_config, chosen) => { pools.push(chosen); return {} as AccountService; }, undefined,
      { createManaged: () => managed });
    expect((await handler(request(method, path), staffEnv)).status).toBe(200);
    expect(pools).toEqual(['customer']);
  });

  // What /ops/* does with its bearer, end to end, is in tests/staff-keys.test.ts.
});
