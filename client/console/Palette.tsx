import type { PaletteProps } from './types';

/**
 * Placeholder palette: renders nothing. The Ctrl+K command surface arrives in
 * a later pass; the Shell owns the keyboard handler until then.
 */
export function Palette(_props: PaletteProps) {
  return null;
}
