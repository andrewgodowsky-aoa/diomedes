/**
 * The desktop's half of ORG-01: a signed-in business's setup comes from the
 * account service, and this computer keeps a tagged copy of it.
 *
 *   <data>/workspaces/setup/<org>.json                the setup, as before (a BusinessSetup)
 *   <data>/workspaces/setup/<org>.sync.json           which service revision that file is, and for whom
 *   <data>/workspaces/setup/<org>.before-sync[-n].json  a setup only this computer held, set aside
 *
 * The setup file keeps its old shape on purpose. The workspace service loads it
 * by organization id at start, the configuration service compares activation
 * against its answers (`server/configuration.ts`), and a business kept only on
 * this computer (no account service) is unchanged.
 *
 * What this module will not do:
 * - **show a blank setup because loading failed.** An unreachable service with
 *   no usable copy is a load error (`decideSetupLoad`), never "not started";
 * - **write while the service cannot be reached.** A copy shown offline is
 *   read-only. There is no queue of offline edits that could win later;
 * - **use a copy after a refusal.** A revoked or signed-out person gets the
 *   refusal, whatever this computer still holds;
 * - **overwrite someone else's revision.** Every write names the revision it
 *   was made from, and the service decides;
 * - **delete a setup only this computer held.** Before the business's setup
 *   replaces one, it is set aside under a name nothing else reads (decision 10).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BusinessSetup } from '../shared/business-setup.js';
import {
  decideSetupLoad,
  SETUP_UNREACHABLE_REASON,
  type OrganizationSetupWrite,
  type SetupCacheTag,
  type SetupCopy,
  type SetupFetchOutcome,
  type SetupLoad,
  type SetupWriteOutcome,
} from '../shared/organization-setup.js';
import { ApiError } from './paths.js';
import { jsonWrite, readJson } from './store.js';

const MISSING = Symbol('missing');

/** The account service, as the setup sees it (`AccountSessionService` in production). */
export interface SetupRemote {
  read(organizationId: string): Promise<SetupFetchOutcome>;
  write(organizationId: string, input: OrganizationSetupWrite): Promise<SetupWriteOutcome>;
}

/** Who is opening which business's setup on this computer, and what they may do there. */
export interface SetupSubject {
  organizationId: string;
  tenantId: string;
  personId: string;
  /** This person's access generation for the business on this computer now. */
  generation: number;
  /** An active owner or Manager. Only they save, including moving an old setup to the service. */
  mayConfigure: boolean;
}

export const SETUP_SAVE_UNREACHABLE =
  "The account service can't be reached, so this change wasn't saved. Try again when the connection is back.";

/** The same words the intake has always used for a concurrent edit. */
export const SETUP_SAVE_CONFLICT = 'Someone else changed this setup while you were answering. Reload it and try again.';

/** This computer's own files failed, not the service: said as such, and never as a blank setup. */
export const SETUP_LOCAL_ERROR_REASON =
  "This computer couldn't open its copy of this business's setup. Nothing was reset. Try again.";

/** A save that lost to someone else's. `load` is what the business holds now, when it could be read. */
export class SetupConflict extends ApiError {
  constructor(readonly load: SetupLoad | null) {
    super(409, SETUP_SAVE_CONFLICT, { code: 'setup_conflict' });
  }
}

/** What a save leaves this computer holding. */
export type SetupSaved = Extract<SetupLoad, { kind: 'service' | 'local' }>;

/** A refusal of the record itself (a credential, another business, a shape), not of the person. */
const refusesRecord = (code: string) => code === 'invalid_setup' || code.startsWith('setup_');
/** A refusal that means this person may not see the business's setup at all. */
const refusesPerson = (code: string) => code === 'sign_in_required' || code === 'not_a_member';

/** A setup file, if it is one for this business; anything else is not a copy of it. */
function asSetup(value: unknown, organizationId: string): BusinessSetup | null {
  if (!value || typeof value !== 'object') return null;
  const setup = value as BusinessSetup;
  return setup.organizationId === organizationId && typeof setup.answers === 'object' && setup.answers !== null
    ? setup
    : null;
}

function asTag(value: unknown): SetupCacheTag | null {
  if (!value || typeof value !== 'object') return null;
  const tag = value as SetupCacheTag;
  return tag.v === 1 &&
    typeof tag.organizationId === 'string' &&
    typeof tag.tenantId === 'string' &&
    typeof tag.personId === 'string' &&
    Number.isInteger(tag.generation) &&
    Number.isInteger(tag.revision) &&
    typeof tag.fetchedAt === 'string'
    ? tag
    : null;
}

