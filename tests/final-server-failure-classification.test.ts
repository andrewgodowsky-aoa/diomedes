/**
 * Final hostile pass, server side: what a refusal is read from.
 *
 * The repair replaced "serialise the payload and search it for a word" with
 * "read the fields a payload uses to say what went wrong". These cases ask
 * whether the fields it reads are still the failure's own fields when the
 * caller hands it a whole frame rather than the frame's error.
 */
import { describe, expect, it } from 'vitest';
import { failureKind } from '../server/engines/process.js';

describe('the fields a failure is classified from', () => {
  it('reads a denial and a limit the payload actually names', () => {
    expect(failureKind({ name: 'ProviderAuthError' })).toBe('denied');
    expect(failureKind({ error: { type: 'rate_limit_error' } })).toBe('limited');
    expect(failureKind({}, 403)).toBe('denied');
    // The word inside another word is what this replaced.
    expect(failureKind({ message: 'The authority certificate chain is untrusted.' })).toBe(
      'unknown',
    );
  });

  it('does not take a refusal from free text belonging to something else', () => {
    // A Claude Code result frame with no `errors` array is handed whole
    // (`server/engines/claude.ts`, `failure(frame.errors ?? frame, phase)`), so
    // every named text field anywhere inside it feeds the fallback. Here the
    // only such field describes a tool the model asked for; the failure itself
    // says only that execution stopped.
    const frame = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'stopped',
      permission_denials: [
        { tool_name: 'Bash', tool_input: { description: 'rotate the api key for the deploy' } },
      ],
    };
    expect(failureKind(frame)).toBe('unknown');
  });

  it('does not take a service limit from text belonging to something else', () => {
    const frame = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      permission_denials: [
        { tool_name: 'Bash', tool_input: { description: 'report which customers are over quota' } },
      ],
    };
    expect(failureKind(frame)).toBe('unknown');
  });
});
