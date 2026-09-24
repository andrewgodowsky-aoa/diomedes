/**
 * Automations, Milestone A — contract version 1.
 *
 * What a person may ask of this screen: what have we enabled, is it working,
 * what needs a person, and what happened last time. Every answer here is a
 * projection of records that already exist — the active configuration, the
 * output binding, the harness run, the project's Task, Session and Changes —
 * plus the one record Milestone A adds, the `TriggerOccurrence`, which says a
 * person pressed Run once and what admission made of it.
 *
 * Nothing in this file stores a state. `automationLabel` is a pure function of
 * facts, so the same records always read the same way, and a label is never a
 * second lifecycle beside the run's own. In particular nothing here can say an
 * automation runs on its own: the only trigger is `manual`, and the resting
 * label is "Manual — not scheduled" until a scheduler exists (Milestone B).
 *
 * Field names below are frozen for Milestone A (slice A0,
 * docs/implementation/2026-09-24-automations-a.md).
 */
import type { HarnessRunState } from './harness.js';
import type { AutomationSchedule } from './automation-schedule.js';

export const AUTOMATIONS_CONTRACT_VERSION = 1 as const;
/**
 * The occurrence file's envelope. Version 2 (Milestone B) may hold scheduled
 * occurrences; a version 1 file is read as it is and written back as 2. A
 * build that knows only version 1 refuses a version 2 file and leaves it alone.
 */
export const OCCURRENCES_FILE_VERSION = 2 as const;

/** Manual: a person pressed Run once. Schedule: an enabled schedule's slot came due (B). */
export type AutomationTriggerKind = 'manual' | 'schedule';

/** The derived weekly brief's id. One per organization; never stored as a definition in A. */
export const briefAutomationId = (organizationId: string) => `brief:${organizationId}`;

/**
 * A durable record that a person asked for a run, and what admission made of
 * it. It holds references to the run and never the run's state: run, step and
 * Need state are always read from RunService and the project.
 */
export interface TriggerOccurrence {
  readonly v: typeof AUTOMATIONS_CONTRACT_VERSION;
  /** `O-` plus a digest of the organization and the command id. */
  readonly id: string;
  /** `brief:<organizationId>`. */
  readonly automationId: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly trigger: ManualTrigger | ScheduleTrigger;
  /** The configuration revision admission pinned. Null only when there was none to pin. */
  readonly configuration: { readonly revision: number; readonly digest: string } | null;
  /** The project admission pinned. Null only when no output project resolved. */
  readonly target: { readonly projectId: string; readonly projectName: string } | null;
  /** Per-run sources, bound by SHA-256, when an owner or admin chose them. */
  readonly sources: readonly { readonly path: string; readonly sha: string }[] | null;
  readonly observedAt: string;
  readonly admission:
    | { readonly state: 'admitting'; readonly runId: string }
    | {
        readonly state: 'admitted';
        readonly runId: string;
        readonly taskId: string;
        readonly sessionId: string;
        readonly at: string;
      }
    | {
        readonly state: 'refused';
        readonly code: string;
        readonly reason: string;
        readonly at: string;
        /** A run that was created and then stopped before it could proceed, when one exists. */
        readonly runId?: string;
      };
}

export interface ManualTrigger {
  readonly kind: 'manual';
  readonly commandId: string;
  readonly payloadDigest: string;
  /** The person id that pressed Run once. A local development fixture identity in this build. */
  readonly requestedBy: string;
}

/**
 * A slot of an enabled schedule. The command id is derived from the
 * automation, the definition revision and the slot, so a duplicate dispatch
 * or a restart names the same occurrence and gets a receipt (A05).
 */
export interface ScheduleTrigger {
  readonly kind: 'schedule';
  readonly commandId: string;
  readonly payloadDigest: string;
  /** The slot's instant, UTC ISO: the slot's identity. */
  readonly slot: string;
  /** The intended local date and time, `YYYY-MM-DD HH:MM`, in `timezone`. */
  readonly local: string;
  readonly timezone: string;
  /** `gap`: that local time did not exist, so it ran when the clocks jumped. */
  readonly shifted: 'gap' | null;
  /** The definition revision whose schedule named this slot (A13, A35). */
  readonly definitionRevision: number;
  /** The owner or admin whose recorded enable this runs under. Never anyone else (A15). */
  readonly enabledBy: string;
  /** The computer the schedule is assigned to. */
  readonly hostId: string;
  /** Started more than two minutes after its time: a catch-up after the computer was off. */
  readonly late: boolean;
}

