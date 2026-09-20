import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  READINESS_CONTRACT_VERSION,
  productKnowledgeIndexSchema,
  productKnowledgeResourceSchema,
  type ProductKnowledgeBundle,
  type ProductKnowledgeConflict,
} from '../../shared/readiness.js';

const MAX_INDEX_BYTES = 64 * 1024;
const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const allScopes = (resources: readonly { scopes: readonly string[] }[]) =>
  [...new Set(['product', ...resources.flatMap((item) => item.scopes)])].sort();

async function regularText(file: string, maxBytes: number): Promise<string> {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The path is not a regular file.');
  if (info.size > maxBytes) throw new Error(`The file exceeds the ${maxBytes} byte limit.`);
  return fs.readFile(file, 'utf8');
}

/**
 * Load the shipped, local-only knowledge set. The index is the trusted scope
 * and digest declaration; a resource that differs is not parsed or partially
 * accepted. No network, discovery or account operation is reachable here.
 */
export async function loadProductKnowledge(input: {
  root: string;
  buildVersion: string;
  now?: string;
}): Promise<ProductKnowledgeBundle> {
  const loadedAt = input.now ?? new Date().toISOString();
  const conflicts: ProductKnowledgeConflict[] = [];
  const empty = (code: 'missing-index' | 'invalid-index', detail: string): ProductKnowledgeBundle => ({
    contractVersion: READINESS_CONTRACT_VERSION,
    indexVersion: null,
    buildVersion: input.buildVersion,
    bundleSha256: null,
    resources: [],
    conflicts: [{ code, detail, scopes: ['product'], source: 'resources/product-knowledge/index.json' }],
    loadedAt,
  });

  const root = path.resolve(input.root);
  const indexPath = path.join(root, 'index.json');
  let indexText: string;
  try {
    indexText = await regularText(indexPath, MAX_INDEX_BYTES);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return empty('missing-index', 'The shipped product knowledge index is missing.');
    return empty('invalid-index', `The product knowledge index is unusable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  let index;
  try {
    index = productKnowledgeIndexSchema.parse(JSON.parse(indexText));
  } catch (error) {
    return empty('invalid-index', `The product knowledge index is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  const scopes = allScopes(index.resources);
  if (index.buildVersion !== input.buildVersion)
    conflicts.push({
      code: 'build-version',
      detail: `Knowledge index ${index.version} describes build ${index.buildVersion}, not installed build ${input.buildVersion}.`,
      scopes,
      source: 'resources/product-knowledge/index.json',
    });

  const resources: ProductKnowledgeBundle['resources'][number][] = [];
  let totalBytes = Buffer.byteLength(indexText);
  const resourceIds = new Map<string, string>();
  for (const entry of [...index.resources].sort((a, b) => a.path.localeCompare(b.path))) {
    const source = `resources/product-knowledge/${entry.path}`;
    const file = path.resolve(root, entry.path);
    const relative = path.relative(root, file);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      conflicts.push({ code: 'invalid-resource', detail: 'The indexed path leaves the product knowledge folder.', scopes: entry.scopes, source });
      continue;
    }
    let text: string;
    try {
      text = await regularText(file, MAX_RESOURCE_BYTES);
      const realRoot = await fs.realpath(root);
      const realFile = await fs.realpath(file);
      const realRelative = path.relative(realRoot, realFile);
      if (realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative))
        throw new Error('The indexed file resolves outside the product knowledge folder.');
    } catch (error) {
      conflicts.push({
        code: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing-resource' : 'invalid-resource',
        detail: `The indexed resource is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
        scopes: entry.scopes,
        source,
      });
      continue;
    }
    const bytes = Buffer.byteLength(text);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      conflicts.push({ code: 'invalid-resource', detail: 'The product knowledge set exceeds its total byte limit.', scopes: entry.scopes, source });
      continue;
    }
    const actual = digest(text);
    if (actual !== entry.sha256) {
      conflicts.push({
        code: 'digest-mismatch',
        detail: `The bytes do not match the indexed sha256 ${entry.sha256}.`,
        scopes: entry.scopes,
        source,
      });
      continue;
    }
    let resource;
    try {
      resource = productKnowledgeResourceSchema.parse(JSON.parse(text));
    } catch (error) {
      conflicts.push({
        code: 'invalid-resource',
        detail: `The indexed resource is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
        scopes: entry.scopes,
        source,
      });
      continue;
    }
    if (resource.buildVersion !== input.buildVersion)
      conflicts.push({
        code: 'build-version',
        detail: `Resource ${resource.id} describes build ${resource.buildVersion}, not installed build ${input.buildVersion}.`,
        scopes: entry.scopes,
        source,
      });
    const prior = resourceIds.get(resource.id);
    if (prior)
      conflicts.push({
        code: 'duplicate-resource',
        detail: `Resource id ${resource.id} is also declared by ${prior}.`,
        scopes: entry.scopes,
        source,
      });
    else resourceIds.set(resource.id, entry.path);
    if (
      resource.qualification.status === 'verified' &&
      resource.qualification.qualifiedAt !== null &&
      resource.qualification.staleAfterMs !== null &&
      Date.parse(loadedAt) - Date.parse(resource.qualification.qualifiedAt) > resource.qualification.staleAfterMs
    )
      conflicts.push({
        code: 'stale-qualification',
        detail: `Qualification ${resource.qualification.evidenceId} is past its ${resource.qualification.staleAfterMs} ms freshness window.`,
        scopes: entry.scopes,
        source,
      });
    resources.push({ path: entry.path, sha256: actual, bytes, resource });
  }

  const bundleSha256 = digest(
    JSON.stringify({
      index: digest(indexText),
      resources: resources.map((item) => ({ path: item.path, sha256: item.sha256 })),
    }),
  );
  return {
    contractVersion: READINESS_CONTRACT_VERSION,
    indexVersion: index.version,
    buildVersion: input.buildVersion,
    bundleSha256,
    resources,
    conflicts,
    loadedAt,
  };
}