/** Whether the person started the setup and gave every answer in it. */
function attributableTo(setup: BusinessSetup, personId: string): boolean {
  return setup.startedBy === personId && Object.values(setup.answers).every((answer) => answer.by === personId);
}

/** JSON with sorted keys: the service's database does not keep the order a setup was written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}

/** What is on this computer for one business. */
interface Found extends SetupCopy {
  /** The setup file exists but is not a readable setup for this business. */
  unreadable: boolean;
}

export class OrganizationSetupSync {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Businesses whose old setup the service would not hold. It is not offered again this run. */
  private readonly declined = new Set<string>();

  constructor(
    /** `<data>/workspaces/setup`. */
    private readonly dir: string,
    private readonly remote: SetupRemote,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setupPath(organizationId: string) {
    return path.join(this.dir, `${organizationId}.json`);
  }
  private tagPath(organizationId: string) {
    return path.join(this.dir, `${organizationId}.sync.json`);
  }
  /** Where a setup only this computer held is kept: the first one plainly, later ones numbered. */
  asidePath(organizationId: string, n = 1) {
    return path.join(this.dir, n === 1 ? `${organizationId}.before-sync.json` : `${organizationId}.before-sync-${n}.json`);
  }

  /** One load or save per business at a time, whoever calls. */
  private serial<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(organizationId) ?? Promise.resolve()).then(work, work);
    this.queues.set(organizationId, next.catch(() => undefined));
    return next;
  }

  /** A file's JSON, telling a missing file apart from one that is there but unreadable. */
  private async raw(target: string): Promise<{ present: boolean; value: unknown }> {
    try {
      const value = await readJson<unknown>(target, () => MISSING);
      return value === MISSING ? { present: false, value: null } : { present: true, value };
    } catch {
      return { present: true, value: null };
    }
  }

  private async find(organizationId: string): Promise<Found> {
    const file = await this.raw(this.setupPath(organizationId));
    const setup = asSetup(file.value, organizationId);
    return {
      setup,
      tag: setup ? asTag((await this.raw(this.tagPath(organizationId))).value) : null,
      unreadable: file.present && setup === null,
    };
  }

  /** This computer's copy and its tag, as found. A missing or unreadable file is no copy. */
  async copy(organizationId: string): Promise<SetupCopy> {
    const { setup, tag } = await this.find(organizationId);
    return { setup, tag };
  }

  /**
   * The service revision this computer's copy on disk is, 0 when there is none.
   * For inspection: a save names the revision its content was read with, which
   * the caller holds (see `save`).
   */
  async revision(organizationId: string): Promise<number> {
    return (await this.copy(organizationId)).tag?.revision ?? 0;
  }

  /** Keep a service revision as this computer's copy. */
  private async keep(subject: SetupSubject, revision: number, setup: BusinessSetup) {
    // The tag goes first, so an interrupted write leaves an untagged copy, which
    // is never shown in place of the service, rather than a mislabelled one.
    await fs.rm(this.tagPath(subject.organizationId), { force: true });
    await jsonWrite(this.setupPath(subject.organizationId), setup);
    const tag: SetupCacheTag = {
      v: 1,
      organizationId: subject.organizationId,
      tenantId: subject.tenantId,
      personId: subject.personId,
      generation: subject.generation,
      revision,
      fetchedAt: this.now().toISOString(),
    };
    await jsonWrite(this.tagPath(subject.organizationId), tag);
  }

  /** Move the setup file to the first free set-aside name. Nothing is overwritten or deleted. */
  private async setAside(organizationId: string) {
    await fs.rm(this.tagPath(organizationId), { force: true });
    for (let n = 1; n <= 1_000; n += 1) {
      const target = this.asidePath(organizationId, n);
      if ((await this.raw(target)).present) continue;
      await fs.rename(this.setupPath(organizationId), target);
      return;
    }
    throw new Error('Too many set-aside setups for this business.');
  }

  /**
   * What this business's setup is on this computer now, refreshing the copy
   * from the service. A setup only this computer held, from before the service
   * kept setups, becomes the business's first revision when the person who
   * started it and gave every answer opens it and may configure. Otherwise it
   * is set aside, and offered again the next time such a person opens it.
   */
  load(subject: SetupSubject): Promise<SetupLoad> {
    return this.serial(subject.organizationId, () => this.refresh(subject, true));
  }

  private async refresh(subject: SetupSubject, mayMove: boolean): Promise<SetupLoad> {
    const organizationId = subject.organizationId;
    const found = await this.find(organizationId);
    const decided = decideSetupLoad({ ...subject, fetched: await this.remote.read(organizationId), copy: found });
    if (decided.kind !== 'service') return decided;
    const localOnly = found.unreadable || (found.setup !== null && found.tag === null);

    if (decided.setup) {
      if (localOnly && (found.setup === null || canonical(found.setup) !== canonical(decided.setup)))
        await this.setAside(organizationId);
      await this.keep(subject, decided.revision, decided.setup);
      return decided;
    }

    // The service holds no setup for this business yet.
    const candidate = found.unreadable
      ? null
      : found.setup === null
        ? asSetup((await this.raw(this.asidePath(organizationId))).value, organizationId)
        : found.tag === null
          ? found.setup
          : null;
    if (
      mayMove &&
      candidate &&
      !this.declined.has(organizationId) &&
      subject.mayConfigure &&
      candidate.tenantId === subject.tenantId &&
      attributableTo(candidate, subject.personId)
    ) {
      const moved = await this.remote.write(organizationId, { expectedRevision: 0, record: { v: 1, setup: candidate } });
      switch (moved.kind) {
        case 'written': {
          const setup = moved.answer.record?.setup ?? candidate;
          await this.keep(subject, moved.answer.revision, setup);
          return {
            kind: 'service',
            revision: moved.answer.revision,
            setup,
            writtenAt: moved.answer.writtenAt,
            writtenBy: moved.answer.writtenBy,
          };
        }
        case 'conflict':
          // Someone saved first. Theirs is the business's setup; this one is set aside.
          return this.refresh(subject, false);
        case 'refused':
          if (refusesPerson(moved.code)) return { kind: 'refused', code: moved.code, reason: moved.message };
          // The record (a credential, another person's answers) or this role: set aside below.
          this.declined.add(organizationId);
          break;
        case 'unreachable':
        case 'unsupported':
          return { kind: 'load-error', reason: SETUP_UNREACHABLE_REASON };
      }
    }
    if (found.setup !== null || found.unreadable) await this.setAside(organizationId);
    return decided;
  }

  /**
   * Save the next revision through the service, then keep it here.
   * `expectedRevision` must be the revision `setup` was made from, read
   * together with it, never looked up again at save time: a copy refreshed in
   * between would otherwise let this save overwrite what the refresh brought.
   *
   * A refusal is thrown as an ApiError the routes pass on. A conflict throws
   * `SetupConflict` carrying what the business holds now, so the caller shows
   * the other person's work. A service that keeps no setups leaves the setup to
   * this computer alone, as before ORG-01.
   */
  save(subject: SetupSubject, setup: BusinessSetup, expectedRevision: number): Promise<SetupSaved> {
    return this.serial(subject.organizationId, async (): Promise<SetupSaved> => {
      const organizationId = subject.organizationId;
      const outcome = await this.remote.write(organizationId, { expectedRevision, record: { v: 1, setup } });
      switch (outcome.kind) {
        case 'written': {
          const saved = outcome.answer.record?.setup ?? setup;
          await this.keep(subject, outcome.answer.revision, saved);
          return {
            kind: 'service',
            revision: outcome.answer.revision,
            setup: saved,
            writtenAt: outcome.answer.writtenAt,
            writtenBy: outcome.answer.writtenBy,
          };
        }
        case 'unsupported':
          await fs.rm(this.tagPath(organizationId), { force: true });
          await jsonWrite(this.setupPath(organizationId), setup);
          return { kind: 'local', setup };
        case 'conflict':
          throw new SetupConflict(await this.refresh(subject, false).catch(() => null));
        case 'unreachable':
          throw new ApiError(503, SETUP_SAVE_UNREACHABLE, { code: 'setup_unavailable' });
        case 'refused':
          throw new ApiError(
            outcome.code === 'sign_in_required' ? 401 : refusesRecord(outcome.code) ? 422 : 403,
            outcome.message,
            { code: outcome.code },
          );
      }
    });
  }
}
