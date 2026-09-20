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
  /**
   * The last failure, as it was recorded. Every field here is a fact from that
   * moment, not a current one: the row above says what is true now, and the two
   * disagree exactly when something changed after the failure.
   */
  readonly diagnostic: {
    stage: SetupStage | null;
    code: string | null;
    correlationId: string | null;
    at: string | null;
    buildId: string | null;
    candidateSource: CandidateSource | null;
    installedVersion: string | null;
    accountRoute: string | null;
    selectedModel: string | null;
    lastVerifiedAt: string | null;
  } | null;
}

// Each sentence names one thing the bundle refuses to carry, so a reader can
// trust what is missing as well as what is present. Every sentence here is a
// claim about this file's own code, so each one has to survive the worst string
// an adapter or an error could hand it — see `clean()` and `field()` below.
// Each is rendered after "not included:", so each reads as one.
const EXCLUDED = [
  // Nothing here is read from the environment. A tool that printed one of its
  // own variables into an error message is the case this cannot promise away,
  // which is why the client shows this text before anyone sends it.
  'Environment variables are not collected, though one a tool printed into an error can appear there.',
  'Credential files are not opened and no credential file content is collected.',
  // Held to known secret shapes: the scrubber removes every shape it knows
  // before a string is written, and a shape it does not know passes. The two
  // sentences here used to say "Tokens are not included." and "API keys are not
  // included." flat, which promised the filter nobody wrote. A reader who acts
  // on the promise rather than the preview is the person that sentence hurt, so
  // it now says what the code does and asks for the one thing that catches the
  // rest.
  "Tokens and API keys in the shapes Diomedes recognises. A shape it does not know can remain inside a tool's own error text, so read this bundle before you share it.",
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

/**
 * The bundle is a list of lines, and a reader trusts a line because of where it
 * sits. Runtime text carries whatever a tool wrote into it, so a newline inside
 * one field could forge a `not included:` promise or a second `build:` line, and
 * a bidi override could reorder what a person sees without changing the bytes.
 *
 * A newline becomes the two characters a reader can see, because the fact that
 * the text contained one is itself worth reporting. Everything else in the
 * control and override ranges is dropped. This runs before any length cap, so a
 * cap can never cut a sequence in half and leave the remainder.
 */
const NEWLINE = new RegExp('\\r\\n|[\\r\\n\\u2028\\u2029]', 'g');
const CONTROL = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);
const oneLine = (text: string) => text.replace(NEWLINE, '\\n').replace(CONTROL, '');

/**
 * The floor for text whose secret inventory nobody holds, over and above
 * `baselineRedact`: the same profile paths spelled in any case (Windows paths
 * are case-insensitive, and an 8.3 alias is a different spelling of the same
 * folder), and the secret shapes a tool is most likely to echo. A shape not
 * listed here is not removed, which is why the promises above say what they say.
 */
