// One Diomedes conversation message from arrival to outcome. This is the executable sequence
// the contract describes, with no cycle in it: resolve under the host's lock, generate or
// read back with no lock held, project under the host's lock, then admit, where each
// admission takes its own fresh lock and every phase is written by the session driver.
//
// It is not a runtime, a scheduler, a permissions engine or a status store. It starts no work
// of its own: a task is created by the path a person's task takes and work starts by the path
// a person's Start takes, each under the command id derived for this message, so a retry
// reaches the existing receipt. What a person is told is read from phases and receipts.
import type { ClaudeSessionRuns, InteractionPhase } from './harness/claude-session-run.js';
import { HarnessError } from './harness/policy.js';
import type { TextRequest } from './engines/contract.js';
import { EngineError } from './engines/process.js';
import type { EngineService } from './engines/service.js';
import { ApiError } from './paths.js';
import type { MessageResult } from '../shared/conversation.js';
import type { InteractionDecision } from '../shared/interaction.js';
import {
  admitInteraction,
  conversationCommandIds,
  type ActionSelection,
  type Restriction,
} from './interaction-admission.js';
import {
  decisionOf,
  outcomeOf,
  selectionOf,
  splitDecision,
  type ConversationMode,
  type DecisionPhaseBody,
  type InteractionOutcome,
  type Receipts,
  type TurnAction,
} from './interaction-turn.js';

export interface MessageCommand {
  commandId: string;
  text: string;
  mode: ConversationMode;
  sources: { path: string; sha: string }[];
}
/** What one request lends the sequence: when to stop, and when the response has ended. */
export interface RequestContext {
  signal?: AbortSignal;
  whenDone?(end: () => void): void;
}
/** Why the current lineage could not take a new message. The guard that refused it names the reason. */
export type LineageRetirement = 'scope-change' | 'terminated' | 'budget';

/** One message, resolved by the host under its own lock before anything is generated. */
export interface ResolvedMessage {
  projectId: string;
  threadId: string;
  commandId: string;
  sourceMessageId: string;
  restriction: Restriction;
  /** The one run this message lives on. Progress, execution and projection all name it. */
  runId: string;
  action: TurnAction;
  /** True when this command was already answered: the record is read back and nothing is generated. */
  replay: boolean;
  input: TextRequest;
  /** What the person typed, for projection. The prompt may carry more than this. */
  text: string;
  mode: ConversationMode;
  /**
   * The Mode control as it stands now, which is what admission is held to. For a new message
   * it is the Mode the message was sent with. For a command read back later it is the thread's
   * current Mode: `restriction` stays what the command was bound to and is never widened by
   * this, only narrowed.
   */
  control: Restriction;
}
/** A command whose turn never finished on a lineage that has since been retired or settled. */
export interface UnfinishedElsewhere {
  unfinished: true;
  runId: string;
  sourceMessageId: string;
}
/** A message that was admitted earlier, found again without its body. */
export interface LocatedMessage {
  runId: string;
  sourceMessageId: string;
  answered: boolean;
  settled: boolean;
  /** From the conversation's Mode control as it stands now. */
  restriction: Restriction;
}

/**
 * The conversation run an admission comes from, and the saved intent its children are held
 * to. These are check inputs, not grants: each child admission re-reads what the conversation
 * says now and admits only what this exact saved proposal still allows.
 */
export interface AdmissionSource {
  projectId: string;
  threadId: string;
  runId: string;
  commandId: string;
  sourceMessageId: string;
  /** What the answered message was bound to. Intersected with the Mode control as it stands. */
  restriction: Restriction;
  /** The proposal this message recorded, read back from its own first phase. */
  decision: InteractionDecision;
  /** The person's saved choice of that exact proposal. */
  selection: ActionSelection;
  /** What the choice was pinned to: nothing else may be started under it. */
  proposalDigest: string;
  targetProjectId: string;
}

/**
 * What this message's children are made from, rebuilt from its own saved phases. A receipt
 * found under a derived command id is this message's child only when the command holds
 * exactly this, so an id bound to different work is a conflict rather than a start.
 */
