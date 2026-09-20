import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Store } from '../store.js';
import { ApiError } from '../paths.js';
import type { HarnessHost } from './host.js';
import { localHarnessPrincipal } from './bridge.js';
import { HarnessError } from './policy.js';
import { CODEX_REPORT } from './codex-engine.js';

function eventCursor(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new ApiError(400, 'Provide a nonnegative whole event cursor.');
  return Number(raw);
}

function checkCursor(cursor: number, lastSeq: number) {
  if (cursor > lastSeq)
    throw new ApiError(409, 'The event cursor is ahead of this saved run. Reload its event history.', {
      code: 'event_cursor_ahead', lastSeq,
    });
}

export function mountHarnessRoutes(app: Express, store: Store, host: HarnessHost) {
  const base = '/api/projects/:id/harness/runs';
  const routeError = (error: unknown, next: NextFunction) => {
    if (error instanceof HarnessError) {
      const message =
        error.code === 'unsupported_run_version'
          ? 'This saved run needs a different version of Diomedes. Its record was left unchanged.'
          : error.code === 'invalid_run_record'
            ? 'This saved run could not be read. Its record was left unchanged.'
            : host.redact(error.message);
      next(new ApiError(error.code === 'unknown_run' ? 404 : 409, message, { code: error.code }));
    } else next(error);
  };
  const route =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await host.refreshSecrets();
        res.json(host.scrub(await action(req)));
      } catch (error) {
        routeError(error, next);
      }
    };
  app.get(
    base,
    route(async (req) => ({
      runs: (await host.list(String(req.params.id))).map((run) => ({
        id: run.id,
        state: run.state,
        capabilityId: run.capabilityId,
        capabilityVersion: run.capabilityVersion,
        taskId: run.taskId,
        sessionId: run.sessionId,
      })),
    })),
  );
  app.get(
    `${base}/:runId`,
    route((req) => host.get(String(req.params.id), String(req.params.runId))),
  );
  app.get(
    `${base}/:runId/events`,
    route(async (req) => {
      const cursor = eventCursor(req.query.after ?? '0');
      const run = await host.get(String(req.params.id), String(req.params.runId));
      checkCursor(cursor, run.lastSeq);
      return {
        events: run.events.filter((event) => event.seq > cursor),
        lastSeq: run.lastSeq,
      };
    }),
  );
  app.get(`${base}/:runId/events/stream`, async (req, res, next) => {
    const projectId = String(req.params.id);
    const runId = String(req.params.runId);
    let cursor = 0;
    let closed = false;
    let initialized = false;
    let pumping = false;
    let pending = false;
    let backpressure = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      store.off('change', changed);
      store.off('settings', wake);
      res.off('drain', drain);
      res.off('close', cleanup);
      res.off('error', cleanup);
      req.off('aborted', cleanup);
    };
    const stop = () => { cleanup(); res.destroy(); };
    const write = (frame: string) => {
      if (!res.write(frame)) backpressure = true;
    };
    const pump = async () => {
      if (closed || !initialized || pumping) return;
      pumping = true;
      try {
        while (pending && !closed) {
          pending = false;
          await host.refreshSecrets();
          // Recheck the current host authority even for a stalled reader.
          // Subscriptions and a previously accepted cursor confer no rights.
          const run = await host.get(projectId, runId);
          if (closed) return;
          checkCursor(cursor, run.lastSeq);
          if (backpressure) continue;
          for (const event of run.events) {
            if (event.seq <= cursor) continue;
            write(`id: ${event.seq}\nevent: harness-event\ndata: ${JSON.stringify(host.scrub(event))}\n\n`);
            cursor = event.seq;
            if (backpressure) break;
          }
        }
      } catch {
        // After headers, a read/authority failure closes the transport. It
        // cannot manufacture a durable terminal event or invoke a provider.
        stop();
      } finally { pumping = false; }
    };
    function wake() { pending = true; void pump(); }
    function changed(id: string) { if (id === projectId) wake(); }
    function drain() { backpressure = false; wake(); }
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('aborted', cleanup);
    try {
      const initial = eventCursor(req.query.after ?? '0');
      // EventSource retains its URL on reconnect. Its last received id must
      // override that original query cursor; validate both when supplied.
      const lastId = req.get('Last-Event-ID');
      cursor = lastId === undefined ? initial : eventCursor(lastId);
      // Subscribe first so a save racing the initial snapshot is observed.
      unsubscribe = host.subscribe(runId, wake, stop);
      store.on('change', changed);
      store.on('settings', wake);
      res.on('drain', drain);
      await host.refreshSecrets();
      const run = await host.get(projectId, runId);
      if (closed) return;
      checkCursor(cursor, run.lastSeq);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      initialized = true;
      wake();
      heartbeat = setInterval(() => {
        // The periodic read catches authority changes with no Store event.
        wake();
        if (!closed && !backpressure) write(': keep-alive\n\n');
      }, 15_000);
      heartbeat.unref();
    } catch (error) {
      cleanup();
      if (res.headersSent) res.destroy();
      else routeError(error, next);
    }
  });
  app.post(
    `${base}/:runId/cancel`,
    route(async (req) => {
      const input = z
        .strictObject({ reason: z.string().trim().min(1).max(1000).optional() })
        .safeParse(req.body ?? {});
      if (!input.success) throw new ApiError(400, 'Provide a short reason for stopping the run.');
      const projectId = String(req.params.id);
      const run = await host.get(projectId, String(req.params.runId));
      if (run.capabilityId === CODEX_REPORT.id) {
        if (!run.sessionId) throw new ApiError(409, 'This run has no owning session.');
        await store.locked(() => host.bridge.stop(projectId, run.sessionId!, input.data.reason));
        await host.bridge.flush();
        return host.get(projectId, run.id);
      }
      await store.locked(() =>
        host.runs.cancel(
          run.id,
          input.data.reason ?? 'Stopped by the person.',
          localHarnessPrincipal(projectId),
        ),
      );
      await host.bridge.flush();
      return host.get(projectId, run.id);
    }),
  );
}
