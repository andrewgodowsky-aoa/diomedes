/**
 * What this computer does with a phone's frames, and what it sends back (relay plan steps 3 and 4).
 * One handler per link: one person's registration of this computer for one business.
 *
 * Authority is the person signed in on this computer. A phone's frame carries the hub's `from`
 * stamp; a command from anyone else is refused `not_signed_in_person`. Each command then goes
 * through the desktop's own path for it and nothing else: a decision through the Need answer path
 * (never `allowForTask`), a Stop through Work control, a message through the conversation or the
 * Team mailbox, a wake through the Team wake path. Each is checked again when it acts, exactly as
 * the desktop's own route checks it, and acts at most once per command id (commands.ts).
 *
 * The payer switch, settings, routes, Trust, access profiles, files and the shell are never
 * relayed: no frame names them, and nothing here reaches the loopback API or any other endpoint.
 * A phone reaches only projects of this link's business.
 */
import { PHONE_RELAY_FEATURE, PHONE_RELAY_NOT_INCLUDED_REASON } from '../../shared/access.js';
import type { ConversationMode } from '../interaction-turn.js';
import type { Change, Conversation, MailboxMessage, Need, Session, Task, TeamMember } from '../../shared/types.js';
import type { WorkRowsSource } from '../../shared/work-rows.js';
import {
  RELAY_MESSAGE_TIMINGS,
  parseDesktopToPhone,
  type ConversationRef,
  type NeedDecision,
  type RelayedPhoneMessage,
  type ResultMessage,
  type StopTarget,
} from '../../services/control-plane/src/relay/protocol.js';
import { unreadForSlot } from '../team/mailbox.js';
import { ApiError } from '../paths.js';
import type { CommandLedger } from './commands.js';
import { boardPages, needSummary, resultFrame, turnUpdates, workRowsFrame } from './frames.js';
import { OutboundGate } from './outbound.js';
import { payerOf, sessionRoute } from './work-rows.js';
import { routeDisplayName } from '../../shared/engines.js';

/** What the handlers read of a project. */
export interface RelayProjectState {
  tasks: readonly Task[];
  sessions: readonly Session[];
  needs: readonly Need[];
  changes: readonly Change[];
  conversations: readonly Conversation[];
  team?: { members: readonly TeamMember[]; messages: readonly MailboxMessage[] } | null;
}

/** A turn a phone's message started, as the desktop's conversation answered it. */
export interface RelayTurnResult {
  answerText: string | null;
  interrupted: boolean;
}

/**
 * The desktop's own paths, as the relay reaches them (ports.ts builds these from the app). Each
 * acting port is the path the desktop's own route takes, under the same lock and checks.
 */
export interface PhoneRelayPorts {
  /** The person signed in on this computer now, or null. */
  personId(): string | null;
  /** Whether the business's current plan includes `feature`. */
  includes(organizationId: string, feature: string): boolean;
  /** The business a project's work belongs to, as the Agent gate resolves it. Null: the home conversation. */
  organizationFor(projectId: string | null): string | null;
  projectIds(): string[];
  /** The reserved home project, when one exists. */
  homeProjectId(): string | null;
  state(projectId: string): RelayProjectState;
  workRows: WorkRowsSource;
  /** Calls back with a project id whenever its records change; answers the unsubscribe. */
  onChange(listener: (projectId: string) => void): () => void;
  /** Calls back when a conversation turn starts generating; answers the unsubscribe. */
  onTurnStarted(listener: (event: { projectId: string; threadId: string; requestId: string }) => void): () => void;
  /** Runs something that changes the desktop's records, as a desktop request does. Refused while an accepted update closes the app. */
  mutation<T>(action: () => Promise<T>): Promise<T>;
  /** Answers an open Need through the Need answer path, and records that the answer came from the phone. */
  decide(input: { projectId: string; needId: string; decision: NeedDecision; commandId: string; personId: string }): Promise<'decided' | 'already-answered'>;
  /** Stops a task's work, or one run of it, through Work control. */
  stop(projectId: string, target: StopTarget): Promise<void>;
  /** The home conversation's thread, or a project's own Nectovia conversation, made once if it isn't there. */
  thread(conversation: Exclude<ConversationRef, { kind: 'member' }>): Promise<{ projectId: string; threadId: string; mode: ConversationMode }>;
  /** Whether a message on this thread would stop at the job cap's question first. */
  messageWarns(projectId: string, threadId: string, text: string, mode: ConversationMode): Promise<boolean>;
  /** Sends a message as if typed on this computer. `done` settles once the phone no longer follows it. */
  message(input: { projectId: string; threadId: string; commandId: string; text: string; mode: ConversationMode }, done: Promise<void>): Promise<RelayTurnResult>;
  /** Puts a message in a Team member's mailbox, as the owner. */
  memberMessage(projectId: string, slotId: string, text: string): Promise<void>;
  /** Whether waking this member would stop at the job cap's question first. */
  wakeWarns(projectId: string, slotId: string): Promise<boolean>;
  /** Wakes a Team member on its recorded route. */
  wake(projectId: string, slotId: string): Promise<void>;
}

