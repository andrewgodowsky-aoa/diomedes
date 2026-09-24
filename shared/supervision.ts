/**
 * H15 — drift detection, bounded correction and escalation.
 *
 * Diomedes watches a run for drift by reading the run's durable records — the
 * writes History recorded, the Needs it proposed, the harness steps it took,
 * the H18 context account, the H17 verification evidence and the H08 control
 * receipts — never a transcript and never a model's account of itself. Each
 * detector is a pure function over a route-agnostic view of those records
 * (`DriftInput`), so a Work run, a harness run and the native plan/act/observe
 * loop are all read the same way.
 *
 * A finding is answered on a declared ladder: **note** it, **ask the run to
 * correct** (a message through H08's Steer, or its Queue where the route cannot
 * steer, labelled as Diomedes supervision), then **pause the run and ask the
 * person** through an ordinary Need. Corrections are bounded per detector per
 * run. An escalation is never answered by anyone but a person, is raised once
 * per underlying issue, and grants nothing: continuing goes through H08's
 * Resume, which re-checks what the run would continue with (decision 7).
 *
 * Every supervision action is a Diomedes *application* action — deterministic
 * code comparing records, no model — and is attributed that way (decision 8).
 */

/** The five detectors. Stable codes; tests, records and the Console cite them. */
export const DRIFT_CODES = [
  'scope-drift',
  'no-progress',
  'budget-burn',
  'instruction-drift',
  'verification-regression',
] as const;
export type DriftCode = (typeof DRIFT_CODES)[number];

export const DRIFT_LABELS: Readonly<Record<DriftCode, string>> = Object.freeze({
  'scope-drift': 'Scope drift',
  'no-progress': 'No progress',
  'budget-burn': 'Budget burn',
  'instruction-drift': 'Instruction drift',
  'verification-regression': 'Verification regression',
});

/** `info` is noted, `warning` asks the run to correct, `critical` pauses and asks you. */
export type DriftSeverity = 'info' | 'warning' | 'critical';

/** One fact a finding rests on, pointing at the durable record that holds it. */
export interface DriftEvidence {
  /** What kind of record: a History entry, a Need, a harness step, a budget line, a rule, a verification. */
  readonly kind:
    | 'write'
    | 'proposal'
    | 'read'
    | 'destination'
    | 'tool-call'
    | 'budget'
    | 'rule'
    | 'verification';
  /** The record's own id (History entry, Need, step, rule, verification entry). */
  readonly ref: string;
  /** One plain sentence. Names paths and counts; never file content. */
  readonly detail: string;
  readonly path?: string;
  readonly at?: string;
}

export interface DriftFinding {
  readonly code: DriftCode;
  /**
   * The underlying issue, stable while it is the same issue: the folder a run
   * wandered into, the repeated call, the budget dimension, the rule, the
   * verified run. Escalations are deduplicated on it.
   */
  readonly issueKey: string;
  readonly severity: DriftSeverity;
  /** One sentence, completing "Diomedes paused this run: it …" when escalated. */
  readonly summary: string;
  /** What the correction asks the run to do. */
  readonly ask: string;
  readonly evidence: readonly DriftEvidence[];
  /** Digest over the evidence refs: unchanged evidence is never acted on twice. */
  readonly evidenceDigest: string;
}

// --- the route-agnostic input -------------------------------------------------

/** A file or destination the run touched, read or wrote, proposed or recorded. */
export interface DriftTouch {
  readonly ref: string;
  readonly at: string;
  readonly kind: 'file' | 'destination';
  /** Project-relative with forward slashes for a file; a label for a destination. */
  readonly target: string;
  readonly access: 'read' | 'write';
  /** A proposal waits for a person; a recorded touch already happened. */
  readonly status: 'proposed' | 'recorded';
  /** True when a person (or a scope they granted) approved exactly this touch. */
  readonly approved: boolean;
}

/** One tool call and what it observed, by digest. */
export interface DriftAction {
  readonly ref: string;
  readonly at: string;
  readonly tool: string;
  readonly inputDigest: string;
  /** Null when the call has no recorded output yet. */
  readonly outputDigest: string | null;
}

export type BudgetDimension =
  | 'model-calls'
  | 'tool-calls'
  | 'units'
  | 'turns'
  | 'context-tokens'
  | 'wall-ms'
  | 'spend-micro-usd';

export interface DriftBudgetLine {
  readonly dimension: BudgetDimension;
  readonly used: number;
  readonly limit: number;
  /** Where the limit came from, for the evidence sentence. */
  readonly source: string;
}

/** A machine-checkable line from a delivered instruction file. */
export interface DriftRule {
  readonly id: string;
  /** The instruction file and the sha of the bytes the run was given. */
  readonly file: { readonly path: string; readonly sha: string };
  /** The folder the file governs ('' is the project root). */
  readonly scope: string;
  /** A project-relative path or folder (ending in '/') no write may land in. */
  readonly forbids: string;
  readonly line: number;
  readonly text: string;
}

export interface DriftVerificationInput {
  readonly history: readonly import('./types.js').HistoryEntry[];
  readonly sessions: readonly Pick<import('./types.js').Session, 'id' | 'state' | 'taskId'>[];
  readonly tasks: readonly Pick<import('./types.js').Task, 'id' | 'acceptance'>[];
}

