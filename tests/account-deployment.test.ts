/**
 * Which account service a build signs people in to, and the WorkOS sign-in it opens (task 4).
 *
 * A packaged build signs people in to the deployed account service named in the repository's
 * wrangler.jsonc, through WorkOS in the system browser. It never falls back to the faux cloud, even
 * when the deployed service does not answer and a faux cloud does. Development, tests and
 * DIOMEDES_TEST_MODE keep the faux cloud as before.
 *
 * The deployed service is the Worker's own handler (services/control-plane/src/worker.ts), which
 * refuses before it reads any account, or a fetcher that refuses. The development default is a faux
 * cloud held in memory on a loopback port. Nothing here leaves this computer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAccountBackend } from '../server/accounts/backend.js';
import { ControlPlaneError } from '../server/accounts/client.js';
import { accountDeployment, browserSignIn, deploymentFromWrangler } from '../server/accounts/deployment.js';
import { startFauxCloud, type RunningFauxCloud } from '../services/control-plane/src/faux/server.js';
import { createHandler } from '../services/control-plane/src/worker.js';
// @ts-expect-error The desktop packaging entry is an executable JavaScript module.
import { readDeployment } from '../scripts/package-desktop.mjs';

const DEPLOYED = 'https://accounts.diomedes.net';
const NOT_ANSWERING = 'The account service did not answer. Check the connection, then try again.';

/** The repository's wrangler.jsonc, read here on its own terms, so no value is retyped. */
async function wrangler() {
  const text = await fs.readFile(path.resolve('wrangler.jsonc'), 'utf8');
  return { text, config: JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { routes: { pattern: string; custom_domain?: boolean }[]; vars: Record<string, string> } };
}

/**
 * The deployed Worker, configured as deployed. It checks the bearer before it routes, so every
 * request here is refused before any account is read; the account factory is never reached.
 */
const worker = createHandler(
  () => {
    throw new Error('No account is read in this test.');
  },
  undefined,
  {
    configuration: () => ({
      environment: 'production',
      origins: [],
      databaseUrl: 'postgres://unused.invalid/none',
      fundingDatabaseUrl: null,
      identity: { ...accountDeployment().workos, apiKey: 'placeholder, never used' },
      staffIdentity: null,
    }),
  },
);

let dataDir: string;
let requests: string[];
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-account-deployment-'));
  requests = [];
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The deployed service, answering as the Worker does. */
const deployed = async (request: Request) => {
  requests.push(`${request.method} ${request.url}`);
  return worker(request, {});
};

