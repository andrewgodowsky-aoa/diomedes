import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { diffLines } from 'diff';
import type {
  Change,
  Conversation,
  DocumentInfo,
  HistoryEntry,
  Owner,
  Project,
  ProjectState,
  Settings,
  Task,
  TaskCandidate,
  TaskState,
  TeamState,
} from '../shared/types.js';
import {
  ApiError,
  absent,
  isContained,
  MAX_TEXT_BYTES,
  projectFile,
  readTextOrNull,
  relativeName,
  safeAbsolute,
  textKind,
} from './paths.js';

export const now = () => new Date().toISOString();
export const hash = (text: string | null) =>
  text === null ? null : createHash('sha256').update(text).digest('hex');
export const identifier = (prefix = '') => prefix + randomBytes(6).toString('hex');
// Folders that never hold Diomedes documents; skipped during the documents walk.
export const SKIPPED_FOLDERS = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  'artifacts',
  'libraries',
  'assets',
  'natives',
  'versions',
  'logs',
  'crash-reports',
  'screenshots',
]);
/** Trim conversation text to a 60-character thread name at a word boundary. */
export function threadNameFromText(text: string): string {
  const collapsed = text.trim().replaceAll(/\s+/g, ' ');
  if (!collapsed) return 'New thread';
  if (collapsed.length <= 60) return collapsed;
  const slice = collapsed.slice(0, 60);
  const boundary = slice.lastIndexOf(' ');
  const trimmed = (boundary > 0 ? slice.slice(0, boundary) : slice).trim();
  return trimmed || 'New thread';
}

export function migrateConversation(
  conversation: Conversation,
  tasks: Task[],
  loadTime: string,
): void {
  // The retired 'work' mode becomes 'build' on every stored turn.
  for (const turn of conversation.turns ?? []) {
    if ((turn as { mode?: unknown }).mode === 'work')
      (turn as { mode?: unknown }).mode = 'build';
  }
  if (conversation.taskId === undefined)
    conversation.taskId =
      conversation.attachedTo.kind === 'task' ? conversation.attachedTo.ref : null;
  if (conversation.helper === undefined) conversation.helper = null;
  if (conversation.requested === undefined) conversation.requested = null;
  if (conversation.permission === undefined) conversation.permission = 'show-first';
  if (conversation.mode === undefined || (conversation.mode as unknown) === 'work') {
    const last = [...(conversation.turns ?? [])].reverse().find((t) => t.mode);
    const raw = (last?.mode as unknown) === 'work' ? 'build' : last?.mode;
    conversation.mode =
      raw === 'ask' || raw === 'plan' || raw === 'build' || raw === 'fix' ? raw : 'ask';
  }
  if (conversation.createdAt === undefined) {
    conversation.createdAt = conversation.turns[0]?.at ?? loadTime;
  }
  if (conversation.updatedAt === undefined) {
    conversation.updatedAt =
      conversation.turns[conversation.turns.length - 1]?.at ?? conversation.createdAt;
  }
  if (conversation.name === undefined || conversation.name === '') {
    const attachedTask =
      conversation.attachedTo.kind === 'task'
        ? tasks.find((t) => t.id === conversation.attachedTo.ref)
        : undefined;
    if (attachedTask) conversation.name = `Thread for ${attachedTask.name}`;
    else {
      const firstYou = conversation.turns.find((t) => t.role === 'you');
      conversation.name = firstYou ? threadNameFromText(firstYou.text) : 'New thread';
    }
  }
}

/**
 * Settings written by an earlier build. The two surfaces were renamed - the
 * Book became the Workbook and the Desk the Console - and 'technical' detail
 * had already been retired into the second surface before that. Old values are
 * read forever and only the current ones are written, so a person who has been
 * running Diomedes does not land on a surface they did not choose.
 */
export function migrateSettings(settings: Settings): void {
  const stored = settings.surface as string | undefined;
  if (stored === 'book') settings.surface = 'workbook';
  else if (stored === 'desk' || stored === 'technical') settings.surface = 'console';
  if (settings.surface === undefined)
    settings.surface = settings.detail === 'technical' ? 'console' : 'workbook';
}

export const emptyTeam = (): TeamState => ({ members: [], messages: [], runs: [] });

export function migrateTeam(state: ProjectState): TeamState {
  if (!state.team) state.team = emptyTeam();
  state.team.members ??= [];
  state.team.messages ??= [];
  state.team.runs ??= [];
  return state.team;
}

export interface TeamMeta {
  idempotency: Record<string, string>;
  blockedBy: Record<string, string[]>;
}
export const emptyTeamMeta = (): TeamMeta => ({ idempotency: {}, blockedBy: {} });

