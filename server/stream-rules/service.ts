/**
 * H16: stream-time rule triggers, applied where a run already passes.
 *
 * - **Streamed text** is watched inside the model step itself: the adapter
 *   hands each delta to `watch(...).onDelta`, the bounded evaluator matches it,
 *   and a firing is recorded while the stream is still running. A route that
 *   sends its answer whole is evaluated on that text before the step returns,
 *   and the firing says so (`source: 'final-text'`). Either way it is before any
 *   tool the answer proposes can be admitted.
 * - **A proposed tool intent** is judged by `hook`, a `RunService` hook: the
 *   same place H12 admission already runs, before the effect intent is written.
 *   There is no second path to an effect.
 *
 * What a firing does is the rule's intervention, and nothing else:
 *
 * - **annotate** records it;
 * - **hold** answers the hook with a hold, so the step waits at the approval
 *   gate for a person, as an ordinary Need the bridge raises;
 * - **steer** and **stop** are handed to H15 supervision, which reads the
 *   firing as a finding and answers it on its own ladder: a correction through
 *   H08 Steer or Queue, or an H08 Stop and a Need. A stop on a tool intent that
 *   supervision could not apply refuses the intent rather than letting it run.
 *
 * Model output and tool input are never changed. Every firing is appended to
 * `ProjectState.streamTriggerFirings` and never rewritten (decision 10).
 */
import type { HarnessRun, Json, StepIntent, ToolEffectClass } from '../../shared/harness.js';
import { TEAM_WORK_CAPABILITY } from '../harness/model-session-run.js';
import type { ProjectState, Settings } from '../../shared/types.js';
import {
  constrainsOf,
  firingsFor,
  interventionRank,
  resolveStreamRules,
  STREAM_RULE_LIMITS,
  streamRuleSetSchema,
  STREAM_RULE_WATCHES,
  TRIGGER_ACTOR,
  type AuthoredStreamRule,
  type StreamRule,
  type StreamRuleAuthority,
  type StreamRuleResolution,
  type StreamTriggerFiring,
  type StreamTriggerMatch,
} from '../../shared/stream-rules.js';
import { AGENT_NAME } from '../../shared/agent-name.js';
import { OWNER_RULES_NOT_INCLUDED_REASON } from '../../shared/access.js';
import { ApiError, relativeName } from '../paths.js';
import { identifier, now, type Store } from '../store.js';
import { digest, HarnessError } from '../harness/policy.js';
import type { HarnessHook, HarnessHookVerdict, RunService } from '../harness/run-service.js';
import type { ToolRegistry } from '../harness/tools.js';
import { StreamEvaluator } from './evaluator.js';

/** What supervision offers this service: evaluate one run now. It takes the store lock itself. */
export interface TriggerSupervisionPort {
  evaluate(projectId: string, sessionId: string): Promise<unknown>;
}

/** The sink a model step hands its streamed text to. */
export interface StreamWatch {
  onDelta(text: string): void;
  /**
   * The stream is over. `finalText` is evaluated only when nothing was
   * streamed. Resolves once every firing is durable and handed on; rejects when
   * one could not be, so the step never returns past an unrecorded firing.
   */
  end(finalText: string | null): Promise<void>;
}

/**
 * The runs trigger rules watch: work loop runs, where Nectovia owns the model stream and tool
 * admission, and Work on an external engine, whose text streams back through Nectovia
 * (`work-watch.ts`). An external engine runs its own tools, and those are not watched.
 */
export const WATCHED_RUNS: readonly string[] = STREAM_RULE_WATCHES;

/** What a rule write changed, in words, in the order the rules are written; removals last. */
export function ruleChanges(before: readonly StreamRule[], after: readonly StreamRule[]): string[] {
  const earlier = new Map(before.map((rule) => [rule.id, rule]));
  const changes: string[] = [];
  for (const rule of after) {
    const previous = earlier.get(rule.id);
    if (!previous) changes.push(`added ${rule.id} v${rule.version}`);
    else if (digest(previous) !== digest(rule))
      changes.push(
        previous.enabled !== rule.enabled && digest({ ...previous, enabled: rule.enabled, version: rule.version }) === digest(rule)
          ? `turned ${rule.enabled ? 'on' : 'off'} ${rule.id} v${rule.version}`
          : `changed ${rule.id} v${rule.version}`,
      );
  }
  for (const rule of before) if (!after.some((item) => item.id === rule.id)) changes.push(`removed ${rule.id}`);
  return changes;
}

