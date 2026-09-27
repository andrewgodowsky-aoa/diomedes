import { ControlPlaneClient } from '../../server/accounts/client';
import type { AccountBackend } from '../../server/accounts/backend';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, seedDemo } from '../../services/control-plane/src/faux/seed';
import type { WorkspaceView } from '../../shared/workspaces';

// The Nectovia route for the Home page specs, through the real account service and its real
// managed gateway: the faux cloud's control-plane handler, seeded as the app's own test mode seeds
// it (Juniper Street Bakery on the Business plan, GPT-6 Luna behind every tier). The only seam is
// the one the faux cloud offers for this, the gateway's provider transport, so the scripted
// provider a spec already speaks answers at the provider boundary. Nothing reaches AWS, no
// customer connects anything, and no money is spent.

/** The signed-in person: the faux seed's Business owner, whose plan includes the Agent. */
export const NECTOVIA_OWNER = DEMO_ACCOUNTS.owner.email;

export interface GatewayCall {
  url: string;
  /** The request's headers, lower-cased, as the gateway received them. */
  headers: Record<string, string>;
}
/** Every call the desktop made to the managed gateway, in order. */
export const gateway: GatewayCall[] = [];
/** A refusal the gateway answers the next calls with instead of dispatching, while set. */
export const refusal: { next: { status: number; code: string; message: string } | null } = { next: null };

/**
 * An in-process call behaves as the network would: when the desktop gives up on a request, its
 * call rejects. The faux cloud's handler never reads the request's signal itself.
 */
function abortable(signal: AbortSignal, answer: Promise<Response>): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Response>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    answer.then(
      (response) => {
        signal.removeEventListener('abort', stop);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

/**
 * The `accounts` option `createApp` takes: this faux cloud, and the test mode that signs the
 * Business owner in at start. `provider` is the transport the managed gateway calls.
 */
export async function nectoviaAccounts(provider: typeof globalThis.fetch): Promise<{
  accounts: { backend: AccountBackend; env: NodeJS.ProcessEnv };
  cloud: FauxCloud;
}> {
  const cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, managed: { transport: provider } });
  await seedDemo(cloud);
  const handle = (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname.startsWith('/managed/v1/')) {
      gateway.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()) });
      const refused = refusal.next;
      if (refused)
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: refused.code, message: refused.message } }), {
            status: refused.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
    }
    return abortable(request.signal, cloud.handle(request));
  };
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', handle),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  return {
    accounts: { backend, env: { DIOMEDES_TEST_MODE: '1', DIOMEDES_TEST_ACCOUNT: NECTOVIA_OWNER } },
    cloud,
  };
}

type Api = <T>(route: string, method?: string, data?: unknown) => Promise<T>;

/**
 * Link a project to the business the signed-in owner works in, on the route Workspaces' "Link Home
 * to this business" uses. Paid Agent work runs only in a project one business owns, and creating a
 * project links it to nothing, so a spec links each project it talks to the Agent in, as an owner
 * would. Linking never chooses where the business's Automations write.
 */
export async function linkToBusiness(api: Api, projectId: string): Promise<void> {
  const { active } = await api<WorkspaceView>('/workspace');
  if (active.kind !== 'business') throw new Error('The signed-in owner is not working in a business.');
  await api(`/workspace/organizations/${active.organizationId}/projects`, 'POST', { projectId });
}

/** Home, made if it never was, and linked to the business the way Workspaces does it. */
export async function linkHome(api: Api): Promise<{ projectId: string; threadId: string }> {
  const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST', {});
  await linkToBusiness(api, home.projectId);
  return home;
}
