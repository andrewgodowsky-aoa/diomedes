import { describe, expect, test } from 'vitest';
import { buildSupportBundle, renderSupportBundle } from '../server/support-bundle.js';
import type { IntegrationStatus, ProjectState } from '../shared/types.js';

const NOW = '2026-09-11T00:00:00.000Z';
const TOKEN = 'sk-bundle-secret-abc123';

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
      const { bundle, text } = (await response.json()) as { bundle: { project: unknown; app: { version: string } }; text: string };
      expect(bundle.project).toBeNull();
      expect(text).toContain(`Diomedes ${bundle.app.version}`);
      expect(text).toContain('not included: Environment variables are not included.');
    } finally {
      await app.locals.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