export interface ChildIntent {
  task: { name: string; description: string };
  /** Null until the Work input phase pinned the task and the route it was resolved on. */
  work: { taskId: string; route: string; instruction: string } | null;
}

/** What the host supplies. Every method that touches the Store takes and releases its own lock. */
export interface InteractionHost {
  /**
   * Replay lookup first, through every lineage the thread ever had, then the restriction, the
   * lineage and the one run id. `replace` retires the current lineage and admits the next
   * generation in the same mutation. Never awaits a provider.
   */
  resolve(
    projectId: string,
    threadId: string,
    command: MessageCommand,
    options: RequestContext & { replace?: LineageRetirement },
  ): Promise<ResolvedMessage | UnfinishedElsewhere>;
  locate(projectId: string, threadId: string, commandId: string): Promise<LocatedMessage | null>;
  /** Idempotent transcript projection of a committed answer. */
  project(
    resolved: ResolvedMessage,
    result: { runId: string; text: string; model: string; version: string },
  ): Promise<void>;
  admissionContext(): Promise<{ homeProjectId: string | null; targetableProjectIds: string[] }>;
  /**
   * A read. The receipts that exist under these derived command ids in this project, and only
   * where the command holds what this message would submit. A command bound to different work
   * is refused here, through the same replay check a person's own task goes through, so no
   * other request's child is ever read back as this message's start.
   */
  receipts(
    projectId: string,
    ids: { taskCommandId: string; workCommandId: string },
    intent: ChildIntent | null,
  ): Promise<Receipts>;
  /**
   * Both admissions name the conversation run they come from. The host refuses, inside the
   * Store lock and before it admits anything, when that run is settled: a cancellation that
   * lands after the input phase was recorded still stops the admission it precedes.
   */
  createTask(
    projectId: string,
    command: { commandId: string; name: string; description: string },
    source: AdmissionSource,
  ): Promise<{ taskId: string }>;
  startWork(
    projectId: string,
    command: { commandId: string; taskId: string; instruction: string; route: string },
    source: AdmissionSource,
  ): Promise<{ sessionId: string }>;
  /**
   * The route the target project would start Work on. Read once and saved with the Work
   * input, so a retry builds the command this message already sent rather than one made
   * from a setting that has changed since.
   */
  workRoute(projectId: string): Promise<string>;
}

export type { MessageResult };

const NARROW: Record<Restriction, number> = { 'answer-only': 0, 'plan-only': 1, automatic: 2 };
/** The narrower of what was recorded with the answer and what the Mode control says now. */
export const narrower = (a: Restriction, b: Restriction) => (NARROW[a] <= NARROW[b] ? a : b);

const MOVED_ON =
  'This message did not finish before the conversation moved on. Send it again as a new message if you still want it.';

/**
 * The task this message proposes, from its first phase and nothing else. Admission submits
 * exactly this and a read compares exactly this, so a retry from any route reaches the same
 * receipt and a command holding anything else is not this message's child.
 */
const taskIntent = (body: DecisionPhaseBody) => ({
  name: (body.decision.publicSummary.trim() || body.text).slice(0, 200),
  description: body.text,
});

/** What the Work input phase pinned: the task it named and the route it was resolved on. */
const workInput = (phases: readonly InteractionPhase[]) =>
  phases.find((phase) => phase.phase === 'work-input')?.body as
    | { taskId?: unknown; route?: unknown }
    | undefined;

/** Which guard refused a new message, if it is one a fresh lineage answers. */
function retirement(error: unknown): LineageRetirement | null {
  if (error instanceof EngineError && error.code === 'SESSION_MISMATCH') return 'scope-change';
  if (error instanceof EngineError && error.code === 'RECONCILE_REQUIRED') return 'terminated';
  // The Runtime refuses with `blocked: budget exceeded`. The engine service hands every Runtime
  // refusal it does not name to its callers as RUNTIME_UNAVAILABLE with the Runtime's own words,
  // so that is the shape that arrives here. The turn was written and never sent.
  if (
    (error instanceof HarnessError && error.code === 'blocked') ||
    (error instanceof EngineError && error.code === 'RUNTIME_UNAVAILABLE')
  )
    return /^budget exceeded/.test(error.message) ? 'budget' : null;
  return null;
}

