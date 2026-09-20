/**
 * Hostile verification of "one next action".
 *
 * `shared/connection-policy.ts` is the one rule, `EngineService.nextAction`
 * applies it with two documented pre-emptions, and `client/ai-setup-state.ts`
 * only renders the answer. These tests look for a state where the host's own
 * action disagrees with the facts the same record makes the screen say.
 *
 * Nothing here edits product code, calls a provider or reads a credential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { EngineError } from '../server/engines/process.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { nextSetupAction, type SetupObservation } from '../shared/connection-policy.js';
import { routeIssueSentences, setupStates } from '../client/ai-setup-state.js';
import type { DiscoveredInstallation } from '../server/discovery.js';
import type { AdapterInspection, TextRequest, TextResponse } from '../server/engines/contract.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';

const ENGINE: ExternalEngine = 'opencode';
const VERSION = TESTED_VERSIONS[ENGINE];
const ROUTE = 'opencode:opencode-go';
const READY = { enabled: true, installSupported: true };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temporary(prefix: string) {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(made);
  return made;
}

function host() {
  const serviceRoot = temporary('diomedes-hostile-');
  const toolsRoot = temporary('diomedes-hostile-tools-');
  const file = path.join(toolsRoot, 'opencode.exe');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'binary');
  let inspection: AdapterInspection | (() => never) = {
    authentication: 'signed-in',
    accountRoute: ROUTE,
    models: [],
    detail: 'Checked',
  };
  const inspect = vi.fn(async () => {
    if (typeof inspection === 'function') inspection();
    return structuredClone(inspection as AdapterInspection);
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
    buildId: () => 'hostile-build',
    adapter: (id) => ({
      id,
      contract: routeContractFor(id),
      inspect,
      generate: (async () => {
        throw new Error('no provider call in this test');
      }) as unknown as (input: TextRequest) => Promise<TextResponse>,
    }),
  });
  return {
    service,
    say: (next: AdapterInspection | (() => never)) => {
      inspection = next;
    },
  };
}

const connection = (service: EngineService) =>
  service.status().find((row) => row.engine === ENGINE)!;

describe('a route issue that is no longer what the tool reports', () => {
  it('keeps explaining an account route after the tool says the person is signed out', async () => {
    const h = host();
    // First check: the tool answers, and reports an account this route refuses.
    h.say({
      authentication: 'unknown',
      accountRoute: null,
      models: [],
      detail: 'Other providers are connected.',
      routeIssue: { required: ROUTE, connected: ['anthropic'] },
    });
    await h.service.discover(true);
    await h.service.check(ENGINE);
    expect(connection(h.service).routeIssue).toEqual({
      required: ROUTE,
      connected: ['anthropic'],
    });

    // The person signs out of the tool entirely. The next check is refused for
    // authentication, which is a different situation from holding another route.
    h.say(() => {
      throw new EngineError('AUTH_REQUIRED', 'Sign in to OpenCode, then recheck.');
    });
    await expect(h.service.check(ENGINE)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    const after = connection(h.service);
    expect(after.authentication).toBe('signed-out');
    // The catch clears accountRoute and the model list; the route issue it
    // contradicts is left standing (server/engines/service.ts:791-811).
    expect(after.routeIssue).toBeNull();
  });

  it('does not make the screen assert a route the same record says was never reported', async () => {
    const h = host();
    h.say({
      authentication: 'unknown',
      accountRoute: null,
      models: [],
      detail: 'Other providers are connected.',
      routeIssue: { required: ROUTE, connected: ['anthropic'] },
    });
    await h.service.discover(true);
    await h.service.check(ENGINE);
    h.say(() => {
      throw new EngineError('AUTH_REQUIRED', 'Sign in to OpenCode, then recheck.');
    });
    await expect(h.service.check(ENGINE)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    const after = connection(h.service);
    const account = setupStates(after).find((row) => row.key === 'account')!;
    const sentences = routeIssueSentences(after, 'OpenCode');
    // One record cannot both say the account was not detected and say the tool
    // reported which accounts it holds.
    expect([account.value, sentences.length]).toEqual(['no', 0]);
  });

  it('does not answer a failure to start the tool by explaining an account route', async () => {
    const h = host();
    h.say({
      authentication: 'unknown',
      accountRoute: null,
      models: [],
      detail: 'Other providers are connected.',
      routeIssue: { required: ROUTE, connected: ['anthropic'] },
    });
    await h.service.discover(true);
    await h.service.check(ENGINE);
    // The tool now will not start at all. Nothing was learned about any
    // account, and the recorded stage says so.
    h.say(() => {
      throw new EngineError(
        'LAUNCH_FAILED',
        'OpenCode could not be started.',
        true,
        'launch',
      );
    });
    await expect(h.service.check(ENGINE)).rejects.toMatchObject({ code: 'LAUNCH_FAILED' });

    const after = connection(h.service);
    expect(after.diagnostic?.stage).toBe('launch');
    // The one next action must belong to the stage that failed.
    expect(h.service.nextAction(ENGINE, READY)).not.toBe('explain-account-route');
  });

  it('agrees with the shared rule about which action that state deserves', async () => {
    const h = host();
    h.say({
      authentication: 'unknown',
      accountRoute: null,
      models: [],
      detail: 'Other providers are connected.',
      routeIssue: { required: ROUTE, connected: ['anthropic'] },
    });
    await h.service.discover(true);
    await h.service.check(ENGINE);
    h.say(() => {
      throw new EngineError('AUTH_REQUIRED', 'Sign in to OpenCode, then recheck.');
    });
    await expect(h.service.check(ENGINE)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    const after = connection(h.service);
    const observation: SetupObservation = {
      installation: 'ready',
      installSupported: true,
      authentication: after.authentication,
      accountRouteAllowed: true,
      modelCount: after.models.length,
      enabled: true,
      checkedAt: after.checkedAt,
      revision: after.revision ?? 0,
      verifiedRevision: null,
    };
    expect(h.service.nextAction(ENGINE, READY)).toBe(nextSetupAction(observation, Date.now()));
  });
});

describe('the shared rule over the whole state space', () => {
  /**
   * Every combination the host can observe, checked for two properties: the
   * rule answers, and it never says `ready` while a fact that a screen shows
   * as a problem is still true.
   */
  it('never reports ready while any state the screen shows is still unmet', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const fresh = new Date(now - 1000).toISOString();
    const stale = new Date(now - 600_000).toISOString();
    const installations = ['missing', 'unsupported', 'corrupt', 'ready'] as const;
    const authentications = ['unknown', 'signed-in', 'signed-out'] as const;
    const times = [null, fresh, stale, 'not a date', new Date(now + 60_000).toISOString()];
    let ready = 0;
    for (const installation of installations)
      for (const installSupported of [true, false])
        for (const authentication of authentications)
          for (const accountRouteAllowed of [true, false])
            for (const modelCount of [0, 3])
              for (const enabled of [true, false])
                for (const checkedAt of times)
                  for (const [revision, verifiedRevision] of [
                    [0, null],
                    [1, null],
                    [1, 0],
                    [1, 1],
                  ] as [number, number | null][]) {
                    const observation: SetupObservation = {
                      installation,
                      installSupported,
                      authentication,
                      accountRouteAllowed,
                      modelCount,
                      enabled,
                      checkedAt,
                      revision,
                      verifiedRevision,
                    };
                    const action = nextSetupAction(observation, now);
                    if (action !== 'ready') continue;
                    ready += 1;
                    expect(observation).toMatchObject({
                      installation: 'ready',
                      authentication: 'signed-in',
                      accountRouteAllowed: true,
                      enabled: true,
                      checkedAt: fresh,
                    });
                    expect(observation.modelCount).toBeGreaterThan(0);
                    expect(observation.verifiedRevision).toBe(observation.revision);
                  }
    expect(ready).toBeGreaterThan(0);
  });

  it('refuses a nonsense observation rather than guessing an action', () => {
    const base: SetupObservation = {
      installation: 'ready',
      installSupported: true,
      authentication: 'signed-in',
      accountRouteAllowed: true,
      modelCount: 1,
      enabled: true,
      checkedAt: null,
      revision: 0,
      verifiedRevision: null,
    };
    expect(() => nextSetupAction({ ...base, modelCount: -1 }, Date.now())).toThrow(RangeError);
    expect(() => nextSetupAction({ ...base, revision: 1.5 }, Date.now())).toThrow(RangeError);
    expect(() => nextSetupAction({ ...base, verifiedRevision: -2 }, Date.now())).toThrow(RangeError);
    expect(() => nextSetupAction(base, Number.NaN)).toThrow(RangeError);
  });
});
