import { describe, expect, test } from 'vitest';
import fixture from './fixtures/instruction-texts.json';
import {
  instructionDigest,
  KNOWN_INSTRUCTION_DIGESTS,
  REVOKED_INSTRUCTION_DIGESTS,
} from '../server/instruction-digests';
import { recordedInstructions, retirementNote } from '../server/lineage-continuity';
import { instructionsFor } from '../server/interaction-turn';
import { MODES } from '../server/modes';

// The golden list: every conversation instruction text a shipped build could have recorded in a
// lineage, each reproducible from its build's own composer output in the fixture. A change to a
// mode's text fails here until its digest is added deliberately, with its fixture, and the old
// digests are kept.

type Row = { build: string; source: string; mode: 'ask' | 'plan' | 'auto'; sha256: string; text: string };
const rows = fixture.texts as Row[];
const LABEL = { ask: 'Ask', plan: 'Plan', auto: 'Automatic' } as const;
const today = (mode: 'ask' | 'plan' | 'auto') => instructionsFor(mode, MODES[mode].instructions);

describe('the known instruction digests', () => {
  test('every fixture text is a known digest, labelled with its mode and build', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(instructionDigest(row.text), `${row.build} ${row.mode}`).toBe(row.sha256);
      const label = KNOWN_INSTRUCTION_DIGESTS.get(row.sha256);
      expect(label, `${row.build} ${row.mode}`).toContain(LABEL[row.mode]);
      expect(label, `${row.build} ${row.mode}`).toContain(row.build);
    }
  });

  test('every known digest is reproducible from a fixture', () => {
    const fixed = new Set(rows.map((row) => row.sha256));
    for (const digest of KNOWN_INSTRUCTION_DIGESTS.keys()) expect(fixed.has(digest), digest).toBe(true);
  });

  test("today's composed Ask, Plan and Automatic texts are known, and are the 0.1.8 fixtures", () => {
    for (const mode of ['ask', 'plan', 'auto'] as const) {
      const text = today(mode);
      expect(KNOWN_INSTRUCTION_DIGESTS.has(instructionDigest(text)), mode).toBe(true);
      expect(rows.find((row) => row.build === '0.1.8' && row.mode === mode)?.text, mode).toBe(text);
    }
  });

  test('v0.1.7 composed all three conversation modes, and the fixtures keep them', () => {
    expect(rows.filter((row) => row.build === 'v0.1.7').map((row) => row.mode).sort()).toEqual(['ask', 'auto', 'plan']);
  });

  test('no text carries a carriage return, whatever the checkout wrote into the source', () => {
    for (const row of rows) expect(row.text.includes('\r'), `${row.build} ${row.mode}`).toBe(false);
    for (const mode of ['ask', 'plan', 'auto'] as const) expect(today(mode).includes('\r')).toBe(false);
  });

  test('nothing is revoked, and no text composed today could be', () => {
    expect([...REVOKED_INSTRUCTION_DIGESTS.keys()]).toEqual([]);
    for (const mode of ['ask', 'plan', 'auto'] as const)
      expect(REVOKED_INSTRUCTION_DIGESTS.has(instructionDigest(today(mode)))).toBe(false);
  });
});

describe('a recorded text', () => {
  const v017Ask = rows.find((row) => row.build === 'v0.1.7' && row.mode === 'ask')!.text;

  test('is kept only when it is known byte for byte', () => {
    expect(recordedInstructions({ instructions: v017Ask })).toEqual({ state: 'known', text: v017Ask });
    const altered = v017Ask.replace('plainly', 'plainly!');
    expect(altered).not.toBe(v017Ask);
    expect(recordedInstructions({ instructions: altered })).toEqual({ state: 'unknown', text: altered });
    expect(recordedInstructions({ instructions: `${v017Ask} ` })).toMatchObject({ state: 'unknown' });
    expect(recordedInstructions({ instructions: 7 })).toEqual({ state: 'absent' });
    expect(recordedInstructions(null)).toEqual({ state: 'absent' });
  });

  test('that changed is explained in plain words', () => {
    expect(retirementNote('instructions')).toBe(
      "Nectovia started this conversation fresh because its instructions changed. Your earlier messages are still here, but it won't remember them.",
    );
    expect(retirementNote('tier', { tier: 'Thorough' })).toBe(
      "Nectovia started this conversation fresh because this conversation moved to the Thorough tier. Your earlier messages are still here, but it won't remember them.",
    );
  });
});
