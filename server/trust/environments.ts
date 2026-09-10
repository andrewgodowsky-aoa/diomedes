/**
 * The single source of isolated execution environments.
 *
 * There are none. Diomedes has no image, snapshot, container or virtual-machine
 * lifecycle, so there is nothing it could hand unrestricted authority to. This
 * module exists so that the Full access predicate reads a real list instead of
 * a constant `false`, and so that adding an environment later is one deliberate
 * change in one place with the prerequisite check already in force.
 *
 * It takes no settings, request fields or environment variables on purpose: a
 * preference must not be able to make Full access available.
 */
import type { IsolatedEnvironment } from '../../shared/capabilities.js';

export const NO_ENVIRONMENT_REASON =
  'This installation runs engines as the current user with no operating-system, process or virtual-machine boundary that Diomedes owns. A project folder or git worktree is edit isolation, not containment.';

export function listIsolatedEnvironments(): readonly IsolatedEnvironment[] {
  return [];
}

/** Chosen environment for a request. Always null while the list above is empty. */
export function selectedIsolatedEnvironment(id?: string | null): IsolatedEnvironment | null {
  if (!id) return null;
  return listIsolatedEnvironments().find((item) => item.id === id) ?? null;
}