/** Which stored rule cannot run, and why, in the words the rules API would have refused it with. */
export interface UnreadableStreamRules {
  readonly authority: StreamRuleAuthority;
  /** The rule's id when it has a readable one; null when the layer as a whole is refused. */
  readonly ruleId: string | null;
  readonly message: string;
}

/** One authority's stored rules, held to the rules API's own schema, or why they cannot run. */
function readLayer(
  authority: StreamRuleAuthority,
  stored: unknown,
): { rules: AuthoredStreamRule[] } | { problem: UnreadableStreamRules } {
  const parsed = streamRuleSetSchema.safeParse({ protocolVersion: 1, rules: stored ?? [] });
  if (parsed.success) return { rules: parsed.data.rules.map((rule) => ({ rule, authority })) };
  const issue = parsed.error.issues[0];
  const index = issue?.path[0] === 'rules' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
  const raw = index === null || !Array.isArray(stored) ? null : (stored[index] as { id?: unknown } | null);
  const ruleId = typeof raw?.id === 'string' ? raw.id.slice(0, 64) : null;
  const which = `${authority === 'organization' ? 'An organization' : 'A project'} trigger rule${ruleId ? ` (${ruleId})` : ''}`;
  return {
    problem: {
      authority,
      ruleId,
      message: `${which} on disk is not one ${AGENT_NAME} can run: ${issue?.message ?? 'it is not in the expected shape.'} Fix or remove it through the rules API; until then no run it would watch goes ahead.`,
    },
  };
}

/** Runs whose tool intents answer to a Work Session named by their command id. */
const TEAM_WORK_RUNS = TEAM_WORK_CAPABILITY.id;

/** The declaration that fired: its exact bytes' digest, never just its id. */
export const ruleDigest = (rule: StreamRule) => digest(rule);

/** Path-like fields a tool's own input may carry, when it declares no targets. */
const PATH_KEYS = ['path', 'paths', 'file', 'files', 'target', 'document', 'documents'];
function pathsIn(input: Json): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = (input as Record<string, Json>)[key];
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) found.push(...value.filter((item): item is string => typeof item === 'string'));
  }
  return found;
}

const clean = (name: string) => name.replace(/^\.\/+/, '');

/** Where the project folder's file names ignore case, so a spelling in another case names the same file. */
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * A target as the readers and writers resolve it (decision 11: a path is judged by
 * what it resolves to, not by how it is spelled): `docs\order.md` is `docs/order.md`,
 * and where file names ignore case, so does the comparison.
 */
function canonical(name: string, foldCase: boolean): string {
  let resolved: string;
  try {
    resolved = relativeName(name);
  } catch {
    resolved = clean(name.replaceAll('\\', '/'));
  }
  return foldCase ? resolved.toLowerCase() : resolved;
}

/** A target inside a rule's target: the same file, or anything under a folder ending in `/`. */
export function targetMatches(target: string, wanted: string, foldCase = FOLDS_CASE): boolean {
  const have = canonical(target, foldCase);
  const want = wanted.endsWith('/') ? `${canonical(wanted.slice(0, -1), foldCase)}/` : canonical(wanted, foldCase);
  return want.endsWith('/') ? have.startsWith(want) : have === want;
}

export interface ToolFacts {
  readonly tool: string;
  readonly effectClass: ToolEffectClass | null;
  readonly targets: readonly string[];
}

export function toolMatches(match: StreamRule['match'], facts: ToolFacts): boolean {
  if (match.kind !== 'tool') return false;
  if (match.tool !== undefined && match.tool !== facts.tool) return false;
  if (match.effectClass !== undefined && (!facts.effectClass || !match.effectClass.includes(facts.effectClass)))
    return false;
  if (match.target !== undefined && !facts.targets.some((target) => targetMatches(target, match.target!))) return false;
  return true;
}

/**
 * How a firing is handled. A hold waits at the approval gate only where that
 * gate can carry a person's exact OK for this intent — a step whose own policy
 * already asks for one (today the recorded write). Any other held intent is
 * refused at admission and paused for you through supervision, so it still
 * never runs before a person answers.
 */
const handlingOf = (intervention: StreamRule['intervention'], gated: boolean): StreamTriggerFiring['handling'] =>
  intervention === 'annotate'
    ? 'recorded'
    : intervention === 'hold' && gated
      ? 'held-for-you'
      : 'handed-to-supervision';