describe('the deployment wrangler.jsonc names', () => {
  test('is the account service Workers Builds deploys, with its WorkOS client, read from the file', async () => {
    const { config } = await wrangler();
    const deployment = accountDeployment();
    expect(deployment.url).toBe(DEPLOYED);
    expect(deployment.workos).toEqual({
      clientId: config.vars.WORKOS_CLIENT_ID,
      issuer: config.vars.WORKOS_ISSUER,
      audience: config.vars.WORKOS_TOKEN_AUDIENCE,
    });
    // The bare issuer the Worker's verifier is configured with, and the service's own audience.
    expect(deployment.workos.issuer).toBe('https://api.workos.com');
    expect(deployment.workos.audience).toBe(DEPLOYED);
    expect(deployment.workos.clientId).toMatch(/^client_/);
  });

  test('a packaged build carries the same deployment, and nothing else from the file', async () => {
    const baked: string = await readDeployment(path.resolve('.'));
    expect(deploymentFromWrangler(baked)).toEqual(accountDeployment());
    const carried = JSON.parse(baked) as { routes: unknown[]; vars: Record<string, string> };
    expect(Object.keys(carried).sort()).toEqual(['routes', 'vars']);
    expect(Object.keys(carried.vars).sort()).toEqual(['WORKOS_CLIENT_ID', 'WORKOS_ISSUER', 'WORKOS_TOKEN_AUDIENCE']);
    expect(carried.routes).toHaveLength(1);
  });

  test('refuses a file that does not name one account service and its WorkOS client', async () => {
    const { config } = await wrangler();
    const change = (edit: (copy: typeof config) => void) => {
      const copy = structuredClone(config);
      edit(copy);
      return JSON.stringify(copy);
    };
    const broken = [
      change((copy) => void (copy.routes = [])),
      change((copy) => void (copy.routes = [...copy.routes, { pattern: 'second.diomedes.net', custom_domain: true }])),
      change((copy) => void (copy.routes = copy.routes.map((route) => ({ pattern: route.pattern })))),
      change((copy) => void delete copy.vars.WORKOS_CLIENT_ID),
      change((copy) => void (copy.vars.WORKOS_CLIENT_ID = 'not-a-client-id')),
      change((copy) => void delete copy.vars.WORKOS_ISSUER),
      change((copy) => void (copy.vars.WORKOS_ISSUER = 'http://api.workos.com')),
      change((copy) => void (copy.vars.WORKOS_ISSUER = 'https://api.workos.com/user_management')),
      change((copy) => void delete copy.vars.WORKOS_TOKEN_AUDIENCE),
      'not json',
    ];
    // The running app refuses each of these, and so does packaging, before anything is built.
    for (const text of broken) {
      expect(() => deploymentFromWrangler(text)).toThrow();
      const root = await fs.mkdtemp(path.join(dataDir, 'package-'));
      await fs.writeFile(path.join(root, 'wrangler.jsonc'), text);
      await expect(readDeployment(root)).rejects.toThrow('Nothing was packaged.');
    }
    await expect(readDeployment(path.join(dataDir, 'no-such-root'))).rejects.toThrow('wrangler.jsonc could not be read');
  });
});

describe('the WorkOS sign-in a build opens', () => {
  const workos = () => accountDeployment().workos;

  test('a development build opens none unless one is named', () => {
    expect(browserSignIn({ env: {}, packaged: false })).toBeNull();
    expect(browserSignIn({ env: {} })).toBeNull();
  });

  test('a packaged build opens the deployed client, and accepts the two issuers the service accepts', () => {
    const { clientId, issuer, audience } = workos();
    expect(browserSignIn({ env: {}, packaged: true })).toEqual({
      clientId,
      issuers: [issuer, `${issuer}/user_management/${clientId}`],
      audience,
    });
  });

  test('a client and issuer named in the environment win, with that one exact issuer', () => {
    const env = {
      DIOMEDES_WORKOS_CLIENT_ID: 'client_named_fixture',
      DIOMEDES_WORKOS_TOKEN_ISSUER: 'https://login.fixture.invalid/user_management/client_named_fixture',
    };
    for (const packaged of [false, true])
      expect(browserSignIn({ env, packaged })).toEqual({
        clientId: 'client_named_fixture',
        issuers: ['https://login.fixture.invalid/user_management/client_named_fixture'],
        audience: workos().audience,
      });
  });

  test('a packaged build that cannot name its deployment opens none', () => {
    expect(
      browserSignIn({
        env: {},
        packaged: true,
        deployment: () => {
          throw new Error('No deployment.');
        },
      }),
    ).toBeNull();
  });
});

