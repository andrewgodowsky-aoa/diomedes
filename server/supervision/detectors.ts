/**
 * The five H15 drift detectors. Each is a pure function of a `DriftInput` — a
 * route-agnostic view of a run's durable records (`records.ts` builds it for a
 * Work run; the native plan/act/observe loop can build it for its own) — and
 * returns findings with a stable code, the evidence each rests on and a
 * severity. Nothing here reads a transcript, a file body or a model's account
 * of itself, and nothing here acts: `ladder.ts` decides what to do and
 * `service.ts` does it.
 */
import { createHash } from 'node:crypto';
import {
  DRIFT_THRESHOLDS,
  type DriftAction,
  type DriftEvidence,
  type DriftFinding,
  type DriftInput,
  type DriftRule,
  type DriftSeverity,
  type DriftThresholds,
  type DriftTouch,
} from '../../shared/supervision.js';
import { verificationOf } from '../../shared/verification.js';

const RANK: Record<DriftSeverity, number> = { info: 0, warning: 1, critical: 2 };
const worst = (a: DriftSeverity, b: DriftSeverity) => (RANK[a] >= RANK[b] ? a : b);

/** Evidence identity: the refs and what each says, in a fixed order. */
export function evidenceDigest(evidence: readonly DriftEvidence[]): string {
  return createHash('sha256')
    .update(JSON.stringify(evidence.map((item) => [item.kind, item.ref, item.detail]).sort()))
    .digest('hex');
}

function finding(input: Omit<DriftFinding, 'evidenceDigest'>): DriftFinding {
  return { ...input, evidenceDigest: evidenceDigest(input.evidence) };
}

const sha12 = (value: string | null) => (value ? value.slice(0, 12) : 'nothing');

// --- paths --------------------------------------------------------------------

