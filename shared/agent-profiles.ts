/**
 * Exact-model Agent profiles (H09).
 *
 * An Agent (`shared/agents.ts`) is a worker contract that runs through
 * whichever compatible model is selected. A profile is the person's saved
 * answer to "which exact model": one engine, one model id exactly as the route
 * lists it, the reasoning level where the route has one, the Agent whose role
 * it works under, and a few rules of the person's own. Profiles are versioned:
 * an edit appends a revision and never rewrites one, because an admitted run
 * pins the revision it resolved and must go on naming it.
 *
 * Routing is an ordered preference list of profiles, per project with a
 * per-task override. Fallback is off unless the person turned it on for that
 * project or task: when the first profile cannot run, the run is refused by
 * name. When fallback is on, the next available profile runs and the record
 * says which one was skipped and why.
 *
 * A profile chooses intelligence. It never grants authority: the Agent's
 * ceiling and the person's grant still decide what a run may do.
 */
import { routeDisplayName } from './engines.js';

export const PROFILE_PROTOCOL_VERSION = 1;
export const PROFILE_MAX_RULES = 8;
export const PROFILE_MAX_RULE = 240;
export const PROFILE_MAX_PROFILES = 64;
export const PROFILE_MAX_ORDER = 8;
/** A model id as a route lists it: a slug, a Bedrock profile id or a vendor/model path. */
export const PROFILE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

/** One immutable revision. Every field is part of what an admitted run pins. */
export interface AgentProfileRevision {
  readonly protocolVersion: 1;
  readonly profileId: string;
  /** 1, 2, 3 … An edit appends; nothing rewrites a revision. */
  readonly revision: number;
  readonly name: string;
  /** A route id (`shared/engines.ts` ROUTES), never `sample`. */
  readonly engine: string;
  /** The exact model id sent to the route. */
  readonly model: string;
  /** The reasoning level, where the route has one. Null leaves the route's own. */
  readonly effort: string | null;
  /** The Agent whose role and ceiling this profile works under, or `auto`. */
  readonly agentId: string;
  /** The person's own rules, sent with the run's instructions and shown in its record. */
  readonly rules: readonly string[];
  readonly createdAt: string;
}

export interface AgentProfileRecord {
  readonly profileId: string;
  /** Oldest first; the last one is current. */
  readonly revisions: readonly AgentProfileRevision[];
  /** Deleted profiles are archived, so the runs that used them still resolve their names. */
  readonly archivedAt: string | null;
}

export interface RoutingPreference {
  /** Profile ids, preferred first. */
  readonly order: readonly string[];
  /** Off unless the person turned it on. */
  readonly fallback: boolean;
}
export type RoutingSource = 'thread' | 'task' | 'project';

/** A profile as the resolver sees it: its current revision, and why it cannot run now. */
export interface ProfileCandidate {
  readonly revision: AgentProfileRevision;
  readonly digest: string;
  /** Null when it can run; otherwise the sentence that says why not. */
  readonly unavailable: string | null;
}

export interface ProfileSkip {
  readonly profileId: string;
  readonly name: string;
  readonly revision: number | null;
  readonly reason: string;
}

/**
 * What an admitted run pins. It is written once, at admission, into the run's
 * Agent resolution and never recomputed: a later edit to the profile makes a
 * new revision and leaves this record naming the one that ran.
 */
export interface ProfileResolution {
  readonly protocolVersion: 1;
  readonly profileId: string;
  readonly revision: number;
  readonly digest: string;
  readonly name: string;
  readonly engine: string;
  readonly model: string;
  readonly effort: string | null;
  readonly agentId: string;
  readonly rules: readonly string[];
  /** Which choice named it: the thread's own pick, the task override or the project list. */
  readonly source: RoutingSource;
  readonly fallbackPolicy: 'off' | 'on';
  /** Set only when an earlier profile could not run and fallback was on. */
  readonly fallback: { readonly fromProfileId: string; readonly fromName: string; readonly reason: string } | null;
  /** Every profile tried before this one, with its reason. */
  readonly skipped: readonly ProfileSkip[];
}

