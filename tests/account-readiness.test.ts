import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkAccountReadiness, readReadinessConfiguration, type ReadinessConfiguration } from '../scripts/account-readiness';

const config: ReadinessConfiguration = {
  url: 'https://accounts.fixture.invalid', callback: 'diomedes-auth://callback',
  workos: { clientId: 'client_readiness_fixture', issuer: 'https://api.workos.com', audience: 'https://accounts.fixture.invalid' },
};
const key = { ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), kid: 'fixture_key', alg: 'RS256' };
const hosted = 'https://fixture-staging.authkit.app';
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
type Override = (url: URL, request: Request) => Response | undefined;

function fixture(override: Override = () => undefined) {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (request: Request) => {
      requests.push(request);
      const url = new URL(request.url);
      const changed = override(url, request);
      if (changed) return changed;
      if (url.origin === config.url && url.pathname === '/account/session')
        return Response.json({ error: 'A verified bearer session is required.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
      if (url.origin !== 'https://api.workos.com') throw new Error('Unexpected origin.');
      if (url.pathname === `/sso/jwks/${config.workos.clientId}`) return Response.json({ keys: [key] });
      if (url.pathname === '/user_management/authorize')
        return redirect(`${hosted}/${url.searchParams.get('redirect_uri') === config.callback ? 'bootstrap' : 'redirect-uri-invalid'}?state=private-fixture-state`);
      throw new Error('Unexpected request.');
    },
  };
}

describe('account deployment readiness', () => {
  it('reads the callback and deployment that the real desktop and Worker use', async () => {
    const found = await readReadinessConfiguration();
    expect(found.callback).toBe('diomedes-auth://callback');
    expect(found.workos.clientId).toMatch(/^client_/);
    expect(found.url).toBe('https://accounts.diomedes.net');
  });

  it('checks four public boundaries without following redirects or sending credentials', async () => {
    const transport = fixture();
    const result = await checkAccountReadiness(config, transport.fetch);
    expect(result.status).toBe('configuration-checks-passed');
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.unverified).toHaveLength(3);
    expect(transport.requests).toHaveLength(4);
    for (const request of transport.requests) {
      expect(request.method).toBe('GET');
      expect(request.redirect).toBe('manual');
      expect(request.credentials).toBe('omit');
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.headers.has('cookie')).toBe(false);
    }
    const authorizations = transport.requests.map((request) => new URL(request.url)).filter((url) => url.pathname.endsWith('/authorize'));
    const states = authorizations.map((url) => url.searchParams.get('state'));
    expect(new Set(states).size).toBe(2);
    for (const url of authorizations) {
      expect(url.searchParams.get('client_id')).toBe(config.workos.clientId);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
      expect(url.searchParams.has('client_secret')).toBe(false);
      expect(url.searchParams.has('code_verifier')).toBe(false);
      expect(JSON.stringify(result)).not.toContain(url.searchParams.get('state'));
    }
    expect(JSON.stringify(result)).not.toContain('private-fixture-state');
  });

  it('reproduces the live missing-callback failure even though WorkOS returns HTTP 302', async () => {
    const transport = fixture((url) => url.searchParams.get('redirect_uri') === config.callback
      ? redirect(`${hosted}/redirect-uri-invalid`) : undefined);
    const result = await checkAccountReadiness(config, transport.fetch);
    expect(result.status).toBe('blocked');
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(['desktop-callback']);
  });

  it.each([
    'https://authkit.app.attacker.invalid/bootstrap',
    'https://fixture-staging.authkit.app.attacker.invalid/bootstrap',
    'http://fixture-staging.authkit.app/bootstrap',
    'https://fixture-staging.authkit.app/bootstrap?error=invalid_client',
    'https://user:password@fixture-staging.authkit.app/bootstrap',
  ])('refuses an unexpected hosted sign-in destination: %s', async (destination) => {
    const result = await checkAccountReadiness(config, fixture((url) => url.searchParams.get('redirect_uri') === config.callback ? redirect(destination) : undefined).fetch);
    expect(result.checks.find((check) => check.name === 'desktop-callback')?.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain(destination);
  });

  it('blocks if the negative control is accepted', async () => {
    const result = await checkAccountReadiness(config, fixture((url) => url.pathname.endsWith('/authorize') ? redirect(`${hosted}/bootstrap`) : undefined).fetch);
    expect(result.status).toBe('blocked');
    expect(result.checks.find((check) => check.name === 'unregistered-callback')?.passed).toBe(false);
  });

  it.each([200, 302, 403, 503])('does not mistake account-service HTTP %i for readiness', async (status) => {
    const result = await checkAccountReadiness(config, fixture((url) => url.origin === config.url ? new Response('secret-error-body', { status }) : undefined).fetch);
    expect(result.status).toBe('blocked');
    expect(result.checks.find((check) => check.name === 'account-service')?.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-error-body');
  });

  it('refuses cacheable or unrelated 401 responses', async () => {
    for (const response of [
      Response.json({ error: 'A verified bearer session is required.' }, { status: 401 }),
      Response.json({ error: 'An unrelated service.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } }),
    ]) {
      const result = await checkAccountReadiness(config, fixture((url) => url.origin === config.url ? response : undefined).fetch);
      expect(result.checks.find((check) => check.name === 'account-service')?.passed).toBe(false);
    }
  });

  it.each([{ keys: [] }, { keys: [{ ...key, d: 'private' }] }, { keys: [{ ...key, alg: 'HS256' }] }, { keys: [{ kty: 'RSA', kid: 'invalid' }] }])('refuses an unusable signing-key set', async (payload) => {
    const result = await checkAccountReadiness(config, fixture((url) => url.pathname.includes('/jwks/') ? Response.json(payload) : undefined).fetch);
    expect(result.checks.find((check) => check.name === 'workos-keys')?.passed).toBe(false);
  });

  it('bounds response bodies and reports transport failures without raw provider details', async () => {
    const large = await checkAccountReadiness(config, fixture((url) => url.pathname.includes('/jwks/') ? new Response('x'.repeat(131_073)) : undefined).fetch);
    expect(large.checks.find((check) => check.name === 'workos-keys')?.passed).toBe(false);
    const failed = await checkAccountReadiness(config, async () => { throw new Error('secret-response-and-token'); });
    expect(failed.status).toBe('blocked');
    expect(failed.checks.every((check) => !check.passed)).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('secret-response-and-token');
  });
});
