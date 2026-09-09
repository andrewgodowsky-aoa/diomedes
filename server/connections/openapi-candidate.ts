import { z } from 'zod';
import { connectorManifestSchema, type ConnectorManifest } from '../../shared/connections.js';

const selectionSchema = z.strictObject({
  connectorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  operationIds: z.array(z.string().min(1).max(120)).min(1).max(12),
  sourceUrl: z.url(),
});

type Selection = z.infer<typeof selectionSchema>;

const METHODS: string[] = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'];

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSnake(operationId: string): string {
  const snake = operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return snake;
}

/** Reject every $ref explicitly. Local refs are not resolved; remote refs are never fetched. */
function rejectRefs(value: unknown): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) return;
    const { node, depth } = next;
    if (depth > 25 || count > 2000)
      fail('Unsupported spec: object graph too deep (refs not resolved).');
    if (isRecord(node)) {
      if (seen.has(node)) continue;
      seen.add(node);
      count += 1;
      for (const [key, child] of Object.entries(node)) {
        if (key === '$ref') {
          if (typeof child !== 'string') fail('Malformed spec: $ref must be a string.');
          if (child.startsWith('#/'))
            fail(`Unsupported spec: local $ref is not resolved (${child}).`);
          fail(`Unsupported spec: remote $ref is never fetched (${child}).`);
        }
        stack.push({ node: child, depth: depth + 1 });
      }
    } else if (Array.isArray(node)) {
      if (seen.has(node)) continue;
      seen.add(node);
      count += 1;
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    }
  }
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0)
    fail(`Malformed spec: ${field} must be a non-empty string.`);
  return value;
}

interface IndexedOperation {
  method: string;
  path: string;
  operation: Record<string, unknown>;
  pathItem: Record<string, unknown>;
}

