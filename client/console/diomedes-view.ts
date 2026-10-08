import type { ConversationMode, InteractionOutcome } from '../../shared/conversation';
import type { Conversation, Project } from '../../shared/types';
import { AGENT_CATALOG, AUTO_AGENT, AUTO_SUMMARY, listedAgents, runKindOf } from '../../shared/agents';
import { agentChoiceOf } from '../../shared/agent-choice';
import type { RailItem } from './Rail';
import { projectProgress } from './progress-bars';

/**
 * The Diomedes page's view-model: everything the page decides, read from
 * props and nothing else. No React, no CSS, no DOM, no clock of its own
 * (`now` is always a parameter). `Diomedes.tsx` calls these and renders what
 * they return; it makes no decision of its own that belongs here.
 *
 * Tested directly (`tests/diomedes-view.test.ts`), the way
 * `client/console/activity.ts` is tested by `tests/console-activity.test.ts`:
 * this repository has no jsdom, so a pure `.ts` module is what a Console
 * screen's logic can actually run under Node.
 */


/** One finished piece of work, read from records that already exist. Never invented. */
export interface DiomedesResult {
  id: string;
  title: string;
  projectName: string;
  when: string;
  state: 'done' | 'needs-you' | 'running' | 'failed';
}

/**
 * The spine id for the home conversation, which is not a project of its own.
 * It is a screen-only value and is never saved. The leading colon keeps it
 * outside the alphabet a saved project id may use (`PROJECT_ID` in
 * server/store.ts starts with a letter or a digit), so no project that loads,
 * not even one whose id is the word "all", can be mistaken for home.
 */
export const ALL_PROJECTS = ':all';

/** One Agent this page offers: its one plain line, and the kind of message it answers. */
export interface ConversationAgent {
  id: string;
  name: string;
  line: string;
  kind: ConversationMode;
}

/**
 * The Agent select, in order (DIO-292): Auto, then each built-in Agent that answers in the
 * conversation, in catalog order. An Agent that changes files is absent on purpose and must stay
 * absent: this page answers, looks things up and plans; it never applies a change unsupervised.
 */
export function conversationAgents(): ConversationAgent[] {
  return [
    { id: AUTO_AGENT, name: 'Auto', line: AUTO_SUMMARY, kind: 'auto' },
    ...listedAgents(AGENT_CATALOG).flatMap((item) => {
      const kind = runKindOf(item);
      return kind === 'ask' || kind === 'plan' ? [{ id: item.id, name: item.name, line: item.summary, kind }] : [];
    }),
  ];
}

/** A thread's Agent box as this page's control. An Agent this page doesn't offer reads as Auto. */
export function conversationAgentOf(thread: Pick<Conversation, 'mode' | 'requested'>): string {
  const id = agentChoiceOf(thread);
  return conversationAgents().some((item) => item.id === id) ? id : AUTO_AGENT;
}

/** The kind of message one of this page's Agents answers. Anything else answers as Auto. */
export function conversationKindOf(agentId: string): ConversationMode {
  return conversationAgents().find((item) => item.id === agentId)?.kind ?? 'auto';
}

/**
 * Whether an Agent can go in the conversation's box now (DIO-292). Another Agent's pick waits for
 * the conversation's first message. That wait dates from when a project's conversation that hadn't
 * spoken was found by its Automatic kind; its marker finds it now (DIO-299), so the wait is no
 * longer needed and can be relaxed later. Auto keeps the kind, and the home conversation is found
 * by its binding, so either can go in at once.
 */
export function canSaveAgent(
  scopeId: string | null,
  thread: Pick<Conversation, 'lineages'> | null,
  agent: string,
): boolean {
  return scopeId === null || agent === AUTO_AGENT || (thread?.lineages?.length ?? 0) > 0;
}

