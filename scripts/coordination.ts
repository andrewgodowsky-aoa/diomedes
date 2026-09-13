/**
 * Coordination for the unified execution program (2026-09-13).
 *
 * One rendezvous directory under the Git common dir holds exclusive file
 * claims, one heavy-test / live-call slot, and one append-only journal per
 * role. Nothing here touches Git's own state; the folder is a sibling of
 * Git's files, never one of them.
 *
 * Rules the charter fixes and this file enforces:
 * - A claim is created atomically (`wx`). Two workers racing for one path get
 *   exactly one winner; the loser is told who holds it.
 * - A stale timestamp alone is never permission to steal. A claim ends only
 *   by release or recorded handoff.
 * - The charter's shared hot files belong to the integrator (Fable). Others
 *   may inspect them and return patches; they cannot claim them.
 * - A missing partner journal means read-only work, not a second implementation.
 *
 * Library API (tested in tests/coordination.test.ts) and a small CLI:
 *   tsx scripts/coordination.ts claim|release|slot|unslot|journal|mode|status ...
 */
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const PROGRAM = 'unified-20260913' as const;
export type Role = 'fable' | 'astra' | 'opus';
export const ROLES: readonly Role[] = Object.freeze(['fable', 'astra', 'opus']);
export const INTEGRATOR: Role = 'fable';

/** Charter §"Shared hot files": serialized through the integrator. Prefixes end with `/`. */
export const CHARTER_HOT_FILES: readonly string[] = Object.freeze([
  'package.json',
  'package-lock.json',
  'shared/types.ts',
  'shared/harness.ts',
  'shared/engines.ts',
  'shared/agents.ts',
  'shared/capability-packs.ts',
  'shared/execution.ts',
  'shared/work-control.ts',
  'shared/contract-revision.ts',
  'server/app.ts',
  'server/store.ts',
  'server/native-work.ts',
  'client/api.ts',
  'client/console/Shell.tsx',
  'desktop/',
]);

export interface Owner {
  readonly role: Role;
  readonly host: string;
  readonly pid: number;
  /** ISO time the owning process started; identity, not a lease. */
  readonly processStart: string;
  readonly worktree: string;
}

export interface Claim {
  readonly schema_version: 1;
  readonly claimId: string;
  readonly program: typeof PROGRAM;
  readonly node: string;
  readonly owner: Owner;
  readonly paths: readonly string[];
  readonly baseSha: string;
  readonly createdAt: string;
  readonly handoffFrom: string | null;
}

export interface ClaimRelease {
  readonly claimId: string;
  readonly releasedBy: Owner;
  readonly at: string;
  readonly note: string;
}

export type ClaimResult =
  | { ok: true; claim: Claim }
  | {
      ok: false;
      reason: 'held' | 'integrator-owned' | 'invalid';
      detail: string;
      heldBy?: Claim;
    };

export interface Slot {
  readonly schema_version: 1;
  readonly slotId: string;
  readonly owner: Owner;
  readonly purpose: string;
  readonly node: string;
  readonly acquiredAt: string;
}

export type SlotResult =
  | { ok: true; slot: Slot }
  | { ok: false; heldBy: Slot | null; detail: string };

