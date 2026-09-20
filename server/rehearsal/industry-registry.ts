import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { IndustryFixtureDefinition, IndustryVariantMetadata } from '../../shared/rehearsal.js';

const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const VARIANT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TERMINOLOGY_KEY = /^[a-z][a-z0-9-]*$/;
const FIXTURE_EXTENSIONS = new Set(['.csv', '.json', '.md', '.txt']);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const safeWindowsRelative = (value: string) =>
  !value.includes(':') &&
  value
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        !segment.endsWith('.') &&
        !segment.endsWith(' ') &&
        !WINDOWS_RESERVED.test(segment),
    );

const boundedText = z.string().trim().min(1).max(240);
const containedDestination = boundedText.refine((value) => {
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('{{') ||
    value.includes('}}')
  ) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !path.posix.isAbsolute(normalized) &&
    safeWindowsRelative(normalized)
  );
}, 'must be a contained relative path without Windows drive, colon, or reserved names');
const variantSchema = z
  .object({
    id: z.string().regex(VARIANT_ID, 'id must be a path-guarded lowercase slug'),
    contractVersion: z.literal(1),
    engine: z.literal('weekly-brief'),
    label: boundedText,
    industry: boundedText,
    keywords: z.array(boundedText).max(32),
    scopeLabel: boundedText,
    scopeSelection: z.array(boundedText).min(1).max(32),
    outputLabel: boundedText,
    destination: containedDestination,
    guidanceText: z.string().trim().min(1).max(2_000),
    terminology: z.record(z.string().regex(TERMINOLOGY_KEY), boundedText),
  })
  .strict();

const fixtureSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    label: boundedText,
    default: z.boolean(),
    slot: z.literal('location').optional(),
  })
  .strict();

const fixturesSchema = z.array(fixtureSchema).min(1).max(DEFAULT_MAX_FILES);

export interface LoadedIndustryFixture extends IndustryFixtureDefinition {
  readonly template: string;
}

export interface LoadedIndustryVariant extends IndustryVariantMetadata {
  readonly source: 'bundled' | 'operator';
  readonly sourcePath: string;
  /** Exact identity of every admitted metadata and fixture byte. */
  readonly digest: `sha256:${string}`;
  readonly fixtures: readonly LoadedIndustryFixture[];
}

export interface IndustryRegistryRefusal {
  readonly code:
    | 'duplicate-id'
    | 'invalid-folder'
    | 'invalid-json'
    | 'invalid-variant'
    | 'invalid-fixture'
    | 'limit-exceeded'
    | 'reparse-point'
    | 'unexpected-file';
  readonly path: string;
  readonly message: string;
}

export interface IndustryVariantRegistry {
  readonly variants: ReadonlyMap<string, LoadedIndustryVariant>;
  readonly refusals: readonly IndustryRegistryRefusal[];
}

export interface LoadIndustryVariantRegistryOptions {
  readonly bundledRoot: string;
  readonly operatorRoot?: string;
  readonly maxVariantFiles?: number;
  readonly maxVariantBytes?: number;
}

interface FileBytes {
  readonly relative: string;
  readonly absolute: string;
  readonly bytes: Buffer;
}

class VariantRefusal extends Error {
  constructor(
    readonly code: IndustryRegistryRefusal['code'],
    message: string,
  ) {
    super(message);
  }
}

const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const fieldName = (issue: z.core.$ZodIssue) =>
  issue.path.length ? issue.path.map(String).join('.') : 'record';

const schemaMessage = (kind: string, error: z.ZodError) =>
  error.issues.map((issue) => `${kind}.${fieldName(issue)}: ${issue.message}`).join('; ');

