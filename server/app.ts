import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  Conversation,
  Owner,
  Page,
  Session,
  Settings,
  TaskState,
  ThreadPermission,
  Turn,
  TeamMember,
} from '../shared/types.js';
import { ApiError, absent, relativeName, safeAbsolute } from './paths.js';
import { defaults, findTasks, hash, identifier, now, Store, threadNameFromText } from './store.js';
import { WorkService } from './work.js';
import { NativeWorkService, type NativeGenerator } from './native-work.js';
import { askCodex, getIntegrationStatuses, type NativeTeamOptions } from './integrations.js';
import { fakeCodexSnapshot, usageService } from './usage.js';
import { engineCatalog, isKnownChoice } from './models.js';
import type { UsageSnapshot } from '../shared/types.js';
import { mountTeamRoutes } from './team/routes.js';
import { roleInstructions } from './team/prompts.js';

interface AppOptions {
  dataDir: string;
  projectRoot?: string;
  stepMs?: number;
  port?: number;
  clientPort?: number;
  nativeGenerator?: NativeGenerator;
}
const pages: Page[] = ['home', 'ask', 'plan', 'work', 'review', 'tasks', 'documents', 'history'];
const owners: Owner[] = ['you', 'diomedes', 'diomedes-with-ok'];
const states: TaskState[] = ['todo', 'working', 'waiting', 'done'];
const asString = (value: unknown, name: string, max = 10000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ApiError(400, `Provide ${name} of up to ${max} characters.`);
  return value;
};
function taskNameFromText(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine;
  const shortened = firstLine.slice(0, 80);
  if (/\s/.test(firstLine[80])) return shortened.trimEnd();
  const boundary = shortened.search(/\s+\S*$/);
  return (boundary > 0 ? shortened.slice(0, boundary) : shortened).trimEnd();
}
const choice = <const T extends string>(value: unknown, values: readonly T[], name: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new ApiError(400, `Choose a valid ${name}.`);
  return value as T;
};
const THREAD_PERMISSIONS: readonly ThreadPermission[] = ['show-first', 'task'];
const PERMISSION_UNAVAILABLE = 'That permission mode is not available in this version.';
function parseThreadPermission(value: unknown): ThreadPermission {
  if (typeof value !== 'string' || !THREAD_PERMISSIONS.includes(value as ThreadPermission))
    throw new ApiError(400, PERMISSION_UNAVAILABLE);
  return value as ThreadPermission;
}
/**
 * A thread's helper choice. Null clears it, so the thread follows the saved
 * default again. The pair is checked against the engine's own list, which keeps
 * a choice that has since been withdrawn from reaching `thread/start`.
 */
function parseRequested(value: unknown): Conversation['requested'] {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Provide a helper choice, or null to use the default.');
  const v = value as Record<string, unknown>;
  const model = v.model === null || v.model === undefined ? null : v.model;
  const effort = v.effort === null || v.effort === undefined ? null : v.effort;
  if (model === null) return null;
  if (typeof model !== 'string' || !model.trim() || model.length > 120)
    throw new ApiError(400, 'That is not a helper choice.');
  if (effort !== null && (typeof effort !== 'string' || !effort.trim() || effort.length > 40))
    throw new ApiError(400, 'That is not a reasoning level.');
  const chosen = { model: model.trim(), effort: effort === null ? null : String(effort).trim() };
  if (!isKnownChoice('codex', chosen.model, chosen.effort))
    throw new ApiError(400, 'That helper choice is not one this computer offers.');
  return chosen;
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Provide an object.');
  return value as Record<string, unknown>;
}