/** The refusals a desktop answers with, each with the one sentence the phone shows. */
export const DESKTOP_REFUSALS = {
  not_signed_in_person: 'Someone else is signed in on this computer now.',
  phone_relay_not_included: PHONE_RELAY_NOT_INCLUDED_REASON,
  not_this_business: "That isn't part of this business on this computer.",
  need_not_found: "That request isn't on this computer anymore.",
  task_not_found: "That task isn't on this computer anymore.",
  run_not_found: "That run isn't on this computer anymore.",
  member_not_found: "That Team member isn't on this computer anymore.",
  conversation_not_found: "That conversation isn't on this computer anymore.",
  nothing_waiting: 'Nothing is waiting for this Team member.',
  names_documents: 'Waking this Team member would hand it documents. Do that on your computer.',
  cap_question: "This would go past the job's cap. Decide that on your computer.",
  updating: 'Nectovia on your computer is closing for an update. Try again once it restarts.',
} as const;
export type DesktopRefusal = keyof typeof DESKTOP_REFUSALS;

/** What the phone reads when a decision arrives for a Need already answered. */
export const ALREADY_ANSWERED = 'Already answered on your computer';
const EXPIRED = 'This request is too old to answer from your phone. Open it again or answer on your computer.';
const COULD_NOT = "Your computer couldn't do this. Open Nectovia there to see why.";
const CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/** A refusal the relay raises itself, with its stable code. */
export class RelayRefusal extends Error {
  constructor(readonly code: DesktopRefusal) {
    super(DESKTOP_REFUSALS[code]);
  }
}

const sentenceFor = (code: string): string => (DESKTOP_REFUSALS as Record<string, string>)[code] ?? COULD_NOT;

/**
 * A code for an error from the desktop's own path: the path's own code when it names one (an
 * engine's code in lower case), else what a 404 means for this command. Never the error's message,
 * which may name a file; the phone reads one of this file's sentences instead.
 */
function errorCode(error: unknown, notFound: DesktopRefusal): { code: string; message: string } {
  if (error instanceof RelayRefusal) return { code: error.code, message: error.message };
  const named = error instanceof ApiError ? error.details.code : (error as { code?: unknown } | null)?.code;
  const raw = typeof named === 'string' ? (error instanceof ApiError ? named : named.toLowerCase()) : null;
  if (raw === 'unknown_run' || (raw === null && error instanceof ApiError && error.status === 404)) return { code: notFound, message: sentenceFor(notFound) };
  if (raw && CODE.test(raw)) return { code: raw, message: sentenceFor(raw) };
  return { code: 'refused', message: COULD_NOT };
}

type Command = Extract<RelayedPhoneMessage, { commandId: string }>;
interface Outcome {
  result: ResultMessage;
  /** What follows the result, once it is sent: a turn's updates. */
  follow?: () => void;
}

export interface PhoneRelayMessagesOptions {
  organizationId: string;
  deviceId: string;
  /** Writes one frame on the link. False when no connection is ready. */
  send(text: string): boolean;
  ports: PhoneRelayPorts;
  commands: CommandLedger;
  now?: () => number;
  log?: (line: string) => void;
}

