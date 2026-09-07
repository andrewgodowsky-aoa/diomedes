import { describe, expect, test } from 'vitest';
import { MODES, modeOf } from '../server/modes.js';

describe('modes harness', () => {
  test('the four definitions carry the fixed harness values', () => {
    expect(MODES.ask.effort).toBe('low');
    expect(MODES.ask.output).toBe('text');
    expect(MODES.ask.writes).toBe('none');
    expect(MODES.ask.consent).toBe('sending-setting');
    expect(MODES.ask.maxAttempts).toBeUndefined();
    expect(MODES.plan.effort).toBe('medium');
    expect(MODES.plan.output).toBe('plan');
    expect(MODES.plan.writes).toBe('plan');
    expect(MODES.plan.consent).toBe('sending-setting');
    expect(MODES.plan.maxAttempts).toBeUndefined();
    expect(MODES.build.effort).toBe('medium');
    expect(MODES.build.output).toBe('proposal');
    expect(MODES.build.writes).toBe('proposal');
    expect(MODES.build.consent).toBe('always');
    expect(MODES.build.maxAttempts).toBeUndefined();
    expect(MODES.fix.effort).toBe('medium');
    expect(MODES.fix.output).toBe('proposal');
    expect(MODES.fix.writes).toBe('proposal');
    expect(MODES.fix.consent).toBe('always');
    expect(MODES.fix.maxAttempts).toBe(3);
  });
  test("modeOf('work') is 'build'", () => {
    expect(modeOf('work')).toBe('build');
  });
  test("modeOf('fix') is 'fix'", () => {
    expect(modeOf('fix')).toBe('fix');
  });
  test("modeOf('x') and modeOf(1) are undefined", () => {
    expect(modeOf('x')).toBeUndefined();
    expect(modeOf(1)).toBeUndefined();
  });
  test('every instructions string is under 900 characters', () => {
    for (const mode of Object.values(MODES)) expect(mode.instructions.length).toBeLessThan(900);
  });
});
