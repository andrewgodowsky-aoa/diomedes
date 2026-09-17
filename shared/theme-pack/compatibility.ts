/**
 * What each surface does with each part of a ThemePack.
 *
 * The manifest below is the answer to "will my pack look like this over
 * there?" — one row per field, one column per surface, and an explicit rule
 * for the fields a surface does not render. Optional fields a surface does not
 * know are a warning and are ignored; a pack that never claimed the surface at
 * all is a hard incompatibility and fails.
 *
 * Self-contained by design — see the note at the top of types.ts.
 */

import { SURFACES, type Surface, type ThemePackV1 } from './types.js';

export type FieldSupport = 'renders' | 'ignores';

export interface CompatibilityEntry {
  /** Dotted path into the pack. */
  field: string;
  /** True when a surface that does not render it may simply carry on. */
  optional: boolean;
  support: Record<Surface, FieldSupport>;
  note: string;
}

export const THEME_PACK_COMPATIBILITY: readonly CompatibilityEntry[] = [
  {
    field: 'id',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Identity of the pack on both surfaces; also the storage key.',
  },
  {
    field: 'revision',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Shown beside the pack; higher wins when the same id arrives twice.',
  },
  {
    field: 'baseTheme',
    optional: false,
    support: { 'app-console': 'renders', website: 'ignores' },
    note: 'The app uses it for fallbacks and for the desktop titlebar pair; the website has no titlebar.',
  },
  {
    field: 'surfaces',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'A surface not listed here refuses the pack outright.',
  },
  {
    field: 'provenance',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Displayed as authorship information. It is not a licence or a payment proof.',
  },
  {
    field: 'tokens.color',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Both surfaces map these onto their own custom properties.',
  },
  {
    field: 'tokens.lightScheme',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Drives color-scheme and, in the app, the titlebar text colour.',
  },
  {
    field: 'typography',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Scales are restricted to the approved set; fonts are ids of already-bundled families.',
  },
  {
    field: 'geometry',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Radius, separator strength and density carry the same meaning on both surfaces.',
  },
  {
    field: 'motion',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'A preset id and bounded numbers; reduced motion stops motion on both surfaces.',
  },
  {
    field: 'artwork.logo',
    optional: true,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Shown in the app chrome and in the site header.',
  },
  {
    field: 'artwork.bust',
    optional: true,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'The character plate.',
  },
  {
    field: 'artwork.emptyState',
    optional: true,
    support: { 'app-console': 'renders', website: 'ignores' },
    note: 'The website has no empty states to fill; the slot is carried and ignored.',
  },
  {
    field: 'artwork.texture',
    optional: true,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Suppressed entirely when the accessibility layer asks for texture off.',
  },
  {
    field: 'artwork.hero',
    optional: true,
    support: { 'app-console': 'ignores', website: 'renders' },
    note: 'Website-only v1 extension. The app ignores it and says so.',
  },
  {
    field: 'artwork.sceneTreatment',
    optional: true,
    support: { 'app-console': 'ignores', website: 'renders' },
    note: 'Website-only v1 extension. The app ignores it and says so.',
  },
  {
    field: 'assets',
    optional: false,
    support: { 'app-console': 'renders', website: 'renders' },
    note: 'Metadata only; the bytes travel in the .diomedes-theme container.',
  },
];

export interface CompatibilityReport {
  surface: Surface;
  /** False only when something required makes the pack unusable here. */
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Look a field up in the manifest. Unknown fields are not the caller's to guess. */
export function supportFor(field: string, surface: Surface): FieldSupport | undefined {
  return THEME_PACK_COMPATIBILITY.find((entry) => entry.field === field)?.support[surface];
}

/**
 * Report what `surface` will do with `pack`.
 *
 * Errors mean "do not apply this". Warnings mean "applied, minus these parts",
 * and are worth showing once in the editor rather than swallowing.
 */
export function checkCompatibility(pack: ThemePackV1, surface: Surface): CompatibilityReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!(SURFACES as readonly string[]).includes(surface))
    errors.push(`${surface} is not a surface this contract knows`);
  if (!pack.surfaces.includes(surface))
    errors.push(
      `pack "${pack.id}" declares surfaces ${pack.surfaces.join(', ')} and was not built for ${surface}`,
    );

  for (const slot of Object.keys(pack.artwork)) {
    const field = `artwork.${slot}`;
    const support = supportFor(field, surface);
    if (support === undefined) {
      errors.push(`${field} is not a field this contract declares`);
      continue;
    }
    if (support === 'ignores')
      warnings.push(
        `${field} is ignored on ${surface}: it is an optional slot this surface does not render`,
      );
  }

  return { surface, ok: errors.length === 0, errors, warnings };
}