export function generateCandidate(spec: unknown, selection: Selection): ConnectorManifest {
  const sel = selectionSchema.parse(selection);
  if (new Set(sel.operationIds).size !== sel.operationIds.length) {
    fail('Ambiguous selection: duplicate operationId in selection.');
  }
  if (!isRecord(spec)) fail('Malformed spec: root must be an object.');
  const openapi = spec['openapi'];
  if (typeof openapi !== 'string' || /^3\.(0|1|2)\.\d+$/.test(openapi) === false) {
    fail(`Unsupported spec: only OpenAPI 3.0/3.1/3.2 are supported (got ${String(openapi)}).`);
  }
  const info = spec['info'];
  if (!isRecord(info)) fail('Malformed spec: info must be an object.');
  const vendor = requiredString(info, 'title');
  const version = requiredString(info, 'version');

  if (spec['servers'] !== undefined) {
    fail('Unsupported spec: servers overrides require separate review.');
  }
  if (spec['security'] !== undefined) {
    fail('Unsupported spec: hidden security requires separate review.');
  }
  const components = spec['components'];
  if (components !== undefined && !isRecord(components))
    fail('Malformed spec: components must be an object.');
  if (isRecord(components) && components['securitySchemes'] !== undefined) {
    fail('Unsupported spec: securitySchemes require separate review.');
  }
  if (spec['webhooks'] !== undefined) {
    fail('Unsupported spec: webhooks are not supported.');
  }

  const paths = spec['paths'];
  if (!isRecord(paths)) fail('Malformed spec: paths must be an object.');

  const byId = new Map<string, IndexedOperation[]>();
  for (const [path, rawItem] of Object.entries(paths)) {
    if (!/^\/[A-Za-z0-9_{}./-]*$/.test(path) || path.includes('//') || path.includes('..'))
      fail('Unsupported spec: source paths must be simple absolute API paths.');
    if (!isRecord(rawItem)) fail(`Malformed spec: path item for ${path} must be an object.`);
    for (const method of METHODS) {
      const rawOp = rawItem[method];
      if (rawOp === undefined) continue;
      if (!isRecord(rawOp))
        fail(`Malformed spec: operation ${method.toUpperCase()} ${path} must be an object.`);
      const id = rawOp['operationId'];
      if (typeof id !== 'string' || id.length === 0) continue;
      const list = byId.get(id);
      const entry: IndexedOperation = {
        method: method.toUpperCase(),
        path,
        operation: rawOp,
        pathItem: rawItem,
      };
      if (list === undefined) byId.set(id, [entry]);
      else list.push(entry);
    }
  }

  const operations: ConnectorManifest['operations'] = [];
  const seenIds = new Set<string>();

  for (const operationId of sel.operationIds) {
    const matches = byId.get(operationId);
    if (matches === undefined || matches.length === 0) fail(`Unknown operationId: ${operationId}.`);
    if (matches.length > 1) fail(`Ambiguous duplicate operationId: ${operationId}.`);
    const match = matches.at(0);
    if (match === undefined) fail(`Unknown operationId: ${operationId}.`);
    if (match.method !== 'GET')
      fail(`Writes refused: ${operationId} is ${match.method} ${match.path} (GET only).`);
    if (/[{}]/.test(match.path))
      fail('Unsupported spec: path templates require separate binding review.');
    const op = match.operation;

    if (op['requestBody'] !== undefined)
      fail(`Unsupported spec: request bodies are not supported (${operationId}).`);
    if (op['callbacks'] !== undefined)
      fail(`Unsupported spec: callbacks are not supported (${operationId}).`);
    if (op['servers'] !== undefined || op['security'] !== undefined) {
      fail(
        `Unsupported spec: per-operation servers/security overrides require review (${operationId}).`,
      );
    }
    if (match.pathItem['servers'] !== undefined || match.pathItem['security'] !== undefined) {
      fail(
        `Unsupported spec: per-path servers/security overrides require review (${operationId}).`,
      );
    }
    if (match.pathItem['parameters'] !== undefined || match.pathItem['$ref'] !== undefined)
      fail('Unsupported spec: inherited path parameters and references require review.');
    rejectRefs(op);

    const summary = typeof op['summary'] === 'string' ? op['summary'] : '';
    const descriptionRaw = typeof op['description'] === 'string' ? op['description'] : summary;
    const description = (descriptionRaw.length > 0 ? descriptionRaw : operationId).slice(0, 500);

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const parameters = op['parameters'];
    if (parameters !== undefined) {
      if (Array.isArray(parameters) === false)
        fail(`Malformed spec: parameters must be an array (${operationId}).`);
      for (const rawParam of parameters) {
        if (!isRecord(rawParam))
          fail(`Malformed spec: parameter must be an object (${operationId}).`);
        const name = rawParam['name'];
        const location = rawParam['in'];
        if (typeof name !== 'string' || name.length === 0)
          fail(`Malformed spec: parameter name required (${operationId}).`);
        if (
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) ||
          ['constructor', 'prototype'].includes(name) ||
          Object.hasOwn(properties, name)
        )
          fail('Unsupported spec: parameter names must be safe and unique across locations.');
        if (rawParam['required'] !== undefined && typeof rawParam['required'] !== 'boolean')
          fail('Malformed parameter required flag.');
        if (
          ['style', 'explode', 'allowReserved', 'content'].some(
            (key) => rawParam[key] !== undefined,
          )
        )
          fail('Unsupported spec: parameter serialization requires review.');
        if (location !== 'query') {
          fail(`Unsupported spec: only query parameters are supported (${operationId}).`);
        }
        const schema = rawParam['schema'];
        if (!isRecord(schema))
          fail(`Malformed spec: inline parameter schema required (${operationId}.${name}).`);
        validateSchema(schema);
        properties[name] = schema;
        if (rawParam['required'] === true) required.push(name);
      }
    }
    const inputSchema: Record<string, unknown> = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };

    const responses = op['responses'];
    if (!isRecord(responses)) fail(`Malformed spec: responses must be an object (${operationId}).`);
    const status =
      responses['200'] !== undefined
        ? '200'
        : Object.keys(responses).find((key) => /^2\d\d$/.test(key));
    if (status === undefined) fail(`Malformed spec: a 2xx response is required (${operationId}).`);
    const response = responses[status];
    if (!isRecord(response))
      fail(`Malformed spec: response ${status} must be an object (${operationId}).`);
    const content = response['content'];
    if (!isRecord(content)) fail(`Malformed spec: response content is required (${operationId}).`);
    const jsonMedia = content['application/json'];
    if (!isRecord(jsonMedia))
      fail(`Unsupported spec: application/json response is required (${operationId}).`);
    const resultSchema = jsonMedia['schema'];
    if (!isRecord(resultSchema)) {
      fail(`Malformed spec: inline response schema is required (${operationId}).`);
    }
    validateSchema(resultSchema);

    const normalized = toSnake(operationId);
    if (/^[a-z][a-z0-9_]{0,40}$/.test(normalized) === false) {
      fail(`Malformed spec: operationId does not map to a manifest id (${operationId}).`);
    }
    if (seenIds.has(normalized))
      fail(`Ambiguous duplicate operationId after normalization: ${operationId}.`);
    seenIds.add(normalized);

    operations.push({
      id: normalized,
      description,
      effect: 'read',
      permission: 'connections.read',
      vendorScopes: [],
      source: { method: 'GET', path: match.path },
      inputSchema: z.json().parse(inputSchema),
      resultSchema: z.json().parse(resultSchema),
    });
  }

  return connectorManifestSchema.parse({
    schemaVersion: 1,
    id: sel.connectorId,
    vendor,
    version,
    provenance: {
      source: sel.sourceUrl,
      license: 'candidate-only; source licence must be reviewed',
      review: 'candidate',
      integrity: null,
    },
    authentication: ['none'],
    operations,
    // Documentation provenance is not an API destination. No destination is approved here.
    allowedOrigins: [],
    pagination: 'Candidate only; pagination unreviewed.',
    rateLimit: 'Candidate only; no live calls.',
    retry: 'Candidate only; no live calls.',
    idempotency: 'Read-only candidate.',
    reconciliation: 'Candidate only; no reconciliation.',
    webhook: 'Unavailable in candidate.',
    freshness: 'Candidate only; no live data.',
    dataClassification: 'restricted',
    limitations: [
      'Inactive candidate; authority is not activated and no network calls are made.',
      'Curated subset: only explicitly selected GET operations are exposed.',
      'Remote and local $refs are never fetched or resolved.',
    ],
    approvals: ['Host review required before activation.'],
    healthCheck: 'Candidate only; no live check.',
    fixtures: [],
    rules: [],
  });
}

