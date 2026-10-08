import { AGENT_CATALOG, AUTO_AGENT, runKindOf } from '../../shared/agents';
import { agentChoiceOf, type AgentPickView } from '../../shared/agent-choice';
import { AGENT_NAME } from '../../shared/agent-name';
import { isExternalEngine } from '../../shared/engines';
import { isModelApiRoute } from '../../shared/model-api';
import type { Conversation, Mode, Turn } from '../../shared/types';

/** A thread's Agent box as the Console shows it (DIO-292). `kind` is `auto` for Auto. */
export interface AgentChoiceView {
  id: string;
  name: string;
  kind: Mode;
}

/**
 * The box's choice. A built-in Agent's kind is the catalog's. An added Agent's is the kind the
 * thread stored when it was chosen, so its file isn't needed here.
 */
export function choiceView(thread: Pick<Conversation, 'mode' | 'requested'>): AgentChoiceView {
  const id = agentChoiceOf(thread);
  if (id === AUTO_AGENT) return { id, name: 'Auto', kind: 'auto' };
  const listed = AGENT_CATALOG.find((item) => item.id === id);
  return { id, name: listed?.name ?? id, kind: listed ? runKindOf(listed) : thread.mode };
}

const PLACEHOLDERS: Readonly<Record<string, string>> = {
  'diomedes.researcher': 'Ask a question',
  'diomedes.architect': 'What should the plan cover?',
  'diomedes.builder': 'What should change?',
  'diomedes.debugger': "What's broken?",
  'diomedes.reviewer': 'What should be checked?',
  'diomedes.explorer': 'What are you looking for?',
  'diomedes.analyst': 'What numbers do you need?',
  'diomedes.writer': 'What should be written?',
};
/** What the box asks for, by Agent. */
export function placeholderFor(choice: AgentChoiceView): string {
  if (choice.id === AUTO_AGENT) return `Ask ${AGENT_NAME}, or hand it something to do`;
  return PLACEHOLDERS[choice.id] ?? `Message ${choice.name}`;
}

/** A reply's line for who answered it. */
export function agentCaption(agent: NonNullable<Turn['agent']>): string {
  return agent.picked ? `${agent.name}, picked by Auto` : agent.name;
}

/**
 * The Agent Auto picked for the thread's latest reply, or null when Auto answered it itself. A
 * note the app wrote in the thread isn't a reply, so it never hides the pick.
 */
export function lastPick(thread: Pick<Conversation, 'turns'>): string | null {
  const reply = [...thread.turns].reverse().find((turn) => turn.role === 'assistant');
  return reply?.agent?.picked ? reply.agent.name : null;
}

/**
 * Whether the person confirms before this message is sent: its documents go to an engine on this
 * computer that isn't Nectovia's own, to Codex for a change or under the owner's "confirm before
 * sending", or to a provider account for a change. The rule the thread view kept per mode, now
 * read from the pick.
 */
export function confirmFor(pick: Pick<AgentPickView, 'mode' | 'route'>, sending: boolean): boolean {
  const changes = pick.mode === 'build' || pick.mode === 'fix';
  return (
    isExternalEngine(pick.route) ||
    (pick.route === 'codex' && (changes || sending)) ||
    // A change sends the selected documents to the company's provider account.
    (isModelApiRoute(pick.route) && changes)
  );
}