export const defaults = (): Settings => ({
  version: 1,
  detail: 'guided',
  surface: 'workbook',
  onboarding: {
    work: null,
    detail: null,
    familiarity: null,
    resumeAt: 'welcome',
    completedAt: null,
  },
  permissions: {
    changingFiles: true,
    deleting: true,
    sending: false,
    workingOutside: true,
    spending: true,
  },
  explanations: 'persistent',
  appearance: { package: 'deep-field', motion: 'normal' },
  history: { keepDays: 30, maxBytesPerProject: 2147483648 },
  seen: { onlineServiceNotice: false, guidedDescriptors: {}, firstUse: [] },
  openProjects: [],
  lastPage: {},
  tasksView: {},
  services: { codex: false },
});

async function durableWrite(target: string, bytes: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${identifier()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, target);
}
const jsonWrite = (target: string, object: unknown) =>
  durableWrite(target, JSON.stringify(object, null, 2));
async function readJson<T>(target: string, initial: () => T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8')) as T;
  } catch (error) {
    if (absent(error)) return initial();
    throw error;
  }
}

interface StoredState extends ProjectState {
  autoUpdate: boolean;
  teamMeta?: TeamMeta;
}
interface PendingWrite {
  path: string;
  before: string | null;
  after: string | null;
}
interface Journal {
  id: string;
  projectId: string;
  writes: PendingWrite[];
  state: StoredState;
}
export interface WriteInput {
  path: string;
  text: string | null;
  expected: string | null;
}
export interface WriteOptions {
  actor?: Owner;
  kind?: string;
  sentence?: string;
  sessionId?: string | null;
  taskId?: string | null;
  sample?: boolean;
  restoreOf?: string;
  label?: string;
  merge?: boolean;
  review?: boolean;
}