/** A project-relative name: forward slashes, no drive, no leading slash, no `..` segment. */
export function insideProject(name: string): boolean {
  if (!name || name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((part) => part === '..');
}

const clean = (name: string) => name.replace(/^\.\/+/, '').replace(/\/+$/, '');

/** The folder a file sits in; '' is the project root. */
export function folderOf(name: string): string {
  const parts = clean(name).split('/');
  return parts.slice(0, -1).join('/');
}

/** True when `name` is `folder` itself or inside it, by whole segments. '' holds everything. */
export function within(name: string, folder: string): boolean {
  const root = clean(folder);
  const target = clean(name);
  return root === '' || target === root || target.startsWith(`${root}/`);
}

const folderLabel = (folder: string) => (folder ? `${folder}/` : 'the project folder');

// --- (a) scope drift ------------------------------------------------------------

/**
 * A touch outside the run's scope. The scope is the folder of every declared
 * or selected source, plus what a person approved or a grant admits. With no
 * declared or selected source there is no scope to judge, and only a path
 * outside the project folder counts. A recorded write outside scope pauses the
 * run and asks; a read, or a proposal a person is already being asked about, is
 * noted.
 */
export function detectScopeDrift(input: DriftInput): DriftFinding[] {
  const sources = [...input.scope.declared, ...input.scope.selected].filter(insideProject);
  const roots = [...new Set(sources.map(folderOf))];
  const admitted = input.scope.admitted.filter(insideProject);
  const covered = (target: string) =>
    roots.some((root) => within(target, root)) ||
    admitted.some((item) =>
      item.endsWith('/') ? within(target, item) : clean(item) === clean(target),
    );
  const groups = new Map<
    string,
    {
      severity: DriftSeverity;
      touches: DriftTouch[];
      kind: 'outside-project' | 'folder' | 'destination';
    }
  >();
  const add = (
    key: string,
    kind: 'outside-project' | 'folder' | 'destination',
    severity: DriftSeverity,
    touch: DriftTouch,
  ) => {
    const group = groups.get(key) ?? { severity, touches: [], kind };
    group.severity = worst(group.severity, severity);
    group.touches.push(touch);
    groups.set(key, group);
  };
  for (const touch of input.touches) {
    const done = touch.status === 'recorded' && touch.access === 'write' && !touch.approved;
    if (touch.kind === 'destination') {
      const allowed = input.scope.destinations;
      if (!allowed || touch.approved || allowed.includes(touch.target)) continue;
      add(`scope:destination:${touch.target}`, 'destination', done ? 'critical' : 'info', touch);
      continue;
    }
    if (!insideProject(touch.target)) {
      if (!touch.approved) add('scope:outside-project', 'outside-project', 'critical', touch);
      continue;
    }
    if (!roots.length || touch.approved || covered(touch.target)) continue;
    add(`scope:${folderOf(touch.target) || '/'}`, 'folder', done ? 'critical' : 'info', touch);
  }
  const scopeLabel = roots.length === 1 ? folderLabel(roots[0]) : roots.map(folderLabel).join(', ');
  return [...groups].map(([issueKey, group]) => {
    const writes = group.touches.filter((touch) => touch.access === 'write');
    const recorded = writes.some((touch) => touch.status === 'recorded' && !touch.approved);
    const summary =
      group.kind === 'outside-project'
        ? 'it touched a path outside the project folder'
        : group.kind === 'destination'
          ? 'it reached a destination it was not admitted to'
          : recorded
            ? `it started writing outside the selected ${roots.length === 1 ? 'folder' : 'folders'}`
            : writes.length
              ? `it proposed writing outside the selected ${roots.length === 1 ? 'folder' : 'folders'}`
              : `it read files outside the selected ${roots.length === 1 ? 'folder' : 'folders'}`;
    const evidence = group.touches.map<DriftEvidence>((touch) => ({
      kind:
        touch.kind === 'destination'
          ? 'destination'
          : touch.status === 'proposed'
            ? 'proposal'
            : touch.access === 'write'
              ? 'write'
              : 'read',
      ref: touch.ref,
      path: touch.target,
      at: touch.at,
      detail:
        group.kind === 'destination'
          ? `${touch.access === 'write' ? 'Sent to' : 'Read from'} ${touch.target}, which is not an admitted destination.`
          : group.kind === 'outside-project'
            ? `${touch.status === 'proposed' ? 'Proposed' : touch.access === 'write' ? 'Wrote' : 'Read'} ${touch.target}, outside the project folder.`
            : `${touch.status === 'proposed' ? 'Proposed writing' : touch.access === 'write' ? 'Wrote' : 'Read'} ${touch.target}, outside ${scopeLabel}.`,
    }));
    return finding({
      code: 'scope-drift',
      issueKey,
      severity: group.severity,
      summary,
      ask:
        group.kind === 'folder'
          ? `Stay inside ${scopeLabel}, where this task's sources are. Do not read or write anywhere else unless the person asks.`
          : group.kind === 'destination'
            ? 'Use only the destinations this run was admitted to.'
            : 'Work only inside the project folder.',
      evidence,
    });
  });
}

// --- (b) no-progress loop -------------------------------------------------------

interface Streak {
  start: number;
  length: number;
}
function longest(
  actions: readonly DriftAction[],
  same: (a: DriftAction, b: DriftAction) => boolean,
) {
  const streaks: Streak[] = [];
  let start = 0;
  for (let index = 1; index <= actions.length; index++) {
    if (index < actions.length && same(actions[index - 1], actions[index])) continue;
    streaks.push({ start, length: index - start });
    start = index;
  }
  return streaks;
}

function severityFor(length: number, bands: { info: number; warning: number; critical: number }) {
  if (length >= bands.critical) return 'critical' as const;
  if (length >= bands.warning) return 'warning' as const;
  if (length >= bands.info) return 'info' as const;
  return null;
}

/**
 * The same tool called with the same input again and again, or the same
 * observation coming back again and again, in a row. A loop the run has already
 * left is only noted; one still going climbs.
 */
export function detectNoProgress(
  input: DriftInput,
  thresholds: DriftThresholds = DRIFT_THRESHOLDS,
): DriftFinding[] {
  const actions = input.actions;
  const findings: DriftFinding[] = [];
  const reported = new Set<number>();
  const judge = (streak: Streak, bands: { info: number; warning: number; critical: number }) => {
    let severity = severityFor(streak.length, bands);
    if (!severity) return null;
    const ongoing = streak.start + streak.length === actions.length;
    if (!ongoing) severity = 'info';
    return severity;
  };
  for (const streak of longest(
    actions,
    (a, b) => a.tool === b.tool && a.inputDigest === b.inputDigest,
  )) {
    const severity = judge(streak, thresholds.loop);
    if (!severity) continue;
    const run = actions.slice(streak.start, streak.start + streak.length);
    run.forEach((_, offset) => reported.add(streak.start + offset));
    findings.push(
      finding({
        code: 'no-progress',
        issueKey: `loop:call:${run[0].tool}:${run[0].inputDigest.slice(0, 12)}`,
        severity,
        summary: `it called ${run[0].tool} with the same input ${run.length} times in a row`,
        ask: `Stop repeating ${run[0].tool} with the same input. Say what is blocking progress, or try a different step.`,
        evidence: run.map((action, index) => ({
          kind: 'tool-call',
          ref: action.ref,
          at: action.at,
          detail: `Call ${index + 1} of ${run.length}: ${action.tool}, input ${action.inputDigest.slice(0, 12)}.`,
        })),
      }),
    );
  }
  for (const streak of longest(
    actions,
    (a, b) => a.tool === b.tool && a.outputDigest !== null && a.outputDigest === b.outputDigest,
  )) {
    const run = actions.slice(streak.start, streak.start + streak.length);
    // The same call repeated is reported above; this is different inputs, same answer.
    if (new Set(run.map((action) => action.inputDigest)).size < 2) continue;
    if (run.every((_, offset) => reported.has(streak.start + offset))) continue;
    const severity = judge(streak, thresholds.observation);
    if (!severity) continue;
    findings.push(
      finding({
        code: 'no-progress',
        issueKey: `loop:observation:${run[0].tool}:${run[0].outputDigest!.slice(0, 12)}`,
        severity,
        summary: `it got the same result from ${run[0].tool} ${run.length} times in a row`,
        ask: `${run[0].tool} keeps returning the same result. Change approach or say what is missing.`,
        evidence: run.map((action, index) => ({
          kind: 'tool-call',
          ref: action.ref,
          at: action.at,
          detail: `Call ${index + 1} of ${run.length}: ${action.tool} returned ${action.outputDigest!.slice(0, 12)}.`,
        })),
      }),
    );
  }
  return findings;
}

// --- (c) budget burn ------------------------------------------------------------

const DIMENSION_WORDS: Record<string, string> = {
  'model-calls': 'model calls',
  'tool-calls': 'tool calls',
  units: 'step units',
  turns: 'turns',
  'context-tokens': 'context tokens',
  'wall-ms': 'milliseconds',
  'spend-micro-usd': 'micro-dollars',
};

/**
 * A run pacing to exceed a budget before its plan completes. With a declared
 * plan the projection is linear: what each completed step cost, times the steps
 * the plan has. Without one, heavy use is only noted — the hard limit is
 * already enforced where the budget lives, and a guess is not a projection.
 */
export function detectBudgetBurn(
  input: DriftInput,
  thresholds: DriftThresholds = DRIFT_THRESHOLDS,
): DriftFinding[] {
  if (!input.run.live) return [];
  const plan = input.plan;
  if (plan && plan.total > 0 && plan.done >= plan.total) return [];
  const findings: DriftFinding[] = [];
  for (const line of input.budget) {
    if (!(line.limit > 0) || line.used < 0) continue;
    const words = DIMENSION_WORDS[line.dimension] ?? line.dimension;
    const share = line.used / line.limit;
    const projected =
      plan && plan.total > 0 && plan.done >= thresholds.paceMinDone
        ? Math.ceil((line.used / plan.done) * plan.total)
        : null;
    const overrun = projected !== null && projected > line.limit;
    let severity: DriftSeverity | null = null;
    if (overrun) severity = share >= 0.9 ? 'critical' : 'warning';
    else if (share >= thresholds.budgetUsedInfo) severity = 'info';
    if (!severity) continue;
    const evidence: DriftEvidence[] = [
      {
        kind: 'budget',
        ref: `budget:${line.dimension}:${line.used}`,
        detail: `Used ${line.used} of ${line.limit} ${words} (${Math.round(share * 100)}%), limit from ${line.source}.`,
      },
    ];
    if (projected !== null && plan)
      evidence.push({
        kind: 'budget',
        ref: `plan:${plan.done}/${plan.total}`,
        detail: `${plan.done} of ${plan.total} plan steps done; at this pace the plan needs about ${projected} ${words}.`,
      });
    findings.push(
      finding({
        code: 'budget-burn',
        issueKey: `budget:${line.dimension}`,
        severity,
        summary: overrun
          ? `it is on pace to use about ${projected} of its ${line.limit} ${words} before the plan completes`
          : `it has used ${line.used} of its ${line.limit} ${words}`,
        ask: overrun
          ? `You are on pace to run out of ${words} before the plan is done. Finish the remaining steps more economically, or stop and report what is left.`
          : `You have used most of the ${words} available. Prioritise what is left.`,
        evidence,
      }),
    );
  }
  return findings;
}

// --- (d) instruction drift ------------------------------------------------------

const DIRECTIVE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:do\s+not|don['’]t|never)\s+(?:edit|modify|change|write(?:\s+to)?|touch|delete|overwrite|commit\s+to)\b(.*)$/i;

const EXCEPTION = /\b(?:outside|except|other\s+than|apart\s+from|besides|unless|instead)\b/i;

/**
 * The machine-checkable lines of an instruction file: a sentence that begins
 * "Do not edit", "Never write to", "Don't modify" (and the like) and names one
 * or more paths in backticks. A path is read relative to the folder the file
 * governs; a trailing `/` names a folder. Everything else in the file is prose
 * for the model and is not judged here — a rule that has to be interpreted is
 * not a rule a detector can hold anyone to.
 */
export function machineRules(
  text: string,
  file: { path: string; sha: string },
  scope: string,
): DriftRule[] {
  const rules: DriftRule[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const match = DIRECTIVE.exec(raw);
    if (!match) return;
    // Only the prohibition's own clause; the next one may say where to work instead.
    const clause = match[1].split(/;|\s[—–]\s|\.(?=\s|$)/)[0];
    // "Outside `src/`" or "except `docs/`" permits what it names: that is prose, not a rule.
    if (EXCEPTION.test(clause)) return;
    for (const quoted of clause.matchAll(/`([^`]+)`/g)) {
      const named = quoted[1].trim().replace(/^\.\/+/, '');
      if (!named || !insideProject(named) || named.includes('*')) continue;
      const forbids = scope ? `${clean(scope)}/${named}` : named;
      rules.push({
        id: `${file.path}#L${index + 1}:${named}`,
        file,
        scope,
        forbids,
        line: index + 1,
        text: raw.trim().slice(0, 240),
      });
    }
  });
  return rules;
}

