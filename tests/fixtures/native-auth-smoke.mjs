// Explicit opt-in Electron smoke. Synthetic session, owned profile, no provider
// call or OS protocol registration. Run after buildDesktopAuth(root, stage).
import { app, BrowserWindow, safeStorage } from 'electron';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultStorage } from '@workos/authkit-electron';

const root = path.resolve(import.meta.dirname, '../..');
const stage = path.resolve(process.argv[2] ?? '');
const relative = path.relative(root, stage);
if (!relative.startsWith('.desktop-stage-native-auth-') || relative.includes(path.sep))
  throw new Error('The smoke requires its own native-auth staging folder.');
const profile = path.join(stage, 'profile');
app.setPath('userData', profile);
let window;
let auth;
let server;
let assertions = 0;
function check(actual, expected) {
  assert.deepEqual(actual, expected);
  assertions++;
}
const timeout = setTimeout(() => app.exit(2), 25_000);

void app
  .whenReady()
  .then(async () => {
    const { createNativeAuth } = await import(
      pathToFileURL(path.join(stage, 'native-auth.mjs')).href
    );
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Native auth fixture</title><p>Personal fixture</p>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let registrations = 0;
    auth = createNativeAuth({
      clientId: 'client_runtime_fixture',
      tokenIssuer: 'https://api.workos.com', // Explicit synthetic fixture issuer.
      origin,
      getWindow: () => window,
      registerProtocol: () => {
        registrations++;
        return false;
      },
      shell: {
        openExternal: async () => {
          throw new Error('No browser is allowed in this fixture.');
        },
      },
    });
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(stage, 'native-auth-preload.cjs'),
      },
    });
    await window.loadURL(origin);
    const result = await window.webContents.executeJavaScript(`(async () => ({
    state: await window.__authkit_electron.getUser(),
    token: await window.__authkit_electron.getAccessToken(),
    signIn: await window.__authkit_electron.signIn(),
    node: typeof window.require, process: typeof window.process,
    generic: typeof window.__authkit_electron.invoke
  }))()`);
    check(result.state.ok, true);
    check(result.state.data.status, 'signed-out');
    check(result.token.ok, false);
    check(result.signIn.ok, false);
    check(result.node, 'undefined');
    check(result.process, 'undefined');
    check(result.generic, 'undefined');
    check(registrations, 1); // Only the injected function was called.
    check(window.webContents.getLastWebPreferences().sandbox, true);
    check(window.webContents.getLastWebPreferences().contextIsolation, true);
    check(safeStorage.isEncryptionAvailable(), true);
    const sdk = createDefaultStorage({ name: 'diomedes-native-auth-client_runtime_fixture' });
    const synthetic = {
      accessToken: 'native-smoke-access-sentinel',
      refreshToken: 'native-smoke-refresh-sentinel',
      user: { id: 'user_fixture' },
    };
    sdk.setSession(synthetic);
    sdk.setPendingVerifier('native-smoke-state-sentinel', 'native-smoke-state-sentinel');
    const bytes = await fs.readFile(
      path.join(profile, 'diomedes-native-auth-client_runtime_fixture.json'),
      'utf8',
    );
    check(bytes.includes('native-smoke-'), false);
    const reopened = createDefaultStorage({ name: 'diomedes-native-auth-client_runtime_fixture' });
    check(reopened.getSession(), synthetic);
    check(
      reopened.takePendingVerifier('native-smoke-state-sentinel'),
      'native-smoke-state-sentinel',
    );
    check(reopened.takePendingVerifier('native-smoke-state-sentinel'), null);
    reopened.clearSession();
    const report = {
      passed: true,
      assertions,
      electron: process.versions.electron,
      node: process.versions.node,
      sandbox: true,
      contextIsolation: true,
      storage: 'actual OS safeStorage with synthetic data',
      providerCalls: 0,
      protocolRegistrations: 0,
      installedAppMutation: false,
      profile,
    };
    await fs.writeFile(path.join(stage, 'smoke-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    auth.dispose();
    window.destroy();
    server.close();
    clearTimeout(timeout);
    app.quit();
  })
  .catch(async (error) => {
    console.error(error);
    await fs.writeFile(path.join(stage, 'smoke-failure.txt'), String(error));
    auth?.dispose();
    window?.destroy();
    server?.close();
    clearTimeout(timeout);
    app.exit(1);
  });
