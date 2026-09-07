import { describe, expect, it } from 'vitest';
import { EFFORT_ORDER, MODE_CEILING, effortFor, effortLowered } from '../shared/effort';

/**
 * The rule the merge settled: a level chosen for a thread outranks the mode's
 * own default, and Fix alone holds that choice to a ceiling. These tests pin
 * both halves, because getting either backwards is silent - the run simply
 * thinks harder or less hard than the person asked for, and says nothing.
 */
describe('reasoning level for a run', () => {
  it('uses the mode default when nothing was chosen', () => {
    expect(effortFor('ask', null, 'low')).toBe('low');
    expect(effortFor('plan', '', 'medium')).toBe('medium');
    expect(effortFor('build', undefined, 'medium')).toBe('medium');
  });

  it('lets a choice outrank the mode default where there is no ceiling', () => {
    expect(effortFor('ask', 'ultra', 'low')).toBe('ultra');
    expect(effortFor('plan', 'max', 'medium')).toBe('max');
    expect(effortFor('build', 'xhigh', 'medium')).toBe('xhigh');
    // Downwards too: a person may deliberately ask for less than the mode.
    expect(effortFor('build', 'low', 'medium')).toBe('low');
  });

  it('holds Fix to its ceiling however deep the choice', () => {
    expect(MODE_CEILING.fix).toBe('medium');
    for (const deeper of ['high', 'xhigh', 'max', 'ultra'])
      expect(effortFor('fix', deeper, 'medium')).toBe('medium');
  });

  it('leaves a Fix choice alone when it is already at or under the ceiling', () => {
    expect(effortFor('fix', 'low', 'medium')).toBe('low');
    expect(effortFor('fix', 'medium', 'medium')).toBe('medium');
  });

  it('holds an unknown level to the ceiling rather than letting it through', () => {
    // A rung this build does not know is likelier a new deeper one than a new
    // shallower one, and a ceiling that can be stepped over is not a ceiling.
    expect(effortFor('fix', 'unheard-of', 'medium')).toBe('medium');
    // Without a ceiling there is nothing to compare against, so it is passed on.
    expect(effortFor('ask', 'unheard-of', 'low')).toBe('unheard-of');
  });

  it('reports when the ceiling lowered a choice, so the person can be told', () => {
    expect(effortLowered('fix', 'ultra')).toBe(true);
    expect(effortLowered('fix', 'medium')).toBe(false);
    expect(effortLowered('fix', 'low')).toBe(false);
    expect(effortLowered('ask', 'ultra')).toBe(false);
    // Nothing chosen is not a lowering: the mode default was never a request.
    expect(effortLowered('fix', null)).toBe(false);
    expect(effortLowered('fix', '')).toBe(false);
  });

  it('orders the ladder weakest first, which is what makes a ceiling mean anything', () => {
    expect([...EFFORT_ORDER]).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });
});