const parse = (iso: string): number | null => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** A short mono age for the spine's `time` column: minutes, hours, then days. */
function timeLabel(iso: string, now: number): string {
  const ms = parse(iso);
  if (ms === null) return '';
  const diff = Math.max(0, now - ms);
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * What one project is doing, read from its own status record and nothing
 * else: the same reading `client/console/Home.tsx` makes for the same
 * reason, kept local here because this module cannot import a `.tsx`.
 */
function projectSub(p: Project): { text: string; tone?: 'attn' | 'live' } {
  if (p.status?.needsYou) return { text: 'Needs you', tone: 'attn' };
  if (p.status?.working) {
    return { text: `Working on ${p.status.working} task${p.status.working === 1 ? '' : 's'}`, tone: 'live' };
  }
  if (p.status?.tasksTotal)
    return { text: `${p.status.tasksDone} of ${p.status.tasksTotal} ${p.status.tasksTotal === 1 ? 'task' : 'tasks'} done` };
  return { text: 'Ready to begin' };
}

/**
 * First row is always All projects, then projects most recently opened
 * first: the same ordering the thread rail keeps for threads, applied here
 * to projects. `now` makes the age column testable and keeps this function
 * from reading the clock itself.
 *
 * The home row says what it is, a conversation, and nothing about what that
 * conversation can reach. This function is never told whether the
 * conversation can run, so a line about reach would stay on the screen beside
 * a composer that has just said it cannot.
 */
export function spineItems(projects: readonly Project[], now: number): RailItem[] {
  const home: RailItem = {
    id: ALL_PROJECTS,
    name: 'All projects',
    time: '',
    sub: 'Your main conversation',
  };
  const rest = [...projects]
    .sort((a, b) => (b.lastOpenedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.createdAt))
    .map((p) => {
      const sub = projectSub(p);
      return {
        id: p.id,
        name: p.name,
        time: timeLabel(p.lastOpenedAt || p.createdAt, now),
        sub: sub.text,
        ...(sub.tone ? { tone: sub.tone } : {}),
        // The same task count the Projects list draws, from the same record.
        progress: projectProgress(p),
      };
    });
  return [home, ...rest];
}

/** null is "All projects": the reserved spine id. A scope id is itself otherwise. */
export function selectedSpineId(scopeId: string | null): string {
  return scopeId === null ? ALL_PROJECTS : scopeId;
}

/** The reserved spine id maps back to null; any other id is a project's own. */
export function scopeFromSpineId(id: string): string | null {
  return id === ALL_PROJECTS ? null : id;
}

/**
 * One mono line: the scope's name and the Agent's. An id that names no
 * project reads exactly as the null scope would, so a project removed out
 * from under an open conversation never leaves the line naming nothing at all.
 */
export function instrumentLine(
  scopeId: string | null,
  projects: readonly Project[],
  agent: string,
): string {
  const project = scopeId === null ? null : (projects.find((p) => p.id === scopeId) ?? null);
  const name = project ? project.name : 'All projects';
  return `${name} · ${agent}`;
}

/**
 * A turn's text as the paragraphs it was written in: split on a blank line,
 * trimmed, empties dropped. The same rule the thread view applies to the same
 * records, so a conversation reads identically on either screen.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Where the home's newest exchange starts: the person's last message, so the page shows that
 * message and everything after it under the ask box, with Earlier for the rest. A note Nectovia
 * wrote between the last answer and that message ("Nectovia started this conversation fresh...")
 * says how the newest exchange was answered, so it stays with it: a reply that follows another
 * reply, rather than a message, is a note. Zero when there is nothing earlier to fold.
 */
export function newestExchange(turns: readonly { role: string }[]): number {
  let start = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1)
    if (turns[index].role === 'you') {
      start = index;
      break;
    }
  if (start <= 0) return 0;
  while (start >= 2 && turns[start - 1].role !== 'you' && turns[start - 2].role !== 'you') start -= 1;
  return start;
}

/** False for empty or whitespace-only text, while pending, or when unavailable. */
export function canSend(text: string, pending: boolean, unavailable: string | null): boolean {
  return text.trim() !== '' && !pending && unavailable === null;
}

/**
 * Enter sends. Shift+Enter is left to the textarea's own default, so it
 * reads as a newline rather than a caller-built one. An IME composition
 * never sends: the Enter that closes a candidate window is not the Enter
 * that means "send this". Anything else is not this composer's business.
 */
export function keyIntent(
  e: { key: string; shiftKey: boolean; isComposing?: boolean },
): 'send' | 'newline' | null {
  if (e.key !== 'Enter' || e.isComposing) return null;
  return e.shiftKey ? 'newline' : 'send';
}

/**
 * Newest first, capped. This function does not sort: the caller already
 * hands results newest first, the way every other list in this app is
 * assembled from its own records rather than re-derived here. An empty
 * input is an empty output: there is no empty-state row, because the
 * ledger renders nothing at all when there is nothing to show.
 */
export function visibleResults(
  results: readonly DiomedesResult[],
  limit = 5,
): DiomedesResult[] {
  return results.slice(0, limit);
}


/**
 * Which thread is a project's Diomedes conversation is not this page's rule alone: the server
 * adopts the same thread when it provisions one. The rule lives in `shared/diomedes-thread`, and
 * this page reads it from there so the two can never choose differently.
 */
export { diomedesThread } from '../../shared/diomedes-thread';

/** What the page shows under the last answer. Null when the answer is all there is to show. */
export interface OutcomeCard {
  tone: 'offer' | 'live' | 'attn' | 'fail';
  title: string;
  body: string;
  /** `start` selects this proposal; `open` goes to the work that did start. */
  action: { kind: 'start'; label: string } | { kind: 'open'; label: string } | null;
}

const OPERATION: Record<'prepare_artifact' | 'write_internal', string> = {
  prepare_artifact: 'Nectovia will prepare this for you to review.',
  write_internal: 'Nectovia will propose the changes. Nothing is written until you say go ahead.',
};

/**
 * One outcome in plain words. Only `proposed` offers Start, and only `started` says anything
 * started: every other state says what did not happen, in the server's own sentence.
 */
export function outcomeCard(
  outcome: InteractionOutcome | null,
  projects: readonly Project[],
): OutcomeCard | null {
  if (!outcome || outcome.status === 'answered' || outcome.status === 'read') return null;
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? 'a project';
  if (outcome.status === 'proposed')
    return {
      tone: 'offer',
      title: `Nectovia can start this in ${nameOf(outcome.projectId)}`,
      body: `${outcome.summary} ${OPERATION[outcome.operationClass]}`.trim(),
      action: { kind: 'start', label: 'Start' },
    };
  if (outcome.status === 'started')
    return {
      tone: 'live',
      title: `Started in ${nameOf(outcome.projectId)}`,
      body: 'The work is running in that project, where you can follow and review it.',
      action: { kind: 'open', label: 'Open the work' },
    };
  if (outcome.status === 'unresolved')
    return { tone: 'attn', title: 'This did not finish', body: outcome.message, action: null };
  return {
    tone: outcome.reason === 'refused' ? 'fail' : 'attn',
    title: 'Nothing was started',
    body: outcome.message,
    action: null,
  };
}
