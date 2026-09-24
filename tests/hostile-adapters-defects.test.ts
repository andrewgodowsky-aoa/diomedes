import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { OpenCodeAdapter, OPENCODE_ACCOUNT_ROUTE } from '../server/engines/opencode.js';
import { engineEnvironment, openProcess } from '../server/engines/process.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import type { AdapterInspection, TextRequest, TextResponse } from '../server/engines/contract.js';
import type { DiscoveredInstallation } from '../server/discovery.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';

/**
 * Hostile verification of the first-run repair, adapters area (F02, F04, F07).
 *
 * EVERY TEST IN THIS FILE, BUT THE ONE NAMED "control", IS EXPECTED TO FAIL
 * against the code as written. Each one asserts the behaviour the repair's own
 * brief and design record promise, and its failure is the evidence that the
 * promise is not kept. Nothing here is a fix; product code is untouched.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const CATALOGUE = {
  connected: ['opencode-go'],
  all: [{ id: 'opencode-go', models: { 'go-model': { id: 'go-model', name: 'Go model' } } }],
};

const request = (signal?: AbortSignal): TextRequest => ({
  projectId: 'p1',
  threadId: 't1',
  requestId: 'r1',
  model: 'opencode-go/go-model',
  accountRoute: OPENCODE_ACCOUNT_ROUTE,
  instructions: '',
  prompt: 'Question',
  documents: [],
  signal,
});

/**
 * A child handle the adapter owns and that is already reapable: `pid` is absent,
 * so `killOwnedProcess` returns without reaching `taskkill`. Nothing real runs.
 */
function stubChild(): ChildProcessWithoutNullStreams {
  return {
    stdout: { resume() {} },
    stderr: { resume() {} },
    once() {
      return this;
    },
    exitCode: null,
    signalCode: null,
    pid: undefined,
  } as unknown as ChildProcessWithoutNullStreams;
}

interface Script {
  provider?: () => Response;
  session?: () => Response;
  prompt?: () => Response;
  /** Written into the event stream as soon as it is opened. */
  events?: string;
  /**
   * Called when the prompt is dispatched, before its acceptance is answered, so
   * a test can abort at the one moment "after dispatch" names rather than at a
   * wall-clock guess that a slow runner reaches before dispatch.
   */
  onDispatch?: () => void;
}

async function adapterFor(script: Script, requestTimeoutMs = 30_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostile-opencode-'));
  roots.push(root);
  const encoder = new TextEncoder();
  const fetcher = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const signal = init.signal ?? undefined;
    // As a real fetch does: a signal that is already aborted rejects before any
    // response. Without this, a Stop landing before the event stream opens on a
    // slow runner left the stream's abort listener unfired and the read hung.
    signal?.throwIfAborted();
    if (url.endsWith('/provider'))
      return script.provider ? script.provider() : new Response(JSON.stringify(CATALOGUE));
    if (url.endsWith('/event')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(signal.reason);
              } catch {
                /* The stream is already finished. */
              }
            },
            { once: true },
          );
          if (script.events) controller.enqueue(encoder.encode(script.events));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (url.endsWith('/session'))
      return script.session ? script.session() : new Response(JSON.stringify({ id: 'session-1' }));
    if (url.endsWith('/prompt_async')) {
      script.onDispatch?.();
      return script.prompt ? script.prompt() : new Response(null, { status: 204 });
    }
    return new Response('true', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return new OpenCodeAdapter('opencode', root, {
    fetch: fetcher,
    spawn: () => stubChild(),
    reservePort: async () => 45_123,
    startupTimeoutMs: 5_000,
    requestTimeoutMs,
  });
}

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { code: string; stage?: string; message: string; ambiguous?: boolean }) => error,
  );

