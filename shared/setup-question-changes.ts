/**
 * ORG-02: how a business's setup answers cross a change in the questions.
 *
 * The intake's questions carry a revision (`BUSINESS_SETUP_SCHEMA_REVISION`).
 * When a later build asks different questions, a setup saved under the
 * earlier ones is neither thrown away nor reinterpreted. Each revision
 * declares what changed from the one before it: questions added, questions
 * whose meaning or accepted answers changed, and questions no longer asked,
 * each with why, in words a person reads before they resume.
 *
 * Resuming carries every other answer across exactly as it was given: the same
 * value, words, person and time. The account service therefore sees it as
 * unchanged, and it stays in the name of whoever gave it (ORG-01's attribution
 * rule), even when someone else resumes. A changed question is asked again. A
 * removed question's answer is not carried; the business's earlier revision
 * keeps it, and nothing is deleted.
 *
 * The carry is an H21 migration: `server/migrations/registry.ts` builds the
 * `business-setup` family from this table, so a setup saved by a newer build
 * is refused and left as it was, never guessed at. A step changes only the
 * answers and the revision. The resume that runs it (`startSetup` in
 * `server/workspaces.ts`) sets the state, the cursor and the proposal from the
 * current questions, which is why nothing reads a carried record any other way.
 *
 * Pure and dependency-free.
 */
import {
  BUSINESS_SETUP_SCHEMA_REVISION,
  type SetupCarryView,
  type SetupQuestionNote,
} from './business-setup.js';

/** What changed between revision `from` of the questions and `from + 1`. */
export interface QuestionSetChange {
  /** The revision this change starts from. It leads to `from + 1`. */
  readonly from: number;
  /** New questions. They are asked; nothing is carried into them. */
  readonly added: readonly SetupQuestionNote[];
  /** Questions whose meaning or accepted answers changed. Their answers are not carried; they are asked again. */
  readonly changed: readonly SetupQuestionNote[];
  /** Questions no longer asked. Their answers stay in the revision they were given in. */
  readonly removed: readonly SetupQuestionNote[];
}

/**
 * Every change of the questions this build knows, oldest first.
 *
 * Revision 2 rewords the job prompt and result explanation to use Nectovia.
 * Their meaning and accepted answers are unchanged, so every answer carries
 * across, including its original prompt, author and time. Future revisions
 * add a step here when raising `BUSINESS_SETUP_SCHEMA_REVISION`.
 * A question left out of the entry is carried as it is, so an entry must name
 * every question whose meaning changed, not only the reworded ones.
 */
export const QUESTION_SET_CHANGES: readonly QuestionSetChange[] = Object.freeze([
  { from: 1, added: [], changed: [], removed: [] },
]);

/** The refusal for a setup saved by a newer version of the questions. Nothing is changed. */
export const SETUP_NEWER_REASON =
  'This setup was saved by a newer version of Nectovia, which asks different questions. Update Nectovia on this computer to continue it. Nothing in it was changed.';

/** The refusal for a setup at a revision this build does not carry. Nothing is changed. */
export const SETUP_UNREADABLE_REASON =
  "This setup was saved in a form this version of Nectovia can't read, so it can't be continued here. Nothing in it was changed.";

/** The refusal for answering a setup saved under earlier questions before it is resumed. */
export const SETUP_EARLIER_REASON =
  'This setup was saved under earlier questions. Resume it to carry its answers across to the current ones.';

type StoredSetup = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Carries a stored setup across one change. Pure: the input is not mutated,
 * and each carried answer is the same object it was. An answer stored under a
 * new question's id belongs to something else, so it is not carried either.
 */
export function carryAcross(setup: StoredSetup, change: QuestionSetChange): StoredSetup {
  if (setup.schemaRevision !== change.from)
    throw new Error(
      `This change carries setups saved under revision ${change.from}, not ${String(setup.schemaRevision)}.`,
    );
  if (!isRecord(setup.answers)) throw new Error('This setup has no answers to carry.');
  const left = new Set([...change.added, ...change.changed, ...change.removed].map((note) => note.id));
  const answers = Object.fromEntries(Object.entries(setup.answers).filter(([id]) => !left.has(id)));
  return { ...setup, schemaRevision: change.from + 1, answers };
}

