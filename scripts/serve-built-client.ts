import path from 'node:path';
import { createApp } from '../server/app.js';
import { serveClient } from '../desktop/service.js';
const port = Number(process.env.DIOMEDES_CLIENT_PORT);
if (!process.env.DIOMEDES_DATA_DIR || !process.env.DIOMEDES_PROJECTS_DIR || !Number.isInteger(port))
  throw new Error('An isolated built-client test environment is required.');
const app = await createApp({ dataDir: process.env.DIOMEDES_DATA_DIR,
  projectRoot: process.env.DIOMEDES_PROJECTS_DIR, port, clientPort: port });
serveClient(app, path.resolve('dist'));
const server = app.listen(port, '127.0.0.1');
async function close() { await app.locals.close(); server.close(() => process.exit(0)); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