/** The stored envelope, one file per organization. Occurrences are never pruned (decision 10). */
export interface StoredOccurrences {
  readonly v: 1 | typeof OCCURRENCES_FILE_VERSION;
  readonly organizationId: string;
  readonly occurrences: readonly TriggerOccurrence[];
}

// --- Milestone B: the stored definition --------------------------------------

export const AUTOMATION_DEFINITION_VERSION = 1 as const;

/**
 * One revision of what an automation's schedule is. An edit makes a new
 * revision and never rewrites an old one, so an occurrence admitted under
 * revision 3 keeps saying so after revision 4 exists (A13, A35).
 */
export interface ScheduleRevision {
  readonly revision: number;
  readonly at: string;
  readonly by: string;
  readonly schedule: AutomationSchedule;
  /** Missed-run policy: the most recent missed slot may still run within this many minutes. 0: never. */
  readonly catchUpMinutes: number;
}

/**
 * The recorded authority an enable (or a resume) carries. A schedule runs only
 * under it, only on the computer it names, and only while the setup it was
 * given for is still the active one. Configuration never creates one (A01).
 */
export interface ScheduleGrant {
  readonly personId: string;
  readonly at: string;
  readonly configuration: { readonly revision: number; readonly digest: string };
  readonly hostId: string;
}

export type ScheduleControl =
  | { readonly state: 'off' }
  | {
      readonly state: 'enabled';
      /** Slots after this moment are this schedule's: the enable or resume time. Never a backlog before it. */
      readonly since: string;
      readonly grant: ScheduleGrant;
    }
  | {
      readonly state: 'paused';
      readonly since: string;
      readonly by: string;
      readonly reason: string;
      readonly grant: ScheduleGrant;
    };

export type ScheduleActKind = 'edited' | 'enabled' | 'paused' | 'resumed' | 'turned-off';

/** Every change to the definition, kept as evidence (decision 10). */
export interface ScheduleAct {
  readonly at: string;
  readonly by: string;
  readonly kind: ScheduleActKind;
  /** The schedule revision current after this act. */
  readonly revision: number;
  readonly reason?: string;
  /** A pause's receipt: the scheduled occurrence already started before it, which it does not stop. */
  readonly inFlight?: string | null;
}

/** One deduplicated thing a person should know about (A31). In-app only: nothing is pushed. */
export interface AutomationAttention {
  readonly id: string;
  readonly kind: 'missed' | 'skipped' | 'blocked' | 'failed';
  /** The underlying issue. Open items with the same code absorb new occurrences instead of repeating. */
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly occurrenceIds: readonly string[];
  readonly openedAt: string;
  readonly lastSeenAt: string;
  readonly resolved: {
    readonly at: string;
    readonly how: 'seen' | 'recovered' | 'addressed';
    readonly by: string;
  } | null;
}

export interface AutomationDefinition {
  readonly v: typeof AUTOMATION_DEFINITION_VERSION;
  /** `brief:<organizationId>`. */
  readonly id: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly kind: 'weekly-brief';
  /** Bumped by every change; a change sent against an older one is a 409 (A24). */
  readonly generation: number;
  /** Oldest first. Never pruned. */
  readonly revisions: readonly ScheduleRevision[];
  readonly control: ScheduleControl;
  readonly acts: readonly ScheduleAct[];
  readonly attention: readonly AutomationAttention[];
}

export interface StoredDefinitions {
  readonly v: typeof AUTOMATION_DEFINITION_VERSION;
  readonly organizationId: string;
  readonly definitions: readonly AutomationDefinition[];
}

/** The last heartbeat this computer's scheduler wrote. It is what "last known" means (A03). */
export interface HostRecord {
  readonly v: 1;
  readonly hostId: string;
  readonly name: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * Why a scheduled slot did not start, in words a person reads once. Each is
 * the reason a recorded occurrence carries; none is a new run state.
 */
export const SCHEDULE_OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  missed_host_off: 'Missed — computer was off',
  project_busy: 'Skipped — previous run still active',
  schedule_paused: 'Skipped — paused',
  schedule_authority_lost: 'Blocked — the person who turned it on lost access',
  schedule_owner_not_signed_in: 'Blocked — someone else is signed in on this computer',
  configuration_changed: 'Blocked — the setup changed',
  assigned_to_another_computer: 'Blocked — assigned to another computer',
  schedule_budget_unbounded: 'Blocked — no hard spending bound',
});

