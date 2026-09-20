/**
 * Hostile verification of the two documents this repair rewrote.
 *
 * Each case pairs one sentence with the code it describes at this commit.
 * A failure here is a sentence the tree contradicts, which AGENTS.md's
 * completion rule ("nothing in the tree claims a capability is shipped that is
 * not shipped") treats as a defect in its own right.
 *
 * Read-only: no document is edited.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const readme = read('README.md');
const record = read('docs/implementation/2026-09-20-first-run-repair.md');

describe('README sentences against the code at this commit', () => {
  it('does not say the route profiles are unread', () => {
    // client/AISetup.tsx:6 and scripts/write-capability-record.ts:27 both
    // import ENGINE_ROUTE_PROFILES, and the record says the setup screen
    // renders them.
    expect(read('client/AISetup.tsx')).toContain('ENGINE_ROUTE_PROFILES');
    expect(record.replace(/\s+/g, ' ')).toContain('setup screen renders the same profiles');
    expect(readme).not.toContain('nothing reads it yet');
  });

  it('does not say an adapter still reports another account as signed out', () => {
    for (const adapter of ['claude', 'opencode', 'omp'])
      expect(read(`server/engines/${adapter}.ts`), adapter).toContain('routeIssue:');
    expect(readme).not.toContain('still reports an unsupported account as signed out');
  });

  it('lists every state checking this computer can actually end in', () => {
    // client/ai-setup-state.ts:84-95 renders six installation states and a
    // separate Test state. The README presents its list as exhaustive:
    // "Checking this computer ends in one of these".
    expect(readme).toContain('Checking this computer ends in one of these');
    expect(readme).toMatch(/integrity check/i);
    expect(readme).toMatch(/needs repair/i);
  });

  it('mentions the consented test that now stands between Ready and a real result', () => {
    // README's "Ready" is the state `EngineService.generate()` admits on
    // (service.ts:1278-1288, which needs no receipt). `SetupAction 'ready'`
    // is a different state: shared/connection-policy.ts:154 answers
    // `test-connection` until a receipt matches the binding revision, and
    // client/ai-setup-state.ts:114-119 renders a fourth Test row for it.
    // One word, two meanings, and the README never names the test.
    expect(readme).toMatch(/test this connection|connection test|test succeeded/i);
  });
});

describe('the implementation record against its own lanes', () => {
  it('carries no unfilled cell on a commit that integrates the lanes', () => {
    expect(record).not.toContain('TO BE FILLED');
  });

  it('keeps naming the four things this work does not prove', () => {
    for (const sentence of [
      'A clean Windows standard-user install of the exact artifact',
      'A real consented provider result',
      'Restart and repeat',
      "The reporting customer's diagnosis",
    ])
      expect(record, sentence).toContain(sentence);
  });

  it('does not describe a lane as landed while its cell is empty', () => {
    // The sentence that closes the table. Without it `indexOf` answers -1 and
    // the slice quietly runs to the end of the file instead of the table.
    const end = record.indexOf('Each row names what git holds');
    expect(end).toBeGreaterThan(0);
    const table = record.slice(record.indexOf('| Lane |'), end);
    const lanes = table
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split('|')[1].trim());
    const unfilled = table
      .split('\n')
      .filter((line) => line.includes('TO BE FILLED'))
      .map((line) => line.split('|')[1].trim());
    expect(lanes.length).toBeGreaterThan(0);
    expect({ lanes: lanes.length, unfilled: unfilled.length }).toMatchObject({ unfilled: 0 });
  });
});
