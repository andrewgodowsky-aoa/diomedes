/**
 * Every durable file family Diomedes writes into its data folder, with the
 * version this build writes and how an older one is carried forward (H21).
 *
 * A family marked `throughFramework` is read through `migrateRecord` or
 * `openVersionedFile`, so a newer file is refused with the file untouched and
 * an older one is carried forward with a backup kept beside it. The others
 * still check their version in their own reader; each names where, and
 * `docs/implementation/2026-09-24-h21-migrations-perf.md` lists what wiring
 * them needs. Adding a family, or bumping one, starts here: a version bump
 * without a migration from the previous version fails `tests/migrations.test.ts`.
 */
import { HARNESS_CONTRACT_VERSION } from '../../shared/harness.js';
import { AUTOMATION_DEFINITION_VERSION, OCCURRENCES_FILE_VERSION } from '../../shared/automations.js';
import type { DurableFamily } from './framework.js';

const family = (value: DurableFamily) => Object.freeze(value);
const single = { oldest: 1, current: 1, migrations: {} } as const;

export const SETTINGS = family({
  id: 'settings',
  title: 'settings file',
  location: 'settings.json',
  versionField: 'version',
  ...single,
  // Every settings file ever written carries `version: 1`; the in-place
  // normalisations in `migrateSettings` are within version 1.
  unversioned: 1,
  reader: { file: 'server/store.ts', throughFramework: true },
});

export const PROJECT_STATE = family({
  id: 'project-state',
  title: 'project record',
  location: 'projects/*/state.json',
  versionField: 'schemaVersion',
  ...single,
  // Written without a version until H21. Those files are version 1, and the
  // additive normalisations in `Store.init` (conversations, team, sharing)
  // stay within it.
  unversioned: 1,
  reader: { file: 'server/store.ts', throughFramework: true },
});

export const HARNESS_RUN = family({
  id: 'harness-run',
  title: 'saved run',
  location: 'projects/*/harness/runs/*.json',
  versionField: 'v',
  oldest: 1,
  current: HARNESS_CONTRACT_VERSION,
  migrations: {},
  unversioned: null,
  reader: { file: 'server/harness/run-store.ts', throughFramework: true },
});

export const AUTOMATION_OCCURRENCES = family({
  id: 'automation-occurrences',
  title: 'automation record',
  location: 'workspaces/automations/*.json',
  versionField: 'v',
  oldest: 1,
  current: OCCURRENCES_FILE_VERSION,
  migrations: {
    // Milestone A files hold manual occurrences only. Version 2 may also hold
    // scheduled ones, which a Milestone A build must refuse rather than
    // misread; the occurrences themselves are unchanged.
    1: (record) => ({ ...record, v: 2 }),
  },
  unversioned: null,
  reader: { file: 'server/automations.ts', throughFramework: true },
});

export const AUTOMATION_DEFINITIONS = family({
  id: 'automation-definitions',
  title: 'automation definition',
  location: 'workspaces/automations/definitions/*.json',
  versionField: 'v',
  oldest: 1,
  current: AUTOMATION_DEFINITION_VERSION,
  migrations: {},
  unversioned: null,
  reader: { file: 'server/automation-definitions.ts', throughFramework: true },
});

export const PACK_STORE = family({
  id: 'pack-store',
  title: 'pack store',
  location: 'packs/store.json',
  versionField: 'schemaVersion',
  ...single,
  unversioned: null,
  reader: { file: 'server/pack-lifecycle.ts', throughFramework: true },
});

export const READY_QUEUE = family({
  id: 'ready-queue',
  title: 'Ready queue pause',
  location: 'ready-queue.json',
  versionField: 'version',
  ...single,
  unversioned: null,
  reader: { file: 'server/ready-scheduler.ts', throughFramework: true },
});

/** Families whose reader still checks its own version. Listed so nothing durable is unaccounted for. */
const own = (id: string, title: string, location: string, versionField: string, file: string, note: string) =>
  family({
    id,
    title,
    location,
    versionField,
    ...single,
    unversioned: null,
    reader: { file, throughFramework: false, note },
  });

export const DURABLE_FAMILIES: readonly DurableFamily[] = Object.freeze([
  SETTINGS,
  PROJECT_STATE,
  HARNESS_RUN,
  AUTOMATION_OCCURRENCES,
  AUTOMATION_DEFINITIONS,
  PACK_STORE,
  READY_QUEUE,
  family({
    id: 'project-registry',
    title: 'project list',
    location: 'registry.json',
    versionField: 'version',
    ...single,
    unversioned: 1,
    reader: {
      file: 'server/store.ts',
      throughFramework: false,
      note: 'A bare array with nowhere to carry a version; each row is checked by shape. Needs an envelope before its first bump.',
    },
  }),
  family({
    id: 'write-journal',
    title: 'prepared write',
    location: 'pending/*.json',
    versionField: 'version',
    ...single,
    unversioned: 1,
    reader: {
      file: 'server/store.ts',
      throughFramework: false,
      note: 'Short-lived: recovery replays and removes it. Its embedded project record is checked by the same validators as state.json.',
    },
  }),
  own('automation-host', 'automation host', 'workspaces/automation-host.json', 'v', 'server/automations.ts',
    'An unreadable host record is replaced by a new one; it holds only a host id and a heartbeat.'),
  own('job-caps', 'job caps', 'job-caps.json', 'v', 'server/job-caps.ts', 'Refuses any v other than 1.'),
  own('managed-allowance', 'managed allowance', 'allowance/*.json', 'v', 'server/managed-usage.ts',
    'Refuses any v other than 1, per organization.'),
  own('workspace-configuration', 'workspace configuration', 'workspaces/configuration/*.json', 'v',
    'server/configuration.ts', 'Refuses any v other than 1, per organization.'),
  own('spend-exposure', 'spend exposure ledger', 'spend-exposure/*.json', 'v', 'server/spend-exposure.ts',
    'Refuses any v other than 1.'),
  own('change-review', 'change review ledger', 'change-review/*/*.json', 'v', 'server/change-review/service.ts',
    'Written as v 1.'),
  own('discovery', 'discovery record', 'prospects/discovery/*.json', 'v', 'server/discovery/service.ts',
    'Refuses any v other than 1.'),
  own('customization-benefit', 'customization benefit', 'benefits/*.json', 'v', 'server/customization-benefit.ts',
    'Written as v 1.'),
  own('billing-events', 'billing events', 'billing/*.json', 'v', 'server/billing-events.ts', 'Written as v 1.'),
  own('engine-bindings', 'engine bindings', 'engines/bindings.json', 'version', 'server/engines/binding-store.ts',
    'Validated by schema with version 1.'),
  own('engine-verification', 'engine verification receipts', 'engines/receipts.json', 'version',
    'server/engines/verification.ts', 'Validated by schema with version 1.'),
  own('approved-read-servers', 'approved read servers', 'read-connectors.json', 'version',
    'server/engines/read-connector-routes.ts', 'Validated by schema with version 1.'),
  own('aws-bedrock-connection', 'AWS Bedrock connection', 'connections/aws-bedrock.json', 'v',
    'server/engines/aws-bedrock.ts', 'Validated by schema with v 1.'),
]);

export function durableFamily(id: string): DurableFamily {
  const found = DURABLE_FAMILIES.find((item) => item.id === id);
  if (!found) throw new Error(`No durable family is registered as ${id}.`);
  return found;
}
