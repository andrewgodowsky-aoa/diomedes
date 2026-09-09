import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import helpdeskSourceImport from '../../fixtures/connections/helpdesk-openapi.json' with { type: 'json' };
import librarySourceImport from '../../fixtures/connections/library-openapi.json' with { type: 'json' };
import type { Json } from '../../shared/harness.js';
import { connectionSchema, type ConnectorManifest } from '../../shared/connections.js';
import { digest } from '../harness/policy.js';
import {
  compileReviewedFixtureConnector,
  type CompiledFixtureConnector,
  type FixtureCompilationReview,
  type OpenApiSelection,
} from './compiled-fixture.js';
import { buildConnectionsMcpProjection } from './mcp-projection.js';
import { generateCandidate } from './openapi-candidate.js';
import type { ConnectionsService } from './service.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const activationSchema = z.strictObject({
  name: z.string().min(1).max(40),
  expectedCandidateDigest: hashSchema,
  projectId: z.string().min(1),
  tenantId: z.string().min(1),
});
const roundTripSchema = z.strictObject({
  name: z.string().min(1).max(40),
  projectId: z.string().min(1),
  connectionId: z.string().min(1),
});

export type CompiledConnectionDemoName = 'library' | 'helpdesk';
export type ActivateCompiledConnectionDemoInput = z.infer<typeof activationSchema>;
export type RunCompiledConnectionDemoInput = z.infer<typeof roundTripSchema>;
type JsonObject = Record<string, Json>;

interface DemoDefinition {
  readonly name: CompiledConnectionDemoName;
  readonly label: string;
  readonly sourceDigest: string;
  readonly candidateDigest: string;
  readonly reviewDigest: string;
  readonly candidate: ConnectorManifest;
  readonly connector: CompiledFixtureConnector;
  readonly resources: readonly { id: string; name: string }[];
  readonly firstExampleArguments: JsonObject;
}

export interface CompiledConnectionDemoSummary {
  name: CompiledConnectionDemoName;
  label: string;
  active: false;
  sourceDigest: string;
  candidateDigest: string;
  reviewDigest: string;
  candidate: ConnectorManifest;
  resources: Array<{ id: string; name: string }>;
  firstExampleArguments: JsonObject;
}

