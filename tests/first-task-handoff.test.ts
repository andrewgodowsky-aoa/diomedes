import { describe, expect, it } from 'vitest';
import type { ConnectionReceipt, EngineConnection } from '../shared/engines.js';
import { firstTaskHandoff } from '../client/ai-setup-state.js';

/**
 * When a route may carry a person straight into their first real task.
 *
 * The answer is the host's, not the screen's: the host says a receipt still
 * names what is selected now by keeping `verification` on the record and by
 * moving `nextAction` to `ready`. A click that succeeded a moment ago proves
 * nothing on its own, so nothing here reads one.
 */

const VERIFIED_AT = '2026-09-20T10:00:00.000Z';

const receipt = (patch: Partial<ConnectionReceipt> = {}): ConnectionReceipt => ({
  engine: 'opencode',
  revision: 3,
  candidateId: 'managed:opencode:C:\\Diomedes\\engines\\opencode\\opencode.exe',
  version: '1.18.4',
  accountRoute: 'opencode:opencode-go',
  model: 'opencode/fixture-model',
  runId: 'run-fixture',
  buildId: 'build-fixture',
  verifiedAt: VERIFIED_AT,
  ...patch,
});

const base: EngineConnection = {
  engine: 'opencode',
  installation: 'found',
  compatibility: 'supported',
  authentication: 'signed-in',
  accountRoute: 'opencode:opencode-go',
  models: [
    {
      slug: 'opencode/fixture-model',
      name: 'Fixture model',
      description: 'A fixture model.',
      defaultEffort: null,
      efforts: [],
    },
  ],
  checkedAt: VERIFIED_AT,
  detail: 'Native OpenCode Go account connected.',
  usage: { state: 'unknown', checkedAt: null },
  revision: 3,
  nextAction: 'ready',
  verification: receipt(),
};

describe('the route a first task may start on', () => {
  it('names the route and the model the host verified', () => {
    expect(firstTaskHandoff(base, 'opencode/fixture-model')).toEqual({
      route: 'opencode',
      model: 'opencode/fixture-model',
    });
  });

  it('offers nothing until the host says this route is ready', () => {
    expect(firstTaskHandoff({ ...base, nextAction: 'test-connection' }, 'opencode/fixture-model'))
      .toBeNull();
    expect(firstTaskHandoff({ ...base, nextAction: undefined }, 'opencode/fixture-model')).toBeNull();
  });

  it('offers nothing when no real request has ever run', () => {
    expect(firstTaskHandoff({ ...base, verification: null }, 'opencode/fixture-model')).toBeNull();
  });

  it('offers nothing when the receipt is for an older binding revision', () => {
    expect(firstTaskHandoff({ ...base, revision: 4 }, 'opencode/fixture-model')).toBeNull();
  });

  it('offers nothing when this route is set to use a different model now', () => {
    expect(firstTaskHandoff(base, 'opencode/another-model')).toBeNull();
    expect(firstTaskHandoff(base, '')).toBeNull();
  });

  it('offers nothing when the account route changed since the receipt', () => {
    expect(
      firstTaskHandoff({ ...base, accountRoute: 'opencode:zen' }, 'opencode/fixture-model'),
    ).toBeNull();
  });
});
