/**
 * Which account service this install signs people in to.
 *
 *   NECTOVIA_ACCOUNT_SERVICE=<url>   that service (the deployed control plane, or a
 *                                    faux cloud another process serves)
 *   test mode (DIOMEDES_TEST_MODE=1) a faux cloud in this process, stored under
 *                                    <data>/faux-cloud, seeded with the demo accounts
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
import { ControlPlaneClient, ControlPlaneError } from './client.js';

export interface AccountBackend {
  readonly client: ControlPlaneClient;
  view(): AccountBackendView;
  close(): Promise<void>;
}

const CLOUD_LABEL = 'Nectovia account service';

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

export async function resolveAccountBackend(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Tests: the port for the shared faux cloud. */
  fauxPort?: number;
}): Promise<AccountBackend> {
  const env = options.env ?? process.env;
  const testMode = env.DIOMEDES_TEST_MODE === '1';

  const configured = env.NECTOVIA_ACCOUNT_SERVICE?.trim();
  if (configured) {
    const url = accountServiceUrl(configured);
    const client = new ControlPlaneClient(url, (request) => fetch(request));
    const status = await probe(client).catch(() => null);
    return fixed(client, {
      kind: status === null ? 'unavailable' : status.backend,
      label: status?.backend === 'faux' ? FAUX_BACKEND_LABEL : CLOUD_LABEL,
      url,
      reason: status === null ? 'The account service did not answer. Check the connection, then try again.' : null,
      // The deployed service signs people in through WorkOS in a browser, which this build does not open yet.
      signIn: status?.backend === 'cloud' ? 'browser' : 'password',
    });
  }

  if (testMode) {
    // In-process, per data folder: parallel test servers never share accounts.
    const cloud = await createFauxCloud({ file: path.join(options.dataDir, 'faux-cloud', 'faux-cloud.json'), passwordIterations: 1_000 });
    await seedDemo(cloud);
    const client = new ControlPlaneClient('http://faux.local', (request) => cloud.handle(request));
    return fixed(client, { kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' });
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
