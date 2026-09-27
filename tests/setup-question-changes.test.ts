/**
 * ORG-02: a setup saved under earlier questions keeps every answer the change
 * did not touch, exactly as it was given, and a setup saved under newer ones is
 * refused rather than guessed at.
 *
 * The shipped revision 2 only rewords the product name. These tests also run
 * the carry against a separate sample
 * revision 2 (`REVISION_2`) that adds one question, changes one and stops
 * asking one.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  BUSINESS_QUESTIONS,
  BUSINESS_SETUP_SCHEMA_REVISION,
  type AnswerValue,
  type BusinessAnswer,
  type BusinessSetup,
} from '../shared/business-setup.js';
import {
  QUESTION_SET_CHANGES,
  carryAcross,
  carryPlan,
  changesBetween,
  questionChangeProblems,
  setupMigrations,
  type QuestionSetChange,
} from '../shared/setup-question-changes.js';
import { screenSetupRecord } from '../shared/organization-setup.js';
import { familyProblems, migrateRecord, MigrationRefusal, type DurableFamily } from '../server/migrations/framework.js';
import { BUSINESS_SETUP, durableFamily } from '../server/migrations/registry.js';

const OWNER = 'person_owner';
const MANAGER = 'person_manager';

const REVISION_2: QuestionSetChange = {
  from: 1,
  added: [{ id: 'busy-season', why: 'Briefs now plan around the weeks the business is busiest.' }],
  changed: [{ id: 'people', why: 'This now counts everyone who reads the brief, not only staff.' }],
  removed: [{ id: 'host', why: 'Nectovia now finds the computer that runs the work by itself.' }],
};

const given = (questionId: string, value: AnswerValue, by = OWNER): BusinessAnswer => ({
  questionId,
  value,
  unknown: false,
  origin: 'person',
  at: '2026-09-20T10:00:00.000Z',
  by,
  prompt: BUSINESS_QUESTIONS.find((question) => question.id === questionId)?.prompt ?? `The ${questionId} question`,
});

/** A finished setup saved under revision 1, answered by the owner. */
const savedUnderOne = (): BusinessSetup => ({
  v: 1,
  organizationId: 'org_juniper',
  tenantId: 'tenant_juniper',
  schemaRevision: 1,
  state: 'proposal-ready',
  answers: {
    name: given('name', 'Juniper Street Bakery'),
    industry: given('industry', 'Bakery'),
    job: given('job', 'recurring-report'),
    people: given('people', 'just-me'),
    host: given('host', 'The office desktop, weekdays.'),
  },
  cursor: 'review',
  startedAt: '2026-09-20T09:59:00.000Z',
  startedBy: OWNER,
  updatedAt: '2026-09-20T10:05:00.000Z',
  proposalDigest: 'digest-of-the-revision-1-answers',
});

/** The setup family as the build that ships `REVISION_2` would register it. */
const WITH_REVISION_2: DurableFamily = { ...BUSINESS_SETUP, current: 2, migrations: setupMigrations([REVISION_2]) };

describe('the shipped questions', () => {
  test('revision 2 carries every answer across the product-name rewording', () => {
    expect(BUSINESS_SETUP_SCHEMA_REVISION).toBe(2);
    expect(QUESTION_SET_CHANGES).toEqual([{ from: 1, added: [], changed: [], removed: [] }]);
    const saved = savedUnderOne();
    saved.answers.job.prompt = 'What recurring job should Diomedes help with first?';
    const carried = migrateRecord(BUSINESS_SETUP, saved).record;
    expect(carried).toEqual({ ...saved, schemaRevision: 2 });
    expect(carryPlan(saved)).toEqual({ from: 1, to: 2, keeps: Object.keys(saved.answers).sort(), asks: [], adds: [], drops: [] });
    expect(BUSINESS_QUESTIONS.find((question) => question.id === 'job')?.prompt).toBe('What recurring job should Nectovia help with first?');
    expect(questionChangeProblems(QUESTION_SET_CHANGES)).toEqual([]);
    expect(durableFamily('business-setup')).toBe(BUSINESS_SETUP);
    expect(BUSINESS_SETUP).toMatchObject({
      location: 'workspaces/setup/*.json',
      versionField: 'schemaRevision',
      oldest: 1,
      current: BUSINESS_SETUP_SCHEMA_REVISION,
      unversioned: null,
      reader: { file: 'server/workspaces.ts', throughFramework: true },
    });
    expect(familyProblems(BUSINESS_SETUP)).toEqual([]);
  });

  test('what the revision 1 questions accept is pinned, so changing it is a decision and not an accident', () => {
    // Prompts and reasons are left out: rewording a question does not change
    // what its answers mean, and each answer keeps the words it was given
    // against. Everything that decides what an answer means is in.
    const shape = BUSINESS_QUESTIONS.map((question) => [
      question.id,
      question.kind,
      question.required,
      (question.options ?? []).map((option) => option.id),
      question.allowOther ?? false,
      question.maxLength ?? null,
      question.revealWhen ? 'conditional' : 'always',
    ]);
    const fingerprint = createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
    // If this fails, the questions changed. When every stored answer still
    // means what it meant, update the value below. When one does not, raise
    // BUSINESS_SETUP_SCHEMA_REVISION and add a QuestionSetChange naming it.
    expect(fingerprint, 'the revision 1 questions changed').toBe('0666c326febe7973');
  });
});

