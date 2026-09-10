/**
 * The Business questionnaire — schema revision 1.
 *
 * A short, resumable intake that belongs to an organization, never to a person.
 * It is a pure state machine on purpose: the host enforces the same rule the
 * renderer draws, so "which question is next" and "is this finished" cannot
 * disagree between the two. `server/workspaces.ts` calls exactly these
 * functions before it writes, which is what makes the gate a host gate rather
 * than a screen.
 *
 * What it collects is description, not authorization. An answer names a goal,
 * a source, a reviewer or a cap; it never grants access, spending, sending or
 * membership. The proposals people make here (who should approve, who should
 * be invited) stay proposals: `server/workspaces.ts` does not read them when it
 * decides authority.
 */

export const BUSINESS_SETUP_SCHEMA_REVISION = 1 as const;

/**
 * The lifecycle the product contract names. This build implements the drafting
 * end of it: `not-started` → `drafting` → `proposal-ready`, plus the explicit
 * `paused` and `superseded` outcomes. Compiling, validating, rehearsing and
 * activating a configuration are not implemented here, and the host refuses
 * those transitions rather than pretending to make them.
 */
export type SetupState =
  | 'not-started'
  | 'drafting'
  | 'proposal-ready'
  | 'validating'
  | 'needs-approval'
  | 'rehearsing'
  | 'ready-to-activate'
  | 'active'
  | 'blocked'
  | 'paused'
  | 'superseded';

/**
 * The states the *intake* can actually reach. Anything else is refused.
 *
 * The list stays short because the intake stops at a reviewed proposal on
 * purpose: once answers become a configuration, `ConfigurationManifest` in
 * `shared/configuration.ts` owns whether that configuration is staged, active
 * or superseded. Two records tracking one lifecycle is how they drift apart.
 */
export const IMPLEMENTED_SETUP_STATES: readonly SetupState[] = Object.freeze([
  'not-started',
  'drafting',
  'proposal-ready',
  'paused',
  'superseded',
]);

/** The refusal for a state this build's intake cannot continue from. */
export const UNIMPLEMENTED_SETUP_REASON =
  'This setup is in a state the intake cannot continue from. Rehearsing a configuration before it runs is not built yet.';

/**
 * What happens after the questionnaire, said plainly rather than implied by a
 * screen that simply stops.
 *
 * Compiling the answers, checking them, staging an inactive setup and turning
 * one on are all implemented. A rehearsal — a dry run that proves the job works
 * before it works for real — is not, and this says so rather than letting
 * someone assume the first run has already been practised.
 */
export const AFTER_PROPOSAL =
  'Next you read the setup this makes, and turn it on yourself. Nothing runs until you do. There is no rehearsal step yet, so the first job is the real one: it writes a draft and stops for you to read.';

export type AnswerKind = 'text' | 'choice' | 'multi' | 'money';

export interface QuestionOption {
  id: string;
  label: string;
}

export interface Question {
  id: string;
  /** The question as a person reads it. */
  prompt: string;
  /** One short line saying what answering does. Every question carries one. */
  reason: string;
  kind: AnswerKind;
  options?: readonly QuestionOption[];
  /** A choice question that also accepts a typed answer. */
  allowOther?: boolean;
  /** False for questions that may be left unknown or skipped. */
  required: boolean;
  maxLength?: number;
  /**
   * Deeper questions appear only when the chosen job needs them. Absent means
   * the question is always asked.
   */
  revealWhen?: (answers: AnswerMap) => boolean;
}

export type AnswerValue = string | string[] | number | null;

/**
 * Where a stored fact came from. Explicit facts, model suggestions and
 * unresolved questions stay distinguishable: `origin` separates the first two
 * and `unknown` marks the third. Only `person` is produced in this build.
 */
export type AnswerOrigin = 'person' | 'model-suggested';

export interface BusinessAnswer {
  questionId: string;
  value: AnswerValue;
  /** The person said they do not know, or skipped an optional question. */
  unknown: boolean;
  origin: AnswerOrigin;
  at: string;
  /** The person id that recorded it. Attribution, not authority. */
  by: string;
}