const FLOOR: readonly (readonly [RegExp, string])[] = [
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/:*?"<>|\s'"()]+/gi, '[home]'],
  [/\/Users\/[^/:'"()\s]+/gi, '[home]'],
  [/\/home\/[^/:'"()\s]+/gi, '[home]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  // A Google-style key: `AIza` and exactly 35 more characters. Written to its
  // own length because it carries no separator and no label, so a looser rule
  // here would start eating ordinary words out of an error message.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [
    /\b(api[-_ ]?keys?|tokens?|secrets?|passwords?|passphrases?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1$2[redacted]',
  ],
];

/**
 * Any spelling of one absolute path, in either separator and any case. The
 * trailing guard keeps `C:\Users\andre` from matching inside `C:\Users\andrew`,
 * which would replace one account's name with a tilde and leave the rest of
 * another account's name behind it.
 */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function homeExpression(home: string): RegExp | null {
  // Too short to be a profile directory, and short enough to match everything.
  if (home.length < 4) return null;
  const path = home.split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]+');
  return new RegExp(`${path}(?![A-Za-z0-9_.-])`, 'gi');
}

/**
 * A connection row promises it carries no executable path, so that promise is
 * enforced where the row is built rather than trusted of the fields it reads.
 */
// `.com` is left out: in an identifier field a host name is likelier than a
// DOS executable, and turning one into `[path]` would hide a real fact.
const EXECUTABLE = /\S*[\\/][^\\/\s"']*\.(?:exe|cmd|bat|ps1|psm1|msi|dll|sh|appx)\b/gi;

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
  const profile = homeExpression(home);
  /**
   * Every string that reaches the bundle goes through here, whoever wrote it.
   * In order: the literal inventory the caller holds, the line and override
   * normalisation, this account's own directory in any spelling, then the
   * pattern floor for the secrets and other people's paths nobody inventoried.
   *
   * Tilde keeps a path useful for diagnosis without naming the account behind
   * it; another profile becomes `[home]`, because naming it helps no one.
   */
  const clean = (text: string) => {
    let value = oneLine(scrub(text));
    if (profile) value = value.replace(profile, '~');
    value = baselineRedact(value);
    for (const [pattern, replacement] of FLOOR) value = value.replace(pattern, replacement);
    return value;
  };
  /**
   * One string from a connection: an identifier, a code or a version. These are
   * the fields a row is made of, so a value that spans lines is not one of them:
   * it is cut at the first break and the cut is said, rather than escaped and
   * carried. Free-running text — an error, an adapter's own detail — keeps its
   * content through `clean()`, where an escaped break can forge no line.
   */
  const field = (value: unknown, max = MAX_FIELD_CHARS): string | null => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const cut = NEWLINE.exec(value);
    NEWLINE.lastIndex = 0;
    const head = cut ? `${value.slice(0, cut.index)} [cut at a line break]` : value;
    return clean(head).replace(EXECUTABLE, '[path]').slice(0, max);
  };
  const oneOf = <T extends string>(value: unknown, allowed: Record<T, true>): T | null =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(allowed, value)
      ? (value as T)
      : null;
  const integer = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  // Cleaned before it is judged: a timestamp that needed scrubbing to become
  // one line is not a timestamp, and must not be read as one.
  const timestamp = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length > 40) return null;
    const text = clean(value);
    return text.length <= 40 && Number.isFinite(Date.parse(text)) ? text : null;
  };
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const identity = input.build === undefined ? currentBuildIdentity(input.version) : input.build;
  const build: SupportBundleBuild | null = identity
    ? {
        version: clean(identity.version),
        commit: identity.commit,
        builtAt: identity.builtAt === null ? null : clean(identity.builtAt),
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
      // An adapter writes both of these, so both are capped as well as cleaned:
      // a long tail would otherwise carry bulk into a pasted bundle.
      const status = clean(engine.status).slice(0, MAX_ERROR_CHARS);
      const detail = clean(engine.detail).slice(0, MAX_ERROR_CHARS);
      return {
        // An adapter writes this too, and it was the one such string that went
        // out unfiltered: a newline in it opened a line the bundle never wrote.
        id: clean(engine.id).slice(0, MAX_FIELD_CHARS),
        found: engine.found,
        available: engine.available,
        // The diagnostic sentence rides along in status so it is scrubbed too.
        ...(engine.installedVersion
          ? { installedVersion: clean(engine.installedVersion).slice(0, MAX_FIELD_CHARS) }
          : {}),
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
      const installation = field(row.installation, 40) ?? 'unknown';
      // Two repairs leave no current observation to report. A copy that failed
      // its integrity check has no version Diomedes trusts — `EngineService`
      // records that failure with no installed version — and a selected copy
      // that is gone leaves only the version the binding remembers, which is
      // what it was before. Printing either would state what the host refused
      // to; the version recorded with the failure is in `diagnostic`.
      //
      // Every other repair — the wrong version, a copy that changed, one that
      // no longer verifies — was probed just now, and that version is the fact
      // the support conversation turns on.
      const untrusted = installation === 'corrupt' || row.repair === 'selected-missing';
      return {
        engine,
        installation,
        compatibility: field(row.compatibility, 40) ?? 'unknown',
        authentication: field(row.authentication, 40) ?? 'unknown',
        candidateSource:
          (binding ? oneOf(binding.source, CANDIDATE_SOURCES) : null) ??
          (chosen ? oneOf(chosen.source, CANDIDATE_SOURCES) : null),
        candidates: candidates.length,
        bound: binding !== null,
        bindingOrigin: binding ? oneOf(binding.origin, ORIGINS) : null,
        installedVersion: untrusted
          ? null
          : ((chosen ? field(chosen.version, 40) : null) ??
            (binding ? field(binding.version, 40) : null) ??
            field(row.version, 40)),
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
        // The facts as the failure recorded them. A diagnostic answers "what was
        // true when this broke", and substituting today's values for its own
        // would answer a question nobody asked.
        diagnostic: diagnostic
          ? {
              stage,
              code: field(diagnostic.code, MAX_CODE_CHARS),
              correlationId: field(diagnostic.correlationId, MAX_CODE_CHARS),
              at: timestamp(diagnostic.at),
              buildId: field(diagnostic.buildId, MAX_CODE_CHARS),
              candidateSource: oneOf(diagnostic.candidateSource, CANDIDATE_SOURCES),
              installedVersion: field(diagnostic.installedVersion, 40),
              accountRoute: field(diagnostic.accountRoute),
              selectedModel: field(diagnostic.selectedModel),
              lastVerifiedAt: timestamp(diagnostic.lastVerifiedAt),
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
        `model selected in settings=${connection.selectedModel ?? 'none'}`,
        ...(connection.revision === null ? [] : [`revision=${connection.revision}`]),
        `last verified=${connection.lastVerifiedAt ?? 'never'}${
          connection.verifiedRevision === null ? '' : ` (revision ${connection.verifiedRevision})`
        }`,
      ];
      const rows = [`connection ${connection.engine}: ${facts.join(' ')}`];
      const failure = connection.diagnostic;
      if (failure)
        rows.push(
          `diagnostic ${connection.engine}: stage=${failure.stage ?? 'unknown'} code=${
            failure.code ?? 'unknown'
          } correlation=${failure.correlationId ?? 'none'} at=${failure.at ?? 'unknown'}` +
            // Labelled, because every value after this marker is what was true
            // when the failure happened and not what is true now.
            ` recorded then: build=${failure.buildId ?? 'unknown'} source=${
              failure.candidateSource ?? 'unknown'
            } version=${failure.installedVersion ?? 'not stated'} account route=${
              failure.accountRoute ?? 'none'
            } model=${failure.selectedModel ?? 'none'} last verified=${failure.lastVerifiedAt ?? 'never'}`,
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
