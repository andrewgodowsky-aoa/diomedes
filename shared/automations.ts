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

export const AUTOMATIONS_CONTRACT_VERSION = 1 as const;

/** The one trigger Milestone A has. A schedule is Milestone B's to add. */
export type AutomationTriggerKind = 'manual';

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
  readonly trigger: {
    readonly kind: AutomationTriggerKind;
    readonly commandId: string;
    readonly payloadDigest: string;
    /** The person id that pressed Run once. A local development fixture identity in this build. */
    readonly requestedBy: string;
  };
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

/** The stored envelope, one file per organization. Occurrences are never pruned (decision 10). */
export interface StoredOccurrences {
  readonly v: typeof AUTOMATIONS_CONTRACT_VERSION;
  readonly organizationId: string;
  readonly occurrences: readonly TriggerOccurrence[];
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

export interface AutomationFacts {
  readonly trigger: AutomationTriggerKind;
  readonly setup: SetupFacts;
  /** The newest occurrence, or null when Run once has never been pressed. */
  readonly latest: OccurrenceFacts | null;
}

// --- labels ---------------------------------------------------------------------

export type AutomationLabel =
  | 'manual'
  | 'running'
  | 'needs-approval'
  | 'waiting-for-data'
  | 'setup-incomplete'
  | 'needs-investigation';

export const AUTOMATION_LABEL_TEXT: Readonly<Record<AutomationLabel, string>> = Object.freeze({
  manual: 'Manual — not scheduled',
  running: 'Running',
  'needs-approval': 'Needs approval',
  'waiting-for-data': 'Waiting for data',
  'setup-incomplete': 'Setup incomplete',
  'needs-investigation': 'Needs investigation',
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
  running: 4,
  manual: 5,
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
  if (facts.setup.state === 'incomplete') return status('setup-incomplete', facts.setup.message);
  if (run?.state === 'failed' && run.waitingForData)
    return status(
      'waiting-for-data',
      `${listFiles(run.missing)} could not be read, so nothing was written.`,
    );
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
}

export interface AutomationSummary {
  readonly configured: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly notReady: number;
}

/** Each count's definition, shown beside it. */
export const AUTOMATION_SUMMARY_CAPTIONS: Readonly<Record<keyof AutomationSummary, string>> =
  Object.freeze({
    configured: 'Set up and able to run when someone presses Run once.',
    running: 'Working now.',
    needsAttention: 'Waiting for data, an approval, or a check.',
    notReady: 'Setup is not finished, so it cannot run.',
  });

/**
 * The counts over the automations this person may see. A manual job counts as
 * configured, never as active: there is no "active" count until something runs
 * on its own.
 */
export function automationSummary(
  statuses: readonly Pick<AutomationStatus, 'label'>[],
): AutomationSummary {
  let configured = 0;
  let running = 0;
  let needsAttention = 0;
  let notReady = 0;
  for (const { label } of statuses) {
    if (label === 'setup-incomplete') notReady += 1;
    else configured += 1;
    if (label === 'running') running += 1;
    if (label === 'needs-approval' || label === 'waiting-for-data' || label === 'needs-investigation')
      needsAttention += 1;
  }
  return { configured, running, needsAttention, notReady };
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