function validateSettings(current: Settings, body: unknown): Settings {
  const supplied = plain(body);
  const result = structuredClone(current);
  for (const key of Object.keys(supplied))
    if (!Object.hasOwn(defaults(), key)) throw new ApiError(400, `Unknown setting: ${key}`);
  if (supplied.version !== undefined && supplied.version !== 1)
    throw new ApiError(400, 'This settings version is unsupported.');
  if (supplied.detail !== undefined)
    result.detail = choice(supplied.detail, ['guided', 'standard', 'technical'], 'detail level');
  if (supplied.surface !== undefined)
    result.surface = choice(supplied.surface, ['book', 'desk'], 'surface');
  if (supplied.explanations !== undefined)
    result.explanations = choice(
      supplied.explanations,
      ['persistent', 'once', 'off'],
      'explanations setting',
    );
  if (supplied.permissions) {
    const value = plain(supplied.permissions);
    for (const key of Object.keys(result.permissions) as (keyof Settings['permissions'])[]) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== 'boolean')
          throw new ApiError(400, 'Permissions must be true or false.');
        result.permissions[key] = value[key];
      }
    }
  }
  if (supplied.onboarding) {
    const value = plain(supplied.onboarding);
    if (value.work !== undefined)
      result.onboarding.work =
        value.work === null
          ? null
          : choice(value.work, ['business', 'school', 'software', 'personal', 'mix'], 'work type');
    if (value.detail !== undefined)
      result.onboarding.detail =
        value.detail === null
          ? null
          : choice(value.detail, ['guided', 'standard', 'technical'], 'detail level');
    if (value.familiarity !== undefined)
      result.onboarding.familiarity =
        value.familiarity === null
          ? null
          : choice(value.familiarity, ['new', 'some', 'comfortable'], 'familiarity');
    if (value.resumeAt !== undefined)
      result.onboarding.resumeAt = choice(
        value.resumeAt,
        ['welcome', 'q1', 'q2', 'q3', 'ready', 'done'],
        'setup step',
      );
    if (value.completedAt !== undefined) {
      if (
        value.completedAt !== null &&
        (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt)))
      )
        throw new ApiError(400, 'Provide a valid completion time.');
      result.onboarding.completedAt = value.completedAt;
    }
  }
  if (supplied.appearance) {
    const value = plain(supplied.appearance);
    if (value.package !== undefined)
      result.appearance.package = choice(
        value.package,
        ['deep-field', 'cobalt', 'graphite', 'verdigris', 'paper'],
        'appearance package',
      );
    if (value.motion !== undefined)
      result.appearance.motion = choice(value.motion, ['normal', 'reduced'], 'motion setting');
    for (const key of ['interfaceScale', 'readingScale', 'codeScale'] as const)
      if (value[key] !== undefined) {
        const n = value[key];
        if (typeof n !== 'number' || n < 0.75 || n > 2)
          throw new ApiError(400, 'Text scale must be between 0.75 and 2.');
        result.appearance[key] = n;
      }
  }
  if (supplied.history) {
    const value = plain(supplied.history);
    for (const key of ['keepDays', 'maxBytesPerProject'] as const)
      if (value[key] !== undefined) {
        const n = value[key];
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
          throw new ApiError(400, 'History settings must be positive whole numbers.');
        result.history[key] = n;
      }
  }
  if (supplied.services) {
    const value = plain(supplied.services);
    const services: Record<string, boolean | string> = {};
    for (const [key, on] of Object.entries(value)) {
      // The Codex selection is a name, not a switch; it only ever reaches
      // `thread/start` config, never the answer text.
      if (key === 'codexModel' || key === 'codexEffort') {
        if (typeof on !== 'string' || !on.trim() || on.length > 120)
          throw new ApiError(400, 'The Codex helper choice must be up to 120 characters.');
        services[key] = on.trim();
        continue;
      }
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || typeof on !== 'boolean')
        throw new ApiError(400, 'A helper setting must be true or false.');
      services[key] = on;
    }
    result.services = services as Settings['services'];
  }
  if (supplied.openProjects) {
    if (
      !Array.isArray(supplied.openProjects) ||
      supplied.openProjects.some((id) => typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id))
    )
      throw new ApiError(400, 'Provide valid project identifiers.');
    result.openProjects = supplied.openProjects;
  }
  if (supplied.lastPage) {
    const value = plain(supplied.lastPage);
    result.lastPage = {};
    for (const [key, page] of Object.entries(value)) {
      if (!/^[a-f0-9]{12}$/.test(key)) throw new ApiError(400, 'Invalid project identifier.');
      result.lastPage[key] = choice(page, pages, 'page');
    }
  }
  if (supplied.tasksView) {
    const value = plain(supplied.tasksView);
    result.tasksView = {};
    for (const [key, view] of Object.entries(value)) {
      if (!/^[a-f0-9]{12}$/.test(key)) throw new ApiError(400, 'Invalid project identifier.');
      result.tasksView[key] = choice(view, ['board', 'list'], 'tasks view');
    }
  }
  if (supplied.seen) {
    const value = plain(supplied.seen);
    if (value.onlineServiceNotice !== undefined) {
      if (typeof value.onlineServiceNotice !== 'boolean')
        throw new ApiError(400, 'The notice setting must be true or false.');
      result.seen.onlineServiceNotice = value.onlineServiceNotice;
    }
    if (value.firstUse !== undefined) {
      if (
        !Array.isArray(value.firstUse) ||
        value.firstUse.some((item) => typeof item !== 'string' || item.length > 100)
      )
        throw new ApiError(400, 'Invalid first-use settings.');
      result.seen.firstUse = value.firstUse;
    }
    if (value.guidedDescriptors !== undefined) {
      const entries = plain(value.guidedDescriptors);
      result.seen.guidedDescriptors = {};
      for (const [key, count] of Object.entries(entries)) {
        if (
          !pages.includes(key as Page) ||
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0
        )
          throw new ApiError(400, 'Invalid guided descriptor settings.');
        result.seen.guidedDescriptors[key] = count;
      }
    }
  }
  return result;
}