describe('a timeout the host imposed is not the person stopping the request', () => {
  /**
   * `EngineService.test()` gives a connection test a 60-second budget by merging
   * `AbortSignal.timeout(TEST_TIMEOUT_MS)` into the signal the adapter receives
   * (server/engines/service.ts:1110-1113). Every adapter reads an externally
   * aborted signal as a person pressing stop, so the one way a consented test
   * can run out of time tells that person they cancelled it.
   */
  it('reports a caller-imposed timeout after dispatch as a timeout, not a cancellation', async () => {
    // The reason a real `AbortSignal.timeout()` aborts with, delivered at
    // dispatch: the deadline lands after the prompt is out however slow the runner.
    const expired = AbortSignal.timeout(0);
    await new Promise((resolve) => expired.addEventListener('abort', resolve, { once: true }));
    const controller = new AbortController();
    const adapter = await adapterFor({ onDispatch: () => controller.abort(expired.reason) });
    const failure = await failureOf(adapter.generate(request(controller.signal)));
    expect(failure?.code).toBe('TIMEOUT');
    expect(failure?.stage).toBe('stream');
    expect(failure?.message).not.toMatch(/was stopped/i);
  });
  it('control: the adapter names its own request budget a timeout', async () => {
    const adapter = await adapterFor({}, 120);
    const failure = await failureOf(adapter.generate(request()));
    expect(failure?.code).toBe('TIMEOUT');
  });
  it('reports a run the host withdrew as the host withdrawing it, not the person stopping', async () => {
    // The harness aborts a run whose lease went stale with an error-shaped
    // reason. This route used to answer that with "The request was stopped.",
    // the sentence for a person pressing stop, while the other four did not.
    const controller = new AbortController();
    const adapter = await adapterFor({
      onDispatch: () =>
        controller.abort(Object.assign(new Error('stale_lease'), { name: 'HarnessError' })),
    });
    const failure = await failureOf(adapter.generate(request(controller.signal)));
    expect(failure?.code).toBe('DISPATCH_UNCERTAIN');
    expect(failure?.stage).toBe('stream');
    expect(failure?.message).not.toMatch(/was stopped/i);
    expect(failure?.ambiguous).toBe(true);
  });
  it('still reports a person pressing stop as the request being stopped', async () => {
    const controller = new AbortController();
    const adapter = await adapterFor({ onDispatch: () => controller.abort() });
    const failure = await failureOf(adapter.generate(request(controller.signal)));
    expect(failure?.code).toBe('CANCELLED');
    expect(failure?.stage).toBe('stream');
  });
});

describe('a refusal is read from what the payload says, not from a number inside it', () => {
  /**
   * `UPSTREAM_DENIAL` (server/engines/opencode.ts:222) matches `\b40[13]\b`
   * against the serialised payload, so any field whose value happens to be 401
   * or 403 — an elapsed time, a token count, a line number — turns an ordinary
   * provider fault into "check that account", at the wrong stage.
   */
  it('does not read an elapsed time of 403 milliseconds as an account denial', async () => {
    const adapter = await adapterFor({
      events: `data: ${JSON.stringify({
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: {
            name: 'ModelStalledError',
            data: { message: 'The model stopped responding.', elapsedMs: 403 },
          },
        },
      })}\n\n`,
    });
    const failure = await failureOf(adapter.generate(request()));
    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR', stage: 'stream' });
    expect(failure?.message).not.toMatch(/account/i);
  });
  /**
   * `errorForResponse` (server/engines/opencode.ts:199) matches the bare word
   * `usage` anywhere in a non-ok body, so a local server fault that happens to
   * carry a usage field is reported to the person as a service limit.
   */
  it('does not read a 500 whose body carries a usage field as a service limit', async () => {
    const adapter = await adapterFor({
      session: () =>
        new Response(
          JSON.stringify({ error: { message: 'internal error' }, usage: { input: 0, output: 0 } }),
          { status: 500 },
        ),
    });
    const failure = await failureOf(adapter.generate(request()));
    expect(failure?.code).toBe('PROVIDER_ERROR');
    expect(failure?.message).not.toMatch(/limit/i);
  });
});

