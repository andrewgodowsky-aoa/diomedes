import { z } from 'zod';
import { ADAPTER_COMMANDS, type AdapterCommand } from './adapter-contract.js';
import type { ConnectionInstance, ConnectionObservation, ConnectorManifest } from './connections.js';
import type { EngineConnection } from './engines.js';

export const READINESS_CONTRACT_VERSION = 1 as const;
export const READINESS_AXES = [
  'implemented',
  'installed',
  'authorized',
  'verified',
  'healthy',
] as const;
export type ReadinessAxisName = (typeof READINESS_AXES)[number];
export type ReadinessValue = 'yes' | 'no' | 'unknown';
export type FreshnessState = 'static' | 'fresh' | 'stale' | 'unknown';

export interface ReadinessSource {
  readonly kind: 'build' | 'settings' | 'engine-status' | 'manifest' | 'connection' | 'observation' | 'product-knowledge' | 'validated-evidence';
  readonly id: string;
  readonly digest?: string;
}

export interface ReadinessFreshness {
  readonly state: FreshnessState;
  readonly observedAt: string | null;
  readonly staleAfterMs: number | null;
}

export interface ReadinessAxis {
  readonly value: ReadinessValue;
  readonly source: ReadinessSource;
  readonly freshness: ReadinessFreshness;
  readonly detail: string;
}

export interface ReadinessAxes {
  readonly implemented: ReadinessAxis;
  readonly installed: ReadinessAxis;
  readonly authorized: ReadinessAxis;
  readonly verified: ReadinessAxis;
  readonly healthy: ReadinessAxis;
}

export interface ReadinessCapability {
  readonly kind: 'route' | 'connector';
  readonly id: string;
  readonly axes: ReadinessAxes;
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

const id = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.string().min(1).max(160);
const sourcePath = z.string().min(1).max(300);
const validTimestamp = z.iso.datetime({ offset: true });
const control = z.enum(['enforced', 'observed', 'instructional', 'unsupported']);

export const productKnowledgeRequirementSchema = z.strictObject({
  kind: z.enum(['route', 'connector']),
  id,
  commands: z.array(z.enum(ADAPTER_COMMANDS)).max(10).default([]),
  operations: z.array(id).max(20).default([]),
  controls: z.record(z.string().min(1).max(80), control).default({}),
});
export type ProductKnowledgeRequirement = z.infer<typeof productKnowledgeRequirementSchema>;

export const productKnowledgeResourceSchema = z
  .strictObject({
    schemaVersion: z.literal(READINESS_CONTRACT_VERSION),
    id,
    version: z.string().min(1).max(80),
    buildVersion: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    qualification: z.strictObject({
      status: z.enum(['verified', 'unverified']),
      evidenceId: id.nullable(),
      source: sourcePath.nullable(),
      qualifiedAt: validTimestamp.nullable(),
      staleAfterMs: z.number().int().positive().max(365 * 24 * 60 * 60 * 1000).nullable(),
    }),
    scopes: z.array(scope).min(1).max(100),
    routes: z
      .array(
        z.strictObject({
          routeId: id,
          contractVersion: z.number().int().positive(),
          engineVersion: z.string().min(1).max(100),
        }),
      )
      .max(40),
    connectors: z
      .array(
        z.strictObject({
          connectorId: id,
          schemaVersion: z.number().int().positive(),
          version: z.string().min(1).max(100),
          manifestDigest: sha256,
        }),
      )
      .max(40),
    workflows: z
      .array(
        z.strictObject({
          id,
          title: z.string().min(1).max(200),
          requirements: z.array(productKnowledgeRequirementSchema).min(1).max(20),
        }),
      )
      .max(40),
    statements: z
      .array(
        z.strictObject({
          id,
          scopes: z.array(scope).min(1).max(30),
          text: z.string().min(1).max(2000),
          sources: z.array(sourcePath).min(1).max(20),
        }),
      )
      .max(100),
  })
  .superRefine((resource, ctx) => {
    const unique = (values: readonly string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: 'custom', path, message: 'Values must be unique.' });
    };
    unique(resource.scopes, ['scopes']);
    unique(resource.routes.map((item) => item.routeId), ['routes']);
    unique(resource.connectors.map((item) => item.connectorId), ['connectors']);
    unique(resource.workflows.map((item) => item.id), ['workflows']);
    unique(resource.statements.map((item) => item.id), ['statements']);
    const qualification = resource.qualification;
    const fields = [qualification.evidenceId, qualification.source, qualification.qualifiedAt, qualification.staleAfterMs];
    if (qualification.status === 'verified' && fields.some((value) => value === null))
      ctx.addIssue({ code: 'custom', path: ['qualification'], message: 'A verified qualification requires exact evidence, source, time and freshness.' });
    if (qualification.status === 'unverified' && fields.some((value) => value !== null))
      ctx.addIssue({ code: 'custom', path: ['qualification'], message: 'An unverified resource must not carry proof-shaped qualification fields.' });
    for (const [index, workflow] of resource.workflows.entries())
      unique(workflow.requirements.map((item) => `${item.kind}:${item.id}`), ['workflows', index, 'requirements']);
  });
export type ProductKnowledgeResource = z.infer<typeof productKnowledgeResourceSchema>;

