import type { Project } from '../../shared/types';
import { projectProgress } from './progress-bars';
import type { SegmentInput } from './segment-bar-model';

/**
 * The agent home's progress report, as plain sentences (Home.dc.html, contract
 * A9). Every figure is one a project's own status record already keeps: its
 * open needs, its running work and its task tally. Nothing here guesses at a
 * time, a cause or a result the records do not hold, and nothing is technical.
 * Pure: the clock and the locale come in as arguments, so it is tested
 * directly (tests/home-brief.test.ts).
 */

export type BriefState = 'attn' | 'live' | 'done';

export interface BriefRow {
  projectId: string;
  state: BriefState;
  /** The instrument label: Needs you, Working or Done. */
  label: string;
  name: string;
  /** One plain sentence about the project, from its own counts. */
  sentence: string;
  /** The project's task tally as a bar, or null when it keeps none. */
  progress: SegmentInput | null;
}

export interface HomeBriefModel {
  /** Today's date and time, in the person's own locale. */
  date: string;
  greeting: string;
  /** The one accent phrase in the heading: what most needs saying. */
  accent: string;
  rows: BriefRow[];
  /** Rows left out to keep the report short. */
  more: number;
  /** Projects with nothing waiting, nothing running and nothing finished to report. */
  quiet: number;
}

/** The report stops at this many rows; the rail lists every project. */
export const BRIEF_ROWS = 5;

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** A small count as a word, the way a person says it; larger ones stay figures. */
export function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

const lower = (n: number) => (n < WORDS.length ? countWord(n).toLowerCase() : String(n));

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning.';
  if (hour >= 12 && hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

export function briefDate(now: Date, locale?: string): string {
  const day = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const time = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

function rowFor(project: Project): BriefRow | null {
  const status = project.status;
  if (!status) return null;
  const progress = projectProgress(project);
  const base = { projectId: project.id, name: project.name, progress };
  if (status.needsYou > 0)
    return {
      ...base,
      state: 'attn',
      label: 'Needs you',
      sentence: `${countWord(status.needsYou)} ${status.needsYou === 1 ? 'thing is' : 'things are'} waiting on you.`,
    };
  if (status.working > 0)
    return {
      ...base,
      state: 'live',
      label: 'Working',
      sentence: `${countWord(status.working)} ${status.working === 1 ? 'run is' : 'runs are'} working now.`,
    };
  if (status.tasksTotal > 0 && status.tasksDone === status.tasksTotal)
    return {
      ...base,
      state: 'done',
      label: 'Done',
      sentence:
        status.tasksTotal === 1
          ? 'Its one task is done.'
          : `All ${lower(status.tasksTotal)} tasks are done.`,
    };
  return null;
}

const ORDER: Record<BriefState, number> = { attn: 0, live: 1, done: 2 };

export function homeBrief(
  projects: readonly Project[],
  now: Date,
  locale?: string,
): HomeBriefModel {
  const present = projects.filter((project) => !project.missing);
  const all = present
    .map((project) => ({ project, row: rowFor(project) }))
    .filter((item): item is { project: Project; row: BriefRow } => item.row !== null)
    .sort(
      (a, b) =>
        ORDER[a.row.state] - ORDER[b.row.state] ||
        // Within a state, the project with more waiting or running leads, then the one opened last.
        (b.project.status.needsYou + b.project.status.working) -
          (a.project.status.needsYou + a.project.status.working) ||
        b.project.lastOpenedAt.localeCompare(a.project.lastOpenedAt),
    )
    .map((item) => item.row);
  const needs = present.reduce((sum, project) => sum + (project.status?.needsYou ?? 0), 0);
  const running = present.reduce((sum, project) => sum + (project.status?.working ?? 0), 0);
  const counted = present.filter((project) => (project.status?.tasksTotal ?? 0) > 0);
  const allDone =
    counted.length > 0 &&
    counted.every((project) => project.status.tasksDone === project.status.tasksTotal);
  const accent =
    needs > 0
      ? `${countWord(needs)} ${needs === 1 ? 'thing needs' : 'things need'} you.`
      : running > 0
        ? `${countWord(running)} ${running === 1 ? 'run is' : 'runs are'} working.`
        : allDone
          ? 'Every task on your lists is done.'
          : 'Nothing is waiting on you.';
  return {
    date: briefDate(now, locale),
    greeting: greetingFor(now.getHours()),
    accent,
    rows: all.slice(0, BRIEF_ROWS),
    more: Math.max(0, all.length - BRIEF_ROWS),
    quiet: present.length - all.length,
  };
}

/** The closing line for the projects the rows leave out, or null when there are none. */
export function quietLine(model: Pick<HomeBriefModel, 'more' | 'quiet'>): string | null {
  const parts: string[] = [];
  if (model.more > 0)
    parts.push(
      `${countWord(model.more)} more ${model.more === 1 ? 'project has' : 'projects have'} something to report.`,
    );
  if (model.quiet > 0)
    parts.push(
      `${countWord(model.quiet)} ${model.more > 0 ? 'other ' : ''}${model.quiet === 1 ? 'project is' : 'projects are'} quiet.`,
    );
  return parts.length ? parts.join(' ') : null;
}
