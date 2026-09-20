import { describe, expect, test } from 'vitest';
import { buildSupportBundle, renderSupportBundle } from '../server/support-bundle.js';
import type { SupportBundle } from '../server/support-bundle.js';
import { buildIdentity } from '../server/build-identity.js';
import type { IntegrationStatus, ProjectState } from '../shared/types.js';
import type { EngineCandidate, EngineConnection } from '../shared/engines.js';

const NOW = '2026-09-11T00:00:00.000Z';
const TOKEN = 'sk-bundle-secret-abc123';
const HOME = 'C:\\Users\\BundleTest';

const BUILD = buildIdentity({
  version: '0.1.4',
  read: () =>
    JSON.stringify({
      version: '0.1.4',
      baseCommit: 'efa83acd021c5c14fc32a4760e7f7af1d0f53cd6',
      sourceStatus: 'committed',
      signing: 'unsigned-experimental',
      builtAt: '2026-09-19T06:07:40.484Z',
    }),
  execPath: `${HOME}\\AppData\\Local\\Diomedes\\Diomedes.exe`,
  home: HOME,
  packaged: true,
});

function candidate(overrides: Partial<EngineCandidate> = {}): EngineCandidate {
  return {
    id: 'system:opencode:c:/tools/opencode.exe',
    engine: 'opencode',
    source: 'system',
    present: true,
    path: `${HOME}\\tools\\opencode.exe`,
    version: '1.19.0',
    sha256: 'a'.repeat(64),
    integrity: 'verified',
    protocol: 'passed',
    provenance: 'unverified',
    context: 'windows-native',
    compatibility: 'unsupported',
    ...overrides,
  };
}

function connection(overrides: Partial<EngineConnection> = {}): EngineConnection {
  return {
    engine: 'opencode',
    installation: 'found',
    compatibility: 'unsupported',
    authentication: 'signed-in',
    accountRoute: 'opencode:opencode-zen',
    models: [],
    checkedAt: NOW,
    detail: 'The installed version is not the tested one.',
    usage: { state: 'unknown', checkedAt: null },
    ...overrides,
  };
}

function engine(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local',
    found: true,
    available: true,
    enabled: true,
    status: 'ready',
    detail: 'local service answered',
    capabilities: [],
    signIn: 'not-needed',
    adapter: 'ready',
    disclosure: [],
    ...overrides,
  };
}

function state(): ProjectState {
  return {
    project: {
      id: 'proj-1',
      name: 'Test project',
      folder: '/tmp/test',
      createdAt: NOW,
      lastOpenedAt: NOW,
      plans: [],
      references: [],
      repository: { present: false },
      leftOff: null,
      counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
      status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 },
    },
    documents: [],
    tasks: [],
    needs: [],
    sessions: [],
    history: [],
    changes: [],
    conversations: [],
  };
}

