/**
 * Deterministic verification for a change review.
 *
 * Checks are evidence, not judgment: each one scans known inputs and reports a
 * state — passed, failed, not-run, skipped or error — with the digest of what
 * it scanned, so a check that ran against an earlier version is visibly stale.
 *
 * What this never does: run project code. Tests, builds and linters execute
 * repository scripts, which is a Trust decision — so command checks exist only
 * as `not-run` rows naming why they did not run. The seam for an approved
 * command check is `plannedProjectChecks`; wiring it to `command-admission`
 * is a later, separately reviewed step, not a silent default.
 */

import { createHash } from 'node:crypto';
import {
  type ChangeEntry,
  type ChangeEvidenceRef,
  type ReviewCheck,
} from '../../shared/change-manifest.js';
import { containsSecretLikeText } from '../../shared/business-setup.js';
import { CONTENT_SCAN_LIMIT } from './rules.js';

const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})/m;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const SECRET_ASSIGNMENT =
  /(?:api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{16,}/i;

export interface CheckInput {
  readonly changes: readonly ChangeEntry[];
  readonly textFor: (path: string, side: 'before' | 'after') => string | null;
  /** Current content hash of a path, for staleness checks against recorded shas. */
  readonly currentSha: (path: string) => Promise<string | null>;
  readonly structuredRecords: readonly {
    id: string;
    malformed: readonly string[];
  }[];
  readonly ranAt: string;
  /** True when the Software Engineering pack is active for this project. */
  readonly softwarePack: boolean;
}

function digestInputs(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${part}\0`);
  return `sha256:${hash.digest('hex')}`;
}

/** Recorded object hashes are bare hex; live scans prefix 'sha256:'. Compare the digest itself. */
const bareSha = (sha: string | null): string | null =>
  sha === null ? null : sha.replace(/^sha256:/, '');

function evidenceOf(entries: readonly ChangeEntry[]): ChangeEvidenceRef[] {
  return entries.flatMap((entry) => entry.evidence.slice(0, 1)).slice(0, 8);
}

/**
 * The deterministic check set for one manifest build. Each check runs against
 * the same evidence the manifest reports and records its input digest.
 */
export async function runChecks(input: CheckInput): Promise<ReviewCheck[]> {
  const checks: ReviewCheck[] = [];
  const fileChanges = input.changes.filter((c) => c.source !== 'structured');
  const changed = fileChanges.filter((c) => c.kind !== 'unchanged');

  // --- diff integrity: recorded and observed hashes still match the files ---
  if (changed.length) {
    const started = Date.now();
    const mismatched: string[] = [];
    const unreadable: string[] = [];
    let error: string | null = null;
    try {
      for (const change of changed) {
        if (change.source === 'git') continue; // git state is reported as-read
        const current = await input.currentSha(change.path);
        if (change.kind === 'deleted') {
          if (current !== null) mismatched.push(change.path);
        } else if (current === null) unreadable.push(change.path);
        else if (change.afterSha !== null && bareSha(current) !== bareSha(change.afterSha))
          mismatched.push(change.path);
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The comparison could not finish.';
    }
    const parts = changed.map((c) => `${c.path}:${c.afterSha ?? 'none'}`);
    checks.push({
      id: 'diff-integrity',
      label: 'Recorded hashes match the files on disk',
      state: error
        ? 'error'
        : mismatched.length
          ? 'failed'
          : unreadable.length
            ? 'skipped'
            : 'passed',
      reason: error
        ? error
        : unreadable.length
          ? `${unreadable.length} ${unreadable.length === 1 ? 'file' : 'files'} could not be re-read`
          : null,
      detail: mismatched.length
        ? `${mismatched.length} ${mismatched.length === 1 ? 'file differs' : 'files differ'} from its recorded hash: ${mismatched.slice(0, 4).join(', ')}`
        : `${changed.length} ${changed.length === 1 ? 'file' : 'files'} compared`,
      inputDigest: digestInputs(parts),
      ranAt: error ? null : input.ranAt,
      durationMs: error ? null : Date.now() - started,
      evidence: evidenceOf(changed),
    });
  }

  // --- text scans over new content ------------------------------------------
  const scannable = changed.filter(
    (c) => c.kind !== 'deleted' && !c.binary && input.textFor(c.path, 'after') !== null,
  );
  if (scannable.length) {
    const started = Date.now();
    const markers = scannable.filter((c) =>
      CONFLICT_MARKER.test(input.textFor(c.path, 'after')!.slice(0, CONTENT_SCAN_LIMIT)),
    );
    const secrets = scannable.filter((c) => {
      const text = input.textFor(c.path, 'after')!.slice(0, CONTENT_SCAN_LIMIT);
      return (
        PEM_PRIVATE_KEY.test(text) || SECRET_ASSIGNMENT.test(text) || containsSecretLikeText(text)
      );
    });
    const inputDigest = digestInputs(
      scannable.map((c) => `${c.path}:${c.afterSha ?? 'unhashed'}`),
    );
    checks.push({
      id: 'conflict-scan',
      label: 'Merge-conflict marker scan',
      state: markers.length ? 'failed' : 'passed',
      reason: null,
      detail: markers.length
        ? `Markers found in ${markers.map((c) => c.path).slice(0, 4).join(', ')}`
        : `${scannable.length} ${scannable.length === 1 ? 'file' : 'files'} scanned`,
      inputDigest,
      ranAt: input.ranAt,
      durationMs: Date.now() - started,
      evidence: evidenceOf(markers.length ? markers : scannable),
    });
    checks.push({
      id: 'credential-scan',
      label: 'Credential-pattern scan of new text',
      state: secrets.length ? 'failed' : 'passed',
      reason: null,
      detail: secrets.length
        ? `Credential-like text in ${secrets.map((c) => c.path).slice(0, 4).join(', ')}`
        : `${scannable.length} ${scannable.length === 1 ? 'file' : 'files'} scanned`,
      inputDigest,
      ranAt: input.ranAt,
      durationMs: Date.now() - started,
      evidence: evidenceOf(secrets.length ? secrets : scannable),
    });
  }

  // --- structured record validity --------------------------------------------
  for (const record of input.structuredRecords) {
    checks.push({
      id: `structured-${record.id}`,
      label: `Structured record “${record.id}” parsed cleanly`,
      state: record.malformed.length ? 'failed' : 'passed',
      reason: null,
      detail: record.malformed.length ? record.malformed.slice(0, 3).join('; ') : 'All fields compared',
      inputDigest: digestInputs([record.id]),
      ranAt: input.ranAt,
      durationMs: null,
      evidence: [{ kind: 'structured', recordId: record.id, fieldPath: '*' }],
    });
  }

  // --- project commands: declared, never silently run --------------------------
  if (input.softwarePack) {
    for (const planned of plannedProjectChecks) {
      checks.push({
        id: planned.id,
        label: planned.label,
        state: 'not-run',
        reason:
          'Running project code is a Trust decision; automatic review does not execute scripts.',
        detail: null,
        inputDigest: null,
        ranAt: null,
        durationMs: null,
        evidence: [],
      });
    }
  }
  return checks;
}

/**
 * The checks a software project would normally run. Declared so the review can
 * say plainly that they did not run — wiring any of them to an approved
 * command admission is a separate Trust-bound slice.
 */
export const plannedProjectChecks = [
  { id: 'typecheck', label: 'TypeScript check' },
  { id: 'unit-tests', label: 'Unit tests' },
  { id: 'production-build', label: 'Production build' },
] as const;
