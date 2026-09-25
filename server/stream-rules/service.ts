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
import type { Json, StepIntent, ToolEffectClass } from '../../shared/harness.js';
import type { ProjectState, Settings } from '../../shared/types.js';
import {
  constrainsOf,
  firingsFor,
  interventionRank,
  resolveStreamRules,
  STREAM_RULE_LIMITS,
  streamRuleSetSchema,
  TRIGGER_ACTOR,
  type AuthoredStreamRule,
  type StreamRule,
  type StreamRuleAuthority,
  type StreamRuleResolution,
  type StreamTriggerFiring,
  type StreamTriggerMatch,
} from '../../shared/stream-rules.js';
import { ApiError } from '../paths.js';
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

/** A target inside a rule's target: the same file, or anything under a folder ending in `/`. */
export function targetMatches(target: string, wanted: string): boolean {
  const have = clean(target);
  const want = clean(wanted);
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
    },
  ) {}

  attachSupervision(port: TriggerSupervisionPort) {
    this.supervision = port;
  }

  private get store() {
    return this.deps.store;
  }

  // --- the rules -----------------------------------------------------------------

  private authored(state: Pick<ProjectState, 'streamTriggerRules'>): AuthoredStreamRule[] {
    return [
      ...(this.store.settings.streamTriggerRules ?? []).map((rule) => ({ rule, authority: 'organization' as const })),
      ...(state.streamTriggerRules ?? []).map((rule) => ({ rule, authority: 'project' as const })),
    ];
  }

  /** Which rules watch a run of this task in this project, and why the others do not. */
  resolution(projectId: string, taskId: string | null): StreamRuleResolution {
    return resolveStreamRules(this.authored(this.store.state(projectId)), taskId);
  }

  /** The rules at both authorities, and how they resolve for a task (or for none). */
  list(projectId: string | null, taskId: string | null = null) {
    const organization = structuredClone(this.store.settings.streamTriggerRules ?? []);
    if (projectId === null) return { organization, project: [], resolution: null };
    const state = this.store.state(projectId);
    return {
      organization,
      project: structuredClone(state.streamTriggerRules ?? []),
      resolution: resolveStreamRules(this.authored(state), taskId),
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
      const organization = this.authored({ streamTriggerRules: [] });
      for (const item of layer) {
        const decision = resolveStreamRules([...organization, item], item.rule.taskId ?? null).decisions.find(
          (entry) => entry.authority === 'project' && entry.ruleId === item.rule.id,
        );
        if (decision?.outcome === 'blocked')
          throw new ApiError(409, `${item.rule.id}: ${decision.reason}`, { code: 'stream_rule_loosens' });
      }
      state.streamTriggerRules = structuredClone(rules);
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

  /** The Session and task a harness run belongs to, when it belongs to a person's work. */
  private async owner(runId: string) {
    const run = await this.deps.runs.get(runId).catch(() => null);
    if (!run?.sessionId || !run.taskId) return null;
    let state: ProjectState;
    try {
      state = this.store.state(run.projectId);
    } catch {
      return null;
    }
    if (!state.sessions.some((session) => session.id === run.sessionId)) return null;
    return { run, state, ref: { id: run.id, sessionId: run.sessionId, taskId: run.taskId } };
  }

  // --- tool intents, at admission ------------------------------------------------------

  private async facts(step: StepIntent, effect: Parameters<HarnessHook>[0]['effect']): Promise<ToolFacts> {
    // A read's effect record names no targets (only effects on the world declare them), so judge
    // what its own input names, as for a tool with no effect record.
    if (effect)
      return { tool: effect.tool, effectClass: effect.effectClass, targets: effect.targets.length ? effect.targets : pathsIn(step.input) };
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
    const { run, state, ref } = owner;
    const active = resolveStreamRules(this.authored(state), run.taskId).active.filter(
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
          if (pending.intervention === 'stop' && (await this.deps.runs.get(runId)).state !== 'cancelled')
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