describe('the same reading of a payload appears in a second adapter', () => {
  /**
   * `failure()` in server/engines/claude.ts:92 tests `/auth|login|sign.?in|
   * unauthorized/i` against the serialised result frame. `auth` is a substring
   * of `authority`, so the enterprise-CA and proxy case the audit names among
   * its hostile machines is answered with "Claude Code needs sign-in" — the
   * blanket sign-in advice the repair exists to remove.
   */
  it('does not read a certificate authority failure as a missing sign-in', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostile-claude-'));
    roots.push(root);
    const { ClaudeAdapter } = await import('../server/engines/claude.js');
    let initialized = '';
    const child = {
      send(frame: { type?: string; request_id?: string }) {
        if (frame.type === 'control_request') initialized = frame.request_id ?? '';
      },
      async next() {
        if (initialized) {
          const id = initialized;
          initialized = '';
          return {
            type: 'control_response',
            response: { request_id: id, subtype: 'success', response: { models: [] } },
          };
        }
        return {
          type: 'result',
          is_error: true,
          subtype: 'error_during_execution',
          errors: {
            message: 'unable to verify the certificate authority for the configured proxy',
          },
        };
      },
      async close() {},
    };
    const adapter = new ClaudeAdapter(path.join(root, 'claude.exe'), root, {
      launch: () => child as never,
      account: async () => ({ loggedIn: true, authMethod: 'claude.ai' }),
    });
    const failure = await failureOf(
      adapter.generate({ ...request(), model: 'sonnet', accountRoute: 'claude-code:claude.ai' }),
    );
    expect(failure?.code).toBe('PROVIDER_ERROR');
    expect(failure?.message).not.toMatch(/sign.?in/i);
  });
});

describe('the identifiers that ride in a route issue are provider ids and nothing else', () => {
  /**
   * `PROVIDER_ID` (server/engines/opencode.ts:258) bounds shape and length only.
   * A 64-character opaque secret and a customer's own account name both satisfy
   * it, and `routeIssue.connected` is copied verbatim into the setup screen
   * (client/ai-setup-state.ts:319-327) and into the support bundle a person
   * sends to someone else (server/support-bundle.ts:321-325).
   */
  it('drops an opaque secret-shaped identifier rather than publishing it', async () => {
    const secret = `sk-proj-${'A1b2C3d4E5f6G7h8J9k0'.repeat(3).slice(0, 56)}`;
    expect(secret).toHaveLength(64);
    const adapter = await adapterFor({
      provider: () => new Response(JSON.stringify({ connected: [secret], all: [] })),
    });
    const inspection = await adapter.inspect();
    expect(inspection.routeIssue?.connected).not.toContain(secret);
  });
  it('drops an account name rather than publishing it', async () => {
    const account = 'acme-holdings-inc';
    const adapter = await adapterFor({
      provider: () => new Response(JSON.stringify({ connected: [account], all: [] })),
    });
    const inspection = await adapter.inspect();
    expect(inspection.routeIssue?.connected).not.toContain(account);
  });
});

describe('the shared owned-process reader reads a host budget the same wrong way', () => {
  /**
   * The same confusion as the OpenCode case above, one layer down: every
   * process-based adapter (claude, oh-my-pi, cursor, devin) reaches
   * `EngineProcess`, whose abort listener is `() => this.fail(stopped())`
   * (server/engines/process.ts:89). A 60-second connection-test budget is an
   * abort, so the four remaining routes report a person's own cancellation too.
   */
  it('reports a caller-imposed timeout on an owned process as a timeout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostile-process-'));
    roots.push(root);
    const child = openProcess({
      file: process.execPath,
      args: ['-e', 'setTimeout(function(){}, 30000)'],
      cwd: root,
      env: engineEnvironment(),
      signal: AbortSignal.timeout(150),
      timeoutMs: 30_000,
    });
    const failure = await child.nextLine().then(
      () => undefined,
      (error: { code: string; message: string }) => error,
    );
    await child.close().catch(() => {
      /* Cleanup is not what this test is about. */
    });
    expect(failure?.code).toBe('TIMEOUT');
    expect(failure?.message).not.toMatch(/was stopped/i);
  }, 20_000);
});

