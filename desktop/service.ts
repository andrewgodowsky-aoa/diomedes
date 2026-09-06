import express from 'express';
import path from 'node:path';
export { createApp } from '../server/app.js';

export function serveClient(app: express.Express, directory: string) {
  app.use(express.static(directory));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(directory, 'index.html')));
}