/** Codes that stop every slot until an owner or admin acts. */
export const SCHEDULE_BLOCKING_CODES: readonly string[] = [
  'schedule_authority_lost',
  'schedule_owner_not_signed_in',
  'configuration_changed',
  'assigned_to_another_computer',
  'schedule_budget_unbounded',
];

/** The outcome text of a scheduled occurrence that did not start, or null. */
export function scheduleOutcome(occurrence: Pick<TriggerOccurrence, 'trigger' | 'admission'>): string | null {
  if (occurrence.trigger.kind !== 'schedule' || occurrence.admission.state !== 'refused') return null;
  return SCHEDULE_OUTCOME[occurrence.admission.code] ?? 'Did not start';
}

// --- the facts a label is computed from ---------------------------------------

/** Why an automation cannot run yet, in the server's own refusal codes. */
export type SetupIncompleteCode =
  | 'no_active_configuration'
  | 'brief_not_ready'
  | 'brief_no_destination'
  | 'no_output_project'
  | 'output_project_missing'
  | 'output_project_ownership_unresolved';

export type SetupFacts =
  | { readonly state: 'ready' }
  | { readonly state: 'incomplete'; readonly code: SetupIncompleteCode; readonly message: string };

/** What the run records say, read at the moment the view was built. */
export interface RunFacts {
  readonly state: HarnessRunState;
  /** A step is waiting for an exact approval. */
  readonly waitingApproval: boolean;
  /** A step's outcome is unknown and needs reconciliation. */
  readonly uncertain: boolean;
  /** The run stopped before writing because selected sources were missing (D3). */
  readonly waitingForData: boolean;
  /** Selected files that could not be read, as the read step recorded them. */
  readonly missing: readonly string[];
  /** The draft the run saved, when it saved one. */
  readonly written: { readonly entryId: string; readonly path: string } | null;
  /** The saved draft's review state, from the project's Change record. */
  readonly change: 'waiting' | 'kept' | 'undone' | null;
}

export interface OccurrenceFacts {
  readonly admission: TriggerOccurrence['admission']['state'];
  readonly refusalCode: string | null;
  /** Null when the run record could not be found or read. */
  readonly run: RunFacts | null;
}

/** What the definition and this computer say about the schedule (Milestone B). */
export interface ScheduleFacts {
  readonly state: 'off' | 'enabled' | 'paused';
  /** Whether this computer's scheduler has checked recently. Never a live claim about another device. */
  readonly host: 'available' | 'unknown';
  /** The schedule is assigned to this computer. */
  readonly here: boolean;
  /** The newest scheduled slot was blocked, and why. */
  readonly blocked: { readonly code: string; readonly reason: string } | null;
}

export interface AutomationFacts {
  readonly trigger: AutomationTriggerKind;
  readonly setup: SetupFacts;
  /**
   * The newest occurrence that is not a scheduled slot that never started, or
   * null when nothing has run. Missed and skipped slots are read from `schedule`.
   */
  readonly latest: OccurrenceFacts | null;
  /** Absent reads as no schedule: Milestone A's facts. */
  readonly schedule?: ScheduleFacts;
}

// --- labels ---------------------------------------------------------------------

export type AutomationLabel =
  | 'manual'
  | 'running'
  | 'needs-approval'
  | 'waiting-for-data'
  | 'setup-incomplete'
  | 'needs-investigation'
  | 'scheduled'
  | 'paused'
  | 'waiting-for-computer';

export const AUTOMATION_LABEL_TEXT: Readonly<Record<AutomationLabel, string>> = Object.freeze({
  manual: 'Manual — not scheduled',
  running: 'Running',
  'needs-approval': 'Needs approval',
  'waiting-for-data': 'Waiting for data',
  'setup-incomplete': 'Setup incomplete',
  'needs-investigation': 'Needs investigation',
  scheduled: 'Scheduled',
  paused: 'Paused',
  'waiting-for-computer': 'Waiting for computer',
});

