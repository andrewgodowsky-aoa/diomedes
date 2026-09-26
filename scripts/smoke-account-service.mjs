import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A local test account service for the packaged smokes, and the sign-in they need.
//
// A packaged build answers nothing under /api but /api/account and /api/updates
// until a person signs in (server/accounts/routes.ts), and it signs customers in
// through WorkOS to the deployed account service, which a smoke can't do.
// NECTOVIA_ACCOUNT_SERVICE names another service instead (server/accounts/backend.ts).
// This starts the control plane's own faux cloud (services/control-plane/scripts/
// faux-cloud.ts) on a free loopback port, seeded with the demo accounts and
// password sign-in, so a smoke drives the shipped binary with nothing test-only
// switched on inside it. The service never calls a model provider: the variables
// that would give it a live key are blanked for its process.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(repo, 'services', 'control-plane', 'scripts', 'faux-cloud.ts');

/** The seeded Business-plan owner of Juniper Street Bakery (services/control-plane/src/faux/seed.ts). Faux data only. */
export const SMOKE_ACCOUNT = { email: 'owner@juniper.test', password: 'nectovia-demo' };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts the service with its store in `dir`, and resolves once it listens: the app
 * gives an account service five seconds to answer at launch. It runs in one Node
 * process (tsx as a loader, not tsx's own launcher), so `close()` leaves nothing
 * holding the port.
 */
export async function startSmokeAccountService(dir, { timeoutMs = 60_000 } = {}) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', runner, '--file', path.join(dir, 'faux-cloud.json'), '--port', String(port), '--identity', 'password'],
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NECTOVIA_FAUX_BEDROCK_API_KEY: '', NECTOVIA_FAUX_OPENROUTER_API_KEY: '' },
      windowsHide: true,
    },
  );
  let output = '';
  const url = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) return resolve(value);
      child.kill();
      const tail = output.trim().split(/\r?\n/).slice(-5).join(' | ');
      reject(new Error(tail ? `${error.message}: ${tail}` : error.message));
    };
    const timer = setTimeout(
      () => settle(new Error(`The test account service did not start within ${timeoutMs / 1000} s`)),
      timeoutMs,
    );
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const ready = /ready: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (ready) settle(null, ready[1]);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => settle(error));
    child.on('exit', (code) => settle(new Error(`The test account service exited with code ${code}`)));
  });
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/**
 * Signs the seeded owner in from inside the app window, the only caller the local
 * service answers (desktop/main.mjs adds its per-launch session header there).
 * Nothing is remembered, so each launch signs in on its own.
 */
export async function signInFromWindow(page, account = SMOKE_ACCOUNT) {
  const result = await page.evaluate(
    async (body) => {
      const response = await fetch('/api/account/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    { email: account.email, password: account.password, remember: false },
  );
  if (result.status !== 200)
    throw new Error(`Signing in to the test account service answered ${result.status}: ${result.text.slice(0, 200)}`);
  const state = JSON.parse(result.text);
  if (state.signedIn !== true || state.person?.email !== account.email)
    throw new Error(`Signing in to the test account service did not sign ${account.email} in`);
  return state;
}
