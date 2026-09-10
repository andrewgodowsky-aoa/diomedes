/** Explicit, disposable fixture composition. Never loaded by server/app.ts or the desktop. */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import {
  createConnectionFixture,
  connectionFixtureModel,
  fixtureStockEvent,
} from '../server/connections/fixture.js';
import { TOAST_ITEMS, TOAST_RESOURCES } from '../server/connections/toast.js';
import { HarnessError } from '../server/harness/policy.js';

export async function startConnectionsDemo(root: string, port = 0) {
  await fs.mkdir(root, { recursive: true });
  const names = await fs.readdir(root);
  if (names.length && !names.includes('CONNECTIONS_FIXTURE_PROFILE'))
    throw new Error('Use a new empty fixture directory.');
  await fs.writeFile(
    path.join(root, 'CONNECTIONS_FIXTURE_PROFILE'),
    'Synthetic Connections proof only.\n',
  );
  const fixture = await createConnectionFixture(root);
  const { service, project } = fixture;
  await service.recover(project.id);
  const app = express();
  app.disable('x-powered-by');
  let processing: Promise<void> = Promise.resolve();
  let failure: string | null = null;
  let lastFixtureEvent: { raw: string; at: string } | null = null;
  const schedule = () => {
    processing = service.drain(project.id);
    void processing.catch(() => {
      failure = 'Fixture processing failed. The durable inbox is preserved.';
    });
  };
  app.use('/api', (req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ error: 'Fixture loopback access only.' });
      return;
    }
    if (
      req.method !== 'GET' &&
      req.path !== '/fixture/webhook' &&
      req.header('X-Diomedes-Fixture') !== '1'
    ) {
      res.status(403).json({ error: 'Fixture control header required.' });
      return;
    }
    const origin = req.header('Origin');
    if (origin && origin !== `http://${req.headers.host}`) {
      res.status(403).json({ error: 'Cross-origin fixture request refused.' });
      return;
    }
    next();
  });
  // Raw bytes are verified before JSON middleware. Acknowledgement follows the durable inbox write.
  app.post(
    '/api/fixture/webhook',
    express.text({ type: 'application/json', limit: '32kb' }),
    async (req, res) => {
      const result = await service.accept(
        project.id,
        'toast-group',
        String(req.body),
        req.header('Toast-Signature') ?? '',
        req.header('Toast-Restaurant-External-ID'),
      );
      res.status(202).json(result);
      setImmediate(schedule);
    },
  );
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/connections', async (_req, res) => {
    const status = await service.status(project.id, 'toast-group'),
      snapshot = service.snapshot(project.id);
    res.json({
      ...status,
      observations: Object.values(snapshot.connections.observations),
      tasks: snapshot.tasks,
      rules: snapshot.rules.active,
      proposals: snapshot.rules.proposals,
      evidence: snapshot.connections.contextEvidence,
      events: snapshot.connections.inbox,
      failure,
      canRepeatFixtureEvent: lastFixtureEvent !== null,
    });
  });
  app.post('/api/fixture/read', async (_req, res) => {
    const input = {
      resources: TOAST_RESOURCES.map((resource) => resource.id),
      itemIds: TOAST_ITEMS,
    };
    const runId = await service.admit(project.id, 'toast-group', input.resources, [
      'get_item_availability',
    ]);
    const result = await service.runFixtureAgent(
      runId,
      connectionFixtureModel(input),
      'Check menu availability at the approved restaurants.',
    );
    res.json({ runId, result });
  });
  app.post('/api/fixture/control', async (req, res) => {
    const { status } = z
      .strictObject({
        status: z.enum(['connected', 'paused', 'disconnected', 'authorization-required']),
      })
      .parse(req.body);
    res.json(await service.control(project.id, 'toast-group', status));
  });
  app.post('/api/fixture/propose', async (req, res) => {
    const { text } = z.strictObject({ text: z.string().max(2000) }).parse(req.body);
    res.json(await service.propose(project.id, 'toast-group', text));
  });
  app.post('/api/fixture/activate', async (req, res) => {
    const { id, digest } = z.strictObject({ id: z.string(), digest: z.string() }).parse(req.body);
    res.json(await service.activate(project.id, 'toast-group', id, digest));
  });
  app.post('/api/fixture/event', async (req, res) => {
    const { repeat } = z.strictObject({ repeat: z.boolean() }).parse(req.body);
    if (repeat && !lastFixtureEvent)
      throw new HarnessError('no_fixture_event', 'Simulate a sample event first.');
    const at = repeat ? lastFixtureEvent!.at : new Date().toISOString();
    const raw = repeat ? lastFixtureEvent!.raw : fixtureStockEvent(at, 4, randomUUID());
    const result = await service.accept(project.id, 'toast-group', raw, fixture.sign(raw, at));
    lastFixtureEvent = { raw, at };
    // Interactive fixture button waits for its own result. The webhook route acknowledges first.
    await service.drain(project.id);
    res.json(result);
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown fixture action.' });
  });
  const workspace = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const vite = await createServer({
    configFile: false,
    root: workspace,
    plugins: [react()],
    appType: 'custom',
    server: {
      middlewareMode: true,
      fs: { allow: [workspace, await fs.realpath(path.join(workspace, 'node_modules'))] },
    },
  });
  app.use(vite.middlewares);
  app.get('/', async (_req, res) => {
    res
      .type('html')
      .send(
        await vite.transformIndexHtml(
          '/',
          '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Connections - Diomedes fixture</title></head><body><div id="root"></div><script type="module" src="/client/connections/fixture-main.tsx"></script></body></html>',
        ),
      );
  });
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res
        .status(error instanceof HarnessError ? 403 : error instanceof z.ZodError ? 400 : 500)
        .json({
          error:
            error instanceof HarnessError
              ? error.message
              : 'The fixture request could not be completed.',
        });
    },
  );
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    fixture,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await processing;
      await vite.close();
      await fixture.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve('test-results', 'connections-demo');
  const demo = await startConnectionsDemo(
    root,
    Number(process.env.DIOMEDES_CONNECTIONS_PORT ?? 47639),
  );
  console.log(`Connections fixture: ${demo.url}\nDisposable profile: ${root}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void demo.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
}
