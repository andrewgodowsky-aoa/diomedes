/**
 * Interaction decision: the frozen additive shape from CD-01.
 *
 * SCHEMA VALIDITY NEVER ESTABLISHES SEMANTIC CORRECTNESS, AND PARSING ONE OF
 * THESE OBJECTS NEVER AUTHORIZES AN EFFECT. This file describes what a model
 * may *propose* about one source message. Whether anything happens is decided
 * afterwards and elsewhere: `ScopeGrants.matching` (server/trust/scope-grants.ts)
 * is the only thing that mints write authority, `NativeWorkService.start`
 * (server/native-work.ts) is the only thing that admits a run, and the mode
 * instructions pinned into a native conversation scope
 * (server/harness/claude-session-run.ts `scope`) are the only thing that bounds
 * what the provider was asked to do. A decision that parses cleanly and names
 * `operationClass: 'send_external'` has exactly as much authority as a
 * decision that names `'none'`, which is none at all.
 *
 * Nothing here changes an existing contract version. `HARNESS_CONTRACT_VERSION`
 * stays 1, `WORK_CONTROL_CONTRACT_VERSION` stays 1 and
 * `WORKSPACE_CONTRACT_VERSION` stays 1. This file does not amend contract
 * revision `2026-09-13.1`, which is still `proposed` (shared/contract-revision.ts
 * `CONTRACT_REVISION.status`); it stands beside it and consumes none of it.
 *
 * Field naming: the CD-1 package fixture
 * (`contracts/interaction-decision.schema.json`) is snake_case. This module is
 * camelCase, matching every other record in `shared/`. `PACKAGE_FIELD_NAMES`
 * below is the 1:1 correspondence, exported so a reviewer can check the two
 * documents against each other mechanically rather than by eye.
 *
 * Parity rule: apart from that renaming, this parser accepts and refuses
 * exactly what the fixture does. It does not tighten. Three consequences that
 * are deliberate, not oversights:
 *
 * 1. No `.trim()` anywhere. The fixture's `minLength` admits a one-space
 *    string, and trimming would both change which values parse and silently
 *    rewrite a source identity. `sourceMessageId` is the exact bytes the
 *    caller sent. Identity normalization, if the product ever wants it, is a
 *    separate named step that runs before validation and is recorded where it
 *    happens. It is not hidden inside a parser.
 * 2. Length bounds count Unicode code points, matching JSON Schema. Zod's own
 *    `.max()` counts UTF-16 units, so a string of 160 emoji would pass the
 *    fixture and fail a naive `.max(160)`. `withinCodePoints` is the check.
 * 3. `targetRunId` may be non-null on `retrieve`, `plan`, `act` and
 *    `build_capability`. The fixture constrains it to null only for
 *    `respond`, `clarify` and `blocked`, and requires it for `control`. A
 *    retrieval or an act that names the run it continues is a legal proposal.
 *
 * Any future divergence from the fixture must version the fixture first and
 * say so here. A parser that quietly refuses more than its schema is a parser
 * two teams can disagree about.
 *
 * Where it is stored: an accepted or refused decision rides on the existing run
 * record as one `RunService` step with `kind: 'transform'`, `effect: 'pure'`,
 * `cost: 0`, `destination: 'local'` (see `StepKind`/`Effect` in shared/harness.ts).
 * It is not a field on `Turn` and it is not a new store. A pure zero-cost step
 * spends no budget, reaches no provider and records the proposal exactly as it
 * was made, including the refused ones.
 */
import { z } from 'zod';

/** Which contract fixture this shape was frozen against. Not a runtime version. */
export const INTERACTION_CONTRACT = Object.freeze({
  source: 'CD-1/contracts/interaction-decision.schema.json',
  frozenAt: '2026-09-20',
  status: 'proposed',
} as const);

/**
 * The eight orthogonal dispositions. One message yields exactly one.
 *
 * `respond` answers from context already permitted. `retrieve` needs a read.
 * `plan` explains or prepares a reviewable proposal without implementing it.
 * `act` requests a concrete existing operation. `build_capability` proposes a
 * missing reusable capability. `control` addresses a named active run.
 * `clarify` asks for one essential missing input. `blocked` explains a path
 * that is unavailable or unauthorized.
 */
