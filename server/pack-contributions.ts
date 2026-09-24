/**
 * P04: registering a pack's contribution index on activation, and loading one
 * contribution's body only when it is needed.
 *
 * The contract is `shared/pack-contributions.ts`. Four properties are the
 * point of this file:
 *
 * 1. **Index on activation, bodies on demand.** Turning a pack on registers an
 *    index (names, one-line descriptions, triggers, a digest per body) on the
 *    Project's own state, through the one activation writer
 *    (`recordPackActivation`). No body is read then.
 * 2. **A run pins what it was admitted with.** `admit` snapshots the indexes
 *    of the packs that are on at admission. A load names a contribution and
 *    resolves through that pin, so a run admitted before a deactivation, an
 *    update or a rollback keeps the version it pinned, and a run admitted after
 *    sees the change.
 * 3. **The digest is checked at every load.** The body is hashed as it is read
 *    and compared with the digest the index registered. A mismatch is recorded
 *    and refused; the body is never used.
 * 4. **Every load is evidence.** A load, a refusal, a registration and an
 *    unload each append a `ContributionRecord` and are stated in History with
 *    the contribution's identity, the pack version and the digest.
 *
 * Nothing here reads or writes a grant, a Need or a permission: loading a
 * contribution is not authorization (`AGENTS.md` decision 14).
 */
import { createHash } from 'node:crypto';
import {
  CAPABILITY_PACKS,
  isCapabilityPackId,
  isPackActive,
  renderSkillPlaybook,
  type CapabilityPackManifest,
} from '../shared/capability-packs.js';
import {
  canonicalJson,
  manifestFromCapabilityPack,
  type PackManifestBody,
} from '../shared/pack-manifest.js';
import {
  contributionSentence,
  oneLine,
  type ContributionIndexEntry,
  type ContributionKind,
  type ContributionLoadReason,
  type ContributionRecord,
  type ContributionRef,
  type LoadedContribution,
  type RegisteredPackIndex,
} from '../shared/pack-contributions.js';
import type { HistoryEntry, ProjectState } from '../shared/types.js';
import { ApiError } from './paths.js';
import { identifier, now, type Store } from './store.js';

/** The live Project state the store persists. */
type Stored = Parameters<Store['persist']>[0];

/** One contribution with its body, as a pack version supplies it. */
export interface ContributionBody {
  readonly kind: ContributionKind;
  readonly id: string;
  readonly name: string;
  readonly line: string;
  readonly triggers: readonly string[];
  readonly surface?: ContributionIndexEntry['surface'];
  readonly body: string;
}

/** Everything one pack version contributes, bodies included. Never stored; read when needed. */
export interface PackBodies {
  readonly packId: string;
  readonly packVersion: string;
  readonly packName: string;
  readonly contributions: readonly ContributionBody[];
}