describe('support bundle', () => {
  test('a token in an engine detail is scrubbed', () => {
    const bundle = buildSupportBundle({
      version: '1.2.3',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [engine({ detail: `auth failed with ${TOKEN} yesterday` })],
      state: state(),
      recentErrors: [],
      secrets: [TOKEN],
      now: () => NOW,
    });
    expect(bundle.engines[0].status).not.toContain(TOKEN);
    expect(bundle.engines[0].status).toContain('[redacted]');
    expect(renderSupportBundle(bundle)).not.toContain(TOKEN);
  });

  test('the profile directory is replaced with ~', () => {
    const savedProfile = process.env.USERPROFILE;
    const savedHome = process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\BundleTest';
    process.env.HOME = 'C:\\Users\\BundleTest';
    try {
      const bundle = buildSupportBundle({
        version: '1.2.3',
        dataDir: 'C:\\Users\\BundleTest\\Diomedes\\data',
        projectRoot: 'C:\\Users\\BundleTest\\work\\proj',
        port: 5174,
        engines: [],
        state: null,
        recentErrors: [],
        secrets: [],
        now: () => NOW,
      });
      expect(bundle.paths.dataDir).toBe('~\\Diomedes\\data');
      expect(bundle.paths.projectRoot).toBe('~\\work\\proj');
    } finally {
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  test('recentErrors is capped at 20 entries of 500 chars', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `error ${i}: ${'x'.repeat(600)}`);
    const bundle = buildSupportBundle({
      version: '1.2.3',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: null,
      recentErrors: lines,
      secrets: [],
      now: () => NOW,
    });
    expect(bundle.recentErrors).toHaveLength(20);
    for (const line of bundle.recentErrors) expect(line.length).toBeLessThanOrEqual(500);
    expect(bundle.recentErrors[0]).toContain('error 5:');
    expect(bundle.recentErrors[19]).toContain('error 24:');
  });

  test('excluded names environment variables, credentials and document contents', () => {
    const bundle = buildSupportBundle({
      version: '1.2.3',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: null,
      recentErrors: [],
      secrets: [],
      now: () => NOW,
    });
    const joined = bundle.excluded.join('\n').toLowerCase();
    expect(joined).toContain('environment variables');
    expect(joined).toContain('credential');
    expect(joined).toContain('document content');
  });

  test('rendered output contains the version and no raw secret', () => {
    const bundle = buildSupportBundle({
      version: '9.8.7',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [engine({ status: `broken ${TOKEN}` })],
      state: state(),
      recentErrors: [`failed: ${TOKEN}`],
      secrets: [TOKEN],
      now: () => NOW,
    });
    const rendered = renderSupportBundle(bundle);
    expect(rendered).toContain('9.8.7');
    expect(rendered).not.toContain(TOKEN);
  });

  test('project null renders without a project section', () => {
    const bundle = buildSupportBundle({
      version: '1.2.3',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: null,
      recentErrors: [],
      secrets: [],
      now: () => NOW,
    });
    expect(bundle.project).toBeNull();
    const rendered = renderSupportBundle(bundle);
    expect(rendered.split('\n').filter((line) => line.startsWith('project ') && !line.startsWith('project root:'))).toHaveLength(0);
  });
});

describe('the build identity in the bundle', () => {
  test('the app section carries the build and the launch target', () => {
    const bundle = buildSupportBundle({
      version: '0.1.4',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: null,
      recentErrors: [],
      secrets: [],
      build: BUILD,
      now: () => NOW,
    });
    expect(bundle.app.build).toEqual({
      version: '0.1.4',
      commit: 'efa83acd021c5c14fc32a4760e7f7af1d0f53cd6',
      builtAt: '2026-09-19T06:07:40.484Z',
      channel: 'experimental',
      signing: 'unsigned-experimental',
      sourceStatus: 'committed',
      packaged: true,
      source: 'build-record',
      buildId: '0.1.4+efa83acd021c',
    });
    expect(bundle.app.launchTarget).toBe('~\\AppData\\Local\\Diomedes\\Diomedes.exe');
    const rendered = renderSupportBundle(bundle);
    expect(rendered).toContain('build: 0.1.4+efa83acd021c');
    expect(rendered).toContain('source=build-record');
    expect(rendered).toContain('launch target: ~\\AppData\\Local\\Diomedes\\Diomedes.exe');
  });

  test('a bundle told there is no build identity says so rather than staying silent', () => {
    const bundle = buildSupportBundle({
      version: '0.1.4',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: null,
      recentErrors: [],
      secrets: [],
      build: null,
      now: () => NOW,
    });
    expect(bundle.app.build).toBeNull();
    expect(bundle.app.launchTarget).toBeNull();
    expect(renderSupportBundle(bundle)).toContain('build: not recorded');
  });

  test('a caller that says nothing about the build gets the running one', () => {
    const bundle = buildSupportBundle({
      version: '0.1.4',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: null,
      recentErrors: [],
      secrets: [],
      now: () => NOW,
    });
    // This checkout ships no build record, so the honest answer is development.
    expect(bundle.app.build?.source).toBe('development');
    expect(bundle.app.launchTarget).not.toBeNull();
  });
});

describe('the connection facts in the bundle', () => {
  function bundleWith(connections: EngineConnection[], services?: Record<string, unknown>) {
    return buildSupportBundle({
      version: '0.1.4',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: null,
      recentErrors: [],
      secrets: [TOKEN],
      connections,
      services,
      build: BUILD,
      now: () => NOW,
    });
  }

  test('the bound installation, its origin and its provenance are named', () => {
    const bound = candidate({ id: 'managed:opencode:private', source: 'managed', version: '1.18.4', provenance: 'reviewed-release', compatibility: 'supported' });
    const [row] = bundleWith([
      connection({
        candidates: [candidate(), bound],
        binding: {
          id: bound.id,
          engine: 'opencode',
          path: bound.path,
          version: bound.version,
          sha256: bound.sha256,
          source: 'managed',
          boundAt: NOW,
          origin: 'explicit',
        },
      }),
    ]).connections;
    expect(row.candidates).toBe(2);
    expect(row.bound).toBe(true);
    expect(row.bindingOrigin).toBe('explicit');
    expect(row.candidateSource).toBe('managed');
    expect(row.installedVersion).toBe('1.18.4');
    expect(row.provenance).toBe('reviewed-release');
    expect(row.context).toBe('windows-native');
  });

  test('with nothing bound, the recommended candidate is the one described', () => {
    const [row] = bundleWith([
      connection({
        candidates: [candidate()],
        binding: null,
        recommendedCandidateId: 'system:opencode:c:/tools/opencode.exe',
      }),
    ]).connections;
    expect(row.bound).toBe(false);
    expect(row.bindingOrigin).toBeNull();
    expect(row.candidateSource).toBe('system');
    expect(row.installedVersion).toBe('1.19.0');
    expect(row.provenance).toBe('unverified');
  });

  test('the account route, the route issue and the model counts travel as identifiers', () => {
    const [row] = bundleWith(
      [
        connection({
          models: [
            { slug: 'zen/fast', name: 'Fast', description: 'a description', defaultEffort: null, efforts: [] },
            { slug: 'zen/deep', name: 'Deep', description: 'a description', defaultEffort: null, efforts: [] },
          ],
          routeIssue: { required: 'opencode:opencode-go', connected: ['opencode:opencode-zen'] },
        }),
      ],
      { opencodeModel: 'zen/deep', opencode: true },
    ).connections;
    expect(row.accountRoute).toBe('opencode:opencode-zen');
    expect(row.routeIssue).toEqual({
      required: 'opencode:opencode-go',
      connected: ['opencode:opencode-zen'],
    });
    expect(row.models).toBe(2);
    expect(row.selectedModel).toBe('zen/deep');
    const rendered = renderSupportBundle(bundleWith([connection({ models: [{ slug: 'zen/deep', name: 'Deep', description: 'a description', defaultEffort: null, efforts: [] }] })]));
    expect(rendered).not.toContain('a description');
  });

  test('the last failure names its stage, code, correlation id and the facts it recorded', () => {
    const [row] = bundleWith([
      connection({
        revision: 4,
        verification: {
          engine: 'opencode',
          revision: 3,
          candidateId: 'managed:opencode:private',
          version: '1.18.4',
          accountRoute: 'opencode:opencode-go',
          model: 'go/standard',
          runId: 'run-1',
          buildId: '0.1.4+efa83acd021c',
          verifiedAt: '2026-09-10T00:00:00.000Z',
        },
        diagnostic: {
          buildId: '0.1.4+efa83acd021c',
          engine: 'opencode',
          candidateSource: 'system',
          installedVersion: '1.19.0',
          accountRoute: 'opencode:opencode-zen',
          selectedModel: 'zen/deep',
          stage: 'provider-auth',
          code: 'ACCOUNT_ROUTE_UNSUPPORTED',
          correlationId: 'c-9f2a',
          lastVerifiedAt: null,
          at: NOW,
        },
      }),
    ]).connections;
    expect(row.revision).toBe(4);
    expect(row.verifiedRevision).toBe(3);
    expect(row.lastVerifiedAt).toBe('2026-09-10T00:00:00.000Z');
    // A diagnostic is a record of a past failure, so it carries the facts as
    // they were then. The row's own fields say what is true now.
    expect(row.diagnostic).toEqual({
      stage: 'provider-auth',
      code: 'ACCOUNT_ROUTE_UNSUPPORTED',
      correlationId: 'c-9f2a',
      at: NOW,
      buildId: '0.1.4+efa83acd021c',
      candidateSource: 'system',
      installedVersion: '1.19.0',
      accountRoute: 'opencode:opencode-zen',
      selectedModel: 'zen/deep',
      lastVerifiedAt: null,
    });
    expect(renderSupportBundle(bundleWith([connection({ diagnostic: {
      buildId: 'x', engine: 'opencode', candidateSource: null, installedVersion: null,
      accountRoute: null, selectedModel: null, stage: 'local-handshake', code: 'HANDSHAKE_TIMEOUT',
      correlationId: 'c-1', lastVerifiedAt: null, at: NOW,
    } })]))).toContain('diagnostic opencode: stage=local-handshake code=HANDSHAKE_TIMEOUT');
  });

  test('the recorded facts of a failure are rendered as recorded, beside the stage', () => {
    const rendered = renderSupportBundle(
      bundleWith([
        connection({
          accountRoute: 'opencode:opencode-go',
          diagnostic: {
            buildId: '0.1.3+ffffffffffff',
            engine: 'opencode',
            candidateSource: 'system',
            installedVersion: '1.19.0',
            accountRoute: 'opencode:opencode-zen',
            selectedModel: 'zen/deep',
            stage: 'provider-auth',
            code: 'ACCOUNT_ROUTE_UNSUPPORTED',
            correlationId: 'c-9f2a',
            lastVerifiedAt: '2026-09-10T00:00:00.000Z',
            at: NOW,
          },
        }),
      ]),
    );
    const line = rendered.split('\n').find((row) => row.startsWith('diagnostic opencode:'))!;
    expect(line).toContain('stage=provider-auth code=ACCOUNT_ROUTE_UNSUPPORTED');
    // The reader must not read a past fact as a current one.
    expect(line).toContain('recorded then:');
    expect(line).toContain('build=0.1.3+ffffffffffff');
    expect(line).toContain('version=1.19.0');
    expect(line).toContain('account route=opencode:opencode-zen');
    expect(line).toContain('model=zen/deep');
  });

  test('a corrupt installation reports no version, because the failure refused to state one', () => {
    // server/engines/service.ts sets `installedVersion: null` on the diagnostic
    // of a candidate that failed its digest: no version is trusted there. The
    // remembered binding still holds the version from before, and printing that
    // would state what the diagnostic refused to.
    const [row] = bundleWith([
      connection({
        installation: 'corrupt',
        repair: 'selected-unverified',
        binding: {
          id: 'managed:opencode:private',
          engine: 'opencode',
          path: `${HOME}\\tools\\opencode.exe`,
          version: '1.18.4',
          sha256: 'a'.repeat(64),
          source: 'managed',
          boundAt: NOW,
          origin: 'explicit',
        },
        diagnostic: {
          buildId: '0.1.4+efa83acd021c',
          engine: 'opencode',
          candidateSource: 'managed',
          installedVersion: null,
          accountRoute: null,
          selectedModel: null,
          stage: 'runtime-verification',
          code: 'INSTALL_CHECKSUM',
          correlationId: 'c-1',
          lastVerifiedAt: null,
          at: NOW,
        },
      }),
    ]).connections;
    expect(row.installedVersion).toBeNull();
  });

  test('a hostile connection cannot smuggle a field, a path or a secret into the bundle', () => {
    const hostile = {
      engine: 'opencode',
      installation: 'found',
      compatibility: 'unsupported',
      authentication: 'signed-in',
      accountRoute: `opencode:zen ${TOKEN}`,
      models: 'lots',
      checkedAt: NOW,
      detail: 'x',
      usage: { state: 'unknown', checkedAt: null },
      candidates: 'not an array',
      binding: 'not an object',
      revision: 1e400,
      location: `${HOME}\\tools\\opencode.exe`,
      verification: { verifiedAt: 'whenever', revision: -3 },
      routeIssue: {
        required: 'r'.repeat(400),
        connected: Array.from({ length: 40 }, (_, i) => `provider-${'p'.repeat(200)}-${String(i)}`),
      },
      diagnostic: {
        stage: 'exfiltrate',
        code: `${HOME}\\secrets ${'y'.repeat(500)}`,
        correlationId: { toString: () => TOKEN },
        at: NOW,
        prompt: 'the user asked about their salary',
      },
      teamSecret: TOKEN,
    } as unknown as EngineConnection;
    const bundle = bundleWith([hostile]);
    const [row] = bundle.connections;
    const serialised = JSON.stringify(bundle);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('teamSecret');
    expect(serialised).not.toContain('the user asked');
    expect(serialised).not.toContain('opencode.exe');
    expect(serialised).not.toContain('BundleTest');
    expect(row.candidates).toBe(0);
    expect(row.bound).toBe(false);
    expect(row.models).toBe(0);
    expect(row.revision).toBeNull();
    expect(row.verifiedRevision).toBeNull();
    expect(row.lastVerifiedAt).toBeNull();
    expect(row.accountRoute).toBe('opencode:zen [redacted]');
    expect(row.routeIssue?.required.length).toBeLessThanOrEqual(120);
    expect(row.routeIssue?.connected).toHaveLength(10);
    for (const id of row.routeIssue?.connected ?? []) expect(id.length).toBeLessThanOrEqual(80);
    expect(row.diagnostic?.stage).toBeNull();
    expect(row.diagnostic?.correlationId).toBeNull();
    expect(String(row.diagnostic?.code)).toHaveLength(80);
    expect(renderSupportBundle(bundle)).not.toContain(TOKEN);
  });

  test('the connection list is capped like every other list here', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      connection({ accountRoute: `route-${String(i)}` }),
    );
    expect(bundleWith(many).connections).toHaveLength(20);
  });
});

