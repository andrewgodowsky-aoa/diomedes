import type { Mode } from '../../shared/types';
import { NECTOVIA_ROUTE } from '../../shared/model-api';

/**
 * Why a worker is grayed in the Agent menu on Nectovia, or null when it is not.
 *
 * A thread send to Nectovia refuses Build and Fix (server/engines/nectovia.ts
 * NECTOVIA_WORK_REFUSED): the Nectovia Agent answers in the conversation. A worker whose
 * leading mode is one of those would read as pickable and then be refused, so the menu grays it
 * with one plain reason. The leading mode is the first one the worker lists, the job it is for:
 * Change Builder leads with Build and Problem Debugger with Fix. A worker that also answers
 * questions but leads with something else stays pickable.
 *
 * Display only. It decides nothing about what a worker may do; capability facts and Trust do that.
 */
export function nectoviaAgentGap(agent: { modes: readonly Mode[] }, route: string): string | null {
  if (route !== NECTOVIA_ROUTE) return null;
  const leading = agent.modes[0];
  if (leading === 'build') return "Build isn't on Nectovia yet.";
  if (leading === 'fix') return "Fix isn't on Nectovia yet.";
  return null;
}
