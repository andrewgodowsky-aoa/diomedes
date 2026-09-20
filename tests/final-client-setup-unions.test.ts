/**
 * Every value the host can put on the wire has a sentence and a control.
 *
 * The setup screen renders one host-derived next action, one repair reason and
 * one failed stage. A value the host can send and the screen has no words for
 * renders as nothing at all: no crash, no label, no way forward. So the unions
 * are enumerated here by hand rather than mapped over, because a value added to
 * `SetupAction`, `RepairReason` or `SetupStage` and not added here fails
 * `npx tsc --noEmit` on the exhaustive maps below, and a value added here and
 * not answered by the screen fails these assertions.
 */
import { describe, expect, it } from 'vitest';
import type { RepairReason, SetupAction } from '../shared/connection-policy.js';
import type { EngineConnection, SetupStage } from '../shared/engines.js';
import { SETUP_STAGES } from '../shared/engines.js';
import {
  primaryControl,
  repairText,
  stageAction,
  stageText,
} from '../client/ai-setup-state.js';

const ACTIONS: Record<SetupAction, true> = {
  install: true,
  repair: true,
  'choose-installation': true,
  'check-connection': true,
  'sign-in': true,
  'explain-account-route': true,
  'resolve-model-access': true,
  enable: true,
  'test-connection': true,
  ready: true,
};

const REASONS: Record<RepairReason, true> = {
  'selected-missing': true,
  'selected-changed': true,
  'selected-unverified': true,
  'no-reviewed-candidate': true,
  'record-unreadable': true,
};

function connection(overrides: Partial<EngineConnection> = {}): EngineConnection {
  return {
    engine: 'opencode',
    installation: 'found',
    compatibility: 'supported',
    authentication: 'signed-in',
    accountRoute: 'opencode:opencode-go',
    models: [],
    checkedAt: '2026-09-20T10:00:00.000Z',
    detail: 'A fixture connection.',
    usage: { state: 'unknown', checkedAt: null },
    ...overrides,
  };
}

describe('every next action the host can send', () => {
  it('has a label on the one primary control, except the one that offers none', () => {
    for (const action of Object.keys(ACTIONS) as SetupAction[]) {
      const control = primaryControl(connection({ nextAction: action }), 'OpenCode');
      expect(control.action, `${action} keeps its own identity`).toBe(action);
      if (action === 'ready') {
        expect(control.intent, 'ready offers no next action').toBe('none');
        expect(control.label).toBe('');
      } else {
        expect(control.intent, `${action} has an intent`).not.toBe('none');
        expect(control.label.trim(), `${action} has a label`).not.toBe('');
      }
    }
  });

  it('falls back to the action that asks the host what is true when none was sent', () => {
    const control = primaryControl(connection({ nextAction: undefined }), 'OpenCode');
    expect(control.action).toBe('check-connection');
    expect(control.label.trim()).not.toBe('');
  });
});

describe('every repair reason the host can send', () => {
  it('names why this route needs repair', () => {
    for (const reason of Object.keys(REASONS) as RepairReason[]) {
      const text = repairText(connection({ repair: reason, location: 'C:\\tools\\opencode.exe' }));
      expect(text.trim(), `${reason} has a sentence`).not.toBe('');
      expect(text, `${reason} says something, not undefined`).not.toContain('undefined');
    }
  });

  /**
   * The screen renders `repairText` straight into the card. A reason it has no
   * case for returns an empty string, so the card shows a route that needs
   * repair and says nothing about why. That is the shape of the failure, not a
   * crash, and it is what this holds the line against.
   */
  it('returns nothing for a reason nobody wrote a sentence for, which is the trap', () => {
    const unknown = repairText(connection({ repair: 'a-reason-from-a-newer-host' as RepairReason }));
    expect(unknown).toBe('');
  });
});

describe('every stage a failure can stop at', () => {
  it('is said in plain words with the action that belongs to it', () => {
    for (const stage of SETUP_STAGES as readonly SetupStage[]) {
      expect(stageText(stage).trim(), `${stage} has words`).not.toBe('');
      expect(stageAction(stage).trim(), `${stage} has an action`).not.toBe('');
      expect(stageAction(stage), `${stage} never says sign in again as a blanket`).not.toMatch(
        /^sign in again/i,
      );
    }
  });
});
