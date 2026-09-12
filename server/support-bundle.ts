import os from 'node:os';
import { secretScrubber } from './secrets.js';
import type { IntegrationStatus, ProjectState } from '../shared/types.js';

// A support bundle is pasted into tickets and chats, where the writer loses
// control of it. Facts travel; anything that could grant access stays home.
export interface SupportBundle {
  readonly generatedAt: string;
  readonly app: { name: 'Diomedes'; version: string; protocolVersions: { work: 1; approval: 1; rule: 1 } };
  readonly host: { platform: string; arch: string; node: string; osRelease: string; locale: string; timeZone: string };
  readonly paths: { dataDir: string; projectRoot: string; port: number };
  readonly engines: { id: string; found: boolean; available: boolean; installedVersion?: string; status: string }[];
  readonly project: { id: string; name: string; tasks: number; sessions: number; openNeeds: number; historyEntries: number } | null;
  readonly recentErrors: string[];
  readonly excluded: string[];
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
];

// Caps keep a pasted bundle readable and stop a long log tail from smuggling bulk.
const MAX_ENGINES = 20;
const MAX_ERRORS = 20;
const MAX_ERROR_CHARS = 500;

export function buildSupportBundle(input: {
  version: string; dataDir: string; projectRoot: string; port: number;
  engines: IntegrationStatus[]; state: ProjectState | null;
  recentErrors: string[]; secrets: Iterable<string>; now?: () => string;
}): SupportBundle {
  const scrub = secretScrubber(input.secrets);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  // Tilde keeps a path useful for diagnosis without naming the account behind it.
  const clean = (text: string) => {
    const scrubbed = scrub(text);
    return home ? scrubbed.split(home).join('~') : scrubbed;
  };
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    app: { name: 'Diomedes', version: clean(input.version), protocolVersions: { work: 1, approval: 1, rule: 1 } },
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
    // Counts only: the bundle says how much history exists, never what it says.
    project: input.state ? {
      id: clean(input.state.project.id),
      name: clean(input.state.project.name),
      tasks: input.state.tasks.length,
      sessions: input.state.sessions.length,
      openNeeds: input.state.needs.filter((need) => need.state === 'open').length,
      historyEntries: input.state.history.length,
    } : null,
    recentErrors: input.recentErrors.slice(-MAX_ERRORS).map((line) => clean(line).slice(0, MAX_ERROR_CHARS)),
    excluded: [...EXCLUDED],
  };
}

// Plain lines for a Copy button: readable without Diomedes, pasteable anywhere.
export function renderSupportBundle(bundle: SupportBundle): string {
  const lines = [
    'Diomedes support bundle',
    `generated: ${bundle.generatedAt}`,
    `app: Diomedes ${bundle.app.version} (work ${bundle.app.protocolVersions.work}, approval ${bundle.app.protocolVersions.approval}, rule ${bundle.app.protocolVersions.rule})`,
    `host: ${bundle.host.platform}/${bundle.host.arch} ${bundle.host.node} ${bundle.host.osRelease} ${bundle.host.locale} ${bundle.host.timeZone}`,
    `data dir: ${bundle.paths.dataDir}`,
    `project root: ${bundle.paths.projectRoot}`,
    `port: ${bundle.paths.port}`,
    ...bundle.engines.map((engine) =>
      `engine ${engine.id}: found=${engine.found ? 'yes' : 'no'} available=${engine.available ? 'yes' : 'no'}${
        engine.installedVersion ? ` version=${engine.installedVersion}` : ''
      } status=${engine.status}`,
    ),
    ...(bundle.project
      ? [`project ${bundle.project.name} (${bundle.project.id}): tasks=${bundle.project.tasks} sessions=${bundle.project.sessions} open needs=${bundle.project.openNeeds} history entries=${bundle.project.historyEntries}`]
      : []),
    ...bundle.recentErrors.map((line) => `error: ${line}`),
    ...bundle.excluded.map((sentence) => `not included: ${sentence}`),
  ];
  return lines.join('\n');
}
