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
import { HARNESS_CONTRACT_VERSION, type HarnessRun } from '../../shared/harness.js';
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
  await fs.rename(temp, target);
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
      text = await fs.readFile(this.file(runId), 'utf8');
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<HarnessRun>;
    if (parsed.v !== HARNESS_CONTRACT_VERSION)
      throw new HarnessError(
        'unsupported_run_version',
        `Run ${runId} was written by contract version ${String(parsed.v)}; this build reads version ${HARNESS_CONTRACT_VERSION}.`,
      );
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
}
