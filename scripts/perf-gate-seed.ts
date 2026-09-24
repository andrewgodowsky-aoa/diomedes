// The performance gate's synthetic project (scripts/perf-gate.ts).
//
// One real project is made through the Store first, so every record the gate
// multiplies has the exact shape this build writes: a task, its `tasks-made`
// entry and a recorded `modified` edit with its History objects. Those records
// are then cloned with fixed ids, fixed timestamps and fixed file contents and
// written back in one go. Going through the API ten thousand times would spend
// minutes fsyncing a growing state.json and measure the seeder, not the app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, bytesHash } from '../server/store.js';
import type { HistoryEntry, ProjectState, Task } from '../shared/types.js';

export interface SyntheticSize {
  historyEntries: number;
  files: number;
  tasks: number;
}
export const FULL_SIZE: SyntheticSize = { historyEntries: 10000, files: 2000, tasks: 500 };
export const SMALL_SIZE: SyntheticSize = { historyEntries: 500, files: 100, tasks: 50 };

/** Fixed, so two seeds of the same size write byte-identical project state. */
export const PERF_PROJECT_ID = 'perfgate0001';
const BASE_TIME = Date.parse('2026-01-05T09:00:00.000Z');
const FILES_PER_FOLDER = 50;
const TASK_STATES: Task['state'][] = ['todo', 'todo', 'todo', 'done'];

const at = (minutes: number) => new Date(BASE_TIME + minutes * 60000).toISOString();
const entryId = (n: number) => `E${n.toString(16).padStart(12, '0')}`;
export const syntheticFilePath = (n: number) =>
  `area-${String(Math.floor(n / FILES_PER_FOLDER)).padStart(3, '0')}/note-${String(n).padStart(5, '0')}.md`;
const fileText = (n: number) =>
  `# Note ${n}\n\nSynthetic content for the performance gate. Line ${n % 97} of a fixed pattern.\n` +
  'Nothing here is read for meaning; only its size and name matter.\n';

export async function seedSyntheticProject(
  root: string,
  size: SyntheticSize,
): Promise<{ dataDir: string; projectsDir: string; projectId: string; folder: string }> {
  if (size.tasks > size.historyEntries)
    throw new Error('Each task has a History entry, so tasks cannot exceed entries.');
  const dataDir = path.join(root, 'data');
  const projectsDir = path.join(root, 'projects');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });

  // Templates from the real write paths.
  const store = new Store(dataDir, projectsDir);
  await store.init();
  const created = await store.createProject('Perf gate');
  const first = '# Seed\n\nFirst version.\n';
  await store.locked(() =>
    store.writeRecorded(created.id, [{ path: 'seed.md', text: first, expected: null }]),
  );
  await store.locked(() =>
    store.writeRecorded(
      created.id,
      [
        {
          path: 'seed.md',
          text: '# Seed\n\nSecond version.\n',
          expected: bytesHash(Buffer.from(first)),
        },
      ],
      { merge: false },
    ),
  );
  await store.locked(async () => {
    const state = store.state(created.id);
    const task = store.createTask(state, { name: 'Template task', description: 'Template.' });
    store.addEntry(state, {
      kind: 'tasks-made',
      sentence: `You made a task: ${task.name}`,
      taskId: task.id,
    });
    await store.persist(state);
  });

  // Swap the random project id for a fixed one everywhere it was written.
  const oldId = created.id;
  const rewrite = async (file: string) =>
    fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll(oldId, PERF_PROJECT_ID));
  await rewrite(path.join(dataDir, 'registry.json'));
  await rewrite(path.join(dataDir, 'settings.json'));
  await rewrite(store.statePath(oldId));
  await fs.rename(
    path.join(dataDir, 'projects', oldId),
    path.join(dataDir, 'projects', PERF_PROJECT_ID),
  );
  const statePath = store.statePath(PERF_PROJECT_ID);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as ProjectState;

  const edited = state.history.find((entry) => entry.files[0]?.op === 'modified');
  const made = state.history.find((entry) => entry.kind === 'tasks-made');
  const taskTemplate = state.tasks[0];
  if (!edited || !made || !taskTemplate)
    throw new Error('The template project is missing a record.');

  state.project.createdAt = at(-60);
  state.project.lastOpenedAt = at(-60);
  state.tasks = [];
  state.history = [];
  // Tasks are made first, then edits spread over the files, one minute apart.
  for (let n = 0; n < size.historyEntries; n++) {
    let entry: HistoryEntry;
    if (n < size.tasks) {
      const task: Task = {
        ...structuredClone(taskTemplate),
        id: `T${n + 1}`,
        name: `Synthetic task ${n + 1}`,
        description: `Fixed description for synthetic task ${n + 1}.`,
        state: TASK_STATES[n % TASK_STATES.length],
        createdAt: at(n),
      };
      state.tasks.push(task);
      entry = {
        ...structuredClone(made),
        sentence: `You made a task: ${task.name}`,
        taskId: task.id,
      };
    } else {
      entry = structuredClone(edited);
      entry.files[0].path = syntheticFilePath(n % Math.max(1, size.files));
      entry.sentence = `You edited ${entry.files[0].path}`;
    }
    entry.id = entryId(n + 1);
    entry.time = at(n);
    entry.versionId = `v${String(n + 1).padStart(4, '0')}`;
    state.history.push(entry);
  }
  await fs.writeFile(statePath, JSON.stringify({ ...state, documents: [] }, null, 2));

  // The project folder: fixed names, fixed bytes, fixed mtimes. The template's
  // own file goes, so the folder holds exactly `size.files` documents.
  const folder = state.project.folder;
  await fs.rm(path.join(folder, 'seed.md'));
  const mtime = new Date(BASE_TIME);
  for (let dir = 0; dir * FILES_PER_FOLDER < size.files; dir++)
    await fs.mkdir(path.join(folder, path.dirname(syntheticFilePath(dir * FILES_PER_FOLDER))), {
      recursive: true,
    });
  for (let n = 0; n < size.files; n += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, size.files - n) }, async (_, offset) => {
        const file = path.join(folder, syntheticFilePath(n + offset));
        await fs.writeFile(file, fileText(n + offset));
        await fs.utimes(file, mtime, mtime);
      }),
    );
  return { dataDir, projectsDir, projectId: PERF_PROJECT_ID, folder };
}
