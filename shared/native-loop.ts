/**
 * H13: the Diomedes-owned plan → act → observe → finish loop, as records.
 *
 * The loop keeps no lifecycle of its own. Every phase is an ordinary step in
 * the run's durable record (`server/harness/run-service.ts`), and everything a
 * person sees here is projected from those steps on every read:
 *
 * | Step id            | Kind      | Who it is attributed to                     |
 * |--------------------|-----------|---------------------------------------------|
 * | `loop:context`     | transform | Diomedes application (context accounting)   |
 * | `model:plan`       | model     | the runtime-reported model                  |
 * | `plan`             | transform | Diomedes native supervisor (bounded plan)   |
 * | `model:<n>`        | model     | the runtime-reported model (next action)    |
 * | `tool:<n>`         | tool      | the registry's tool, under Trust            |
 * | `handoff:<n>`      | transform | Diomedes native supervisor (the envelope)   |
 * | `delegate:<n>`     | tool      | Diomedes native supervisor (child run)      |
 * | `observe:<n>`      | transform | Diomedes application (what came back)       |
 * | `finish:<n>`       | transform | Diomedes native supervisor (a claim only)   |
 * | `stop:turns`/`stop:budget` | transform | Diomedes native supervisor          |
 *
 * A finish is a claim, never a grade. Whether the result is done is decided by
 * H17's projection of the task's declared acceptance checks against the bytes
 * the run wrote (`shared/verification.ts`); `loopOutcome` only reads it.
 *
 * Pure: no clock, no disk, no request. Client and server share it.
 */
import type { OriginSnapshot } from './attribution.js';
import type { ContextAccount } from './context-accounting.js';
import type { HandoffEnvelope } from './handoff.js';
import type {
  HarnessBudget,
  HarnessRun,
  HarnessRunState,
  HarnessUsage,
  StepRecord,
  StepState,
} from './harness.js';
import { VERIFICATION_LABEL, type VerificationState } from './verification.js';

export const NATIVE_LOOP_VERSION = 'v1';
export const NATIVE_LOOP_CAPABILITY = 'diomedes-loop';
export const NATIVE_LOOP_DELEGATE_CAPABILITY = 'diomedes-loop-delegate';
/** The Session engine name of a loop run. Never a model or provider name. */
export const NATIVE_LOOP_ENGINE = 'diomedes-loop';
/** The executor id on steps the loop itself decides. */
export const NATIVE_LOOP_EXECUTOR = 'diomedes:native-loop';

/**
 * A step the loop itself decided: recording the plan, opening a handoff, waiting
 * for a delegate, recording a finish claim or a stop. Diomedes is the actor here
 * because the native loop truly owns these operations (decision 8). No model is
 * named: the model steps carry their own runtime-reported origin.
 */
export function supervisorOrigin(): OriginSnapshot {
  return {
    protocolVersion: 1,
    mode: 'supervisor',
    engine: null,
    model: { requested: null, reported: null, source: 'not-recorded' },
    executorId: NATIVE_LOOP_EXECUTOR,
  };
}

/**
 * The origin a loop run's Session shows: Diomedes supervising, with the first
 * model the runtime reported for it. Before any model reported, it is Diomedes'
 * native supervisor with no model named. A scripted route names none, ever.
 */
export function loopSessionOrigin(run: Pick<HarnessRun, 'steps'>): OriginSnapshot {
  const model = run.steps.find(
    (step) =>
      step.intent.kind === 'model' &&
      step.state === 'succeeded' &&
      step.origin?.mode === 'direct' &&
      step.origin.model.source === 'runtime',
  )?.origin;
  return model
    ? {
        ...supervisorOrigin(),
        engine: model.engine,
        model: { requested: model.model.requested, reported: model.model.reported, source: 'runtime' },
        ...(model.accountRoute ? { accountRoute: model.accountRoute } : {}),
      }
    : supervisorOrigin();
}

/** Small on purpose: a loop that needs more is not bounded work. */
export const LOOP_LIMITS = Object.freeze({
  defaultTurns: 8,
  maxTurns: 16,
  planItems: 8,
  planItemChars: 240,
  claimChars: 4000,
  excerptChars: 600,
  /** One level only: a delegate is never offered `delegate`. */
  delegationDepth: 1,
  delegationsPerRun: 2,
  delegateTurns: 4,
  taskChars: 2000,
});