export interface AutomationStatus {
  readonly label: AutomationLabel;
  readonly text: string;
  /** One plain sentence: why this label, from the facts behind it. */
  readonly reason: string;
}

/** Attention first: the order rows are listed in (specification section 4.1). */
const ATTENTION: Readonly<Record<AutomationLabel, number>> = Object.freeze({
  'needs-approval': 0,
  'needs-investigation': 1,
  'waiting-for-data': 2,
  'setup-incomplete': 3,
  'waiting-for-computer': 4,
  running: 5,
  paused: 6,
  scheduled: 7,
  manual: 8,
});

export const attentionRank = (label: AutomationLabel) => ATTENTION[label];

const status = (label: AutomationLabel, reason: string): AutomationStatus => ({
  label,
  text: AUTOMATION_LABEL_TEXT[label],
  reason,
});

const listFiles = (paths: readonly string[]) =>
  paths.length === 0
    ? 'A file it reads'
    : paths.length === 1
      ? paths[0]!
      : `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`;

/**
 * The one label a set of facts reads as. Pure and total: no clock, no I/O,
 * and no fact is inferred from another — "Running" is never guessed from
 * elapsed time, and a missing source never reads as a clean result.
 */
export function automationLabel(facts: AutomationFacts): AutomationStatus {
  const latest = facts.latest;
  const run = latest?.run ?? null;
  if (latest?.admission === 'admitting')
    // Admission writes this and settles it in one locked step, and startup
    // recovery settles any left behind. Seen from outside, it was interrupted.
    return status('needs-investigation', 'The last press was interrupted before its run started.');
  if (latest?.admission === 'refused' && latest.refusalCode === 'interrupted_before_start')
    return status(
      'needs-investigation',
      'The last press was interrupted before its run started. Nothing was written. Press Run once again.',
    );
  if (latest?.admission === 'admitted' && run === null)
    return status('needs-investigation', 'The last run’s record could not be read.');
  if (run) {
    if (run.state === 'queued' || run.state === 'running')
      return status('running', 'Preparing the draft now.');
    if (run.state === 'waiting')
      return run.waitingApproval
        ? status('needs-approval', 'A step is waiting for your exact OK.')
        : status('needs-investigation', 'The last run is waiting on something outside Diomedes.');
    if (run.state === 'reconcile_required' || run.uncertain)
      return status(
        'needs-investigation',
        'The last run may have done something it could not confirm. Check it before running again.',
      );
    if (run.state === 'failed' && !run.waitingForData)
      return status('needs-investigation', 'The last run stopped because something went wrong.');
  }
  const schedule = facts.schedule;
  if (schedule && schedule.state !== 'off' && schedule.blocked)
    return status('needs-investigation', schedule.blocked.reason);
  if (facts.setup.state === 'incomplete') return status('setup-incomplete', facts.setup.message);
  if (run?.state === 'failed' && run.waitingForData)
    return status(
      'waiting-for-data',
      `${listFiles(run.missing)} could not be read, so nothing was written.`,
    );
  if (schedule?.state === 'paused')
    return status('paused', 'Nothing starts on its own until an owner or admin resumes it.');
  if (schedule?.state === 'enabled' && !schedule.here)
    return status('waiting-for-computer', 'Its schedule is assigned to another computer, so nothing starts here.');
  if (schedule?.state === 'enabled' && schedule.host === 'unknown')
    return status(
      'waiting-for-computer',
      'This computer has not checked its schedule recently, so it cannot say it will start on time.',
    );
  if (schedule?.state === 'enabled')
    return status('scheduled', 'Starts on its own at its scheduled time while this computer is on.');
  return status('manual', 'Runs only when someone presses Run once.');
}

// --- the last result, kept apart from the label ---------------------------------

/** "Sent" is not here: nothing in Milestone A sends anything. */
export type AutomationResult = 'draft-saved' | 'kept' | 'undone' | 'not-written';

export const AUTOMATION_RESULT_TEXT: Readonly<Record<AutomationResult, string>> = Object.freeze({
  'draft-saved': 'Draft saved for review',
  kept: 'Kept',
  undone: 'Undone',
  'not-written': 'Not written',
});

/**
 * What one occurrence left behind, or null while its run is still going. A
 * saved draft is only ever "saved for review" until a person keeps it.
 */
