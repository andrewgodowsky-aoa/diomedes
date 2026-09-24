/**
 * H12 containment: the narrowest capability a harness tool runs with.
 *
 * `containedPath` is the one funnel a tool's path goes through. It judges what
 * a spelling resolves to, not how it is spelled (decision 11): the spelling is
 * refused if it is absolute, climbs, carries a NUL, is not in composed (NFC)
 * form for a write, or names a private or guarded entry under compatibility
 * folding (a fullwidth `．env` is `.env`); it then goes through `projectFile`
 * and `safeAbsolute`, which refuse links and junctions at every component and
 * expand a Windows 8.3 alias before re-running the private checks; and the
 * resolved location is checked once more against the resolved project root.
 * For a write, a name that differs from an existing entry only by case or
 * Unicode normalisation is refused, so no tool makes a confusable twin or
 * silently lands on another file on a case-insensitive disk.
 *
 * `containedWrite` writes only a declared target, through a temporary file in
 * the checked folder, and re-checks the folder and target between the write
 * and the rename; a swap between check and use is refused with
 * `path_changed`. Node has no `openat`, so a swap in the instant between the
 * re-check and the rename is outside what this can prove; the rename itself
 * never follows a link at the final component.
 *
 * `containedSpawn` is the only way a harness tool starts a process: no shell,
 * a working folder inside the project, a minimal environment (nothing
 * inherited but the path and the system folders; an explicit addition that
 * looks like a secret is refused), bounded output and a timeout that ends the
 * whole process tree.
 *
 * Every refusal is a `HarnessError` with a stable code.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError, isContained, projectFile, rejectForbidden, safeAbsolute } from '../paths.js';
import { HarnessError } from './policy.js';

export type ContainmentCode =
  | 'path_invalid'
  | 'path_absolute'
  | 'path_traversal'
  | 'path_forbidden'
  | 'path_unnormalized'
  | 'path_link'
  | 'path_outside_root'
  | 'path_collision'
  | 'path_changed'
  | 'path_not_declared'
  | 'payload_too_large'
  | 'spawn_env_refused';

const refuse = (code: ContainmentCode, message: string) => new HarnessError(code, message);

const MAX_SPELLING = 512;
const fold = (value: string) => value.normalize('NFC').toLowerCase();
const CASE_FOLDING = process.platform === 'win32' || process.platform === 'darwin';
const pieces = (value: string) => value.split(/[\\/]+/).filter(Boolean);

/** Map the path trust funnel's own refusals onto containment codes. */
function fromApiError(error: unknown): never {
  if (error instanceof ApiError) {
    if (/linked/i.test(error.message)) throw refuse('path_link', 'Linked folders and files cannot be used.');
    if (/private/i.test(error.message)) throw refuse('path_forbidden', 'This folder or file is private.');
    if (/inside this project/i.test(error.message) && error.status === 403)
      throw refuse('path_outside_root', 'That path is outside the project folder.');
    throw refuse('path_invalid', 'This file name cannot be used.');
  }
  throw error;
}

export interface ContainedPath {
  /** Absolute location under the project root, as `projectFile` resolved it. */
  absolute: string;
  /** Project-relative name with forward slashes; empty for the root itself. */
  relative: string;
}

/**
 * The absolute location a project-relative spelling names, or a refusal. The
 * root is the project folder the host already trusts; it must not be a link.
 */