const parseJson = (file: FileBytes): unknown => {
  try {
    return JSON.parse(file.bytes.toString('utf8'));
  } catch (error) {
    throw new VariantRefusal(
      'invalid-json',
      `${file.absolute}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
};

const safeFixturePath = (value: string, slot: 'location' | undefined) => {
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    !safeWindowsRelative(value.replaceAll('{{location.index}}', '1'))
  ) {
    throw new VariantRefusal(
      'invalid-fixture',
      `fixtures.path ${JSON.stringify(value)} is not contained.`,
    );
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new VariantRefusal(
      'invalid-fixture',
      `fixtures.path ${JSON.stringify(value)} escapes fixtures.`,
    );
  }
  const pathProbe = value.replaceAll('{{location.index}}', '1');
  if (pathProbe.includes('{{') || pathProbe.includes('}}')) {
    throw new VariantRefusal(
      'invalid-fixture',
      `fixtures.path ${JSON.stringify(value)} contains an unsupported path placeholder.`,
    );
  }
  if (slot === 'location' && !value.includes('{{location.index}}')) {
    throw new VariantRefusal(
      'invalid-fixture',
      `fixtures.path ${JSON.stringify(value)} must include {{location.index}} for a location slot.`,
    );
  }
  const extension = path.posix.extname(pathProbe).toLowerCase();
  if (!FIXTURE_EXTENSIONS.has(extension)) {
    throw new VariantRefusal(
      'invalid-fixture',
      `fixtures.path ${JSON.stringify(value)} has an executable or unsupported extension ${JSON.stringify(extension)}.`,
    );
  }
  return value;
};

const enumerateFiles = async (
  root: string,
  maxFiles: number,
  maxBytes: number,
): Promise<readonly FileBytes[]> => {
  const files: FileBytes[] = [];
  const queue = [root];
  let totalBytes = 0;
  while (queue.length) {
    const directory = queue.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new VariantRefusal(
          'reparse-point',
          `${absolute}: symbolic link or reparse point is refused.`,
        );
      }
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new VariantRefusal(
          'reparse-point',
          `${absolute}: symbolic link or reparse point is refused.`,
        );
      }
      if (stat.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw new VariantRefusal(
          'invalid-folder',
          `${absolute}: only ordinary files are admitted.`,
        );
      }
      if (!within(root, absolute)) {
        throw new VariantRefusal('invalid-folder', `${absolute}: file escaped variant folder.`);
      }
      if (files.length + 1 > maxFiles) {
        throw new VariantRefusal('limit-exceeded', `${root}: file limit ${maxFiles} exceeded.`);
      }
      totalBytes += stat.size;
      if (totalBytes > maxBytes) {
        throw new VariantRefusal('limit-exceeded', `${root}: byte limit ${maxBytes} exceeded.`);
      }
      files.push({
        relative: path.relative(root, absolute).split(path.sep).join('/'),
        absolute,
        bytes: await fs.readFile(absolute),
      });
    }
  }
  return files;
};

const loadFolder = async (
  folderPath: string,
  source: LoadedIndustryVariant['source'],
  maxFiles: number,
  maxBytes: number,
): Promise<LoadedIndustryVariant> => {
  const folderStat = await fs.lstat(folderPath);
  if (folderStat.isSymbolicLink()) {
    throw new VariantRefusal(
      'reparse-point',
      `${folderPath}: symbolic link or reparse point is refused.`,
    );
  }
  const realFolder = await fs.realpath(folderPath);
  if (path.resolve(realFolder) !== path.resolve(folderPath)) {
    throw new VariantRefusal(
      'reparse-point',
      `${folderPath}: resolved path differs from the data folder.`,
    );
  }
  const files = await enumerateFiles(folderPath, maxFiles, maxBytes);
  const byPath = new Map(files.map((file) => [file.relative, file]));
  const variantFile = byPath.get('variant.json');
  const fixturesFile = byPath.get('fixtures.json');
  if (!variantFile) {
    throw new VariantRefusal('invalid-folder', `${folderPath}: missing field file variant.json.`);
  }
  if (!fixturesFile) {
    throw new VariantRefusal('invalid-folder', `${folderPath}: missing field file fixtures.json.`);
  }

  const parsedVariant = variantSchema.safeParse(parseJson(variantFile));
  if (!parsedVariant.success) {
    throw new VariantRefusal(
      'invalid-variant',
      `${folderPath}: ${schemaMessage('variant', parsedVariant.error)}`,
    );
  }
  const parsedFixtures = fixturesSchema.safeParse(parseJson(fixturesFile));
  if (!parsedFixtures.success) {
    throw new VariantRefusal(
      'invalid-fixture',
      `${folderPath}: ${schemaMessage('fixtures', parsedFixtures.error)}`,
    );
  }
  if (path.basename(folderPath) !== parsedVariant.data.id) {
    throw new VariantRefusal(
      'invalid-variant',
      `${folderPath}: variant.id ${JSON.stringify(parsedVariant.data.id)} must match the folder name.`,
    );
  }

  const admitted = new Set(['variant.json', 'fixtures.json']);
  const seenFixturePaths = new Set<string>();
  const loadedFixtures: LoadedIndustryFixture[] = [];
  for (const fixture of parsedFixtures.data) {
    safeFixturePath(fixture.path, fixture.slot);
    if (seenFixturePaths.has(fixture.path)) {
      throw new VariantRefusal(
        'invalid-fixture',
        `${folderPath}: duplicate fixtures.path ${fixture.path}.`,
      );
    }
    seenFixturePaths.add(fixture.path);
    const relative = `fixtures/${fixture.path}`;
    const file = byPath.get(relative);
    if (!file) {
      throw new VariantRefusal(
        'invalid-fixture',
        `${folderPath}: fixtures.path ${fixture.path} is missing.`,
      );
    }
    admitted.add(relative);
    const template = file.bytes.toString('utf8');
    if (template.includes('\0')) {
      throw new VariantRefusal(
        'invalid-fixture',
        `${file.absolute}: fixture text contains a NUL byte.`,
      );
    }
    loadedFixtures.push(Object.freeze({ ...fixture, template }));
  }
  const unexpected = files.find((file) => !admitted.has(file.relative));
  if (unexpected) {
    throw new VariantRefusal(
      'unexpected-file',
      `${unexpected.absolute}: unexpected file; executable imports and unlisted fixture bytes are refused.`,
    );
  }

  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) =>
    left.relative.localeCompare(right.relative),
  )) {
    hash.update(file.relative, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(file.bytes);
    hash.update(Buffer.from([0]));
  }
  const digest = `sha256:${hash.digest('hex')}` as const;
  const data = parsedVariant.data;
  return Object.freeze({
    ...data,
    keywords: Object.freeze([...data.keywords]),
    scopeSelection: Object.freeze([...data.scopeSelection]),
    terminology: Object.freeze({ ...data.terminology }),
    source,
    sourcePath: path.resolve(folderPath),
    digest,
    fixtures: Object.freeze(loadedFixtures),
  });
};

const refusalOf = (folderPath: string, error: unknown): IndustryRegistryRefusal => {
  if (error instanceof VariantRefusal) {
    return Object.freeze({
      code: error.code,
      path: path.resolve(folderPath),
      message: error.message,
    });
  }
  return Object.freeze({
    code: 'invalid-folder',
    path: path.resolve(folderPath),
    message: `${folderPath}: ${error instanceof Error ? error.message : String(error)}`,
  });
};

/** Load data-only variants. A refused folder is reported and never blocks unrelated folders. */
export async function loadIndustryVariantRegistry(
  options: LoadIndustryVariantRegistryOptions,
): Promise<IndustryVariantRegistry> {
  const maxFiles = options.maxVariantFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxVariantBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 3)
    throw new Error('maxVariantFiles must be at least 3.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('maxVariantBytes must be positive.');

  const loaded: LoadedIndustryVariant[] = [];
  const refusals: IndustryRegistryRefusal[] = [];
  const roots: Array<{ path: string; source: LoadedIndustryVariant['source']; optional: boolean }> =
    [
      { path: path.resolve(options.bundledRoot), source: 'bundled', optional: false },
      ...(options.operatorRoot
        ? [
            {
              path: path.resolve(options.operatorRoot),
              source: 'operator' as const,
              optional: true,
            },
          ]
        : []),
    ];
  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true });
    } catch (error) {
      if (root.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const folderPath = path.join(root.path, entry.name);
      if (entry.isSymbolicLink()) {
        refusals.push(
          Object.freeze({
            code: 'reparse-point',
            path: path.resolve(folderPath),
            message: `${folderPath}: symbolic link or reparse point is refused.`,
          }),
        );
        continue;
      }
      if (!entry.isDirectory()) {
        refusals.push(
          Object.freeze({
            code: 'invalid-folder',
            path: path.resolve(folderPath),
            message: `${folderPath}: registry entries must be data folders.`,
          }),
        );
        continue;
      }
      try {
        loaded.push(await loadFolder(folderPath, root.source, maxFiles, maxBytes));
      } catch (error) {
        refusals.push(refusalOf(folderPath, error));
      }
    }
  }

  const grouped = new Map<string, LoadedIndustryVariant[]>();
  for (const variant of loaded)
    grouped.set(variant.id, [...(grouped.get(variant.id) ?? []), variant]);
  const variants = new Map<string, LoadedIndustryVariant>();
  for (const [id, matches] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    if (matches.length > 1) {
      const paths = matches.map((match) => match.sourcePath).sort();
      refusals.push(
        Object.freeze({
          code: 'duplicate-id',
          path: paths[0]!,
          message: `Duplicate variant id ${JSON.stringify(id)} appears at ${paths.join(' and ')}.`,
        }),
      );
      continue;
    }
    variants.set(id, matches[0]!);
  }
  return Object.freeze({ variants, refusals: Object.freeze(refusals) });
}
