import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { HarnessPrincipal, Json } from '../shared/harness.js';
import { connectionSchema } from '../shared/connections.js';
import { Store } from '../server/store.js';
import { createHarnessHost } from '../server/harness/host.js';
import { digest } from '../server/harness/policy.js';
import {
  compileReviewedFixtureConnector,
  type CompiledFixtureConnector,
  type OpenApiSelection,
  type ReviewedFixtureCase,
} from '../server/connections/compiled-fixture.js';
import {
  activateCompiledConnectionDemo,
  compiledConnectionDemoConnectors,
  listCompiledConnectionDemoCandidates,
  runCompiledConnectionDemoRoundTrip,
  type CompiledConnectionDemoName,
} from '../server/connections/compiler-demo.js';
import { fixtureCredentials } from '../server/connections/credentials.js';
import { buildConnectionsMcpProjection } from '../server/connections/mcp-projection.js';
import { generateCandidate } from '../server/connections/openapi-candidate.js';
import { ConnectionsService } from '../server/connections/service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

async function readSpec(name: string): Promise<Json> {
  return z
    .json()
    .parse(
      JSON.parse(
        await fs.readFile(path.join(process.cwd(), 'fixtures', 'connections', name), 'utf8'),
      ),
    );
}

function compile(
  sourceSpec: Json,
  selection: OpenApiSelection,
  resources: Array<{ id: string; name: string }>,
  cases: ReviewedFixtureCase[],
): CompiledFixtureConnector {
  const candidate = generateCandidate(sourceSpec, selection);
  return compileReviewedFixtureConnector({
    sourceSpec,
    selection,
    candidate,
    review: {
      expectedCandidateDigest: digest(candidate),
      expectedSourceDigest: digest(sourceSpec),
      license: 'Synthetic fixture; CC0-1.0',
      resources,
      cases,
    },
  });
}

async function connectors() {
  const librarySpec = await readSpec('library-openapi.json');
  const helpdeskSpec = await readSpec('helpdesk-openapi.json');
  const library = compile(
    librarySpec,
    {
      connectorId: 'library',
      operationIds: ['listBooks'],
      sourceUrl: 'https://fixtures.diomedes.invalid/library-openapi.json',
    },
    [
      { id: 'central', name: 'Central library' },
      { id: 'west', name: 'West library' },
    ],
    [
      {
        id: 'central-all-books',
        operationId: 'list_books',
        input: { libraryId: 'central' },
        resources: ['central'],
        result: {
          libraryId: 'central',
          books: [{ id: 'book-1', title: 'The Left Hand of Darkness', available: true }],
        },
      },
      {
        id: 'central-fiction-books',
        operationId: 'list_books',
        input: { libraryId: 'central', genre: 'fiction' },
        resources: ['central'],
        result: {
          libraryId: 'central',
          books: [{ id: 'book-2', title: 'Kindred', available: false }],
        },
      },
      {
        id: 'west-all-books',
        operationId: 'list_books',
        input: { libraryId: 'west' },
        resources: ['west'],
        result: {
          libraryId: 'west',
          books: [{ id: 'book-3', title: 'The Histories', available: true }],
        },
      },
    ],
  );
  const helpdesk = compile(
    helpdeskSpec,
    {
      connectorId: 'helpdesk',
      operationIds: ['listTickets'],
      sourceUrl: 'https://fixtures.diomedes.invalid/helpdesk-openapi.json',
    },
    [
      { id: 'support', name: 'Support queue' },
      { id: 'billing', name: 'Billing queue' },
    ],
    [
      {
        id: 'support-open-tickets',
        operationId: 'list_tickets',
        input: { queueId: 'support', state: 'open' },
        resources: ['support'],
        result: {
          queueId: 'support',
          tickets: [{ id: 'ticket-7', title: 'Cannot sign in', priority: 'urgent', state: 'open' }],
        },
      },
      {
        id: 'billing-all-tickets',
        operationId: 'list_tickets',
        input: { queueId: 'billing' },
        resources: ['billing'],
        result: {
          queueId: 'billing',
          tickets: [{ id: 'ticket-9', title: 'Invoice copy', priority: 'normal', state: 'closed' }],
        },
      },
    ],
  );
  return { librarySpec, helpdeskSpec, library, helpdesk };
}

