import path from 'node:path';
import { z } from 'zod';

import type { ProspectOverlay, SyntheticRehearsalArtifact } from '../../shared/rehearsal.js';
import type { LoadedIndustryFixture, LoadedIndustryVariant } from './industry-registry.js';

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const TERMINOLOGY_KEY = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /{{([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)}}/g;
const TEMPLATE_MARKER = /{{|}}/;
const safeLabel = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !TEMPLATE_MARKER.test(value), 'must not contain a template marker')
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters');

const overlaySchema = z
  .object({
    prospectId: z.string().regex(SLUG),
    variantId: z.string().regex(SLUG),
    revision: z.number().int().positive(),
    business: z.object({ name: safeLabel }).strict(),
    locations: z.array(z.object({ name: safeLabel }).strict()).max(100),
    terminology: z.record(z.string().regex(TERMINOLOGY_KEY), safeLabel),
    selection: z.array(z.string().min(1).max(240)).max(64),
    policy: z.literal('drafts-only'),
  })
  .strict();

const issuePath = (issue: z.core.$ZodIssue) =>
  issue.path.length ? issue.path.map(String).join('.') : 'overlay';

const parseOverlay = (input: ProspectOverlay) => {
  const parsed = overlaySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => `${issuePath(issue)}: ${issue.message}`).join('; '),
    );
  }
  if (new Set(parsed.data.selection).size !== parsed.data.selection.length) {
    throw new Error('selection contains a duplicate fixture path.');
  }
  return parsed.data;
};

const renderTemplate = (
  template: string,
  extension: string,
  overlay: ReturnType<typeof parseOverlay>,
  terminology: Readonly<Record<string, string>>,
  location: { name: string; index: number } | null,
) => {
  const encode = (value: string) => {
    if (extension === '.json') return JSON.stringify(value).slice(1, -1);
    if (extension === '.csv' && /[",\r\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
    return value;
  };
  const rendered = template.replace(PLACEHOLDER, (_match, key: string) => {
    if (key === 'business.name') return encode(overlay.business.name);
    if (key === 'location.name') {
      if (!location) throw new Error('location.name is only available in a location fixture.');
      return encode(location.name);
    }
    if (key === 'location.index') {
      if (!location) throw new Error('location.index is only available in a location fixture.');
      return String(location.index);
    }
    if (key.startsWith('terminology.')) {
      const term = key.slice('terminology.'.length);
      const value = terminology[term];
      if (!value) throw new Error(`terminology.${term}: no label is configured.`);
      return encode(value);
    }
    throw new Error(`${key}: unsupported fixture placeholder.`);
  });
  const unresolved = rendered.match(PLACEHOLDER)?.[0];
  if (unresolved) throw new Error(`${unresolved}: unresolved fixture placeholder.`);
  return rendered;
};

const outputPath = (fixture: LoadedIndustryFixture, locationIndex: number | null) => {
  const rendered = fixture.path.replaceAll('{{location.index}}', String(locationIndex ?? ''));
  const normalized = path.posix.normalize(rendered);
  if (
    normalized !== rendered ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes('{{') ||
    normalized.includes('}}')
  ) {
    throw new Error(
      `fixtures.path ${JSON.stringify(fixture.path)} did not produce a contained path.`,
    );
  }
  return normalized;
};

const header = (variant: LoadedIndustryVariant) =>
  `Demonstration data. Every figure is synthetic. Business and location names are public names used with no claim about the business. Generated from variant ${variant.id} revision ${variant.digest}. Route: synthetic.`;

const artifact = (
  variant: LoadedIndustryVariant,
  fixture: LoadedIndustryFixture,
  overlay: ReturnType<typeof parseOverlay>,
  terminology: Readonly<Record<string, string>>,
  location: { name: string; index: number } | null,
): SyntheticRehearsalArtifact => {
  const extension = path.posix.extname(fixture.path).toLowerCase();
  const body = renderTemplate(fixture.template, extension, overlay, terminology, location).replace(
    /^\uFEFF/,
    '',
  );
  const notice = header(variant);
  let text: string;
  if (extension === '.json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `${fixture.path}: rendered JSON is invalid (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    text = `${JSON.stringify(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>), syntheticNotice: notice }
        : { syntheticNotice: notice, data: parsed },
      null,
      2,
    )}\n`;
  } else if (extension === '.csv') {
    text = `${notice}\n\n${body}`;
  } else text = `${notice}\n\n${body}`;
  return Object.freeze({
    path: outputPath(fixture, location?.index ?? null),
    text,
    sample: true as const,
    route: 'synthetic' as const,
  });
};

/**
 * Render candidates for the existing recorded writer. This function performs
 * no writes and grants no authority.
 */
export function renderSyntheticFixtures(
  variant: LoadedIndustryVariant,
  input: ProspectOverlay,
): readonly SyntheticRehearsalArtifact[] {
  const overlay = parseOverlay(input);
  if (overlay.variantId !== variant.id) {
    throw new Error(`variantId ${overlay.variantId} does not match loaded variant ${variant.id}.`);
  }
  const knownPaths = new Set(variant.fixtures.map((fixture) => fixture.path));
  const unknown = overlay.selection.find((selection) => !knownPaths.has(selection));
  if (unknown)
    throw new Error(`selection ${JSON.stringify(unknown)} is not a fixture in ${variant.id}.`);
  const selected = variant.fixtures.filter((fixture) =>
    overlay.selection.length ? overlay.selection.includes(fixture.path) : fixture.default,
  );
  const terminology = Object.freeze({ ...variant.terminology, ...overlay.terminology });
  const artifacts: SyntheticRehearsalArtifact[] = [];
  for (const fixture of selected) {
    if (fixture.slot === 'location') {
      overlay.locations.forEach((location, offset) => {
        artifacts.push(
          artifact(variant, fixture, overlay, terminology, {
            name: location.name,
            index: offset + 1,
          }),
        );
      });
    } else {
      artifacts.push(artifact(variant, fixture, overlay, terminology, null));
    }
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const identity = (value: string) => value.normalize('NFC').toLocaleLowerCase('en-US');
  const duplicate = artifacts.find(
    (item, index) =>
      artifacts.findIndex((other) => identity(other.path) === identity(item.path)) !== index,
  );
  if (duplicate)
    throw new Error(`Fixture rendering produced duplicate output path ${duplicate.path}.`);
  return Object.freeze(artifacts);
}
