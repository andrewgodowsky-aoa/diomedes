import type { Mode } from '../../shared/types';
import { NECTOVIA_ROUTE } from '../../shared/model-api';

/**
 * Why an Agent is grayed in the Agent menu on Nectovia, or null when it is not.
 *
 * A thread send to Nectovia refuses Build and Fix runs (server/engines/nectovia.ts
 * NECTOVIA_WORK_REFUSED): the Nectovia Agent answers in the conversation. An Agent whose kind is
 * one of those (Builder, Fixer, Writer) would read as pickable and then be refused, so the menu
 * grays it with one plain reason by its own name. The kind is the first mode an Agent lists.
 *
 * Display only. It decides nothing about what an Agent may do; capability facts and Trust do that.
 */
export function nectoviaAgentGap(
  agent: { name: string; modes: readonly Mode[] },
  route: string,
): string | null {
  if (route !== NECTOVIA_ROUTE) return null;
  const kind = agent.modes[0];
  return kind === 'build' || kind === 'fix' ? `${agent.name} isn't on Nectovia yet.` : null;
}
