/** App-scoped Personal desktop identities for the existing Trust policy. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Store } from '../store.js';
import { currentAuthority, requireGenuine, type TrustBackend } from './authority.js';
import { generationFor, revoke } from './revocation.js';
import { denial, isDenial, type Authority, type AuthorityClaim, type Denial, type Principal } from './types.js';

/** A token-free, already verified publication. sessionId may be a host publication nonce. */
export interface LocalTrustAccountFacts {
  backendKind: 'cloud';
  backendKey: string;
  personId: string;
  sessionId: string;
  lifecycle: number;
  publishedLifecycle: number;
  expiresAt: string;
}

/** Null is required for Business, ambiguous ownership, and an unopened scope generation. */
export interface PersonalAuthorityFacts {
  projectId: string;
  tenantId: 'local';
  generation: number;
  projectFolder: string;
}

export interface LocalTrustBackendOptions {
  store: Pick<Store, 'dataDir' | 'state' | 'readTeamSecrets'>;
  accountFacts(): LocalTrustAccountFacts | null;
  personalFacts(projectId: string): PersonalAuthorityFacts | null;
  now?: () => number;
}

interface DirectoryIdentity { realPath: string; device: string; inode: string }
type AccountIdentity = Omit<LocalTrustAccountFacts, 'expiresAt'>;
interface ScopeIdentity {
  projectId: string;
  tenantId: 'local';
  generation: number;
  projectFolder: string;
  account: AccountIdentity;
  root: DirectoryIdentity;
  folder: DirectoryIdentity;
  owner: string;
  host: string;
}
interface MemberIdentity { slotId: string; createdAt: string; threadId: string | null; tokenDigest: string }
interface IssuedIdentity {
  id: string;
  kind: 'local-owner' | 'team-member';
  scope: ScopeIdentity;
  member: MemberIdentity | null;
}

const execute = promisify(execFile);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function directoryIdentity(folder: string): Promise<DirectoryIdentity> {
  const realPath = await fs.realpath(folder);
  const stat = await fs.stat(realPath, { bigint: true });
  if (!stat.isDirectory()) throw new Error('The authority folder is unavailable.');
  return { realPath, device: stat.dev.toString(), inode: stat.ino.toString() };
}

/** No caller-provided username or renderer claim can replace the current OS identity. */
async function ownerIdentity(): Promise<string> {
  const user = os.userInfo();
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot;
    if (!system || !path.isAbsolute(system)) throw new Error('The OS identity is unavailable.');
    const answer = await execute(path.join(system, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024,
    });
    const sids = answer.stdout.match(/\bS-1-\d+(?:-\d+)+\b/g);
    if (sids?.length !== 1) throw new Error('The OS identity is unavailable.');
    return digest({ platform: process.platform, sid: sids[0], user: user.username, home: user.homedir });
  }
  if (!Number.isSafeInteger(user.uid) || user.uid < 0) throw new Error('The OS identity is unavailable.');
  return digest({ platform: process.platform, uid: user.uid, user: user.username, home: user.homedir });
}

/**
 * Only the protected desktop host constructs this object. It never installs a global backend,
 * performs network admission, changes policy, or reacquires Store.locked. Private issued records
 * contain identity bindings, not Authorities or permissions. A fresh instance refuses every old ref.
 */
