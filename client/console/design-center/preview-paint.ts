/**
 * Painting a resolved appearance onto the preview, and only onto the preview.
 *
 * This is deliberately **not** `applyResolvedAppearance` from
 * `client/console/theme-runtime.ts`. That module keeps one module-level record
 * of what it last wrote so it can take exactly that back, which is right for
 * the document root and wrong for a second surface: a preview painting itself
 * would rewrite the bookkeeping the running app's own theme depends on, and the
 * app's `clearResolvedAppearance` would then strip the preview instead. One
 * writer per element, each remembering its own writes.
 *
 * The safety checks are shared, not re-implemented: `isSafeProperty` and
 * `isSafeDataset` are imported from that module, so there is one answer in this
 * codebase to "may this value reach the DOM".
 *
 * Custom properties inherit, so the whole preview subtree picks up the theme's
 * colours, radii, scales and fonts from the container. The stylesheet's
 * `data-*` rules are anchored to `html` and do not reach a nested element, so
 * `design-center.css` restates the handful that matter, scoped to the stage.
 */
import type { ResolvedAppearance } from '../../../shared/theme-pack/resolve';
import { isSafeDataset, isSafeProperty } from '../theme-runtime';

/** Per-element memory: what this module wrote there, so it can take it back. */
const written = new WeakMap<HTMLElement, { properties: string[]; dataset: string[] }>();

export function paintPreview(element: HTMLElement, resolved: ResolvedAppearance): void {
  const properties: string[] = [];
  const dataset: string[] = [];
  for (const [name, value] of Object.entries(resolved.vars)) {
    if (!isSafeProperty(name, value)) continue;
    element.style.setProperty(name, value);
    properties.push(name);
  }
  for (const [key, value] of Object.entries(resolved.dataset)) {
    if (!isSafeDataset(key, value)) continue;
    element.dataset[key] = value;
    dataset.push(key);
  }
  const before = written.get(element);
  if (before) {
    for (const name of before.properties)
      if (!properties.includes(name)) element.style.removeProperty(name);
    for (const key of before.dataset) if (!dataset.includes(key)) delete element.dataset[key];
  }
  written.set(element, { properties, dataset });
}

export function clearPreview(element: HTMLElement): void {
  const before = written.get(element);
  if (!before) return;
  for (const name of before.properties) element.style.removeProperty(name);
  for (const key of before.dataset) delete element.dataset[key];
  written.delete(element);
}