const forbidden = (target: string, rule: DriftRule) =>
  within(target, rule.scope) &&
  (rule.forbids.endsWith('/')
    ? within(target, rule.forbids)
    : clean(target) === clean(rule.forbids) || within(target, `${clean(rule.forbids)}/`));

/**
 * A write that contradicts a delivered instruction's machine-checkable rule. A
 * recorded write nobody approved pauses the run; a proposal, or a write a
 * person approved exactly, is noted — the person decided that one.
 */
export function detectInstructionDrift(input: DriftInput): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const rule of input.rules) {
    const hits = input.touches.filter(
      (touch) =>
        touch.kind === 'file' &&
        touch.access === 'write' &&
        insideProject(touch.target) &&
        forbidden(touch.target, rule),
    );
    if (!hits.length) continue;
    const recorded = hits.some((touch) => touch.status === 'recorded' && !touch.approved);
    findings.push(
      finding({
        code: 'instruction-drift',
        issueKey: `instruction:${rule.id}`,
        severity: recorded ? 'critical' : 'info',
        summary: recorded
          ? `it wrote to ${rule.forbids}, which ${rule.file.path} says not to change`
          : `it proposed changing ${rule.forbids}, which ${rule.file.path} says not to change`,
        ask: `${rule.file.path} line ${rule.line} says: “${rule.text}”. Leave ${rule.forbids} as it is.`,
        evidence: [
          {
            kind: 'rule',
            ref: rule.id,
            path: rule.file.path,
            detail: `${rule.file.path} (sha ${sha12(rule.file.sha)}) line ${rule.line}: ${rule.text}`,
          },
          ...hits.map<DriftEvidence>((touch) => ({
            kind: touch.status === 'proposed' ? 'proposal' : 'write',
            ref: touch.ref,
            path: touch.target,
            at: touch.at,
            detail: `${touch.status === 'proposed' ? 'Proposed writing' : 'Wrote'} ${touch.target}${touch.approved ? ', approved by you' : ''}.`,
          })),
        ],
      }),
    );
  }
  return findings;
}