export class InteractionTurns {
  constructor(
    private readonly engines: Pick<EngineService, 'claudeSession' | 'nativeSessions'>,
    private readonly host: InteractionHost,
  ) {}

  private driver(): ClaudeSessionRuns {
    if (!this.engines.nativeSessions)
      throw new ApiError(503, 'The native conversation runtime is unavailable.');
    return this.engines.nativeSessions;
  }

  async message(
    projectId: string,
    threadId: string,
    command: MessageCommand,
    context: RequestContext = {},
  ): Promise<MessageResult> {
    this.driver();
    let resolved = await this.host.resolve(projectId, threadId, command, context);
    if ('unfinished' in resolved)
      return {
        runId: resolved.runId,
        commandId: command.commandId,
        sourceMessageId: resolved.sourceMessageId,
        answerText: null,
        interrupted: false,
        outcome: { status: 'unresolved', message: MOVED_ON },
      };
    let result;
    try {
      result = await this.engines.claudeSession(resolved.action, resolved.runId, resolved.input);
    } catch (error) {
      // A guard that refuses a NEW message is what triggers the next generation. It is never
      // bypassed, it never fires for a replay, and it is answered at most once per message.
      const reason = resolved.replay ? null : retirement(error);
      if (!reason) throw error;
      const next = await this.host.resolve(projectId, threadId, command, {
        ...context,
        replace: reason,
      });
      if ('unfinished' in next) throw error;
      resolved = next;
      result = await this.engines.claudeSession(resolved.action, resolved.runId, resolved.input);
    }
    if (result.response)
      await this.host.project(resolved, {
        runId: result.runId,
        text: result.answerText ?? result.response.text,
        model: result.response.model,
        version: result.response.version,
      });
    // The outcome is read from what was recorded and from nothing else. A decision that was
    // never saved is not rebuilt in memory: the message reads as unresolved on every route.
    const outcome = await this.settle({
      projectId,
      threadId,
      commandId: command.commandId,
      runId: resolved.runId,
      sourceMessageId: resolved.sourceMessageId,
      restriction: resolved.control,
    });
    return {
      runId: resolved.runId,
      commandId: command.commandId,
      sourceMessageId: resolved.sourceMessageId,
      answerText: result.response ? (result.answerText ?? result.response.text) : null,
      interrupted: result.interrupted,
      outcome,
    };
  }

  /**
   * The person chooses to start what was shown. The choice is bound to the message, to the
   * digest of the exact proposal and to its target, and is saved as a phase before anything
   * is admitted, so it cannot apply to another message, to reworded work or to another project.
   */
  async select(
    projectId: string,
    threadId: string,
    commandId: string,
    chosen: { proposalDigest: string; projectId: string },
  ): Promise<MessageResult> {
    const driver = this.driver();
    const located = await this.host.locate(projectId, threadId, commandId);
    if (!located?.answered) throw new ApiError(404, 'This message was not found.');
    const phases = await driver.phases(projectId, located.runId, located.sourceMessageId);
    const recorded = decisionOf(phases);
    if (!recorded || recorded.block !== 'parsed')
      throw new ApiError(409, 'There is no proposal on this message to start.', {
        code: 'no_proposal',
      });
    const selection: ActionSelection = {
      sourceMessageId: located.sourceMessageId,
      proposalDigest: chosen.proposalDigest,
      projectId: chosen.projectId,
    };
    const message = {
      projectId,
      runId: located.runId,
      sourceMessageId: located.sourceMessageId,
      restriction: located.restriction,
    };
    // The choice the person already made, and what it already started, is a record. Reading
    // it back needs the read they already have and nothing more, so a conversation that has
    // since been cancelled or narrowed still answers with its own receipt.
    const committed = await this.replayed(message, phases, selection, located.settled);
    if (committed)
      return {
        runId: located.runId,
        commandId,
        sourceMessageId: located.sourceMessageId,
        answerText: null,
        interrupted: false,
        outcome: committed,
      };
    if (located.settled) throw new ApiError(409, MOVED_ON, { code: 'conversation_settled' });
    const verdict = admitInteraction({
      decision: recorded.decision,
      restriction: narrower(recorded.restriction, located.restriction),
      conversationProjectId: projectId,
      ...(await this.host.admissionContext()),
      selection,
    });
    if (verdict.outcome !== 'escalate')
      throw new ApiError(409, 'That choice does not match what was proposed. Nothing was started.', {
        code: verdict.outcome === 'blocked' ? verdict.reason : 'not_startable',
      });
    await driver.record(projectId, located.runId, [
      { phase: 'action-selected', sourceMessageId: located.sourceMessageId, body: { ...selection } },
    ]);
    const outcome = await this.settle({
      projectId,
      threadId,
      commandId,
      runId: located.runId,
      sourceMessageId: located.sourceMessageId,
      restriction: located.restriction,
    });
    return {
      runId: located.runId,
      commandId,
      sourceMessageId: located.sourceMessageId,
      answerText: null,
      interrupted: false,
      outcome,
    };
  }

