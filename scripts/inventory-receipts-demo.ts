/** Explicit local demonstration using the built Console view and real durable stock service. */
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import packageInfo from '../package.json' with { type: 'json' };
import { inventoryReceiptRoutes } from '../server/inventory/receipt-routes.js';
import {
  createReceiptFixture,
  FIXTURE_REVISION,
  type FixtureAccess,
} from '../tests/fixtures/inventory-receipts.js';

const workspace = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function startInventoryReceiptsDemo(root: string, port = 0) {
  const htmlPath = path.join(workspace, 'dist/inventory.html');
  const builtAt = (await fs.stat(htmlPath)).mtimeMs;
  for (const source of [
    'inventory.html',
    'client/inventory/main.tsx',
    'client/inventory/receipt-client.ts',
    'client/console/InventoryReceipts.tsx',
    'client/console/inventory-receipts.css',
    'shared/inventory-workflow.ts',
    'shared/inventory.ts',
  ]) {
    if ((await fs.stat(path.join(workspace, source))).mtimeMs > builtAt)
      throw new Error(
        'The inventory client build is stale. Run npx vite build before the demonstration.',
      );
  }
  const html = await fs.readFile(htmlPath, 'utf8');
  const build = {
    version: packageInfo.version,
    fixtureRevision: FIXTURE_REVISION,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    sourceDirty: !!execFileSync('git', ['status', '--porcelain'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    authentication: 'simulated-test-authorizer',
    stock: 'synthetic',
    purchasing: 'unavailable',
  };
  const fixture = await createReceiptFixture(path.resolve(root));
  const app = express();
  app.disable('x-powered-by');
  let authority = '';
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') ||
      request.get('host') !== authority ||
      (origin && origin !== `http://${authority}`) ||
      request.get('sec-fetch-site') === 'cross-site'
    ) {
      response
        .status(403)
        .json({ error: 'This demonstration accepts same-origin loopback requests only.' });
      return;
    }
    if (request.path.startsWith('/api/') && request.get('X-Diomedes-Inventory') !== '1') {
      response.status(403).json({ error: 'Explicit inventory demonstration header required.' });
      return;
    }
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/demo/build', (_request, response) => {
    response.json(build);
  });
  app.use(
    '/api/inventory',
    inventoryReceiptRoutes<{ access?: FixtureAccess }>({
      service: fixture.service,
      projectId: fixture.project.id,
      // The optional header can only reduce the test grant. It is not a production auth mechanism.
      claim: (request) => ({
        access:
          request.get('X-Diomedes-Demo-Access') === 'revoked'
            ? 'revoked'
            : request.get('X-Diomedes-Demo-Access') === 'read-only'
              ? 'read-only'
              : undefined,
      }),
    }),
  );
  app.use('/api', (_request, response) => {
    response
      .status(404)
      .json({ error: 'No other application API is exposed by this demonstration.' });
  });
  app.get('/', (_request, response) => {
    response
      .type('html')
      .send(
        html.replace(
          'Development demonstration.',
          `Diomedes ${packageInfo.version} development demonstration. Source ${build.commit.slice(0, 12)}${build.sourceDirty ? ' with local changes' : ''}.`,
        ),
      );
  });
  app.use('/assets', express.static(path.join(workspace, 'dist/assets')));
  const server = app.listen(port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('The fixture listener is unavailable.');
    authority = `127.0.0.1:${address.port}`;
  } catch (error) {
    await fixture.close();
    throw error;
  }
  return {
    url: `http://${authority}`,
    fixture,
    build,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await fixture.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(
    process.env.DIOMEDES_RECEIPT_DEMO_ROOT ?? 'test-results/inventory-receipt-demo',
  );
  const demo = await startInventoryReceiptsDemo(
    root,
    Number(process.env.DIOMEDES_RECEIPT_DEMO_PORT ?? 47643),
  );
  console.log(JSON.stringify({ url: demo.url, profile: root, ...demo.build }, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void demo.close().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
}