export function occurrenceResult(facts: OccurrenceFacts): AutomationResult | null {
  if (facts.admission === 'refused') return 'not-written';
  if (facts.admission === 'admitting') return null;
  const run = facts.run;
  if (!run) return null;
  if (run.written) return run.change === 'kept' ? 'kept' : run.change === 'undone' ? 'undone' : 'draft-saved';
  if (run.state === 'queued' || run.state === 'running' || run.state === 'waiting') return null;
  // A run that may have acted without confirming it did is not "not written":
  // nobody knows, and the label says to check.
  if (run.state === 'reconcile_required' || run.uncertain) return null;
  return 'not-written';
}

// --- the views the Console reads -----------------------------------------------

export interface OccurrenceView {
  readonly occurrence: TriggerOccurrence;
  /** The run as RunService reports it now; null for a refusal or an unreadable record. */
  readonly run: {
    readonly id: string;
    readonly state: HarnessRunState;
    readonly sentence: string;
    readonly taskId: string | null;
    readonly sessionId: string | null;
    /** Whether the Task is still in the project, so a link is never offered to nothing. */
    readonly taskExists: boolean;
    readonly stages: readonly { readonly name: string; readonly done: boolean; readonly detail: string }[];
    readonly sources: readonly { readonly path: string; readonly sha: string }[];
    readonly missing: readonly string[];
    readonly written: { readonly entryId: string; readonly path: string } | null;
    readonly change: 'waiting' | 'kept' | 'undone' | null;
    readonly failure: string | null;
    readonly updatedAt: string;
  } | null;
  readonly result: AutomationResult | null;
  readonly resultText: string | null;
  /** Refused occurrences say what to do next. */
  readonly next: string | null;
  /** A scheduled slot that did not start, in words: "Missed — computer was off". */
  readonly note: string | null;
  /** The slot in the schedule's own local time, for a scheduled occurrence. */
  readonly slotText: string | null;
}

/** An attention item as the Console shows it, with where it points. */
export interface AttentionView {
  readonly id: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly organizationId: string;
  readonly kind: AutomationAttention['kind'];
  readonly title: string;
  readonly detail: string;
  readonly count: number;
  readonly openedAt: string;
  readonly lastSeenAt: string;
}

/** The schedule as the Console shows it. Nothing here is a live claim about another device. */
export interface ScheduleView {
  readonly state: ScheduleControl['state'];
  /** "Every Monday at 8:00 a.m. America/New_York", or null with no schedule saved. */
  readonly text: string | null;
  readonly current: ScheduleRevision | null;
  readonly generation: number;
  /** The next slots, computed at `observedAt`. Shown for an enabled schedule, and as a preview otherwise. */
  readonly next: readonly { readonly at: string; readonly text: string }[];
  readonly catchUpText: string;
  readonly since: string | null;
  readonly by: string | null;
  readonly pauseReason: string | null;
  readonly host: {
    readonly name: string;
    /** The last heartbeat this computer's scheduler wrote. */
    readonly lastSeenAt: string | null;
    readonly state: 'available' | 'unknown';
    /** The schedule is assigned to this computer, or nothing is assigned yet. */
    readonly here: boolean;
  };
  /** Whether this person may edit, turn on, pause, resume or turn off the schedule. */
  readonly mayControl: boolean;
  /** Why the schedule could not be turned on now, or null. */
  readonly enableBlocked: string | null;
  /** The recorded setup answer, kept inactive until someone turns a schedule on (A01). */
  readonly recorded: string | null;
  /** Newest first. */
  readonly acts: readonly ScheduleAct[];
}