/**
 * A sign-in window closing promises one thing on screen: "Diomedes checks this
 * service again when this window closes" (server/engines/login.ts:209). The
 * host answers that promise with `engines.check(engine)` and throws the answer
 * away when a check is already running (server/app.ts:471), and `check` refuses
 * a concurrent caller instead of joining the one in flight
 * (server/engines/service.ts:731-735). A check that started before the sign-in
 * finished therefore becomes the last word.
 */
describe('a sign-in that finishes while a check is running is still re-checked', () => {
  const ENGINE: ExternalEngine = 'opencode';
  const VERSION = TESTED_VERSIONS[ENGINE];
  const ROUTE = 'opencode:opencode-go';
  const MODELS = [
    { slug: 'go-model', name: 'Go model', description: '', efforts: [], defaultEffort: null },
  ];
  function host() {
    const serviceRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hostile-recheck-'));
    roots.push(serviceRoot);
    const file = path.join(serviceRoot, 'tools', 'opencode.exe');
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, 'binary');
    let inspection: AdapterInspection = {
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
      detail: 'Sign in to the native OpenCode Go account before using this route.',
    };
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let slow = true;
    const inspect = vi.fn(async () => {
      // What the tool answered when this check started. A check that began
      // before the sign-in finished cannot have seen the account that finished
      // after it, so the snapshot is taken here and not after the wait.
      const answered = structuredClone(inspection);
      reached();
      if (slow) await held;
      return answered;
    });
    const rows: IntegrationStatus[] = [
      {
        id: ENGINE,
        name: ENGINE,
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Found',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: VERSION,
        location: file,
        disclosure: [],
      },
    ];
    const installations: DiscoveredInstallation[] = [
      { engine: ENGINE, path: file, context: 'windows-native' },
    ];
    const service = new EngineService(serviceRoot, {
      discover: async () => rows,
      enumerate: async () => installations,
      version: async () => VERSION,
      buildId: () => 'test-build',
      adapter: (id) => ({
        id,
        contract: routeContractFor(id),
        inspect,
        generate: async () => ({}) as TextResponse,
      }),
    });
    return {
      service,
      entered,
      signIn: () => {
        inspection = {
          authentication: 'signed-in',
          accountRoute: ROUTE,
          models: MODELS.map((row) => ({ ...row })),
          detail: 'Native OpenCode Go account connected.',
        };
      },
      release: () => {
        slow = false;
        release();
      },
    };
  }
  it('does not let a check that began before the sign-in be the last word', async () => {
    const h = host();
    await h.service.discover(true);
    // A person presses Check, and the route is slow to answer.
    const first = h.service.check(ENGINE);
    await h.entered;
    // While it runs they finish the native sign-in and the window closes.
    h.signIn();
    // A second check is refused rather than joined: the one in flight began
    // before the sign-in, so its answer could not be the one that was promised.
    await expect(h.service.check(ENGINE)).rejects.toMatchObject({ code: 'REQUEST_ACTIVE' });
    // So the host waits for the check in flight and then looks again. This is
    // the sequence server/app.ts runs when the window closes; the wiring itself
    // is proved through createApp in tests/sign-in-recheck-wiring.test.ts.
    const recheck = h.service
      .settled(ENGINE)
      .then(() => h.service.check(ENGINE))
      .then(
        () => 'checked',
        (error: { code: string }) => error.code,
      );
    h.release();
    await first;
    expect(await recheck).toBe('checked');
    // What the person sees after finishing sign-in and closing the window.
    expect(h.service.status().find((row) => row.engine === ENGINE)?.authentication).toBe(
      'signed-in',
    );
  }, 20_000);
});