export class PhoneRelayMessages {
  private readonly gate: OutboundGate;
  private readonly ports: PhoneRelayPorts;
  private readonly now: () => number;
  /** When each summarized Need stops taking a phone's decision. Kept here, per Need, never trusted from the phone. */
  private readonly windows = new Map<string, { projectId: string; until: number }>();
  private readonly unsubscribe: (() => void)[] = [];
  private closed = false;

  constructor(private readonly options: PhoneRelayMessagesOptions) {
    this.ports = options.ports;
    this.now = options.now ?? Date.now;
    this.gate = new OutboundGate({ send: options.send, now: this.now, log: options.log });
    this.unsubscribe.push(
      this.ports.workRows.subscribe((projectId) => {
        if (this.gate.attending && this.inBusiness(projectId)) this.rows(projectId);
      }),
      this.ports.onChange((projectId) => {
        if (!this.gate.attending || !this.inBusiness(projectId)) return;
        this.board(projectId, 1);
        this.needs(projectId, false);
      }),
    );
  }

  /** A relayed phone frame. Never throws. */
  receive(message: RelayedPhoneMessage): void {
    void this.handle(message).catch((error: unknown) => {
      this.options.log?.(`Phone relay for ${this.options.deviceId}: ${message.type} failed (${errorCode(error, 'not_this_business').code}).`);
    });
  }

  /** Waits until everything due now has gone out. */
  settled(): Promise<void> {
    return this.gate.settled();
  }

  close(): void {
    this.closed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    this.gate.close();
  }

  private async handle(message: RelayedPhoneMessage): Promise<void> {
    if (this.closed || message.deviceId !== this.options.deviceId) return;
    if (!('commandId' in message)) {
      // `hello` and `board.page` answer nothing when the sender may not act here.
      if (this.refusal(message.from.personId)) return;
      this.gate.attend();
      if (message.type === 'hello') return this.hello();
      if (this.inBusiness(message.projectId)) this.board(message.projectId, message.page);
      return;
    }
    const after: { follow?: () => void } = {};
    const { result, repeat } = await this.options.commands.once(this.options.deviceId, message.commandId, async () => {
      const outcome = await this.command(message).catch((error: unknown): Outcome => this.refused(message, error));
      after.follow = outcome.follow;
      return outcome.result;
    });
    if (this.closed) return;
    this.gate.answer(result);
    this.options.log?.(`Phone relay for ${this.options.deviceId}: ${message.type} ${result.outcome}${result.code ? ` ${result.code}` : ''}${repeat ? ' (repeat)' : ''}.`);
    if (!repeat) after.follow?.();
  }

  /** Why the sender may not act here now, or null. */
  private refusal(personId: string): DesktopRefusal | null {
    const signedIn = this.ports.personId();
    if (!signedIn || signedIn !== personId) return 'not_signed_in_person';
    if (!this.ports.includes(this.options.organizationId, PHONE_RELAY_FEATURE)) return 'phone_relay_not_included';
    return null;
  }

  private async command(message: Command): Promise<Outcome> {
    const refusal = this.refusal(message.from.personId);
    if (refusal) throw new RelayRefusal(refusal);
    this.gate.attend();
    switch (message.type) {
      case 'need.decision':
        return this.decide(message);
      case 'stop.request':
        return this.stop(message);
      case 'message.send':
        return this.send(message);
      case 'member.wake':
        return this.wake(message);
    }
  }

  private accepted(message: Command): Outcome {
    return { result: resultFrame(message.commandId, 'accepted') };
  }

  private refused(message: Command, error: unknown): Outcome {
    const notFound: DesktopRefusal =
      message.type === 'stop.request' ? (message.target.kind === 'run' ? 'run_not_found' : 'task_not_found')
        : message.type === 'need.decision' ? 'need_not_found'
          : message.type === 'member.wake' ? 'member_not_found'
            : 'conversation_not_found';
    const { code, message: sentence } = errorCode(error, notFound);
    const result = resultFrame(message.commandId, 'refused', code, sentence);
    // A result is never a frame the gate would drop: one outside the contract says only that it was refused.
    if (parseDesktopToPhone(JSON.stringify(result))) return { result };
    return { result: resultFrame(message.commandId, 'refused', 'refused', COULD_NOT) };
  }