export interface AutomationView {
  readonly id: string;
  readonly kind: 'weekly-brief';
  readonly name: string;
  /** One plain sentence: what it does, and that it sends nothing. */
  readonly purpose: string;
  readonly trigger: { readonly kind: AutomationTriggerKind; readonly text: string };
  /** A recorded schedule answer, shown as the inactive thing it is (A01). */
  readonly scheduleRecorded: string | null;
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly owner: {
    readonly personId: string;
    readonly you: boolean;
    readonly identitySource: 'development-fixture' | 'hosted';
  };
  readonly configuration: {
    readonly revision: number;
    readonly digest: string;
    readonly activatedAt: string | null;
  } | null;
  readonly reads: { readonly label: string; readonly paths: readonly string[] };
  readonly writes: { readonly path: string; readonly projectName: string | null } | null;
  readonly reviewedBy: 'person' | 'person-after-reviewer' | null;
  /** What it never does, said once. */
  readonly doesNot: string;
  /** What remains a person's job. */
  readonly manual: readonly string[];
  readonly status: AutomationStatus;
  readonly lastResult: {
    readonly result: AutomationResult;
    readonly text: string;
    readonly at: string;
  } | null;
  /** The newest run's source read, when there is one. */
  readonly freshness: {
    readonly at: string;
    readonly sources: readonly { readonly path: string; readonly sha: string }[];
    readonly missing: readonly string[];
  } | null;
  readonly run: { readonly allowed: boolean; readonly reason: string | null };
  /** Usefulness is not measured in Milestone A (A34). */
  readonly usefulness: 'not-measured';
  readonly occurrences: number;
  /** The newest occurrence, so the list can link to its run without a second read. */
  readonly latest: OccurrenceView | null;
  /** Milestone B: the stored schedule and this computer. */
  readonly schedule: ScheduleView;
  /** Open attention items, one per underlying issue (A31). */
  readonly attention: readonly AttentionView[];
}

export interface AutomationSummary {
  readonly configured: number;
  /** Enabled schedules on an available computer: the only count that means "starts on its own". */
  readonly scheduled: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly notReady: number;
}

/** Each count's definition, shown beside it. */
export const AUTOMATION_SUMMARY_CAPTIONS: Readonly<Record<keyof AutomationSummary, string>> =
  Object.freeze({
    configured: 'Set up and able to run, on a schedule or when someone presses Run once.',
    scheduled: 'Starts on its own at its scheduled time on this computer.',
    running: 'Working now.',
    needsAttention: 'Waiting for data, an approval, or a check, or a run was missed or blocked.',
    notReady: 'Setup is not finished, so it cannot run.',
  });

/**
 * The counts over the automations this person may see. A manual job counts as
 * configured, never as scheduled: only an enabled schedule on an available
 * computer counts as starting on its own, and a recorded or paused schedule
 * never does (A01).
 */
export function automationSummary(
  statuses: readonly (Pick<AutomationStatus, 'label'> & {
    readonly scheduled?: boolean;
    /** Open attention items, which need a person even while the label is calm. */
    readonly attention?: number;
  })[],
): AutomationSummary {
  let configured = 0;
  let scheduled = 0;
  let running = 0;
  let needsAttention = 0;
  let notReady = 0;
  for (const { label, scheduled: starts, attention } of statuses) {
    if (label === 'setup-incomplete') notReady += 1;
    else configured += 1;
    if (starts) scheduled += 1;
    if (label === 'running') running += 1;
    if (
      label === 'needs-approval' ||
      label === 'waiting-for-data' ||
      label === 'needs-investigation' ||
      (attention ?? 0) > 0
    )
      needsAttention += 1;
  }
  return { configured, scheduled, running, needsAttention, notReady };
}

/** Attention first, then name, so a live update never reorders rows for any other reason. */
export function byAttention<T extends { status: Pick<AutomationStatus, 'label'>; name: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      attentionRank(a.status.label) - attentionRank(b.status.label) || a.name.localeCompare(b.name),
  );
}

export interface AutomationList {
  readonly v: typeof AUTOMATIONS_CONTRACT_VERSION;
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly identitySource: 'development-fixture' | 'hosted';
  };
  readonly observedAt: string;
  readonly summary: AutomationSummary;
  readonly automations: readonly AutomationView[];
}

export interface AutomationDetail {
  readonly v: typeof AUTOMATIONS_CONTRACT_VERSION;
  readonly observedAt: string;
  readonly automation: AutomationView;
  /** Newest first. */
  readonly occurrences: readonly OccurrenceView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface RunOnceResult {
  readonly occurrence: TriggerOccurrence;
  /** True when this command id had already been admitted: nothing new was started. */
  readonly duplicate: boolean;
  readonly automation: AutomationView;
}

/** What a schedule change answers with. */
export interface ScheduleChangeResult {
  readonly automation: AutomationView;
  readonly act: ScheduleAct;
  /** A pause's receipt: the scheduled run already started, which the pause does not stop. */
  readonly inFlight: OccurrenceView | null;
}
