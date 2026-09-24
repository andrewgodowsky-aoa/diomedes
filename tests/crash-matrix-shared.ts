/** What `tests/crash-matrix.test.ts` and its child process agree on. Every id here is invented. */
import type { TriggerOccurrence } from '../shared/automations.js';
import { occurrenceIdFor, runIdFor } from '../server/automations.js';

export type CrashBoundary =
  | 'object-write'
  | 'journal-append'
  | 'project-file'
  | 'state-temp'
  | 'state-rename'
  | 'journal-unlink'
  | 'occurrence-temp'
  | 'occurrence-rename'
  | 'migration-backup'
  | 'migration-rewrite'
  | 'claim-temp'
  | 'claim-rename';

export const CRASH_TEXT = {
  zero: '# Notes\n',
  one: '# Notes\n\nFirst acknowledged line.\n',
  two: '# Notes\n\nFirst acknowledged line.\nSecond line, in flight when the process died.\n',
} as const;

export const crashOccurrence = (commandId: string): TriggerOccurrence => {
  const id = occurrenceIdFor('org_crash', commandId);
  return {
    v: 1,
    id,
    automationId: 'brief:org_crash',
    organizationId: 'org_crash',
    tenantId: 'tenant_org_crash',
    trigger: { kind: 'manual', commandId, payloadDigest: `sha256:${'0'.repeat(64)}`, requestedBy: 'person_a' },
    configuration: { revision: 1, digest: 'sha256:x' },
    target: { projectId: 'P1', projectName: 'Books' },
    sources: null,
    observedAt: '2026-09-24T09:00:00.000Z',
    admission: { state: 'admitting', runId: runIdFor(id) },
  };
};
