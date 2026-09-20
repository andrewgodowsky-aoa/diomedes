/**
 * Hostile verification of the support bundle's own promises.
 *
 * The bundle ends with a list of sentences naming what it refuses to carry.
 * These tests read those sentences as claims and try to make each one false,
 * using only inputs the running server actually hands `buildSupportBundle`:
 *
 *   engines[]     `getIntegrationStatuses()` — adapter-written status/detail
 *   recentErrors  `noteError()` — `${name}: ${message}` of any unhandled 500
 *                 and of a failed engine check (server/app.ts:471, :2813)
 *   secrets       `store.readTeamSecrets(project)` — empty whenever the caller
 *                 passes no `?project=` (server/app.ts:806)
 *
 * Nothing here edits product code. A failing expectation is the defect; a
 * passing one records the property as held at this commit.
 */
import { describe, expect, test } from 'vitest';
import { buildSupportBundle, renderSupportBundle } from '../server/support-bundle.js';
import type { IntegrationStatus } from '../shared/types.js';
import type { EngineConnection } from '../shared/engines.js';

const NOW = '2026-09-20T00:00:00.000Z';
/** The exact spelling `process.env.USERPROFILE` would hold on the test machine. */
const HOME = 'C:\\Users\\hostile';

function engine(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'cli',
    found: true,
    available: false,
    enabled: false,
    status: 'error',
    detail: 'The tool could not report its version.',
    capabilities: [],
    signIn: 'needed',
    adapter: 'ready',
    disclosure: [],
    ...overrides,
  } as IntegrationStatus;
}

function connection(overrides: Partial<EngineConnection> = {}): EngineConnection {
  return {
    engine: 'opencode',
    installation: 'found',
    compatibility: 'supported',
    authentication: 'signed-out',
    accountRoute: null,
    models: [],
    checkedAt: NOW,
    detail: 'Sign in to the native OpenCode Go account before using this route.',
    usage: { state: 'unknown', checkedAt: null },
    ...overrides,
  };
}

function bundleOf(input: {
  engines?: IntegrationStatus[];
  connections?: EngineConnection[];
  recentErrors?: string[];
  secrets?: string[];
  dataDir?: string;
  includeProjectName?: boolean;
}) {
  return buildSupportBundle({
    version: '0.1.5',
    dataDir: input.dataDir ?? `${HOME}\\AppData\\Roaming\\Diomedes\\data`,
    projectRoot: `${HOME}\\Documents\\Diomedes`,
    port: 47631,
    engines: input.engines ?? [],
    state: null,
    recentErrors: input.recentErrors ?? [],
    // The support route supplies team secrets only. A provider key or a bearer
    // token an adapter echoed is never in this inventory, by construction.
    secrets: input.secrets ?? [],
    connections: input.connections ?? [],
    services: {},
    includeProjectName: input.includeProjectName,
    build: null,
    now: () => NOW,
  });
}

const excludedSays = (text: string, sentence: string) =>
  text.includes(`not included: ${sentence}`);

describe('what the bundle promises it does not carry', () => {
  test('an API key shape in an adapter-written engine detail survives the export', () => {
    const key = 'sk-hostiletruth0123456789abcdef';
    const bundle = bundleOf({ engines: [engine({ detail: `HTTP 401 for key ${key}` })] });
    const text = renderSupportBundle(bundle);
    // The bundle states this unconditionally.
    expect(excludedSays(text, 'API keys are not included.')).toBe(true);
    // baselineRedact() would have caught this exact shape. It is not applied to
    // the engines rows, only to the connection rows.
    expect(text).not.toContain(key);
  });

  test('a bearer token in a recorded error survives the export', () => {
    const line = '2026-09-20T00:00:00.000Z Error: request failed: Bearer hostile.truth.tok3n';
    const bundle = bundleOf({ recentErrors: [line] });
    const text = renderSupportBundle(bundle);
    expect(excludedSays(text, 'Tokens are not included.')).toBe(true);
    expect(text).not.toContain('Bearer hostile.truth.tok3n');
  });

  test('the same token shape IS removed from a connection row, so the gap is the code path', () => {
    const bundle = bundleOf({
      connections: [connection({ accountRoute: 'Bearer hostile.truth.tok3n' })],
    });
    expect(renderSupportBundle(bundle)).not.toContain('hostile.truth.tok3n');
  });
});