export const DISPOSITIONS = [
  'respond',
  'retrieve',
  'plan',
  'act',
  'build_capability',
  'control',
  'clarify',
  'blocked',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * What kind of operation the disposition would involve if it were admitted.
 * This is a claim about the class of effect, never a grant of it.
 */
export const OPERATION_CLASSES = [
  'none',
  'read',
  'prepare_artifact',
  'write_internal',
  'send_external',
  'develop_capability',
  'control_run',
] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

/**
 * Dispositions the fixture pins to `operationClass: 'none'` and
 * `targetRunId: null`. `control` is the opposite pole: it requires a target.
 * Everything else may name a target run or not.
 */
export const INERT_DISPOSITIONS: readonly Disposition[] = Object.freeze([
  'respond',
  'clarify',
  'blocked',
]);

/**
 * The operation classes each disposition may name. A disposition absent from
 * this map is a programming error, not an admitted decision; the schema below
 * reads this map rather than repeating the rules.
 */
export const ALLOWED_OPERATIONS: Readonly<Record<Disposition, readonly OperationClass[]>> =
  Object.freeze({
    respond: Object.freeze(['none'] as const),
    clarify: Object.freeze(['none'] as const),
    blocked: Object.freeze(['none'] as const),
    retrieve: Object.freeze(['read'] as const),
    plan: Object.freeze(['none', 'prepare_artifact'] as const),
    act: Object.freeze([
      'read',
      'prepare_artifact',
      'write_internal',
      'send_external',
    ] as const),
    build_capability: Object.freeze(['develop_capability'] as const),
    control: Object.freeze(['control_run'] as const),
  });

/**
 * The issued trusted source identity, as frozen by CD-01 decision 10.
 *
 * The server mints one of these per accepted source message, before
 * generation. It is not the transport command id, and it is never trimmed:
 * 35 ASCII characters is 35 code points and 35 UTF-16 units, so the three
 * length semantics on this bridge cannot disagree about it.
 *
 * This constrains what the server ISSUES and what admission ACCEPTS. It does
 * not constrain this module's parser, which keeps exact fixture parity and
 * accepts any string the fixture accepts. A decision whose `sourceMessageId`
 * is well formed but is not the identity this turn was admitted for is a valid
 * decision object and an invalid proposal; admission makes that call, not the
 * schema. Exported so admission and the work-linkage field share one
 * definition rather than drifting apart.
 */
export const ISSUED_SOURCE_ID = /^sm\.[0-9a-f]{32}$/;

/** True when `value` is an identity the server could have issued. */
export const isIssuedSourceId = (value: string) => ISSUED_SOURCE_ID.test(value);

/** camelCase field here → snake_case field in the CD-1 package fixture. */
export const PACKAGE_FIELD_NAMES = Object.freeze({
  sourceMessageId: 'source_message_id',
  disposition: 'disposition',
  requestedProjectId: 'requested_project_id',
  operationClass: 'operation_class',
  sourceRefs: 'source_refs',
  targetRunId: 'target_run_id',
  question: 'question',
  publicSummary: 'public_summary',
} as const);

/**
 * JSON Schema counts characters as Unicode code points. Zod's `.max()` counts
 * UTF-16 units, so it would refuse 160 supplementary characters that the
 * fixture accepts. Every bound below goes through this.
 */
export const withinCodePoints = (max: number) => (value: string) => [...value].length <= max;

/** `minLength: 1, maxLength: 160`, with no normalization of any kind. */
const bounded = z
  .string()
  .min(1)
  .refine(withinCodePoints(160), { message: 'Use at most 160 characters.' });

/**
 * Every field is required, including the nullable ones. An omitted
 * `targetRunId` and an explicit `null` are different statements about a
 * proposal, and only the explicit one is accepted.
 */
export const interactionDecisionSchema = z
  .strictObject({
    /**
     * The stable identity of the message that produced this decision, exactly
     * as supplied. A retry of the same message carries the same value, which
     * is what lets a re-proposal reach the existing receipt instead of minting
     * new work. Never trimmed: two ids that differ only in whitespace are two
     * ids, and deciding otherwise is a normalization policy, not parsing.
     */
    sourceMessageId: bounded,
    disposition: z.enum(DISPOSITIONS),
    /** The project the message asked for, or null when none was named. */
    requestedProjectId: bounded.nullable(),
    operationClass: z.enum(OPERATION_CLASSES),
    /**
     * References to material already in scope. Never file contents.
     * Uniqueness is compared on the raw strings, as the fixture's
     * `uniqueItems` does: `'document'` and `' document '` are two references.
     */
    sourceRefs: z
      .array(bounded)
      .max(32)
      .refine((items) => new Set(items).size === items.length, {
        message: 'List each source reference once.',
      }),
    /**
     * The run this decision addresses. Required for `control`, forbidden for
     * `respond`, `clarify` and `blocked`, optional for the rest.
     */
    targetRunId: bounded.nullable(),
    /** The single essential missing input. Required for `clarify`. */
    question: z
      .string()
      .min(1)
      .refine(withinCodePoints(1000), { message: 'Use at most 1000 characters.' })
      .nullable(),
    /** User-safe summary of the decision or result. Never private reasoning. */
    publicSummary: z
      .string()
      .refine(withinCodePoints(2000), { message: 'Use at most 2000 characters.' }),
  })
  .superRefine((decision, context) => {
    const allowed = ALLOWED_OPERATIONS[decision.disposition];
    if (!allowed.includes(decision.operationClass))
      context.addIssue({
        code: 'custom',
        path: ['operationClass'],
        message: `A ${decision.disposition} decision may not name the ${decision.operationClass} operation class.`,
      });
    // Exactly the fixture's rule: required for control, forbidden for the
    // three inert dispositions, free for the rest.
    if (decision.disposition === 'control') {
      if (decision.targetRunId === null)
        context.addIssue({
          code: 'custom',
          path: ['targetRunId'],
          message: 'A control decision must name the run it addresses.',
        });
    } else if (INERT_DISPOSITIONS.includes(decision.disposition) && decision.targetRunId !== null)
      context.addIssue({
        code: 'custom',
        path: ['targetRunId'],
        message: `A ${decision.disposition} decision may not name a target run.`,
      });
    if (decision.disposition === 'clarify' && decision.question === null)
      context.addIssue({
        code: 'custom',
        path: ['question'],
        message: 'A clarify decision must carry the question it needs answered.',
      });
  });
export type InteractionDecision = z.infer<typeof interactionDecisionSchema>;

/**
 * One valid example per disposition, each tied to the evaluation case it was
 * written for. These are shapes, not expected outputs: an example proving that
 * `act` can be expressed says nothing about whether that act would be admitted.
 */
export const INTERACTION_EXAMPLES = Object.freeze({
  /** C01 "Morning." A greeting creates no visible task. */
  greeting: Object.freeze({
    sourceMessageId: 'msg_c01',
    disposition: 'respond',
    requestedProjectId: null,
    operationClass: 'none',
    sourceRefs: [],
    targetRunId: null,
    question: null,
    publicSummary: 'Answered directly. No work was created.',
  }),
  /** C05 comparing two approved delivery notes the person already selected. */
  lookup: Object.freeze({
    sourceMessageId: 'msg_c05',
    disposition: 'retrieve',
    requestedProjectId: 'project_linen',
    operationClass: 'read',
    sourceRefs: ['doc_delivery_note_a', 'doc_delivery_note_b'],
    targetRunId: null,
    question: null,
    publicSummary: 'Read both approved delivery notes and compared them.',
  }),
  /** C07 "Plan how to fix this, but do not implement it." */
  planOnly: Object.freeze({
    sourceMessageId: 'msg_c07',
    disposition: 'plan',
    requestedProjectId: 'project_linen',
    operationClass: 'prepare_artifact',
    sourceRefs: ['doc_receiving_process'],
    targetRunId: null,
    question: null,
    publicSummary: 'Prepared a plan. Nothing was changed.',
  }),
  /** C09 "Build next week's staff schedule" with an existing capability. */
  act: Object.freeze({
    sourceMessageId: 'msg_c09',
    disposition: 'act',
    requestedProjectId: 'project_rota',
    operationClass: 'prepare_artifact',
    sourceRefs: ['doc_constraints', 'doc_last_week_rota'],
    targetRunId: null,
    question: null,
    publicSummary: 'Proposed preparing the schedule for next week as a reviewable draft.',
  }),
  /** C11 a verified gap: a validator for an unsupported file format. */
  buildCapability: Object.freeze({
    sourceMessageId: 'msg_c11',
    disposition: 'build_capability',
    requestedProjectId: 'project_intake',
    operationClass: 'develop_capability',
    sourceRefs: ['doc_format_sample'],
    targetRunId: null,
    question: null,
    publicSummary: 'Proposed a bounded development task with tests and separate activation.',
  }),
  /** C34 "Stop the current job." */
  control: Object.freeze({
    sourceMessageId: 'msg_c34',
    disposition: 'control',
    requestedProjectId: 'project_linen',
    operationClass: 'control_run',
    sourceRefs: [],
    targetRunId: 'run_supplier_update',
    question: null,
    publicSummary: 'Requested a stop for the named job.',
  }),
  /** C15 "Compare our deliveries" with no project selected and several plausible. */
  clarify: Object.freeze({
    sourceMessageId: 'msg_c15',
    disposition: 'clarify',
    requestedProjectId: null,
    operationClass: 'none',
    sourceRefs: [],
    targetRunId: null,
    question: 'Which project should I compare deliveries for?',
    publicSummary: 'Asked which project to use. Nothing was started.',
  }),
  /** C12 an existing tool is present but permission is absent. */
  blocked: Object.freeze({
    sourceMessageId: 'msg_c12',
    disposition: 'blocked',
    requestedProjectId: 'project_intake',
    operationClass: 'none',
    sourceRefs: ['grant_denied_receipt'],
    targetRunId: null,
    question: null,
    publicSummary: 'The tool exists but access was refused. That boundary needs a grant, not new code.',
  }),
} as const) satisfies Readonly<Record<string, InteractionDecision>>;
