import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { renderSyntheticFixtures } from '../server/rehearsal/fixture-template.js';
import {
  loadIndustryVariantRegistry,
  type LoadedIndustryFixture,
  type LoadedIndustryVariant,
} from '../server/rehearsal/industry-registry.js';
import type { ProspectOverlay } from '../shared/rehearsal.js';

let root = '';
let bundledRoot = '';
let operatorRoot = '';

const overlay = (overrides: Partial<ProspectOverlay> = {}): ProspectOverlay => ({
  prospectId: 'prospect-adversarial',
  variantId: 'adversarial',
  revision: 3,
  business: { name: 'Harbor "North", LLC' },
  locations: [{ name: 'North, "Market"' }],
  terminology: { labor: 'crew "hours", actual' },
  selection: [],
  policy: 'drafts-only',
  ...overrides,
});

const metadata = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  contractVersion: 1,
  engine: 'weekly-brief',
  label: 'Adversarial weekly brief',
  industry: 'adversarial',
  keywords: ['adversarial'],
  scopeLabel: 'Adversarial exports',
  outputLabel: 'Adversarial brief',
  scopeSelection: ['weekly-operations-exports'],
  destination: 'Drafts/Adversarial brief.md',
  guidanceText: 'Cite selected exports and leave missing sources visible.',
  terminology: { labor: 'labor hours' },
  ...overrides,
});

async function writeVariant(
  parent: string,
  id: string,
  options: {
    metadata?: Record<string, unknown>;
    fixtures?: Array<Record<string, unknown>>;
    files?: Record<string, string>;
  } = {},
) {
  const folder = path.join(parent, id);
  await fs.mkdir(path.join(folder, 'fixtures'), { recursive: true });
  const fixtures = options.fixtures ?? [{ path: 'summary.md', label: 'Summary', default: true }];
  const files = options.files ?? { 'summary.md': '# {{business.name}}\n' };
  await fs.writeFile(
    path.join(folder, 'variant.json'),
    JSON.stringify(metadata(id, options.metadata), null, 2),
  );
  await fs.writeFile(path.join(folder, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(folder, 'fixtures', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return folder;
}

const candidate = (
  fixtures: readonly LoadedIndustryFixture[],
  overrides: Partial<LoadedIndustryVariant> = {},
): LoadedIndustryVariant =>
  ({
    ...metadata('adversarial'),
    contractVersion: 1,
    engine: 'weekly-brief',
    source: 'operator',
    sourcePath: path.join(operatorRoot, 'adversarial'),
    digest: `sha256:${'a'.repeat(64)}`,
    fixtures,
    ...overrides,
  }) as LoadedIndustryVariant;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'fd04-adversarial-'));
  bundledRoot = path.join(root, 'bundled');
  operatorRoot = path.join(root, 'operator');
  await fs.mkdir(bundledRoot, { recursive: true });
  await fs.mkdir(operatorRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FD04 adversarial registry boundaries', () => {
  test('refuses drive-qualified, colon-bearing, and reserved Windows output destinations', async () => {
    await writeVariant(operatorRoot, 'drive-destination', {
      metadata: { destination: 'C:/outside.md' },
    });
    await writeVariant(operatorRoot, 'colon-destination', {
      metadata: { destination: 'Drafts/report:alternate.md' },
    });
    await writeVariant(operatorRoot, 'reserved-destination', {
      metadata: { destination: 'Drafts/CON.md' },
    });

    const registry = await loadIndustryVariantRegistry({ bundledRoot, operatorRoot });

    expect([...registry.variants]).toEqual([]);
    expect(registry.refusals).toHaveLength(3);
    expect(registry.refusals.map((item) => item.message).join('\n')).toMatch(
      /destination.*(contained|colon|reserved|windows)/i,
    );
  });

  test('refuses a registry reached through a reparse-point ancestor', async () => {
    const realOperatorRoot = path.join(root, 'real-operator');
    await fs.mkdir(realOperatorRoot, { recursive: true });
    await writeVariant(realOperatorRoot, 'adversarial');
    const linkedRoot = path.join(root, 'linked-operator');
    await fs.symlink(realOperatorRoot, linkedRoot, 'junction');

    const registry = await loadIndustryVariantRegistry({
      bundledRoot,
      operatorRoot: linkedRoot,
    });

    expect([...registry.variants]).toEqual([]);
    expect(registry.refusals).toEqual([
      expect.objectContaining({
        code: 'reparse-point',
        path: expect.stringContaining('adversarial'),
      }),
    ]);
  });

  test('applies file and byte ceilings to the aggregate contents of one folder', async () => {
    await writeVariant(operatorRoot, 'too-many-files', {
      fixtures: [
        { path: 'one.md', label: 'One', default: true },
        { path: 'two.md', label: 'Two', default: true },
      ],
      files: { 'one.md': 'one', 'two.md': 'two' },
    });
    const fileLimited = await loadIndustryVariantRegistry({
      bundledRoot,
      operatorRoot,
      maxVariantFiles: 3,
    });
    expect(fileLimited.variants.has('too-many-files')).toBe(false);
    expect(fileLimited.refusals).toEqual([
      expect.objectContaining({
        code: 'limit-exceeded',
        message: expect.stringMatching(/file limit/i),
      }),
    ]);

    await fs.rm(path.join(operatorRoot, 'too-many-files'), { recursive: true, force: true });
    await writeVariant(operatorRoot, 'split-bytes', {
      fixtures: [
        { path: 'one.md', label: 'One', default: true },
        { path: 'two.md', label: 'Two', default: true },
      ],
      files: { 'one.md': 'a'.repeat(500), 'two.md': 'b'.repeat(500) },
    });
    const byteLimited = await loadIndustryVariantRegistry({
      bundledRoot,
      operatorRoot,
      maxVariantBytes: 900,
    });
    expect(byteLimited.variants.has('split-bytes')).toBe(false);
    expect(byteLimited.refusals).toEqual([
      expect.objectContaining({
        code: 'limit-exceeded',
        message: expect.stringMatching(/byte limit/i),
      }),
    ]);
  });

  test('admits only the implemented variant contract version', async () => {
    await writeVariant(operatorRoot, 'future-contract', {
      metadata: { contractVersion: 2 },
    });

    const registry = await loadIndustryVariantRegistry({ bundledRoot, operatorRoot });

    expect(registry.variants.has('future-contract')).toBe(false);
    expect(registry.refusals).toEqual([
      expect.objectContaining({
        code: 'invalid-variant',
        message: expect.stringMatching(/contractVersion/i),
      }),
    ]);
  });

  test('changes the immutable digest when any admitted fixture byte changes', async () => {
    const folder = await writeVariant(operatorRoot, 'byte-identity', {
      files: { 'summary.md': 'before {{business.name}}\n' },
    });
    const first = await loadIndustryVariantRegistry({ bundledRoot, operatorRoot });
    const firstVariant = first.variants.get('byte-identity')!;

    await fs.writeFile(path.join(folder, 'fixtures', 'summary.md'), 'after! {{business.name}}\n');
    const second = await loadIndustryVariantRegistry({ bundledRoot, operatorRoot });
    const secondVariant = second.variants.get('byte-identity')!;

    expect(secondVariant.digest).not.toBe(firstVariant.digest);
    expect(firstVariant.fixtures[0]!.template).toContain('before');
    expect(secondVariant.fixtures[0]!.template).toContain('after!');
  });
});

