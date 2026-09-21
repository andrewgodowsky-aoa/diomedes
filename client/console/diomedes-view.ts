import type { Project } from '../../shared/types';
import type { RailItem } from './Rail';

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

export type Restriction = 'automatic' | 'answer-only' | 'plan-only';

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

/** The Mode select, in order. Build is absent on purpose and must stay absent:
 *  this page answers, looks things up and plans; it never applies a change
 *  unsupervised, and Build is a promise this screen does not make. */
export const RESTRICTIONS: readonly { id: Restriction; label: string }[] = [
  { id: 'automatic', label: 'Automatic' },
  { id: 'answer-only', label: 'Answer only' },
  { id: 'plan-only', label: 'Plan only' },
];

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
  if (p.status?.needsYou) return { text: 'Needs your OK', tone: 'attn' };
  if (p.status?.working) {
    return { text: `Working on ${p.status.working} task${p.status.working === 1 ? '' : 's'}`, tone: 'live' };
  }
  if (p.status?.tasksTotal) return { text: `${p.status.tasksDone} of ${p.status.tasksTotal} tasks done` };
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
 * One mono line: the scope's name and the restriction in words. An id that
 * names no project reads exactly as the null scope would, so a project
 * removed out from under an open conversation never leaves the line naming
 * nothing at all.
 */
export function instrumentLine(
  scopeId: string | null,
  projects: readonly Project[],
  restriction: Restriction,
): string {
  const project = scopeId === null ? null : (projects.find((p) => p.id === scopeId) ?? null);
  const name = project ? project.name : 'All projects';
  const label = RESTRICTIONS.find((r) => r.id === restriction)?.label ?? RESTRICTIONS[0].label;
  return `${name} · ${label}`;
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
