import type { Mode } from './types.js';

/**
 * Reasoning levels, weakest first. Every engine catalogue read so far uses this
 * ladder and offers a contiguous run of it: GPT-5.5 stops at 'xhigh', Astra
 * reaches 'ultra'. The order is what lets a ceiling mean anything.
 */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/**
 * The highest level a mode will run at, whatever was chosen for the thread.
 * Only Fix has a ceiling: a fix is meant to be the smallest change that makes
 * one named thing work, and a deeper budget invites the model to improve
 * things nobody asked about. Every other mode follows the person's choice.
 */
export const MODE_CEILING: Partial<Record<Mode, string>> = { fix: 'medium' };

/** Where a level sits on the ladder, or -1 when it is not one we know. */
export function effortRank(effort: string): number {
  return (EFFORT_ORDER as readonly string[]).indexOf(effort);
}

/**
 * The level a run actually uses: the thread's own choice when it has one,
 * otherwise the mode's default, then held to the mode's ceiling.
 *
 * A level that is not on the ladder cannot be shown to sit under a ceiling, so
 * the ceiling wins rather than the unknown value. That is the safe direction:
 * a ceiling exists to bound the run, and an unrecognised level is more likely a
 * new deeper rung than a new shallower one.
 */
export function effortFor(
  mode: Mode,
  chosen: string | null | undefined,
  fallback: string,
): string {
  const wanted = (chosen ?? '').trim() || fallback;
  const ceiling = MODE_CEILING[mode];
  if (!ceiling || wanted === ceiling) return wanted;
  const ceilingRank = effortRank(ceiling);
  if (ceilingRank === -1) return wanted;
  const wantedRank = effortRank(wanted);
  return wantedRank === -1 || wantedRank > ceilingRank ? ceiling : wanted;
}

/**
 * True when the ceiling would lower what was chosen for the thread. The person
 * is told rather than quietly given a weaker run than the one they picked.
 */
export function effortLowered(mode: Mode, chosen: string | null | undefined): boolean {
  const wanted = (chosen ?? '').trim();
  if (!wanted) return false;
  return effortFor(mode, wanted, wanted) !== wanted;
}