describe('FD04 adversarial fixture rendering', () => {
  test('accepts the prospect id format emitted by FD02', () => {
    const variant = candidate([
      { path: 'summary.md', label: 'Summary', default: true, template: '# {{business.name}}' },
    ]);

    expect(() =>
      renderSyntheticFixtures(
        variant,
        overlay({ prospectId: 'prospect_550e8400-e29b-41d4-a716-446655440000' }),
      ),
    ).not.toThrow();
  });

  test('escapes public names when substituting CSV values with commas and quotes', () => {
    const variant = candidate([
      {
        path: 'location-{{location.index}}.csv',
        label: 'Location',
        default: true,
        slot: 'location',
        template: 'business,location\n{{business.name}},{{location.name}}\n',
      },
    ]);

    const [artifact] = renderSyntheticFixtures(variant, overlay());

    expect(artifact!.text).toContain('"Harbor ""North"", LLC","North, ""Market"""');
  });

  test('escapes public names and terminology as JSON string content', async () => {
    await writeVariant(operatorRoot, 'json-fixture', {
      fixtures: [{ path: 'summary.json', label: 'Summary', default: true }],
      files: {
        'summary.json': '{"business":"{{business.name}}","labor":"{{terminology.labor}}"}\n',
      },
    });
    const registry = await loadIndustryVariantRegistry({ bundledRoot, operatorRoot });
    const variant = registry.variants.get('json-fixture')!;
    const [artifact] = renderSyntheticFixtures(
      variant,
      overlay({ variantId: 'json-fixture', locations: [] }),
    );

    expect(JSON.parse(artifact!.text)).toMatchObject({
      business: 'Harbor "North", LLC',
      labor: 'crew "hours", actual',
      syntheticNotice: expect.stringMatching(/^Demonstration data\./),
    });
  });

  test('refuses output collisions using Windows case-insensitive path identity', () => {
    const variant = candidate([
      { path: 'Summary.md', label: 'First', default: true, template: 'first' },
      { path: 'summary.md', label: 'Second', default: true, template: 'second' },
    ]);

    expect(() => renderSyntheticFixtures(variant, overlay())).toThrow(/duplicate output path/i);
  });
});
