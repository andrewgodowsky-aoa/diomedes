/**
 * ORG-01 / SET-01: the business setup belongs to the organization, not to one
 * computer.
 *
 * Until this contract the intake (`shared/business-setup.ts`) was saved as one
 * JSON file per organization on the computer that answered it. A second
 * computer, an invited administrator or a new owner found no file and was shown
 * the first question again. Now the account service keeps every revision of
 * the record for the organization, and each computer holds a tagged copy.
 *
 * Three rules carry the whole file.
 *
 * 1. **The service stores; it does not interpret.** It checks the record's shape
 *    (`services/control-plane/src/organization-setup/schema.ts`), that no answer
 *    carries a credential, that the record belongs to the business named in the
 *    route, and that every changed answer is attributed to the person writing
 *    it. What each question accepts stays the desktop host's rule
 *    (`validateAnswer`), so a questionnaire revision never needs a Worker deploy.
 * 2. **Revisions are compare-and-set.** A write names the revision it was made
 *    from. Anything else is a conflict the writer is told about, never a last
 *    write that wins. Every revision is kept: an owner transfer or a correction
 *    adds one, it never rewrites one.
 * 3. **Failing to load is not "not started".** `decideSetupLoad` keeps four
 *    outcomes apart: the service's answer, a tagged copy shown while the service
 *    cannot be reached, a load error when there is no usable copy, and a refusal.
 *    A refusal never falls back to the copy, so a cached setup cannot outlive a
 *    revoked membership.
 *
 * Pure and dependency-free: no clock, no filesystem, no network, no schema
 * library. The account service's Worker bundles this file.
 */
import { containsSecretLikeText, type BusinessAnswer, type BusinessSetup, type SetupState } from './business-setup.js';

export const ORGANIZATION_SETUP_CONTRACT_VERSION = 1 as const;

/** The service's bounds. Wider than the intake's own, so they only catch a record no intake could make. */
export const SETUP_RECORD_LIMITS = Object.freeze({
  answers: 64,
  text: 2_000,
  choices: 32,
  choice: 64,
  prompt: 400,
  revision: 1_000_000,
});

/** Every state a stored record may name: the whole lifecycle, not only what this build reaches. */
export const SETUP_RECORD_STATES: readonly SetupState[] = Object.freeze([
  'not-started',
  'drafting',
  'proposal-ready',
  'validating',
  'needs-approval',
  'rehearsing',
  'ready-to-activate',
  'active',
  'blocked',
  'paused',
  'superseded',
]);

/** What the account service keeps for one organization, per revision. */
export interface OrganizationSetupRecord {
  v: typeof ORGANIZATION_SETUP_CONTRACT_VERSION;
  setup: BusinessSetup;
}

/** A write: the record, and the revision it was made from (0 when the service had none). */
export interface OrganizationSetupWrite {
  expectedRevision: number;
  record: OrganizationSetupRecord;
}

/** The service's answer to a read or a write. Revision 0 means nothing is stored yet. */
export interface OrganizationSetupAnswer {
  organizationId: string;
  tenantId: string;
  revision: number;
  record: OrganizationSetupRecord | null;
  writtenAt: string | null;
  writtenBy: string | null;
}

// --- what the service refuses beyond shape -----------------------------------------

export type SetupRecordRefusalCode = 'wrong-organization' | 'secret-like' | 'attribution';

export interface SetupRecordRefusal {
  code: SetupRecordRefusalCode;
  message: string;
}

function strings(record: OrganizationSetupRecord): string[] {
  const out: string[] = [];
  for (const answer of Object.values(record.setup.answers)) {
    if (typeof answer.value === 'string') out.push(answer.value);
    if (Array.isArray(answer.value)) out.push(...answer.value);
    if (answer.prompt) out.push(answer.prompt);
  }
  return out;
}

function sameAnswer(a: BusinessAnswer, b: BusinessAnswer) {
  return (
    JSON.stringify([a.value, a.unknown, a.origin, a.at, a.by, a.prompt ?? null]) ===
    JSON.stringify([b.value, b.unknown, b.origin, b.at, b.by, b.prompt ?? null])
  );
}

/**
 * Whether the service may store this record as the next revision.
 *
 * `writer` is the verified person making the write, never a field of the
 * request. A changed or new answer must name them: a record cannot put words in
 * another person's mouth. Who started the setup, and when, is history, so it
 * cannot change once stored. Unchanged answers keep whoever gave them, which is
 * how an owner transfer preserves the previous owner's answers as theirs.
 */
export function screenSetupRecord(
  record: OrganizationSetupRecord,
  context: {
    organizationId: string;
    tenantId: string;
    writer: string;
    previous: OrganizationSetupRecord | null;
  },
): SetupRecordRefusal | null {
  if (record.setup.organizationId !== context.organizationId || record.setup.tenantId !== context.tenantId)
    return { code: 'wrong-organization', message: 'This setup belongs to a different business.' };
  if (strings(record).some((text) => containsSecretLikeText(text)))
    return {
      code: 'secret-like',
      message: 'An answer looks like a key, password or card number. Setup answers cannot hold credentials.',
    };
  const before = context.previous?.setup ?? null;
  if (before && (before.startedBy !== record.setup.startedBy || before.startedAt !== record.setup.startedAt))
    return { code: 'attribution', message: 'Who started this setup, and when, cannot be changed.' };
  if (!before && record.setup.startedBy !== context.writer)
    return { code: 'attribution', message: 'A new setup is started by the person saving it.' };
  for (const [id, answer] of Object.entries(record.setup.answers)) {
    const old = before?.answers[id];
    if (old && sameAnswer(old, answer)) continue;
    if (answer.by !== context.writer)
      return { code: 'attribution', message: 'A changed answer is recorded as given by the person saving it.' };
  }
  return null;
}

