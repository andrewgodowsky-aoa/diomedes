import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
import { claimDataFolder } from './lock.js';
import { safeAbsolute } from './paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DIOMEDES_DATA_DIR ?? path.join(root, '.data'));
const projectRoot = path.resolve(
  process.env.DIOMEDES_PROJECTS_DIR ?? path.join(root, 'fixtures', 'projects'),
);
const port = Number(process.env.DIOMEDES_PORT ?? 47631);
const clientPort = Number(process.env.DIOMEDES_CLIENT_PORT ?? 5173);
if (process.env.DIOMEDES_ALLOW_UNPROTECTED_BROWSER !== '1')
  throw new Error('The standalone browser service has no desktop session authentication. Use the desktop app, or start the local development launcher with test data.');
if (![port, clientPort].every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535))
  throw new Error('Diomedes ports must be whole numbers between 1024 and 65535.');
await safeAbsolute(dataDir);
await fs.mkdir(dataDir, { recursive: true });
const { release } = await claimDataFolder(dataDir, { port });
try {
  // Customer accounts are on: every route needs a signed-in person (server/accounts/).
  const app = await createApp({ dataDir, projectRoot, port, clientPort, accounts: {} });
  if (process.argv.includes('--production')) {
    const dist = path.join(root, 'dist');
    await fs.access(path.join(dist, 'index.html'));
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }
  const server = app.listen(port, '127.0.0.1');
  server.on('listening', () => {
    console.log(`Diomedes local service ready: http://127.0.0.1:${port}`);
    console.log(`App data: ${dataDir}`);
    console.log(`Project root: ${projectRoot}`);
  });
  server.on('error', (error) => {
    console.error(`Could not start Diomedes: ${error.message}`);
    void release().finally(() => process.exit(1));
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.locals.close();
    server.close();
    server.closeAllConnections();
    await release();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
} catch (error) {
  await release();
  throw error;
}
