import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';

const token = 'a'.repeat(64);
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

test('a desktop launch token guards reads, writes and the event stream', async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'loopback-auth-'));
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    loopbackToken: token,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  close = async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await fs.rm(root, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const route of ['/api/health', '/api/settings', '/api/events']) {
    expect((await fetch(`${base}${route}`)).status, route).toBe(401);
    expect((await fetch(`${base}${route}`, {
      headers: { 'X-Diomedes-Client': '1', 'X-Diomedes-Session': 'b'.repeat(64) },
    })).status, route).toBe(401);
  }
  expect((await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: JSON.stringify({ detail: 'standard' }),
  })).status).toBe(401);
  expect((await fetch(`${base}/api/health`, {
    headers: { 'X-Diomedes-Session': token },
  })).status).toBe(200);
  const events = await fetch(`${base}/api/events`, {
    headers: { 'X-Diomedes-Session': token },
  });
  expect(events.status).toBe(200);
  expect(events.headers.get('content-type')).toContain('text/event-stream');
  await events.body?.cancel();
});

test('invalid launch secrets fail before a service starts', async () => {
  await expect(createApp({ dataDir: 'unused', loopbackToken: 'guessable' })).rejects.toThrow(
    'local-service token is invalid',
  );
});
