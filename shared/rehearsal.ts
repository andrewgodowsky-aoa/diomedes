/**
 * Contracts for the deterministic, synthetic half of FD04 rehearsal.
 *
 * These records carry no authority. The server returns artifact candidates for
 * the existing recorded-write path; it does not create a second writer.
 */

export type DeterministicRehearsalEngine = 'weekly-brief';

export interface ProspectOverlay {
  readonly prospectId: string;
  readonly variantId: string;
  readonly revision: number;
  readonly business: {
    readonly name: string;
  };
  readonly locations: readonly {
    readonly name: string;
  }[];
  readonly terminology: Readonly<Record<string, string>>;
  readonly selection: readonly string[];
  readonly policy: 'drafts-only';
}

export interface IndustryFixtureDefinition {
  readonly path: string;
  readonly label: string;
  readonly default: boolean;
  readonly slot?: 'location';
}

export interface IndustryVariantMetadata {
  readonly id: string;
  readonly contractVersion: number;
  readonly engine: DeterministicRehearsalEngine;
  readonly label: string;
  readonly industry: string;
  readonly keywords: readonly string[];
  readonly scopeLabel: string;
  readonly scopeSelection: readonly string[];
  readonly outputLabel: string;
  readonly destination: string;
  readonly guidanceText: string;
  readonly terminology: Readonly<Record<string, string>>;
}

export interface SyntheticRehearsalArtifact {
  readonly path: string;
  readonly text: string;
  readonly sample: true;
  readonly route: 'synthetic';
}
