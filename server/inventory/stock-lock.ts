import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../paths.js';
import { identifier } from '../store.js';

/**
 * Cross-process mutual exclusion for the inventory stock ledger.
 *
 * Store.locked() serializes writers inside one process only; two OS processes
 * sharing a data folder can otherwise interleave a stock commit's journal,
 * replace, state persist and journal cleanup. Acquisition is an atomic mkdir
 * under `<dataDir>/inventory-locks/`; an owner record identifies the holder so
 * a crashed holder's lock can be broken safely.
 *
 * This is not a Store-level data-folder ownership claim — it only serializes
 * the inventory stock commit/recovery critical section across processes.
 */

const LOCK_RETRY_MS = 15;
/** A waiting process may hold for slow commits; give up only well past a normal commit's cost. */
const LOCK_WAIT_MS = 30_000;
/** An owner file appears moments after mkdir; a bare dir older than this is a crashed holder. */
const OWNER_GRACE_MS = 5_000;
/** Settle window between the stale decision and the break attempt. */
const BREAK_RECHECK_MS = 25;

interface OwnerRecord {
  readonly pid: number;
  readonly token: string;
  readonly at: string;
}

/** Directory birthtime pins this instance of the lock; ownerRaw captures the owner write. */
interface LockIdentity {
  readonly birthtimeMs: number;
  readonly ownerRaw: string | null;
  readonly owner: OwnerRecord | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseOwner(raw: string | null): OwnerRecord | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.token === 'string'
    )
      return parsed as OwnerRecord;
  } catch {
    /* unreadable owner record */
  }
  return null;
}

async function lockIdentity(dir: string): Promise<LockIdentity | null> {
  try {
    const stat = await fs.stat(dir);
    let ownerRaw: string | null = null;
    try {
      ownerRaw = await fs.readFile(path.join(dir, 'owner.json'), 'utf8');
    } catch {
      /* owner record absent */
    }
    return { birthtimeMs: stat.birthtimeMs, ownerRaw, owner: parseOwner(ownerRaw) };
  } catch {
    return null; // already gone — retry acquisition
  }
}

const sameIdentity = (a: LockIdentity, b: LockIdentity) =>
  a.birthtimeMs === b.birthtimeMs && a.ownerRaw === b.ownerRaw;

/**
 * Break a lock only when its holder cannot still be writing: the recorded pid
 * is dead, or the lock predates its owner record past the grace window (holder
 * died between mkdir and owner write, or the owner record is corrupt). The
 * identity is re-read after a settle delay and the break moves the dir aside
 * atomically, so a fresh holder racing the decision keeps its lock.
 */
async function breakIfStale(dir: string, token: string): Promise<boolean> {
  const first = await lockIdentity(dir);
  if (!first) return true; // already gone — retry acquisition
  if (first.owner && pidAlive(first.owner.pid)) return false;
  const breakable =
    (first.owner !== null && !pidAlive(first.owner.pid)) ||
    (first.owner === null && Date.now() - first.birthtimeMs > OWNER_GRACE_MS);
  if (!breakable) return false;
  await sleep(BREAK_RECHECK_MS);
  const second = await lockIdentity(dir);
  if (!second) return true;
  if (!sameIdentity(first, second)) return false; // changed under us — live lock
  const trash = `${dir}.breaking-${token}`;
  try {
    await fs.rm(trash, { recursive: true, force: true });
    await fs.rename(dir, trash);
  } catch {
    return false; // lost the rename race or dir vanished — retry acquisition
  }
  await fs.rm(trash, { recursive: true, force: true });
  return true;
}

/**
 * Run `action` while holding the lock named for one (project, stockPath)
 * ledger. Throws ApiError 409 `inventory-lock-held` when another live process
 * holds it past the wait budget.
 */
export async function withStockLock<T>(
  locksDir: string,
  lockName: string,
  action: () => Promise<T>,
): Promise<T> {
  const dir = path.join(locksDir, `${lockName}.lock`);
  const token = identifier('L');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await breakIfStale(dir, token)) continue;
      if (Date.now() > deadline)
        throw new ApiError(409, 'Another process is writing this inventory.', {
          code: 'inventory-lock-held',
        });
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    await fs.writeFile(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() } satisfies OwnerRecord),
    );
    return await action();
  } finally {
    // Release only our own lock: a broken-and-reacquired dir belongs to whoever
    // wrote the surviving owner record, not to us.
    try {
      const raw = await fs.readFile(path.join(dir, 'owner.json'), 'utf8');
      if (parseOwner(raw)?.token === token) await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* lock dir already gone */
    }
  }
}