type Pending = Omit<StreamTriggerFiring, 'protocolVersion' | 'id' | 'at' | 'actor'>;

/** Same run, step, rule and span or intent: one firing, however often it is looked at. */
const identity = (firing: Pending | StreamTriggerFiring) =>
  [
    firing.runId,
    firing.stepId,
    `${firing.rule.authority}:${firing.rule.id}@${firing.rule.digest}`,
    firing.match.kind === 'tool' ? firing.match.intentHash : `${firing.attempt}:${firing.match.start}`,
  ].join('|');

export class StreamRuleService {
  private supervision: TriggerSupervisionPort | null = null;

  constructor(
    private readonly deps: {
      store: Store;
      runs: RunService;
      tools: ToolRegistry;
      redact: (text: string) => string;
      /**
       * Whether the work's business holds 'owner-rules' (Andrew, 2026-09-25), resolved
       * through the account session the way the Agent gate does. Absent passes everything
       * through, the embedded-host behaviour; a Personal project answers false.
       */
      ownerRules?: (projectId: string | null) => boolean;
    },
  ) {}

  attachSupervision(port: TriggerSupervisionPort) {
    this.supervision = port;
  }

  private get store() {
    return this.deps.store;
  }

  /**
   * Owner-written rules are a paid ability: without the feature they are kept, listed and
   * never evaluated — not read for a watch, not judged at a tool's admission. `null` (the
   * organization list) answers for the active workspace, as the Agent gate resolves it.
   */
  private included(projectId: string | null): boolean {
    return this.deps.ownerRules?.(projectId) ?? true;
  }

  // --- the rules -----------------------------------------------------------------

  /**
   * The rules at both authorities, each layer re-validated as a whole: a file edited by hand
   * is held to the same schema, grammar and budget as a write through the rules API. A layer
   * that fails is refused, never trimmed — dropping a rule would silently loosen what someone
   * wrote — so everything that reads the rules fails closed (review G, finding 7).
   */
  private authored(state: Pick<ProjectState, 'streamTriggerRules'>): AuthoredStreamRule[] {
    const layers = [readLayer('organization', this.store.settings.streamTriggerRules), readLayer('project', state.streamTriggerRules)];
    const problem = layers.find((layer) => 'problem' in layer);
    if (problem && 'problem' in problem) throw new HarnessError('stream_rules_unreadable', problem.problem.message);
    return layers.flatMap((layer) => ('rules' in layer ? layer.rules : []));
  }

  /** Which rules watch a run of this task in this project, and why the others do not. */
  resolution(projectId: string, taskId: string | null): StreamRuleResolution {
    return resolveStreamRules(
      this.included(projectId) ? this.authored(this.store.state(projectId)) : [],
      taskId,
    );
  }

  /**
   * The rules at both authorities, and how they resolve for a task (or for none). A layer on
   * disk that cannot run is listed as stored, with `unreadable` saying which rule and why and
   * no resolution, so the person can see what to fix.
   */
  list(projectId: string | null, taskId: string | null = null) {
    const organization = structuredClone(this.store.settings.streamTriggerRules ?? []);
    const state = projectId === null ? null : this.store.state(projectId);
    const unreadable = [
      readLayer('organization', organization),
      ...(state ? [readLayer('project', state.streamTriggerRules)] : []),
    ].flatMap((layer) => ('problem' in layer ? [layer.problem] : []));
    // The rules stay listed — they are the owner's data — but nothing claims they watch
    // when the business does not hold them: no resolution, and the one reason sentence.
    const included = this.included(projectId);
    const view = {
      organization,
      watches: WATCHED_RUNS,
      notIncludedReason: included ? null : OWNER_RULES_NOT_INCLUDED_REASON,
      ...(unreadable.length ? { unreadable } : {}),
    };
    if (state === null) return { ...view, project: [], resolution: null };
    return {
      ...view,
      project: structuredClone(state.streamTriggerRules ?? []),
      resolution:
        unreadable.length || !included ? null : resolveStreamRules(this.authored(state), taskId),
    };
  }

