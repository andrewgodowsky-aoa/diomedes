/**
 * Which account service this install signs people in to.
 *
 *   NECTOVIA_ACCOUNT_SERVICE=<url>   that service (the deployed control plane, or a
 *                                    faux cloud another process serves)
 *   test mode (DIOMEDES_TEST_MODE=1) a faux cloud in this process, stored under
 *                                    <data>/faux-cloud, seeded with the demo accounts
 *   a packaged build                 the deployed account service (server/accounts/deployment.ts),
 *                                    signed in to through WorkOS in the system browser. When it
 *                                    does not answer, sign-in says so; it is never the faux cloud.
 *   otherwise                        the shared faux cloud on 127.0.0.1:8795; when
 *                                    nothing answers there, this process serves it
 *
 * The faux cloud is the real control-plane handler over a local JSON store and
 * local passwords (services/control-plane/src/faux). Every account screen names
 * it as the test account service; nothing it holds was bought.
 */
import path from 'node:path';
import type { AccountBackendView } from '../../shared/accounts.js';
import { createFauxCloud, FAUX_BACKEND_LABEL } from '../../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../../services/control-plane/src/faux/seed.js';
import { FAUX_CLOUD_PORT, startFauxCloud, type RunningFauxCloud } from '../../services/control-plane/src/faux/server.js';
import { ControlPlaneClient, ControlPlaneError, type Fetcher } from './client.js';
import { accountDeployment, type AccountDeployment } from './deployment.js';

export interface AccountBackend {
  readonly client: ControlPlaneClient;
  view(): AccountBackendView;
  /** Ask a service named by address again when it did not answer. Nothing else has one. */
  recheck?(): Promise<void>;
  close(): Promise<void>;
}

const CLOUD_LABEL = 'Nectovia account service';
const NOT_ANSWERING = 'The account service did not answer. Check the connection, then try again.';
/** How long a start, or a "Try again", waits for the service to say what it is. */
const PROBE_TIMEOUT_MS = 5_000;

/** The seeded customers a tester signs in as. Staff accounts belong to the Operations app. */
const FAUX_DEMO = {
  password: FAUX_DEMO_PASSWORD,
  accounts: [
    { ...DEMO_ACCOUNTS.owner, label: 'Business owner, Juniper Street Bakery (Business plan)' },
    { ...DEMO_ACCOUNTS.manager, label: 'Manager, Juniper Street Bakery' },
    { ...DEMO_ACCOUNTS.employee, label: 'Employee, Juniper Street Bakery' },
    { ...DEMO_ACCOUNTS.harborOwner, label: 'Business owner, Harbor Hardware (no plan)' },
    { ...DEMO_ACCOUNTS.free, label: 'Free, no business' },
  ],
};

/** An exact HTTPS origin, or plain HTTP on loopback only. */
export function accountServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NECTOVIA_ACCOUNT_SERVICE must be a URL.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)))
    throw new Error('NECTOVIA_ACCOUNT_SERVICE must be an HTTPS address, or plain HTTP on this computer only.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function fixed(client: ControlPlaneClient, view: AccountBackendView, close: () => Promise<void> = async () => {}): AccountBackend {
  const shown = { ...view, demo: view.kind === 'faux' ? FAUX_DEMO : null };
  return { client, view: () => ({ ...shown }), close };
}

async function probe(client: ControlPlaneClient) {
  try {
    return await client.status();
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === 'unreachable') return null;
    throw error;
  }
}

/**
 * A service named by address: the deployed one, or the one NECTOVIA_ACCOUNT_SERVICE names. It is
 * asked what it is at start, and again on `recheck` while it has not answered; it is never
 * replaced by another service.
 */
async function named(url: string, fetcher: Fetcher): Promise<AccountBackend> {
  const client = new ControlPlaneClient(url, fetcher);
  const asking = new ControlPlaneClient(url, fetcher, PROBE_TIMEOUT_MS);
  let shown: AccountBackendView;
  const check = async () => {
    const status = await probe(asking).catch(() => null);
    const faux = status?.backend === 'faux';
    shown = {
      kind: status === null ? 'unavailable' : status.backend,
      label: faux ? FAUX_BACKEND_LABEL : CLOUD_LABEL,
      url,
      reason: status === null ? NOT_ANSWERING : null,
      // The deployed service signs people in through WorkOS, in the system browser.
      signIn: faux ? 'password' : 'browser',
      demo: faux ? FAUX_DEMO : null,
    };
  };
  await check();
  return {
    client,
    view: () => ({ ...shown }),
    recheck: async () => {
      if (shown.kind === 'unavailable') await check();
    },
    close: async () => {},
  };
}

export async function resolveAccountBackend(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** The desktop app's packaged build (Electron's `app.isPackaged`). */
  packaged?: boolean;
  /** Tests: the port for the shared faux cloud. */
  fauxPort?: number;
  /** Tests: the transport to a service named by address, and the deployment it is read from. */
  fetch?: Fetcher;
  deployment?: () => AccountDeployment;
}): Promise<AccountBackend> {
  const env = options.env ?? process.env;
  const testMode = env.DIOMEDES_TEST_MODE === '1';
  const fetcher: Fetcher = options.fetch ?? ((request) => fetch(request));

  const configured = env.NECTOVIA_ACCOUNT_SERVICE?.trim();
  if (configured) return named(accountServiceUrl(configured), fetcher);

  if (testMode) {
    // In-process, per data folder: parallel test servers never share accounts.
    const cloud = await createFauxCloud({ file: path.join(options.dataDir, 'faux-cloud', 'faux-cloud.json'), passwordIterations: 1_000 });
    await seedDemo(cloud);
    const client = new ControlPlaneClient('http://faux.local', (request) => cloud.handle(request));
    return fixed(client, { kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' });
  }

  if (options.packaged) {
    let deployment: AccountDeployment;
    try {
      deployment = (options.deployment ?? accountDeployment)();
    } catch {
      // A build packaged without its deployment signs nobody in, rather than signing anyone in to the wrong service.
      const nowhere = new ControlPlaneClient('https://accounts.invalid', async () => {
        throw new Error('No account service is named.');
      });
      return fixed(nowhere, {
        kind: 'unavailable',
        label: CLOUD_LABEL,
        url: null,
        reason: 'This copy of Nectovia does not name its account service, so nobody can sign in. Install it again.',
        signIn: 'browser',
      });
    }
    return named(accountServiceUrl(deployment.url), fetcher);
  }

  const port = options.fauxPort ?? FAUX_CLOUD_PORT;
  const url = `http://127.0.0.1:${port}`;
  const client = new ControlPlaneClient(url, (request) => fetch(request));
  let running: RunningFauxCloud | null = null;
  let status = await probe(client).catch(() => null);
  if (status === null) {
    try {
      running = await startFauxCloud({ port, seed: true });
      status = { backend: 'faux', label: FAUX_BACKEND_LABEL };
    } catch (error) {
      // Another process may have started it between the probe and the listen.
      status = await probe(client).catch(() => null);
      if (status === null)
        return fixed(client, {
          kind: 'unavailable',
          label: FAUX_BACKEND_LABEL,
          url,
          reason: `The test account service could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
          signIn: 'password',
        });
    }
  }
  return fixed(
    client,
    {
      kind: status.backend,
      label: status.backend === 'faux' ? FAUX_BACKEND_LABEL : CLOUD_LABEL,
      url,
      reason: null,
      signIn: 'password',
    },
    async () => {
      await running?.close();
    },
  );
}
