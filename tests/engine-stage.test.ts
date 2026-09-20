import { describe, expect, it } from 'vitest';
import { cleanupFailed, EngineError, staged } from '../server/engines/process.js';

/**
 * The one failure-stage classifier the process adapters share. Every adapter
 * that drives a child process fails asynchronously: a spawn `error` event
 * surfaces out of whichever protocol read notices it first, so the phase the
 * caller had reached is not on its own the stage that failure belongs to.
 *
 * These cases are the rules as the code applies them, in the order it applies
 * them. They are a pure unit test: nothing here launches anything.
 */
describe('the stage an untagged engine failure belongs to', () => {
  it('returns anything that is not an engine failure untouched', () => {
    const plain = new Error('not ours');
    expect(staged(plain, 'launch')).toBe(plain);
    expect(staged('a string', 'launch')).toBe('a string');
    expect(staged(undefined, 'launch')).toBeUndefined();
  });

  it('keeps a stage the thrower already knew', () => {
    const error = new EngineError('TIMEOUT', 'Timed out.', true, 'stream');
    expect(staged(error, 'launch').stage).toBe('stream');
  });

  it('tags the error in place rather than returning a copy', () => {
    const error = new EngineError('PROTOCOL_ERROR', 'Unreadable.');
    expect(staged(error, 'local-handshake')).toBe(error);
    expect(error.stage).toBe('local-handshake');
  });

  it('gives a cleanup fault reported on its own the cleanup stage', () => {
    const fault = cleanupFailed();
    expect(fault.code).toBe('CLEANUP_FAILED');
    expect(staged(fault, 'dispatch').stage).toBe('cleanup');
  });

  it('gives a cleanup fault the stage of the failure it is reported with', () => {
    const primary = new EngineError('PROVIDER_ERROR', 'Upstream refused.', true, 'stream');
    const fault = cleanupFailed(primary);
    expect(staged(fault, 'launch', primary).stage).toBe('stream');
  });

  it('reads a sign-in denial as the provider account, wherever it surfaced', () => {
    const error = new EngineError('AUTH_REQUIRED', 'Sign in.');
    expect(staged(error, 'dispatch').stage).toBe('provider-auth');
    expect(staged(new EngineError('AUTH_REQUIRED', 'Sign in.'), 'launch').stage).toBe(
      'provider-auth',
    );
  });

  it('prefers the stage of the failure being reported with over the code rules', () => {
    // A cleanup fault carrying a sign-in denial's code still belongs where that
    // denial was found: the primary's own stage is consulted before any code.
    const primary = new EngineError('AUTH_REQUIRED', 'Sign in.', true, 'launch');
    const fault = cleanupFailed(primary);
    expect(fault.code).toBe('AUTH_REQUIRED');
    expect(staged(fault, 'model-list', primary).stage).toBe('launch');
  });

  it('ignores a primary that never reached a stage of its own', () => {
    const primary = new EngineError('PROVIDER_ERROR', 'Upstream refused.');
    const error = new EngineError('PROTOCOL_ERROR', 'Unreadable.');
    expect(staged(error, 'model-list', primary).stage).toBe('model-list');
  });

  for (const code of ['LAUNCH_FAILED', 'PROCESS_EXITED', 'TIMEOUT']) {
    it(`reads ${code} before the session exists as a launch failure`, () => {
      expect(staged(new EngineError(code, 'Gone.'), 'launch').stage).toBe('launch');
      expect(staged(new EngineError(code, 'Gone.'), 'local-handshake').stage).toBe('launch');
    });

    it(`keeps ${code} at the phase it reached once the session exists`, () => {
      expect(staged(new EngineError(code, 'Gone.'), 'dispatch').stage).toBe('dispatch');
      expect(staged(new EngineError(code, 'Gone.'), 'stream').stage).toBe('stream');
      expect(staged(new EngineError(code, 'Gone.'), 'provider-auth').stage).toBe('provider-auth');
    });
  }

  it('leaves any other code at the phase the attempt had reached', () => {
    expect(staged(new EngineError('PROTOCOL_ERROR', 'Unreadable.'), 'local-handshake').stage).toBe(
      'local-handshake',
    );
    expect(staged(new EngineError('POLICY_MISMATCH', 'Asked for a tool.'), 'launch').stage).toBe(
      'launch',
    );
    expect(staged(new EngineError('USAGE_LIMIT', 'Out of allowance.'), 'model-list').stage).toBe(
      'model-list',
    );
  });
});