function fail(message: string): never {
  throw new Error(message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableJson(value: unknown): Json {
  return deepFreeze(z.json().parse(structuredClone(value)));
}

function immutableJsonObject(value: unknown): JsonObject {
  const parsed = immutableJson(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    fail('Demo arguments must be a JSON object.');
  return parsed;
}

function buildDemo(input: {
  name: CompiledConnectionDemoName;
  label: string;
  sourceImport: unknown;
  selection: OpenApiSelection;
  license: string;
  resources: Array<{ id: string; name: string }>;
  cases: FixtureCompilationReview['cases'];
  firstExampleArguments: JsonObject;
}): DemoDefinition {
  const source = immutableJson(input.sourceImport);
  const candidate = deepFreeze(generateCandidate(source, input.selection));
  const review = deepFreeze({
    expectedCandidateDigest: digest(candidate),
    expectedSourceDigest: digest(source),
    license: input.license,
    resources: structuredClone(input.resources),
    cases: structuredClone(input.cases),
  });
  const connector = compileReviewedFixtureConnector({
    sourceSpec: source,
    selection: input.selection,
    candidate,
    review,
  });
  const firstExampleArguments = immutableJsonObject(input.firstExampleArguments);
  if (!connector.operations[0].input.safeParse(firstExampleArguments).success)
    fail('The first demo arguments do not match the compiled operation schema.');
  connector.operations[0].resources(firstExampleArguments);
  return Object.freeze({
    name: input.name,
    label: input.label,
    sourceDigest: connector.compilation.sourceDigest,
    candidateDigest: connector.compilation.candidateDigest,
    reviewDigest: digest(review),
    candidate,
    connector,
    resources: deepFreeze(structuredClone(input.resources)),
    firstExampleArguments,
  });
}

const library = buildDemo({
  name: 'library',
  label: 'Library catalogue / synthetic fixture',
  sourceImport: librarySourceImport,
  selection: {
    connectorId: 'library',
    operationIds: ['listBooks'],
    sourceUrl: 'https://fixtures.diomedes.invalid/library-openapi.json',
  },
  license: 'Synthetic fixture; CC0-1.0',
  resources: [
    { id: 'central', name: 'Central library' },
    { id: 'west', name: 'West library' },
  ],
  cases: [
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
  firstExampleArguments: { libraryId: 'central' },
});

const helpdesk = buildDemo({
  name: 'helpdesk',
  label: 'Helpdesk tickets / synthetic fixture',
  sourceImport: helpdeskSourceImport,
  selection: {
    connectorId: 'helpdesk',
    operationIds: ['listTickets'],
    sourceUrl: 'https://fixtures.diomedes.invalid/helpdesk-openapi.json',
  },
  license: 'Synthetic fixture; CC0-1.0',
  resources: [
    { id: 'support', name: 'Support queue' },
    { id: 'billing', name: 'Billing queue' },
  ],
  cases: [
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
  firstExampleArguments: { queueId: 'support', state: 'open' },
});

const demos: Readonly<Record<CompiledConnectionDemoName, DemoDefinition>> = Object.freeze({
  library,
  helpdesk,
});

/** Register these host-reviewed connectors in the one existing ConnectionsService constructor. */
export const compiledConnectionDemoConnectors: readonly CompiledFixtureConnector[] = Object.freeze([
  library.connector,
  helpdesk.connector,
]);

function demo(name: string): DemoDefinition {
  if (name !== 'library' && name !== 'helpdesk')
    fail('That compiled connection demo is unsupported.');
  return demos[name];
}

/** Return inactive review previews. Callers receive copies and no activation authority. */
export function listCompiledConnectionDemoCandidates(): CompiledConnectionDemoSummary[] {
  return Object.values(demos).map((item) => ({
    name: item.name,
    label: item.label,
    active: false,
    sourceDigest: item.sourceDigest,
    candidateDigest: item.candidateDigest,
    reviewDigest: item.reviewDigest,
    candidate: structuredClone(item.candidate),
    resources: item.resources.map((resource) => ({ ...resource })),
    firstExampleArguments: structuredClone(item.firstExampleArguments),
  }));
}

export function compiledConnectionDemoId(
  projectId: string,
  tenantId: string,
  name: CompiledConnectionDemoName,
): string {
  return `${name}-${digest({ projectId, tenantId, name }).slice(0, 20)}`;
}

/**
 * Install one exact reviewed demo into an existing service. The service performs
 * the live current-principal/manage check. Existing instances are refused and
 * never resumed or reauthorized by this helper.
 */
export async function activateCompiledConnectionDemo(
  service: ConnectionsService,
  rawInput: ActivateCompiledConnectionDemoInput,
) {
  const input = activationSchema.parse(rawInput);
  const selected = demo(input.name);
  if (input.expectedCandidateDigest !== selected.candidateDigest)
    fail('The compiled candidate changed; review its exact digest again.');
  const connectionId = compiledConnectionDemoId(input.projectId, input.tenantId, selected.name);
  if (
    service
      .snapshot(input.projectId)
      .connections.instances.some((connection) => connection.id === connectionId)
  )
    fail('This demo connection already exists; use an explicit connection control to change it.');
  const connection = connectionSchema.parse({
    id: connectionId,
    connectorId: selected.connector.manifest.id,
    version: selected.connector.manifest.version,
    manifestDigest: digest(selected.connector.manifest),
    tenantId: input.tenantId,
    projectId: input.projectId,
    name: selected.label,
    resources: selected.resources,
    vendorScopes: [],
    operations: selected.connector.manifest.operations.map((operation) => operation.id),
    mode: 'fixture',
    status: 'connected',
    generation: 1,
    staleAfterMs: 300_000,
    lastEventAt: null,
    lastReconciledAt: null,
    problem: null,
  });
  return service.install(input.projectId, connection);
}

/** Run one official SDK in-memory MCP discovery/call and finish that same read run. */
export async function runCompiledConnectionDemoRoundTrip(
  service: ConnectionsService,
  rawInput: RunCompiledConnectionDemoInput,
) {
  const input = roundTripSchema.parse(rawInput);
  const selected = demo(input.name);
  const connection = service
    .snapshot(input.projectId)
    .connections.instances.find((item) => item.id === input.connectionId);
  if (
    !connection ||
    connection.connectorId !== selected.connector.manifest.id ||
    connection.version !== selected.connector.manifest.version ||
    connection.manifestDigest !== digest(selected.connector.manifest) ||
    connection.status !== 'connected'
  )
    fail('The installed demo connection does not match the reviewed active connector.');
  const resources = selected.resources.map((resource) => resource.id);
  const operations = selected.connector.manifest.operations.map((operation) => operation.id);
  const runId = await service.admit(input.projectId, input.connectionId, resources, operations);
  const projection = buildConnectionsMcpProjection(service, {
    projectId: input.projectId,
    connectionId: input.connectionId,
    runId,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'diomedes-compiled-demo', version: '0.1.0' },
    { capabilities: {} },
  );
  try {
    await projection.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    if (listed.tools.length !== operations.length)
      fail('MCP discovery did not match the admitted operation set.');
    const operation = selected.connector.manifest.operations[0];
    const name = service.toolName(selected.connector.manifest.id, operation.id);
    if (!listed.tools.some((tool) => tool.name === name))
      fail('MCP discovery omitted the admitted demo operation.');
    const response = await client.callTool({
      name,
      arguments: structuredClone(selected.firstExampleArguments),
    });
    if (response.isError) fail('The MCP demo invocation was denied.');
    const content = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(response.content);
    const first = content[0];
    if (!first || first.type !== 'text' || first.text === undefined)
      fail('The MCP demo did not return its JSON result as text.');
    const result = z.json().parse(JSON.parse(first.text));
    await service.finishRead(runId, result);
    return {
      runId,
      tools: listed.tools.map((tool) => tool.name),
      result,
    };
  } finally {
    try {
      await client.close();
    } finally {
      await projection.close();
    }
  }
}