export type AnswerMap = Readonly<Record<string, BusinessAnswer>>;

export interface BusinessSetup {
  v: 1;
  organizationId: string;
  /** The tenant these answers were recorded under; a copy cannot cross tenants. */
  tenantId: string;
  schemaRevision: number;
  state: SetupState;
  answers: Record<string, BusinessAnswer>;
  /** Where the flow resumes. Always an id from `BUSINESS_QUESTIONS`, or `review`. */
  cursor: string;
  startedAt: string;
  startedBy: string;
  updatedAt: string;
  /**
   * The answer digest a proposal was formed from. A later activation compares
   * against it, so a configuration cannot be activated over answers that moved
   * underneath it.
   */
  proposalDigest: string | null;
}

export const REVIEW_STEP = 'review' as const;

const JOB_OPTIONS: readonly QuestionOption[] = Object.freeze([
  { id: 'draft-replies', label: 'Draft replies or messages someone sends' },
  { id: 'summarise-documents', label: 'Summarise or extract from documents we already have' },
  { id: 'prepare-quotes', label: 'Prepare quotes, estimates or proposals' },
  { id: 'recurring-report', label: 'Produce a recurring report' },
  { id: 'organise-notes', label: 'Turn rough notes into a usable written record' },
]);

/**
 * A job that works from notes a person types needs no source question: asking
 * where the information lives would be a question with no useful answer.
 */
const JOBS_WITHOUT_SOURCES = new Set(['organise-notes']);

export function answeredJob(answers: AnswerMap): string | null {
  const answer = answers['job'];
  if (!answer || answer.unknown) return null;
  return typeof answer.value === 'string' ? answer.value : null;
}

