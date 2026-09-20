/**
 * The sign-in wait is described as time-bounded. It is not: it is bounded by a
 * status payload arriving.
 *
 * While a route is waiting, the card hides its primary control, its check
 * control and the whole paid-test block (`client/AISetup.tsx:680`, `:712`,
 * `:887`). The wait leaves that state only inside `advanceWatches`, and
 * `advanceWatches` only runs from the success path of `refreshStatus`
 * (`client/AISetup.tsx:166`). A `GET /ai/status` that keeps failing — the host
 * busy, the loopback port taken, the machine asleep — calls `setStatusError`
 * and returns without folding, so `nowMs - endedAtMs >= SIGN_IN_SETTLE_MS` is
 * never evaluated, the poll interval never stops and the card never offers a
 * next action again until the person closes Settings.
 *
 * These assertions state the requirement rather than the current behaviour, so
 * red here means the gate can still outlive its budget.
 */
import { describe, expect, it } from 'vitest';
import type { EngineConnection } from '../shared/engines.js';
import {
  SIGN_IN_SETTLE_MS,
  advanceSignIn,
  advanceWatches,
  signingIn,
} from '../client/ai-setup-state.js';
import type { SignInWatch } from '../client/ai-setup-state.js';

const START = 1_000_000;

const checking: SignInWatch = {
  state: 'checking',
  startedAtMs: START,
  endedAtMs: START + 500,
};

function connection(overrides: Partial<EngineConnection> = {}): EngineConnection {
  return {
    engine: 'opencode',
    installation: 'found',
    compatibility: 'supported',
    authentication: 'signed-out',
    accountRoute: null,
    models: [],
    // Older than the moment this wait began, so it never settles the wait.
    checkedAt: new Date(START - 60_000).toISOString(),
    detail: 'A fixture connection.',
    usage: { state: 'unknown', checkedAt: null },
    signInWindow: 'idle',
    ...overrides,
  };
}

describe('a sign-in wait that no status answer arrives for', () => {
  it('is over once its settle budget has passed, whether or not a row arrived', () => {
    const far = START + SIGN_IN_SETTLE_MS * 100;
    const folded = advanceWatches({ opencode: checking }, [], far);
    expect(
      signingIn(folded['opencode']),
      'a wait long past its budget still gates the card when no connection row arrived',
    ).toBe(false);
  });

  it('is over on the clock alone, so a failing status read cannot hold the gate open', () => {
    const far = START + SIGN_IN_SETTLE_MS * 100;
    // The same fold the card runs, given the rows it already holds rather than
    // rows a failed read never returned. The host is not reporting a window and
    // its last check is older than the wait, which is exactly the record a card
    // sits on while `/ai/status` is erroring.
    const stale = advanceSignIn(checking, connection({ signInWindow: undefined }), far);
    expect(
      signingIn(stale),
      'a payload that says nothing about a window still has to let the budget expire',
    ).toBe(false);
  });

  it('settles normally when a payload does arrive after the budget', () => {
    const far = START + SIGN_IN_SETTLE_MS * 2;
    const folded = advanceWatches({ opencode: checking }, [connection()], far);
    expect(signingIn(folded['opencode'])).toBe(false);
  });
});
