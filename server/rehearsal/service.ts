import type { ConfigurationManifest } from '../../shared/configuration.js';
import type { SyntheticRehearsalArtifact } from '../../shared/rehearsal.js';
import { payloadDigest } from '../command-admission.js';
import { fileReferences } from '../file-imports.js';
import { ApiError, relativeName } from '../paths.js';
import { hash, type Store } from '../store.js';
import { WeeklyBriefService } from '../weekly-brief.js';
import { renderSyntheticFixtures } from './fixture-template.js';
import type { LoadedIndustryVariant } from './industry-registry.js';
import {
  assertProspectProposal,
  overlayDigest,
  type ProspectConfigurationSnapshot,
} from './prospect-configuration.js';

const notice = (manifest: ConfigurationManifest, variant: LoadedIndustryVariant) =>
  `Demonstration data. Route: synthetic. Configuration revision ${manifest.revision}; configuration digest ${manifest.digest}; variant revision ${variant.digest}.`;

export interface ProspectRehearsalResult {
  readonly artifacts: readonly SyntheticRehearsalArtifact[];
  readonly fixtureEntryId: string | null;
  readonly briefEntryId: string;
  readonly destination: string;
}

export interface ProspectRehearsalAuthority {
  /**
   * Resolves the current FD02 record, trusted project binding, active
   * configuration, and freshly loaded registry variant. The app adapter must
   * derive all four from authoritative state; request data is never an
   * implementation of this interface.
   */
  resolve(input: {
    readonly projectId: string;
    readonly owner: Extract<NonNullable<ConfigurationManifest['owner']>, { kind: 'prospect' }>;
  }): Promise<{
    readonly projectId: string;
    readonly snapshot: ProspectConfigurationSnapshot;
    readonly manifest: ConfigurationManifest;
    readonly variant: LoadedIndustryVariant;
  }>;
}

/** Uses only the active pinned prospect configuration and existing recorded writers. */
export class ProspectRehearsalService {
  private readonly briefs: WeeklyBriefService;

  constructor(
    private readonly store: Store,
    private readonly authority: ProspectRehearsalAuthority,
    briefs?: WeeklyBriefService,
  ) {
    this.briefs = briefs ?? new WeeklyBriefService(store);
  }

