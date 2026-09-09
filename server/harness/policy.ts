/**
 * The mandatory policy boundary. Runs before any optional hook and before any
 * handler. No authentication server or OS sandbox is implied: a principal is
 * whatever the trusted host says it is, and a label is trusted only because the
 * host attached it. Missing labels are untrusted and restricted, never the
 * other way round.
 */
import { createHash } from 'node:crypto';
import type { HarnessLabel, HarnessPrincipal, StepIntent } from '../../shared/harness.js';

export class HarnessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

/** Sorted-key JSON for hashing. Only finite, plain JSON values are accepted. */
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  throw new HarnessError('not_json', 'Only finite, plain JSON values are accepted.');
}

export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** A deep copy through canonical JSON: what a hook or handler gets can never be the original. */
export const copy = <T>(value: T): T => JSON.parse(canonical(value)) as T;

export function units(value: unknown, what = 'This value'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new HarnessError('invalid_units', `${what} must be a nonnegative safe integer.`);
  return value;
}

const LEVELS = ['public', 'internal', 'restricted'] as const;

export function validateLabel(label: unknown): asserts label is HarnessLabel {
  const l = label as Partial<HarnessLabel> | null;
  if (
    !l ||
    typeof l.tenantId !== 'string' ||
    !l.tenantId ||
    typeof l.projectId !== 'string' ||
    !l.projectId ||
    (l.integrity !== 'trusted' && l.integrity !== 'untrusted') ||
    !(LEVELS as readonly string[]).includes(l.confidentiality as string) ||
    !Array.isArray(l.provenance) ||
    !l.provenance.every((p) => typeof p === 'string')
  )
    throw new HarnessError('invalid_label', 'Invalid label.');
}

/** Conservative join: least integrity, most restrictive confidentiality, union of provenance. */
export function joinLabels(...labels: HarnessLabel[]): HarnessLabel {
  if (!labels.length) throw new HarnessError('invalid_label', 'A label is required.');
  labels.forEach(validateLabel);
  const { tenantId, projectId } = labels[0];
  if (labels.some((l) => l.tenantId !== tenantId))
    throw new HarnessError('cross_tenant', 'Cross-tenant label join denied.');
  if (labels.some((l) => l.projectId !== projectId))
    throw new HarnessError('cross_project', 'Cross-project label join denied.');
  return {
    tenantId,
    projectId,
    integrity: labels.some((l) => l.integrity === 'untrusted') ? 'untrusted' : 'trusted',
    confidentiality: LEVELS[Math.max(...labels.map((l) => LEVELS.indexOf(l.confidentiality)))],
    provenance: [...new Set(labels.flatMap((l) => l.provenance))],
  };
}

export function validatePrincipal(principal: unknown): asserts principal is HarnessPrincipal {
  const p = principal as Partial<HarnessPrincipal> | null;
  if (
    !p ||
    typeof p.id !== 'string' ||
    !p.id ||
    typeof p.tenantId !== 'string' ||
    !p.tenantId ||
    typeof p.projectId !== 'string' ||
    !p.projectId ||
    !Array.isArray(p.capabilities) ||
    !p.capabilities.every((c) => typeof c === 'string') ||
    typeof p.identityGeneration !== 'number' ||
    !Number.isSafeInteger(p.identityGeneration)
  )
    throw new HarnessError('invalid_principal', 'Invalid principal.');
}

/**
 * Mandatory checks on one intent for one principal. Denials are thrown; the
 * caller must run this before any hook sees the intent.
 */
export function authorize(intent: StepIntent, principal: HarnessPrincipal): void {
  validatePrincipal(principal);
  if (intent.permission && !principal.capabilities.includes(intent.permission))
    throw new HarnessError('missing_capability', `Missing capability: ${intent.permission}.`);
  const label: HarnessLabel = intent.label ?? {
    tenantId: principal.tenantId,
    projectId: principal.projectId,
    integrity: 'untrusted',
    confidentiality: 'restricted',
    provenance: [],
  };
  validateLabel(label);
  if (label.tenantId !== principal.tenantId)
    throw new HarnessError('cross_tenant', 'Cross-tenant operation denied.');
  if (label.projectId !== principal.projectId)
    throw new HarnessError('cross_project', 'Cross-project operation denied.');
  if (intent.destination !== 'local' && intent.destination !== 'external')
    throw new HarnessError('unknown_destination', 'Unknown destination.');
  if (intent.destination === 'external' && label.confidentiality !== 'public')
    throw new HarnessError('egress_denied', 'Confidentiality egress denied.');
  if (intent.trustedInputRequired && label.integrity !== 'trusted')
    throw new HarnessError('integrity_denied', 'Input integrity denied.');
}
