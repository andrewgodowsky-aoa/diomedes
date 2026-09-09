import { z } from 'zod';
import type { Json } from '../../shared/harness.js';
import { connectorManifestSchema, type ConnectorManifest } from '../../shared/connections.js';
import { digest } from '../harness/policy.js';
import { generateCandidate } from './openapi-candidate.js';
import type { FixtureConnector, FixtureOperation } from './service.js';

const selectionSchema = z.strictObject({
  connectorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  operationIds: z.array(z.string().min(1).max(120)).min(1).max(12),
  sourceUrl: z.url(),
});
const resourceSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  name: z.string().min(1).max(100),
});
const fixtureCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  operationId: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  input: z.json(),
  resources: z.array(resourceSchema.shape.id).min(1).max(32),
  result: z.json(),
});
const reviewSchema = z.strictObject({
  expectedCandidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  license: z.string().min(1).max(200),
  resources: z.array(resourceSchema).min(1).max(32),
  cases: z.array(fixtureCaseSchema).min(1).max(64),
});

export type OpenApiSelection = z.infer<typeof selectionSchema>;
export type ReviewedFixtureCase = z.infer<typeof fixtureCaseSchema>;
export type FixtureCompilationReview = z.infer<typeof reviewSchema>;

export interface CompileFixtureInput {
  sourceSpec: unknown;
  selection: OpenApiSelection;
  candidate: ConnectorManifest;
  review: FixtureCompilationReview;
}

export interface FixtureCompilationEvidence {
  readonly candidateDigest: string;
  readonly sourceDigest: string;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly resourceIds: readonly string[];
  readonly fixtureCaseIds: readonly string[];
}

export type CompiledFixtureConnector = FixtureConnector & {
  readonly compilation: FixtureCompilationEvidence;
};

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_FIXTURE_BYTES = 128 * 1024;
const MAX_NODES = 5_000;
const MAX_DEPTH = 25;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate plain bounded JSON before it reaches hashing, schemas, or fixture closures. */
function boundedJson(label: string, value: unknown, maximumBytes: number): Json {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if (next.depth > MAX_DEPTH) fail(`${label} exceeds the supported nesting depth.`);
    const item = next.value;
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint')
      fail(`${label} must contain data only.`);
    if (item === undefined || (typeof item === 'number' && !Number.isFinite(item)))
      fail(`${label} must be valid JSON.`);
    if (item && typeof item === 'object') {
      if (seen.has(item)) fail(`${label} must not contain cycles or aliases.`);
      seen.add(item);
      nodes += 1;
      if (nodes > MAX_NODES) fail(`${label} exceeds the supported object count.`);
      if (Array.isArray(item)) {
        for (const child of item) stack.push({ value: child, depth: next.depth + 1 });
      } else {
        for (const [key, child] of Object.entries(item)) {
          if (DANGEROUS_KEYS.has(key)) fail(`${label} contains an unsafe object key.`);
          stack.push({ value: child, depth: next.depth + 1 });
        }
      }
    }
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return fail(`${label} must be valid JSON.`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maximumBytes)
    fail(`${label} exceeds the supported byte limit.`);
  return z.json().parse(JSON.parse(encoded));
}

function withoutDialect(schema: Json): Json {
  const copy = structuredClone(schema);
  if (isRecord(copy)) delete copy['$schema'];
  return copy;
}

function compileSchema(label: string, schema: Json): z.ZodType<Json> {
  if (!isRecord(schema) || schema['type'] !== 'object')
    fail(`${label} must be an inline object schema.`);
  let compiled: z.ZodType;
  try {
    compiled = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return fail(`${label} uses a schema construct the fixture compiler does not support.`);
  }
  const roundTrip = z.json().parse(z.toJSONSchema(compiled));
  if (digest(withoutDialect(roundTrip)) !== digest(withoutDialect(schema)))
    fail(`${label} does not survive the supported schema compilation round trip.`);
  return compiled as z.ZodType<Json>;
}

