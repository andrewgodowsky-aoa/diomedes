/** Explicit user preference; independent of viewport, surface, density and OS DPI. */
export const INTERFACE_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type ScaleCommand = 'increase' | 'decrease' | 'reset';

export function nextInterfaceScale(current: number, command: ScaleCommand): number {
  if (command === 'reset') return 1;
  if (command === 'increase')
    return INTERFACE_SCALES.find((value) => value > current + 0.001) ?? current;
  return [...INTERFACE_SCALES].reverse().find((value) => value < current - 0.001) ?? current;
}

export function scaleShortcut(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  key: string;
}): ScaleCommand | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (event.key === '+' || event.key === '=') return 'increase';
  if (event.key === '-') return 'decrease';
  if (event.key === '0') return 'reset';
}
