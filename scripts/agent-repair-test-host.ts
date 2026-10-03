/** Playwright global setup: owns only its two listeners; no process inspection or termination. */
import path from 'node:path';
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import type { FullConfig } from '@playwright/test';
import { createApp } from '../server/app.js';

export default async function setup(config: FullConfig): Promise<() => Promise<void>> {
  const fixture = config.metadata.agentRepairHost as {
    port: number; clientPort: number; nativePort: number; dataDir: string; projectRoot: string; codexHome: string;
  };
  if (!fixture) throw new Error('Explicit task-owned test configuration is required.');
  const { port, clientPort, nativePort } = fixture;
  if (new Set([port, clientPort, nativePort]).size !== 3 || ![port, clientPort, nativePort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535))
    throw new Error('Three explicit, distinct test ports are required.');
  Object.assign(process.env, {
    DIOMEDES_PORT: String(port), DIOMEDES_CLIENT_PORT: String(clientPort), DIOMEDES_NATIVE_UI_PORT: String(nativePort),
    DIOMEDES_TEST_MODE: '1', DIOMEDES_TEST_ACCOUNT: 'owner@juniper.test',
    DIOMEDES_ENTITLEMENT_FIXTURE: 'paid', DIOMEDES_OWNER_ROUTES: '1',
    DIOMEDES_ALLOW_UNPROTECTED_BROWSER: '1', CODEX_HOME: fixture.codexHome,
  });
  const server = createServer();
  // Reserve only our requested port. A collision fails; it never reclaims a listener.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let application: Awaited<ReturnType<typeof createApp>> | undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await vite?.close();
    try { await application?.locals.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  })();
  try {
    application = await createApp({
      port, clientPort, dataDir: path.resolve(fixture.dataDir), projectRoot: path.resolve(fixture.projectRoot), accounts: {},
    });
    server.on('request', application);
    vite = await createViteServer({ server: { host: '127.0.0.1', port: clientPort, strictPort: true } });
    await vite.listen();
    console.log(`Isolated synthetic browser host ready on ${clientPort}; service ${port}.`);
    // Playwright awaits this teardown in the same process. No webServer child/tree kill is used.
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
