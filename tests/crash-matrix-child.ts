/**
 * H21 crash matrix: the process `tests/crash-matrix.test.ts` kills.
 *
 * It performs one acknowledged operation, records the acknowledgement, then
 * starts a second operation and SIGKILLs itself at the named durable write
 * boundary - no `close()`, no `finally`, no flush. The parent restarts the
 * same data folder and checks what survived.
 *
 * Usage: crash-matrix-child.ts <root> <scenario> <boundary> [projectId]
 */
import fs from 'node:fs/promises';
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { hash, Store } from '../server/store.js';
import { AutomationOccurrences } from '../server/automations.js';
import { createApp } from '../server/app.js';
import { crashOccurrence, CRASH_TEXT, type CrashBoundary } from './crash-matrix-shared.js';

const [root, scenario, boundary, projectId] = process.argv.slice(2) as [string, string, CrashBoundary, string?];
if (!root || !scenario || !boundary) throw new Error('Invalid crash matrix arguments.');
const data = path.join(root, 'data');

/** Durable before the parent reads it: an acknowledgement nobody can lose. */
function acknowledge(what: string) {
  const file = path.join(root, 'acks.jsonl');
  appendFileSync(file, `${JSON.stringify(what)}\n`);
  const handle = openSync(file, 'r+');
  fsyncSync(handle);
  closeSync(handle);
}
function die(): never {
  writeFileSync(path.join(root, 'reached'), boundary);
  process.kill(process.pid, 'SIGKILL');
  // SIGKILL is not deliverable to a handler; this line is never reached.
  throw new Error('unreachable');
}

type Hook = { rename?: (from: string, to: string) => 'before' | 'after' | null; unlink?: (target: string) => boolean };
let hook: Hook = {};
const rename = fs.rename.bind(fs),
  unlink = fs.unlink.bind(fs);
fs.rename = async (from, to) => {
  const when = hook.rename?.(String(from), String(to)) ?? null;
  if (when === 'before') die();
  await rename(from, to);
  if (when === 'after') die();
};
fs.unlink = async (target) => {
  await unlink(target);
  if (hook.unlink?.(String(target))) die();
};

if (scenario === 'store') {
  if (!projectId) throw new Error('The store scenario needs a project.');
  const store = new Store(data, path.join(root, 'projects'));
  await store.init();
  const folder = store.state(projectId).project.folder;
  const write = (text: string, expected: string | null) =>
    store.writeRecorded(projectId, [{ path: 'Notes.md', text, expected }], { merge: false });
  await write(CRASH_TEXT.one, hash(CRASH_TEXT.zero));
  acknowledge('one');
  const pending = path.join(data, 'pending');
  const stateFile = store.statePath(projectId);
  const object = store.objectPath(projectId, hash(CRASH_TEXT.two)!);
  hook = {
    rename: (_from, to) => {
      if (boundary === 'object-write' && to === object) return 'after';
      if (boundary === 'journal-append' && path.dirname(to) === pending) return 'after';
      if (boundary === 'project-file' && to === path.join(folder, 'Notes.md')) return 'after';
      if (boundary === 'state-temp' && to === stateFile) return 'before';
      if (boundary === 'state-rename' && to === stateFile) return 'after';
      return null;
    },
    unlink: (target) => boundary === 'journal-unlink' && path.dirname(target) === pending,
  };
  await write(CRASH_TEXT.two, hash(CRASH_TEXT.one));
} else if (scenario === 'occurrence') {
  const occurrences = new AutomationOccurrences(data);
  const file = path.join(data, 'workspaces', 'automations', 'org_crash.json');
  if (boundary === 'migration-backup' || boundary === 'migration-rewrite') {
    // The parent seeded a Milestone A (v1) file; opening it migrates it.
    hook = {
      rename: (_from, to) => {
        if (boundary === 'migration-backup' && to.startsWith(`${file}.v1.`) && to.endsWith('.bak')) return 'after';
        if (boundary === 'migration-rewrite' && to === file) return 'after';
        return null;
      },
    };
    await occurrences.init();
  } else {
    await occurrences.init();
    await occurrences.put(crashOccurrence('one'));
    acknowledge('one');
    hook = {
      rename: (_from, to) =>
        to !== file ? null : boundary === 'occurrence-temp' ? 'before' : boundary === 'occurrence-rename' ? 'after' : null,
    };
    await occurrences.put(crashOccurrence('two'));
  }
} else if (scenario === 'claim') {
  if (!projectId) throw new Error('The claim scenario needs a project.');
  const app = await createApp({ dataDir: data, projectRoot: path.join(root, 'projects'), stepMs: 20 });
  const store: Store = app.locals.store;
  const stateFile = store.statePath(projectId);
  /** A claim is written and its admission has not persisted a session yet. */
  const bareClaim = (text: string) => {
    const state = JSON.parse(text) as {
      readyQueue?: { claims: { state: string; commandId: string }[] };
      sessions: { receipt?: { commandId: string } }[];
    };
    const claim = state.readyQueue?.claims.find((item) => item.state === 'claimed');
    return !!claim && !state.sessions.some((session) => session.receipt?.commandId === claim.commandId);
  };
  hook = {
    rename: (from, to) => {
      if (to !== stateFile || !bareClaim(readFileSync(from, 'utf8'))) return null;
      return boundary === 'claim-temp' ? 'before' : boundary === 'claim-rename' ? 'after' : null;
    },
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}/ready-queue`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: JSON.stringify({ autoStart: true }),
    },
  );
  if (response.ok) acknowledge('auto-start');
  // The pass runs behind the lock after the response; give it bounded time to reach the boundary.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
throw new Error(`Boundary ${boundary} of ${scenario} was never reached.`);
