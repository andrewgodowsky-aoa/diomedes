import type { AnswerMap } from '../../shared/business-setup.js';
import type {
  ConfigurationOwner,
  ConfigurationProposal,
  KnownAgent,
  ProspectConfigurationPin,
} from '../../shared/configuration.js';
import type { ProspectOverlay } from '../../shared/rehearsal.js';
import { compileProposal, type WeeklyBriefVariant } from '../../shared/packs.js';
import { payloadDigest } from '../command-admission.js';
import { ApiError } from '../paths.js';

export interface ProspectConfigurationSnapshot {
  readonly owner: Extract<ConfigurationOwner, { kind: 'prospect' }>;
  readonly name: string;
  readonly answers: AnswerMap;
  readonly answersDigest: string;
  readonly recordId: string;
  readonly recordDigest: string;
  readonly recordUpdatedAt: string;
  readonly overlay: ProspectOverlay;
}

/** Implemented by the active FD02 record adapter at app composition time. */
export interface ProspectConfigurationSource {
  resolve(
    owner: Extract<ConfigurationOwner, { kind: 'prospect' }>,
  ): Promise<ProspectConfigurationSnapshot>;
}

export const overlayDigest = (overlay: ProspectOverlay): string => payloadDigest(overlay);

export function prospectPin(
  snapshot: ProspectConfigurationSnapshot,
  variantDigest: string,
): ProspectConfigurationPin {
  return Object.freeze({
    recordId: snapshot.recordId,
    recordDigest: snapshot.recordDigest,
    recordUpdatedAt: snapshot.recordUpdatedAt,
    variantDigest,
    overlayDigest: overlayDigest(snapshot.overlay),
    overlay: structuredClone(snapshot.overlay),
    policy: 'drafts-only' as const,
  });
}

export function compileProspectProposal(input: {
  readonly snapshot: ProspectConfigurationSnapshot;
  readonly variant: WeeklyBriefVariant & { readonly digest: string };
  readonly variants: ReadonlyMap<string, WeeklyBriefVariant>;
  readonly previousConfigurationDigest: string | null;
  readonly agents: ReadonlyMap<string, KnownAgent>;
  readonly at: string;
}): ConfigurationProposal {
  return compileProposal({
    owner: input.snapshot.owner,
    organizationId: null,
    tenantId: null,
    prospect: prospectPin(input.snapshot, input.variant.digest),
    answers: input.snapshot.answers,
    answersDigest: input.snapshot.answersDigest,
    previousConfigurationDigest: input.previousConfigurationDigest,
    variantId: input.variant.id,
    variants: input.variants,
    agents: input.agents,
    teamExecutionAvailable: false,
    connectedConnections: new Set(),
    at: input.at,
    by: input.snapshot.owner.operatorId,
  });
}

export function assertProspectProposal(
  proposal: ConfigurationProposal,
  snapshot: ProspectConfigurationSnapshot,
): void {
  if (
    proposal.owner?.kind !== 'prospect' ||
    proposal.owner.prospectId !== snapshot.owner.prospectId ||
    proposal.owner.operatorId !== snapshot.owner.operatorId ||
    proposal.organizationId !== null ||
    proposal.tenantId !== null
  )
    throw new ApiError(400, 'This proposal is outside the active prospect namespace.', {
      code: 'prospect_scope_mismatch',
    });
  const pin = proposal.prospect;
  if (
    !pin ||
    pin.policy !== 'drafts-only' ||
    pin.recordId !== snapshot.recordId ||
    pin.recordDigest !== snapshot.recordDigest ||
    pin.recordUpdatedAt !== snapshot.recordUpdatedAt ||
    pin.overlayDigest !== overlayDigest(snapshot.overlay) ||
    pin.overlayDigest !== overlayDigest(pin.overlay)
  )
    throw new ApiError(409, 'The active prospect record or rehearsal overlay changed.', {
      code: 'prospect_source_moved',
    });
  if (proposal.team !== null || proposal.requiredConnections.length > 0)
    throw new ApiError(
      400,
      'Prospect rehearsal cannot activate live connections or Team execution.',
      {
        code: 'prospect_live_authority',
      },
    );
  if (proposal.modelPolicy.routes.some((route) => route !== 'harness-runtime'))
    throw new ApiError(400, 'Prospect rehearsal supports only the local draft route.', {
      code: 'prospect_unsupported_route',
    });
}