export async function containedPath(
  root: string,
  spelled: unknown,
  options: { write: boolean },
): Promise<ContainedPath> {
  if (typeof spelled !== 'string' || spelled.length > MAX_SPELLING || spelled.includes('\0'))
    throw refuse('path_invalid', 'This file name cannot be used.');
  if (options.write && spelled !== spelled.normalize('NFC'))
    throw refuse('path_unnormalized', 'Spell the name in composed (NFC) form.');
  if (
    path.posix.isAbsolute(spelled) ||
    path.win32.isAbsolute(spelled) ||
    /^[a-z]:/i.test(spelled) ||
    /^[\\/]{2}/.test(spelled)
  )
    throw refuse('path_absolute', 'Use a path relative to the project folder.');
  const parts = pieces(spelled.trim()).filter((part) => part !== '.');
  if (parts.includes('..')) throw refuse('path_traversal', 'A path cannot climb out of the project folder.');
  // What the name folds to under compatibility normalisation is judged too.
  const folded = parts.map((part) => part.normalize('NFKC'));
  try {
    rejectForbidden(path.join(path.parse(process.cwd()).root, ...folded));
  } catch (error) {
    fromApiError(error);
  }
  let resolvedRoot: string;
  let realRoot: string;
  try {
    resolvedRoot = await safeAbsolute(root);
    realRoot = await fs.realpath(resolvedRoot);
  } catch (error) {
    fromApiError(error);
  }
  const rootInfo = await fs.lstat(resolvedRoot);
  if (!rootInfo.isDirectory()) throw refuse('path_link', 'The project folder is not a plain folder.');
  if (!parts.length) return { absolute: resolvedRoot, relative: '' };
  let found: { relative: string; absolute: string };
  try {
    found = await projectFile(resolvedRoot, parts.join('/'));
  } catch (error) {
    fromApiError(error);
  }
  // The deepest existing component must resolve inside the resolved root, spelled the same way.
  let deepest = found.absolute;
  for (;;) {
    try {
      await fs.lstat(deepest);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      deepest = path.dirname(deepest);
    }
  }
  if (options.write) await refuseCollisions(resolvedRoot, found.relative);
  const real = await fs.realpath(deepest);
  if (!isContained(realRoot, real)) throw refuse('path_outside_root', 'That path is outside the project folder.');
  const expected = path.join(realRoot, path.relative(resolvedRoot, deepest));
  // Windows and macOS disks fold case (and macOS normalisation), so only the fold is compared there.
  if (CASE_FOLDING ? fold(real) !== fold(expected) : real !== expected)
    throw refuse('path_link', 'That path reaches its location through a link or alias.');
  return found;
}

/** A name that differs from an existing entry only by case or normalisation is a collision. */
async function refuseCollisions(root: string, relative: string) {
  let current = root;
  for (const part of relative.split('/')) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries) return;
    if (!entries.includes(part)) {
      const twin = entries.find((entry) => fold(entry) === fold(part));
      if (twin !== undefined)
        throw refuse('path_collision', 'Another entry already has this name in a different case or form.');
      return;
    }
    current = path.join(current, part);
  }
}

/** Refuse any target that is not one of the declared ones, compared exactly. */
export function assertDeclared(relative: string, declared: readonly string[]) {
  if (!declared.includes(relative))
    throw refuse('path_not_declared', `This tool did not declare ${relative} as a target.`);
}

export interface ContainedWriteOptions {
  declared: readonly string[];
  maxBytes?: number;
  /** Test seam: runs after the checks and the temporary write, before the commit. */
  beforeCommit?: (absolute: string) => Promise<void>;
}

const sameEntry = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;

/**
 * Write one declared project file. The folder must already exist; the file is
 * replaced whole through a temporary file created exclusively in that folder.
 */
