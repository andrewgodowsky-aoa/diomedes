/**
 * The shapes of a stored business setup (ORG-01), for the Worker and for the
 * desktop that reads the Worker's answers. The rules that are not shape — no
 * credentials, the right business, truthful attribution — are
 * `screenSetupRecord` in shared/organization-setup.ts, which both sides share.
 *
 * Kept here rather than in shared/ so the Worker bundles one copy of zod: the
 * desktop already imports the account service's modules from this package.
 */
import { z } from 'zod';
import {
  ORGANIZATION_SETUP_CONTRACT_VERSION,
  SETUP_RECORD_LIMITS,
  SETUP_RECORD_STATES,
  type OrganizationSetupAnswer,
  type OrganizationSetupRecord,
  type OrganizationSetupWrite,
} from '../../../../shared/organization-setup.js';
import type { SetupState } from '../../../../shared/business-setup.js';

/** The account service's id rule (`accountId` in ../domain.ts). */
const recordId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const questionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const time = z.iso.datetime({ offset: true });

export const businessAnswerSchema = z.strictObject({
  questionId,
  value: z.union([
    z.string().max(SETUP_RECORD_LIMITS.text),
    z.array(z.string().max(SETUP_RECORD_LIMITS.choice)).max(SETUP_RECORD_LIMITS.choices),
    z.number().finite(),
    z.null(),
  ]),
  unknown: z.boolean(),
  origin: z.enum(['person', 'model-suggested']),
  at: time,
  by: recordId,
  /** The question as it was worded when this answer was given. */
  prompt: z.string().max(SETUP_RECORD_LIMITS.prompt).optional(),
});

export const businessSetupSchema = z.strictObject({
  v: z.literal(1),
  organizationId: recordId,
  tenantId: recordId,
  schemaRevision: z.number().int().min(1).max(10_000),
  state: z.enum(SETUP_RECORD_STATES as [SetupState, ...SetupState[]]),
  answers: z
    .record(questionId, businessAnswerSchema)
    .refine((answers) => Object.keys(answers).length <= SETUP_RECORD_LIMITS.answers, { message: 'Too many answers.' })
    .refine((answers) => Object.entries(answers).every(([id, answer]) => answer.questionId === id), {
      message: 'Each answer is filed under its own question.',
    }),
  cursor: questionId,
  startedAt: time,
  startedBy: recordId,
  updatedAt: time,
  proposalDigest: z.string().min(1).max(200).nullable(),
});

export const organizationSetupRecordSchema = z.strictObject({
  v: z.literal(ORGANIZATION_SETUP_CONTRACT_VERSION),
  setup: businessSetupSchema,
}) satisfies z.ZodType<OrganizationSetupRecord>;

export const organizationSetupWriteSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(SETUP_RECORD_LIMITS.revision),
  record: organizationSetupRecordSchema,
}) satisfies z.ZodType<OrganizationSetupWrite>;

/** What the desktop accepts back from the service. */
export const organizationSetupAnswerSchema = z.strictObject({
  organizationId: recordId,
  tenantId: recordId,
  revision: z.number().int().min(0).max(SETUP_RECORD_LIMITS.revision),
  record: organizationSetupRecordSchema.nullable(),
  writtenAt: time.nullable(),
  writtenBy: recordId.nullable(),
}) satisfies z.ZodType<OrganizationSetupAnswer>;