export const BUSINESS_QUESTIONS: readonly Question[] = Object.freeze([
  {
    id: 'name',
    prompt: 'What should we call your business, and what work do you do?',
    reason:
      'Names this workspace and picks which examples you are shown. It selects examples, not authority.',
    kind: 'text',
    required: true,
    maxLength: 120,
  },
  {
    id: 'industry',
    prompt: 'What kind of work is that, in a word or two?',
    reason: 'Optional. Chooses starting examples only; leave it blank if none fit.',
    kind: 'text',
    required: false,
    maxLength: 60,
  },
  {
    id: 'job',
    prompt: 'What recurring job should Diomedes help with first?',
    reason:
      'One concrete outcome to start from. Anything unsupported is explained rather than promised.',
    kind: 'choice',
    options: JOB_OPTIONS,
    allowOther: true,
    required: true,
    maxLength: 200,
  },
  {
    id: 'result',
    prompt: 'What does a useful result look like, and who reviews it today?',
    reason:
      'Records the output and who checks it now. It is a baseline to compare against, not a saving Diomedes claims.',
    kind: 'text',
    required: true,
    maxLength: 400,
  },
  {
    id: 'sources',
    prompt: 'Where does the information for that job live?',
    reason: 'Describes the sources. Naming one does not connect it or grant access to it.',
    kind: 'multi',
    options: Object.freeze([
      { id: 'files', label: 'Files on this computer' },
      { id: 'shared-drive', label: 'A shared drive or folder' },
      { id: 'email', label: 'Email' },
      { id: 'business-system', label: 'A business system we use' },
      { id: 'paper', label: 'Paper or people' },
    ]),
    required: false,
    revealWhen: (answers) => {
      const job = answeredJob(answers);
      return job === null || !JOBS_WITHOUT_SOURCES.has(job);
    },
  },
  {
    id: 'people',
    prompt: 'Who uses this workspace, and who approves changes to it?',
    reason:
      'A proposal about people and approvers. It is confirmed separately; it does not invite anyone or grant a role.',
    kind: 'choice',
    options: Object.freeze([
      { id: 'just-me', label: 'Just me' },
      { id: 'small-team', label: 'A small team' },
      { id: 'several-teams', label: 'Several teams or departments' },
    ]),
    required: true,
  },
  {
    id: 'locations',
    prompt: 'Are there multiple locations or projects to keep apart?',
    reason:
      'Records labels and what must stay separate. It does not grant anyone access to either.',
    kind: 'choice',
    options: Object.freeze([
      { id: 'one', label: 'One' },
      { id: 'several', label: 'Several, kept separate' },
      { id: 'several-shared', label: 'Several that share most things' },
    ]),
    required: false,
    revealWhen: (answers) => {
      const people = answers['people'];
      return !people || people.unknown || people.value !== 'just-me';
    },
  },
  {
    id: 'human-required',
    prompt: 'What must always come back to a person before it happens?',
    reason:
      'Sets where a draft stops and waits. Anything consequential stays conservative by default.',
    kind: 'multi',
    options: Object.freeze([
      { id: 'sending', label: 'Anything sent outside the business' },
      { id: 'money', label: 'Anything involving money' },
      { id: 'commitments', label: 'Commitments to a customer' },
      { id: 'records', label: 'Changes to records we keep' },
      { id: 'everything', label: 'Everything, to start with' },
    ]),
    required: true,
  },
  {
    id: 'data-leaving',
    prompt: 'May this information leave this computer?',
    reason:
      'Decides which processing routes are allowed. If this is unknown, the risky ones stay closed.',
    kind: 'choice',
    options: Object.freeze([
      { id: 'no', label: 'No — keep it on this computer' },
      { id: 'non-sensitive', label: 'Only material that is not sensitive' },
      { id: 'yes', label: 'Yes, under our normal supplier terms' },
    ]),
    required: true,
  },
  {
    id: 'host',
    prompt: 'Which computer does this work, and when is it available?',
    reason:
      'Records the host and its hours. Nothing is discovered or scheduled without a separate confirmation.',
    kind: 'text',
    required: false,
    maxLength: 200,
  },
  {
    id: 'spend-cap',
    prompt: 'What monthly AI spending limit applies, and who can change it?',
    reason:
      'A proposed upper bound in US dollars. It cannot authorise spending, and it is never consent to go over.',
    kind: 'money',
    required: false,
  },
  {
    id: 'first-run',
    prompt: 'When should the first job run?',
    reason: 'Manual to start with. An unsupported schedule is recorded but stays inactive.',
    kind: 'choice',
    options: Object.freeze([
      { id: 'manual', label: 'When someone asks for it' },
      { id: 'daily', label: 'Daily' },
      { id: 'weekly', label: 'Weekly' },
    ]),
    required: false,
  },
]);

export const QUESTION_BY_ID: Readonly<Record<string, Question>> = Object.freeze(
  Object.fromEntries(BUSINESS_QUESTIONS.map((question) => [question.id, question])),
);

// --- flow ---------------------------------------------------------------------

/** The questions that apply given what has been answered so far. */
export function visibleQuestions(answers: AnswerMap): Question[] {
  return BUSINESS_QUESTIONS.filter(
    (question) => !question.revealWhen || question.revealWhen(answers),
  );
}

function answeredFor(question: Question, answers: AnswerMap): boolean {
  const answer = answers[question.id];
  if (!answer) return false;
  if (answer.unknown) return !question.required;
  return !emptyValue(answer.value);
}

function emptyValue(value: AnswerValue): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * The next question to put in front of someone, or `review` when every
 * applicable question has an answer. A question that stopped applying because
 * an earlier answer changed is skipped rather than blocking the flow.
 */
export function nextStep(answers: AnswerMap): string {
  for (const question of visibleQuestions(answers))
    if (!answeredFor(question, answers)) return question.id;
  return REVIEW_STEP;
}

/** The step before `current`, or null when it is already the first one. */
export function previousStep(answers: AnswerMap, current: string): string | null {
  const visible = visibleQuestions(answers);
  if (current === REVIEW_STEP) return visible.at(-1)?.id ?? null;
  const index = visible.findIndex((question) => question.id === current);
  return index > 0 ? (visible[index - 1]?.id ?? null) : null;
}