  /**
   * What an identical selection already settled, or null where there is still something to
   * admit. The saved choice must name this message, this proposal and this target; the
   * message must already hold its Work receipt or its final refusal, so nothing here applies
   * authority to a new effect. Nothing is written: a settled run is read and left alone.
   */
  private async replayed(
    message: { projectId: string; runId: string; sourceMessageId: string; restriction: Restriction },
    phases: readonly InteractionPhase[],
    selection: ActionSelection,
    settled: boolean,
  ): Promise<InteractionOutcome | null> {
    const saved = selectionOf(phases);
    if (
      !saved ||
      saved.sourceMessageId !== selection.sourceMessageId ||
      saved.proposalDigest !== selection.proposalDigest ||
      saved.projectId !== selection.projectId
    )
      return null;
    const refused = phases.some(
      (phase) => phase.phase === 'task-refused' || phase.phase === 'work-refused',
    );
    const read = await this.read(message, settled);
    return refused || read.receipts.sessionId ? read.outcome : null;
  }

  /** A read. What happened to a message, from its phases and receipts. Nothing is written or started. */
  async outcome(projectId: string, threadId: string, commandId: string): Promise<MessageResult> {
    const located = await this.host.locate(projectId, threadId, commandId);
    if (!located) throw new ApiError(404, 'This message was not found.');
    // Read from what the turn itself saved, not from the fact that its step succeeded: an
    // interruption the provider acknowledged succeeds with no answer, and a person polling
    // this message must be told that, not that nothing happened.
    const turn = await this.driver().turnResult(projectId, located.runId, commandId);
    const outcome = await this.read(
      {
        projectId,
        runId: located.runId,
        sourceMessageId: located.sourceMessageId,
        restriction: located.restriction,
      },
      located.settled,
    );
    return {
      runId: located.runId,
      commandId,
      sourceMessageId: located.sourceMessageId,
      answerText: null,
      interrupted: turn?.interrupted ?? false,
      outcome: outcome.outcome,
    };
  }

  private async read(
    message: { projectId: string; runId: string; sourceMessageId: string; restriction: Restriction },
    settled: boolean,
  ) {
    const phases = await this.driver().phases(
      message.projectId,
      message.runId,
      message.sourceMessageId,
    );
    const body = decisionOf(phases);
    const verdict = body
      ? admitInteraction({
          decision: body.decision,
          restriction: narrower(body.restriction, message.restriction),
          conversationProjectId: message.projectId,
          ...(await this.host.admissionContext()),
          selection: selectionOf(phases),
        })
      : null;
    // Where receipts are looked for: the project the saved task input names, else the
    // proposal's own target. A receipt there is authoritative with or without its phase.
    const began = phases.find((phase) => phase.phase === 'task-input')?.body as
      | { projectId?: string }
      | undefined;
    const target =
      began?.projectId ??
      (verdict && (verdict.outcome === 'proposed' || verdict.outcome === 'escalate')
        ? verdict.projectId
        : null);
    const pinned = workInput(phases);
    const receipts: Receipts = target
      ? await this.host.receipts(
          target,
          conversationCommandIds(message.sourceMessageId),
          body
            ? {
                task: taskIntent(body),
                work:
                  typeof pinned?.taskId === 'string' && typeof pinned.route === 'string'
                    ? { taskId: pinned.taskId, route: pinned.route, instruction: body.text }
                    : null,
              }
            : null,
        )
      : { projectId: null, taskId: null, sessionId: null };
    return { phases, body, verdict, receipts, outcome: outcomeOf(phases, receipts, verdict, { settled }) };
  }

