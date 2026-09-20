import type { ExternalEngine } from './types.js';

/**
 * One release-bound record of what Diomedes can drive, and how far each claim
 * has actually been carried.
 *
 * A hostile audit dated 2026-09-20 (F08) found the README, the release notes,
 * the website and the planning documents disagreeing about versions, account
 * routes and what is available. The repair is not another guide. It is one
 * generated file whose volatile facts come from the source of truth for each
 * one, and which keeps three states apart that prose kept collapsing:
 *
 * - `source` — the adapter is in this tree.
 * - `packaged` — a release evidence record names it.
 * - `cleanMachine` — it was installed and used on a machine other than the one
 *   that built it.
 *
 * None of the three is inferred from another. `packaged` is non-null only when
 * a release evidence record supplied by the caller names that route at the
 * reviewed version. `cleanMachine` is non-null only when the caller supplies an
 * evidence record of a clean-machine run. Today none exists, so every
 * `cleanMachine` is `null` and the field is still written, because an absent
 * field reads as an unasked question.
 *
 * This builder performs no IO and reads no clock. The caller supplies the
 * commit as `generatedFrom`, so the same tree produces the same bytes.
 */

export const CAPABILITY_RECORD_SCHEMA_VERSION = 1;

/** Whether the adapter for a route exists in the tree this record describes. */
export type SourceState = 'implemented' | 'not-implemented';

/** A recorded run of a published build on a machine that did not build it. */
export interface CleanMachineEvidence {
  /** A repository-relative path or a record id. Never a machine-local path. */
  evidence: string;
}

/** What a release evidence record states, reduced to the fields a reader needs. */
export interface ReleaseEvidenceInput {
  releaseId: string;
  appVersion: string;
  channel: string;
  /** The commit the release was built from. */
  baseCommit: string;
  recordedAt: string;
  installerFilename: string | null;
  installerSha256: string | null;
  applicationSigning: string | null;
  installerSigning: string | null;
  /** Repository-relative path of the evidence file itself, with forward slashes. */
  evidencePath: string;
  /** The reviewed tool versions that record names, per route. */
  engineVersions: Partial<Record<ExternalEngine, string>>;
}

export interface CapabilityRouteInput {
  engine: ExternalEngine;
  displayName: string;
  routeLabel: string;
  taskScope: string;
  reviewedVersion: string;
  /** Whether Diomedes offers a guided install of a pinned private copy. */
  guidedInstall: boolean;
  source: SourceState;
  cleanMachine: CleanMachineEvidence | null;
}

/** Evidence for the two proofs that are not per-route. Null while none exists. */
export interface CapabilityProofsInput {
  consentedProviderResult?: { evidence: string } | null;
  restartAndRepeat?: { evidence: string } | null;
}

export interface CapabilityRecordInput {
  appVersion: string;
  /** The commit this record was generated from. Supplied, never read here. */
  generatedFrom: string;
  routes: CapabilityRouteInput[];
  release: ReleaseEvidenceInput | null;
  proofs?: CapabilityProofsInput;
}

export interface PackagedState {
  release: string;
  note: string;
}

export interface CapabilityRouteRecord {
  engine: ExternalEngine;
  displayName: string;
  routeLabel: string;
  taskScope: string;
  reviewedVersion: string;
  guidedInstall: boolean;
  states: {
    source: SourceState;
    packaged: PackagedState | null;
    cleanMachine: CleanMachineEvidence | null;
  };
}

export interface ReleaseRecord {
  releaseId: string;
  appVersion: string;
  channel: string;
  baseCommit: string;
  recordedAt: string;
  installerFilename: string | null;
  installerSha256: string | null;
  signing: { application: string | null; installer: string | null };
  evidence: string;
  appVersionMatchesSource: boolean;
  note: string;
}

export interface CapabilityRecord {
  schemaVersion: number;
  kind: 'diomedes-capability-record';
  appVersion: string;
  generatedFrom: { commit: string; note: string };
  states: { source: string; packaged: string; cleanMachine: string };
  release: ReleaseRecord | null;
  routes: CapabilityRouteRecord[];
  notProven: string[];
}

const STATE_MEANINGS = {
  source: 'The code is in this source tree and its tests pass there.',
  packaged:
    'A release evidence record names this, so the code is inside a build someone can install.',
  cleanMachine:
    'That exact build was installed and used on a machine other than the one that built it.',
} as const;

const GENERATED_FROM_NOTE =
  'The commit checked out when this file was written. The commit that carries the file is its child.';

export function buildCapabilityRecord(input: CapabilityRecordInput): CapabilityRecord {
  const release = input.release;
  const routes = input.routes.map((route): CapabilityRouteRecord => {
    // Packaged is a fact about a release record, never about the source tree.
    // A release that does not name this route at this reviewed version says
    // nothing about it, and silence is not a yes.
    const named = release?.engineVersions[route.engine];
    const packaged: PackagedState | null =
      release && named === route.reviewedVersion
        ? {
            release: release.releaseId,
            note: `The release record names this reviewed tool version. It does not record a request through this route, and the adapter in that build is at commit ${release.baseCommit}.`,
          }
        : null;
    return {
      engine: route.engine,
      displayName: route.displayName,
      routeLabel: route.routeLabel,
      taskScope: route.taskScope,
      reviewedVersion: route.reviewedVersion,
      guidedInstall: route.guidedInstall,
      states: {
        source: route.source,
        packaged,
        cleanMachine: route.cleanMachine,
      },
    };
  });

  return {
    schemaVersion: CAPABILITY_RECORD_SCHEMA_VERSION,
    kind: 'diomedes-capability-record',
    appVersion: input.appVersion,
    generatedFrom: { commit: input.generatedFrom, note: GENERATED_FROM_NOTE },
    states: { ...STATE_MEANINGS },
    release: release
      ? {
          releaseId: release.releaseId,
          appVersion: release.appVersion,
          channel: release.channel,
          baseCommit: release.baseCommit,
          recordedAt: release.recordedAt,
          installerFilename: release.installerFilename,
          installerSha256: release.installerSha256,
          signing: { application: release.applicationSigning, installer: release.installerSigning },
          evidence: release.evidencePath,
          appVersionMatchesSource: release.appVersion === input.appVersion,
          note: 'This evidence is release-level, not route-level. It records build identity, installer bytes, reviewed tool versions and test counts. It records no request through any adapter route.',
        }
      : null,
    routes,
    notProven: notProven(routes, release, input.proofs ?? {}),
  };
}

/**
 * Each sentence is written only while its evidence is missing, so the record
 * stops saying a thing the day someone proves it.
 */
function notProven(
  routes: CapabilityRouteRecord[],
  release: ReleaseEvidenceInput | null,
  proofs: CapabilityProofsInput,
): string[] {
  const sentences: string[] = [];
  if (routes.some((route) => route.states.cleanMachine === null))
    sentences.push(
      'No clean Windows standard-user install of the exact published artifact has been run for any route.',
    );
  if (!proofs.consentedProviderResult)
    sentences.push('No real consented provider result through one of these routes is recorded here.');
  if (!proofs.restartAndRepeat)
    sentences.push(
      'No check that a route stays ready after a restart, and answers again, is recorded here.',
    );
  if (release && (release.installerSigning ?? '').toLowerCase() !== 'signed')
    sentences.push(
      'The published installer is unsigned, so a matching checksum proves the bytes and not the publisher.',
    );
  return sentences;
}