describe('carrying a setup across one change', () => {
  test('keeps every untouched answer as the same object, and changes nothing but the answers and the revision', () => {
    const before = savedUnderOne();
    const snapshot = structuredClone(before);
    const carried = carryAcross(before as unknown as Record<string, unknown>, REVISION_2) as unknown as BusinessSetup;
    expect(carried.schemaRevision).toBe(2);
    expect(Object.keys(carried.answers).sort()).toEqual(['industry', 'job', 'name']);
    for (const id of ['industry', 'job', 'name']) expect(carried.answers[id]).toBe(before.answers[id]);
    const { answers: _answers, schemaRevision: _revision, ...rest } = carried;
    const { answers: _was, schemaRevision: _wasRevision, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(before).toEqual(snapshot);
  });

  test("an answer stored under a new question's id is not carried into it", () => {
    const before = savedUnderOne();
    before.answers['busy-season'] = given('busy-season', 'December');
    const carried = carryAcross(before as unknown as Record<string, unknown>, REVISION_2);
    expect(Object.keys(carried.answers as object)).not.toContain('busy-season');
  });

  test('refuses a setup saved under another revision, or one with no answers', () => {
    expect(() => carryAcross({ ...savedUnderOne(), schemaRevision: 2 }, REVISION_2)).toThrow(/revision 1, not 2/);
    expect(() => carryAcross({ ...savedUnderOne(), answers: null }, REVISION_2)).toThrow(/no answers/);
  });
});

describe('the setup family, as the build that ships revision 2 would read it', () => {
  test('carries a revision 1 setup forward and reads a revision 2 setup as it is', () => {
    const result = migrateRecord(WITH_REVISION_2, savedUnderOne());
    expect(result).toMatchObject({ from: 1, to: 2, migrated: true });
    expect(Object.keys(result.record.answers as object).sort()).toEqual(['industry', 'job', 'name']);
    expect((result.record.answers as Record<string, BusinessAnswer>).name).toEqual(savedUnderOne().answers.name);
    const current = { ...savedUnderOne(), schemaRevision: 2 };
    expect(migrateRecord(WITH_REVISION_2, current).record).toBe(current);
  });

  test('refuses a setup saved by a newer version, or one that names no revision it could have written', () => {
    const refusal = (value: unknown) => {
      try {
        migrateRecord(WITH_REVISION_2, value);
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationRefusal);
        return (error as MigrationRefusal).code;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal({ ...savedUnderOne(), schemaRevision: 3 })).toBe('newer-version');
    expect(refusal({ ...savedUnderOne(), schemaRevision: 0 })).toBe('unknown-version');
    const { schemaRevision: _revision, ...unversioned } = savedUnderOne();
    expect(refusal(unversioned)).toBe('unknown-version');
    // The shipped family refuses a setup newer than its own questions too.
    expect(() => migrateRecord(BUSINESS_SETUP, { ...savedUnderOne(), schemaRevision: BUSINESS_SETUP_SCHEMA_REVISION + 1 })).toThrow(MigrationRefusal);
  });
});

describe('the plan a person reads before resuming', () => {
  test('says which answers come across, which questions are asked again or for the first time, and which stop, with why', () => {
    expect(carryPlan(savedUnderOne(), 2, [REVISION_2])).toEqual({
      from: 1,
      to: 2,
      keeps: ['industry', 'job', 'name'],
      asks: [REVISION_2.changed[0]],
      adds: [REVISION_2.added[0]],
      drops: [REVISION_2.removed[0]],
    });
  });

  test('a question changed or removed that was never answered is not reported as asked again or dropped', () => {
    const setup = savedUnderOne();
    delete setup.answers.people;
    delete setup.answers.host;
    expect(carryPlan(setup, 2, [REVISION_2])).toMatchObject({ asks: [], drops: [], adds: [REVISION_2.added[0]] });
  });

  test('there is no plan for a setup already current, a newer one, or one whose steps this build does not have', () => {
    expect(carryPlan({ ...savedUnderOne(), schemaRevision: 2 }, 2, [REVISION_2])).toBeNull();
    expect(carryPlan({ ...savedUnderOne(), schemaRevision: 3 }, 2, [REVISION_2])).toBeNull();
    expect(carryPlan(savedUnderOne(), 3, [REVISION_2])).toBeNull();
    expect(changesBetween(1, 3, [REVISION_2])).toBeNull();
    expect(carryPlan({ ...savedUnderOne(), schemaRevision: BUSINESS_SETUP_SCHEMA_REVISION })).toBeNull();
  });

  test('across two changes, the later words win and a question that stops being asked is not also asked', () => {
    const REVISION_3: QuestionSetChange = {
      from: 2,
      added: [],
      changed: [
        { id: 'busy-season', why: 'This now asks for weeks rather than a month.' },
        { id: 'people', why: 'This now also counts people outside the business.' },
      ],
      removed: [{ id: 'industry', why: 'The trade now comes from the business name.' }],
    };
    expect(carryPlan(savedUnderOne(), 3, [REVISION_2, REVISION_3])).toEqual({
      from: 1,
      to: 3,
      keeps: ['job', 'name'],
      asks: [{ id: 'people', why: 'This now also counts people outside the business.' }],
      adds: [{ id: 'busy-season', why: 'This now asks for weeks rather than a month.' }],
      drops: [REVISION_2.removed[0], REVISION_3.removed[0]],
    });
    const REVISION_3_DROPS_PEOPLE: QuestionSetChange = {
      from: 2,
      added: [],
      changed: [],
      removed: [{ id: 'people', why: 'Nobody reads a count of people.' }],
    };
    expect(carryPlan(savedUnderOne(), 3, [REVISION_2, REVISION_3_DROPS_PEOPLE])).toMatchObject({
      asks: [],
      drops: [REVISION_2.removed[0], REVISION_3_DROPS_PEOPLE.removed[0]],
    });
  });

  test('a table with a missing, stray or doubled step, or a note without a reason, is reported', () => {
    expect(questionChangeProblems([], 2)).toEqual(['no change from 1']);
    expect(questionChangeProblems([REVISION_2], 1)).toEqual(['stray change from 1']);
    expect(questionChangeProblems([REVISION_2, REVISION_2], 2)).toEqual(['a revision has two changes']);
    expect(
      questionChangeProblems(
        [{ ...REVISION_2, removed: [{ id: 'people', why: ' ' }] }],
        2,
      ),
    ).toEqual(['change from 1 names a question twice', 'change from 1 does not say why people changed']);
  });
});

describe('what the account service makes of a carried setup (ORG-01 attribution)', () => {
  const context = (previous: BusinessSetup, writer: string) => ({
    organizationId: previous.organizationId,
    tenantId: previous.tenantId,
    writer,
    previous: { v: 1 as const, setup: previous },
  });

  test("a Manager may save the carried setup: the answers it keeps are unchanged, so they stay the owner's", () => {
    const previous = savedUnderOne();
    const carried = migrateRecord(WITH_REVISION_2, previous).record as unknown as BusinessSetup;
    const resumed: BusinessSetup = { ...carried, state: 'drafting', cursor: 'people', proposalDigest: null };
    expect(screenSetupRecord({ v: 1, setup: resumed }, context(previous, MANAGER))).toBeNull();
    for (const answer of Object.values(resumed.answers)) expect(answer.by).toBe(OWNER);
  });

  test('a carried answer altered in any way would be refused, which is why the carry never touches one', () => {
    const previous = savedUnderOne();
    const carried = migrateRecord(WITH_REVISION_2, previous).record as unknown as BusinessSetup;
    carried.answers.name = { ...carried.answers.name!, prompt: 'What is the business called?' };
    expect(screenSetupRecord({ v: 1, setup: carried }, context(previous, MANAGER))).toMatchObject({
      code: 'attribution',
    });
  });
});