export async function createApp(options: AppOptions) {
  const store = new Store(path.resolve(options.dataDir), options.projectRoot);
  await store.init();
  const work = new WorkService(store, options.stepMs);
  const nativeWork = new NativeWorkService(store, options.nativeGenerator);
  const app = express();
  // The port this service listens on, learned from the first request's socket (listen(0)
  // in tests picks it late). A wake has no request of its own, so it uses the remembered one.
  let listeningPort: number | undefined;
  const teamForMember = (
    projectId: string,
    member: TeamMember,
    port: number | undefined,
  ): NativeTeamOptions => {
    if (!port) throw new ApiError(503, 'The team service listening port is unavailable.');
    return {
      url: `http://127.0.0.1:${port}/mcp/team/${projectId}`,
      tokenEnv: `DIOMEDES_TEAM_${member.slotId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
      slotId: member.slotId,
      role: member.role,
      roleInstructions: roleInstructions(member.role, member, store.state(projectId).project),
    };
  };
  const teamForThread = (
    req: Request,
    projectId: string,
    threadId: string | undefined,
  ): NativeTeamOptions | undefined => {
    if (!threadId) return undefined;
    const state = store.state(projectId);
    const member = state.team?.members.find(
      (item) => item.threadId === threadId && item.engine === 'codex',
    );
    if (!member) return undefined;
    // The socket is the listening service, even when listen(0) selected the port.
    return teamForMember(projectId, member, req.socket.localPort);
  };
  const serviceFor = (projectId: string, sessionId: string) => {
    const session = store.state(projectId).sessions.find((item) => item.id === sessionId);
    if (!session) throw new ApiError(404, 'This work session was not found.');
    return session.sample ? work : nativeWork;
  };
  const port = options.port ?? Number(process.env.DIOMEDES_PORT ?? 47631),
    clientPort = options.clientPort ?? Number(process.env.DIOMEDES_CLIENT_PORT ?? 5173);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://127.0.0.1:${clientPort}`]);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.socket.localPort) listeningPort = req.socket.localPort;
    if (req.path.startsWith('/mcp/team/')) return next();
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host))
      return next(new ApiError(403, 'This service accepts connections on 127.0.0.1 only.'));
    if (origin && !origins.has(origin))
      return next(new ApiError(403, 'This page cannot access the local service.'));
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Diomedes-Client');
      res.status(204).end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-diomedes-client'] !== '1')
      return next(new ApiError(403, 'The Diomedes client header is required.'));
    next();
  });
  app.use(express.json({ limit: '9mb' }));
  const teamService = mountTeamRoutes(app, store);
  // A member wakes on team mail (see server/team/service.ts): the run is the same Codex Work
  // run a person starts from the thread, on the member's open task when it has one. Only
  // Codex members run; other engines park as waiting until they exist.
  teamService.setRunStarter(async ({ projectId, member, threadId, text }) => {
    if (member.engine !== 'codex') throw new ApiError(409, 'This helper cannot run here yet.');
    const state = store.state(projectId);
    const openTask = state.tasks.find(
      (item) => item.assignedTo === member.slotId && !item.deletedAt && item.state !== 'done',
    );
    const started = await startCodexWork(
      {
        projectId,
        threadId,
        attachedTo: { kind: 'project', ref: projectId },
        text,
        sources: [],
        consent: true,
        team: teamForMember(projectId, member, listeningPort),
        taskId: openTask?.id,
        wake: true,
      },
      true,
    );
    return { sessionId: started.session.id };
  });
  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: express.NextFunction) => {
      try {
        const result = locked ? await store.locked(() => action(req, res)) : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };
  const id = (req: Request) => String(req.params.id);
  const body = (req: Request) => plain(req.body);
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      name: 'Diomedes',
      version: '0.1.0',
      dataDir: store.dataDir,
      projectRoot: store.projectRoot,
      service: 'local',
      port,
    }),
  );
  app.get(
    '/api/settings',
    route(async () => store.settings),
  );
  app.put(
    '/api/settings',
    route(async (req) => store.saveSettings(validateSettings(store.settings, req.body))),
  );
  app.get(
    '/api/integrations',
    route(
      async (req) => ({
        integrations: (
          await getIntegrationStatuses({ refresh: req.query.refresh === '1' })
        ).map((item) =>
          item.adapter === 'ready' && item.kind !== 'sample'
            ? { ...item, enabled: store.settings.services?.[item.id] === true }
            : item,
        ),
      }),
      false,
    ),
  );
  app.get(
    '/api/usage',
    route(
      async (req) => {
        if (req.query.fake === '1') {
          // Test-mode only: a fixed Codex snapshot so the UI suite can assert
          // the chip, the signal colour and the Settings bars without a real
          // Codex session.
          if (process.env.DIOMEDES_TEST_MODE !== '1')
            throw new ApiError(404, 'This action was not found.');
          const snapshot = fakeCodexSnapshot();
          usageService.record('codex', snapshot);
          return { usage: usageService.all() };
        }
        return { usage: usageService.all() };
      },
      false,
    ),
  );
  app.get(
    '/api/fs/list',
    route(async (req) => {
      const folder = await safeAbsolute(
        typeof req.query.path === 'string' && req.query.path.trim()
          ? req.query.path
          : store.projectRoot,
      );
      try {
        await fs.access(folder);
      } catch (error) {
        if (!absent(error)) throw error;
        return { path: folder, parent: path.dirname(folder), folders: [] };
      }
      const folders = [];
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink() || item.name.startsWith('.')) continue;
        try {
          const safe = await safeAbsolute(path.join(folder, item.name));
          folders.push({ name: item.name, path: safe });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 403)) throw error;
        }
      }
      return {
        path: folder,
        parent: path.dirname(folder) === folder ? null : path.dirname(folder),
        folders,
      };
    }),
  );
  app.get(
    '/api/projects',
    route(async () => ({ projects: await store.projects() })),
  );
  app.post(
    '/api/projects/sample',
    route(async () => {
      const name = 'Harbor Street restaurants';
      const project = await store.createProject(
        name,
        path.join(store.projectRoot, `${name} ${identifier().slice(0, 6)}`),
      );
      const state = store.state(project.id);
      state.project.plans.push('Reopening plan.md');
      await store.persist(state);
      await store.writeRecorded(
        project.id,
        [
          {
            path: 'Reopening plan.md',
            expected: null,
            text: '# Reopening plan\n\nHarbor Street restaurants is reopening the patio for fall.\n\n1. Review the fall menu and update the descriptions\n2. Prepare a reopening announcement\n3. Call the produce supplier about seasonal availability\n4. Check the patio setup before opening day\n',
          },
          {
            path: 'Fall menu.md',
            expected: null,
            text: '# Fall menu\n\nRoasted squash soup - $9\nHarbor Street burger - $18\nMushroom risotto - $21\nApple crumble - $8\n\nUse local produce where available. Confirm prices before printing.\n',
          },
          {
            path: 'Opening notes.txt',
            expected: null,
            text: 'Patio reopening: Friday, September 18.\nCheck the weather on Wednesday.\nAsk the team to review the fall menu before the announcement goes out.\n',
          },
        ],
        {
          kind: 'edited',
          sentence: 'You created the Harbor Street sample project',
          sample: true,
          merge: false,
        },
      );
      return store.state(project.id).project;
    }),
  );
  app.post(
    '/api/projects/open',
    route(async (req) => {
      const folder = asString(body(req).folder, 'a folder path', 1000);
      return store.createProject(path.basename(path.resolve(folder)), folder, true);
    }),
  );
  app.post(
    '/api/projects',
    route(async (req) => {
      const b = body(req);
      return store.createProject(
        asString(b.name, 'a project name', 120),
        b.folder === undefined || b.folder === ''
          ? undefined
          : asString(b.folder, 'a folder path', 1000),
      );
    }),
  );
  app.get(
    '/api/projects/:id/state',
    route(async (req) => store.projectState(id(req))),
  );
  /**
   * What an engine can be asked to run. Read from the engine's own list on this
   * computer, so the choices follow the account rather than a Diomedes release.
   */
  app.get(
    '/api/engines/:engineId/models',
    route(async (req) => {
      const engine = String(req.params.engineId);
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(engine))
        throw new ApiError(400, 'That is not an engine name.');
      return engineCatalog(engine);
    }),
  );
  app.get(
    '/api/projects/:id',
    route(async (req) => {
      await store.projects();
      return store.state(id(req)).project;
    }),
  );
  app.post(
    '/api/projects/:id/open-folder',
    route(async (req) => {
      const folder = await safeAbsolute(store.state(id(req)).project.folder);
      if (!(await fs.stat(folder)).isDirectory())
        throw new ApiError(404, 'The project folder is missing.');
      if (process.platform !== 'win32')
        throw new ApiError(
          501,
          'Opening a folder in its desktop app is supported on Windows only.',
        );
      await new Promise<void>((resolve, reject) => {
        const explorer = spawn(
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'),
          [folder],
          { shell: false, windowsHide: true, stdio: 'ignore' },
        );
        explorer.once('error', reject);
        explorer.once('spawn', () => {
          explorer.unref();
          resolve();
        });
      });
      return { opened: true };
    }),
  );
  app.put(
    '/api/projects/:id/left-off',
    route(async (req) => {
      const b = body(req),
        state = store.state(id(req));
      const page = choice(b.page, pages, 'page');
      const document =
        b.document === null || b.document === undefined ? null : relativeName(b.document);
      const scroll = b.scroll ?? 0;
      if (typeof scroll !== 'number' || !Number.isFinite(scroll) || scroll < 0)
        throw new ApiError(400, 'Provide a valid scroll position.');
      state.project.leftOff = { page, document, scroll, at: now() };
      await store.persist(state);
      return state.project;
    }),
  );
  app.get(
    '/api/projects/:id/documents',
    route(async (req) => ({ documents: await store.listDocuments(id(req)) })),
  );
  app.get(
    '/api/projects/:id/documents/read',
    route(async (req) =>
      store.readDocument(id(req), asString(req.query.path, 'a document path', 1000)),
    ),
  );
  app.post(
    '/api/projects/:id/documents/write',
    route(async (req) => {
      const b = body(req);
      if (
        typeof b.text !== 'string' ||
        typeof b.baseSha !== 'string' ||
        !/^[a-f0-9]{64}$/.test(b.baseSha)
      )
        throw new ApiError(400, 'Provide document text and the version you opened.');
      const entry = await store.writeRecorded(id(req), [
        { path: relativeName(b.path), text: b.text, expected: b.baseSha },
      ]);
      return { sha: hash(b.text), entryId: entry.id };
    }),
  );
  app.post(
    '/api/projects/:id/documents/create',
    route(async (req) => {
      const b = body(req);
      if (typeof b.text !== 'string') throw new ApiError(400, 'Provide document text.');
      const name = relativeName(b.path);
      if (b.kind === 'plan' && !store.state(id(req)).project.plans.includes(name))
        store.state(id(req)).project.plans.push(name);
      return store.writeRecorded(id(req), [{ path: name, text: b.text, expected: null }], {
        merge: false,
      });
    }),
  );
  app.get(
    '/api/projects/:id/history',
    route(async (req) => {
      const entries = [...store.state(id(req)).history]
        .reverse()
        .filter(
          (e) =>
            (!req.query.path || e.files.some((f) => f.path === req.query.path)) &&
            (!req.query.kind || e.kind === req.query.kind),
        );
      const days = new Map<string, typeof entries>();
      for (const entry of entries) {
        const day = entry.time.slice(0, 10);
        const group = days.get(day) ?? [];
        group.push(entry);
        days.set(day, group);
      }
      return { days: [...days].map(([day, entries]) => ({ day, entries })) };
    }),
  );
  app.post(
    '/api/projects/:id/history/label',
    route(async (req) => store.snapshot(id(req), asString(body(req).label, 'a version name', 120))),
  );
  app.get(
    '/api/projects/:id/history/:entryId/changes',
    route(async (req) => {
      const entry = store.state(id(req)).history.find((e) => e.id === req.params.entryId);
      if (!entry) throw new ApiError(404, 'This history entry was not found.');
      return {
        files: await Promise.all(
          entry.files.map((_file, index) => store.changeFromFile(id(req), entry, index)),
        ),
      };
    }),
  );
  app.post(
    '/api/projects/:id/history/:entryId/restore',
    route(async (req) => {
      const b = body(req);
      let files: string[] | undefined;
      if (b.files !== undefined) {
        if (!Array.isArray(b.files)) throw new ApiError(400, 'Provide the files to restore.');
        files = b.files.map(relativeName);
      }
      return store.restore(
        id(req),
        String(req.params.entryId),
        files,
        b.mode === undefined
          ? undefined
          : choice(b.mode, ['all', 'unchanged-only', 'copies'], 'restore option'),
      );
    }),
  );
  app.post(
    '/api/projects/:id/history/:entryId/restore-file',
    route(
      async (req) =>
        (await store.restore(id(req), String(req.params.entryId), [relativeName(body(req).path)]))
          .entry,
    ),
  );
  app.get(
    '/api/projects/:id/tasks',
    route(async (req) => ({
      tasks: store.state(id(req)).tasks,
      autoUpdate: store.state(id(req)).autoUpdate,
    })),
  );
  app.post(
    '/api/projects/:id/tasks',
    route(async (req) => {
      const b = body(req),
        state = store.state(id(req));
      const task = store.createTask(state, {
        name: asString(b.name, 'a task name', 200),
        description: typeof b.description === 'string' ? b.description.slice(0, 10000) : '',
        owner: b.owner === undefined ? 'you' : choice(b.owner, owners, 'owner'),
      });
      store.addEntry(state, {
        kind: 'tasks-made',
        sentence: `You made a task: ${task.name}`,
        taskId: task.id,
      });
      await store.persist(state);
      return task;
    }),
  );
  app.put(
    '/api/projects/:id/tasks/auto',
    route(async (req) => {
      const state = store.state(id(req)),
        value = body(req).autoUpdate;
      if (typeof value !== 'boolean') throw new ApiError(400, 'Choose true or false.');
      state.autoUpdate = value;
      await store.persist(state);
      return { autoUpdate: value };
    }),
  );
  app.put(
    '/api/projects/:id/tasks/:taskId',
    route(async (req) => {
      const b = body(req),
        state = store.state(id(req)),
        task = state.tasks.find((t) => t.id === req.params.taskId);
      if (!task) throw new ApiError(404, 'This task was not found.');
      if (b.name !== undefined) task.name = asString(b.name, 'a task name', 200);
      if (b.description !== undefined) {
        if (typeof b.description !== 'string' || b.description.length > 10000)
          throw new ApiError(400, 'Provide a description of up to 10,000 characters.');
        task.description = b.description;
      }
      if (b.owner !== undefined) task.owner = choice(b.owner, owners, 'owner');
      if (b.state !== undefined) {
        if (
          state.sessions.some(
            (s) => s.taskId === task.id && ['working', 'waiting', 'queued'].includes(s.state),
          )
        )
          throw new ApiError(409, 'Stop this work before moving the task manually.');
        store.moveTask(state, task, choice(b.state, states, 'task state'));
        task.reason = null;
      }
      await store.persist(state);
      return task;
    }),
  );
  app.post(
    '/api/projects/:id/tasks/:taskId/undo-move',
    route(async (req) => {
      const state = store.state(id(req)),
        task = state.tasks.find((t) => t.id === req.params.taskId);
      if (!task) throw new ApiError(404, 'This task was not found.');
      const move = task.moves.at(-1);
      if (!move || move.undone || move.by === 'you' || Date.parse(move.undoUntil) < Date.now())
        throw new ApiError(409, 'This automatic move can no longer be undone.');
      const session = state.sessions.find(
        (s) => s.taskId === task.id && ['working', 'waiting', 'queued'].includes(s.state),
      );
      if (session) await serviceFor(id(req), session.id).stop(id(req), session.id);
      task.state = move.from;
      move.undone = true;
      store.addEntry(state, {
        kind: 'task-moved',
        sentence: `You undid the move of ${task.name}`,
        taskId: task.id,
      });
      await store.persist(state);
      return task;
    }),
  );
  app.post(
    '/api/projects/:id/plans/find-tasks',
    route(async (req) => {
      const document = await store.readDocument(id(req), relativeName(body(req).path));
      return { found: findTasks(document.text) };
    }),
  );
  app.post(
    '/api/projects/:id/plans/add-tasks',
    route(async (req) => {
      const b = body(req),
        name = relativeName(b.path),
        document = await store.readDocument(id(req), name);
      const found = findTasks(document.text);
      const state = store.state(id(req));
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 500)
        throw new ApiError(400, 'Choose between 1 and 500 tasks.');
      const items = b.items.map((item) => {
        const value = plain(item);
        const candidate = found.find((f) => f.line === value.line);
        if (!candidate) throw new ApiError(409, 'This plan changed. Find its tasks again.');
        return {
          line: candidate.line,
          name: asString(value.name, 'a task name', 200),
          owner: choice(value.owner, owners, 'owner'),
        };
      });
      if (new Set(items.map((i) => i.line)).size !== items.length)
        throw new ApiError(400, 'Choose each plan line once.');
      const tasks = items.map((item) =>
        store.createTask(state, {
          name: item.name,
          owner: item.owner,
          from: {
            plan: name,
            step: found.findIndex((candidate) => candidate.line === item.line) + 1,
          },
        }),
      );
      const lines = document.text.split(/\r?\n/);
      items.forEach((item, index) => {
        lines[item.line - 1] += ` T${tasks[index].id.slice(1)}`;
      });
      if (!state.project.plans.includes(name)) state.project.plans.push(name);
      const entry = await store.writeRecorded(
        id(req),
        [{ path: name, text: lines.join('\n'), expected: document.sha }],
        {
          kind: 'tasks-made',
          sentence: `You made ${tasks.length} tasks from ${name}`,
          merge: false,
        },
      );
      return { tasks, entryId: entry.id };
    }),
  );
  app.get(
    '/api/projects/:id/work',
    route(async (req) => ({ sessions: store.state(id(req)).sessions })),
  );
  app.post(
    '/api/projects/:id/work/start',
    route(async (req) => {
      const b = body(req);
      const projectId = id(req);
      const threadId =
        b.threadId === undefined || b.threadId === null
          ? undefined
          : asString(b.threadId, 'a thread', 100);
      let threadPermission: ThreadPermission = 'show-first';
      if (threadId !== undefined) {
        const thread = store.state(projectId).conversations.find((c) => c.id === threadId);
        if (!thread) throw new ApiError(404, 'This thread was not found.');
        threadPermission = thread.permission ?? 'show-first';
      }
      const selectedRoute =
        b.route === undefined ? 'sample' : choice(b.route, ['sample', 'codex'], 'service');
      if (selectedRoute === 'codex') {
        if (b.consent !== true)
          throw new ApiError(
            409,
            'Your instruction and selected documents will be sent to Codex. Confirm before sending.',
            { consentRequired: true },
          );
        if (!Array.isArray(b.sources))
          throw new ApiError(
            400,
            'Provide the explicitly selected source documents, or an empty list to propose new files.',
          );
        const started = await nativeWork.start(projectId, asString(b.taskId, 'a task', 100), {
          instruction:
            b.instruction === undefined
              ? undefined
              : asString(b.instruction, 'an instruction', 16000),
          sources: b.sources.map(relativeName),
          consent: true,
          team: teamForThread(req, projectId, threadId),
        });
        const stored = store.state(projectId).sessions.find((s) => s.id === started.id)!;
        stored.permission = threadPermission;
        await store.persist(store.state(projectId));
        return stored;
      }
      const started = await work.start(
        projectId,
        asString(b.taskId, 'a task', 100),
        typeof b.instruction === 'string' ? b.instruction : '',
        b.demo === 'fault',
      );
      const stored = store.state(projectId).sessions.find((s) => s.id === started.id)!;
      stored.permission = threadPermission;
      await store.persist(store.state(projectId));
      return stored;
    }),
  );
  app.post(
    '/api/projects/:id/work/:sessionId/stop',
    route(async (req) =>
      serviceFor(id(req), String(req.params.sessionId)).stop(id(req), String(req.params.sessionId)),
    ),
  );
  app.post(
    '/api/projects/:id/work/:sessionId/note',
    route(async (req) =>
      serviceFor(id(req), String(req.params.sessionId)).note(
        id(req),
        String(req.params.sessionId),
        asString(body(req).text, 'a note', 4000),
      ),
    ),
  );
  app.get(
    '/api/projects/:id/needs',
    route(async (req) => ({ needs: store.state(id(req)).needs })),
  );
  app.post(
    '/api/projects/:id/needs/:needId/resolve',
    route(async (req) => {
      const b = body(req);
      if (b.allowForTask !== undefined && typeof b.allowForTask !== 'boolean')
        throw new ApiError(400, 'Choose true or false for the task allowance.');
      const need = store.state(id(req)).needs.find((item) => item.id === req.params.needId);
      if (!need) throw new ApiError(404, 'This request was not found.');
      return serviceFor(id(req), need.sessionId).resolve(
        id(req),
        String(req.params.needId),
        choice(b.resolution, ['go-ahead', 'declined'], 'decision'),
        b.allowForTask === true,
      );
    }),
  );
  const review = async (projectId: string, changeId: string, action: 'keep' | 'undo') => {
    let state = store.state(projectId);
    const change = state.changes.find((c) => c.id === changeId);
    if (!change) throw new ApiError(404, 'This change was not found.');
    if (change.state !== 'waiting')
      throw new ApiError(409, 'This change has already been reviewed.');
    let entryId: string | undefined;
    if (action === 'undo') {
      const result = await store.restore(projectId, change.entryId, [change.path]);
      entryId = result.entryId;
      state = store.state(projectId);
    }
    const fresh = state.changes.find((c) => c.id === changeId)!;
    fresh.state = action === 'keep' ? 'kept' : 'undone';
    const task = state.tasks.find((t) => t.id === fresh.taskId);
    if (task && !state.changes.some((c) => c.taskId === task.id && c.state === 'waiting')) {
      store.moveTask(state, task, 'done', 'diomedes');
      task.reason = null;
    }
    await store.persist(state);
    return { change: fresh, entryId };
  };
  app.get(
    '/api/projects/:id/review',
    route(async (req) => ({ changes: store.state(id(req)).changes })),
  );
  app.post(
    '/api/projects/:id/review/all',
    route(async (req) => {
      const b = body(req),
        action = choice(b.action, ['keep', 'undo'], 'review action');
      const changes = store
        .state(id(req))
        .changes.filter(
          (c) => c.state === 'waiting' && (!b.sessionId || c.sessionId === b.sessionId),
        );
      const results = [];
      for (const change of changes) results.push(await review(id(req), change.id, action));
      return { changes: results.map((r) => r.change) };
    }),
  );
  app.post(
    '/api/projects/:id/review/:changeId',
    route(async (req) =>
      review(
        id(req),
        String(req.params.changeId),
        choice(body(req).action, ['keep', 'undo'], 'review action'),
      ),
    ),
  );
  app.get(
    '/api/projects/:id/conversations',
    route(async (req) => ({ conversations: store.state(id(req)).conversations })),
  );
  const touchThread = (
    conversation: Conversation,
    at: string,
    tasks: { id: string; name: string }[] = [],
  ) => {
    conversation.updatedAt = at;
    if (conversation.name === 'New thread') {
      const firstYou = conversation.turns.find((t) => t.role === 'you');
      if (firstYou) conversation.name = threadNameFromText(firstYou.text);
      else if (conversation.attachedTo.kind === 'task') {
        const task = tasks.find((t) => t.id === conversation.attachedTo.ref);
        if (task) conversation.name = `Thread for ${task.name}`;
      }
    }
  };
  app.get(
    '/api/projects/:id/threads',
    route(async (req) => {
      const threads = [...store.state(id(req)).conversations].sort((a, b) =>
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      );
      return { threads };
    }),
  );
  app.post(
    '/api/projects/:id/threads',
    route(async (req, res) => {
      const b = body(req),
        projectId = id(req),
        state = store.state(projectId);
      let attachedTo: Conversation['attachedTo'] = { kind: 'project', ref: projectId };
      if (b.attachedTo !== undefined) {
        const attached = plain(b.attachedTo);
        attachedTo = {
          kind: choice(
            attached.kind,
            ['project', 'document', 'plan', 'task', 'review'],
            'attachment type',
          ),
          ref: asString(attached.ref, 'an attachment', 1000),
        };
      }
      let taskId: string | null =
        attachedTo.kind === 'task' ? attachedTo.ref : null;
      if (b.taskId !== undefined && b.taskId !== null) {
        const given = asString(b.taskId, 'a task', 100);
        const task = state.tasks.find((t) => t.id === given);
        if (task) {
          attachedTo = { kind: 'task', ref: task.id };
          taskId = task.id;
        }
      }
      let name: string;
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120)
          throw new ApiError(400, 'Give this thread a name of up to 120 characters.');
        name = b.name.trim();
      } else {
        const task =
          attachedTo.kind === 'task'
            ? state.tasks.find((t) => t.id === attachedTo.ref)
            : undefined;
        name = task ? `Thread for ${task.name}` : 'New thread';
      }
      const permission: ThreadPermission =
        b.permission === undefined ? 'show-first' : parseThreadPermission(b.permission);
      const stamped = now();
      const conversation: Conversation = {
        id: identifier('C'),
        attachedTo,
        turns: [],
        name,
        createdAt: stamped,
        updatedAt: stamped,
        taskId,
        helper: null,
        permission,
      };
      state.conversations.push(conversation);
      await store.persist(state);
      res.status(201).json(conversation);
      return undefined;
    }),
  );
  app.put(
    '/api/projects/:id/threads/:threadId',
    route(async (req) => {
      const state = store.state(id(req)),
        conversation = state.conversations.find((c) => c.id === req.params.threadId);
      if (!conversation) throw new ApiError(404, 'This thread was not found.');
      const b = body(req);
      if (b.name === undefined && b.permission === undefined && b.requested === undefined)
        throw new ApiError(400, 'Provide a thread name, permission mode or helper choice.');
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120)
          throw new ApiError(400, 'Give this thread a name of up to 120 characters.');
        conversation.name = b.name.trim();
      }
      if (b.permission !== undefined)
        conversation.permission = parseThreadPermission(b.permission);
      if (b.requested !== undefined) conversation.requested = parseRequested(b.requested);
      await store.persist(state);
      return conversation;
    }),
  );
  /**
   * Verified helper bookkeeping (muse/verified-model). A displayed helper name comes
   * only from the runtime result, never from answer text. Sample work is
   * deterministic, so its helper is verified without a runtime call.
   */
  const codexModelSetting = (): string | undefined => {
    const raw = (store.settings.services as Record<string, unknown> | undefined)?.codexModel;
    return typeof raw === 'string' && raw.trim() && raw.length <= 120 ? raw.trim() : undefined;
  };
  const codexEffortSetting = (): string | undefined => {
    const raw = (store.settings.services as Record<string, unknown> | undefined)?.codexEffort;
    return typeof raw === 'string' && raw.trim() && raw.length <= 40 ? raw.trim() : undefined;
  };
  /**
   * What to ask Codex to run: the thread's own choice first, then the saved
   * default, then nothing, which leaves the runtime's default in place. A pair
   * the engine no longer offers is dropped rather than sent.
   */
  const codexChoice = (conversation?: Conversation | null): { model?: string; effort?: string } => {
    const chosen = conversation?.requested;
    const model = chosen?.model ?? codexModelSetting();
    const effort = chosen?.model ? (chosen.effort ?? undefined) : codexEffortSetting();
    if (!model || !isKnownChoice('codex', model, effort ?? null)) return {};
    return { model, ...(effort ? { effort } : {}) };
  };
  const codexHelper = (result: {
    model?: string;
    version?: string;
  }): NonNullable<Turn['helper']> =>
    result.model
      ? { engine: 'codex', model: result.model, version: result.version ?? null, verified: true }
      : { engine: 'codex', model: null, version: result.version ?? null, verified: false };
  const sampleHelper = (): NonNullable<Turn['helper']> => ({
    engine: 'sample',
    model: null,
    version: null,
    verified: true,
  });
  /**
   * A Codex Work run from a thread: a task from the text (or the given task), the person's
   * turn, the native run with any team options, and the reply turn. `held` says the caller
   * already holds the store lock (the lock is a queue, not reentrant): the team service's
   * wake runs inside a locked route, the /ask route does not.
   */
  const startCodexWork = async (
    input: {
      projectId: string;
      threadId: string | undefined;
      attachedTo: Conversation['attachedTo'];
      text: string;
      sources: string[];
      consent: boolean;
      team: NativeTeamOptions | undefined;
      taskId?: string;
      wake?: boolean;
    },
    held = false,
  ) => {
    const { projectId, threadId, attachedTo, text, sources, consent, team, taskId, wake } = input;
    const run = async () => {
      const state = store.state(projectId);
      if (
        state.sessions.some((session) =>
          ['queued', 'working', 'waiting'].includes(session.state),
        )
      )
        throw new ApiError(409, 'This project already has work in progress.');
      const task =
        (taskId !== undefined
          ? state.tasks.find((item) => item.id === taskId && !item.deletedAt)
          : undefined) ??
        store.createTask(state, {
          // A wake's text opens with the sender line; the task is named for the ask itself.
          name: taskNameFromText(wake ? text.replace(/^From [^:\n]{1,80}: /, '') : text),
          description: text,
          owner: 'diomedes-with-ok',
        });
      let conversation =
        threadId !== undefined
          ? state.conversations.find((item) => item.id === threadId)!
          : state.conversations.find(
              (item) =>
                item.attachedTo.kind === attachedTo.kind &&
                item.attachedTo.ref === attachedTo.ref,
            );
      if (!conversation) {
        const stamped = now();
        conversation = {
          id: identifier('C'),
          attachedTo,
          turns: [],
          name: 'New thread',
          createdAt: stamped,
          updatedAt: stamped,
          taskId: attachedTo.kind === 'task' ? attachedTo.ref : null,
          helper: null,
          permission: 'show-first',
        };
        state.conversations.push(conversation);
      }
      if (!conversation.taskId) conversation.taskId = task.id;
      if (!wake) {
        // A wake carries team mail that the thread already shows; only a person's own
        // message becomes a turn of theirs.
        const youTurn: Turn = {
          id: identifier('U'),
          role: 'you',
          mode: 'work',
          text,
          at: now(),
          sources,
          route: 'codex',
        };
        conversation.turns.push(youTurn);
        touchThread(conversation, youTurn.at, state.tasks);
      }
      // The turn id is fixed before the run so the native worker can mark the
      // turn verified once the runtime reports its engine.
      const turnId = identifier('U');
      const session = await nativeWork.start(projectId, task.id, {
        instruction: text,
        sources,
        consent: consent,
        team: team,
        turnId,
        requested: codexChoice(conversation),
      });
      const storedSession = store
        .state(projectId)
        .sessions.find((item) => item.id === session.id)!;
      storedSession.permission = conversation.permission ?? 'show-first';
      const turn: Turn = {
        id: turnId,
        role: 'diomedes',
        mode: 'work',
        text: wake
          ? 'Picked up a message from the team. Anything Codex proposes waits for your go-ahead.'
          : 'Codex is preparing a file proposal. Review each proposed change before saying go ahead. No project files have been changed.',
        at: now(),
        sources,
        route: 'codex',
        helper: {
          engine: 'codex',
          model: codexChoice(conversation).model ?? null,
          version: null,
          verified: false,
        },
      };
      conversation.turns.push(turn);
      touchThread(conversation, turn.at, state.tasks);
      await store.persist(store.state(projectId));
      return {
        turn,
        conversation,
        session: store.state(projectId).sessions.find((item) => item.id === session.id)!,
      };
    };
    return held ? run() : store.locked(run);
  };
  app.post(
    '/api/projects/:id/ask',
    route(async (req) => {
      const b = body(req),
        projectId = id(req),
        mode = choice(b.mode, ['ask', 'plan', 'work'], 'mode'),
        text = asString(b.text, 'an instruction', 16000),
        serviceRoute =
          b.route === undefined ? 'sample' : choice(b.route, ['sample', 'codex'], 'service');
      const attached =
        b.attachedTo === undefined ? { kind: 'project', ref: projectId } : plain(b.attachedTo);
      const attachedTo: Conversation['attachedTo'] = {
        kind: choice(
          attached.kind,
          ['project', 'document', 'plan', 'task', 'review'],
          'attachment type',
        ),
        ref: asString(attached.ref, 'an attachment', 1000),
      };
      const threadId =
        b.threadId === undefined || b.threadId === null
          ? undefined
          : asString(b.threadId, 'a thread', 100);
      if (
        threadId !== undefined &&
        !store.state(projectId).conversations.some((c) => c.id === threadId)
      )
        throw new ApiError(404, 'This thread was not found.');
      if (serviceRoute === 'codex' && !store.settings.services?.codex)
        throw new ApiError(409, 'Turn Codex on in Settings before using it.');
      if (
        serviceRoute === 'codex' &&
        (mode === 'work' || store.settings.permissions.sending) &&
        b.consent !== true
      )
        throw new ApiError(
          409,
          'Your instruction and selected documents will be sent to Codex. Confirm before sending.',
          { consentRequired: true },
        );
      let sources: string[] = [];
      if (b.sources !== undefined) {
        if (!Array.isArray(b.sources) || b.sources.length > 8)
          throw new ApiError(400, 'Select no more than eight source documents.');
        sources = b.sources.map(relativeName);
      }
      if (['document', 'plan'].includes(attachedTo.kind))
        sources.push(relativeName(attachedTo.ref));
      sources = [...new Set(sources)];
      if (sources.length > 8)
        throw new ApiError(400, 'Select no more than eight source documents.');
      if (mode === 'work' && serviceRoute === 'codex')
        return startCodexWork({
          projectId,
          threadId,
          attachedTo,
          text,
          sources,
          consent: b.consent === true,
          team: teamForThread(req, projectId, threadId),
        });
      const prepared = await store.locked(async () => {
        const state = store.state(projectId);
        let conversation =
          threadId !== undefined
            ? state.conversations.find((c) => c.id === threadId)!
            : state.conversations.find(
                (c) =>
                  c.attachedTo.kind === attachedTo.kind && c.attachedTo.ref === attachedTo.ref,
              );
        if (!conversation) {
          const stamped = now();
          conversation = {
            id: identifier('C'),
            attachedTo,
            turns: [],
            name: 'New thread',
            createdAt: stamped,
            updatedAt: stamped,
            taskId: attachedTo.kind === 'task' ? attachedTo.ref : null,
            helper: null,
            permission: 'show-first',
          };
          state.conversations.push(conversation);
        }
        const documents = await Promise.all(
          sources.map(async (name) => {
            const document = await store.readDocument(projectId, name);
            return { path: name, text: document.text };
          }),
        );
        if (documents.reduce((total, d) => total + Buffer.byteLength(d.text), 0) > 128000)
          throw new ApiError(413, 'Choose less than 128 KB of source text for this request.');
        const youTurn: Turn = {
          id: identifier('U'),
          role: 'you',
          mode,
          text,
          at: now(),
          sources,
          route: serviceRoute,
        };
        conversation.turns.push(youTurn);
        touchThread(conversation, youTurn.at, state.tasks);
        await store.persist(state);
        return { conversationId: conversation.id, documents };
      });
      let answer: string;
      let helper: NonNullable<Turn['helper']>;
      const runChoice = codexChoice(
        store.state(projectId).conversations.find((c) => c.id === prepared.conversationId),
      );
      const requestedModel = runChoice.model;
      if (serviceRoute === 'codex') {
        try {
          const result = await askCodex({
            prompt:
              mode === 'plan'
                ? `Write a practical Markdown plan for the following request. Use numbered actionable steps.\n\n${text}`
                : text,
            documents: prepared.documents,
            ...runChoice,
          });
          answer = result.text;
          helper = codexHelper(result);
        } catch (error) {
          throw new ApiError(
            503,
            error instanceof Error ? error.message : 'Codex could not complete this request.',
          );
        }
      } else {
        helper = sampleHelper();
        answer =
          mode === 'ask'
            ? `No service is connected for this request, so Diomedes cannot answer yet.${sources.length ? ` It would read ${sources.slice(0, 3).join(', ')} to answer.` : ''} ${
                store.settings.surface === 'desk'
                  ? 'Turn an engine on in Settings > Engines.'
                  : 'Turn a helper on in Settings > Helpers on this computer.'
              }`
            : mode === 'plan'
              ? `# ${text.split('\n')[0].slice(0, 120)}\n\nSample plan written without a service on ${now()}. Edit it freely.\n\n1. ${text.replaceAll('\n', ' ').slice(0, 240)}\n2. Review what changed\n3. Call anyone who needs to know\n`
              : 'Started clearly labelled sample work. No AI service is involved.';
      }
      return store.locked(async () => {
        let state = store.state(projectId);
        let document: string | undefined;
        let session: Session | undefined;
        let createdTaskId: string | null = null;
        if (mode === 'plan') {
          const safeTitle =
            text
              .split('\n')[0]
              .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
              .trim()
              .replace(/[. ]+$/, '')
              .slice(0, 72) || 'New plan';
          document = `${safeTitle}.md`;
          if ((await store.current(projectId, document)) !== null)
            document = `${safeTitle} ${identifier().slice(0, 4)}.md`;
          state.project.plans.push(document);
          await store.writeRecorded(projectId, [{ path: document, text: answer, expected: null }], {
            actor: 'diomedes',
            kind: 'edited',
            sentence:
              helper.verified && helper.model
                ? `Diomedes, with Codex ${helper.model}, wrote ${document}`
                : `Diomedes wrote ${document}`,
            sample: serviceRoute === 'sample',
            review: true,
            merge: false,
          });
          state = store.state(projectId);
        } else if (mode === 'work') {
          if (
            state.sessions.some((session) =>
              ['queued', 'working', 'waiting'].includes(session.state),
            )
          )
            throw new ApiError(409, 'This project already has work in progress.');
          const task = store.createTask(state, {
            name: taskNameFromText(text),
            description: text,
            owner: 'diomedes-with-ok',
          });
          createdTaskId = task.id;
          await store.persist(state);
          session = await work.start(projectId, task.id, text);
          state = store.state(projectId);
        }
        const conversation = state.conversations.find((c) => c.id === prepared.conversationId)!;
        if (createdTaskId && !conversation.taskId) conversation.taskId = createdTaskId;
        conversation.helper = { engine: helper.engine, model: helper.model };
        if (session) {
          const sessionId = session.id;
          const stored = state.sessions.find((item) => item.id === sessionId)!;
          stored.permission = conversation.permission ?? 'show-first';
          if (stored.sample) {
            stored.engine.verified = true;
            stored.engine.version = null;
          }
          session = stored;
        }
        const turn: Turn = {
          id: identifier('U'),
          role: 'diomedes',
          mode,
          text: answer,
          at: now(),
          sources,
          route: serviceRoute,
          helper,
        };
        conversation.turns.push(turn);
        touchThread(conversation, turn.at, state.tasks);
        await store.persist(state);
        return { turn, conversation, document, session };
      });
    }, false),
  );
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const listener = (projectId: string) => {
      const state = store.state(projectId);
      send('state', { projectId, state });
      for (const event of [
        'project',
        'tasks',
        'needs',
        'history',
        'review',
        'session',
        'status',
        'conversations',
        'team',
      ])
        send(event, {
          projectId,
          data:
            event === 'project'
              ? state.project
              : event === 'review'
                ? state.changes
                : event === 'session'
                  ? state.sessions
                  : event === 'status'
                    ? state.project.status
                    : event === 'team'
                      ? (state.team ?? { members: [], messages: [], runs: [] })
                      : state[event as 'tasks' | 'needs' | 'history' | 'conversations'],
        });
      send('projects', { projects: [state.project] });
    };
    const settingsListener = (settings: Settings) => send('settings', settings);
    const usageListener = (snapshots: UsageSnapshot[]) => send('usage', { usage: snapshots });
    store.on('change', listener);
    store.on('settings', settingsListener);
    const offUsage: () => void = usageService.subscribe(usageListener);
    // The client re-fetches /api/usage on this event, like it does for settings.
    send('ready', { ok: true });
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 15000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      store.off('change', listener);
      store.off('settings', settingsListener);
      offUsage();
    });
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'This action was not found.')));
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message, ...error.details });
      return;
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && 'type' in error && error.type === 'entity.too.large')
    ) {
      res.status(400).json({ error: 'The request is not valid JSON or is too large.' });
      return;
    }
    if (absent(error)) {
      res.status(404).json({ error: 'The requested folder or file does not exist.' });
      return;
    }
    console.error(error);
    res
      .status(500)
      .json({
        error: 'The local service could not complete this action. Your saved history is preserved.',
      });
  };
  app.use(errorHandler);
  app.locals.store = store;
  app.locals.work = work;
  app.locals.nativeWork = nativeWork;
  app.locals.close = async () => {
    await work.close();
    await nativeWork.close();
  };
  return app;
}