export async function createLocalTrustBackend(options: LocalTrustBackendOptions) {
  const now = options.now ?? Date.now;
  const host = randomBytes(32).toString('hex');
  let closed = false;
  const issued = new Map<string, IssuedIdentity>();
  const proof = await Promise.all([ownerIdentity(), directoryIdentity(options.store.dataDir)])
    .then(([owner, root]) => ({ owner, root })).catch(() => null);

  function facts(projectId: string): { personal: PersonalAuthorityFacts; account: AccountIdentity } | null {
    if (closed || !proof || !text(projectId)) return null;
    try {
      const account = options.accountFacts();
      const personal = options.personalFacts(projectId);
      if (!account || account.backendKind !== 'cloud' || !text(account.backendKey) || !text(account.personId) ||
          !text(account.sessionId) || !epoch(account.lifecycle) || account.publishedLifecycle !== account.lifecycle ||
          !text(account.expiresAt) || !Number.isFinite(Date.parse(account.expiresAt)) || Date.parse(account.expiresAt) <= now() ||
          !personal || personal.projectId !== projectId || personal.tenantId !== 'local' || !positive(personal.generation) ||
          !text(personal.projectFolder) || !path.isAbsolute(personal.projectFolder)) return null;
      const project = options.store.state(projectId).project;
      if (project.id !== projectId || path.resolve(project.folder) !== path.resolve(personal.projectFolder)) return null;
      return {
        personal: { projectId, tenantId: 'local', generation: personal.generation, projectFolder: personal.projectFolder },
        account: { backendKind: 'cloud', backendKey: account.backendKey, personId: account.personId,
          sessionId: account.sessionId, lifecycle: account.lifecycle, publishedLifecycle: account.publishedLifecycle },
      };
    } catch { return null; }
  }

  async function scope(projectId: string): Promise<ScopeIdentity | null> {
    const before = facts(projectId);
    if (!before || !proof) return null;
    try {
      const [root, folder] = await Promise.all([
        directoryIdentity(options.store.dataDir), directoryIdentity(before.personal.projectFolder),
      ]);
      const after = facts(projectId);
      if (!after || !same(before, after) || !same(root, proof.root)) return null;
      return { ...before.personal, account: before.account, root, folder, owner: proof.owner, host };
    } catch { return null; }
  }

  function member(projectId: string, slotId: string): Omit<MemberIdentity, 'tokenDigest'> | null {
    if (closed || slotId === 'owner' || !text(slotId)) return null;
    try {
      const found = options.store.state(projectId).team?.members.find(item => item.slotId === slotId);
      if (!found || found.status === 'stopped') {
        // Use existing Trust revocation for an observed stopped/deleted identity. Restoring a
        // status alone cannot revive it; a new token/creation/scope binds a different identity.
        for (const record of issued.values()) if (record.kind === 'team-member' &&
            record.scope.projectId === projectId && record.member?.slotId === slotId)
          void revoke({ kind: 'team-member', id: record.id }, 'The local Team identity stopped or was removed.');
        return null;
      }
      return { slotId, createdAt: found.createdAt, threadId: found.threadId ?? null };
    } catch { return null; }
  }

  async function memberScope(projectId: string, slotId: string, suppliedToken?: string) {
    const before = await scope(projectId);
    const beforeMember = member(projectId, slotId);
    if (!before || !beforeMember) return null;
    try {
      const expected = (await options.store.readTeamSecrets(projectId))[slotId];
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected) ||
          (suppliedToken !== undefined && (!/^[0-9a-f]{64}$/.test(suppliedToken) ||
            !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(suppliedToken, 'hex'))))) return null;
      const after = await scope(projectId);
      const afterToken = (await options.store.readTeamSecrets(projectId))[slotId];
      const afterFacts = facts(projectId);
      const afterMember = member(projectId, slotId);
      if (!after || !afterFacts || !afterMember || expected !== afterToken || !same(before, after) ||
          !same(beforeMember, afterMember) || !same(after.account, afterFacts.account) ||
          !same({ projectId: after.projectId, tenantId: after.tenantId, generation: after.generation,
            projectFolder: after.projectFolder }, afterFacts.personal)) return null;
      return { scope: after, member: { ...afterMember, tokenDigest: digest(expected) } };
    } catch { return null; }
  }

  function remember(kind: IssuedIdentity['kind'], bound: ScopeIdentity, slot: MemberIdentity | null) {
    const id = `local:${kind}:${digest({ kind, scope: bound, member: slot })}`;
    const record: IssuedIdentity = { id, kind, scope: bound, member: slot };
    issued.set(id, record);
    return record;
  }

  function principal(record: IssuedIdentity): Principal {
    return { kind: record.kind, id: record.id, tenantId: 'local', projectId: record.scope.projectId,
      deviceId: null, sessionId: null, slotId: record.member?.slotId ?? null };
  }

  async function resolveIssued(record: IssuedIdentity): Promise<Principal | null> {
    if (closed) return null;
    if (record.kind === 'team-member' && record.member) {
      const current = await memberScope(record.scope.projectId, record.member.slotId);
      if (!current || !same(current.scope, record.scope) || !same(current.member, record.member)) return null;
    } else {
      const current = await scope(record.scope.projectId);
      if (!current || !same(current, record.scope)) return null;
    }
    return closed ? null : principal(record);
  }

  const backend: TrustBackend = {
    async localOwner(ownerId) {
      const record = issued.get(ownerId);
      return record?.kind === 'local-owner' ? resolveIssued(record) : null;
    },
    async lookupTeamMember(projectId, slotId, token) {
      const current = await memberScope(projectId, slotId, token);
      return current && !closed ? principal(remember('team-member', current.scope, current.member)) : null;
    },
    async lookupPrincipalRef(ref) {
      if (closed || ref.tenantId !== 'local' || (ref.kind !== 'local-owner' && ref.kind !== 'team-member')) return null;
      const record = issued.get(ref.id);
      if (!record || record.kind !== ref.kind) return null;
      return resolveIssued(record);
    },
  };
  const resolve = async (claim: AuthorityClaim): Promise<Authority | Denial> => {
    const result = requireGenuine(await currentAuthority(claim, backend));
    if (isDenial(result)) return result;
    // finish() itself yields to existing revocation checks. Re-read the synchronous facts
    // after that yield, so sign-out cannot mint old Current under a newer lifecycle.
    const record = issued.get(result.principal.id);
    const live = record ? facts(record.scope.projectId) : null;
    if (!record || !live || !same(live.account, record.scope.account) ||
        !same(live.personal, { projectId: record.scope.projectId, tenantId: record.scope.tenantId,
          generation: record.scope.generation, projectFolder: record.scope.projectFolder }) ||
        (record.member && !same(member(record.scope.projectId, record.member.slotId), {
          slotId: record.member.slotId, createdAt: record.member.createdAt, threadId: record.member.threadId,
        }))) return denial(403, 'unknown-principal', 'Current protected desktop identity changed during resolution.');
    if (!same(generationFor(result.principal), result.generation))
      return denial(409, 'generation-advanced', 'Trust changed during desktop identity resolution.');
    return result;
  };

  return {
    resolve,
    async ownerAuthority(projectId: string): Promise<Authority | Denial> {
      const current = await scope(projectId);
      if (!current || closed) return denial(403, 'unknown-principal', 'Current protected desktop Personal authority is unavailable.');
      const record = remember('local-owner', current, null);
      return resolve({ via: 'local-owner', ownerId: record.id });
    },
    close() { closed = true; issued.clear(); },
  };
}
