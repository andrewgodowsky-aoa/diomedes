// Independent hidden Electron proof. Synthetic provider responses/JWKS only.
// Real built production modules, SDK, safeStorage, contextBridge and native IPC.
import { app, BrowserWindow, safeStorage } from 'electron';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const root = path.resolve(import.meta.dirname, '../..');
const stage = path.resolve(process.argv[2] ?? '');
const relative = path.relative(root, stage);
if (!relative.startsWith('.desktop-stage-native-auth-review-') || relative.includes(path.sep))
  throw new Error('Review smoke must use its owned staging directory.');
const profile = path.join(stage, 'independent-profile');
app.setPath('userData', profile);
const callback = 'diomedes-auth://callback';
const clientId = 'client_independent_runtime_fixture';
const tokenIssuer = 'https://login.fixture.invalid/user_management/client_default_runtime_fixture/';
let server, mainWindow, otherWindow, auth;
let assertions = 0;
let syntheticRequests = 0;
let protocolFixtureCalls = 0;
let unexpectedNetwork = 0;
const windows = [];
const timeout = setTimeout(() => app.exit(2), 30_000);
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
const get = (window, expression) => window.webContents.executeJavaScript(expression);

void app.whenReady().then(async () => {
try {
  const { createNativeAuth } = await import(pathToFileURL(path.join(stage, 'native-auth.mjs')).href);
  const keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'synthetic-runtime', alg: 'RS256', use: 'sig' };
  const access = await new SignJWT({ iss: tokenIssuer, sub: 'user_runtime_fixture',
    sid: 'session_runtime_fixture', client_id: clientId, exp: Math.floor(Date.now() / 1000) + 300,
    org_id: 'org_runtime_fixture', permissions: ['synthetic:admin'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-runtime' }).sign(keys.privateKey);
  let authorization;
  // Deliberately replace every fetch before constructing the real bundled SDK.
  // An unexpected request fails here; this driver has no network passthrough.
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === `https://api.workos.com/sso/jwks/${clientId}`) {
      syntheticRequests++;
      return Response.json({ keys: [jwk] });
    }
    if (url === 'https://api.workos.com/user_management/authenticate') {
      syntheticRequests++;
      const body = JSON.parse(init.body);
      check(body.client_id, clientId);
      check(body.client_secret, undefined);
      check(new Headers(init.headers).has('authorization'), false);
      check(createHash('sha256').update(body.code_verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
      return Response.json({ access_token: access, refresh_token: 'native-smoke-refresh-sentinel',
        user: { id: 'user_runtime_fixture', first_name: 'Synthetic', last_name: 'User',
          email: 'fixture@example.invalid', email_verified: true }, authentication_method: 'Password' });
    }
    unexpectedNetwork++;
    throw new Error('Network denied by independent fixture');
  };
  server = createServer((request, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(request.url === '/frame' ? '<!doctype html><title>Frame fixture</title>' : '<!doctype html><title>Primary fixture</title><iframe src="/frame"></iframe>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = {
    clientId, origin, getWindow: () => mainWindow,
    tokenIssuer, // Explicit custom-domain/default-application synthetic issuer.
    registerProtocol: () => { protocolFixtureCalls++; return true; },
    shell: { openExternal: async (url) => {
      if (new URL(url).pathname.endsWith('/authorize')) authorization = new URL(url);
    } },
  };
  auth = createNativeAuth(config);
  const makeWindow = () => {
    const window = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      // Test-only enabling of the SDK preload in subframes lets us exercise the
      // production main-frame guard. Shipping main.mjs does NOT enable this.
      nodeIntegrationInSubFrames: true, preload: path.join(stage, 'native-auth-preload.cjs'),
    } });
    windows.push(window);
    return window;
  };
  mainWindow = makeWindow();
  otherWindow = makeWindow();
  await mainWindow.loadURL(origin);
  await otherWindow.loadURL(origin);
  check((await get(mainWindow, 'window.__authkit_electron.getUser()')).data.status, 'signed-out');
  check((await get(otherWindow, 'window.__authkit_electron.getUser()')).ok, false);
  const frame = mainWindow.webContents.mainFrame.frames.find((f) => f.url.endsWith('/frame'));
  assert.ok(frame); assertions++;
  check((await frame.executeJavaScript('window.__authkit_electron.getUser()')).ok, false);
  check((await get(mainWindow, 'window.__authkit_electron.signIn({organizationId:"org_forged"})')).ok, false);
  check((await get(mainWindow, 'window.__authkit_electron.signIn()')).ok, true);
  check(protocolFixtureCalls, 1);
  const state = authorization.searchParams.get('state');
  check(await auth.handleCallback(`${callback}?code=synthetic&state=${encodeURIComponent(state)}`), true);
  const shown = await get(mainWindow, 'window.__authkit_electron.getUser()');
  check(shown.data.account.id, 'user_runtime_fixture');
  check(JSON.stringify(shown).includes(access), false);
  check(JSON.stringify(shown).includes('native-smoke-'), false);
  check(JSON.stringify(shown).includes('synthetic:admin'), false);
  check((await get(mainWindow, 'window.__authkit_electron.getAccessToken()')).ok, false);
  check((await get(mainWindow, 'window.__authkit_electron.switchToOrganization("org_forged")')).ok, false);
  check(await get(mainWindow, '[typeof require, typeof process, typeof window.__authkit_electron.invoke]'), ['undefined', 'undefined', 'undefined']);
  check(safeStorage.isEncryptionAvailable(), true);
  const diskPath = path.join(profile, `diomedes-native-auth-${clientId}.json`);
  const bytes = await fs.readFile(diskPath, 'utf8');
  check(bytes.includes(access), false);
  check(bytes.includes('native-smoke-'), false);
  check(Object.values(JSON.parse(bytes)).every((value) => typeof value === 'string' && value.startsWith('enc:')), true);
  auth.dispose();
  auth = createNativeAuth(config);
  check((await get(mainWindow, 'window.__authkit_electron.getUser()')).data.account.id, 'user_runtime_fixture');
  check((await get(mainWindow, 'window.__authkit_electron.signOut()')).ok, true);
  check(JSON.parse(await fs.readFile(diskPath, 'utf8')).session, undefined);
  auth.dispose();
  auth = createNativeAuth(config);
  check((await get(mainWindow, 'window.__authkit_electron.getUser()')).data.status, 'signed-out');
  check(unexpectedNetwork, 0);
  const report = { passed: true, assertions, syntheticRequests, providerCalls: 0, protocolRegistrations: 0,
    protocolFixtureCalls, unexpectedNetwork, installedAppMutation: false, profile,
    electron: process.versions.electron, node: process.versions.node,
    fixture: 'Synthetic RSA provider/JWKS; actual production bundles, SDK, IPC and OS safeStorage; no live provider or full app proof' };
  await fs.writeFile(path.join(stage, 'independent-smoke-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error);
  await fs.writeFile(path.join(stage, 'independent-smoke-failure.txt'), String(error));
  process.exitCode = 1;
} finally {
  auth?.dispose();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  server?.close();
  clearTimeout(timeout);
  app.exit(process.exitCode || 0);
}
});