// --- what a computer does when it opens a business's setup ---------------------------

/** What asking the service produced, as the desktop's client reports it. */
export type SetupFetchOutcome =
  | { kind: 'answered'; answer: OrganizationSetupAnswer }
  /** The service said this person may not read it (signed out, not a member). */
  | { kind: 'refused'; code: string; message: string }
  /** The service could not be reached, or failed. Nothing is known about the setup. */
  | { kind: 'unreachable'; message: string }
  /**
   * The service answered, but keeps no business setups: a Worker from before
   * migration 008. The setup stays on this computer, exactly as it did before
   * this contract, so a desktop and a Worker can ship in either order.
   */
  | { kind: 'unsupported' };

/** What a write produced. */
export type SetupWriteOutcome =
  | { kind: 'written'; answer: OrganizationSetupAnswer }
  /** Someone else saved a revision first. Nothing was written. */
  | { kind: 'conflict'; message: string }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unreachable'; message: string }
  | { kind: 'unsupported' };

/**
 * The tag a computer keeps beside its copy of the setup. A copy is used only by
 * the person, business, tenant and access generation it was fetched under.
 */
export interface SetupCacheTag {
  v: 1;
  organizationId: string;
  tenantId: string;
  personId: string;
  /** This computer's access generation for the business when the copy was taken. */
  generation: number;
  /** The service revision the copy is. */
  revision: number;
  fetchedAt: string;
}

export interface SetupCopy {
  tag: SetupCacheTag | null;
  setup: BusinessSetup | null;
}

export const SETUP_UNREACHABLE_REASON =
  "The account service can't be reached, so this business's saved setup couldn't be loaded. Try again when the connection is back.";

export const SETUP_CACHED_REASON =
  "The account service can't be reached. This is the setup as this computer last saw it; changes wait until the service answers.";

export type SetupLoad =
  /** The service answered. `setup` is null when it holds none. */
  | { kind: 'service'; revision: number; setup: BusinessSetup | null; writtenAt: string | null; writtenBy: string | null }
  /** The service could not be reached; this computer's tagged copy is shown read-only. */
  | { kind: 'cache'; revision: number; setup: BusinessSetup; fetchedAt: string; reason: string }
  /** The service could not be reached and there is no copy this person may use. Never a blank setup. */
  | { kind: 'load-error'; reason: string }
  /** The service refused. A copy is never used in its place. */
  | { kind: 'refused'; code: string; reason: string }
  /** The service keeps no setups yet: this computer's own setup, as before ORG-01. */
  | { kind: 'local'; setup: BusinessSetup | null };

/**
 * The one decision about what an organization's setup is on this computer now.
 *
 * A copy without a tag is a setup saved before this contract, on this computer
 * only. It is never shown in place of the service, and never treated as the
 * organization's: the caller may offer it as revision 1, where the service's
 * compare-and-set and attribution rules decide.
 */
export function decideSetupLoad(input: {
  organizationId: string;
  tenantId: string;
  personId: string;
  generation: number;
  fetched: SetupFetchOutcome;
  copy: SetupCopy;
}): SetupLoad {
  const { fetched, copy } = input;
  if (fetched.kind === 'answered') {
    const { answer } = fetched;
    const setup = answer.record?.setup ?? null;
    if (
      answer.organizationId !== input.organizationId ||
      answer.tenantId !== input.tenantId ||
      (setup !== null && (setup.organizationId !== input.organizationId || setup.tenantId !== input.tenantId))
    )
      return { kind: 'load-error', reason: 'The account service answered for a different business.' };
    return { kind: 'service', revision: answer.revision, setup, writtenAt: answer.writtenAt, writtenBy: answer.writtenBy };
  }
  if (fetched.kind === 'refused') return { kind: 'refused', code: fetched.code, reason: fetched.message };
  const { tag, setup } = copy;
  // Before the service kept setups, this computer's file was the setup, and it
  // still is while the service keeps none (including after a Worker rollback).
  if (fetched.kind === 'unsupported') return { kind: 'local', setup };
  const usable =
    tag !== null &&
    setup !== null &&
    tag.organizationId === input.organizationId &&
    tag.tenantId === input.tenantId &&
    tag.personId === input.personId &&
    tag.generation === input.generation &&
    tag.revision > 0 &&
    setup.organizationId === input.organizationId &&
    setup.tenantId === input.tenantId;
  if (!usable) return { kind: 'load-error', reason: SETUP_UNREACHABLE_REASON };
  return { kind: 'cache', revision: tag.revision, setup, fetchedAt: tag.fetchedAt, reason: SETUP_CACHED_REASON };
}