export const productKnowledgeIndexSchema = z
  .strictObject({
    schemaVersion: z.literal(READINESS_CONTRACT_VERSION),
    version: z.string().min(1).max(80),
    buildVersion: z.string().min(1).max(80),
    resources: z
      .array(
        z.strictObject({
          path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/),
          sha256,
          scopes: z.array(scope).min(1).max(100),
        }),
      )
      .min(1)
      .max(32),
  })
  .superRefine((index, ctx) => {
    if (new Set(index.resources.map((item) => item.path.toLowerCase())).size !== index.resources.length)
      ctx.addIssue({ code: 'custom', path: ['resources'], message: 'Resource paths must be unique.' });
  });
export type ProductKnowledgeIndex = z.infer<typeof productKnowledgeIndexSchema>;

export type ProductKnowledgeConflictCode =
  | 'missing-index'
  | 'invalid-index'
  | 'build-version'
  | 'missing-resource'
  | 'invalid-resource'
  | 'digest-mismatch'
  | 'duplicate-resource'
  | 'stale-qualification'
  | 'contract-mismatch'
  | 'engine-version-mismatch'
  | 'manifest-mismatch';

export interface ProductKnowledgeConflict {
  readonly code: ProductKnowledgeConflictCode;
  readonly detail: string;
  readonly scopes: readonly string[];
  readonly source: string;
}

export interface LoadedProductKnowledgeResource {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly resource: ProductKnowledgeResource;
}

export interface ProductKnowledgeBundle {
  readonly contractVersion: typeof READINESS_CONTRACT_VERSION;
  readonly indexVersion: string | null;
  readonly buildVersion: string;
  readonly bundleSha256: string | null;
  readonly resources: readonly LoadedProductKnowledgeResource[];
  readonly conflicts: readonly ProductKnowledgeConflict[];
  readonly loadedAt: string;
}

export interface ManifestSnapshot {
  readonly manifest: ConnectorManifest;
  readonly digest: string;
}

export interface BoundConnectionObservation {
  readonly connectionId: string;
  readonly generation: number;
  readonly projectId: string;
  readonly observation: ConnectionObservation;
}

export interface ReadinessRuntimeSnapshot {
  readonly build: { readonly version: string; readonly source: string; readonly digest?: string };
  readonly settings: {
    readonly services: Readonly<Record<string, unknown>>;
    readonly observedAt: string;
  };
  /** Cached EngineService.status() output. Projection code must never call discover/check. */
  readonly engines: readonly EngineConnection[];
  readonly connectors: {
    readonly manifests: readonly ManifestSnapshot[];
    readonly instances: readonly ConnectionInstance[];
    readonly observations: readonly BoundConnectionObservation[];
  };
  /**
   * Evidence already validated by an injected trusted reader. Product JSON
   * never populates this list and cannot certify itself.
   */
  readonly validatedEvidence?: readonly ValidatedReadinessEvidence[];
  /** Current, trusted authorization observations; persisted connection labels do not populate this. */
  readonly connectorAuthorizations?: readonly ConnectorAuthorizationEvidence[];
}

export interface ValidatedReadinessEvidence {
  readonly kind: 'route' | 'connector';
  readonly id: string;
  readonly evidenceId: string;
  readonly source: string;
  readonly validatedAt: string;
  readonly staleAfterMs: number;
  readonly buildVersion: string;
  readonly contractVersion?: number;
  readonly engineVersion?: string;
  readonly manifestDigest?: string;
}

export interface ConnectorAuthorizationEvidence {
  readonly connectorId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly projectId: string;
  readonly authorizedAt: string;
  readonly staleAfterMs: number;
  readonly source: string;
}

export interface WorkflowBlocker {
  readonly code: 'axis-missing' | 'capability-missing' | 'command-unsupported' | 'control-missing' | 'operation-missing' | 'knowledge-conflict';
  readonly requirement: string;
  readonly detail: string;
}

export interface WorkflowReadiness {
  readonly id: string;
  readonly title: string;
  readonly requirements: readonly (ProductKnowledgeRequirement & {
    readonly capability: ReadinessCapability | null;
  })[];
  readonly ready: boolean;
  readonly blockers: readonly WorkflowBlocker[];
  readonly routeSwitch: 'explicit-only';
  readonly selectedAlternatives: readonly string[];
}

export interface ReadinessProjection {
  readonly contractVersion: typeof READINESS_CONTRACT_VERSION;
  readonly generatedAt: string;
  readonly build: ReadinessRuntimeSnapshot['build'];
  readonly knowledge: {
    readonly bundleSha256: string | null;
    readonly conflicts: readonly ProductKnowledgeConflict[];
  };
  readonly routes: readonly ReadinessCapability[];
  readonly connectors: readonly ReadinessCapability[];
  readonly workflows: readonly WorkflowReadiness[];
}

export interface ProductKnowledgeReceipt {
  readonly contractVersion: typeof READINESS_CONTRACT_VERSION;
  readonly routeId: string;
  readonly state: 'prepared' | 'omitted' | 'sent-and-response-returned';
  readonly preparedAt: string;
  readonly sentAt: string | null;
  readonly bundleSha256: string | null;
  readonly sectionSha256: string | null;
  readonly bytes: number;
  readonly resources: readonly { path: string; sha256: string; version: string }[];
  readonly detail: string;
}

export type ReadinessCommand = AdapterCommand;
