/**
 * Which appearance outputs the running build owns outright.
 *
 * A custom ThemePack is a full snapshot: every value is copied from the base
 * when the pack is made, and the resolver writes every one of them inline on
 * `<html>`. An inline custom property outranks every rule in
 * `client/styles.css`, so while a pack is applied, nothing an update changes
 * in the base can show (docs/research/2026-09-25-skin-layering-and-update-refresh.md,
 * cause 1b).
 *
 * The outputs listed here are structural: they set the reading measure, the
 * type rhythm and the size of every control, which the Console owns (decisions
 * 5 and 6), not the palette a skin is for. They are never written inline, so
 * the stylesheet of the build that is running decides them, and a skin that
 * carried a different value is told so rather than silently obeyed. A person's
 * own text sizes are theirs and are applied after this (`client/App.tsx`).
 *
 * The list is deliberately short. Which tokens a business may override is an
 * open decision (update-reconcile record, "Decisions for Andrew" D3); widening
 * or narrowing it is a change to this one list.
 *
 * This file sits beside `shared/theme-pack/`, not in it, because that folder
 * is the frozen ThemePack v1 handoff bundle.
 */
import { APPEARANCE_DEFAULTS, type ResolvedAppearance } from './theme-pack/resolve.js';

/** `--name` for a custom property, `data:<key>` for a dataset key, as `origins` spells them. */
export const STRUCTURAL_APPEARANCE_OUTPUTS = [
  '--dm-line-body',
  '--dm-ui-scale',
  '--dm-read-scale',
  '--dm-code-scale',
  'data:density',
] as const;
export type StructuralOutput = (typeof STRUCTURAL_APPEARANCE_OUTPUTS)[number];

/** What the base stylesheet says for each structural output, mirrored from `client/styles.css`. */
export const BASE_STRUCTURE: Readonly<Record<StructuralOutput, string>> = {
  '--dm-line-body': String(APPEARANCE_DEFAULTS.lineHeight),
  '--dm-ui-scale': String(APPEARANCE_DEFAULTS.interfaceScale),
  '--dm-read-scale': String(APPEARANCE_DEFAULTS.readingScale),
  '--dm-code-scale': String(APPEARANCE_DEFAULTS.codeScale),
  'data:density': APPEARANCE_DEFAULTS.density,
};

/** A skin's value that the base took back. */
export interface SupersededOutput {
  output: StructuralOutput;
  /** What the skin (or workspace) asked for. */
  skinValue: string;
  /** What the running build's stylesheet shows instead. */
  baseValue: string;
}

/**
 * The resolved appearance with every structural output removed, and the list
 * of skin values that removal overrode. Pure; the input is not changed.
 *
 * Only a value a theme or a workspace wrote, and that differs from the base,
 * counts as superseded. A defaults-layer copy is removed too, silently: it is
 * the resolver's own snapshot of the stylesheet and saying so would be noise.
 */
export function withBaseStructure(resolved: ResolvedAppearance): {
  resolved: ResolvedAppearance;
  superseded: SupersededOutput[];
} {
  const vars = { ...resolved.vars };
  const dataset = { ...resolved.dataset };
  const origins = { ...resolved.origins };
  const superseded: SupersededOutput[] = [];
  for (const output of STRUCTURAL_APPEARANCE_OUTPUTS) {
    const isData = output.startsWith('data:');
    const key = isData ? output.slice('data:'.length) : output;
    const value = isData ? dataset[key] : vars[key];
    if (value === undefined) continue;
    const origin = origins[output];
    if ((origin === 'theme' || origin === 'workspace') && value !== BASE_STRUCTURE[output])
      superseded.push({ output, skinValue: value, baseValue: BASE_STRUCTURE[output] });
    if (isData) delete dataset[key];
    else delete vars[key];
    delete origins[output];
  }
  return { resolved: { vars, dataset, origins }, superseded };
}
