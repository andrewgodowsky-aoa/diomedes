import type { Project, ProjectState, Task } from '../../shared/types';
import { projectActivity, WEEK_WINDOW_MS, type ActivityRow } from './activity';

/**
 * The Nectovia home's rail and its suggestions (round 2 reskin, slice 2, decisions 2, 3 and 4,
 * option A each). Pure: no React, no DOM, the clock a parameter (tests/home-rail.test.ts).
 *
 * Rail rows are jobs. One standing conversation per scope answers the ask box; when a request
 * becomes work its job shows here, and a plain question gets no row. The groups follow the scope:
 *
 * - One project's scope: Needs your input, Working and Finished, by name, from `projectActivity`,
 *   Finished over the week.
 * - All projects, with more than one project: only what the records hold across projects. Needs
 *   your input lists each project's newest waiting items by name, tagged with the project. Working
 *   is one row per project with its count, because no record names working jobs across projects.
 *   Finished is not drawn, because no record of it exists across projects.
 * - All projects, with one project: all projects is that project, so its jobs show by name.
 *
 * A group with no rows is not drawn.
 */

export type RailGroupId = 'needs' | 'working' | 'finished';

/** Where a row opens: a job's thread or its card, or a project. */
export interface RailTarget {
  projectId: string;
  taskId?: string;
  needId?: string;
}

export interface RailRow {
  id: string;
  name: string;
  sub: string;
  tone?: 'attn' | 'live' | 'fail';
  target: RailTarget;
}

export interface RailGroup {
  id: RailGroupId;
  heading: string;
  /** How many the records count, which can be more than the rows drawn. */
  count: number;
  rows: RailRow[];
}

export const GROUP_HEADINGS: Record<RailGroupId, string> = {
  needs: 'Needs you',
  working: 'Working',
  finished: 'Finished',
};

/** The scope control is drawn only when the business has more than one project. */
export const showsScope = (projects: readonly Project[]): boolean => projects.length > 1;

/**
 * The project whose records the rail reads, or null when it reads the projects' status records.
 * All projects with one project reads that project.
 */
export function railProject(projects: readonly Project[], scopeId: string | null): string | null {
  if (scopeId !== null) return projects.some((p) => p.id === scopeId) ? scopeId : null;
  return projects.length === 1 ? projects[0].id : null;
}

const needIdOf = (row: ActivityRow): string | undefined =>
  row.id.startsWith('need:') ? row.id.slice('need:'.length) : undefined;

function rowOf(row: ActivityRow, projectId: string, tone: RailRow['tone']): RailRow {
  const needId = needIdOf(row);
  return {
    id: row.id,
    name: row.label,
    sub: row.detail,
    ...(row.tone === 'fail' ? { tone: 'fail' as const } : tone ? { tone } : {}),
    target: {
      projectId,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(needId ? { needId } : {}),
    },
  };
}

const group = (id: RailGroupId, rows: RailRow[], count = rows.length): RailGroup => ({
  id,
  heading: GROUP_HEADINGS[id],
  count,
  rows,
});

/** One project's jobs, by name. */
export function projectGroups(state: ProjectState, now: number): RailGroup[] {
  const projectId = state.project.id;
  const activity = projectActivity(state, now, [], { windowMs: WEEK_WINDOW_MS });
  return [
    group('needs', activity.needsYou.map((row) => rowOf(row, projectId, 'attn'))),
    group('working', activity.working.map((row) => rowOf(row, projectId, 'live'))),
    group('finished', activity.finishedRecently.map((row) => rowOf(row, projectId, undefined))),
  ].filter((item) => item.rows.length > 0);
}

/** Across projects, from each project's status record only. */
export function allProjectGroups(projects: readonly Project[]): RailGroup[] {
  const needs: RailRow[] = [];
  const working: RailRow[] = [];
  let needsCount = 0;
  let workingCount = 0;
  for (const project of projects) {
    const status = project.status;
    if (!status) continue;
    needsCount += status.needsYou;
    for (const item of status.waiting ?? [])
      needs.push({
        id: `${project.id}:${item.id}`,
        name: item.label,
        sub: `${item.detail} · ${project.name}`,
        tone: item.kind === 'failed' ? 'fail' : 'attn',
        target: {
          projectId: project.id,
          ...(item.taskId ? { taskId: item.taskId } : {}),
          ...(item.needId ? { needId: item.needId } : {}),
        },
      });
    if (status.working > 0) {
      workingCount += status.working;
      working.push({
        id: `${project.id}:working`,
        name: project.name,
        sub: `${status.working} working`,
        tone: 'live',
        target: { projectId: project.id },
      });
    }
  }
  return [group('needs', needs, Math.max(needsCount, needs.length)), group('working', working, workingCount)].filter(
    (item) => item.rows.length > 0,
  );
}

/**
 * The rail's groups for a scope. `state` is the records of `railProject(projects, scopeId)`, or
 * null while they are being read or when the rail reads status records.
 */
export function railGroups(input: {
  projects: readonly Project[];
  scopeId: string | null;
  state: ProjectState | null;
  now: number;
}): RailGroup[] {
  const reads = railProject(input.projects, input.scopeId);
  if (reads === null) return input.scopeId === null ? allProjectGroups(input.projects) : [];
  if (!input.state || input.state.project.id !== reads) return [];
  return projectGroups(input.state, input.now);
}

// ---- Nectovia suggests -------------------------------------------------------

/** At most this many suggestions show; the rest wait their turn. */
export const SUGGESTION_LIMIT = 2;

export interface Suggestion {
  taskId: string;
  projectId: string;
  name: string;
  /** The first sentence of the task's description, or '' when it has none. */
  line: string;
  /** The workflow revision Accept names, so a stale card is refused rather than applied. */
  revision: number;
}

/** The first sentence of a description: up to the first full stop, question or exclamation mark. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 159).trimEnd()}…` : sentence;
}

/** A task a Nectovia run proposed that waits in the Inbox for a person's OK. */
export const isProposal = (task: Task): boolean =>
  !task.deletedAt && task.workflow?.inbox === true && task.origin !== undefined;

/**
 * "Nectovia suggests": the newest tasks a Nectovia run proposed, waiting in the Inbox. Nothing is
 * suggested unless a run proposed it, so with no proposal there is no section at all. `hidden`
 * holds the ids a person said Not now to on this computer.
 */
export function suggestions(
  state: ProjectState | null,
  hidden: ReadonlySet<string>,
  limit = SUGGESTION_LIMIT,
): Suggestion[] {
  if (!state) return [];
  return state.tasks
    .filter((task) => isProposal(task) && !hidden.has(task.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((task) => ({
      taskId: task.id,
      projectId: state.project.id,
      name: task.name,
      line: firstSentence(task.description),
      revision: task.workflow?.revision ?? 0,
    }));
}
