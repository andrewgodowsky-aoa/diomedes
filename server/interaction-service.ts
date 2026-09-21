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

/** The conversation run an admission comes from. */
export interface AdmissionSource {
  projectId: string;
  runId: string;
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
  /** A read. The receipts that exist under these derived command ids in this project. */
  receipts(
    projectId: string,
    ids: { taskCommandId: string; workCommandId: string },
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
    command: { commandId: string; taskId: string; instruction: string },
    source: AdmissionSource,
  ): Promise<{ sessionId: string }>;
}

export type { MessageResult };

const NARROW: Record<Restriction, number> = { 'answer-only': 0, 'plan-only': 1, automatic: 2 };
/** The narrower of what was recorded with the answer and what the Mode control says now. */
const narrower = (a: Restriction, b: Restriction) => (NARROW[a] <= NARROW[b] ? a : b);

const MOVED_ON =
  'This message did not finish before the conversation moved on. Send it again as a new message if you still want it.';

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
    if (located.settled) throw new ApiError(409, MOVED_ON, { code: 'conversation_settled' });
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

  /** A read. What happened to a message, from its phases and receipts. Nothing is written or started. */
  async outcome(projectId: string, threadId: string, commandId: string): Promise<MessageResult> {
    const located = await this.host.locate(projectId, threadId, commandId);
    if (!located) throw new ApiError(404, 'This message was not found.');
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
      interrupted: false,
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
    const receipts: Receipts = target
      ? await this.host.receipts(target, conversationCommandIds(message.sourceMessageId))
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
    const source: AdmissionSource = { projectId: message.projectId, runId: message.runId };
    const done = first.phases.some(
      (phase) => phase.phase === 'task-refused' || phase.phase === 'work-refused',
    );
    if (settled || done || first.verdict?.outcome !== 'escalate' || first.receipts.sessionId)
      return first.outcome;
    const verdict = first.verdict;
    const body = first.body!;
    const record = (phase: InteractionPhase['phase'], content: InteractionPhase['body']) =>
      driver.record(message.projectId, message.runId, [
        { phase, sourceMessageId: message.sourceMessageId, body: content },
      ]);
    // Everything a task or a Work command is made from comes out of the saved first phase, so
    // a retry from any route builds the same payload and reaches the receipt it already has.
    const instruction = body.text;
    const name = (body.decision.publicSummary.trim() || instruction).slice(0, 200);
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
    await record('work-input', {
      projectId: verdict.projectId,
      workCommandId: verdict.workCommandId,
      taskId,
    });
    try {
      const started = await this.host.startWork(
        verdict.projectId,
        { commandId: verdict.workCommandId, taskId, instruction },
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