/** What a loop run was admitted with, pinned in `HarnessRun.input` at start. */
export interface LoopRunInput {
  readonly v: 1;
  readonly kind: 'diomedes-loop';
  readonly goal: string;
  readonly route: string;
  readonly model: string | null;
  readonly accountRoute: string | null;
  readonly maxTurns: number;
  /** The H11 instruction section this run was admitted with, or empty. */
  readonly instructions: string;
  /** The route a bounded sub-task may be handed to, chosen by the person. Null offers no delegation. */
  readonly delegate: { readonly route: string; readonly model: string | null; readonly accountRoute: string | null } | null;
  readonly sources: readonly string[];
}

/** What a delegate child run was admitted with. */
export interface LoopChildInput {
  readonly v: 1;
  readonly kind: 'diomedes-loop-delegate';
  readonly parent: { readonly runId: string; readonly stepId: string; readonly handoffId: string };
  readonly task: string;
  readonly route: string;
  readonly model: string | null;
  readonly accountRoute: string | null;
  readonly maxTurns: number;
}

export interface LoopContextRecord {
  readonly v: 1;
  readonly goal: string;
  readonly route: string;
  readonly model: string | null;
  readonly instructions: { readonly sha: string; readonly bytes: number };
  readonly tools: readonly string[];
  /** H18's account of the first call, estimated. The finish or stop record carries it reconciled. */
  readonly account: ContextAccount;
}

export interface LoopPlanRecord {
  readonly v: 1;
  readonly items: readonly string[];
  /** More steps were proposed than a loop keeps, or an item was cut. */
  readonly truncated: boolean;
  readonly from: string;
}

export interface LoopObservationRecord {
  readonly v: 1;
  readonly turn: number;
  readonly action: 'tool' | 'delegate' | 'refused';
  readonly tool: string;
  readonly ok: boolean;
  /** sha-256 of the full canonical output, so the excerpt can be tied to the step record. */
  readonly sha: string | null;
  readonly bytes: number;
  readonly excerpt: string;
  readonly detail: string | null;
}

export interface LoopHandoffRecord {
  readonly v: 1;
  readonly turn: number;
  readonly envelope: HandoffEnvelope | null;
  readonly refusal: string | null;
  readonly route: string;
  readonly childRunId: string;
  readonly task: string;
  readonly budget: HarnessBudget;
}

export interface LoopDelegateResult {
  readonly v: 1;
  readonly childRunId: string;
  readonly state: HarnessRunState;
  readonly text: string | null;
  readonly reason: string | null;
  readonly models: readonly LoopModel[];
}

export interface LoopFinishRecord {
  readonly v: 1;
  readonly turn: number;
  /** The model's own summary. A claim to check, never a verification. */
  readonly claim: string;
  readonly account: ContextAccount | null;
}

export type LoopStopReason = 'turn-limit' | 'budget';
export interface LoopStopRecord {
  readonly v: 1;
  readonly reason: LoopStopReason;
  readonly detail: string;
  readonly turns: { readonly used: number; readonly limit: number };
  readonly used: HarnessUsage;
  readonly budget: HarnessBudget;
  readonly account: ContextAccount | null;
}

/** A model the runtime reported for this run's model steps. */
export interface LoopModel {
  readonly engine: string | null;
  readonly reported: string | null;
  readonly calls: number;
}

export interface LoopTurnView {
  readonly turn: number;
  readonly decision: 'tool' | 'delegate' | 'finish' | 'refused' | 'deciding';
  readonly tool: string | null;
  readonly actionState: StepState | null;
  readonly approval: boolean;
  readonly observation: LoopObservationRecord | null;
}

export interface LoopDelegationView {
  readonly turn: number;
  readonly handoffId: string | null;
  readonly route: string;
  readonly childRunId: string;
  readonly task: string;
  readonly budget: HarnessBudget;
  readonly refusal: string | null;
  readonly state: StepState | null;
  readonly result: LoopDelegateResult | null;
  readonly child: {
    readonly state: HarnessRunState;
    readonly used: HarnessUsage;
    readonly budget: HarnessBudget;
    readonly models: readonly LoopModel[];
    readonly cancelReason: string | null;
  } | null;
}

export interface LoopView {
  readonly runId: string;
  readonly state: HarnessRunState;
  readonly route: string | null;
  readonly requestedModel: string | null;
  readonly delegateRoute: string | null;
  readonly models: readonly LoopModel[];
  readonly context: LoopContextRecord | null;
  readonly account: ContextAccount | null;
  readonly plan: LoopPlanRecord | null;
  readonly turns: readonly LoopTurnView[];
  readonly delegations: readonly LoopDelegationView[];
  readonly finish: LoopFinishRecord | null;
  readonly stop: LoopStopRecord | null;
  readonly waiting: { readonly stepId: string; readonly tool: string } | null;
  readonly usage: {
    readonly turns: { readonly used: number; readonly limit: number };
    readonly modelCalls: { readonly used: number; readonly limit: number };
    readonly toolCalls: { readonly used: number; readonly limit: number };
    readonly units: { readonly used: number; readonly limit: number };
  };
  readonly cancelReason: string | null;
  readonly failure: { readonly name: string; readonly message: string } | null;
}