// --- (e) verification regression --------------------------------------------------

/**
 * A result that was Verified before this run and is uncertain or failed now,
 * because of bytes this run wrote. The comparison is the H17 projection read
 * twice — once over History without this run's entries, once over all of it —
 * so an outside edit or another run is never blamed on this one.
 */
export function detectVerificationRegression(input: DriftInput): DriftFinding[] {
  const source = input.verification;
  if (!source) return [];
  const own = source.history.filter((entry) => entry.sessionId === input.run.id);
  const written = new Map<string, string>();
  for (const entry of own)
    for (const file of entry.files)
      if (file.recorded && file.before !== file.after) written.set(file.path, entry.id);
  if (!written.size) return [];
  const without = source.history.filter((entry) => entry.sessionId !== input.run.id);
  const verified = new Set(
    source.history.flatMap((entry) => (entry.verification ? [entry.verification.sessionId] : [])),
  );
  const findings: DriftFinding[] = [];
  for (const session of source.sessions) {
    if (session.id === input.run.id || !verified.has(session.id)) continue;
    const task = source.tasks.find((item) => item.id === session.taskId) ?? null;
    const before = verificationOf({ session, task, history: without });
    if (before.state !== 'verified') continue;
    const now = verificationOf({ session, task, history: source.history });
    if (now.state !== 'uncertain' && now.state !== 'failed') continue;
    const blamed = now.changed.filter((file) => written.has(file.path));
    if (!blamed.length) continue;
    findings.push(
      finding({
        code: 'verification-regression',
        issueKey: `verification:${session.id}`,
        severity: 'warning',
        summary: `it changed ${blamed.length === 1 ? blamed[0].path : `${blamed.length} files`} that an earlier run had Verified`,
        ask: `${blamed.map((file) => file.path).join(', ')} ${blamed.length === 1 ? 'was' : 'were'} Verified before this run changed ${blamed.length === 1 ? 'it' : 'them'}. Leave verified files as they were unless the task asks for the change.`,
        evidence: [
          {
            kind: 'verification',
            ref: before.entryId ?? session.id,
            detail: `Run ${session.id} was Verified; it now reads ${now.label}: ${now.sentence}`,
          },
          ...blamed.map<DriftEvidence>((file) => ({
            kind: 'write',
            ref: written.get(file.path)!,
            path: file.path,
            detail: `${file.path}: verified ${sha12(file.verified)}, now ${sha12(file.current)}.`,
          })),
        ],
      }),
    );
  }
  return findings;
}

/** Every detector, in a fixed order. */
export function detectDrift(
  input: DriftInput,
  thresholds: DriftThresholds = DRIFT_THRESHOLDS,
): DriftFinding[] {
  return [
    ...detectScopeDrift(input),
    ...detectNoProgress(input, thresholds),
    ...detectBudgetBurn(input, thresholds),
    ...detectInstructionDrift(input),
    ...detectVerificationRegression(input),
  ];
}
