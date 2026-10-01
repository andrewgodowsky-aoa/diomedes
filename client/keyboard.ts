/**
 * Shortcut labels for the keyboard in front of the person.
 *
 * The handlers answer to Ctrl or Cmd on every platform, the way the
 * interface-size keys (shared/interface-scale.ts) always have, so a Mac reaches
 * them with Cmd and Windows with Ctrl. Only what a hint says follows the
 * machine: a Mac reads ⌘K, every other keyboard reads Ctrl K. It is the
 * browser's own platform, not the service's, because a Mac browser pointed at a
 * Windows service still has a Mac keyboard.
 */
export function isMacKeyboard(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** A shortcut as a hint shows it: `⌘K` on a Mac, `Ctrl K` elsewhere. */
export function shortcutHint(key: string): string {
  return isMacKeyboard() ? `⌘${key}` : `Ctrl ${key}`;
}

/** The modifier's name in a sentence: Cmd on a Mac, Ctrl elsewhere. */
export function modifierName(): string {
  return isMacKeyboard() ? 'Cmd' : 'Ctrl';
}
