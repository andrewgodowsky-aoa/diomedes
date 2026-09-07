import express from 'express';
import path from 'node:path';
export { createApp } from '../server/app.js';
// The packaged app copies desktop/main.mjs verbatim and bundles only this file,
// so the Electron main process reaches the shared lock through this re-export.
export { claimDataFolder, DataFolderInUse } from '../server/lock.js';

export function serveClient(app: express.Express, directory: string) {
  app.use(express.static(directory));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(directory, 'index.html')));
}