  /** The projects of this link's business, the home project left out. */
  private projects(): string[] {
    const home = this.ports.homeProjectId();
    return this.ports.projectIds().filter((projectId) => projectId !== home && this.inBusiness(projectId));
  }

  private inBusiness(projectId: string): boolean {
    return this.ports.projectIds().includes(projectId) && this.ports.organizationFor(projectId) === this.options.organizationId;
  }

  private requireBusiness(projectId: string) {
    if (!this.inBusiness(projectId)) throw new RelayRefusal('not_this_business');
  }

  // --- what a phone sees ------------------------------------------------------------------

  /** A phone said hello: the rows, the first Board page and every open Need of the business. */
  private hello() {
    for (const projectId of this.projects()) {
      this.rows(projectId);
      if (this.ports.state(projectId).tasks.some((task) => !task.deletedAt)) this.board(projectId, 1);
      this.needs(projectId, true);
    }
  }

  private rows(projectId: string) {
    this.gate.picture(`work.rows:${projectId}`, `work.rows:${projectId}`, async () => {
      if (!this.inBusiness(projectId)) return null;
      const snapshot = await this.ports.workRows.snapshot(projectId);
      return snapshot ? workRowsFrame(snapshot) : null;
    });
  }

  private board(projectId: string, page: number) {
    this.gate.picture(`board.counts:${projectId}:${page}`, `board.counts:${projectId}`, () => {
      if (!this.inBusiness(projectId)) return null;
      const state = this.ports.state(projectId);
      const pages = boardPages({
        projectId, tasks: state.tasks, sessions: state.sessions, needs: state.needs, changes: state.changes,
        at: new Date(this.now()).toISOString(),
        labelOf: (session) => {
          const member = session.slotId ? state.team?.members.find((item) => item.slotId === session.slotId) : undefined;
          return member?.name || routeDisplayName(sessionRoute(session)) || null;
        },
        payerOf: (session) => payerOf(session ? sessionRoute(session) : null),
      });
      return pages[Math.min(page, pages.length) - 1];
    });
  }

  /**
   * Summaries of a project's open Needs: every one on `hello`, otherwise only Needs not yet sent.
   * Each summary opens a ten-minute window for the phone's decision, from when it is sent.
   */
  private needs(projectId: string, all: boolean) {
    const state = this.ports.state(projectId);
    // A Need answered or gone since takes no decision from a phone.
    for (const [needId, window] of this.windows)
      if (window.projectId === projectId && !state.needs.some((need) => need.id === needId && need.state === 'open')) this.windows.delete(needId);
    for (const need of state.needs) {
      if (need.state !== 'open' || (!all && this.windows.has(need.id))) continue;
      const expiresAt = this.now() + RELAY_MESSAGE_TIMINGS.needDecisionMs;
      this.windows.set(need.id, { projectId, until: expiresAt });
      const task = state.tasks.find((item) => item.id === need.taskId);
      const parts = needSummary(need, projectId, task?.name ?? '', new Date(expiresAt).toISOString());
      for (const part of parts)
        this.gate.picture(`need.summary:${need.id}:${part.part}`, `need.summary:${projectId}`, () => {
          const current = this.inBusiness(projectId) ? this.ports.state(projectId).needs.find((item) => item.id === need.id) : undefined;
          return current?.state === 'open' ? part : null;
        });
    }
  }

  // --- commands --------------------------------------------------------------------------

  private async decide(message: Extract<Command, { type: 'need.decision' }>): Promise<Outcome> {
    const found = this.projects()
      .map((projectId) => ({ projectId, need: this.ports.state(projectId).needs.find((need) => need.id === message.needId) }))
      .find((item) => item.need);
    if (!found?.need) throw new RelayRefusal('need_not_found');
    if (found.need.state !== 'open') return { result: resultFrame(message.commandId, 'already-done', 'already_answered', ALREADY_ANSWERED) };
    const window = this.windows.get(found.need.id);
    if (!window || this.now() >= window.until) return { result: resultFrame(message.commandId, 'expired', 'expired', EXPIRED) };
    const outcome = await this.ports.mutation(() =>
      this.ports.decide({
        projectId: found.projectId, needId: found.need!.id, decision: message.decision, commandId: message.commandId, personId: message.from.personId,
      }),
    );
    if (outcome === 'already-answered') return { result: resultFrame(message.commandId, 'already-done', 'already_answered', ALREADY_ANSWERED) };
    this.windows.delete(found.need.id);
    return this.accepted(message);
  }

