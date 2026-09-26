import { describe, expect, it, vi } from 'vitest';
import { AccountService } from '../src/account-service.js';
import { CommercialService } from '../src/commercial.js';
import { ConfigurationError, configuration, identityFor, type AccountPool, type Configuration } from '../src/config.js';
import { AccountError } from '../src/errors.js';
import { FauxCloudStore } from '../src/faux/store.js';
import { createWorkOSStandIn } from '../src/faux/workos-standin.js';
import { FundingService } from '../src/funding.js';
import { WorkOSIdentityVerifier } from '../src/identity-workos.js';
import type { ManagedInferenceService } from '../src/managed-inference.js';
import { createHandler } from '../src/worker.js';
import { validEnv } from './support/fixtures.js';

// Customers (Nectovia) and staff (Diomedes Systems) sign in through two WorkOS
// environments, each with its own branded page, users and keys. /ops/* accepts only
// the staff environment; every other route accepts only the customer environment.

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

  it.each<[string, Record<string, unknown>]>([
    ['no client', { STAFF_WORKOS_CLIENT_ID: undefined }],
    ['the blank client the wrangler files ship', { STAFF_WORKOS_CLIENT_ID: '' }],
    ['no key', { STAFF_WORKOS_API_KEY: undefined }],
    ['a blank key', { STAFF_WORKOS_API_KEY: '' }],
    ['a malformed client', { STAFF_WORKOS_CLIENT_ID: 'staff' }],
    ['a padded client', { STAFF_WORKOS_CLIENT_ID: ` ${STAFF_CLIENT}` }],
    ['a client ending in a newline', { STAFF_WORKOS_CLIENT_ID: `${STAFF_CLIENT}\n` }],
    ['a non-string client', { STAFF_WORKOS_CLIENT_ID: 42 }],
    ['a malformed key', { STAFF_WORKOS_API_KEY: 'placeholder' }],
    ['a live key outside production', { STAFF_WORKOS_API_KEY: 'sk_live_fixture_staff_only_no_calls' }],
    ['the customer environment’s client', { STAFF_WORKOS_CLIENT_ID: validEnv.WORKOS_CLIENT_ID }],
    ['the customer environment’s key', { STAFF_WORKOS_API_KEY: validEnv.WORKOS_API_KEY }],
  ])('is off with %s, and the customer environment still reads', (_name, change) => {
    const config = configuration({ ...staffEnv, ...change });
    expect(config.staffIdentity).toBeNull();
    expect(config).toEqual(base);
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

  it('refuses /ops/* with 503 when no staff environment is configured, before any provider call', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await createHandler()(request('GET', '/ops/me'), validEnv);
    expect(response.status).toBe(503);
    expect(errors.mock.calls.map(([line]) => line)).toContain(JSON.stringify({ event: 'staff-identity-unavailable' }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('two WorkOS environments, end to end', () => {
  async function environments() {
    const customers = await createWorkOSStandIn({ clientId: 'client_standin_customers' });
    const staff = await createWorkOSStandIn({ clientId: 'client_standin_staff', apiKey: 'sk_test_standin_staff_environment_0000' });
    const env = {
      ...validEnv,
      WORKOS_CLIENT_ID: customers.clientId, WORKOS_API_KEY: customers.apiKey, WORKOS_TOKEN_AUDIENCE: customers.audience,
      STAFF_WORKOS_CLIENT_ID: staff.clientId, STAFF_WORKOS_API_KEY: staff.apiKey,
    };
    const store = await FauxCloudStore.open(null);
    const provider = { customer: customers, staff };
    // The Worker's own composition, with only the verifier's transport pointed at each stand-in.
    const accounts = (config: Configuration, pool: AccountPool) =>
      new AccountService(store.accounts, new WorkOSIdentityVerifier({ ...identityFor(config, pool), fetch: provider[pool].fetch }));
    const handler = createHandler(accounts, undefined, {
      createCommercial: (_config, verified) => new CommercialService(verified, store.commercial, new FundingService(store.funding)),
    });
    const call = (method: string, path: string, token: string) => handler(request(method, path, token), env);
    const customer = (await customers.signInDirect('owner@juniper.example')).access_token;
    const operator = (await staff.signInDirect('andrew@diomedes.example')).access_token;
    return { call, customer, operator };
  }

  it('keeps each sign-in to its own routes', async () => {
    const { call, customer, operator } = await environments();
    expect((await call('GET', '/account/session', customer)).status).toBe(200);
    expect((await call('GET', '/ops/me', customer)).status).toBe(401);
    expect((await call('GET', '/account/session', operator)).status).toBe(401);
    // The staff environment verified the bearer; the role check refuses a person who isn't staff.
    const me = await call('GET', '/ops/me', operator);
    expect(me.status).toBe(403);
    expect(await me.json()).toEqual({ error: 'This account is not a Diomedes staff account.' });
  });

  it('signs a staff session out only through /ops/session/revoke', async () => {
    const { call, customer, operator } = await environments();
    expect((await call('POST', '/ops/session/revoke', customer)).status).toBe(401);
    expect((await call('POST', '/account/session/revoke', operator)).status).toBe(401);
    expect((await call('POST', '/ops/session/revoke', operator)).status).toBe(204);
    expect((await call('GET', '/ops/me', operator)).status).toBe(401);
    expect((await call('GET', '/account/session', customer)).status).toBe(200);
  });
});
