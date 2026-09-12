import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { absent } from './paths.js';

/** Name of the lock file inside a Diomedes data folder. */
export const LOCK_NAME = 'service.lock';
/**
 * A recorded start time and a measured one come from two different clocks: the
 * owner derives its own from `process.uptime()`, while a later reader asks the
 * operating system. They agree to within a few hundred milliseconds, so allow
 * two seconds. A reused pid belongs to a process created much later than that.
 */
export const START_TIME_TOLERANCE_MS = 2000;
/** .NET ticks (100 ns) between 0001-01-01 and the Unix epoch. */
const TICKS_TO_UNIX_EPOCH = 621_355_968_000_000_000n;
const PROBE_TIMEOUT_MS = 4000;
const PORT_TIMEOUT_MS = 500;

export type LockRecord = {
  pid: number;
  port?: number;
  startedAt?: number;
  token?: string;
};

export type LockVerdict = {
  /** True when another live Diomedes still owns the data folder. */
  held: boolean;
  reason:
    | 'unreadable'
    | 'dead'
    | 'start-time-match'
    | 'start-time-mismatch'
    | 'port-active'
    | 'port-idle'
    | 'unverifiable';
};

export type LockProbes = {
  alive?: (pid: number) => boolean;
  startedAt?: (pid: number) => Promise<number | null>;
  listening?: (port: number) => Promise<boolean>;
};

/** Raised when a live process still owns the data folder. */
export class DataFolderInUse extends Error {
  constructor(public pid: number) {
    super(
      `Another process (${pid}) holds this Diomedes data folder. Use its service or choose another data folder.`,
    );
    this.name = 'DataFolderInUse';
  }
}

/** Start time of this process, in epoch milliseconds, without spawning anything. */
export const ownStartedAt = () => Math.round(Date.now() - process.uptime() * 1000);

/** Whether a pid currently exists. A pid we may not signal still counts as alive. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function run(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1 << 20 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * Which PowerShell answers first. PowerShell 7 (`pwsh`) starts in a fraction of
 * the time Windows PowerShell 5.1 does, and on a machine where 5.1 has never
 * been launched since boot its first start can take longer than any budget a
 * lock should wait, because the runtime compiles itself on the way up. The
 * GitHub Windows runner is exactly that machine: every workflow step runs under
 * pwsh, so 5.1 is cold when the suite reaches this probe. Remember the answer
 * per process so the fallback costs one miss, not one per probe.
 */
let windowsHost: 'pwsh.exe' | 'powershell.exe' | null = null;

async function windowsStartedAt(pid: number, timeoutMs: number): Promise<number | null> {
  // Opening the one process by id is cheaper than `Get-Process`, which walks the
  // whole process table before selecting from it. Both throw for a pid that is
  // gone or cannot be opened, so what a caller sees on failure is unchanged.
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-NoLogo',
    '-Command',
    `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`,
  ];
  const parse = (output: string | null) => {
    const text = output?.trim();
    if (!text || !/^\d+$/.test(text)) return null;
    return Number((BigInt(text) - TICKS_TO_UNIX_EPOCH) / 10_000n);
  };
  if (windowsHost) return parse(await run(windowsHost, args, timeoutMs));
  const started = Date.now();
  const viaPwsh = parse(await run('pwsh.exe', args, timeoutMs));
  if (viaPwsh !== null) {
    windowsHost = 'pwsh.exe';
    return viaPwsh;
  }
  // No pwsh, or it could not open the pid. Spend what is left of the budget on
  // 5.1 rather than starting the clock again; a caller asked for one wait.
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) return null;
  const via51 = parse(await run('powershell.exe', args, remaining));
  if (via51 !== null) windowsHost = 'powershell.exe';
  return via51;
}

async function linuxStartedAt(pid: number): Promise<number | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    // The command name may contain spaces and parentheses, so read past the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    const boot = /^btime (\d+)$/m.exec(await fs.readFile('/proc/stat', 'utf8'))?.[1];
    if (!Number.isFinite(ticks) || !boot) return null;
    return Math.round(Number(boot) * 1000 + ticks * 10);
  } catch {
    return null;
  }
}

async function macStartedAt(pid: number, timeoutMs: number): Promise<number | null> {
  const output = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], timeoutMs);
  const parsed = output ? Date.parse(output.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Start time of any pid, in epoch milliseconds, or null when this platform
 * cannot report it. Only called when a lock file already exists, so the cost of
 * the probe never lands on an ordinary start.
 *
 * `timeoutMs` bounds how long a start may wait for the answer. The default is
 * the budget a real start spends; a caller asking whether this platform can
 * report a start time at all, rather than how quickly, may wait longer.
 */
export async function processStartedAt(
  pid: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') return await windowsStartedAt(pid, timeoutMs);
    if (process.platform === 'linux') return await linuxStartedAt(pid);
    if (process.platform === 'darwin') return await macStartedAt(pid, timeoutMs);
  } catch {
    return null;
  }
  return null;
}

/** Whether something accepts loopback connections on a port. */
export function portListening(port: number, timeoutMs = PORT_TIMEOUT_MS): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Decide whether a lock record still describes a running Diomedes.
 *
 * A live pid alone proves nothing: after a reboot the operating system hands
 * the same number to an unrelated program. The recorded start time settles it,
 * and where a start time cannot be read the recorded port stands in for it.
 */
export async function inspectLock(record: unknown, probes: LockProbes = {}): Promise<LockVerdict> {
  const alive = probes.alive ?? processAlive;
  const startedAt = probes.startedAt ?? processStartedAt;
  const listening = probes.listening ?? ((port: number) => portListening(port));
  const entry = (record ?? {}) as Partial<LockRecord>;
  const pid = Number(entry.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { held: false, reason: 'unreadable' };
  if (!alive(pid)) return { held: false, reason: 'dead' };
  const recorded = Number(entry.startedAt);
  if (Number.isFinite(recorded)) {
    const actual = await startedAt(pid);
    if (actual !== null)
      return Math.abs(actual - recorded) <= START_TIME_TOLERANCE_MS
        ? { held: true, reason: 'start-time-match' }
        : { held: false, reason: 'start-time-mismatch' };
  }
  const port = Number(entry.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535)
    return (await listening(port))
      ? { held: true, reason: 'port-active' }
      : { held: false, reason: 'port-idle' };
  // Nothing left to check. Leave the folder alone rather than risk two owners.
  return { held: true, reason: 'unverifiable' };
}

async function removeLock(lockPath: string) {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

/** Read a lock file, returning null when it is missing or not valid JSON. */
export async function readLock(lockPath: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Take ownership of a data folder, clearing a lock left behind by a process
 * that is gone. Throws DataFolderInUse when a live Diomedes still owns it.
 */
export async function claimDataFolder(
  dataDir: string,
  options: { port?: number; probes?: LockProbes } = {},
) {
  const lockPath = path.join(dataDir, LOCK_NAME);
  const existing = await readLock(lockPath);
  if (existing !== null) {
    const verdict = await inspectLock(existing, options.probes);
    if (verdict.held) throw new DataFolderInUse(Number((existing as Partial<LockRecord>).pid));
    await removeLock(lockPath);
  }
  const record: LockRecord = {
    pid: process.pid,
    startedAt: ownStartedAt(),
    token: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    ...(options.port === undefined ? {} : { port: options.port }),
  };
  const handle = await fs.open(lockPath, 'wx');
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  let released = false;
  return {
    path: lockPath,
    record,
    release: async () => {
      if (released) return;
      released = true;
      await removeLock(lockPath);
    },
  };
}