describe('the project name is a choice', () => {
  function bundleFor(includeProjectName?: boolean) {
    return buildSupportBundle({
      version: '0.1.4',
      dataDir: '/tmp/data',
      projectRoot: '/tmp/proj',
      port: 5174,
      engines: [],
      state: state(),
      recentErrors: [],
      secrets: [],
      includeProjectName,
      now: () => NOW,
    });
  }

  test('by default the project is counts and an opaque id', () => {
    const bundle = bundleFor();
    expect(bundle.project?.name).toBeUndefined();
    expect(bundle.project?.id).toBe('proj-1');
    expect(bundle.project?.tasks).toBe(0);
    const rendered = renderSupportBundle(bundle);
    expect(rendered).not.toContain('Test project');
    expect(rendered).toContain('project proj-1:');
    expect(bundle.excluded).toContain('The project name is not included.');
  });

  test('asked for, the name is present and the bundle stops claiming it is absent', () => {
    const bundle = bundleFor(true);
    expect(bundle.project?.name).toBe('Test project');
    expect(renderSupportBundle(bundle)).toContain('Test project');
    expect(bundle.excluded).not.toContain('The project name is not included.');
  });

  test('the excluded sentences name the engine paths and account details left out', () => {
    const joined = bundleFor().excluded.join('\n').toLowerCase();
    expect(joined).toContain('executable path');
    expect(joined).toContain('account name');
  });
});

describe('the support bundle route', () => {
  test('answers without a project, and the text names what it excludes', async () => {
    const { createApp } = await import('../server/app.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-support-'));
    const app = await createApp({
      dataDir: path.join(temp, 'data'),
      projectRoot: path.join(temp, 'projects'),
      stepMs: 20,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/support/bundle?project=missing`);
      expect(response.status).toBe(200);
      const { bundle, text } = (await response.json()) as { bundle: SupportBundle; text: string };
      expect(bundle.project).toBeNull();
      expect(text).toContain(`Diomedes ${bundle.app.version}`);
      expect(text).toContain('not included: Environment variables are not collected');
      // The preview a person reads and the text they paste are one string.
      expect(text).toBe(renderSupportBundle(bundle));
      expect(text).toContain('launch target: ');
    } finally {
      await app.locals.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
