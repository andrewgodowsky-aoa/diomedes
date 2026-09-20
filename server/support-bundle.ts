import os from 'node:os';
import { baselineRedact, secretScrubber } from './secrets.js';
import { currentBuildIdentity, type BuildIdentity } from './build-identity.js';
import { SETUP_STAGES, type EngineConnection, type SetupStage } from '../shared/engines.js';
import type { InstallationContext } from '../shared/engines.js';
import type { CandidateSource } from '../shared/connection-policy.js';
import type { IntegrationStatus, ProjectState } from '../shared/types.js';

// A support bundle is pasted into tickets and chats, where the writer loses
// control of it. Facts travel; anything that could grant access stays home.
export interface SupportBundle {
  readonly generatedAt: string;
  readonly app: {
    name: 'Diomedes';
    version: string;
    protocolVersions: { work: 1; approval: 1; rule: 1 };
    /** Which build is running, from the record a packaged build ships. */
    build: SupportBundleBuild | null;
    /** The executable this process was launched from: a stale shortcut shows here. */
    launchTarget: string | null;
  };
  readonly host: { platform: string; arch: string; node: string; osRelease: string; locale: string; timeZone: string };
  readonly paths: { dataDir: string; projectRoot: string; port: number };
  readonly engines: { id: string; found: boolean; available: boolean; installedVersion?: string; status: string }[];
  /** What each route's connection looks like: where it resolved and where it failed. */
  readonly connections: SupportBundleConnection[];
  readonly project: { id: string; name?: string; tasks: number; sessions: number; openNeeds: number; historyEntries: number } | null;
  readonly recentErrors: string[];
  readonly excluded: string[];
}

/** The build identity, minus the launch target the app section carries once. */
export type SupportBundleBuild = Omit<BuildIdentity, 'launchTarget'>;

/**
 * One route's connection, reduced to the facts that decide a first-run failure.
 * Identifiers, counts and codes: no executable path, no account name, no model
 * description and no adapter output.
 */
export interface SupportBundleConnection {
  readonly engine: string;
  readonly installation: string;
  readonly compatibility: string;
  readonly authentication: string;
  /** Of the bound installation, or of the one Diomedes would offer. */
  readonly candidateSource: CandidateSource | null;
  readonly candidates: number;
  readonly bound: boolean;
  readonly bindingOrigin: 'explicit' | 'adopted' | null;
  readonly installedVersion: string | null;
  readonly provenance: 'reviewed-release' | 'unverified' | null;
  readonly context: InstallationContext | null;
  readonly accountRoute: string | null;
  readonly routeIssue: { required: string; connected: string[] } | null;
  readonly models: number;
  readonly selectedModel: string | null;
  readonly revision: number | null;
  /** The revision a real result last proved, which is not always the current one. */
  readonly verifiedRevision: number | null;
  readonly lastVerifiedAt: string | null;
  readonly diagnostic: {
    stage: SetupStage | null;
    code: string | null;
    correlationId: string | null;
    at: string | null;
  } | null;
}

// Each sentence names one thing the bundle refuses to carry, so a reader can
// trust what is missing as well as what is present.
const EXCLUDED = [
  'Environment variables are not included.',
  'Credential files are not included.',
  'Tokens are not included.',
  'API keys are not included.',
  'Document contents are not included.',
  'Prompts are not included.',
  'Model output is not included.',
  'History file bodies are not included.',
  // Scoped to the connection rows on purpose. A recorded error message is a
  // runtime string this file does not compose, and a failed launch can put an
  // executable path inside one, so a flat "no paths" sentence would be false
  // in exactly the failure a person exports this bundle to explain.
  'Connection rows carry no executable path.',
  'Connection rows carry account route identifiers, not account names.',
];
// Paths and a project name can still name a person, so the bundle is not
// anonymous and does not say it is. The name is the part a person chooses.
const PROJECT_NAME_EXCLUDED = 'The project name is not included.';