  private async stop(message: Extract<Command, { type: 'stop.request' }>): Promise<Outcome> {
    this.requireBusiness(message.projectId);
    await this.ports.mutation(() => this.ports.stop(message.projectId, message.target));
    return this.accepted(message);
  }

  private async wake(message: Extract<Command, { type: 'member.wake' }>): Promise<Outcome> {
    this.requireBusiness(message.projectId);
    const team = this.ports.state(message.projectId).team;
    if (!team?.members.some((member) => member.slotId === message.slotId)) throw new RelayRefusal('member_not_found');
    const waiting = unreadForSlot([...team.messages], message.slotId);
    if (waiting.length === 0) throw new RelayRefusal('nothing_waiting');
    // A wake hands the member its waiting mail; mail that names documents is decided on the computer.
    if (waiting.some((item) => (item.files?.length ?? 0) > 0)) throw new RelayRefusal('names_documents');
    if (await this.ports.wakeWarns(message.projectId, message.slotId)) throw new RelayRefusal('cap_question');
    await this.ports.mutation(() => this.ports.wake(message.projectId, message.slotId));
    return this.accepted(message);
  }

  /**
   * A message as if typed on this computer. To a Team member it goes in the mailbox. To Home or a
   * project's own conversation it is the conversation's next message: accepted once the turn
   * starts (or at once when the desktop already answered that command), then the answer follows
   * as `turn.update` frames. The answer is sent when the turn is saved, never as it streams: the
   * live stream carries a decision block and redactions that only the saved answer has settled.
   */
  private async send(message: Extract<Command, { type: 'message.send' }>): Promise<Outcome> {
    const { conversation } = message;
    if (conversation.kind === 'member') {
      const text = message.text;
      this.requireBusiness(conversation.projectId);
      if (!this.ports.state(conversation.projectId).team?.members.some((member) => member.slotId === conversation.slotId))
        throw new RelayRefusal('member_not_found');
      await this.ports.mutation(() => this.ports.memberMessage(conversation.projectId, conversation.slotId, text));
      return this.accepted(message);
    }
    if (conversation.kind === 'project') this.requireBusiness(conversation.projectId);
    else {
      // Home belongs to a business only once it exists and is linked to it; an unlinked home is Personal.
      const home = this.ports.homeProjectId();
      if (home === null || this.ports.organizationFor(home) !== this.options.organizationId) throw new RelayRefusal('not_this_business');
    }
    // The conversation's own route trims the text it is given; so does this path.
    const text = message.text.trim();
    const thread = await this.ports.mutation(() => this.ports.thread(conversation));
    if (await this.ports.messageWarns(thread.projectId, thread.threadId, text, thread.mode)) throw new RelayRefusal('cap_question');
    const commandId = `phone.${message.commandId}`;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const off = this.ports.onTurnStarted((event) => {
      if (event.requestId === commandId && event.projectId === thread.projectId && event.threadId === thread.threadId) started();
    });
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = this.ports
      .mutation(() => this.ports.message({ projectId: thread.projectId, threadId: thread.threadId, commandId, text, mode: thread.mode }, done))
      .finally(() => {
        off();
        release();
      });
    // Marked handled now; the stream below reads the outcome.
    finished.catch(() => {});
    await Promise.race([begun, finished]);
    return { result: resultFrame(message.commandId, 'accepted'), follow: () => void this.stream(conversation, message.commandId, finished) };
  }

  private async stream(conversation: ConversationRef, turnId: string, finished: Promise<RelayTurnResult>) {
    this.gate.answer(turnUpdates(conversation, turnId, 'running', '', 0)[0]);
    let frames: ReturnType<typeof turnUpdates>;
    try {
      const result = await finished;
      const status = result.interrupted ? 'stopped' : result.answerText === null ? 'failed' : 'done';
      frames = turnUpdates(conversation, turnId, status, result.answerText ?? '', 1);
    } catch {
      frames = turnUpdates(conversation, turnId, 'failed', '', 1);
    }
    for (const frame of frames) this.gate.answer(frame);
  }
}
