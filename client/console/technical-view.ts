import { isPackActive, SOFTWARE_ENGINEERING_PACK } from '../../shared/capability-packs';
import type { Project } from '../../shared/types';

/**
 * Whether a project shows the technical view: each tool call's name and detail, the work's full
 * log, the whole diff of a change and the project's folder. It comes with the Software
 * Engineering Capability Pack while that pack is on for the project. Everyone else gets the
 * plain view a business owner reads. There is no detail level to choose any more (Andrew,
 * 2026-10-08; QUESTIONS.md R17), and a pack composes this view rather than granting anything
 * (AGENTS.md decision 14).
 */
export function technicalView(project: Pick<Project, 'packs'> | null | undefined): boolean {
  return isPackActive(project?.packs, SOFTWARE_ENGINEERING_PACK.id);
}

/** For a screen that belongs to no one project: the technical view while the pack is on for any. */
export function technicalAnywhere(projects: readonly Pick<Project, 'packs'>[]): boolean {
  return projects.some(technicalView);
}