export async function containedWrite(root: string, spelled: string, text: string, options: ContainedWriteOptions) {
  const found = await containedPath(root, spelled, { write: true });
  assertDeclared(found.relative, options.declared);
  const bytes = Buffer.from(text, 'utf8');
  const max = options.maxBytes ?? 1024 * 1024;
  if (bytes.byteLength > max) throw refuse('payload_too_large', `The text is ${bytes.byteLength} bytes; the limit is ${max}.`);
  const folder = path.dirname(found.absolute);
  const checkedFolder = await fs.lstat(folder).catch(() => null);
  if (!checkedFolder?.isDirectory()) throw refuse('path_invalid', 'The folder for this file does not exist.');
  const realFolder = await fs.realpath(folder);
  const existing = await fs.lstat(found.absolute).catch(() => null);
  if (existing && !existing.isFile()) throw refuse('path_link', 'Only a plain file can be replaced.');
  const temp = path.join(folder, `.diomedes-${randomBytes(8).toString('hex')}.tmp`);
  const handle = await fs.open(temp, 'wx');
  let written: { dev: number; ino: number };
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    written = await handle.stat();
  } finally {
    await handle.close();
  }
  // Removed by name only while its folder is still the checked one: after a swap the
  // name may lead through a link, so the stray temporary file is left where it is.
  let folderIntact = true;
  const discard = () => (folderIntact ? fs.rm(temp, { force: true }).catch(() => undefined) : undefined);
  try {
    await options.beforeCommit?.(found.absolute);
    // Re-check between the write and the commit: the folder is the same plain
    // folder, still inside the root; the target is absent or a plain file; the
    // temporary file is the one written.
    const folderNow = await fs.lstat(folder).catch(() => null);
    const realNow = await fs.realpath(folder).catch(() => null);
    const tempNow = await fs.lstat(temp).catch(() => null);
    const targetNow = await fs.lstat(found.absolute).catch(() => null);
    folderIntact = Boolean(folderNow?.isDirectory() && !folderNow.isSymbolicLink() && sameEntry(folderNow, checkedFolder) && realNow === realFolder);
    if (
      !folderNow ||
      folderNow.isSymbolicLink() ||
      !folderNow.isDirectory() ||
      !sameEntry(folderNow, checkedFolder) ||
      realNow !== realFolder ||
      !tempNow ||
      !sameEntry(tempNow, written) ||
      (targetNow && !targetNow.isFile()) ||
      (existing ? !targetNow || !sameEntry(targetNow, existing) : targetNow !== null)
    )
      throw refuse('path_changed', 'The folder or file changed between the check and the write, so nothing was written.');
    await containedPath(root, spelled, { write: true });
  } catch (error) {
    await discard();
    throw error;
  }
  await fs.rename(temp, found.absolute);
  const landed = await fs.lstat(found.absolute).catch(() => null);
  if (!landed || !sameEntry(landed, written))
    throw refuse('path_changed', 'The file changed while it was being written; its outcome is not certain.');
  return { relative: found.relative, bytes: bytes.byteLength };
}

// --- processes -----------------------------------------------------------------------

/** Environment names a child may inherit: the search path and the system folders only. */
const INHERITED = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'LANG'];
const SECRETISH = /(TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE|AUTH|COOKIE|SESSION)/i;

export function minimalEnvironment(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || SECRETISH.test(name) || typeof value !== 'string')
      throw refuse('spawn_env_refused', `The environment variable ${name} cannot be passed to a tool's process.`);
    env[name] = value;
  }
  return env;
}

export interface SpawnLimits {
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** End a process and everything it started. */
function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run one program for a tool: no shell, a working folder inside the project,
 * a minimal environment, bounded output and a timeout that ends the tree.
 */
export async function containedSpawn(
  root: string,
  cwd: string,
  command: string,
  args: readonly string[],
  limits: SpawnLimits,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = minimalEnvironment(limits.env ?? {});
  const folder = await containedPath(root, cwd === '.' ? '' : cwd, { write: false });
  const max = limits.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: folder.absolute,
      env,
      shell: false,
      windowsHide: true,
      // Its own process group on POSIX, so the whole tree can be ended at once.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      limits.signal?.removeEventListener('abort', onAbort);
      if (error) {
        killTree(child.pid);
        // What the process wrote before it was stopped, for a caller that reports it.
        Object.assign(error, {
          partial: { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') },
        });
        reject(error);
      } else resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > max) {
        finish(new HarnessError('tool_output_too_large', `The process wrote more than ${max} bytes.`));
        return;
      }
      into.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const timer = setTimeout(
      () => finish(new HarnessError('tool_timeout', `The process did not finish within ${limits.timeoutMs} ms.`)),
      limits.timeoutMs,
    );
    const onAbort = () => finish(new HarnessError('aborted', 'The process was stopped.'));
    limits.signal?.addEventListener('abort', onAbort, { once: true });
    if (limits.signal?.aborted) onAbort();
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      // Whatever the program left running in its group ends with it.
      if (!settled) killTree(child.pid);
      finish(null, code);
    });
  });
}
