import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ProspectRehearsalService } from '../server/rehearsal/service.js';
import { loadIndustryVariantRegistry } from '../server/rehearsal/industry-registry.js';
import { overlayDigest } from '../server/rehearsal/prospect-configuration.js';
import { payloadDigest } from '../server/command-admission.js';
import { importExports, inspectImport } from '../server/file-imports.js';
import { ApiError } from '../server/paths.js';
import { hash, Store } from '../server/store.js';
import type { ConfigurationManifest } from '../shared/configuration.js';
import type { ProspectOverlay } from '../shared/rehearsal.js';

let root = '';
let store: Store;
let projectId = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'fd04-rehearsal-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  projectId = (await store.createProject('Synthetic prospect rehearsal')).id;
});

afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe('FD04 prospect rehearsal service', () => {
  test('records synthetic fixtures and brief as samples through the production weekly brief', async () => {
    const registry = await loadIndustryVariantRegistry({
      bundledRoot: path.join(process.cwd(), 'resources', 'industry-variants'),
    });
    const variant = registry.variants.get('restaurant-operations')!;
    const overlay: ProspectOverlay = {
      prospectId: 'prospect_550e8400-e29b-41d4-a716-446655440000',
      variantId: variant.id,
      revision: 4,
      business: { name: 'Harbor Street Kitchen' },
      locations: [],
      terminology: {},
      selection: ['weekly-summary.md'],
      policy: 'drafts-only',
    };
    const owner = {
      kind: 'prospect' as const,
      prospectId: overlay.prospectId,
      operatorId: 'operator-test',
    };
    const manifestCandidate = {
      v: 1,
      owner,
      organizationId: null,
      tenantId: null,
      revision: 4,
      digest: `sha256:${'c'.repeat(64)}`,
      state: 'active',
      proposal: {
        v: 1,
        owner,
        organizationId: null,
        tenantId: null,
        prospect: {
          recordId: 'record-1',
          recordDigest: `sha256:${'a'.repeat(64)}`,
          recordUpdatedAt: '2026-09-19T07:00:00.000Z',
          variantDigest: variant.digest,
          overlayDigest: overlayDigest(overlay),
          overlay,
          policy: 'drafts-only',
        },
        questionnaireRevision: 1,
        answersDigest: `sha256:${'b'.repeat(64)}`,
        previousConfigurationDigest: null,
        template: { id: 'diomedes.weekly-brief', version: '1.0.0', variantId: variant.id },
        agents: [],
        team: null,
        rules: [],
        requiredConnections: [],
        contextScopes: [
          {
            id: 'approved',
            kind: 'approved-files',
            label: 'Synthetic sources',
            selection: ['weekly-summary.md'],
            provenance: { source: 'template', why: 'Synthetic rehearsal.' },
          },
        ],
        modelPolicy: {
          routes: ['harness-runtime'],
          processing: 'local-only',
          fallbackAllowed: false,
          provenance: { source: 'template', why: 'Local deterministic rehearsal.' },
        },
        budget: {
          monthlyCapUsd: 0,
          sharesParentBudget: true,
          changeableBy: 'owner',
          provenance: { source: 'template', why: 'No model spend.' },
        },
        approvers: {
          proposedApprovers: ['operator-test'],
          humanRequired: ['everything'],
          everythingStops: true,
          provenance: { source: 'template', why: 'Operator review.' },
        },
        expectedOutputs: [
          {
            id: 'brief',
            label: 'Weekly operations brief',
            artifact: 'report.markdown',
            destination: 'weekly-operations-brief.md',
            reviewedBy: 'person-after-reviewer',
            provenance: { source: 'template', why: 'Draft output.' },
          },
        ],
        unresolved: [],
        createdAt: '2026-09-19T07:00:00.000Z',
        createdBy: 'operator-test',
        candidateOrigin: 'deterministic',
      },
      readiness: {
        ready: true,
        blocking: [],
        degraded: [],
        degradedPlan: null,
        checkedAt: '2026-09-19T07:00:00.000Z',
      },
      stagedAt: '2026-09-19T07:00:00.000Z',
      stagedBy: 'operator-test',
      activatedAt: '2026-09-19T07:01:00.000Z',
      activatedBy: 'operator-test',
      activationId: 'active-1',
      supersededAt: null,
      failureReason: null,
    } satisfies ConfigurationManifest;
    const manifest = {
      ...manifestCandidate,
      digest: payloadDigest(manifestCandidate.proposal),
    } satisfies ConfigurationManifest;
    const snapshot = {
      owner,
      name: 'Harbor Street Kitchen',
      answers: {},
      answersDigest: manifest.proposal.answersDigest,
      recordId: manifest.proposal.prospect!.recordId,
      recordDigest: manifest.proposal.prospect!.recordDigest,
      recordUpdatedAt: manifest.proposal.prospect!.recordUpdatedAt,
      overlay,
    };
    const currentAuthority = {
      resolve: async () => ({
        projectId,
        snapshot,
        manifest,
        variant,
      }),
    };

    const result = await new ProspectRehearsalService(store, currentAuthority).run({
      projectId,
      owner,
      route: 'synthetic',
      at: '2026-09-19T07:02:00.000Z',
    });
    expect(result.artifacts).toHaveLength(1);
    expect(await store.current(projectId, result.destination)).toContain('Route: synthetic');
    const recent = store.state(projectId).history.slice(-2);
    expect(recent.map((entry) => ({ kind: entry.kind, sample: entry.sample }))).toEqual([
      { kind: 'synthetic', sample: true },
      { kind: 'synthetic', sample: true },
    ]);

    const foreignProjectId = (await store.createProject('Foreign project')).id;
    await expect(
      new ProspectRehearsalService(store, currentAuthority).run({
        projectId: foreignProjectId,
        owner,
        route: 'synthetic',
        at: '2026-09-19T07:03:00.000Z',
      }),
    ).rejects.toMatchObject({ details: { code: 'prospect_project_mismatch' } });
    expect(store.state(foreignProjectId).history).toHaveLength(0);

    const revokedProjectId = (await store.createProject('Revoked prospect project')).id;
    let authorityChecks = 0;
    const revokedDuringPreparation = {
      resolve: async () => {
        authorityChecks += 1;
        if (authorityChecks > 1)
          throw new ApiError(404, 'That prospect is no longer active.', {
            code: 'unknown_prospect',
          });
        return {
          projectId: revokedProjectId,
          snapshot,
          manifest,
          variant,
        };
      },
    };
    await expect(
      new ProspectRehearsalService(store, revokedDuringPreparation).run({
        projectId: revokedProjectId,
        owner,
        route: 'synthetic',
        at: '2026-09-19T07:04:00.000Z',
      }),
    ).rejects.toMatchObject({ details: { code: 'unknown_prospect' } });
    expect(store.state(revokedProjectId).history).toHaveLength(0);

    const tamperedProjectId = (await store.createProject('Tampered synthetic project')).id;
    const tamperAuthority = {
      resolve: async () => ({
        projectId: tamperedProjectId,
        snapshot,
        manifest,
        variant,
      }),
    };
    const writeRecorded = store.writeRecorded.bind(store);
    let recordedWrites = 0;
    store.writeRecorded = (async (...args: Parameters<Store['writeRecorded']>) => {
      const entry = await writeRecorded(...args);
      recordedWrites += 1;
      if (recordedWrites === 1) {
        const written = args[1][0]!;
        await fs.writeFile(
          path.join(store.state(args[0]).project.folder, written.path),
          'changed outside the recorded writer',
          'utf8',
        );
      }
      return entry;
    }) as Store['writeRecorded'];
    try {
      await expect(
        new ProspectRehearsalService(store, tamperAuthority).run({
          projectId: tamperedProjectId,
          owner,
          route: 'synthetic',
          at: '2026-09-19T07:05:00.000Z',
        }),
      ).rejects.toThrow('changed or disappeared');
      expect(store.state(tamperedProjectId).history).toHaveLength(1);
    } finally {
      store.writeRecorded = writeRecorded;
    }

    const approvedProjectId = (await store.createProject('Approved import project')).id;
    const localExport = path.join(root, 'approved.csv');
    await fs.writeFile(localExport, 'location,total\nDowntown,42\n', 'utf8');
    const candidate = await inspectImport(localExport);
    const imported = await importExports(store, approvedProjectId, [candidate]);
    const approvedAuthority = {
      resolve: async () => ({
        projectId: approvedProjectId,
        snapshot,
        manifest,
        variant,
      }),
    };
    const approved = await new ProspectRehearsalService(store, approvedAuthority).run({
      projectId: approvedProjectId,
      owner,
      route: 'approved-file',
      sources: imported.files,
      at: '2026-09-19T07:06:00.000Z',
    });
    expect(approved.artifacts).toEqual([]);
    expect(approved.fixtureEntryId).toBeNull();
    const approvedBrief = await store.current(approvedProjectId, approved.destination);
    expect(approvedBrief).toContain('Route: approved-file');
    expect(approvedBrief).not.toContain('Demonstration data');
    expect(store.state(approvedProjectId).history.at(-1)).toMatchObject({
      kind: 'approved-file',
      sample: false,
    });

    await store.writeRecorded(
      approvedProjectId,
      [{ path: 'Imports/unrecorded.csv', text: 'value\n1\n', expected: null }],
      { label: 'Manual file' },
    );
    await expect(
      new ProspectRehearsalService(store, approvedAuthority).run({
        projectId: approvedProjectId,
        owner,
        route: 'approved-file',
        sources: [{ path: 'Imports/unrecorded.csv', sha: hash('value\n1\n')! }],
        at: '2026-09-19T07:07:00.000Z',
      }),
    ).rejects.toMatchObject({ details: { code: 'prospect_source_not_imported' } });

    await fs.writeFile(
      path.join(store.state(approvedProjectId).project.folder, imported.files[0]!.path),
      'location,total\nDowntown,99\n',
      'utf8',
    );
    await expect(
      new ProspectRehearsalService(store, approvedAuthority).run({
        projectId: approvedProjectId,
        owner,
        route: 'approved-file',
        sources: imported.files,
        at: '2026-09-19T07:08:00.000Z',
      }),
    ).rejects.toMatchObject({ details: { code: 'prospect_source_moved' } });
  });
});