  /**
   * Replace the rules at one authority. The caller holds the store lock and is
   * the local person, who administers this installation. Refused, with nothing
   * changed, when a rule would loosen one it cannot or two rules of the same
   * authority contradict each other.
   */
  async setRules(authority: StreamRuleAuthority, projectId: string | null, body: unknown) {
    const parsed = streamRuleSetSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'These rules are not in the expected shape.', {
        code: 'invalid_stream_rules',
      });
    const rules = parsed.data.rules;
    const layer = rules.map((rule) => ({ rule, authority }));
    for (const task of new Set(rules.map((rule) => rule.taskId ?? null))) {
      const conflict = resolveStreamRules(layer, task).conflicts[0];
      if (conflict)
        throw new ApiError(409, `${conflict.message.replace(/(organization|project):/g, '')} Change one of them.`, {
          code: 'stream_rule_conflict',
        });
    }
    if (authority === 'project') {
      const state = this.store.state(projectId!);
      // The organization's rules decide what a project rule may loosen, so a project write
      // waits until they can be read.
      const read = readLayer('organization', this.store.settings.streamTriggerRules);
      if ('problem' in read)
        throw new ApiError(409, read.problem.message, { code: 'stream_rules_unreadable' });
      const organization = read.rules;
      for (const item of layer) {
        const decision = resolveStreamRules([...organization, item], item.rule.taskId ?? null).decisions.find(
          (entry) => entry.authority === 'project' && entry.ruleId === item.rule.id,
        );
        if (decision?.outcome === 'blocked')
          throw new ApiError(409, `${item.rule.id}: ${decision.reason}`, { code: 'stream_rule_loosens' });
      }
      const changes = ruleChanges(state.streamTriggerRules ?? [], rules);
      state.streamTriggerRules = structuredClone(rules);
      // A project's rules are its configuration, recorded like turning a pack on: the local
      // person's decision, only when it changed something (decision 8).
      if (changes.length)
        this.store.addEntry(state, {
          kind: 'rules',
          sentence: `You changed this project's trigger rules: ${changes.join(', ')}. A rule grants nothing.`,
        });
      await this.store.persist(state);
      return this.list(projectId);
    }
    const settings: Settings = { ...structuredClone(this.store.settings), streamTriggerRules: structuredClone(rules) };
    await this.store.saveSettings(settings);
    return this.list(null);
  }

  /** A project's firings, or one run's, oldest first. */
  firings(projectId: string, sessionId?: string): StreamTriggerFiring[] {
    const firings = this.store.state(projectId).streamTriggerFirings ?? [];
    return structuredClone(sessionId ? firingsFor(firings, sessionId) : firings);
  }

  // --- recording -----------------------------------------------------------------

  private async record(projectId: string, pending: readonly Pending[]): Promise<StreamTriggerFiring[]> {
    return this.store.locked(async () => {
      const state = this.store.state(projectId);
      state.streamTriggerFirings ??= [];
      const firings = state.streamTriggerFirings;
      const known = new Set(firings.map(identity));
      const created: StreamTriggerFiring[] = [];
      for (const item of pending) {
        if (firings.length >= STREAM_RULE_LIMITS.firings) break;
        if (known.has(identity(item))) continue;
        const firing: StreamTriggerFiring = {
          protocolVersion: 1,
          id: identifier('TF'),
          at: now(),
          ...structuredClone(item),
          actor: TRIGGER_ACTOR,
        };
        firings.push(firing);
        known.add(identity(firing));
        created.push(firing);
      }
      if (created.length) await this.store.persist(state);
      return created;
    });
  }

  /** Steer and stop go to H15 supervision, which answers them on its ladder. */
  private async handOff(projectId: string, sessionId: string, firings: readonly StreamTriggerFiring[]) {
    if (!firings.some((firing) => firing.handling === 'handed-to-supervision')) return;
    await this.supervision?.evaluate(projectId, sessionId);
  }

  private firingOf(
    item: AuthoredStreamRule,
    run: { id: string; sessionId: string; taskId: string },
    stepId: string,
    attempt: number,
    match: StreamTriggerMatch,
    gated = false,
  ): Pending {
    const rule = item.rule;
    return {
      rule: {
        id: rule.id,
        version: rule.version,
        digest: ruleDigest(rule),
        authority: item.authority,
        constrains: constrainsOf(rule),
        text: rule.text,
        ...(rule.message ? { message: rule.message } : {}),
      },
      intervention: rule.intervention,
      sessionId: run.sessionId,
      taskId: run.taskId,
      runId: run.id,
      stepId,
      attempt,
      match,
      handling: handlingOf(rule.intervention, gated),
    };
  }

  /**
   * The Session and task a harness run belongs to, when it belongs to a person's work. A
   * child run a loop hands work to (an H13 delegate, an H14 worker or advisor) carries no
   * Session of its own; it answers to its parent's, so the rules that watch the parent watch
   * every intent the parent hands on.
   */
  private async owner(runId: string) {
    const run = await this.deps.runs.get(runId).catch(() => null);
    if (run && !run.taskId && run.capabilityId === TEAM_WORK_RUNS) return this.workOwner(run);
    if (!run?.taskId) return null;
    let sessionId = run.sessionId;
    let parent = run;
    for (let depth = 0; !sessionId && depth < 4; depth++) {
      const input = parent.input as { parent?: { runId?: unknown } } | null | undefined;
      const parentId = parent.parentRunId ?? (typeof input?.parent?.runId === 'string' ? input.parent.runId : null);
      if (!parentId) break;
      const next = await this.deps.runs.get(parentId).catch(() => null);
      if (!next || next.projectId !== run.projectId || next.taskId !== run.taskId) break;
      parent = next;
      sessionId = next.sessionId;
    }
    if (!sessionId) return null;
    let state: ProjectState;
    try {
      state = this.store.state(run.projectId);
    } catch {
      return null;
    }
    if (!state.sessions.some((session) => session.id === sessionId)) return null;
    return { run, state, ref: { id: run.id, sessionId, taskId: run.taskId } };
  }

  /**
   * A model-API team member's Work turn runs the team tools itself, through RunService, under
   * a run that names no Session: its command id is the Work run's Session, which carries the
   * task. Its tool intents answer to that Session's rules like a loop's.
   */
  private workOwner(run: HarnessRun) {
    const sessionId = (run.input as { commandId?: unknown } | null)?.commandId;
    if (typeof sessionId !== 'string') return null;
    let state: ProjectState;
    try {
      state = this.store.state(run.projectId);
    } catch {
      return null;
    }
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session?.taskId) return null;
    return { run: { ...run, taskId: session.taskId }, state, ref: { id: run.id, sessionId, taskId: session.taskId } };
  }

  // --- tool intents, at admission ------------------------------------------------------

  private async facts(step: StepIntent, effect: Parameters<HarnessHook>[0]['effect']): Promise<ToolFacts> {
    // A read declares no targets (H12 records targets only for effects); judge the paths it names.
    if (effect)
      return {
        tool: effect.tool,
        effectClass: effect.effectClass,
        targets: effect.targets.length ? effect.targets : pathsIn(step.input),
      };
    const name = step.name ?? step.stepId;
    if (!this.deps.tools.has(name)) return { tool: name, effectClass: null, targets: pathsIn(step.input) };
    const tool = this.deps.tools.get(name);
    let targets: string[] = [];
    try {
      targets = tool.targets ? [...(await tool.targets(step.input))] : [];
    } catch {
      // The tool's own containment refuses this input at admission; judge what it names.
    }
    return { tool: name, effectClass: tool.effectClass, targets: targets.length ? targets : pathsIn(step.input) };
  }

  /** The `RunService` hook: judge a proposed tool intent before it is admitted. */
  readonly hook = async ({ runId, step, effect }: Parameters<HarnessHook>[0]): Promise<HarnessHookVerdict> => {
    if (step.kind !== 'tool') return;
    const owner = await this.owner(runId);
    if (!owner) return;
    const { run, state, ref } = owner;
    if (!this.included(run.projectId)) return;
    const existing = run.steps.find((item) => item.intent.stepId === step.stepId);
    if (existing?.state === 'succeeded') return;
    const active = resolveStreamRules(this.authored(state), run.taskId).active.filter(
      (item) => item.rule.match.kind === 'tool',
    );
    if (!active.length) return;
    const facts = await this.facts(step, effect);
    const matched = active.filter((item) => toolMatches(item.rule.match, facts));
    if (!matched.length) return;
    const intentHash = digest(step);
    const attempt = (existing?.attempt ?? 0) + 1;
    const created = await this.record(
      run.projectId,
      matched.map((item) =>
        this.firingOf(item, ref, step.stepId, attempt, {
          kind: 'tool',
          tool: facts.tool,
          effectClass: facts.effectClass,
          targets: [...facts.targets].slice(0, 20),
          intentHash,
        }, step.approval),
      ),
    );
    await this.handOff(run.projectId, ref.sessionId, created);
    const strongest = matched.reduce((a, b) =>
      interventionRank(b.rule.intervention) > interventionRank(a.rule.intervention) ? b : a,
    );
    const holds = matched.filter((item) => item.rule.intervention === 'hold');
    if (strongest.rule.intervention === 'stop' || (holds.length && !step.approval)) {
      // Supervision paused the run, and admission will refuse the step as cancelled. If it
      // could not, the intent is refused here: a stop or a hold never lets its effect run first.
      if ((await this.deps.runs.get(runId)).state !== 'cancelled')
        throw new HarnessError('trigger_stopped', `A rule stopped this before it ran: ${strongest.rule.text}`);
      return;
    }
    if (holds.length)
      return {
        hold: {
          reason: holds.map((item) => item.rule.text).join(' '),
          refs: holds.map((item) => `${item.authority}:${item.rule.id}@${item.rule.version}`),
        },
      };
  };

  // --- streamed text, inside the model step ---------------------------------------------

  /** A watch for one model step attempt, or null when no text rule watches this run. */
  async watch(runId: string, stepId: string, attempt: number): Promise<StreamWatch | null> {
    const owner = await this.owner(runId);
    if (!owner) return null;
    return this.open(
      owner.run.projectId,
      owner.state,
      owner.ref,
      stepId,
      attempt,
      async () => (await this.deps.runs.get(runId)).state === 'cancelled',
    );
  }

  /**
   * A watch for one Work request on an external engine (Codex, Claude Code, OpenCode, the ACP
   * routes, model-API routes), or null when no text rule watches it. The Work run's Session is
   * the owner; `where` names the run and step the text streamed in, as the route records it.
   * `stopped` says whether the Work request was already stopped, as supervision's H08 Stop does.
   */
  async watchWork(
    projectId: string,
    sessionId: string,
    where: { runId: string; stepId: string },
    stopped: () => boolean,
  ): Promise<StreamWatch | null> {
    let state: ProjectState;
    try {
      state = this.store.state(projectId);
    } catch {
      return null;
    }
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session?.taskId) return null;
    return this.open(projectId, state, { id: where.runId, sessionId, taskId: session.taskId }, where.stepId, 1, async () =>
      stopped(),
    );
  }

  private open(
    projectId: string,
    state: ProjectState,
    ref: { id: string; sessionId: string; taskId: string },
    stepId: string,
    attempt: number,
    stopped: () => Promise<boolean>,
  ): StreamWatch | null {
    const run = { projectId };
    if (!this.included(projectId)) return null;
    const active = resolveStreamRules(this.authored(state), ref.taskId).active.filter(
      (item) => item.rule.match.kind !== 'tool',
    );
    if (!active.length) return null;
    let source: 'stream' | 'final-text' = 'stream';
    let chain: Promise<void> = Promise.resolve();
    let failure: unknown = null;
    const act = (pending: Pending) => {
      // Durable and handed on at once, so a stop lands while the stream is still running.
      chain = chain
        .then(async () => {
          const created = await this.record(run.projectId, [pending]);
          await this.handOff(run.projectId, ref.sessionId, created);
          // Supervision may not pause the run (an escalation for this rule is already open on
          // the task). A stop rule still never lets the run act on what it streamed.
          if (pending.intervention === 'stop' && !(await stopped()))
            throw new HarnessError('trigger_stopped', `A rule stopped this run: ${pending.rule.text}`);
        })
        .catch((error: unknown) => {
          failure ??= error;
        });
    };
    const evaluator = new StreamEvaluator(
      active.map((item) => item.rule),
      (hit) => {
        const item = active[hit.rule];
        act(
          this.firingOf(item, ref, stepId, attempt, {
            kind: item.rule.match.kind as 'text' | 'pattern',
            source,
            start: hit.start,
            end: hit.end,
            excerpt: this.deps.redact(hit.text).slice(0, STREAM_RULE_LIMITS.excerpt),
          }),
        );
      },
    );
    let ended = false;
    return {
      onDelta: (text) => evaluator.push(text),
      end: async (finalText) => {
        if (!ended) {
          ended = true;
          if (evaluator.length === 0 && finalText) {
            source = 'final-text';
            evaluator.push(finalText);
          }
          evaluator.end();
        }
        await chain;
        if (failure) throw failure;
      },
    };
  }
}
