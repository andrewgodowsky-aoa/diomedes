/**
 * Connection policy: which installation a route may use, whether an observation
 * is still current, and the one next setup action to offer.
 *
 * Pure decisions over facts the HOST observed. Nothing here performs IO, reads a
 * credential, launches a process or authorises a run. A renderer never supplies
 * `integrity`, `protocol` or a verified revision; `EngineService` does, from its
 * own discovery, digest and handshake checks. `'ready'` is presentation. The
 * live admission inside `EngineService.generate()` still decides every dispatch.
 */
export type CandidateSource = 'managed' | 'manual' | 'system';

export interface Candidate {
  /** Stable for one installation: `<source>:<engine>:<canonical path>`. */
  readonly id: string;
  readonly engine: string;
  readonly source: CandidateSource;
  readonly present: boolean;
  /** The canonical real path the host resolved, never a PATH spelling. */
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
  /**
   * `verified` for a managed copy: its bytes match the reviewed release digest.
   * `verified` for a system or manual copy: the host resolved a regular file,
   * recorded its SHA-256 and its version probe answered. That pins identity so a
   * later change is detected; it claims no publisher provenance. Provenance is
   * carried separately by the host (`EngineCandidate.provenance`).
   */
  readonly integrity: 'verified' | 'failed' | 'unknown';
  readonly protocol: 'passed' | 'failed' | 'unknown';
}
export interface ReviewedVersion {
  readonly engine: string;
  readonly version: string;
}
export type SelectedBinding = Pick<Candidate, 'id' | 'engine' | 'path' | 'version' | 'sha256'>;
export type RepairReason =
  | 'selected-missing'
  | 'selected-changed'
  | 'selected-unverified'
  | 'no-reviewed-candidate'
  /**
   * The record of what was chosen exists and this build cannot read it, so
   * whether a choice was made is unknown. Produced by the host from its own
   * store, never by `selectCandidate`, and settled only by choosing again.
   */
  | 'record-unreadable';
export type CandidateDecision =
  | { readonly kind: 'candidate'; readonly candidate: Candidate; readonly requiresSelection: boolean }
  | { readonly kind: 'repair'; readonly reason: RepairReason };

/** Recommend a candidate without replacing an existing explicit binding. */
export function selectCandidate(
  inventory: readonly Candidate[],
  reviewed: ReviewedVersion,
  selected?: SelectedBinding,
): CandidateDecision {
  const ids = new Set<string>();
  for (const c of inventory) {
    if (!c.id || ids.has(c.id)) throw new Error('Empty or duplicate candidate identity.');
    ids.add(c.id);
  }
  const usable = (c: Candidate) =>
    c.engine === reviewed.engine &&
    c.version === reviewed.version &&
    c.present &&
    c.path.length > 0 &&
    /^[a-f0-9]{64}$/.test(c.sha256) &&
    c.integrity === 'verified' &&
    c.protocol === 'passed';
  if (selected) {
    const c = inventory.find(
      (row) => row.id === selected.id && row.engine === selected.engine && row.present,
    );
    if (!c) return { kind: 'repair', reason: 'selected-missing' };
    if (c.path !== selected.path || c.version !== selected.version || c.sha256 !== selected.sha256)
      return { kind: 'repair', reason: 'selected-changed' };
    if (!usable(c)) return { kind: 'repair', reason: 'selected-unverified' };
    return { kind: 'candidate', candidate: { ...c }, requiresSelection: false };
  }
  // A reviewed private copy outranks a hand-picked file, which outranks PATH:
  // an unrelated PATH hit must never shadow the copy Diomedes verified.
  const rank = { managed: 0, manual: 1, system: 2 } as const;
  const found = inventory
    .filter(usable)
    .sort((a, b) => rank[a.source] - rank[b.source] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return found
    ? { kind: 'candidate', candidate: { ...found }, requiresSelection: true }
    : { kind: 'repair', reason: 'no-reviewed-candidate' };
}

/** How long one connection observation is presented as current. */
export const CONNECTION_TTL_MS = 300_000;

/**
 * The one expiry boundary, shared by the server's selection guard and every
 * screen. An observation exactly `ttlMs` old is stale; an unreadable or future
 * timestamp is unknown, never fresh.
 */
export function freshness(
  checkedAt: string | null,
  nowMs: number,
  ttlMs = CONNECTION_TTL_MS,
): 'unknown' | 'stale' | 'fresh' {
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new RangeError('A finite clock and positive TTL are required.');
  if (checkedAt === null) return 'unknown';
  const observed = Date.parse(checkedAt);
  if (!Number.isFinite(observed) || observed > nowMs) return 'unknown';
  return nowMs - observed >= ttlMs ? 'stale' : 'fresh';
}

export interface SetupObservation {
  readonly installation: 'missing' | 'unsupported' | 'corrupt' | 'ready';
  readonly installSupported: boolean;
  readonly authentication: 'unknown' | 'signed-in' | 'signed-out';
  readonly accountRouteAllowed: boolean;
  readonly modelCount: number;
  readonly enabled: boolean;
  readonly checkedAt: string | null;
  /** Moves only on a semantic binding change, never on a status poll. */
  readonly revision: number;
  /** Set by the host after a real, consented result is durably recorded. */
  readonly verifiedRevision: number | null;
}
export type SetupAction =
  | 'install'
  | 'repair'
  | 'choose-installation'
  | 'check-connection'
  | 'sign-in'
  | 'explain-account-route'
  | 'resolve-model-access'
  | 'enable'
  | 'test-connection'
  | 'ready';

/** One next action for a person. `'ready'` is presentation, never a run grant. */
export function nextSetupAction(s: SetupObservation, nowMs: number): SetupAction {
  if (
    !Number.isSafeInteger(s.modelCount) ||
    s.modelCount < 0 ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 0 ||
    (s.verifiedRevision !== null &&
      (!Number.isSafeInteger(s.verifiedRevision) || s.verifiedRevision < 0))
  )
    throw new RangeError('Model counts and binding revisions must be non-negative integers.');
  if (s.installation !== 'ready') {
    if (!s.installSupported) return 'choose-installation';
    return s.installation === 'missing' ? 'install' : 'repair';
  }
  if (s.authentication === 'unknown') return 'check-connection';
  if (s.authentication === 'signed-out') return 'sign-in';
  if (!s.accountRouteAllowed) return 'explain-account-route';
  if (s.modelCount === 0) return 'resolve-model-access';
  if (!s.enabled) return 'enable';
  if (freshness(s.checkedAt, nowMs) !== 'fresh') return 'check-connection';
  if (s.verifiedRevision !== s.revision) return 'test-connection';
  return 'ready';
}
