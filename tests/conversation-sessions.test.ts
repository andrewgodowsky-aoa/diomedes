/**
 * The one table a conversation's kept session is chosen from: which route contract, run id,
 * driver and turn each session route uses, and the thread's session view read through it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  KEPT_SESSIONS,
  keptSessionOfRun,
  type KeptSessionEngines,
} from '../server/conversation-sessions';
import { KEPT_SESSION_ROUTES, isKeptSessionRoute } from '../shared/engines';
import { routeContractFor } from '../server/harness/route-contract';
import { modelSessionRunId } from '../server/harness/model-session-run';
import { mountThreadSessionRoute } from '../server/engines/claude-session-routes';
import { sessionControls } from '../shared/session-controls';
import type { TextRequest } from '../server/engines/contract';

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

describe('the kept conversation sessions', () => {
  it('lists Claude Code and the four kept-session engines, each on its own engine session contract', () => {
    expect(KEPT_SESSION_ROUTES).toEqual(['codex', 'opencode', 'cursor', 'devin']);
    expect(isKeptSessionRoute('codex')).toBe(true);
    expect(isKeptSessionRoute('claude-code')).toBe(false);
    expect(isKeptSessionRoute('aws-bedrock')).toBe(false);
    expect(Object.keys(KEPT_SESSIONS)).toEqual(['claude-code', ...KEPT_SESSION_ROUTES]);
    for (const [route, session] of Object.entries(KEPT_SESSIONS)) {
      expect(session.route).toBe(route);
      const contract = routeContractFor(session.routeId);
      expect(contract.mode, route).toBe('external-session');
      expect(contract.engine.id, route).toBe(route);
    }
  });

  it('names each run for its route, and no model-API or ChatGPT work run as a kept session', () => {
    const prefixes = Object.values(KEPT_SESSIONS).map((session) => session.runPrefix);
    for (const session of Object.values(KEPT_SESSIONS)) {
      const runId = session.runId('project-1', 'command-1');
      expect(keptSessionOfRun(runId)).toBe(session);
      // Exactly one route's prefix claims it.
      expect(prefixes.filter((prefix) => runId.startsWith(prefix))).toEqual([session.runPrefix]);
    }
    expect(keptSessionOfRun(modelSessionRunId('project-1', 'command-1'))).toBeNull();
    expect(keptSessionOfRun('codex-work-0123')).toBeNull();
    expect(keptSessionOfRun(undefined)).toBeNull();
    expect(keptSessionOfRun('')).toBeNull();
  });

  it("sends each turn to its own engine's session, passing a queued message only where the route queues", async () => {
    const calls: unknown[][] = [];
    const answer = (name: string) => async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return { runId: 'run-1', response: null, interrupted: false, nativeSession: null };
    };
    const drivers = {
      nativeSessions: { name: 'claude driver' },
      codexSessions: { name: 'codex driver' },
      opencodeSessions: { name: 'opencode driver' },
      cursorSessions: { name: 'cursor driver' },
      devinSessions: { name: 'devin driver' },
    };
    const engines = {
      ...drivers,
      claudeSession: answer('claudeSession'),
      codexSession: answer('codexSession'),
      opencodeSession: answer('opencodeSession'),
      acpSession: answer('acpSession'),
    } as unknown as KeptSessionEngines;
    expect(KEPT_SESSIONS['claude-code'].driver(engines)).toBe(drivers.nativeSessions);
    expect(KEPT_SESSIONS.codex.driver(engines)).toBe(drivers.codexSessions);
    expect(KEPT_SESSIONS.opencode.driver(engines)).toBe(drivers.opencodeSessions);
    expect(KEPT_SESSIONS.cursor.driver(engines)).toBe(drivers.cursorSessions);
    expect(KEPT_SESSIONS.devin.driver(engines)).toBe(drivers.devinSessions);
    const input = { prompt: 'hello' } as unknown as TextRequest;
    for (const session of Object.values(KEPT_SESSIONS))
      await session.turn(engines, 'follow-up', 'run-1', input, undefined, { queued: true });
    expect(calls).toEqual([
      ['claudeSession', 'follow-up', 'run-1', input, undefined, { queued: true }],
      ['codexSession', 'follow-up', 'run-1', input, undefined, { queued: true }],
      ['opencodeSession', 'follow-up', 'run-1', input, undefined, { queued: true }],
      // ACP conversations take no steering: their contract has no steer command.
      ['acpSession', 'cursor', 'follow-up', 'run-1', input, undefined],
      ['acpSession', 'devin', 'follow-up', 'run-1', input, undefined],
    ]);
  });

  it("shows a thread the controls of the session its open run belongs to", async () => {
    let runId: string | null = null;
    const status = async (_projectId: string, id: string) => ({
      runId: id,
      busy: false,
      continuity: null,
      requestedModel: 'fixture-model',
      reportedModel: 'fixture-model',
      steering: [],
    });
    const app = express();
    mountThreadSessionRoute(app, {
      authorize: async () => {},
      lineage: async () => runId,
      engines: {
        nativeSessions: { status },
        codexSessions: { status },
        opencodeSessions: { status },
        cursorSessions: { status },
        devinSessions: { status },
      } as unknown as KeptSessionEngines,
    });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const view = async () =>
      (await fetch(
        `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/projects/p/threads/t/native-session`,
      ).then((response) => response.json())) as { runId: string | null; controls: unknown };
    for (const session of Object.values(KEPT_SESSIONS)) {
      runId = session.runId('p', 'c');
      expect(await view(), session.route).toMatchObject({
        runId,
        controls: sessionControls(routeContractFor(session.routeId)),
      });
    }
    // A model-API conversation has no kept session to control.
    runId = modelSessionRunId('p', 'c');
    expect(await view()).toMatchObject({ runId: null, controls: null });
  });
});