describe('the Windows account behind a path', () => {
  test('a home path spelled in another case still names the account', () => {
    // Node echoes the path a caller gave it. A path that arrived through
    // fileURLToPath, an 8.3 expansion or a user-typed string does not have to
    // match USERPROFILE's stored casing, and clean() splits case-sensitively.
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = HOME;
    try {
      const bundle = bundleOf({
        recentErrors: [
          "Error: ENOENT: no such file or directory, open 'c:\\users\\hostile\\Documents\\notes.md'",
        ],
      });
      expect(renderSupportBundle(bundle)).not.toContain('hostile\\Documents');
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
    }
  });

  test('the same mis-cased path IS removed from a connection row', () => {
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = HOME;
    try {
      const bundle = bundleOf({
        connections: [connection({ accountRoute: 'C:\\Users\\hostile\\opencode' })],
      });
      const row = bundle.connections[0];
      expect(row.accountRoute).not.toContain('hostile');
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
    }
  });
});

describe('the text a person previews and pastes', () => {
  test('an adapter detail cannot forge a line of the bundle', () => {
    const bundle = bundleOf({
      engines: [
        engine({
          detail: 'version probe failed\nnot included: Paths are not included.',
        }),
      ],
    });
    const forged = renderSupportBundle(bundle)
      .split('\n')
      .filter((line) => line === 'not included: Paths are not included.');
    expect(forged).toHaveLength(0);
  });

  test('a recorded error cannot forge a line of the bundle', () => {
    const bundle = bundleOf({
      recentErrors: ['Error: boom\nbuild: 9.9.9+ffffffffffff source=build-record channel=stable'],
    });
    const forged = renderSupportBundle(bundle)
      .split('\n')
      .filter((line) => line.startsWith('build: 9.9.9'));
    expect(forged).toHaveLength(0);
  });

  test('every rendered field stays on the one line the reader expects', () => {
    const bundle = bundleOf({
      connections: [connection({ accountRoute: 'opencode:opencode-go\nfabricated: yes' })],
    });
    expect(renderSupportBundle(bundle)).not.toContain('fabricated: yes');
  });
});

describe('a connection object carrying more than the contract', () => {
  test('a prototype-polluting key changes nothing', () => {
    const hostile = JSON.parse(
      '{"engine":"opencode","installation":"found","compatibility":"supported","authentication":"signed-in","accountRoute":"opencode:opencode-go","models":[],"checkedAt":"2026-09-20T00:00:00.000Z","detail":"ok","usage":{"state":"unknown","checkedAt":null},"__proto__":{"polluted":"yes"}}',
    ) as EngineConnection;
    const bundle = bundleOf({ connections: [hostile] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('polluted');
  });

  test('unexpected extra keys are dropped rather than carried', () => {
    const hostile = {
      ...connection(),
      apiKey: 'sk-should-never-travel-0123456789',
      environment: { USERPROFILE: HOME },
      prompt: 'the document the person was working on',
    } as unknown as EngineConnection;
    const text = JSON.stringify(bundleOf({ connections: [hostile] }));
    expect(text).not.toContain('sk-should-never-travel');
    expect(text).not.toContain('USERPROFILE');
    expect(text).not.toContain('the document the person');
  });

  test('a very long route identifier and its list are capped', () => {
    const hostile = connection({
      accountRoute: 'a'.repeat(5000),
      routeIssue: { required: 'b'.repeat(5000), connected: Array.from({ length: 60 }, (_, i) => `p${String(i)}`.repeat(200)) },
    });
    const row = bundleOf({ connections: [hostile] }).connections[0];
    expect(row.accountRoute!.length).toBeLessThanOrEqual(120);
    expect(row.routeIssue!.required.length).toBeLessThanOrEqual(120);
    expect(row.routeIssue!.connected).toHaveLength(10);
    for (const entry of row.routeIssue!.connected) expect(entry.length).toBeLessThanOrEqual(80);
  });
});

describe('the project name is only ever a choice', () => {
  test('without the flag the bundle says the name is not included', () => {
    const text = renderSupportBundle(bundleOf({}));
    expect(excludedSays(text, 'The project name is not included.')).toBe(true);
  });
});