const record = <T>(step: StepRecord | undefined): T | null =>
  step && step.state === 'succeeded' && step.output && typeof step.output === 'object'
    ? (step.output as unknown as T)
    : null;

const asInput = (run: Pick<HarnessRun, 'input'>): Partial<LoopRunInput> =>
  run.input && typeof run.input === 'object' && !Array.isArray(run.input)
    ? (run.input as unknown as Partial<LoopRunInput>)
    : {};

/** The runtime-reported models behind a run's succeeded model steps, from their origins only. */
export function reportedModels(run: Pick<HarnessRun, 'steps'>): LoopModel[] {
  const found = new Map<string, LoopModel>();
  for (const step of run.steps) {
    if (step.intent.kind !== 'model' || step.state !== 'succeeded' || !step.origin) continue;
    const origin = step.origin;
    // A scripted adapter is an application action: no model authored it.
    if (origin.mode === 'application') continue;
    const engine = origin.engine?.id ?? null;
    const reported = origin.model.source === 'runtime' ? origin.model.reported : null;
    const key = JSON.stringify([engine, reported]);
    const prior = found.get(key);
    found.set(key, { engine, reported, calls: (prior?.calls ?? 0) + 1 });
  }
  return [...found.values()];
}

const turnOf = (stepId: string, prefix: string): number | null => {
  if (!stepId.startsWith(prefix)) return null;
  const value = Number(stepId.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/** The loop as a person reads it, from the run's own steps and its delegate children. */
export function loopView(run: HarnessRun, children: readonly HarnessRun[] = []): LoopView {
  const input = asInput(run);
  const byId = new Map(run.steps.map((step) => [step.intent.stepId, step]));
  const turns: LoopTurnView[] = [];
  const delegations: LoopDelegationView[] = [];
  let finish: LoopFinishRecord | null = null;
  const models = run.steps
    .map((step) => turnOf(step.intent.stepId, 'model:'))
    .filter((turn): turn is number => turn !== null)
    .sort((a, b) => a - b);
  for (const turn of models) {
    const tool = byId.get(`tool:${turn}`);
    const handoffStep = byId.get(`handoff:${turn}`);
    const delegate = byId.get(`delegate:${turn}`);
    const observation = record<LoopObservationRecord>(byId.get(`observe:${turn}`));
    const finished = record<LoopFinishRecord>(byId.get(`finish:${turn}`));
    if (finished) finish = finished;
    const decision: LoopTurnView['decision'] = finished
      ? 'finish'
      : handoffStep || delegate
        ? 'delegate'
        : tool
          ? 'tool'
          : observation?.action === 'refused'
            ? 'refused'
            : 'deciding';
    const action = tool ?? delegate ?? null;
    turns.push({
      turn,
      decision,
      tool: action?.intent.name ?? observation?.tool ?? null,
      actionState: action?.state ?? null,
      approval: action?.intent.approval === true,
      observation,
    });
    if (handoffStep) {
      const handoff = record<LoopHandoffRecord>(handoffStep);
      const handoffInput = handoffStep.intent.input as unknown as Partial<LoopHandoffRecord> | null;
      const childRunId = handoff?.childRunId ?? handoffInput?.childRunId ?? '';
      const child = children.find((item) => item.id === childRunId) ?? null;
      delegations.push({
        turn,
        handoffId: handoff?.envelope?.id ?? null,
        route: handoff?.route ?? handoffInput?.route ?? '',
        childRunId,
        task: handoff?.task ?? handoffInput?.task ?? '',
        budget: handoff?.budget ?? { units: 0, modelCalls: 0, toolCalls: 0, wallMs: null },
        refusal: handoff?.refusal ?? null,
        state: delegate?.state ?? null,
        result: record<LoopDelegateResult>(delegate),
        child: child
          ? {
              state: child.state,
              used: child.used,
              budget: child.budget,
              models: reportedModels(child),
              cancelReason: child.cancelReason,
            }
          : null,
      });
    }
  }
  const stop =
    record<LoopStopRecord>(byId.get('stop:turns')) ?? record<LoopStopRecord>(byId.get('stop:budget'));
  const context = record<LoopContextRecord>(byId.get('loop:context'));
  const waitingStep = run.steps.find((step) => step.state === 'waiting_approval');
  const limit = typeof input.maxTurns === 'number' ? input.maxTurns : LOOP_LIMITS.defaultTurns;
  return {
    runId: run.id,
    state: run.state,
    route: typeof input.route === 'string' ? input.route : null,
    requestedModel: typeof input.model === 'string' ? input.model : null,
    delegateRoute: input.delegate?.route ?? null,
    models: reportedModels(run),
    context,
    account: finish?.account ?? stop?.account ?? context?.account ?? null,
    plan: record<LoopPlanRecord>(byId.get('plan')),
    turns,
    delegations,
    finish,
    stop,
    waiting: waitingStep
      ? { stepId: waitingStep.intent.stepId, tool: waitingStep.intent.name ?? waitingStep.intent.stepId }
      : null,
    usage: {
      turns: { used: models.length, limit },
      modelCalls: { used: run.used.modelCalls, limit: run.budget.modelCalls },
      toolCalls: { used: run.used.toolCalls, limit: run.budget.toolCalls },
      units: { used: run.used.units, limit: run.budget.units },
    },
    cancelReason: run.cancelReason,
    failure: run.failure,
  };
}

export type LoopOutcomeState =
  | 'working'
  | 'waiting'
  | 'verified'
  | 'not-verified'
  | 'failed-verification'
  | 'uncertain'
  | 'stopped-limit'
  | 'stopped'
  | 'failed'
  | 'reconcile';

export interface LoopOutcome {
  readonly state: LoopOutcomeState;
  readonly label: string;
  readonly sentence: string;
}

const VERIFICATION_OUTCOME: Record<VerificationState, LoopOutcomeState> = {
  verified: 'verified',
  'not-verified': 'not-verified',
  failed: 'failed-verification',
  uncertain: 'uncertain',
};

/**
 * What the loop ended as. A finish reads as done only when H17's projection
 * says Verified; otherwise it is the projection's own state and sentence. A
 * stop at a limit says which limit, and the run is never called finished.
 */
export function loopOutcome(
  view: Pick<LoopView, 'state' | 'finish' | 'stop' | 'plan' | 'waiting' | 'cancelReason'>,
  verification: { readonly state: VerificationState; readonly sentence: string } | null,
): LoopOutcome {
  switch (view.state) {
    case 'queued':
    case 'running':
      return {
        state: 'working',
        label: view.plan ? 'Working' : 'Planning',
        sentence: view.plan ? 'Acting on its plan, one recorded step at a time.' : 'Writing a bounded plan first.',
      };
    case 'waiting':
      return {
        state: 'waiting',
        label: 'Waiting for your OK',
        sentence: view.waiting
          ? `The next action, ${view.waiting.tool}, waits for your OK. Nothing runs until you answer.`
          : 'Waiting for something outside Diomedes.',
      };
    case 'reconcile_required':
      return {
        state: 'reconcile',
        label: 'Needs checking',
        sentence: 'An action may have happened that Diomedes could not confirm. Nothing will be repeated on its own.',
      };
    case 'completed': {
      if (!verification)
        return {
          state: 'not-verified',
          label: VERIFICATION_LABEL['not-verified'],
          sentence: 'The loop finished. Its declared checks have not been read yet.',
        };
      return {
        state: VERIFICATION_OUTCOME[verification.state],
        label: VERIFICATION_LABEL[verification.state],
        sentence: verification.sentence,
      };
    }
    case 'cancelled':
      if (view.stop)
        return {
          state: 'stopped-limit',
          label: view.stop.reason === 'turn-limit' ? 'Stopped: turn limit reached' : 'Stopped: budget reached',
          sentence: view.stop.detail,
        };
      return {
        state: 'stopped',
        label: 'Stopped',
        sentence: view.cancelReason ? `Stopped: ${view.cancelReason}` : 'Stopped.',
      };
    case 'failed':
      return {
        state: 'failed',
        label: 'Failed',
        sentence: 'Stopped because something went wrong. Nothing will be repeated on its own.',
      };
  }
}

/** Plan text to at most `planItems` short items. Numbering and bullets are the model's, not content. */
export function parsePlan(text: string): { items: string[]; truncated: boolean } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|step\s+\d+[:.)]?)\s*/i, '').trim())
    .filter(Boolean);
  const source = lines.length ? lines : [text.trim()].filter(Boolean);
  let truncated = source.length > LOOP_LIMITS.planItems;
  const items = source.slice(0, LOOP_LIMITS.planItems).map((line) => {
    if (line.length <= LOOP_LIMITS.planItemChars) return line;
    truncated = true;
    return `${line.slice(0, LOOP_LIMITS.planItemChars - 1)}…`;
  });
  return { items, truncated };
}