export class Store extends EventEmitter {
  settings = defaults();
  private registry: Project[] = [];
  private states = new Map<string, StoredState>();
  private queue: Promise<unknown> = Promise.resolve();
  private docCache = new Map<
    string,
    { at: number; documents: DocumentInfo[]; inFlight?: Promise<DocumentInfo[]> }
  >();
  readonly projectRoot: string;
  constructor(
    readonly dataDir: string,
    projectRoot?: string,
  ) {
    super();
    this.projectRoot = path.resolve(
      projectRoot ?? path.join(process.cwd(), 'fixtures', 'projects'),
    );
  }
  async init() {
    await safeAbsolute(this.dataDir);
    await safeAbsolute(this.projectRoot);
    await fs.mkdir(path.join(this.dataDir, 'pending'), { recursive: true });
    this.settings = await readJson(path.join(this.dataDir, 'settings.json'), defaults);
    migrateSettings(this.settings);
    this.registry = await readJson(path.join(this.dataDir, 'registry.json'), () => []);
    for (const project of this.registry) {
      const state = await readJson<StoredState>(this.statePath(project.id), () => {
        throw new Error(`Project state is missing for ${project.id}.`);
      });
      const loadTime = now();
      for (const conversation of state.conversations ?? [])
        migrateConversation(conversation, state.tasks ?? [], loadTime);
      migrateTeam(state);
      state.teamMeta ??= emptyTeamMeta();
      state.teamMeta.idempotency ??= {};
      state.teamMeta.blockedBy ??= {};
      this.states.set(project.id, state);
    }
    await this.recover();
    for (const state of this.states.values()) {
      for (const session of state.sessions.filter((item) =>
        ['working', 'waiting', 'queued'].includes(item.state),
      )) {
        session.state = 'stopped';
        session.endedAt = now();
        session.needId = null;
        session.log.push({
          time: now(),
          sentence: 'The local service restarted. Work stopped; recorded changes are in History.',
          level: 'plain',
        });
        const task = state.tasks.find((item) => item.id === session.taskId);
        if (task) {
          task.state = 'todo';
          task.needId = null;
          task.reason = null;
        }
        for (const need of state.needs.filter(
          (item) => item.sessionId === session.id && item.state === 'open',
        )) {
          need.state = 'expired';
          need.decidedAt = now();
        }
        this.addEntry(state, {
          kind: 'stop',
          sentence: 'Work stopped when the local service restarted.',
          sessionId: session.id,
          taskId: session.taskId,
          sample: session.sample,
        });
      }
      await this.persist(state);
    }
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      try {
        return await action();
      } catch (error) {
        // Discard metadata mutations from a rejected request and settle any prepared
        // filesystem operation before admitting another writer.
        await this.recover();
        for (const id of this.states.keys()) {
          const fresh = await readJson(this.statePath(id), () => this.state(id));
          const loadTime = now();
          for (const conversation of (fresh as StoredState).conversations ?? [])
            migrateConversation(conversation, (fresh as StoredState).tasks ?? [], loadTime);
          migrateTeam(fresh as StoredState);
          (fresh as StoredState).teamMeta ??= emptyTeamMeta();
          this.states.set(id, fresh as StoredState);
        }
        this.settings = await readJson(path.join(this.dataDir, 'settings.json'), defaults);
        migrateSettings(this.settings);
        throw error;
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  statePath(id: string) {
    return path.join(this.dataDir, 'projects', id, 'state.json');
  }
  teamSecretsPath(id: string) {
    return path.join(this.dataDir, 'projects', id, 'team-secrets.json');
  }
  async readTeamSecrets(id: string): Promise<Record<string, string>> {
    return readJson<Record<string, string>>(this.teamSecretsPath(id), () => ({}));
  }
  async writeTeamSecrets(id: string, secrets: Record<string, string>) {
    await jsonWrite(this.teamSecretsPath(id), secrets);
  }
  team(id: string) {
    return migrateTeam(this.state(id));
  }
  teamMeta(id: string): TeamMeta {
    const state = this.state(id);
    state.teamMeta ??= emptyTeamMeta();
    state.teamMeta.idempotency ??= {};
    state.teamMeta.blockedBy ??= {};
    return state.teamMeta;
  }
  objectPath(id: string, sha: string) {
    return path.join(this.dataDir, 'projects', id, 'history', 'objects', sha);
  }
  state(id: string) {
    const state = this.states.get(id);
    if (!state) throw new ApiError(404, 'This project was not found.');
    return state;
  }
  async object(id: string, sha: string | null) {
    return sha === null ? null : fs.readFile(this.objectPath(id, sha), 'utf8');
  }
  private async saveObject(id: string, text: string | null) {
    const sha = hash(text);
    if (text !== null && sha) await durableWrite(this.objectPath(id, sha), text);
    return sha;
  }
  async persist(state: StoredState) {
    migrateTeam(state);
    state.teamMeta ??= emptyTeamMeta();
    this.refreshCounts(state);
    // The documents listing is a cache, never persisted: it can hold 10,000 rows
    // and would otherwise be rewritten with fsync on every change.
    await jsonWrite(this.statePath(state.project.id), { ...state, documents: [] });
    this.states.set(state.project.id, state);
    this.emit('change', state.project.id);
  }
  /** Cheap fingerprint for the documents cache: count plus a hash of path+size+changedAt. */
  private documentsFingerprint(documents: DocumentInfo[]): string {
    const digest = createHash('sha256');
    for (const doc of documents) digest.update(`${doc.path}\0${doc.size}\0${doc.changedAt}\n`);
    return `${documents.length}:${digest.digest('hex')}`;
  }
  /** Walk in the background and emit 'change' only when the listing actually changed. */
  async refreshDocuments(id: string): Promise<DocumentInfo[]> {
    const cached = this.docCache.get(id);
    if (cached?.inFlight) return cached.inFlight;
    const previous = cached ? this.documentsFingerprint(cached.documents) : null;
    const entry = cached ?? { at: 0, documents: [] as DocumentInfo[] };
    this.docCache.set(id, entry);
    const flight = this.walkDocuments(id)
      .then((documents) => {
        entry.at = Date.now();
        const next = this.documentsFingerprint(documents);
        const changed = previous === null || previous !== next;
        entry.documents = documents;
        try {
          this.state(id).documents = documents;
        } catch {
          // Project may have been removed while the walk was in flight.
        }
        if (entry.inFlight === flight) delete entry.inFlight;
        if (changed) this.emit('change', id);
        return documents;
      })
      .catch((error) => {
        if (entry.inFlight === flight) delete entry.inFlight;
        throw error;
      });
    entry.inFlight = flight;
    return flight;
  }
  /** Mark the cached listing stale and kick a background refresh after a Diomedes folder write. */
  private invalidateDocuments(id: string): void {
    const cached = this.docCache.get(id);
    if (cached?.inFlight) {
      // A walk that began before this write may miss it: walk once more when it lands.
      void cached.inFlight.then(
        () => {
          cached.at = 0;
          return this.refreshDocuments(id);
        },
        () => undefined,
      ).catch(() => undefined);
      return;
    }
    if (cached) cached.at = 0;
    void this.refreshDocuments(id).catch(() => undefined);
  }
  private refreshCounts(state: StoredState) {
    state.project.counts = {
      running: state.sessions.filter((s) => ['working', 'queued'].includes(s.state)).length,
      changesWaiting: state.changes.filter((c) => c.state === 'waiting').length,
      waitingForYou: state.needs.filter((n) => n.state === 'open').length,
      historyToday: state.history.filter((h) => h.time.slice(0, 10) === now().slice(0, 10)).length,
    };
    state.project.status = {
      needsYou: state.project.counts.waitingForYou,
      working: state.project.counts.running,
      tasksDone: state.tasks.filter((t) => t.state === 'done').length,
      tasksTotal: state.tasks.length,
    };
  }
  async projects() {
    const projects = [];
    for (const item of this.registry) {
      const state = this.state(item.id);
      await this.checkFolder(state);
      this.refreshCounts(state);
      projects.push(state.project);
    }
    return projects;
  }
  async checkFolder(state: StoredState) {
    try {
      await safeAbsolute(state.project.folder);
      state.project.missing = !(await fs.stat(state.project.folder)).isDirectory();
    } catch (error) {
      if (!absent(error)) throw error;
      state.project.missing = true;
    }
  }
  async createProject(name: string, requestedFolder?: string, open = false) {
    if (!name.trim() || name.length > 120)
      throw new ApiError(400, 'Give this project a name of up to 120 characters.');
    const folder = await safeAbsolute(
      path.resolve(requestedFolder || path.join(this.projectRoot, relativeName(name))),
    );
    if (isContained(this.dataDir, folder) || isContained(folder, this.dataDir))
      throw new ApiError(403, 'App data cannot be used as a project.');
    if (this.registry.some((p) => path.resolve(p.folder).toLowerCase() === folder.toLowerCase()))
      throw new ApiError(409, 'This folder is already a project.');
    if (open) {
      if (!(await fs.stat(folder)).isDirectory()) throw new ApiError(400, 'Choose a folder.');
    } else await fs.mkdir(folder, { recursive: true });
    const project: Project = {
      id: identifier(),
      name: name.trim(),
      folder,
      createdAt: now(),
      lastOpenedAt: now(),
      plans: [],
      references: [],
      repository: { present: false },
      leftOff: null,
      counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
      status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 },
    };
    try {
      await fs.lstat(path.join(folder, '.git'));
      project.repository.present = true;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const state: StoredState = {
      project,
      documents: [],
      tasks: [],
      needs: [],
      sessions: [],
      history: [],
      changes: [],
      conversations: [],
      autoUpdate: false,
      team: emptyTeam(),
      teamMeta: emptyTeamMeta(),
    };
    await this.persist(state);
    this.registry.push(project);
    await jsonWrite(path.join(this.dataDir, 'registry.json'), this.registry);
    this.settings.openProjects.push(project.id);
    await this.saveSettings(this.settings);
    return project;
  }
  async saveSettings(input: Settings) {
    this.settings = structuredClone(input);
    await jsonWrite(path.join(this.dataDir, 'settings.json'), this.settings);
    this.emit('settings', this.settings);
    return this.settings;
  }
  /** Explicit listing: awaits a fresh walk (Files tab and pickers call this on demand). */
  async listDocuments(id: string): Promise<DocumentInfo[]> {
    return this.refreshDocuments(id);
  }
  private async walkDocuments(id: string): Promise<DocumentInfo[]> {
    const state = this.state(id);
    await this.checkFolder(state);
    if (state.project.missing) return [];
    const waiting = new Set<string>();
    for (const change of state.changes) if (change.state === 'waiting') waiting.add(change.path);
    const recorded = new Set<string>();
    for (const entry of state.history)
      for (const file of entry.files) if (file.recorded) recorded.add(file.path);
    const documents: DocumentInfo[] = [];
    const walk = async (folder: string, prefix = ''): Promise<void> => {
      const dirents = await fs.readdir(folder, { withFileTypes: true });
      const files: { relative: string; absolute: string }[] = [];
      const subdirs: { relative: string; absolute: string }[] = [];
      for (const item of dirents) {
        if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
        if (item.isDirectory() && SKIPPED_FOLDERS.has(item.name)) continue;
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        let absolute: string;
        try {
          absolute = (await projectFile(state.project.folder, relative)).absolute;
        } catch (error) {
          if (error instanceof ApiError && [400, 403].includes(error.status)) continue;
          throw error;
        }
        if (item.isDirectory()) {
          if (documents.length < 10000) subdirs.push({ relative, absolute });
        } else if (item.isFile()) {
          files.push({ relative, absolute });
        }
        // Stop collecting at the cap; entries beyond it are ignored.
        if (documents.length + files.length >= 10000) break;
      }
      for (let index = 0; index < files.length && documents.length < 10000; index += 32) {
        const batch = files.slice(index, index + 32);
        const stats = await Promise.all(
          batch.map(async (file) => {
            try {
              return { file, stat: await fs.stat(file.absolute) };
            } catch (error) {
              if (absent(error)) return null;
              throw error;
            }
          }),
        );
        for (const item of stats) {
          if (!item || documents.length >= 10000) continue;
          documents.push({
            path: item.file.relative,
            kind: state.project.plans.includes(item.file.relative)
              ? 'plan'
              : textKind(item.file.relative),
            size: item.stat.size,
            changedAt: item.stat.mtime.toISOString(),
            hasChangesWaiting: waiting.has(item.file.relative),
            recorded: recorded.has(item.file.relative),
          });
        }
      }
      for (const sub of subdirs) {
        if (documents.length >= 10000) break;
        await walk(sub.absolute, sub.relative);
      }
    };
    await walk(state.project.folder);
    return documents.sort((a, b) => a.path.localeCompare(b.path));
  }
  async current(id: string, input: string) {
    const file = await projectFile(this.state(id).project.folder, input);
    return readTextOrNull(file.absolute);
  }
  latestFile(state: StoredState, name: string) {
    for (const entry of [...state.history].reverse()) {
      const file = entry.files.find((f) => f.path === name);
      if (file) return { entry, file };
    }
    return null;
  }
  async readDocument(id: string, input: string) {
    const state = this.state(id);
    const name = relativeName(input);
    const text = await this.current(id, name);
    const sha = hash(text);
    const last = this.latestFile(state, name);
    let outsideChange: HistoryEntry | null = null;
    if (last && last.file.after !== sha) {
      await this.saveObject(id, text);
      outsideChange = this.addEntry(state, {
        kind: 'outside',
        sentence: `${name} changed outside Diomedes`,
      });
      outsideChange.files.push({
        path: name,
        op: text === null ? 'deleted' : last.file.after === null ? 'created' : 'modified',
        before: last.file.after,
        after: sha,
        recorded: true,
        reason: null,
      });
      await this.persist(state);
    } else if (!last && text !== null) {
      await this.saveObject(id, text);
      const entry = this.addEntry(state, {
        kind: 'observed',
        sentence: `Diomedes recorded the first version it read of ${name}`,
      });
      entry.files.push({
        path: name,
        op: 'modified',
        before: sha,
        after: sha,
        recorded: true,
        reason: null,
      });
      await this.persist(state);
    }
    if (text === null || sha === null)
      throw new ApiError(404, 'This document no longer exists.', { outsideChange });
    return { path: name, text, sha, outsideChange };
  }
  addEntry(state: StoredState, options: WriteOptions): HistoryEntry {
    const entry: HistoryEntry = {
      id: identifier('E'),
      time: now(),
      actor: options.actor ?? 'you',
      kind: options.kind ?? 'edited',
      sentence: options.sentence ?? 'You edited a document',
      sessionId: options.sessionId ?? null,
      taskId: options.taskId ?? null,
      sample: options.sample ?? false,
      files: [],
      label: options.label ?? null,
      restoreOf: options.restoreOf ?? null,
      replaced: null,
      versionId: `v${String(state.history.length + 1).padStart(4, '0')}`,
      commit: null,
    };
    state.history.push(entry);
    return entry;
  }
  async writeRecorded(id: string, inputs: WriteInput[], options: WriteOptions = {}) {
    const source = this.state(id);
    const state = structuredClone(source);
    const checked: PendingWrite[] = [];
    if (new Set(inputs.map((i) => relativeName(i.path).toLowerCase())).size !== inputs.length)
      throw new ApiError(400, 'A file may appear only once in a write.');
    for (const input of inputs) {
      const name = relativeName(input.path);
      if (
        input.text !== null &&
        (Buffer.byteLength(input.text) > MAX_TEXT_BYTES || input.text.includes('\0'))
      )
        throw new ApiError(413, 'Write UTF-8 text of no more than 8 MB.');
      const beforeText = await this.current(id, name);
      const before = hash(beforeText);
      if (before !== input.expected)
        throw new ApiError(
          409,
          'This document changed since you opened it. Read its current version before saving.',
          { path: name, currentSha: before },
        );
      await this.saveObject(id, beforeText);
      const after = await this.saveObject(id, input.text);
      checked.push({ path: name, before, after });
    }
    let entry: HistoryEntry | undefined;
    if (options.merge !== false && options.sessionId)
      entry = [...state.history]
        .reverse()
        .find((e) => e.kind === 'changed' && e.sessionId === options.sessionId);
    else if (
      options.merge !== false &&
      (options.actor ?? 'you') === 'you' &&
      (options.kind ?? 'edited') === 'edited' &&
      checked.length === 1
    ) {
      const last = state.history.at(-1);
      if (
        last?.kind === 'edited' &&
        last.actor === 'you' &&
        last.files.length === 1 &&
        last.files[0].path === checked[0].path &&
        Date.now() - Date.parse(last.time) < 600000
      )
        entry = last;
    }
    entry ??= this.addEntry(state, {
      ...options,
      sentence: options.sentence ?? `You edited ${checked.map((f) => f.path).join(', ')}`,
    });
    for (const file of checked) {
      const previous = entry.files.find((f) => f.path === file.path);
      if (previous) {
        previous.after = file.after;
        previous.op =
          previous.before === null ? 'created' : file.after === null ? 'deleted' : 'modified';
      } else
        entry.files.push({
          ...file,
          op: file.before === null ? 'created' : file.after === null ? 'deleted' : 'modified',
          recorded: true,
          reason: null,
        });
    }
    entry.time = now();
    if (options.sessionId) {
      entry.sentence = `Diomedes changed ${entry.files.length} ${entry.files.length === 1 ? 'file' : 'files'}`;
      const session = state.sessions.find((s) => s.id === options.sessionId);
      if (session && !session.entryIds.includes(entry.id)) session.entryIds.push(entry.id);
    }
    if (options.review || options.sessionId) {
      for (const [index, file] of entry.files.entries()) {
        const changeId = `${entry.id}:${index}`;
        const existing = state.changes.find((c) => c.id === changeId);
        const change = await this.changeFromFile(id, entry, index);
        change.current = change.after;
        change.changedSince = null;
        if (existing) Object.assign(existing, change);
        else state.changes.push(change);
        const task = state.tasks.find((t) => t.id === options.taskId);
        if (task && !task.changeIds.includes(changeId)) task.changeIds.push(changeId);
      }
    }
    const journal: Journal = { id: identifier(), projectId: id, writes: checked, state };
    const journalPath = path.join(this.dataDir, 'pending', `${journal.id}.json`);
    // Both images and the complete intended metadata are durable before touching a project.
    await jsonWrite(journalPath, journal);
    try {
      for (const file of checked) await this.applyWrite(id, file, entry.id);
      await this.persist(state);
      this.invalidateDocuments(id);
      await fs.unlink(journalPath);
    } catch (error) {
      // Settle prepared writes before a worker records its failure, so its count
      // includes any files that reached disk and a later recovery cannot hide it.
      await this.recover();
      throw error;
    }
    return entry;
  }
  private async applyWrite(id: string, file: PendingWrite, entryId: string) {
    const absolute = (await projectFile(this.state(id).project.folder, file.path)).absolute;
    const actual = hash(await readTextOrNull(absolute));
    if (actual === file.after) return;
    if (actual !== file.before)
      throw new ApiError(
        409,
        'A file changed while this operation was being saved. Its current content was preserved.',
        { path: file.path },
      );
    if (file.after === null) {
      if (actual !== null) {
        const removed = path.join(
          this.dataDir,
          'projects',
          id,
          'history',
          'removed',
          entryId,
          file.path,
        );
        await durableWrite(removed, (await this.object(id, actual))!);
        await projectFile(this.state(id).project.folder, file.path);
        await fs.unlink(absolute);
      }
    } else {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await projectFile(this.state(id).project.folder, file.path);
      await durableWrite(absolute, (await this.object(id, file.after))!);
    }
  }
  private async recover() {
    const pending = path.join(this.dataDir, 'pending');
    for (const name of (await fs.readdir(pending)).filter((n) => n.endsWith('.json')).sort()) {
      const journal = JSON.parse(await fs.readFile(path.join(pending, name), 'utf8')) as Journal;
      this.state(journal.projectId);
      for (const file of journal.writes) {
        const actual = await this.current(journal.projectId, file.path);
        const actualHash = hash(actual);
        if (actualHash === file.before || actualHash === file.after)
          await this.applyWrite(journal.projectId, file, journal.id);
        else {
          await this.saveObject(journal.projectId, actual);
          const entry = this.addEntry(journal.state, {
            kind: 'outside',
            sentence: `${file.path} changed during an interrupted save; its current content was preserved`,
          });
          entry.files.push({
            path: file.path,
            before: file.after,
            after: actualHash,
            op: actual === null ? 'deleted' : 'modified',
            recorded: true,
            reason: null,
          });
        }
      }
      await this.persist(journal.state);
      await fs.unlink(path.join(pending, name));
    }
  }
  async changeFromFile(id: string, entry: HistoryEntry, index: number): Promise<Change> {
    const file = entry.files[index];
    if (!file.recorded)
      return {
        id: `${entry.id}:${index}`,
        entryId: entry.id,
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        path: file.path,
        op: file.op,
        summary: `This file was not recorded: ${file.reason ?? 'unsupported content'}`,
        before: null,
        after: null,
        current: null,
        changedSince: null,
        hunks: [],
        state: 'waiting',
      };
    const before = await this.object(id, file.before),
      after = await this.object(id, file.after),
      current = await this.current(id, file.path);
    const latest = this.latestFile(this.state(id), file.path);
    return {
      id: `${entry.id}:${index}`,
      entryId: entry.id,
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      path: file.path,
      op: file.op,
      summary: `${file.op === 'created' ? 'Added' : file.op === 'deleted' ? 'Removed' : 'Updated'} ${file.path}`,
      before,
      after,
      current,
      changedSince:
        hash(current) === file.after
          ? null
          : {
              actor:
                latest && latest.entry.id !== entry.id ? latest.entry.actor : 'outside Diomedes',
              at: latest?.entry.time ?? now(),
            },
      hunks: diffLines(before ?? '', after ?? ''),
      state: 'waiting',
    };
  }
  async snapshot(id: string, label: string | null, sessionId: string | null = null) {
    const state = this.state(id);
    const documents = await this.listDocuments(id);
    const whole = documents.length <= 2000;
    const files = whole ? documents : documents.filter((d) => this.latestFile(state, d.path));
    const entry = this.addEntry(state, {
      kind: 'saved-version',
      sentence: `${sessionId ? 'Diomedes' : 'You'} saved a version${label ? `: ${label}` : ''} (${whole ? 'whole folder' : 'files Diomedes has worked on'})`,
      label: label ?? undefined,
      sessionId,
      actor: sessionId ? 'diomedes' : 'you',
    });
    for (const file of files) {
      if (file.kind === 'unsupported' || file.size > MAX_TEXT_BYTES) {
        entry.files.push({
          path: file.path,
          op: 'modified',
          before: null,
          after: null,
          recorded: false,
          reason: file.size > MAX_TEXT_BYTES ? 'Larger than 8 MB' : 'Unsupported file type',
        });
        continue;
      }
      try {
        const text = await this.current(id, file.path);
        const sha = await this.saveObject(id, text);
        entry.files.push({
          path: file.path,
          op: 'modified',
          before: sha,
          after: sha,
          recorded: true,
          reason: null,
        });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 415)) throw error;
        entry.files.push({
          path: file.path,
          op: 'modified',
          before: null,
          after: null,
          recorded: false,
          reason: 'Not UTF-8 text',
        });
      }
    }
    const missed = entry.files.filter((f) => !f.recorded).length;
    if (missed) entry.sentence += `; ${missed} files could not be saved to History`;
    await this.persist(state);
    return entry;
  }
  async restore(
    id: string,
    entryId: string,
    selected?: string[],
    mode?: 'all' | 'unchanged-only' | 'copies',
  ) {
    const state = this.state(id);
    const entry = state.history.find((e) => e.id === entryId);
    if (!entry) throw new ApiError(404, 'This history entry was not found.');
    if (selected?.some((name) => !entry.files.some((f) => f.path === name)))
      throw new ApiError(400, 'A selected file is not part of this entry.');
    const files = entry.files.filter((f) => f.recorded && (!selected || selected.includes(f.path)));
    // A whole-folder saved version also represents the absence of later files.
    // Preserve any such contents in the restore's before-images before removal.
    if (entry.kind === 'saved-version' && entry.sentence.includes('(whole folder)') && !selected) {
      const documents = await this.listDocuments(id);
      for (const document of documents)
        if (
          document.kind !== 'unsupported' &&
          document.size <= MAX_TEXT_BYTES &&
          !entry.files.some((file) => file.path === document.path)
        ) {
          files.push({
            path: document.path,
            op: 'created',
            before: null,
            after: null,
            recorded: true,
            reason: null,
          });
        }
    }
    const running = state.sessions.find((s) => ['working', 'waiting', 'queued'].includes(s.state));
    if (running)
      throw new ApiError(409, 'Stop the current work before restoring files.', {
        inProgress: { sessionId: running.id, taskId: running.taskId, path: files[0]?.path ?? '' },
      });
    const currents = await Promise.all(
      files.map(async (f) => ({ file: f, text: await this.current(id, f.path) })),
    );
    const conflicts = currents
      .filter(
        ({ file, text }) => hash(text) !== file.after && !(file.op === 'created' && text === null),
      )
      .map(({ file }) => {
        const last = this.latestFile(state, file.path);
        return {
          path: file.path,
          actor: last && last.entry.id !== entry.id ? last.entry.actor : 'outside Diomedes',
          at: last?.entry.time ?? now(),
        };
      });
    if (conflicts.length && !mode)
      throw new ApiError(409, `${conflicts.length} files changed since this version.`, {
        conflicts,
      });
    const changes: WriteInput[] = [];
    for (const { file, text } of currents) {
      const conflict = conflicts.some((c) => c.path === file.path);
      if (mode === 'unchanged-only' && conflict) continue;
      const before = await this.object(id, file.before);
      if (mode === 'copies') {
        if (before === null) continue;
        const parsed = path.posix.parse(file.path);
        const copy = path.posix.join(
          parsed.dir,
          `${parsed.name} (restored ${now().replaceAll(':', '-').slice(0, 19)} ${identifier().slice(0, 4)})${parsed.ext}`,
        );
        changes.push({ path: copy, text: before, expected: null });
      } else {
        if (conflict && mode === 'all') {
          const sha = await this.saveObject(id, text);
          const replaced = this.addEntry(state, {
            kind: 'replaced-by-restore',
            sentence: `${file.path} was saved before restore replaced its newer content`,
          });
          replaced.files.push({
            path: file.path,
            op: 'modified',
            before: sha,
            after: sha,
            recorded: true,
            reason: null,
          });
          replaced.replaced = entryId;
          await this.persist(state);
        }
        changes.push({ path: file.path, text: before, expected: hash(text) });
      }
    }
    const restored = await this.writeRecorded(id, changes, {
      kind: 'restore',
      sentence: `You restored ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`,
      restoreOf: entryId,
      merge: false,
    });
    if (mode !== 'copies') {
      const fresh = this.state(id);
      for (const change of fresh.changes)
        if (change.entryId === entryId && changes.some((file) => file.path === change.path))
          change.state = 'undone';
      await this.persist(fresh);
    }
    return { entryId: restored.id, conflicts, entry: restored };
  }
  createTask(
    state: StoredState,
    input: { name: string; description?: string; owner?: Owner; from?: Task['from'] },
  ): Task {
    if (!input.name.trim()) throw new ApiError(400, 'Give this task a name.');
    const ids = state.tasks.map((t) => Number(t.id.slice(1))).filter(Number.isFinite);
    const task: Task = {
      id: `T${Math.max(0, ...ids) + 1}`,
      name: input.name.trim().slice(0, 200),
      description: input.description ?? '',
      from: input.from ?? null,
      owner: input.owner ?? 'you',
      state: 'todo',
      reason: null,
      needId: null,
      sessionIds: [],
      changeIds: [],
      createdBy: 'you',
      createdAt: now(),
      moves: [],
    };
    state.tasks.push(task);
    return task;
  }
  moveTask(state: StoredState, task: Task, target: TaskState, by: Owner = 'you') {
    if (task.state === target) return;
    const previous = task.state;
    task.state = target;
    task.moves.push({
      at: now(),
      by,
      from: previous,
      to: target,
      undoUntil: new Date(Date.now() + (by === 'you' ? 60000 : 3600000)).toISOString(),
      undone: false,
    });
    const labels: Record<TaskState, string> = {
      todo: 'To do',
      working: 'Working',
      waiting: 'Waiting for you',
      done: 'Done',
    };
    this.addEntry(state, {
      kind: 'task-moved',
      sentence: `${by === 'you' ? 'You' : 'Diomedes'} moved ${task.name} to ${labels[target]}`,
      actor: by,
      taskId: task.id,
    });
  }
  async projectState(id: string): Promise<ProjectState> {
    const state = this.state(id);
    // Never walk on the request path: serve the cached listing and refresh in the background.
    const cached = this.docCache.get(id);
    // Ninety seconds: a walk of a 190k-file folder still costs about 11 s of disk time.
    if (!cached || Date.now() - cached.at > 90000) {
      if (!cached) this.docCache.set(id, { at: 0, documents: [] });
      const entry = this.docCache.get(id)!;
      if (!entry.inFlight) void this.refreshDocuments(id).catch(() => undefined);
    }
    const documents = this.docCache.get(id)?.documents ?? [];
    this.refreshCounts(state);
    if (!state.project.missing)
      for (const change of state.changes) {
        const current = await this.current(id, change.path);
        change.current = current;
        const latest = this.latestFile(state, change.path);
        change.changedSince =
          hash(current) === hash(change.after)
            ? null
            : {
                actor:
                  latest && latest.entry.id !== change.entryId
                    ? latest.entry.actor
                    : 'outside Diomedes',
                at: latest?.entry.time ?? now(),
              };
      }
    migrateTeam(state);
    const clone = structuredClone(state) as StoredState;
    delete (clone as Partial<StoredState>).teamMeta;
    clone.documents = [...documents];
    return clone;
  }
}

export function findTasks(text: string): TaskCandidate[] {
  const found: TaskCandidate[] = [];
  let fenced = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s*(?:\d+[.)]|[-*\u2022])\s+(.*)$/.exec(line);
    if (!match || /^\[[xX]\]\s*/.test(match[1]) || /\bT\d+\s*$/.test(match[1])) continue;
    const name = match[1]
      .replace(/^\[ \]\s*/, '')
      .trim()
      .slice(0, 80);
    if (!name) continue;
    found.push({
      line: index + 1,
      name: name[0].toUpperCase() + name.slice(1),
      owner: /^(call|ask|phone|email|meet|sign|pay|visit|decide|choose)\b/i.test(name)
        ? 'you'
        : 'diomedes-with-ok',
    });
  }
  return found;
}
