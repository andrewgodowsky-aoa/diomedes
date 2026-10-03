/**
 * S1 manual hand-off (plan section 4.10, 2026-10-03): what one manual Team card hands the
 * next when the person passes work from one member to another by hand. The person writes it;
 * no model summarises anything. The next card's sources start as `changedFiles`, and starting
 * that card still asks for consent naming its engine and its documents: a start whose sources
 * leave out a file a hand-off names is refused until they include it (N05).
 *
 * Pure: the record, its caps and the strict validators. The server stamps `id`, `createdBy`
 * and `createdAt`, checks the tasks, slots and files against the project, and persists
 * (server/manual-teams.ts).
 */
import { z } from 'zod';

export interface ManualHandoff {
  id: string; fromTaskId: string; toTaskId: string; fromSlot: string; toSlot: string;
  outcome: string; changedFiles: string[]; checks: string[]; openIssues: string[];
  createdBy: 'you'; createdAt: string;
}

export const MANUAL_HANDOFF_CONTRACT_VERSION = 1 as const;

/**
 * Length caps. Eight files because the next card's sources start as `changedFiles` and a Work
 * start takes at most eight documents (server/native-work.ts).
 */
export const MANUAL_HANDOFF_LIMITS = Object.freeze({
  id: 100,
  outcome: 2000,
  changedFiles: 8,
  path: 400,
  checks: 10,
  openIssues: 10,
  line: 300,
  /** Hand-offs kept per project; the oldest stays and a new one past this is refused. */
  perProject: 500,
});

const identifier = z.string().trim().min(1).max(MANUAL_HANDOFF_LIMITS.id);
const line = z.string().trim().min(1).max(MANUAL_HANDOFF_LIMITS.line);
const file = z.string().trim().min(1).max(MANUAL_HANDOFF_LIMITS.path);

const fields = {
  fromTaskId: identifier,
  toTaskId: identifier,
  fromSlot: identifier,
  toSlot: identifier,
  outcome: z.string().trim().min(1).max(MANUAL_HANDOFF_LIMITS.outcome),
  changedFiles: z
    .array(file)
    .max(MANUAL_HANDOFF_LIMITS.changedFiles)
    .refine((list) => new Set(list.map((item) => item.toLowerCase())).size === list.length, {
      message: 'Name each changed file once.',
    }),
  checks: z.array(line).max(MANUAL_HANDOFF_LIMITS.checks),
  openIssues: z.array(line).max(MANUAL_HANDOFF_LIMITS.openIssues),
};

const differentCards = (value: { fromTaskId: string; toTaskId: string }) => value.fromTaskId !== value.toTaskId;

/** What the person sends. Anything else in the body is refused. */
export const manualHandoffRequestSchema = z
  .strictObject(fields)
  .refine(differentCards, { message: 'Hand off to a different card.' });
export type ManualHandoffRequest = z.infer<typeof manualHandoffRequestSchema>;

/** A stored record, exactly the interface above. */
export const manualHandoffSchema = z
  .strictObject({
    id: identifier,
    ...fields,
    createdBy: z.literal('you'),
    createdAt: z.iso.datetime(),
  })
  .refine(differentCards, { message: 'Hand off to a different card.' });

/** The plain reason a request is refused, from the validator's first issue. */
export function manualHandoffProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Check the hand-off and send it again.';
  const field = String(issue.path[0] ?? '');
  if (issue.code === 'unrecognized_keys') return 'Send only the hand-off fields.';
  if (issue.message === 'Hand off to a different card.' || issue.message === 'Name each changed file once.')
    return issue.message;
  if (field === 'outcome')
    return `Say what came of the work in up to ${MANUAL_HANDOFF_LIMITS.outcome.toLocaleString('en-US')} characters.`;
  if (field === 'changedFiles')
    return `Name up to ${MANUAL_HANDOFF_LIMITS.changedFiles} changed files from this project.`;
  if (field === 'checks') return `List up to ${MANUAL_HANDOFF_LIMITS.checks} checks of up to ${MANUAL_HANDOFF_LIMITS.line} characters each.`;
  if (field === 'openIssues')
    return `List up to ${MANUAL_HANDOFF_LIMITS.openIssues} open issues of up to ${MANUAL_HANDOFF_LIMITS.line} characters each.`;
  if (field === 'fromTaskId' || field === 'toTaskId') return 'Choose the card the work comes from and the card it goes to.';
  if (field === 'fromSlot' || field === 'toSlot') return 'Choose the member handing off and the member taking over.';
  return 'Check the hand-off and send it again.';
}

/** Hand-offs into this card, newest first. */
export function handoffsInto(records: readonly ManualHandoff[] | undefined, taskId: string): ManualHandoff[] {
  return (records ?? []).filter((item) => item.toTaskId === taskId).reverse();
}

/**
 * Every file a hand-off into this card names that `sources` leaves out, compared the way a
 * Work start compares names (case-insensitively). Empty when the sources cover them all.
 */
export function uncoveredHandoffFiles(
  records: readonly ManualHandoff[] | undefined,
  taskId: string,
  sources: readonly string[],
): string[] {
  const chosen = new Set(sources.map((source) => source.replaceAll('\\', '/').toLowerCase()));
  const missing: string[] = [];
  for (const record of records ?? [])
    if (record.toTaskId === taskId)
      for (const name of record.changedFiles)
        if (!chosen.has(name.toLowerCase()) && !missing.some((item) => item.toLowerCase() === name.toLowerCase()))
          missing.push(name);
  return missing;
}