export interface JournalEntry {
  readonly at: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface WorkMode {
  readonly mode: 'edit' | 'read-only';
  readonly why: string;
}

const dirs = (root: string) => ({
  claims: path.join(root, 'claims'),
  locks: path.join(root, 'claims', 'paths'),
  slot: path.join(root, 'slot'),
  journals: path.join(root, 'journals'),
});

const normalizePath = (value: string) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
const lockName = (relPath: string) => encodeURIComponent(normalizePath(relPath)) + '.lock';
const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
const isExists = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST';
const isAbsent = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';

export function isHotFile(relPath: string): boolean {
  const normalized = normalizePath(relPath);
  return CHARTER_HOT_FILES.some((hot) =>
    hot.endsWith('/') ? normalized.startsWith(hot) : normalized === hot,
  );
}

async function ensureDirs(root: string) {
  const d = dirs(root);
  await Promise.all(Object.values(d).map((dir) => fs.mkdir(dir, { recursive: true })));
  return d;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

async function readClaim(root: string, claimId: string): Promise<Claim | null> {
  return readJson<Claim>(path.join(dirs(root).claims, `${claimId}.json`));
}

async function claimRelease(root: string, claimId: string): Promise<ClaimRelease | null> {
  return readJson<ClaimRelease>(path.join(dirs(root).claims, `${claimId}.released.json`));
}

/** Who holds a path right now, or null. */
export async function holderOf(root: string, relPath: string): Promise<Claim | null> {
  const lock = path.join(dirs(root).locks, lockName(relPath));
  let claimId: string;
  try {
    claimId = (await fs.readFile(lock, 'utf8')).trim();
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
  // The winner writes its claim file before its locks, so a lock always names a readable claim.
  return readClaim(root, claimId);
}

/**
 * Claim exact paths for one node. Atomic per path through `wx` lock files,
 * taken in sorted order; a failure rolls back every lock this call created
 * and leaves no partial claim behind.
 */
export async function claimPaths(
  root: string,
  input: {
    owner: Owner;
    node: string;
    baseSha: string;
    paths: readonly string[];
    handoffFrom?: string | null;
    createdAt?: string;
    /** Only for tests and status displays; a later "now" never permits a steal. */
    now?: string;
  },
): Promise<ClaimResult> {
  const paths = [...new Set(input.paths.map(normalizePath))].sort();
  if (paths.length === 0)
    return { ok: false, reason: 'invalid', detail: 'A claim needs at least one path.' };
  if (!ROLES.includes(input.owner.role))
    return { ok: false, reason: 'invalid', detail: `Unknown role ${String(input.owner.role)}.` };
  const hot = paths.filter(isHotFile);
  if (hot.length > 0 && input.owner.role !== INTEGRATOR && !input.handoffFrom)
    return {
      ok: false,
      reason: 'integrator-owned',
      detail: `${hot.join(', ')} ${hot.length === 1 ? 'is a' : 'are'} charter hot file${hot.length === 1 ? '' : 's'}: only the integrator (${INTEGRATOR}) claims ${hot.length === 1 ? 'it' : 'them'}; return a patch instead, or obtain a recorded handoff.`,
    };
  const d = await ensureDirs(root);
  const claim: Claim = {
    schema_version: 1,
    claimId: newId('claim'),
    program: PROGRAM,
    node: input.node,
    owner: input.owner,
    paths,
    baseSha: input.baseSha,
    createdAt: input.createdAt ?? new Date().toISOString(),
    handoffFrom: input.handoffFrom ?? null,
  };
  const claimFile = path.join(d.claims, `${claim.claimId}.json`);
  await fs.writeFile(claimFile, JSON.stringify(claim, null, 2), { flag: 'wx' });
  const taken: string[] = [];
  for (const relPath of paths) {
    const lock = path.join(d.locks, lockName(relPath));
    try {
      await fs.writeFile(lock, claim.claimId, { flag: 'wx' });
      taken.push(lock);
    } catch (error) {
      if (!isExists(error)) {
        await rollback(taken, claimFile);
        throw error;
      }
      const heldBy = await holderOf(root, relPath);
      await rollback(taken, claimFile);
      return {
        ok: false,
        reason: 'held',
        detail: heldBy
          ? `${relPath} is held by ${heldBy.owner.role} (claim ${heldBy.claimId}, node ${heldBy.node}, pid ${heldBy.owner.pid} on ${heldBy.owner.host}, since ${heldBy.createdAt}). A stale timestamp is not permission to steal: wait for a release or obtain a recorded handoff.`
          : `${relPath} is locked by a claim that is being written; retry.`,
        heldBy: heldBy ?? undefined,
      };
    }
  }
  return { ok: true, claim };
}

async function rollback(locks: readonly string[], claimFile: string) {
  await Promise.all(locks.map((lock) => fs.rm(lock, { force: true })));
  await fs.rm(claimFile, { force: true });
}

/**
 * Release a claim. The owner releases it, or the integrator records a handoff
 * on the owner's behalf; anyone else is refused. The claim file stays as
 * evidence; a `.released.json` beside it says who ended it and why.
 */
export async function releaseClaim(
  root: string,
  claimId: string,
  input: { by: Owner; note: string; at?: string },
): Promise<ClaimRelease> {
  const claim = await readClaim(root, claimId);
  if (!claim) throw new Error(`No claim ${claimId}.`);
  if (await claimRelease(root, claimId)) throw new Error(`Claim ${claimId} was already released.`);
  if (input.by.role !== claim.owner.role && input.by.role !== INTEGRATOR)
    throw new Error(
      `Only the holder (${claim.owner.role}) or the integrator may release claim ${claimId}.`,
    );
  const release: ClaimRelease = {
    claimId,
    releasedBy: input.by,
    at: input.at ?? new Date().toISOString(),
    note: input.note,
  };
  const d = dirs(root);
  await fs.writeFile(
    path.join(d.claims, `${claimId}.released.json`),
    JSON.stringify(release, null, 2),
    {
      flag: 'wx',
    },
  );
  for (const relPath of claim.paths) {
    const lock = path.join(d.locks, lockName(relPath));
    const current = await fs.readFile(lock, 'utf8').catch(() => null);
    if (current?.trim() === claimId) await fs.rm(lock, { force: true });
  }
  return release;
}

/** Every claim not yet released. */
export async function activeClaims(root: string): Promise<Claim[]> {
  const d = dirs(root);
  let names: string[];
  try {
    names = await fs.readdir(d.claims);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  const released = new Set(
    names
      .filter((n) => n.endsWith('.released.json'))
      .map((n) => n.replace(/\.released\.json$/, '')),
  );
  const claims: Claim[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.released.json')) continue;
    const id = name.replace(/\.json$/, '');
    if (released.has(id)) continue;
    const claim = await readClaim(root, id);
    if (claim) claims.push(claim);
  }
  return claims.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const slotFile = (root: string) => path.join(dirs(root).slot, 'heavy.json');

/** The one heavy-test / Playwright / packaging / live-call slot, shared by both repositories. */
export async function requestSlot(
  root: string,
  input: { owner: Owner; purpose: string; node: string; at?: string },
): Promise<SlotResult> {
  await ensureDirs(root);
  const slot: Slot = {
    schema_version: 1,
    slotId: newId('slot'),
    owner: input.owner,
    purpose: input.purpose,
    node: input.node,
    acquiredAt: input.at ?? new Date().toISOString(),
  };
  try {
    await fs.writeFile(slotFile(root), JSON.stringify(slot, null, 2), { flag: 'wx' });
  } catch (error) {
    if (!isExists(error)) throw error;
    const heldBy = await readJson<Slot>(slotFile(root));
    return {
      ok: false,
      heldBy,
      detail: heldBy
        ? `The heavy slot is held by ${heldBy.owner.role} for ${heldBy.purpose} (${heldBy.node}, since ${heldBy.acquiredAt}). Wait; do not start Playwright, a full suite, packaging or a live call.`
        : 'The heavy slot is being acquired by someone else; retry.',
    };
  }
  return { ok: true, slot };
}

export async function releaseSlot(root: string, slotId: string, input: { by: Owner; at?: string }) {
  const held = await readJson<Slot>(slotFile(root));
  if (!held || held.slotId !== slotId) throw new Error(`Slot ${slotId} is not the current holder.`);
  if (held.owner.role !== input.by.role || held.owner.pid !== input.by.pid)
    throw new Error(
      `Only the holder (${held.owner.role}, pid ${held.owner.pid}) may release slot ${slotId}.`,
    );
  await fs.appendFile(
    path.join(dirs(root).slot, 'history.jsonl'),
    JSON.stringify({ ...held, releasedAt: input.at ?? new Date().toISOString() }) + '\n',
  );
  await fs.rm(slotFile(root), { force: true });
}

export async function currentSlot(root: string): Promise<Slot | null> {
  return readJson<Slot>(slotFile(root));
}

const journalFile = (root: string, role: Role) => path.join(dirs(root).journals, `${role}.jsonl`);

export async function writeJournal(root: string, owner: Owner, entry: JournalEntry) {
  await ensureDirs(root);
  await fs.appendFile(
    journalFile(root, owner.role),
    JSON.stringify({ ...entry, pid: owner.pid, host: owner.host, worktree: owner.worktree }) + '\n',
  );
}

export async function readJournal(root: string, role: Role): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(journalFile(root, role), 'utf8');
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

/**
 * What a worker may do right now. Read-only when the partner has not shown up
 * in the journals, when a non-integrator wants a charter hot file, or when a
 * wanted path is held by someone else. Read-only work is useful work: source
 * inventory, black-box tests, fixtures, review; never a second implementation.
 */
export async function workMode(
  root: string,
  input: { me: Owner; partner: Role; wantsToEdit: readonly string[] },
): Promise<WorkMode> {
  const partnerJournal = await readJournal(root, input.partner);
  if (partnerJournal.length === 0)
    return {
      mode: 'read-only',
      why: `No journal from ${input.partner} in ${root}: the partner has not joined this coordination root. Do read-only analysis or isolated disjoint work; do not start a second implementation.`,
    };
  const hot = input.wantsToEdit.filter(isHotFile);
  if (hot.length > 0 && input.me.role !== INTEGRATOR)
    return {
      mode: 'read-only',
      why: `${hot.join(', ')} belong to the integrator (${INTEGRATOR}). Inspect and return a patch; do not edit.`,
    };
  for (const relPath of input.wantsToEdit) {
    const holder = await holderOf(root, relPath);
    if (holder && (holder.owner.role !== input.me.role || holder.owner.pid !== input.me.pid))
      return {
        mode: 'read-only',
        why: `${relPath} is held by ${holder.owner.role} (claim ${holder.claimId}, node ${holder.node}).`,
      };
  }
  return {
    mode: 'edit',
    why: 'Partner present, no hot files outside the integrator, no path held by another claim.',
  };
}

// --- CLI ------------------------------------------------------------------------

export function defaultRoot(cwd = process.cwd()): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  const absolute = path.isAbsolute(common) ? common : path.resolve(cwd, common);
  return path.join(absolute, 'diomedes-coordination', PROGRAM);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function ownerFromArgs(args: string[]): Owner {
  const role = argValue(args, 'role') as Role | undefined;
  if (!role || !ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}.`);
  const pid = Number(argValue(args, 'pid') ?? process.ppid);
  const start =
    argValue(args, 'start') ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
  return {
    role,
    host: os.hostname(),
    pid,
    processStart: start,
    worktree: argValue(args, 'worktree') ?? process.cwd().replace(/\\/g, '/'),
  };
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
  const root = argValue(args, 'root') ?? defaultRoot();
  const out = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  switch (command) {
    case 'claim': {
      const owner = ownerFromArgs(args);
      const result = await claimPaths(root, {
        owner,
        node: argValue(args, 'node') ?? 'unspecified',
        baseSha: argValue(args, 'base') ?? 'unspecified',
        paths: (argValue(args, 'paths') ?? '').split(',').filter(Boolean),
        handoffFrom: argValue(args, 'handoff-from') ?? null,
      });
      out(result);
      if (result.ok)
        await writeJournal(root, owner, {
          at: new Date().toISOString(),
          event: 'claim',
          claimId: result.claim.claimId,
          node: result.claim.node,
          paths: result.claim.paths,
        });
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case 'release': {
      const owner = ownerFromArgs(args);
      const claimId = argValue(args, 'claim');
      if (!claimId) throw new Error('--claim is required.');
      const release = await releaseClaim(root, claimId, {
        by: owner,
        note: argValue(args, 'note') ?? '',
      });
      await writeJournal(root, owner, {
        at: release.at,
        event: 'release',
        claimId,
        note: release.note,
      });
      out(release);
      return;
    }
    case 'slot': {
      const owner = ownerFromArgs(args);
      const result = await requestSlot(root, {
        owner,
        purpose: argValue(args, 'purpose') ?? 'unspecified',
        node: argValue(args, 'node') ?? 'unspecified',
      });
      out(result);
      if (result.ok)
        await writeJournal(root, owner, {
          at: result.slot.acquiredAt,
          event: 'slot',
          slotId: result.slot.slotId,
          purpose: result.slot.purpose,
        });
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case 'unslot': {
      const owner = ownerFromArgs(args);
      const slotId = argValue(args, 'slot');
      if (!slotId) throw new Error('--slot is required.');
      await releaseSlot(root, slotId, { by: owner });
      await writeJournal(root, owner, { at: new Date().toISOString(), event: 'unslot', slotId });
      out({ ok: true });
      return;
    }
    case 'journal': {
      const owner = ownerFromArgs(args);
      const entry = { at: new Date().toISOString(), event: argValue(args, 'event') ?? '' };
      await writeJournal(root, owner, entry);
      out(entry);
      return;
    }
    case 'mode': {
      const owner = ownerFromArgs(args);
      const partner = argValue(args, 'partner') as Role | undefined;
      if (!partner || !ROLES.includes(partner)) throw new Error('--partner must name a role.');
      out(
        await workMode(root, {
          me: owner,
          partner,
          wantsToEdit: (argValue(args, 'paths') ?? '').split(',').filter(Boolean),
        }),
      );
      return;
    }
    case 'status': {
      out({
        root,
        slot: await currentSlot(root),
        claims: await activeClaims(root),
        journals: Object.fromEntries(
          await Promise.all(
            ROLES.map(async (role) => [role, (await readJournal(root, role)).length]),
          ),
        ),
      });
      return;
    }
    default:
      process.stderr.write(
        'usage: coordination.ts claim|release|slot|unslot|journal|mode|status [--root DIR] [--role ROLE] ...\n',
      );
      process.exitCode = 2;
  }
}

if (process.argv[1] && /coordination\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