/** The H21 steps for the setup family: `migrations[n]` carries revision n to n + 1. */
export function setupMigrations(
  changes: readonly QuestionSetChange[],
): Record<number, (setup: StoredSetup) => StoredSetup> {
  return Object.fromEntries(
    changes.map((change) => [change.from, (setup: StoredSetup) => carryAcross(setup, change)]),
  );
}

/** The changes that lead from revision `from` to `to`, in order, or null when one is missing. */
export function changesBetween(
  from: number,
  to: number,
  changes: readonly QuestionSetChange[] = QUESTION_SET_CHANGES,
): QuestionSetChange[] | null {
  const chain: QuestionSetChange[] = [];
  for (let revision = from; revision < to; revision++) {
    const step = changes.find((change) => change.from === revision);
    if (!step) return null;
    chain.push(step);
  }
  return chain;
}

const notes = (entries: Map<string, string>): SetupQuestionNote[] =>
  [...entries].map(([id, why]) => ({ id, why }));

/**
 * What resuming `setup` under revision `to` keeps and asks. Null when it is
 * already at `to`, is newer, or this build does not know every step between.
 * `keeps` comes from running the carry itself, so the plan a person reads and
 * the carry they get cannot disagree.
 */
export function carryPlan(
  setup: { schemaRevision: number; answers: Readonly<Record<string, unknown>> },
  to: number = BUSINESS_SETUP_SCHEMA_REVISION,
  changes: readonly QuestionSetChange[] = QUESTION_SET_CHANGES,
): SetupCarryView | null {
  if (!Number.isSafeInteger(setup.schemaRevision) || setup.schemaRevision >= to) return null;
  const chain = changesBetween(setup.schemaRevision, to, changes);
  if (!chain) return null;
  const asks = new Map<string, string>();
  const adds = new Map<string, string>();
  const drops = new Map<string, string>();
  let carried: StoredSetup = { schemaRevision: setup.schemaRevision, answers: { ...setup.answers } };
  for (const change of chain) {
    const answered = new Set(Object.keys(carried.answers as object));
    // A later step's words replace an earlier step's for the same question.
    for (const note of change.changed)
      if (answered.has(note.id) || asks.has(note.id)) asks.set(note.id, note.why);
      else if (adds.has(note.id)) adds.set(note.id, note.why);
    for (const note of change.removed) {
      if (answered.has(note.id) || asks.has(note.id)) drops.set(note.id, note.why);
      asks.delete(note.id);
      adds.delete(note.id);
    }
    for (const note of change.added) adds.set(note.id, note.why);
    carried = carryAcross(carried, change);
  }
  return {
    from: setup.schemaRevision,
    to,
    keeps: Object.keys(carried.answers as object).sort(),
    asks: notes(asks),
    adds: notes(adds),
    drops: notes(drops),
  };
}

/**
 * The table's own consistency, for the build it ships in: one step per
 * revision from 1 to `current - 1` and no others, and each note names a
 * question once. `tests/setup-question-changes.test.ts` holds the shipped table
 * to this, beside the H21 registry's own check.
 */
export function questionChangeProblems(
  changes: readonly QuestionSetChange[],
  current: number = BUSINESS_SETUP_SCHEMA_REVISION,
): string[] {
  const problems: string[] = [];
  const froms = changes.map((change) => change.from);
  for (let revision = 1; revision < current; revision++)
    if (!froms.includes(revision)) problems.push(`no change from ${revision}`);
  for (const from of froms)
    if (!Number.isSafeInteger(from) || from < 1 || from >= current) problems.push(`stray change from ${from}`);
  if (new Set(froms).size !== froms.length) problems.push('a revision has two changes');
  for (const change of changes) {
    const ids = [...change.added, ...change.changed, ...change.removed].map((note) => note.id);
    if (new Set(ids).size !== ids.length) problems.push(`change from ${change.from} names a question twice`);
    for (const note of [...change.added, ...change.changed, ...change.removed])
      if (note.why.trim() === '') problems.push(`change from ${change.from} does not say why ${note.id} changed`);
  }
  return problems;
}
