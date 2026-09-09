import { describe, expect, test } from 'vitest';
import { generateCandidate } from '../server/connections/openapi-candidate.js';
import petstore from '../fixtures/connections/petstore.openapi.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function mustRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error('expected a record');
}

function cloneBase(): Record<string, unknown> {
  const raw: unknown = JSON.parse(JSON.stringify(petstore));
  return mustRecord(raw);
}

function selection(operationIds: string[]): {
  connectorId: string;
  operationIds: string[];
  sourceUrl: string;
} {
  return { connectorId: 'petstore', operationIds, sourceUrl: 'https://example.com/docs/petstore' };
}

describe('openapi candidate generator', () => {
  test('selection exposes only explicitly selected GET operations', () => {
    const manifest = generateCandidate(petstore, selection(['listPets']));
    expect(manifest.operations).toHaveLength(1);
    const op = manifest.operations.at(0);
    if (op === undefined) throw new Error('missing operation');
    expect(op.id).toBe('list_pets');
    expect(op.source).toMatchObject({ method: 'GET', path: '/pets' });
    expect(manifest.operations.map((entry) => entry.id)).not.toContain('create_pet');
  });

  test('candidate is inactive and inspectable', () => {
    const manifest = generateCandidate(petstore, selection(['listPets']));
    expect(manifest.provenance.review).toBe('candidate');
    expect(manifest.provenance.integrity).toBeNull();
    expect(manifest.authentication).toEqual(['none']);
    expect(manifest.allowedOrigins).toEqual([]);
    expect(manifest.dataClassification).toBe('restricted');
    expect(manifest.rules).toEqual([]);
    expect(JSON.stringify(manifest.limitations)).toMatch(/not activated/i);
    const op = manifest.operations.at(0);
    if (op === undefined) throw new Error('missing operation');
    expect(op.source.method).toBe('GET');
    expect(mustRecord(op.inputSchema)).toBeDefined();
    expect(mustRecord(op.resultSchema)).toBeDefined();
  });

  test('input and result schemas are preserved', () => {
    const manifest = generateCandidate(petstore, selection(['listPets']));
    const op = manifest.operations.at(0);
    if (op === undefined) throw new Error('missing operation');
    const input = mustRecord(op.inputSchema);
    const properties = mustRecord(input['properties']);
    expect(mustRecord(properties['limit'])).toMatchObject({ type: 'integer' });
    const result = mustRecord(op.resultSchema);
    expect(result['type']).toBe('array');
    expect(mustRecord(result['items'])).toBeDefined();
  });

  test('write operations are refused', () => {
    expect(() => generateCandidate(petstore, selection(['createPet']))).toThrow(/writes refused/i);
  });

  test('request bodies on selected operations are refused', () => {
    const spec = cloneBase();
    const pets = mustRecord(mustRecord(spec['paths'])['/pets']);
    const get = mustRecord(pets['get']);
    const post = mustRecord(pets['post']);
    get['requestBody'] = mustRecord(post['requestBody']);
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/request bodies/i);
  });

  test('remote refs are refused and never fetched', () => {
    const spec = cloneBase();
    const get = mustRecord(mustRecord(mustRecord(spec['paths'])['/pets'])['get']);
    const json = mustRecord(
      mustRecord(mustRecord(mustRecord(get['responses'])['200'])['content'])['application/json'],
    );
    json['schema'] = { $ref: 'https://example.com/schemas/pet.json' };
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/remote \$ref/i);
  });

  test('local refs are explicitly rejected', () => {
    const spec = cloneBase();
    const get = mustRecord(mustRecord(mustRecord(spec['paths'])['/pets'])['get']);
    const json = mustRecord(
      mustRecord(mustRecord(mustRecord(get['responses'])['200'])['content'])['application/json'],
    );
    json['schema'] = { $ref: '#/components/schemas/Pet' };
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/local \$ref/i);
  });

  test('hidden security is refused', () => {
    const spec = cloneBase();
    spec['components'] = {
      securitySchemes: { api_key: { type: 'apiKey', name: 'api_key', in: 'header' } },
    };
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/security/i);
  });

  test('unsupported versions are refused', () => {
    const spec = cloneBase();
    spec['openapi'] = '2.0.0';
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/only OpenAPI 3/i);
  });

  test('ambiguous duplicate operationIds are refused', () => {
    const spec = cloneBase();
    const paths = mustRecord(spec['paths']);
    paths['/pets-by-status'] = paths['/pets'];
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/ambiguous duplicate/i);
  });

  test('server overrides are refused', () => {
    const spec = cloneBase();
    spec['servers'] = [{ url: 'https://pets.example.com' }];
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/servers/i);
  });

  test('unknown operationIds are refused', () => {
    expect(() => generateCandidate(petstore, selection(['missingOp']))).toThrow(
      /unknown operationId/i,
    );
  });
  test('inherited parameters and operation security cannot be silently omitted', () => {
    const spec = cloneBase(),
      pets = mustRecord(mustRecord(spec['paths'])['/pets']);
    pets['parameters'] = [];
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(
      /inherited path parameters/i,
    );
    delete pets['parameters'];
    mustRecord(pets['get'])['security'] = [];
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/security/i);
  });
  test('an invalid inline schema is refused instead of being treated as valid JSON', () => {
    const spec = cloneBase();
    const get = mustRecord(mustRecord(mustRecord(spec['paths'])['/pets'])['get']);
    get['parameters'] = [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 'zero' } },
    ];
    expect(() => generateCandidate(spec, selection(['listPets']))).toThrow(/schema bound/);
  });
});