export function progress(answers: AnswerMap): {
  answered: number;
  required: number;
  total: number;
} {
  const visible = visibleQuestions(answers);
  return {
    answered: visible.filter((question) => answeredFor(question, answers)).length,
    required: visible.filter((question) => question.required).length,
    total: visible.length,
  };
}

export function readyForProposal(answers: AnswerMap): boolean {
  return nextStep(answers) === REVIEW_STEP;
}

// --- validation ---------------------------------------------------------------

/**
 * Text that looks like a credential or a card number. Free-text answers are
 * refused rather than stored: an intake form is not a secret store, and once a
 * key is written into durable answers no later rule can un-write it.
 *
 * It is deliberately blunt. A false refusal costs someone a rephrase; a missed
 * one puts a live key in a JSON file.
 */
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|passphrase|api[ _-]?key|secret[ _-]?key|access[ _-]?token)\b\s*[:=]\s*\S/i,
]);

/** 13–19 digits with optional spacing or dashes, passing the Luhn check. */
function looksLikeCardNumber(text: string): boolean {
  for (const candidate of text.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? []) {
    const digits = candidate.replace(/[^\d]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let digit = digits.charCodeAt(i) - 48;
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export const SECRET_REFUSAL =
  'This answer looks like a key, password or card number. Setup answers are stored as plain text, so credentials cannot be collected here. Describe the system instead.';

export function containsSecretLikeText(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text)) || looksLikeCardNumber(text);
}

export interface AnswerProblem {
  code: 'unknown-question' | 'not-visible' | 'required' | 'invalid' | 'secret-like';
  message: string;
}

/**
 * Check one submitted answer against its question. Returns the value to store,
 * or the problem to report. It never partially accepts: a rejected answer
 * leaves the stored setup exactly as it was.
 */
export function validateAnswer(
  questionId: string,
  raw: { value: AnswerValue; unknown: boolean },
  answers: AnswerMap,
): { ok: true; value: AnswerValue; unknown: boolean } | { ok: false; problem: AnswerProblem } {
  const question = QUESTION_BY_ID[questionId];
  if (!question)
    return {
      ok: false,
      problem: { code: 'unknown-question', message: 'That question is not part of this setup.' },
    };
  if (question.revealWhen && !question.revealWhen(answers))
    return {
      ok: false,
      problem: {
        code: 'not-visible',
        message: 'That question does not apply to the job you chose.',
      },
    };
  if (raw.unknown) {
    if (question.required)
      return {
        ok: false,
        problem: {
          code: 'required',
          message: 'This one is needed before the setup can be reviewed.',
        },
      };
    return { ok: true, value: null, unknown: true };
  }

  const max = question.maxLength ?? 400;
  switch (question.kind) {
    case 'text': {
      if (typeof raw.value !== 'string')
        return { ok: false, problem: { code: 'invalid', message: 'Answer this one in words.' } };
      const text = raw.value.trim();
      if (text === '')
        return question.required
          ? { ok: false, problem: { code: 'required', message: 'This one is needed.' } }
          : { ok: true, value: null, unknown: true };
      if (text.length > max)
        return {
          ok: false,
          problem: { code: 'invalid', message: `Keep this under ${max} characters.` },
        };
      if (containsSecretLikeText(text))
        return { ok: false, problem: { code: 'secret-like', message: SECRET_REFUSAL } };
      return { ok: true, value: text, unknown: false };
    }
    case 'choice': {
      if (typeof raw.value !== 'string')
        return { ok: false, problem: { code: 'invalid', message: 'Choose one of the answers.' } };
      const text = raw.value.trim();
      if (text === '')
        return question.required
          ? { ok: false, problem: { code: 'required', message: 'This one is needed.' } }
          : { ok: true, value: null, unknown: true };
      const known = question.options?.some((option) => option.id === text) ?? false;
      if (!known && !question.allowOther)
        return { ok: false, problem: { code: 'invalid', message: 'Choose one of the answers.' } };
      if (!known) {
        if (text.length > max)
          return {
            ok: false,
            problem: { code: 'invalid', message: `Keep this under ${max} characters.` },
          };
        if (containsSecretLikeText(text))
          return { ok: false, problem: { code: 'secret-like', message: SECRET_REFUSAL } };
      }
      return { ok: true, value: text, unknown: false };
    }
    case 'multi': {
      if (!Array.isArray(raw.value))
        return { ok: false, problem: { code: 'invalid', message: 'Choose any that apply.' } };
      const ids = [...new Set(raw.value.map((item) => String(item)))];
      if (ids.length === 0)
        return question.required
          ? { ok: false, problem: { code: 'required', message: 'Choose at least one.' } }
          : { ok: true, value: null, unknown: true };
      if (ids.some((id) => !question.options?.some((option) => option.id === id)))
        return {
          ok: false,
          problem: { code: 'invalid', message: 'Choose from the answers listed.' },
        };
      return { ok: true, value: ids, unknown: false };
    }
    case 'money': {
      if (typeof raw.value !== 'number' || !Number.isFinite(raw.value))
        return {
          ok: false,
          problem: { code: 'invalid', message: 'Give a whole number of US dollars.' },
        };
      const amount = Math.round(raw.value);
      if (amount < 0 || amount > 1_000_000)
        return {
          ok: false,
          problem: { code: 'invalid', message: 'Give a limit between $0 and $1,000,000.' },
        };
      return { ok: true, value: amount, unknown: false };
    }
    default:
      return { ok: false, problem: { code: 'invalid', message: 'That answer could not be read.' } };
  }
}

/**
 * The facts collected so far, in the order they were asked, for the review
 * screen and for whatever later step compiles them. Unresolved questions are
 * carried through as unresolved rather than dropped.
 */
export interface CollectedFact {
  questionId: string;
  prompt: string;
  origin: AnswerOrigin | 'unresolved';
  display: string;
}

export function collectFacts(answers: AnswerMap): CollectedFact[] {
  return visibleQuestions(answers).map((question) => {
    const answer = answers[question.id];
    if (!answer || answer.unknown || emptyValue(answer.value))
      return {
        questionId: question.id,
        prompt: question.prompt,
        origin: 'unresolved' as const,
        display: 'Not answered',
      };
    return {
      questionId: question.id,
      prompt: question.prompt,
      origin: answer.origin,
      display: displayValue(question, answer.value),
    };
  });
}

export function displayValue(question: Question, value: AnswerValue): string {
  if (value === null) return 'Not answered';
  if (question.kind === 'money') return `$${Number(value).toLocaleString('en-US')} per month`;
  const label = (id: string) => question.options?.find((option) => option.id === id)?.label ?? id;
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (question.kind === 'choice') return label(String(value));
  return String(value);
}

// --- the shapes the host returns ----------------------------------------------

/** One question as the renderer receives it. Reveal rules stay on the host. */
export interface QuestionView {
  id: string;
  prompt: string;
  reason: string;
  kind: AnswerKind;
  options: readonly QuestionOption[] | null;
  allowOther: boolean;
  required: boolean;
  maxLength: number | null;
}

/**
 * One organization's intake, as the host presents it. `step` is the host's own
 * answer to "what comes next", so the renderer never computes a different one.
 */
export interface BusinessSetupView {
  organization: { id: string; name: string; identitySource: string };
  state: SetupState;
  schemaRevision: number;
  currentSchemaRevision: number;
  /** Saved under a schema this build does not use; resume before continuing. */
  stale: boolean;
  step: string;
  previous: string | null;
  answers: Record<string, BusinessAnswer>;
  facts: CollectedFact[];
  progress: { answered: number; required: number; total: number };
  ready: boolean;
  /** Send back with an answer so a concurrent edit conflicts instead of winning. */
  digest: string;
  proposalDigest: string | null;
  afterProposal: string;
}
