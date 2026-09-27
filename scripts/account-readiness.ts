/**
 * Read-only deployment checks before testing a real desktop sign-in.
 * Run from the repository: node_modules/.bin/tsx scripts/account-readiness.ts
 * No API key, account token, database password, browser, or model call is used.
 * Passing these checks is not proof of authenticated access or database readiness.
 */
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deploymentFromWrangler, type AccountDeployment } from '../server/accounts/deployment.js';
import { readBytes } from '../services/control-plane/src/crypto.js';

const API = 'https://api.workos.com';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
type Transport = (request: Request) => Promise<Response>;
export interface ReadinessConfiguration extends AccountDeployment { callback: string }
interface Check { name: string; passed: boolean; detail: string }

export async function readReadinessConfiguration(root = ROOT): Promise<ReadinessConfiguration> {
  const [rootConfig, workerConfig, nativeAuth] = await Promise.all([
    readFile(path.join(root, 'wrangler.jsonc'), 'utf8'),
    readFile(path.join(root, 'services/control-plane/wrangler.jsonc'), 'utf8'),
    readFile(path.join(root, 'desktop/native-auth.ts'), 'utf8'),
  ]);
  const deployment = deploymentFromWrangler(rootConfig);
  if (JSON.stringify(deployment) !== JSON.stringify(deploymentFromWrangler(workerConfig)))
    throw new Error('The root and account service deployment configurations disagree.');
  // Inspect the exact public callback the native module uses without loading Electron or storage.
  const callbacks = [...nativeAuth.matchAll(/^export const NATIVE_AUTH_CALLBACK = ['"]([^'"\r\n]+)['"];\s*$/gm)];
  if (callbacks.length !== 1) throw new Error('The desktop callback cannot be read from its source.');
  const callback = callbacks[0][1];
  const url = new URL(callback);
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) || ['http:', 'https:', 'file:', 'javascript:', 'data:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.port || url.search || url.hash)
    throw new Error('The desktop callback must be a custom-protocol URL.');
  return { ...deployment, callback };
}

function authorize(config: ReadinessConfiguration, callback: string): URL {
  const url = new URL('/user_management/authorize', API);
  // These are throwaway ceremonies. No code is exchanged, and no verifier is retained or printed.
  const verifier = randomBytes(32).toString('base64url');
  url.search = new URLSearchParams({
    client_id: config.workos.clientId, redirect_uri: callback, provider: 'authkit', response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state: randomBytes(32).toString('base64url'),
  }).toString();
  return url;
}

function hostedRedirect(response: Response): URL | null {
  if (![302, 303, 307, 308].includes(response.status)) return null;
  try {
    const target = new URL(response.headers.get('location') ?? '');
    return target.protocol === 'https:' && target.hostname.endsWith('.authkit.app') && !target.port
      && !target.username && !target.password && !target.hash && !target.searchParams.has('error') ? target : null;
  } catch { return null; }
}

export async function checkAccountReadiness(config: ReadinessConfiguration, fetcher: Transport = fetch) {
  async function check(name: string, url: URL, inspect: (response: Response) => Promise<string> | string): Promise<Check> {
    try {
      const response = await fetcher(new Request(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }));
      try {
        const detail = await inspect(response);
        return { name, passed: true, detail };
      } finally {
        if (response.body && !response.bodyUsed) await response.body.cancel();
      }
    } catch {
      // Provider bodies, Location queries, exceptions and credentials never enter the report.
      return { name, passed: false, detail: FAILURES[name] };
    }
  }
  const json = async (response: Response) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, 131_072)));
  const checks = await Promise.all([
    check('account-service', new URL('/account/session', config.url), async (response) => {
      if (response.status !== 401 || !response.headers.get('cache-control')?.split(',').some((v) => v.trim() === 'no-store')
          || (await json(response))?.error !== 'A verified bearer session is required.') throw new Error();
      return 'The deployed account service requires a bearer and forbids response caching.';
    }),
    check('workos-keys', new URL(`/sso/jwks/${config.workos.clientId}`, API), async (response) => {
      if (response.status !== 200) throw new Error();
      const payload = await json(response);
      if (!Array.isArray(payload?.keys) || payload.keys.length < 1 || payload.keys.length > 32) throw new Error();
      for (const key of payload.keys) {
        if (key?.kty !== 'RSA' || typeof key.kid !== 'string' || !key.kid || key.d !== undefined
            || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig')) throw new Error();
        if (createPublicKey({ key, format: 'jwk' }).asymmetricKeyType !== 'rsa') throw new Error();
      }
      return 'WorkOS publishes usable RSA signing keys for this build\'s customer client.';
    }),
    check('desktop-callback', authorize(config, config.callback), (response) => {
      if (hostedRedirect(response)?.pathname !== '/bootstrap') throw new Error();
      return 'WorkOS accepts the exact desktop callback for a PKCE sign-in.';
    }),
    check('unregistered-callback', authorize(config, `${new URL(config.callback).protocol}//unregistered-${randomBytes(12).toString('hex')}`), (response) => {
      if (hostedRedirect(response)?.pathname !== '/redirect-uri-invalid') throw new Error();
      return 'WorkOS refuses an unregistered callback for the same client.';
    }),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    status: checks.every((result) => result.passed) ? 'configuration-checks-passed' as const : 'blocked' as const,
    accountService: config.url, clientId: config.workos.clientId, callback: config.callback,
    expectedIssuer: config.workos.issuer, expectedAudience: config.workos.audience,
    checks,
    unverified: [
      'Real customer sign-in, email verification, token issuer/audience and OS callback delivery.',
      'Authenticated Neon writes, organization isolation, invitations and membership revocation.',
      'Restart, token refresh, password recovery and hosted sign-out in the installed app.',
    ],
  };
}

const FAILURES: Record<string, string> = {
  'account-service': 'The service did not return its expected uncached sign-in refusal. Check the deployment and server-only configuration.',
  'workos-keys': 'The customer client did not publish a usable signing-key set. Check WORKOS_CLIENT_ID and WorkOS availability.',
  'desktop-callback': 'WorkOS did not accept the desktop callback. Register this exact callback on the customer application; an HTTP redirect alone is not success.',
  'unregistered-callback': 'WorkOS did not explicitly refuse the unregistered callback. Inspect the redirect allowlist before testing sign-in.',
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw new Error();
    const result = await checkAccountReadiness(await readReadinessConfiguration());
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'configuration-checks-passed' ? 0 : 1;
  } catch {
    console.error('Account readiness could not read the deployment and desktop callback. Run this script without arguments from a complete checkout.');
    process.exitCode = 1;
  }
}