/** Deliberately small inline-schema subset; JSON validity alone is not schema validation. */
function validateSchema(value: Record<string, unknown>, depth = 0): void {
  if (depth > 20) fail('Unsupported schema depth.');
  const supported = new Set([
    'type',
    'properties',
    'required',
    'items',
    'additionalProperties',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'description',
    'format',
    'enum',
  ]);
  if (Object.keys(value).some((key) => !supported.has(key))) fail('Unsupported schema keyword.');
  if (
    !['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(String(value['type']))
  )
    fail('Unsupported or malformed schema type.');
  if (
    value['additionalProperties'] !== undefined &&
    typeof value['additionalProperties'] !== 'boolean'
  )
    fail('Unsupported additionalProperties schema.');
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    )
      fail('Malformed schema bound.');
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'])
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 0))
      fail('Malformed schema size bound.');
  for (const [min, max] of [
    ['minimum', 'maximum'],
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
  ])
    if (typeof value[min] === 'number' && typeof value[max] === 'number' && value[min] > value[max])
      fail('Malformed schema bound ordering.');
  for (const key of ['description', 'format'])
    if (value[key] !== undefined && typeof value[key] !== 'string') fail('Malformed schema text.');
  if (value['enum'] !== undefined && (!Array.isArray(value['enum']) || !value['enum'].length))
    fail('Malformed enum.');
  if (value['type'] === 'array') {
    if (!isRecord(value['items'])) fail('Inline array items required.');
    validateSchema(value['items'], depth + 1);
  }
  if (value['properties'] !== undefined) {
    if (value['type'] !== 'object' || !isRecord(value['properties'])) fail('Malformed properties.');
    for (const schema of Object.values(value['properties'])) {
      if (!isRecord(schema)) fail('Malformed property schema.');
      validateSchema(schema, depth + 1);
    }
  }
  if (
    value['required'] !== undefined &&
    (!Array.isArray(value['required']) ||
      !value['required'].every(
        (name) =>
          typeof name === 'string' &&
          isRecord(value['properties']) &&
          Object.hasOwn(value['properties'], name),
      ))
  )
    fail('Malformed required property list.');
}
