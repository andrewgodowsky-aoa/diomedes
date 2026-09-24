/** Explicit user preference; independent of viewport, surface, density and OS DPI. */
export const INTERFACE_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type ScaleCommand = 'increase' | 'decrease' | 'reset';

/**
 * The size of conversation text: a person's messages and the replies to them. It is the
 * `readingScale` preference applied to `--dm-type-conversation`, so it never resizes the
 * rest of the interface. 1 is the default, 15px before any interface size.
 */
export const CONVERSATION_TEXT_BASE_PX = 15;
export const CONVERSATION_TEXT_SCALES = [0.9, 1, 1.1, 1.25] as const;
export const conversationTextLabel = (scale: number) =>
  `${Math.round(scale * 100)}%${scale === 1 ? ' (Default)' : ''}`;

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