export const contributionDigest = (body: string) =>
  `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;

const MANIFEST_KINDS: readonly [keyof PackManifestBody['contributions'], ContributionKind][] = [
  ['tools', 'tool'],
  ['agents', 'agent'],
  ['rules', 'rule'],
  ['context', 'context'],
  ['workflows', 'workflow'],
  ['ui', 'ui'],
];

/**
 * An installed manifest's contributions with their bodies. The body of a
 * declared contribution is its declaration, in canonical JSON, so its digest is
 * stable however the publisher formatted the file.
 */
export function bodiesFromManifest(manifest: PackManifestBody): PackBodies {
  const contributions: ContributionBody[] = [];
  for (const [key, kind] of MANIFEST_KINDS)
    for (const item of manifest.contributions[key] as readonly Record<string, unknown>[]) {
      const id = String(item.id);
      const name = typeof item.name === 'string' ? item.name : id;
      const described =
        typeof item.description === 'string'
          ? item.description
          : typeof item.role === 'string'
            ? item.role
            : typeof item.label === 'string'
              ? item.label
              : name;
      contributions.push({
        kind,
        id,
        name: typeof item.label === 'string' ? item.label : name,
        line: oneLine(described),
        triggers: [],
        ...(kind === 'ui' ? { surface: item.surface as ContributionIndexEntry['surface'] } : {}),
        body: canonicalJson(item),
      });
    }
  return {
    packId: manifest.id,
    packVersion: manifest.version,
    packName: manifest.name,
    contributions,
  };
}

/**
 * A built-in pack's contributions. The same as its manifest form, except that
 * a skill's body is the playbook exactly as a request would carry it
 * (`renderSkillPlaybook`) and its triggers are the skill's own.
 */
export function bodiesFromBuiltin(pack: CapabilityPackManifest): PackBodies {
  const declared = bodiesFromManifest(manifestFromCapabilityPack(pack));
  return {
    ...declared,
    contributions: declared.contributions.map((item) => {
      if (item.kind !== 'workflow') return item;
      const skill = pack.skills.find((candidate) => candidate.id === item.id);
      return skill
        ? {
            ...item,
            name: skill.name,
            line: oneLine(skill.value),
            triggers: [...skill.triggers],
            body: renderSkillPlaybook(skill, pack.version),
          }
        : item;
    }),
  };
}

/** The index for one pack version: every contribution, no body. */
export function indexFor(bodies: PackBodies, at: string): RegisteredPackIndex {
  return {
    packId: bodies.packId,
    packVersion: bodies.packVersion,
    packName: bodies.packName,
    registeredAt: at,
    entries: bodies.contributions.map((item) => ({
      kind: item.kind,
      id: item.id,
      name: item.name,
      line: item.line,
      triggers: item.triggers,
      digest: contributionDigest(item.body),
      bytes: Buffer.byteLength(item.body),
      ...(item.surface ? { surface: item.surface } : {}),
    })),
  };
}

/** A built-in pack's index. Pure apart from hashing, so an activation can register it synchronously. */
export const builtinIndex = (pack: CapabilityPackManifest, at: string) =>
  indexFor(bodiesFromBuiltin(pack), at);

function append(
  store: Store,
  state: Stored,
  record: Omit<ContributionRecord, 'id' | 'at'>,
  at: string,
  entry: HistoryEntry | 'new' | null,
): ContributionRecord {
  const full: ContributionRecord = { id: identifier('K'), at, ...record };
  state.contributionRecords = [...(state.contributionRecords ?? []), full];
  const sentence = contributionSentence(full, packName(state, full.packId));
  const target =
    entry === 'new'
      ? store.addEntry(state, { kind: 'pack-contribution', actor: 'diomedes', sentence })
      : entry;
  if (target) target.contribution = full;
  return full;
}

function packName(state: ProjectState, packId: string) {
  return (
    state.packIndex?.[packId]?.packName ??
    (isCapabilityPackId(packId) ? CAPABILITY_PACKS[packId].name : packId)
  );
}

/**
 * Register an index for a pack that is on in this Project. `entry` is the
 * History entry that already states why (turning it on, an update, a
 * rollback); the registration rides on it rather than saying the same thing
 * twice (decision 4). Pass `'new'` when nothing else says it.
 */
export function registerIndex(
  store: Store,
  state: Stored,
  index: RegisteredPackIndex,
  detail: string,
  entry: HistoryEntry | 'new' | null,
): ContributionRecord {
  state.packIndex = { ...(state.packIndex ?? {}), [index.packId]: index };
  return append(
    store,
    state,
    { outcome: 'indexed', packId: index.packId, packVersion: index.packVersion, detail },
    index.registeredAt,
    entry,
  );
}

/**
 * The pack was turned off here: its index goes, and so does everything it had
 * loaded in this Project. A run admitted earlier keeps its pin and is not
 * touched. Returns null when the pack had nothing registered.
 */
export function unloadPack(
  store: Store,
  state: Stored,
  packId: string,
  at: string,
  entry: HistoryEntry | null,
): ContributionRecord | null {
  const index = state.packIndex?.[packId];
  if (!index) return null;
  const { [packId]: _gone, ...rest } = state.packIndex!;
  state.packIndex = rest;
  const loaded = loadedIn(state).filter((item) => item.packId === packId);
  return append(
    store,
    state,
    {
      outcome: 'unloaded',
      packId,
      packVersion: index.packVersion,
      detail: loaded.length
        ? `Unloaded ${loaded.length} loaded ${loaded.length === 1 ? 'contribution' : 'contributions'}: ${loaded
            .map((item) => `${item.kind} ${item.contributionId}`)
            .join(', ')}.`
        : 'Nothing from it was loaded.',
    },
    at,
    entry,
  );
}

/**
 * What is loaded in a Project now: every contribution loaded since its pack's
 * most recent registration or unload, once each. Read from the records alone.
 */
export function loadedIn(state: ProjectState): ContributionRecord[] {
  const loaded = new Map<string, ContributionRecord>();
  for (const record of state.contributionRecords ?? []) {
    if (record.outcome === 'unloaded' || record.outcome === 'indexed') {
      for (const key of [...loaded.keys()])
        if (loaded.get(key)!.packId === record.packId) loaded.delete(key);
      continue;
    }
    if (record.outcome === 'loaded')
      loaded.set(`${record.packId}\u0000${record.kind}\u0000${record.contributionId}`, record);
  }
  return [...loaded.values()];
}

/** The indexes of the packs that are on in this Project. Nothing for a pack that is off. */
export function activeIndexes(state: ProjectState): RegisteredPackIndex[] {
  return Object.values(state.packIndex ?? {})
    .filter((index) => isPackActive(state.project.packs, index.packId))
    .sort((a, b) => (a.packId < b.packId ? -1 : 1));
}

/**
 * What one admitted run may load: the indexes that were registered, or that
 * would be registered on first use, when the run was admitted. Held in memory
 * for the run's life; never persisted.
 */
export interface ContributionPin {
  readonly projectId: string;
  readonly runKey: string;
  readonly pinnedAt: string;
  readonly indexes: readonly RegisteredPackIndex[];
  /** Packs whose index this pin computed because the Project had none at this version yet. */
  readonly unregistered: readonly string[];
  /** Bodies this run already loaded, so a second ask costs nothing and records nothing. */
  readonly loaded: Map<string, LoadedContribution>;
}

export interface PackContributionsOptions {
  readonly store: Store;
  /**
   * One pack version's contributions with their bodies, or null when that
   * version is no longer available to this build (uninstalled, or damaged).
   */
  readonly bodies: (packId: string, version: string) => Promise<PackBodies | null>;
  /** The version of a pack this build would use now, or null when it has none it can use. */
  readonly current: (packId: string) => Promise<PackBodies | null>;
  readonly clock?: () => string;
}

export interface LoadOptions {
  readonly reason: ContributionLoadReason;
  /**
   * The Project state to write into, when the caller already holds the store
   * lock and persists after (a send). Without it the load takes the lock and
   * persists itself.
   */
  readonly state?: Stored;
}

/** The built-in bodies for one version, or null when this build carries another. */
export function builtinBodies(packId: string, version: string | null): PackBodies | null {
  if (!isCapabilityPackId(packId)) return null;
  const pack = CAPABILITY_PACKS[packId];
  return version === null || pack.version === version ? bodiesFromBuiltin(pack) : null;
}

export class PackContributions {
  private readonly clock: () => string;

  constructor(private readonly options: PackContributionsOptions) {
    this.clock = options.clock ?? now;
  }

  /**
   * Pin the indexes a run may load from. Reads only: a pack that is on but has
   * no index at its current version (it was turned on before indexes existed,
   * or this build updated it) gets one computed here and registered at its
   * first load, so admission never writes.
   */
  async admit(state: ProjectState, runKey: string): Promise<ContributionPin> {
    const pinnedAt = this.clock();
    const indexes: RegisteredPackIndex[] = [];
    const unregistered: string[] = [];
    const ids = [...new Set((state.project.packs ?? []).map((item) => item.packId))].sort();
    for (const packId of ids) {
      if (!isPackActive(state.project.packs, packId)) continue;
      const current = await this.options.current(packId);
      if (!current) continue;
      const registered = state.packIndex?.[packId];
      if (registered && registered.packVersion === current.packVersion) {
        indexes.push(structuredClone(registered));
        continue;
      }
      indexes.push(indexFor(current, pinnedAt));
      unregistered.push(packId);
    }
    return {
      projectId: state.project.id,
      runKey,
      pinnedAt,
      indexes,
      unregistered,
      loaded: new Map(),
    };
  }

  /**
   * Load one contribution's body through a run's pin.
   *
   * Refused with a code when the pack was not on at admission
   * (`pack_inactive`), the contribution is not in its index
   * (`unknown_contribution`), the pinned version is no longer available
   * (`version_unavailable`) or the body does not hash to the registered digest
   * (`digest_mismatch`). The last two are recorded; the first two name nothing
   * this Project has, so there is nothing to record.
   */
  async load(pin: ContributionPin, ref: ContributionRef, options: LoadOptions): Promise<LoadedContribution> {
    const key = `${ref.packId}\u0000${ref.kind}\u0000${ref.id}`;
    const cached = pin.loaded.get(key);
    if (cached) return cached;
    const index = pin.indexes.find((item) => item.packId === ref.packId);
    if (!index)
      throw new ApiError(
        409,
        'That pack is not on in this project, so nothing from it loads. Turning it on adds no permission.',
        { code: 'pack_inactive' },
      );
    const entry = index.entries.find((item) => item.kind === ref.kind && item.id === ref.id);
    if (!entry)
      throw new ApiError(404, `${index.packName} ${index.packVersion} has no ${ref.kind} ${ref.id}.`, {
        code: 'unknown_contribution',
      });
    const run = async (state: Stored, persist: boolean) => {
      const at = this.clock();
      if (pin.unregistered.includes(index.packId) && state.packIndex?.[index.packId]?.packVersion !== index.packVersion)
        registerIndex(
          this.options.store,
          state,
          index,
          state.packIndex?.[index.packId]
            ? `Diomedes now carries ${index.packName} ${index.packVersion}; this project's index moved to it at first use.`
            : `${index.packName} was on here before contribution indexes existed; its index was registered at first use.`,
          'new',
        );
      const base = {
        packId: index.packId,
        packVersion: index.packVersion,
        kind: entry.kind,
        contributionId: entry.id,
        name: entry.name,
        digest: entry.digest,
        reason: options.reason,
        runKey: pin.runKey,
        pinnedAt: pin.pinnedAt,
      };
      const refuse = async (code: string, detail: string, extra: Partial<ContributionRecord> = {}) => {
        append(this.options.store, state, { ...base, ...extra, outcome: 'refused', code, detail }, at, 'new');
        // Persisted before the refusal leaves: the record is the evidence, whatever the caller does next.
        await this.options.store.persist(state);
        throw new ApiError(409, `${entry.name} was not loaded. ${detail}`, { code });
      };
      const bodies = await this.options.bodies(index.packId, index.packVersion);
      if (!bodies)
        return refuse(
          'version_unavailable',
          `${index.packName} ${index.packVersion} is no longer available to this build.`,
        );
      const body = bodies.contributions.find((item) => item.kind === entry.kind && item.id === entry.id);
      if (!body)
        return refuse(
          'version_unavailable',
          `${index.packName} ${index.packVersion} no longer contains it.`,
        );
      const actual = contributionDigest(body.body);
      if (actual !== entry.digest)
        return refuse(
          'digest_mismatch',
          `Its content changed since ${index.packName} ${index.packVersion} was registered here: it hashes to ${actual.slice(7, 19)}, not ${entry.digest.slice(7, 19)}. It was not used.`,
          { actualDigest: actual },
        );
      const bytes = Buffer.byteLength(body.body);
      const record = append(
        this.options.store,
        state,
        { ...base, outcome: 'loaded', bytes, detail: `${bytes} bytes` },
        at,
        'new',
      );
      if (persist) await this.options.store.persist(state);
      const loaded: LoadedContribution = {
        packId: index.packId,
        packVersion: index.packVersion,
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        digest: entry.digest,
        bytes,
        body: body.body,
        recordId: record.id,
      };
      pin.loaded.set(key, loaded);
      return loaded;
    };
    if (options.state) return run(options.state, false);
    return this.options.store.locked(() => run(this.options.store.state(pin.projectId), true));
  }
}