export type ProfileRouting =
  | { readonly outcome: 'none' }
  | { readonly outcome: 'resolved'; readonly pick: ProfileResolution }
  | { readonly outcome: 'refused'; readonly reason: string; readonly tried: readonly ProfileSkip[] };

const MISSING = 'This profile was deleted.';

/**
 * The resolution table. Pure: availability is decided by the caller from host
 * facts and handed in, so the table itself can be tested row by row.
 */
export function resolveProfileRoute(input: {
  source: RoutingSource;
  order: readonly string[];
  fallback: boolean;
  candidates: ReadonlyMap<string, ProfileCandidate>;
}): ProfileRouting {
  if (input.order.length === 0) return { outcome: 'none' };
  const tried: ProfileSkip[] = [];
  const order = [...new Set(input.order)];
  for (const profileId of order) {
    const found = input.candidates.get(profileId);
    const reason = found ? found.unavailable : MISSING;
    if (found && reason === null) {
      const first = tried[0];
      return {
        outcome: 'resolved',
        pick: {
          protocolVersion: 1,
          profileId,
          revision: found.revision.revision,
          digest: found.digest,
          name: found.revision.name,
          engine: found.revision.engine,
          model: found.revision.model,
          effort: found.revision.effort,
          agentId: found.revision.agentId,
          rules: [...found.revision.rules],
          source: input.source,
          fallbackPolicy: input.fallback ? 'on' : 'off',
          fallback: first
            ? { fromProfileId: first.profileId, fromName: first.name, reason: first.reason }
            : null,
          skipped: tried,
        },
      };
    }
    tried.push({
      profileId,
      name: found?.revision.name ?? profileId,
      revision: found?.revision.revision ?? null,
      reason: reason ?? MISSING,
    });
    // Fallback off: the first choice is the only choice.
    if (!input.fallback) break;
  }
  const first = tried[0]!;
  return {
    outcome: 'refused',
    reason: input.fallback
      ? `No profile in this ${input.source === 'task' ? 'task' : 'project'}'s list can run: ${tried
          .map((item) => `${item.name}: ${item.reason}`)
          .join(' ')}`
      : `${first.name} cannot run: ${first.reason} Fallback is off for this ${
          input.source === 'task' ? 'task' : 'project'
        }, so no other profile was tried.`,
    tried,
  };
}

/** One profile as a person reads it: "B (OpenCode · glm-9)". */
export function profileLabel(pick: Pick<ProfileResolution, 'name' | 'engine' | 'model'>): string {
  return `${pick.name} (${routeDisplayName(pick.engine)} · ${pick.model})`;
}

/** The sentence a fallback leaves in the record. Null when no fallback happened. */
export function fallbackSentence(pick: ProfileResolution): string | null {
  if (!pick.fallback) return null;
  return `Ran on ${profileLabel(pick)} because ${pick.fallback.fromName} was unavailable: ${pick.fallback.reason}`;
}

/** Where the choice came from, as the run inspector says it. */
export const ROUTING_SOURCE_LABELS: Record<RoutingSource, string> = {
  thread: "This thread's profile",
  task: "This task's routing preference",
  project: "This project's routing preference",
};

/**
 * Decision 8: the runtime-reported model is the truth about what ran. When it
 * differs from the model a profile asked for, both are kept and the difference
 * is shown. Null when nothing was reported or the two agree.
 */
export function runtimeModelDifference(session: {
  readonly origin?: { readonly model: { readonly requested: string | null; readonly reported: string | null } };
  readonly agent?: { readonly requestedModel: string | null };
  readonly engine: { readonly model: string | null; readonly verified?: boolean };
}): { requested: string; reported: string } | null {
  const requested = session.origin?.model.requested ?? session.agent?.requestedModel ?? null;
  const reported =
    session.origin?.model.reported ?? (session.engine.verified ? session.engine.model : null);
  if (!requested || !reported || requested === reported) return null;
  return { requested, reported };
}