function manifestSchema(schema: z.ZodType<Json>): Json {
  return z.json().parse(z.toJSONSchema(schema));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeEvidence(value: FixtureCompilationEvidence): FixtureCompilationEvidence {
  Object.freeze(value.resourceIds);
  Object.freeze(value.fixtureCaseIds);
  return Object.freeze(value);
}

/**
 * Promote one exact inactive OpenAPI candidate into a local fixture connector.
 * The source is regenerated, the reviewed digests must match, and only exact
 * host-supplied fixture cases become executable. No source text or extension is
 * evaluated, imported, fetched, or treated as authority.
 */
export function compileReviewedFixtureConnector(
  input: CompileFixtureInput,
): CompiledFixtureConnector {
  const sourceSpec = boundedJson('OpenAPI source', input.sourceSpec, MAX_SOURCE_BYTES);
  const selection = selectionSchema.parse(input.selection);
  const candidateJson = boundedJson('Connector candidate', input.candidate, MAX_CANDIDATE_BYTES);
  const candidate = connectorManifestSchema.parse(candidateJson);
  const reviewJson = boundedJson('Fixture review', input.review, MAX_FIXTURE_BYTES);
  const review = reviewSchema.parse(reviewJson);
  const sourceDigest = digest(sourceSpec);
  const candidateDigest = digest(candidate);

  if (sourceDigest !== review.expectedSourceDigest)
    fail('Source digest mismatch; review the exact OpenAPI document again.');
  if (candidateDigest !== review.expectedCandidateDigest)
    fail('Candidate digest mismatch; review the exact candidate again.');
  const regenerated = generateCandidate(sourceSpec, selection);
  if (digest(regenerated) !== candidateDigest)
    fail('Candidate does not match the selected operations in the reviewed source.');
  if (candidate.id !== selection.connectorId || candidate.allowedOrigins.length !== 0)
    fail('Candidate identity or destination authority changed after generation.');

  const resourceIds = review.resources.map((resource) => resource.id);
  if (new Set(resourceIds).size !== resourceIds.length)
    fail('Reviewed fixture resources must be unique.');
  const declaredOperations = new Set(candidate.operations.map((operation) => operation.id));
  if (new Set(review.cases.map((item) => item.id)).size !== review.cases.length)
    fail('Reviewed fixture case identities must be unique.');
  if (review.cases.some((item) => !declaredOperations.has(item.operationId)))
    fail('A fixture case names an undeclared operation.');
  if (review.cases.some((item) => new Set(item.resources).size !== item.resources.length))
    fail('A fixture case must bind distinct resources.');
  if (
    review.cases.some((item) => item.resources.some((resource) => !resourceIds.includes(resource)))
  )
    fail('A fixture case names an undeclared resource.');
  if (
    candidate.operations.some(
      (operation) => !review.cases.some((item) => item.operationId === operation.id),
    )
  )
    fail('Every selected operation needs at least one reviewed fixture case.');

  const operations: FixtureOperation[] = candidate.operations.map((declared) => {
    const inputSchema = compileSchema(`${declared.id} input`, declared.inputSchema);
    const resultSchema = compileSchema(`${declared.id} result`, declared.resultSchema);
    const cases = new Map<string, ReviewedFixtureCase>();
    for (const fixture of review.cases.filter((item) => item.operationId === declared.id)) {
      const parsedInput = inputSchema.safeParse(fixture.input);
      if (!parsedInput.success) fail(`Fixture ${fixture.id} has malformed input.`);
      const parsedResult = resultSchema.safeParse(fixture.result);
      if (!parsedResult.success) fail(`Fixture ${fixture.id} has a malformed result.`);
      const key = digest(parsedInput.data);
      if (cases.has(key)) fail(`Operation ${declared.id} has duplicate fixture input.`);
      const stored = {
        ...fixture,
        input: structuredClone(parsedInput.data),
        resources: [...fixture.resources],
        result: structuredClone(parsedResult.data),
      };
      deepFreeze(stored);
      cases.set(key, stored);
    }
    const find = (raw: Json) => {
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) fail(`Arguments do not match ${declared.id}.`);
      return (
        cases.get(digest(parsed.data)) ?? fail(`No reviewed fixture case matches ${declared.id}.`)
      );
    };
    return Object.freeze({
      id: declared.id,
      input: inputSchema,
      result: resultSchema,
      resources: (raw: Json) => [...find(raw).resources],
      execute: async (raw: Json, signal: AbortSignal) => {
        signal.throwIfAborted();
        return structuredClone(find(raw).result);
      },
      observations: () => [],
    });
  });

  const manifest = connectorManifestSchema.parse({
    ...candidate,
    provenance: {
      source: candidate.provenance.source,
      license: review.license,
      review: 'host-reviewed',
      integrity: sourceDigest,
    },
    authentication: ['fixture'],
    operations: candidate.operations.map((declared, index) => ({
      ...declared,
      inputSchema: manifestSchema(operations[index].input),
      resultSchema: manifestSchema(operations[index].result),
    })),
    allowedOrigins: [],
    pagination: 'Only the bounded reviewed fixture cases are available; no continuation cursor.',
    rateLimit: 'Local immutable fixture data only; no provider quota is consumed.',
    retry:
      'Runtime permits at most two attempts. Retry only the same durable step identity with identical canonical input.',
    idempotency:
      'A completed identical Runtime step returns its recorded result; changed input under the same step identity is refused.',
    reconciliation:
      'Fixture results are accepted only while current connection authority still matches the run binding.',
    webhook: 'Unavailable for generated fixture connectors.',
    freshness: 'Synthetic snapshot fixed by the reviewed fixture case.',
    limitations: [
      ...candidate.limitations,
      'Local immutable fixture execution only; no network transport, credential use, redirects, or production source access.',
    ],
    approvals: [
      `Host review bound to candidate digest ${candidateDigest}.`,
      `Source document bound to digest ${sourceDigest}.`,
    ],
    healthCheck: 'A schema-valid exact fixture case can be read through Runtime.',
    fixtures: review.cases.map((item) => item.id),
    rules: [],
  });
  const compilation = freezeEvidence({
    candidateDigest,
    sourceDigest,
    connectorId: manifest.id,
    connectorVersion: manifest.version,
    resourceIds: Object.freeze([...resourceIds]),
    fixtureCaseIds: Object.freeze(review.cases.map((item) => item.id)),
  });
  Object.freeze(operations);
  deepFreeze(manifest);
  return Object.freeze({ manifest, operations, compilation });
}
