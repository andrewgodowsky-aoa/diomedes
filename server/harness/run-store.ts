/**
 * Where harness runs live. One JSON file per run, written the way `Store`
 * writes `state.json`: to a temporary file, fsynced, then renamed over the
 * target. Runs are bounded (a capability has `maxTurns`), so the whole record
 * including its events fits one file and one atomic write; an append-only
 * journal with compaction is the H03 step. The interface hides the driver so
 * that step can change it without touching the run service.
 *
 * Cross-process atomicity is not provided here. One Diomedes service owns a
 * data folder (`server/lock.ts`); within it the run service serializes writes
 * per run. Two services over one folder are a test arrangement for fencing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { HarnessRun } from '../../shared/harness.js';
import { MigrationRefusal, migrateRecord } from '../migrations/framework.js';
import { HARNESS_RUN } from '../migrations/registry.js';
import { HarnessError } from './policy.js';

export interface RunStore {
  create(run: HarnessRun): Promise<void>;
  read(runId: string): Promise<HarnessRun | null>;
  write(run: HarnessRun): Promise<void>;
  list(): Promise<string[]>;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID.test(value))
    throw new HarnessError('invalid_run_id', 'A run id is letters, digits, dots, dashes or underscores.');
  return value;
}

const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Windows refuses to rename over a file while any handle is open on it, even a
 * share-delete one. The run service polls `read` every few milliseconds, and
 * under CPU load a read's open to close span (several thread-pool hops) leaves a
 * handle open on most polls, so the rename kept colliding with this process's
 * own reader and sometimes outlasted the retry window below. Within one process
 * the store therefore lets reads of a file overlap each other, but makes the
 * replacement wait for reads in flight and makes new reads wait for it. A
 * scanner or another process still holds files outside this gate, which is what
 * the bounded retry is for.
 */
interface Gate { readers: number; writer: Promise<void> | null; drained: Array<() => void>; users: number }
const gates = new Map<string, Gate>();

function gateFor(file: string): Gate {
  let gate = gates.get(file);
  if (!gate) { gate = { readers: 0, writer: null, drained: [], users: 0 }; gates.set(file, gate); }
  gate.users++;
  return gate;
}

function leave(file: string, gate: Gate) {
  if (--gate.users === 0 && gates.get(file) === gate) gates.delete(file);
}

async function reading<T>(file: string, action: () => Promise<T>): Promise<T> {
  const gate = gateFor(file);
  try {
    while (gate.writer) await gate.writer;
    gate.readers++;
    try { return await action(); }
    finally {
      if (--gate.readers === 0) for (const wake of gate.drained.splice(0)) wake();
    }
  } finally { leave(file, gate); }
}

async function replacing<T>(file: string, action: () => Promise<T>): Promise<T> {
  const gate = gateFor(file);
  try {
    const previous = gate.writer;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    gate.writer = mine;
    try {
      if (previous) await previous;
      while (gate.readers > 0) await new Promise<void>((resolve) => gate.drained.push(resolve));
      return await action();
    } finally {
      if (gate.writer === mine) gate.writer = null;
      release();
    }
  } finally { leave(file, gate); }
}

async function durableWrite(target: string, bytes: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Windows can temporarily deny replacement while a reader or scanner has the
  // destination open. A short-lived reader can outlast the former 300 ms retry
  // window. Backoff delays total 1.55 seconds across the same six attempts.
  // Retry only this atomic rename; never repeat a handler or remove the old
  // record. Permanent failures still surface with the temp intact.
  await replacing(target, async () => {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, target); return; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !(error instanceof Error) ||
            !('code' in error) || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error;
        await delay(50 * 2 ** attempt);
      }
    }
  });
}

export class FileRunStore implements RunStore {
  constructor(readonly dir: string) {}
  private file(runId: string) {
    return path.join(this.dir, `${validateRunId(runId)}.json`);
  }
  async create(run: HarnessRun) {
    const target = this.file(run.id);
    try {
      await fs.access(target);
      throw new HarnessError('run_exists', `Run ${run.id} already exists.`);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    await durableWrite(target, JSON.stringify(run));
  }
  async read(runId: string): Promise<HarnessRun | null> {
    let text: string;
    try {
      const file = this.file(runId);
      text = await reading(file, () => fs.readFile(file, 'utf8'));
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<HarnessRun>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new HarnessError('invalid_run_record', 'This saved run is not a run record.');
    // Read through the migration framework (H21). The run contract has one
    // version, so there is nothing to carry forward yet; a newer or unversioned
    // run is refused with the file untouched and keeps its existing code.
    try {
      migrateRecord(HARNESS_RUN, parsed);
    } catch (error) {
      if (!(error instanceof MigrationRefusal)) throw error;
      throw new HarnessError('unsupported_run_version', `Run ${runId}: ${error.message}`);
    }
    return parsed as HarnessRun;
  }
  async write(run: HarnessRun) {
    await durableWrite(this.file(run.id), JSON.stringify(run));
  }
  async list() {
    try {
      return (await fs.readdir(this.dir))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length));
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
  }
  /**
   * Whether a run's file is there. On Windows a directory listing can leave out
   * a file that exists while files in the folder are being replaced (DIO-318,
   * seen under load), so the host asks this before it forgets a run a listing
   * missed. The check waits in the read gate, so it never lands inside this
   * store's own replacement of the file.
   */
  async has(runId: string) {
    // A name that is not a run id names no run this store wrote.
    if (!RUN_ID.test(runId)) return false;
    const file = this.file(runId);
    try {
      await reading(file, () => fs.access(file));
      return true;
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  }
}