  async run(input: {
    readonly projectId: string;
    readonly owner: Extract<NonNullable<ConfigurationManifest['owner']>, { kind: 'prospect' }>;
    readonly at: string;
    readonly route: 'synthetic' | 'approved-file';
    readonly sources?: unknown;
  }): Promise<ProspectRehearsalResult> {
    if (input.route !== 'synthetic' && input.route !== 'approved-file')
      throw new ApiError(400, 'That rehearsal route is not supported.', {
        code: 'prospect_rehearsal_route',
      });
    const resolveCurrentAuthority = async () => {
      const current = await this.authority.resolve({
        projectId: input.projectId,
        owner: input.owner,
      });
      if (
        current.projectId !== input.projectId ||
        current.snapshot.owner.prospectId !== input.owner.prospectId ||
        current.snapshot.owner.operatorId !== input.owner.operatorId ||
        current.manifest.owner?.kind !== 'prospect' ||
        current.manifest.owner.prospectId !== input.owner.prospectId ||
        current.manifest.owner.operatorId !== input.owner.operatorId
      )
        throw new ApiError(403, 'This project is not bound to the active prospect.', {
          code: 'prospect_project_mismatch',
        });
      if (
        current.manifest.state !== 'active' ||
        current.manifest.digest !== payloadDigest(current.manifest.proposal)
      )
        throw new ApiError(409, 'Only the current active prospect configuration can run.', {
          code: 'prospect_rehearsal_not_active',
        });
      assertProspectProposal(current.manifest.proposal, current.snapshot);
      return current;
    };
    const authorized = await resolveCurrentAuthority();
    const { manifest, variant } = authorized;
    const owner = input.owner;
    const assertCurrentAuthority = async () => {
      const current = await resolveCurrentAuthority();
      if (
        current.manifest.revision !== manifest.revision ||
        current.manifest.digest !== manifest.digest ||
        current.variant.id !== variant.id ||
        current.variant.digest !== variant.digest
      )
        throw new ApiError(409, 'The active prospect configuration or variant changed.', {
          code: 'prospect_configuration_moved',
        });
    };
    const pin = manifest.proposal.prospect;
    if (
      !pin ||
      pin.policy !== 'drafts-only' ||
      pin.variantDigest !== variant.digest ||
      pin.overlay.variantId !== variant.id ||
      pin.overlayDigest !== overlayDigest(pin.overlay)
    )
      throw new ApiError(409, 'The rehearsal variant or overlay no longer matches activation.', {
        code: 'prospect_rehearsal_moved',
      });
    if (input.route === 'approved-file') {
      const sources = fileReferences(input.sources).map((source) => ({
        ...source,
        path: relativeName(source.path),
      }));
      const history = this.store.state(input.projectId).history;
      for (const source of sources) {
        const imported = history.some(
          (entry) =>
            entry.label === 'Imported exports' &&
            entry.files.some(
              (file) =>
                file.recorded &&
                file.path.toLowerCase() === source.path.toLowerCase() &&
                file.after === source.sha,
            ),
        );
        if (!imported)
          throw new ApiError(403, `${source.path} is not an unchanged recorded import.`, {
            code: 'prospect_source_not_imported',
          });
        if (hash(await this.store.current(input.projectId, source.path)) !== source.sha)
          throw new ApiError(409, `${source.path} changed after it was imported.`, {
            code: 'prospect_source_moved',
          });
      }
      await assertCurrentAuthority();
      const approvedNotice = `Approved imported data. Route: approved-file. Configuration revision ${manifest.revision}; configuration digest ${manifest.digest}; variant revision ${variant.digest}.`;
      const brief = await this.briefs.run({
        projectId: input.projectId,
        manifest,
        at: input.at,
        sources,
        recording: { sample: false, route: 'approved-file', notice: approvedNotice },
      });
      return {
        artifacts: [],
        fixtureEntryId: null,
        briefEntryId: brief.entryId,
        destination: brief.destination,
      };
    }
    if (input.sources !== undefined)
      throw new ApiError(400, 'Synthetic rehearsal does not accept source files.', {
        code: 'prospect_rehearsal_sources',
      });
    const namespace = `Prospect rehearsals/${owner.prospectId}/revision-${manifest.revision}`;
    const artifacts = renderSyntheticFixtures(variant, pin.overlay).map((artifact) =>
      Object.freeze({ ...artifact, path: `${namespace}/${artifact.path}` }),
    );
    const writes = await Promise.all(
      artifacts.map(async (artifact) => ({
        path: artifact.path,
        text: artifact.text,
        expected: hash(await this.store.current(input.projectId, artifact.path)),
      })),
    );
    // Re-check immediately before the first write so a revoked or moved FD02
    // record cannot use work prepared under its former authority.
    await assertCurrentAuthority();
    const fixtureEntry = await this.store.writeRecorded(input.projectId, writes, {
      kind: 'synthetic',
      sample: true,
      review: true,
      label: 'Synthetic rehearsal sources',
      sentence: `${notice(manifest, variant)} Generated ${writes.length} synthetic source files for review.`,
    });
    const sources = artifacts.map((artifact) => ({
      path: artifact.path,
      // Pin the exact rendered bytes. WeeklyBriefService rereads each file
      // and refuses this hash if anything edits a fixture after recording.
      sha: hash(artifact.text)!,
    }));
    const scopedManifest: ConfigurationManifest = {
      ...manifest,
      proposal: {
        ...manifest.proposal,
        expectedOutputs: manifest.proposal.expectedOutputs.map((output) => ({
          ...output,
          destination: `${namespace}/${output.destination}`,
        })),
      },
    };
    // Fixture creation and brief creation are separate recorded writes. Refuse
    // the second one if the prospect or active revision moved between them.
    await assertCurrentAuthority();
    const brief = await this.briefs.run({
      projectId: input.projectId,
      manifest: scopedManifest,
      at: input.at,
      sources,
      recording: { sample: true, route: 'synthetic', notice: notice(manifest, variant) },
    });
    return {
      artifacts,
      fixtureEntryId: fixtureEntry.id,
      briefEntryId: brief.entryId,
      destination: brief.destination,
    };
  }
}
