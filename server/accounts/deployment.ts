/**
 * The deployed account service a packaged build signs customers in to, and the WorkOS client it
 * trusts, read from the repository root's wrangler.jsonc: the file Workers Builds deploys on every
 * merge to main. Nothing here is retyped.
 *
 *   url       https://<the custom domain in `routes`>
 *   clientId  vars.WORKOS_CLIENT_ID       the customer (Nectovia) WorkOS environment
 *   issuer    vars.WORKOS_ISSUER          WorkOS's bare issuer
 *   audience  vars.WORKOS_TOKEN_AUDIENCE  the resource the WorkOS JWT template adds
 *
 * A packaged build reads the values scripts/package-desktop.mjs baked in when it bundled the
 * service. Development and tests read the file itself.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The deployment, as JSON text, defined by scripts/package-desktop.mjs in the bundled service. */
declare const NECTOVIA_DEPLOYMENT: string | undefined;

export interface AccountDeployment {
  /** The deployed account service's origin. */
  url: string;
  workos: { clientId: string; issuer: string; audience: string };
}

/** What a browser sign-in's token must be: the WorkOS client, the exact issuers it may name, the audience. */
export interface BrowserSignInConfig {
  clientId: string;
  /** Each an exact value, never a pattern. */
  issuers: string[];
  audience: string;
}

const CLIENT_ID = /^client_[A-Za-z0-9_-]{1,120}$/;

function https(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`wrangler.jsonc has no ${name}.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`wrangler.jsonc's ${name} is not a URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error(`wrangler.jsonc's ${name} must be an HTTPS origin.`);
  // Exactly as written: the account service compares these strings as they are.
  return value;
}

/** The deployment named by a wrangler.jsonc text. Whole-line `//` comments only, which is all it uses. */
export function deploymentFromWrangler(text: string): AccountDeployment {
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
    routes?: { pattern?: unknown; custom_domain?: unknown }[];
    vars?: Record<string, unknown>;
  };
  const domains = (config.routes ?? []).filter((route) => route?.custom_domain === true && typeof route.pattern === 'string');
  if (domains.length !== 1) throw new Error('wrangler.jsonc must name exactly one custom domain for the account service.');
  const vars = config.vars ?? {};
  const clientId = vars.WORKOS_CLIENT_ID;
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new Error('wrangler.jsonc has no WORKOS_CLIENT_ID.');
  return {
    url: https(`https://${domains[0].pattern as string}`, 'account service domain'),
    workos: {
      clientId,
      issuer: https(vars.WORKOS_ISSUER, 'WORKOS_ISSUER'),
      audience: https(vars.WORKOS_TOKEN_AUDIENCE, 'WORKOS_TOKEN_AUDIENCE'),
    },
  };
}

/** This build's deployment: baked in when bundled, else the repository's own wrangler.jsonc. */
export function accountDeployment(): AccountDeployment {
  if (typeof NECTOVIA_DEPLOYMENT === 'string') return deploymentFromWrangler(NECTOVIA_DEPLOYMENT);
  return deploymentFromWrangler(fs.readFileSync(fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)), 'utf8'));
}

/**
 * The WorkOS sign-in the desktop opens in the system browser, or null when there is none.
 * `DIOMEDES_WORKOS_CLIENT_ID` and `DIOMEDES_WORKOS_TOKEN_ISSUER` name one explicitly, with that one
 * exact issuer. Otherwise a packaged build uses the deployment's client, and accepts the two
 * issuers the account service's verifier accepts: WorkOS's bare origin and the client's own
 * (services/control-plane/src/identity-workos.ts). A development build has none unless named.
 */
export function browserSignIn(options: { env?: NodeJS.ProcessEnv; packaged?: boolean; deployment?: () => AccountDeployment }): BrowserSignInConfig | null {
  const env = options.env ?? process.env;
  const clientId = env.DIOMEDES_WORKOS_CLIENT_ID?.trim();
  const issuer = env.DIOMEDES_WORKOS_TOKEN_ISSUER?.trim();
  if (!(clientId && issuer) && !options.packaged) return null;
  let workos: AccountDeployment['workos'];
  try {
    workos = (options.deployment ?? accountDeployment)().workos;
  } catch {
    // A build that cannot name its deployment signs nobody in; the account screen says so.
    return null;
  }
  if (clientId && issuer) return { clientId, issuers: [issuer], audience: workos.audience };
  const perClient = `${workos.issuer.replace(/\/+$/, '')}/user_management/${workos.clientId}`;
  return { clientId: workos.clientId, issuers: [workos.issuer, perClient], audience: workos.audience };
}
