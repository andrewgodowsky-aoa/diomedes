import { describe, expect, it } from 'vitest';
import { nextInterfaceScale, scaleShortcut } from '../shared/interface-scale';

describe('interface scale', () => {
  it('steps through presets, bounds repeated shortcuts and preserves custom values', () => {
    expect(nextInterfaceScale(1, 'increase')).toBe(1.1);
    expect(nextInterfaceScale(1.1, 'increase')).toBe(1.25);
    expect(nextInterfaceScale(1.25, 'increase')).toBe(1.25);
    expect(nextInterfaceScale(0.9, 'decrease')).toBe(0.9);
    expect(nextInterfaceScale(1.12, 'decrease')).toBe(1.1);
    expect(nextInterfaceScale(1.12, 'increase')).toBe(1.25);
    expect(nextInterfaceScale(1.5, 'increase')).toBe(1.5);
    expect(nextInterfaceScale(0.75, 'decrease')).toBe(0.75);
    expect(nextInterfaceScale(1.5, 'reset')).toBe(1);
  });
  it('recognizes Ctrl/Cmd plus, minus and reset without stealing ordinary typing', () => {
    const event = { ctrlKey: true, metaKey: false, altKey: false, key: '=' };
    expect(scaleShortcut(event)).toBe('increase');
    expect(scaleShortcut({ ...event, key: '+' })).toBe('increase');
    expect(scaleShortcut({ ...event, key: '-' })).toBe('decrease');
    expect(scaleShortcut({ ...event, key: '0' })).toBe('reset');
    expect(scaleShortcut({ ...event, ctrlKey: false })).toBeUndefined();
    expect(scaleShortcut({ ...event, altKey: true })).toBeUndefined();
    expect(scaleShortcut({ ...event, key: 'k' })).toBeUndefined();
  });
});
