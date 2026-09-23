/**
 * What an Ask or Plan turn may read from the project, chosen per turn by the person.
 *
 * `selected` (the default) is exactly what the send dialog lists: the instruction and the
 * documents the person chose, sent inline. No file tool can read anything else.
 * `project` is the explicit per-turn choice to let the engine look through the project folder
 * for that one message: list it, and read any file the project's Cloud sharing list lets that
 * route receive. It is never saved, never inferred from a setting, a model or an earlier turn,
 * and it is only offered on a route whose file reads Diomedes answers before they run (see
 * `server/engines/turn-scope.ts`).
 */
import type { Route } from './types.js';

export type ReadAccess = 'selected' | 'project';

export const READ_ACCESS: readonly ReadAccess[] = ['selected', 'project'];

/**
 * The routes on which a whole-project read is enforced before each read runs. Claude Code
 * asks the host over its permission-prompt channel for every read outside its own empty
 * working folder, and the host resolves the path before answering. Other routes have no
 * such channel that Diomedes has verified, so they read only the selected documents.
 */
export const WHOLE_PROJECT_READ_ROUTES: readonly Route[] = ['claude-code'];

export const wholeProjectReadAvailable = (route: unknown): boolean =>
  typeof route === 'string' && (WHOLE_PROJECT_READ_ROUTES as readonly string[]).includes(route);

/** The one sentence the send dialog shows about project files for this turn. */
export function readAccessSentence(
  engine: string,
  sources: readonly string[],
  access: ReadAccess,
): string {
  const included = sources.length
    ? `Documents included: ${sources.join(', ')}.`
    : 'No project documents are included.';
  return access === 'project'
    ? `${included} For this message ${engine} may also list the project folder and read any other file this project shares with it.`
    : included;
}

/** The label of the per-message choice itself. */
export const readAccessLabel = (engine: string) =>
  `Let ${engine} look through the project folder for this message`;