export interface DriftInput {
  readonly run: {
    readonly id: string;
    readonly taskId: string | null;
    readonly live: boolean;
    readonly startedAt: string;
  };
  /**
   * What the run was scoped to. `declared` and `selected` are sources (files);
   * their folders are the run's scope. `admitted` are files a person approved
   * or a grant covers, and folders (ending in '/') a grant admits.
   */
  readonly scope: {
    readonly declared: readonly string[];
    readonly selected: readonly string[];
    readonly admitted: readonly string[];
    /** Destination labels the run may reach. Absent means destinations are not judged. */
    readonly destinations?: readonly string[];
  };
  readonly touches: readonly DriftTouch[];
  /** Oldest first. */
  readonly actions: readonly DriftAction[];
  readonly budget: readonly DriftBudgetLine[];
  /** Plan progress when the run declares one; null when it has no declared plan. */
  readonly plan: { readonly done: number; readonly total: number } | null;
  readonly rules: readonly DriftRule[];
  readonly verification: DriftVerificationInput | null;
}

// --- thresholds -----------------------------------------------------------------

/** Proposed defaults (docs/implementation/2026-09-24-h15-drift.md). */
export const DRIFT_THRESHOLDS = Object.freeze({
  /** Identical tool calls (same tool, same input) in a row. */
  loop: Object.freeze({ info: 3, warning: 4, critical: 6 }),
  /** Identical observations (same tool, same output) in a row, whatever the input. */
  observation: Object.freeze({ info: 4, warning: 5, critical: 8 }),
  /** Share of a budget used while the run is still going. */
  budgetUsedInfo: 0.8,
  /** Pacing: projected use at plan completion over the limit, once this much of the plan is done. */
  paceMinDone: 1,
});
export type DriftThresholds = typeof DRIFT_THRESHOLDS;

// --- the ladder ---------------------------------------------------------------

export type SupervisionRung = 'note' | 'correct' | 'escalate';

export interface DriftLadder {
  /** The rung a finding of each severity starts on. */
  readonly entry: Readonly<Record<DriftSeverity, SupervisionRung>>;
  /** Corrections per detector per run before the next step is to ask you. */
  readonly maxCorrections: number;
}

// --- records ------------------------------------------------------------------

/**
 * Who took a supervision action. Diomedes supervision is deterministic code
 * reading records: an application action, never a model's reasoning. An
 * answer to an escalation is the person's.
 */
export type SupervisionActor =
  | { readonly kind: 'diomedes'; readonly role: 'supervision'; readonly mode: 'application' }
  | { readonly kind: 'you'; readonly via: 'local-client' };

export const SUPERVISION_ACTOR: SupervisionActor = Object.freeze({
  kind: 'diomedes',
  role: 'supervision',
  mode: 'application',
});

export type EscalationAnswer = 'continue' | 'redirect' | 'stop';

/**
 * One supervision action, appended and never rewritten (decision 10).
 * `note`, `correct` and `escalate` are Diomedes'; `answer` is the person's.
 */
export interface SupervisionRecord {
  readonly protocolVersion: 1;
  readonly id: string;
  readonly action: SupervisionRung | 'answer';
  readonly sessionId: string;
  readonly taskId: string;
  readonly code: DriftCode;
  readonly issueKey: string;
  readonly severity: DriftSeverity;
  readonly summary: string;
  readonly evidence: readonly DriftEvidence[];
  readonly evidenceDigest: string;
  readonly at: string;
  readonly actor: SupervisionActor;
  /** Why this rung: the ladder's own words. */
  readonly reason: string;
  /** Correct: which correction this is for this detector on this run, and the bound. */
  readonly attempt?: { readonly n: number; readonly of: number };
  /** Correct and escalate: the H08 control that carried it, and what the route did. */
  readonly control?: {
    readonly commandId: string;
    readonly control: 'steer' | 'queue' | 'stop' | 'resume';
    readonly outcome: 'applied' | 'queued' | 'refused' | 'uncertain';
    readonly detail: string;
  };
  /** Correct: the message sent, exactly. */
  readonly message?: string;
  /** Escalate and answer: the Need a person answers. */
  readonly needId?: string;
  /** Answer: what the person chose, and for redirect, what they said. */
  readonly answer?: EscalationAnswer;
  readonly text?: string;
  /** Note: why nothing further was done (run ended, acknowledged, bound reached). */
  readonly settled?: string;
}

/** The link from a Need to the escalation it asks about. */
export interface SupervisionNeedRef {
  readonly protocolVersion: 1;
  readonly recordId: string;
  readonly code: DriftCode;
  readonly issueKey: string;
  /** Always the three; `continue` may be refused by the route or by revalidation, and says why. */
  readonly choices: readonly EscalationAnswer[];
  readonly answer?: EscalationAnswer;
}

/** The prefix every correction message carries, so the run and the person see who sent it. */
export const SUPERVISION_MESSAGE_PREFIX = '[Diomedes supervision]';

export const RUNG_LABELS: Readonly<Record<SupervisionRecord['action'], string>> = Object.freeze({
  note: 'Noted',
  correct: 'Asked the run to correct',
  escalate: 'Paused and asked you',
  answer: 'You answered',
});

export const ANSWER_LABELS: Readonly<Record<EscalationAnswer, string>> = Object.freeze({
  continue: 'Continue',
  redirect: 'Redirect',
  stop: 'Stop',
});

/** Never evicted: a project at the limit records nothing new rather than forgetting. */
export const MAX_SUPERVISION_RECORDS = 4096;

/** Records for one run, oldest first. */
export function supervisionFor(
  records: readonly SupervisionRecord[] | undefined,
  sessionId: string,
): SupervisionRecord[] {
  return (records ?? []).filter((record) => record.sessionId === sessionId);
}
