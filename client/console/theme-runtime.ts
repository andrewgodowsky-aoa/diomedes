/**
 * Applying a resolved appearance to the live document.
 *
 * This is the only place a ThemePack reaches the DOM, and it is deliberately
 * the dullest file in the Studio:
 *
 * - **No CSS text.** Values go through `style.setProperty`, so nothing here
 *   ever builds a declaration string a value could break out of. There is no
 *   `<style>` element to inject into, and no rule, selector or at-rule a theme
 *   can reach. Every custom property the resolver emits is a token value that
 *   `setProperty` can carry as it stands.
 * - **No remount.** Setting properties and dataset values on
 *   `document.documentElement` changes presentation and nothing else. React is
 *   not told, nothing navigates, nothing reloads, no engine is restarted, and a
 *   half-typed message in the composer is still there afterwards.
 * - **Nothing is trusted.** The pack was validated before it was resolved, and
 *   the names and values are checked again here, because this side of the seam
 *   also carries values from settings and from an entitlement decision. A name
 *   or value that does not match is dropped, never written.
 * - **Idempotent.** Applying the same appearance twice leaves the same document.
 *   Applying a different one removes what the previous one added and no more.
 *
 * Both checks below are allowlists. A blocklist here is a list of the attacks
 * somebody happened to think of, and this file is read far less often than it
 * is relied on.
 */
import type { ResolvedAppearance } from '../../shared/theme-pack/resolve';

/** A custom property name the renderer is willing to write. */
const PROPERTY_NAME = /^--[a-z0-9-]+$/;

/**
 * A token value, as an allowlist of characters rather than a list of the ones
 * known to be dangerous. Font stacks carry quotes, commas and spaces; colours,
 * lengths and timings carry little else. Everything a blocklist would have had
 * to remember is simply absent: no `;` or `}` to end a declaration or a block,
 * no `<` or `>`, no backslash to escape past any of it, no `:` and therefore no
 * `javascript:`, and no control character at all — the class is printable ASCII
 * only, so `U+0000`–`U+001F` and `U+007F` cannot appear however they arrive.
 */
const PROPERTY_VALUE = /^[a-zA-Z0-9 .,%#()'"/_-]{1,240}$/;

/**
 * The CSS functions a token value may name.
 *
 * `url(` is the obvious fetch, but `image-set(`, `-webkit-image-set(`, `src(`
 * and `element(` all reach outside the document too, and the next one has not
 * been invented yet. So anything shaped like `identifier(` and not named here
 * is refused, rather than only the ones already known to be trouble.
 */
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'cubic-bezier',
  'var',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'clamp',
  'calc',
  'min',
  'max',
]);

/** CSS function names are case-insensitive, so `URL(` is the same fetch. */
const FUNCTION_CALL = /([a-zA-Z-][a-zA-Z0-9-]*)\(/g;

function onlyAllowedFunctions(value: string): boolean {
  for (const match of value.matchAll(FUNCTION_CALL))
    if (!ALLOWED_FUNCTIONS.has(match[1].toLowerCase())) return false;
  return true;
}

/** A dataset key as `HTMLElement.dataset` spells it, and the values it takes. */
const DATASET_KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;
const DATASET_VALUE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What this module last wrote, so it can take exactly that back. */
let appliedProperties: string[] = [];
let appliedDataset: string[] = [];

export function isSafeProperty(name: string, value: string): boolean {
  return PROPERTY_NAME.test(name) && PROPERTY_VALUE.test(value) && onlyAllowedFunctions(value);
}

export function isSafeDataset(key: string, value: string): boolean {
  return DATASET_KEY.test(key) && DATASET_VALUE.test(value);
}

/**
 * Write a resolved appearance onto the document root.
 *
 * Returns the names it refused, so a caller that cares — the editor, a test —
 * can say so rather than wondering why a token did not take.
 */
export function applyResolvedAppearance(
  resolved: ResolvedAppearance,
  root: HTMLElement = document.documentElement,
): { refused: string[] } {
  const refused: string[] = [];
  const properties: string[] = [];
  const dataset: string[] = [];

  for (const [name, value] of Object.entries(resolved.vars)) {
    if (!isSafeProperty(name, value)) {
      refused.push(name);
      continue;
    }
    root.style.setProperty(name, value);
    properties.push(name);
  }
  for (const [key, value] of Object.entries(resolved.dataset)) {
    if (!isSafeDataset(key, value)) {
      refused.push(`data-${key}`);
      continue;
    }
    root.dataset[key] = value;
    dataset.push(key);
  }

  // Take back only what this module wrote and this appearance does not carry.
  // Anything else on the root belongs to someone else and stays theirs.
  for (const name of appliedProperties)
    if (!properties.includes(name)) root.style.removeProperty(name);
  for (const key of appliedDataset) if (!dataset.includes(key)) delete root.dataset[key];

  appliedProperties = properties;
  appliedDataset = dataset;
  return { refused };
}

/**
 * Hand the document back to the built-in appearance package.
 *
 * It removes what a theme added rather than asserting defaults, so the
 * stylesheet's own `:root` and `html[data-package=…]` rules apply again exactly
 * as they did before any theme was chosen.
 */
export function clearResolvedAppearance(root: HTMLElement = document.documentElement): void {
  for (const name of appliedProperties) root.style.removeProperty(name);
  for (const key of appliedDataset) delete root.dataset[key];
  appliedProperties = [];
  appliedDataset = [];
}

/** True while a resolved appearance is on the document. For tests and the editor. */
export const themeRuntimeActive = () => appliedProperties.length > 0 || appliedDataset.length > 0;
