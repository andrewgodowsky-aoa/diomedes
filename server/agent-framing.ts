import { AUTO_AGENT, DEFAULT_AGENT, type AgentDefinition } from '../shared/agents.js';
import type { Mode } from '../shared/types.js';

type Framed = Pick<AgentDefinition, 'id' | 'name' | 'role'>;
const OPEN = '[[diomedes agent=';

/**
 * Whether an Agent adds its own framing to a run of `mode` (DIO-292): every Agent but the kind's
 * default, whose job the kind's own instructions already are. On Auto's own lane every Agent
 * frames, since that lane's instructions are Auto's. Auto answering itself never frames.
 */
export function framesRun(agentId: string, mode: Mode): boolean {
  if (agentId === AUTO_AGENT) return false;
  return mode === 'auto' || DEFAULT_AGENT[mode] !== agentId;
}

/**
 * A conversation or direct message as an Agent sends it: its role first, marked as the host's,
 * then what the person typed. In the message, never in the lane's instructions: a lane's
 * instructions are part of its saved scope, so changing them per message would retire it.
 */
export function framedText(agent: Framed, mode: Mode, text: string): string {
  if (!framesRun(agent.id, mode)) return text;
  // One line, whatever an added Agent's name or role holds, so the marker always comes off whole.
  const line = (value: string) => value.replace(/\s+/g, ' ').trim();
  return `${OPEN}${line(agent.name.replace(/[[\]]/g, ''))}]] ${line(agent.role)}\n\n${text}`;
}

/** The message without the marker line `framedText` opened it with. */
export function withoutFraming(text: string): string {
  if (!text.startsWith(OPEN)) return text;
  const end = text.indexOf('\n\n');
  return end < 0 ? text : text.slice(end + 2);
}

/** The line a Build or Fix proposal prompt carries for a non-default Agent, or null. */
export function agentFraming(agent: Framed, mode: Mode): string | null {
  return framesRun(agent.id, mode) ? `${agent.name}: ${agent.role}` : null;
}