async function fixture(adapters: CompiledFixtureConnector[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-compiler-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  const project = await store.createProject('Compiled fixture test');
  const host = createHarnessHost({ store, dataDir: store.dataDir });
  await host.init();
  let principalPatch: Partial<HarnessPrincipal> = {};
  const principal = async (projectId: string): Promise<HarnessPrincipal> => ({
    id: 'fixture-reviewer',
    tenantId: 'local',
    projectId,
    identityGeneration: 1,
    capabilities: ['connections.read', 'connections.manage'],
    ...principalPatch,
  });
  const service = new ConnectionsService(
    store,
    host,
    adapters,
    fixtureCredentials('unused').credentials,
    principal,
  );
  cleanup.push(async () => {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    store,
    host,
    project,
    service,
    principal,
    changePrincipal: (patch: Partial<HarnessPrincipal>) => {
      principalPatch = patch;
    },
  };
}

async function install(
  f: Awaited<ReturnType<typeof fixture>>,
  connector: CompiledFixtureConnector,
  id: string,
  resourceIds: string[],
) {
  return f.service.install(
    f.project.id,
    connectionSchema.parse({
      id,
      connectorId: connector.manifest.id,
      version: connector.manifest.version,
      manifestDigest: digest(connector.manifest),
      tenantId: 'local',
      projectId: f.project.id,
      name: `${connector.manifest.vendor} / synthetic`,
      resources: resourceIds.map((resourceId) => ({ id: resourceId, name: resourceId })),
      vendorScopes: [],
      operations: connector.manifest.operations.map((operation) => operation.id),
      mode: 'fixture',
      status: 'connected',
      generation: 1,
      staleAfterMs: 300_000,
      lastEventAt: null,
      lastReconciledAt: null,
      problem: null,
    }),
  );
}

describe('reviewed declarative OpenAPI fixture compiler', () => {
  test('two unrelated specifications execute generated adapters through Runtime and ConnectionsService', async () => {
    const { librarySpec, helpdeskSpec, library, helpdesk } = await connectors();
    expect(library.manifest.version).toBe('1.0.0');
    expect(helpdesk.manifest.version).toBe('2.1.0');
    expect(library.manifest.provenance.integrity).toBe(digest(librarySpec));
    expect(helpdesk.manifest.provenance.integrity).toBe(digest(helpdeskSpec));
    expect(library.manifest.allowedOrigins).toEqual([]);
    expect(Object.isFrozen(library)).toBe(true);
    expect(Object.isFrozen(library.manifest)).toBe(true);
    for (const connector of [library, helpdesk]) {
      connector.manifest.operations.forEach((descriptor, index) => {
        expect(digest(descriptor.inputSchema)).toBe(
          digest(z.toJSONSchema(connector.operations[index].input)),
        );
        expect(digest(descriptor.resultSchema)).toBe(
          digest(z.toJSONSchema(connector.operations[index].result)),
        );
      });
    }

    const f = await fixture([library, helpdesk]);
    await install(f, library, 'library-instance', ['central', 'west']);
    await install(f, helpdesk, 'helpdesk-instance', ['support', 'billing']);
    const libraryRun = await f.service.admit(
      f.project.id,
      'library-instance',
      ['central'],
      ['list_books'],
    );
    const helpdeskRun = await f.service.admit(
      f.project.id,
      'helpdesk-instance',
      ['support'],
      ['list_tickets'],
    );
    expect(
      await f.service.invoke(libraryRun, 'list_books', { libraryId: 'central' }),
    ).toMatchObject({
      result: { libraryId: 'central', books: [{ id: 'book-1' }] },
      assurance: 'fixture-only',
    });
    expect(
      await f.service.invoke(helpdeskRun, 'list_tickets', {
        queueId: 'support',
        state: 'open',
      }),
    ).toMatchObject({
      result: { queueId: 'support', tickets: [{ id: 'ticket-7', priority: 'urgent' }] },
      assurance: 'fixture-only',
    });
    expect((await f.host.runs.get(libraryRun)).steps[0].state).toBe('succeeded');
    expect((await f.host.runs.get(helpdeskRun)).steps[0].state).toBe('succeeded');
  });

  test('malformed arguments and unreviewed fixture inputs fail before fixture execution', async () => {
    const { library } = await connectors();
    const f = await fixture([library]);
    await install(f, library, 'library-instance', ['central', 'west']);
    const runId = await f.service.admit(
      f.project.id,
      'library-instance',
      ['central'],
      ['list_books'],
    );
    await expect(
      f.service.invoke(runId, 'list_books', { libraryId: 'central', genre: 4 }),
    ).rejects.toThrow(/Arguments/);
    await expect(
      f.service.invoke(runId, 'list_books', { libraryId: 'central', genre: 'history' }),
    ).rejects.toThrow(/reviewed fixture case/);
    expect((await f.host.runs.get(runId)).steps).toHaveLength(0);
  });

  test('exact hashes, declared operations/resources, safe data, and supported schemas are mandatory', async () => {
    const source = await readSpec('library-openapi.json');
    const selection = {
      connectorId: 'library',
      operationIds: ['listBooks'],
      sourceUrl: 'https://fixtures.diomedes.invalid/library-openapi.json',
    } satisfies OpenApiSelection;
    const candidate = generateCandidate(source, selection);
    const baseReview = {
      expectedCandidateDigest: digest(candidate),
      expectedSourceDigest: digest(source),
      license: 'Synthetic fixture; CC0-1.0',
      resources: [{ id: 'central', name: 'Central library' }],
      cases: [
        {
          id: 'central-all-books',
          operationId: 'list_books',
          input: { libraryId: 'central' },
          resources: ['central'],
          result: { libraryId: 'central', books: [] },
        },
      ],
    };
    expect(() =>
      compileReviewedFixtureConnector({
        sourceSpec: source,
        selection,
        candidate,
        review: { ...baseReview, expectedCandidateDigest: '0'.repeat(64) },
      }),
    ).toThrow(/Candidate digest mismatch/);
    expect(() =>
      compileReviewedFixtureConnector({
        sourceSpec: source,
        selection,
        candidate,
        review: {
          ...baseReview,
          cases: [{ ...baseReview.cases[0], operationId: 'undeclared_operation' }],
        },
      }),
    ).toThrow(/undeclared operation/);
    expect(() =>
      compileReviewedFixtureConnector({
        sourceSpec: source,
        selection,
        candidate,
        review: {
          ...baseReview,
          cases: [{ ...baseReview.cases[0], resources: ['unreviewed'] }],
        },
      }),
    ).toThrow(/undeclared resource/);

    const changedCandidate = structuredClone(candidate);
    const changedResultSchema = changedCandidate.operations[0].resultSchema;
    if (
      typeof changedResultSchema !== 'object' ||
      changedResultSchema === null ||
      Array.isArray(changedResultSchema)
    )
      throw new Error('Expected an object result schema.');
    changedCandidate.operations[0].resultSchema = {
      ...changedResultSchema,
      additionalProperties: true,
    } as Json;
    expect(() =>
      compileReviewedFixtureConnector({
        sourceSpec: source,
        selection,
        candidate: changedCandidate,
        review: { ...baseReview, expectedCandidateDigest: digest(changedCandidate) },
      }),
    ).toThrow(/does not match/);

    const unsafeSource = record(structuredClone(source));
    record(unsafeSource['paths'])['x-run'] = () => 'do not execute';
    expect(() =>
      compileReviewedFixtureConnector({
        sourceSpec: unsafeSource,
        selection,
        candidate,
        review: baseReview,
      }),
    ).toThrow(/plain JSON|data only/);

    const callbackSource = record(structuredClone(source));
    const callbackOperation = record(record(record(callbackSource['paths'])['/books'])['get']);
    callbackOperation['callbacks'] = {};
    expect(() =>
      compileReviewedFixtureConnector({
        sourceSpec: callbackSource,
        selection,
        candidate,
        review: { ...baseReview, expectedSourceDigest: digest(callbackSource) },
      }),
    ).toThrow(/callbacks are not supported/);

    const unsupported: Array<[string, (copy: Record<string, unknown>) => void, RegExp]> = [
      ['servers', (copy) => void (copy['servers'] = []), /servers overrides/],
      ['security', (copy) => void (copy['security'] = []), /hidden security/],
      [
        'reference',
        (copy) => {
          const operation = record(record(record(copy['paths'])['/books'])['get']);
          operation['$ref'] = '#/components/pathItems/books';
        },
        /local \$ref/,
      ],
      [
        'path template',
        (copy) => {
          const paths = record(copy['paths']);
          paths['/books/{bookId}'] = paths['/books'];
          delete paths['/books'];
        },
        /path templates/,
      ],
      [
        'write method',
        (copy) => {
          const pathItem = record(record(copy['paths'])['/books']);
          pathItem['post'] = pathItem['get'];
          delete pathItem['get'];
        },
        /Writes refused/,
      ],
    ];
    for (const [, mutate, expected] of unsupported) {
      const changed = record(structuredClone(source));
      mutate(changed);
      expect(() => generateCandidate(changed, selection)).toThrow(expected);
    }
  });
});

describe('host-local official MCP projection', () => {
  async function connect(
    service: ConnectionsService,
    binding: { projectId: string; connectionId: string; runId: string },
  ) {
    const projection = buildConnectionsMcpProjection(service, binding);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await projection.connect(serverTransport);
    const client = new Client(
      { name: 'connections-compiler-test', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await Promise.allSettled([client.close(), projection.close()]);
    });
    return { client, projection };
  }

  function readToolResult(result: unknown) {
    const parsed = z
      .object({
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      })
      .parse(result);
    const block = parsed.content[0];
    if (!block || block.type !== 'text' || block.text === undefined)
      throw new Error('Expected an MCP text result.');
    return record(JSON.parse(block.text));
  }

  test('official client/server roundtrip keeps discovery and calls on current service authority', async () => {
    const { library } = await connectors();
    const f = await fixture([library]);
    await install(f, library, 'library-instance', ['central', 'west']);
    const runId = await f.service.admit(
      f.project.id,
      'library-instance',
      ['central'],
      ['list_books'],
      'library-mcp-run',
    );
    const binding = { projectId: f.project.id, connectionId: 'library-instance', runId };
    const first = await connect(f.service, binding);
    const listed = await first.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['conn_library_list_books']);
    expect(listed.tools[0].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    const initial = await first.client.callTool({
      name: 'conn_library_list_books',
      arguments: { libraryId: 'central' },
    });
    expect(initial.isError).not.toBe(true);
    expect(readToolResult(initial)).toMatchObject({
      result: { libraryId: 'central', books: [{ id: 'book-1' }] },
    });
    const distinct = await first.client.callTool({
      name: 'conn_library_list_books',
      arguments: { libraryId: 'central', genre: 'fiction' },
    });
    expect(distinct.isError).not.toBe(true);
    expect((await f.host.runs.get(runId)).steps).toHaveLength(2);

    const retry = await connect(f.service, binding);
    await retry.client.listTools();
    const cached = await retry.client.callTool({
      name: 'conn_library_list_books',
      arguments: { libraryId: 'central' },
    });
    expect(cached.isError).not.toBe(true);
    expect((await f.host.runs.get(runId)).steps).toHaveLength(2);

    const changed = await connect(f.service, binding);
    await changed.client.listTools();
    const refused = await changed.client.callTool({
      name: 'conn_library_list_books',
      arguments: { libraryId: 'central', genre: 'fiction' },
    });
    expect(refused.isError).toBe(true);
    expect(readToolResult(refused)).toEqual({ error: 'Connection invocation denied.' });
    expect((await f.host.runs.get(runId)).steps).toHaveLength(2);

    const malformed = await first.client.callTool({
      name: 'conn_library_list_books',
      arguments: { libraryId: 3 },
    });
    expect(malformed.isError).toBe(true);
    const spoofed = await first.client.callTool({
      name: 'conn_library_list_books',
      arguments: { libraryId: 'west' },
    });
    expect(spoofed.isError).toBe(true);

    await f.service.control(f.project.id, 'library-instance', 'disconnected');
    await expect(first.client.listTools()).rejects.toThrow(/discovery denied/);
    const afterRevocation = await first.client.callTool({
      name: 'conn_library_list_books',
      arguments: { libraryId: 'central' },
    });
    expect(afterRevocation.isError).toBe(true);
  });

  test('client-supplied run, connection, and resource scope cannot replace the trusted closure', async () => {
    const { library } = await connectors();
    const f = await fixture([library]);
    await install(f, library, 'library-instance', ['central', 'west']);
    const runId = await f.service.admit(
      f.project.id,
      'library-instance',
      ['central'],
      ['list_books'],
    );
    const { client } = await connect(f.service, {
      projectId: f.project.id,
      connectionId: 'library-instance',
      runId,
    });
    const result = await client.callTool({
      name: 'conn_library_list_books',
      arguments: {
        libraryId: 'central',
        runId: 'attacker-run',
        connectionId: 'attacker-connection',
        resources: ['west'],
      },
    });
    expect(result.isError).toBe(true);
    expect((await f.host.runs.get(runId)).steps).toHaveLength(0);
    f.changePrincipal({ identityGeneration: 2 });
    await expect(client.listTools()).rejects.toThrow(/discovery denied/);
  });
});

describe('packaged compiled connection demo catalogue', () => {
  test('lists immutable inactive candidates and requires exact live-authorized activation', async () => {
    const summaries = listCompiledConnectionDemoCandidates();
    expect(summaries.map((item) => item.name)).toEqual(['library', 'helpdesk']);
    expect(summaries.every((item) => item.active === false)).toBe(true);
    expect(new Set(summaries.map((item) => item.sourceDigest)).size).toBe(2);
    expect(new Set(summaries.map((item) => item.reviewDigest)).size).toBe(2);
    expect(compiledConnectionDemoConnectors.every((connector) => Object.isFrozen(connector))).toBe(
      true,
    );
    summaries[0].candidate.allowedOrigins.push('https://mutated.invalid');
    expect(listCompiledConnectionDemoCandidates()[0].candidate.allowedOrigins).toEqual([]);

    const f = await fixture([...compiledConnectionDemoConnectors]);
    await expect(
      activateCompiledConnectionDemo(f.service, {
        name: 'unknown',
        expectedCandidateDigest: summaries[0].candidateDigest,
        projectId: f.project.id,
        tenantId: 'local',
      }),
    ).rejects.toThrow(/unsupported/);
    await expect(
      activateCompiledConnectionDemo(f.service, {
        name: 'library',
        expectedCandidateDigest: '0'.repeat(64),
        projectId: f.project.id,
        tenantId: 'local',
      }),
    ).rejects.toThrow(/exact digest/);
    expect(f.service.snapshot(f.project.id).connections.instances).toHaveLength(0);

    f.changePrincipal({ capabilities: ['connections.read'] });
    await expect(
      activateCompiledConnectionDemo(f.service, {
        name: 'library',
        expectedCandidateDigest: summaries[0].candidateDigest,
        projectId: f.project.id,
        tenantId: 'local',
      }),
    ).rejects.toThrow(/capability|authority/i);
    f.changePrincipal({});
    await expect(
      activateCompiledConnectionDemo(f.service, {
        name: 'library',
        expectedCandidateDigest: summaries[0].candidateDigest,
        projectId: f.project.id,
        tenantId: 'other-tenant',
      }),
    ).rejects.toThrow(/tenant|authority/i);
    const installed = await activateCompiledConnectionDemo(f.service, {
      name: 'library',
      expectedCandidateDigest: summaries[0].candidateDigest,
      projectId: f.project.id,
      tenantId: 'local',
    });
    await f.service.control(f.project.id, installed.id, 'disconnected');
    await expect(
      activateCompiledConnectionDemo(f.service, {
        name: 'library',
        expectedCandidateDigest: summaries[0].candidateDigest,
        projectId: f.project.id,
        tenantId: 'local',
      }),
    ).rejects.toThrow(/already exists/);
    expect((await f.service.status(f.project.id, installed.id)).connection.status).toBe(
      'disconnected',
    );
  });

  test.each(['library', 'helpdesk'] as const)(
    '%s runs an independent official MCP roundtrip and finishes the admitted read',
    async (name: CompiledConnectionDemoName) => {
      const summaries = listCompiledConnectionDemoCandidates();
      const selected = summaries.find((item) => item.name === name);
      if (!selected) throw new Error(`Missing ${name} demo.`);
      const f = await fixture([...compiledConnectionDemoConnectors]);
      const connection = await activateCompiledConnectionDemo(f.service, {
        name,
        expectedCandidateDigest: selected.candidateDigest,
        projectId: f.project.id,
        tenantId: 'local',
      });
      const roundTrip = await runCompiledConnectionDemoRoundTrip(f.service, {
        name,
        projectId: f.project.id,
        connectionId: connection.id,
      });
      expect(roundTrip.tools).toEqual([
        name === 'library' ? 'conn_library_list_books' : 'conn_helpdesk_list_tickets',
      ]);
      expect(roundTrip.result).toHaveProperty('result');
      const run = await f.host.runs.get(roundTrip.runId);
      expect(run.state).toBe('completed');
      expect(run.steps).toHaveLength(1);
      expect(run.steps[0].state).toBe('succeeded');
      expect(run.result).toEqual(roundTrip.result);
    },
  );
});