// Caps keep a pasted bundle readable and stop a long log tail from smuggling bulk.
const MAX_ENGINES = 20;
const MAX_ERRORS = 20;
const MAX_ERROR_CHARS = 500;
const MAX_FIELD_CHARS = 120;
const MAX_CODE_CHARS = 80;
const MAX_ROUTE_PROVIDERS = 10;

const CANDIDATE_SOURCES: Record<CandidateSource, true> = { managed: true, manual: true, system: true };
const PROVENANCES: Record<'reviewed-release' | 'unverified', true> = {
  'reviewed-release': true,
  unverified: true,
};
const CONTEXTS: Record<InstallationContext, true> = {
  'windows-native': true,
  'posix-native': true,
  wsl: true,
  'desktop-app': true,
};
const ORIGINS: Record<'explicit' | 'adopted', true> = { explicit: true, adopted: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildSupportBundle(input: {
  version: string; dataDir: string; projectRoot: string; port: number;
  engines: IntegrationStatus[]; state: ProjectState | null;
  recentErrors: string[]; secrets: Iterable<string>;
  /**
   * Host-observed connections. Typed as the contract, validated as if they were
   * not: this function is the last place before the text leaves the computer.
   */
  connections?: readonly EngineConnection[];
  /** `settings.services`, for the model a person selected per route. */
  services?: Record<string, unknown>;
  /** Off by default; the project section is counts and an opaque id without it. */
  includeProjectName?: boolean;
  /** Omit for the running build; pass `null` to state that none is known. */
  build?: BuildIdentity | null;
  now?: () => string;
}): SupportBundle {
  const scrub = secretScrubber(input.secrets);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  // Tilde keeps a path useful for diagnosis without naming the account behind it.
  const clean = (text: string) => {
    const scrubbed = scrub(text);
    return home ? scrubbed.split(home).join('~') : scrubbed;
  };
  /**
   * One string from a connection. Adapters report strings Diomedes did not
   * write and whose secret inventory it does not hold, so the pattern floor runs
   * first, then the literal scrub, then the length cap.
   */
  const field = (value: unknown, max = MAX_FIELD_CHARS): string | null =>
    typeof value === 'string' && value.trim() !== ''
      ? clean(baselineRedact(value)).slice(0, max)
      : null;
  const oneOf = <T extends string>(value: unknown, allowed: Record<T, true>): T | null =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(allowed, value)
      ? (value as T)
      : null;
  const integer = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const timestamp = (value: unknown): string | null =>
    typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
      ? clean(value)
      : null;
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const identity = input.build === undefined ? currentBuildIdentity(input.version) : input.build;
  const build: SupportBundleBuild | null = identity
    ? {
        version: clean(identity.version),
        commit: identity.commit,
        builtAt: identity.builtAt,
        channel: clean(identity.channel),
        signing: identity.signing === null ? null : clean(identity.signing),
        sourceStatus: identity.sourceStatus,
        packaged: identity.packaged,
        source: identity.source,
        buildId: clean(identity.buildId),
      }
    : null;
  return {
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    app: {
      name: 'Diomedes',
      version: clean(input.version),
      protocolVersions: { work: 1, approval: 1, rule: 1 },
      build,
      launchTarget: identity ? clean(identity.launchTarget) : null,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: clean(os.release()),
      locale: clean(resolved.locale || 'unknown'),
      timeZone: clean(resolved.timeZone ?? 'unknown'),
    },
    paths: { dataDir: clean(input.dataDir), projectRoot: clean(input.projectRoot), port: input.port },
    engines: input.engines.slice(0, MAX_ENGINES).map((engine) => {
      const status = clean(engine.status);
      const detail = clean(engine.detail);
      return {
        id: engine.id,
        found: engine.found,
        available: engine.available,
        // The diagnostic sentence rides along in status so it is scrubbed too.
        ...(engine.installedVersion ? { installedVersion: clean(engine.installedVersion) } : {}),
        status: detail && detail !== status ? `${status} — ${detail}` : status,
      };
    }),
    // Named fields only, read one at a time: an unknown field on a connection is
    // dropped rather than carried, whatever put it there.
    connections: (input.connections ?? []).slice(0, MAX_ENGINES).map((value) => {
      const row: Record<string, unknown> = isRecord(value) ? value : {};
      const engine = field(row.engine, 40) ?? 'unknown';
      const candidates = Array.isArray(row.candidates) ? row.candidates.filter(isRecord) : [];
      const binding = isRecord(row.binding) ? row.binding : null;
      const chosen =
        (binding && candidates.find((row) => row.id === binding.id)) ??
        (typeof row.recommendedCandidateId === 'string'
          ? candidates.find((entry) => entry.id === row.recommendedCandidateId)
          : undefined) ??
        null;
      const issue = isRecord(row.routeIssue) ? row.routeIssue : null;
      const required = issue ? field(issue.required) : null;
      const receipt = isRecord(row.verification) ? row.verification : null;
      const diagnostic = isRecord(row.diagnostic) ? row.diagnostic : null;
      const stage = typeof row.diagnostic === 'object' && diagnostic
        ? (SETUP_STAGES as readonly string[]).includes(String(diagnostic.stage))
          ? (diagnostic.stage as SetupStage)
          : null
        : null;
      // A model belongs to a route by the key the settings screen writes.
      const services = input.services;
      const selected =
        services && Object.prototype.hasOwnProperty.call(services, `${engine}Model`)
          ? services[`${engine}Model`]
          : null;
      return {
        engine,
        installation: field(row.installation, 40) ?? 'unknown',
        compatibility: field(row.compatibility, 40) ?? 'unknown',
        authentication: field(row.authentication, 40) ?? 'unknown',
        candidateSource:
          (binding ? oneOf(binding.source, CANDIDATE_SOURCES) : null) ??
          (chosen ? oneOf(chosen.source, CANDIDATE_SOURCES) : null),
        candidates: candidates.length,
        bound: binding !== null,
        bindingOrigin: binding ? oneOf(binding.origin, ORIGINS) : null,
        installedVersion:
          (chosen ? field(chosen.version, 40) : null) ??
          (binding ? field(binding.version, 40) : null) ??
          field(row.version, 40),
        provenance: chosen ? oneOf(chosen.provenance, PROVENANCES) : null,
        context: chosen ? oneOf(chosen.context, CONTEXTS) : null,
        accountRoute: field(row.accountRoute),
        routeIssue:
          issue && required
            ? {
                required,
                connected: (Array.isArray(issue.connected) ? issue.connected : [])
                  .slice(0, MAX_ROUTE_PROVIDERS)
                  .map((entry) => field(entry, MAX_CODE_CHARS))
                  .filter((entry): entry is string => entry !== null),
              }
            : null,
        models: Array.isArray(row.models) ? row.models.length : 0,
        selectedModel: field(selected),
        revision: integer(row.revision),
        verifiedRevision: receipt ? integer(receipt.revision) : null,
        lastVerifiedAt: receipt ? timestamp(receipt.verifiedAt) : null,
        diagnostic: diagnostic
          ? {
              stage,
              code: field(diagnostic.code, MAX_CODE_CHARS),
              correlationId: field(diagnostic.correlationId, MAX_CODE_CHARS),
              at: timestamp(diagnostic.at),
            }
          : null,
      };
    }),
    // Counts only: the bundle says how much history exists, never what it says.
    project: input.state ? {
      id: clean(input.state.project.id),
      ...(input.includeProjectName ? { name: clean(input.state.project.name) } : {}),
      tasks: input.state.tasks.length,
      sessions: input.state.sessions.length,
      openNeeds: input.state.needs.filter((need) => need.state === 'open').length,
      historyEntries: input.state.history.length,
    } : null,
    recentErrors: input.recentErrors.slice(-MAX_ERRORS).map((line) => clean(line).slice(0, MAX_ERROR_CHARS)),
    excluded: input.includeProjectName ? [...EXCLUDED] : [...EXCLUDED, PROJECT_NAME_EXCLUDED],
  };
}

// Plain lines for a Copy button: readable without Diomedes, pasteable anywhere.
export function renderSupportBundle(bundle: SupportBundle): string {
  const build = bundle.app.build;
  const lines = [
    'Diomedes support bundle',
    `generated: ${bundle.generatedAt}`,
    `app: Diomedes ${bundle.app.version} (work ${bundle.app.protocolVersions.work}, approval ${bundle.app.protocolVersions.approval}, rule ${bundle.app.protocolVersions.rule})`,
    build
      ? `build: ${build.buildId} source=${build.source} channel=${build.channel} signing=${build.signing ?? 'unknown'} sourceStatus=${build.sourceStatus ?? 'unknown'} packaged=${build.packaged ? 'yes' : 'no'} built=${build.builtAt ?? 'unknown'}`
      : 'build: not recorded',
    `launch target: ${bundle.app.launchTarget ?? 'unknown'}`,
    `host: ${bundle.host.platform}/${bundle.host.arch} ${bundle.host.node} ${bundle.host.osRelease} ${bundle.host.locale} ${bundle.host.timeZone}`,
    `data dir: ${bundle.paths.dataDir}`,
    `project root: ${bundle.paths.projectRoot}`,
    `port: ${bundle.paths.port}`,
    ...bundle.engines.map((engine) =>
      `engine ${engine.id}: found=${engine.found ? 'yes' : 'no'} available=${engine.available ? 'yes' : 'no'}${
        engine.installedVersion ? ` version=${engine.installedVersion}` : ''
      } status=${engine.status}`,
    ),
    ...bundle.connections.flatMap((connection) => {
      const facts = [
        `installation=${connection.installation}`,
        `compatibility=${connection.compatibility}`,
        `auth=${connection.authentication}`,
        `candidates=${connection.candidates}`,
        `bound=${connection.bound ? (connection.bindingOrigin ?? 'yes') : 'no'}`,
        ...(connection.candidateSource ? [`source=${connection.candidateSource}`] : []),
        ...(connection.installedVersion ? [`version=${connection.installedVersion}`] : []),
        ...(connection.provenance ? [`provenance=${connection.provenance}`] : []),
        ...(connection.context ? [`context=${connection.context}`] : []),
        `account route=${connection.accountRoute ?? 'none'}`,
        ...(connection.routeIssue
          ? [
              `route required=${connection.routeIssue.required}`,
              `route connected=${connection.routeIssue.connected.join(',') || 'none'}`,
            ]
          : []),
        `models=${connection.models}`,
        `selected model=${connection.selectedModel ?? 'none'}`,
        ...(connection.revision === null ? [] : [`revision=${connection.revision}`]),
        `last verified=${connection.lastVerifiedAt ?? 'never'}${
          connection.verifiedRevision === null ? '' : ` (revision ${connection.verifiedRevision})`
        }`,
      ];
      const rows = [`connection ${connection.engine}: ${facts.join(' ')}`];
      if (connection.diagnostic)
        rows.push(
          `diagnostic ${connection.engine}: stage=${connection.diagnostic.stage ?? 'unknown'} code=${
            connection.diagnostic.code ?? 'unknown'
          } correlation=${connection.diagnostic.correlationId ?? 'none'} at=${connection.diagnostic.at ?? 'unknown'}`,
        );
      return rows;
    }),
    ...(bundle.project
      ? [`project ${bundle.project.name ? `${bundle.project.name} (${bundle.project.id})` : bundle.project.id}: tasks=${bundle.project.tasks} sessions=${bundle.project.sessions} open needs=${bundle.project.openNeeds} history entries=${bundle.project.historyEntries}`]
      : []),
    ...bundle.recentErrors.map((line) => `error: ${line}`),
    ...bundle.excluded.map((sentence) => `not included: ${sentence}`),
  ];
  return lines.join('\n');
}