describe('the account service a build signs in to', () => {
  test('the deployed Worker refuses the faux status route, and that refusal reads as the deployed service', async () => {
    const answer = await worker(new Request(`${DEPLOYED}/faux/status`), {});
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: 'A verified bearer session is required.' });
  });

  test('a packaged build signs in to the deployed service, through the browser', async () => {
    const backend = await resolveAccountBackend({ dataDir, env: {}, packaged: true, fetch: deployed });
    expect(backend.view()).toEqual({
      kind: 'cloud',
      label: 'Nectovia account service',
      url: DEPLOYED,
      reason: null,
      signIn: 'browser',
      demo: null,
    });
    expect(backend.client.base).toBe(DEPLOYED);
    expect(requests).toEqual([`GET ${DEPLOYED}/faux/status`]);
  });

  describe('with a faux cloud answering on this computer', () => {
    let faux: RunningFauxCloud;
    let port: number;
    beforeEach(async () => {
      faux = await startFauxCloud({ file: null, port: 0, seed: false, liveBedrockApiKey: null });
      port = Number(new URL(faux.url).port);
    });
    afterEach(async () => {
      await faux.close();
    });

    test('a development build keeps the shared faux cloud, as before', async () => {
      for (const packaged of [undefined, false]) {
        const backend = await resolveAccountBackend({ dataDir, env: {}, packaged, fauxPort: port, fetch: deployed });
        expect(backend.view()).toMatchObject({ kind: 'faux', url: faux.url, reason: null, signIn: 'password' });
        expect(backend.view().demo?.accounts.map((account) => account.email)).toContain('owner@juniper.test');
        await backend.close();
      }
      expect(requests).toEqual([]);
    });

    test('a packaged build whose service does not answer says so, and is never the faux cloud', async () => {
      let online = false;
      const backend = await resolveAccountBackend({
        dataDir,
        env: {},
        packaged: true,
        fauxPort: port,
        fetch: async (request) => {
          if (!online) throw new TypeError('fetch failed');
          return deployed(request);
        },
      });
      expect(backend.view()).toEqual({
        kind: 'unavailable',
        label: 'Nectovia account service',
        url: DEPLOYED,
        reason: NOT_ANSWERING,
        signIn: 'browser',
        demo: null,
      });
      await expect(backend.client.session('token')).rejects.toMatchObject({ code: 'unreachable' });
      // "Try again" asks the same service again, and only that one.
      await backend.recheck!();
      expect(backend.view().kind).toBe('unavailable');
      online = true;
      await backend.recheck!();
      expect(backend.view()).toMatchObject({ kind: 'cloud', url: DEPLOYED, reason: null, signIn: 'browser' });
      expect(requests).toEqual([`GET ${DEPLOYED}/faux/status`]);
    });
  });

  test('a build packaged without its deployment signs nobody in, and says so', async () => {
    const backend = await resolveAccountBackend({
      dataDir,
      env: {},
      packaged: true,
      fetch: deployed,
      deployment: () => {
        throw new Error('No deployment.');
      },
    });
    expect(backend.view()).toMatchObject({
      kind: 'unavailable',
      url: null,
      signIn: 'browser',
      reason: 'This copy of Nectovia does not name its account service, so nobody can sign in. Install it again.',
    });
    const refusal = await backend.client.session('token').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ControlPlaneError);
    expect(refusal).toMatchObject({ code: 'unreachable' });
    expect(requests).toEqual([]);
  });

  test('NECTOVIA_ACCOUNT_SERVICE still names the service, packaged or not; an older Worker’s 404 still reads as the cloud', async () => {
    const named = 'https://staging-accounts.fixture.invalid';
    for (const packaged of [false, true]) {
      const backend = await resolveAccountBackend({ dataDir, env: { NECTOVIA_ACCOUNT_SERVICE: named }, packaged, fetch: deployed });
      expect(backend.view()).toMatchObject({ kind: 'cloud', url: named, signIn: 'browser' });
    }
    const older = await resolveAccountBackend({
      dataDir,
      env: { NECTOVIA_ACCOUNT_SERVICE: named },
      fetch: async () => Response.json({ error: 'Not found.' }, { status: 404 }),
    });
    expect(older.view()).toMatchObject({ kind: 'cloud', url: named });
    expect(requests).toEqual([`GET ${named}/faux/status`, `GET ${named}/faux/status`]);
  });

  test('test mode keeps its faux cloud in this process, packaged or not', async () => {
    const backend = await resolveAccountBackend({ dataDir, env: { DIOMEDES_TEST_MODE: '1' }, packaged: true, fetch: deployed });
    expect(backend.view()).toMatchObject({ kind: 'faux', url: null, signIn: 'password' });
    expect(requests).toEqual([]);
    await backend.close();
  });
});