  /**
   * Resumes from the highest phase present. Each input phase is saved before its admission,
   * and the driver refuses to save anything on a settled run, so a cancelled conversation can
   * never start work: the refusal to record comes first and the admission is never reached.
   */
  private async settle(
    message: {
      projectId: string;
      threadId: string;
      commandId: string;
      runId: string;
      sourceMessageId: string;
      restriction: Restriction;
    },
  ): Promise<InteractionOutcome> {
    const driver = this.driver();
    const located = await driver.locate(message.projectId, [message.runId], message.commandId);
    const settled = located?.settled ?? false;
    const first = await this.read(message, settled);
    const done = first.phases.some(
      (phase) => phase.phase === 'task-refused' || phase.phase === 'work-refused',
    );
    const chosen = selectionOf(first.phases);
    if (
      settled ||
      done ||
      !chosen ||
      first.verdict?.outcome !== 'escalate' ||
      first.receipts.sessionId
    )
      return first.outcome;
    const verdict = first.verdict;
    const body = first.body!;
    // What each child admission is held to. The saved restriction and the saved choice
    // travel with it; what the conversation says now is read where the child commits.
    const source: AdmissionSource = {
      projectId: message.projectId,
      threadId: message.threadId,
      runId: message.runId,
      commandId: message.commandId,
      sourceMessageId: message.sourceMessageId,
      restriction: body.restriction,
      decision: body.decision,
      selection: chosen,
      proposalDigest: verdict.proposalDigest,
      targetProjectId: verdict.projectId,
    };
    const record = (phase: InteractionPhase['phase'], content: InteractionPhase['body']) =>
      driver.record(message.projectId, message.runId, [
        { phase, sourceMessageId: message.sourceMessageId, body: content },
      ]);
    // Everything a task or a Work command is made from comes out of the saved first phase, so
    // a retry from any route builds the same payload and reaches the receipt it already has.
    const { name, description: instruction } = taskIntent(body);
    const refusal = (error: unknown) =>
      error instanceof ApiError && error.status >= 400 && error.status < 500
        ? { status: error.status, message: error.message }
        : null;
    await record('task-input', {
      projectId: verdict.projectId,
      taskCommandId: verdict.taskCommandId,
      name,
    });
    let taskId = first.receipts.taskId;
    if (!taskId)
      try {
        taskId = (
          await this.host.createTask(
            verdict.projectId,
            { commandId: verdict.taskCommandId, name, description: instruction },
            source,
          )
        ).taskId;
      } catch (error) {
        const refused = refusal(error);
        if (!refused) throw error;
        await record('task-refused', refused);
        return (await this.read(message, false)).outcome;
      }
    await record('task-receipt', { taskId });
    // The route is resolved once and saved here, so a retry after the target project's
    // engine changed sends the command this message already sent and reaches its receipt.
    const pinned = workInput(first.phases);
    const route =
      typeof pinned?.route === 'string'
        ? pinned.route
        : await this.host.workRoute(verdict.projectId);
    await record('work-input', {
      projectId: verdict.projectId,
      workCommandId: verdict.workCommandId,
      taskId,
      route,
    });
    try {
      const started = await this.host.startWork(
        verdict.projectId,
        { commandId: verdict.workCommandId, taskId, instruction, route },
        source,
      );
      await record('work-receipt', { sessionId: started.sessionId });
    } catch (error) {
      const refused = refusal(error);
      if (!refused) throw error;
      await record('work-refused', refused);
    }
    return (await this.read(message, false)).outcome;
  }
}
