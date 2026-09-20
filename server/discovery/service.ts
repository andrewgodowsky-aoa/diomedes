import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DISCOVERY_ROUTE_LABEL,
  HYPOTHESIS_OUTCOMES,
  appendDiscoveryFact,
  appendFactCorrection,
  appendHypothesisOutcome,
  createProspectDiscoveryRecord,
  currentFact,
  factProvenanceSchema,
  importResearchBriefFacts,
  parseProspectDiscoveryRecord,
  parseProspectResearchBriefDocument,
  renderDiscoveryExport,
  transitionPublicFact as transitionPublic,
  updateDiscoveryClassification,
  type CreateProspectDiscoveryInput,
  type DiscoveryArtifact,
  type DiscoveryExportReference,
  type DiscoveryFactoryDependencies,
  type DiscoveryStage,
  type FactProvenance,
  type HypothesisOutcome,
  type ObservedEvidence,
  type PersonalizationLevel,
  type ProspectDiscoveryRecord,
} from '../../shared/discovery.js';
import { ApiError } from '../paths.js';
import { jsonWrite, readJson, type Store } from '../store.js';

interface ActiveSelection {
  readonly v: 1;
  readonly operatorId: string;
  readonly activeProspectId: string;
  readonly selectedAt: string;
}

const validStoredId = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
const notFound = () =>
  new ApiError(404, 'That prospect discovery record is not available to this operator.', {
    code: 'discovery_not_found',
  });
const refusal = (error: unknown, status: 400 | 409, code: string) =>
  error instanceof ApiError
    ? error
    : new ApiError(
        status,
        error instanceof Error ? error.message : 'The discovery request was refused.',
        { code },
      );

const invalidStoredRecord = (error?: unknown) =>
  new ApiError(
    409,
    error instanceof Error ? error.message : 'This stored discovery record is invalid.',
    { code: 'invalid_discovery_record' },
  );

function validatedProvenance(value: FactProvenance): FactProvenance {
  const result = factProvenanceSchema.safeParse(value);
  if (!result.success)
    throw new ApiError(400, 'The discovery fact provenance is invalid.', {
      code: 'invalid_fact_provenance',
    });
  return result.data as FactProvenance;
}

function validateHypothesisSources(
  record: ProspectDiscoveryRecord,
  provenance: FactProvenance,
): void {
  if (provenance.class !== 'hypothesized') return;
  const facts = new Set(record.facts.map((fact) => fact.id));
  if (provenance.sourceFactIds.some((factId) => !facts.has(factId)))
    throw new ApiError(400, 'A hypothesized fact may cite only facts in this prospect record.', {
      code: 'invalid_hypothesis_source',
    });
}

function hasPublicLineage(record: ProspectDiscoveryRecord, factId: string): boolean {
  const facts = new Map(record.facts.map((fact) => [fact.id, fact] as const));
  const seen = new Set<string>();
  let fact = facts.get(factId);
  while (fact) {
    if (seen.has(fact.id)) throw invalidStoredRecord();
    seen.add(fact.id);
    if (fact.provenance.class === 'public') return true;
    fact = fact.replacesFactId ? facts.get(fact.replacesFactId) : undefined;
  }
  return false;
}

export class DiscoveryService {
  private readonly deps: DiscoveryFactoryDependencies;
  private readonly verifyObservedEvidence: (input: {
    readonly operatorId: string;
    readonly prospectId: string;
    readonly evidence: ObservedEvidence;
  }) => Promise<boolean>;

  constructor(
    private readonly store: Store,
    dependencies: Partial<DiscoveryFactoryDependencies> & {
      readonly verifyObservedEvidence?: (input: {
        readonly operatorId: string;
        readonly prospectId: string;
        readonly evidence: ObservedEvidence;
      }) => Promise<boolean>;
    } = {},
  ) {
    this.deps = {
      now: dependencies.now ?? (() => new Date().toISOString()),
      id: dependencies.id ?? ((prefix) => `${prefix}${randomUUID()}`),
    };
    this.verifyObservedEvidence = dependencies.verifyObservedEvidence ?? (async () => false);
  }

  /** Routes share the Store's one mutation queue; the service creates no second writer. */
  locked<T>(action: () => Promise<T>): Promise<T> {
    return this.store.locked(action);
  }

  private recordPath(prospectId: string): string {
    if (!validStoredId(prospectId)) throw notFound();
    return path.join(this.store.dataDir, 'prospects', 'discovery', `${prospectId}.json`);
  }

  private selectionPath(operatorId: string): string {
    const key = createHash('sha256').update(operatorId).digest('hex');
    return path.join(this.store.dataDir, 'prospects', 'operators', `${key}.json`);
  }

  private async readRecord(prospectId: string): Promise<ProspectDiscoveryRecord | null> {
    const stored = await readJson<unknown | null>(this.recordPath(prospectId), () => null);
    if (!stored) return null;
    let record: ProspectDiscoveryRecord;
    try {
      record = parseProspectDiscoveryRecord(stored);
    } catch (error) {
      throw invalidStoredRecord(error);
    }
    if (record.prospectId !== prospectId) throw invalidStoredRecord();
    return record;
  }

  private async verifyStoredEvidence(record: ProspectDiscoveryRecord): Promise<void> {
    for (const fact of record.facts) {
      if (fact.provenance.class !== 'observed') continue;
      if (
        !(await this.verifyObservedEvidence({
          operatorId: record.operatorId,
          prospectId: record.prospectId,
          evidence: fact.provenance.evidence,
        }))
      )
        throw new ApiError(409, 'A stored observed fact no longer has valid source evidence.', {
          code: 'invalid_observed_evidence',
        });
    }
  }

  private async owned(operatorId: string, prospectId: string): Promise<ProspectDiscoveryRecord> {
    const record = await this.readRecord(prospectId);
    if (!record || record.operatorId !== operatorId) throw notFound();
    await this.verifyStoredEvidence(record);
    return record;
  }

  private async persist(record: ProspectDiscoveryRecord): Promise<void> {
    let validated: ProspectDiscoveryRecord;
    try {
      validated = parseProspectDiscoveryRecord(record);
    } catch (error) {
      throw invalidStoredRecord(error);
    }
    await jsonWrite(this.recordPath(validated.prospectId), validated);
  }

  private async persistSelection(operatorId: string, prospectId: string): Promise<void> {
    const selection: ActiveSelection = {
      v: 1,
      operatorId,
      activeProspectId: prospectId,
      selectedAt: this.deps.now(),
    };
    await jsonWrite(this.selectionPath(operatorId), selection);
  }

  async active(operatorId: string): Promise<ProspectDiscoveryRecord | null> {
    const selection = await readJson<ActiveSelection | null>(
      this.selectionPath(operatorId),
      () => null,
    );
    if (!selection) return null;
    if (selection.v !== 1 || selection.operatorId !== operatorId)
      throw new ApiError(409, 'This operator discovery selection is invalid.', {
        code: 'invalid_discovery_selection',
      });
    return this.owned(operatorId, selection.activeProspectId);
  }

  private async requireActive(operatorId: string): Promise<ProspectDiscoveryRecord> {
    const record = await this.active(operatorId);
    if (!record) throw notFound();
    return record;
  }

  async assertActive(operatorId: string, prospectId: string): Promise<ProspectDiscoveryRecord> {
    const record = await this.requireActive(operatorId);
    if (record.prospectId !== prospectId) throw notFound();
    return record;
  }

  async createAndSelect(
    operatorId: string,
    input: CreateProspectDiscoveryInput,
  ): Promise<ProspectDiscoveryRecord> {
    const prospectId = this.deps.id('prospect_');
    let record: ProspectDiscoveryRecord;
    try {
      record = createProspectDiscoveryRecord(
        operatorId,
        prospectId,
        this.deps.id('discovery_'),
        input,
        this.deps,
      );
    } catch (error) {
      throw refusal(error, 400, 'invalid_discovery_record');
    }
    await this.persist(record);
    await this.persistSelection(operatorId, prospectId);
    return record;
  }

  async select(operatorId: string, prospectId: string): Promise<ProspectDiscoveryRecord> {
    const record = await this.owned(operatorId, prospectId);
    await this.persistSelection(operatorId, prospectId);
    return record;
  }

  async importBrief(
    operatorId: string,
    filename: string,
    content: string,
  ): Promise<ProspectDiscoveryRecord> {
    const current = await this.requireActive(operatorId);
    let brief;
    try {
      brief = parseProspectResearchBriefDocument(filename, content);
    } catch (error) {
      throw refusal(error, 400, 'invalid_research_brief');
    }
    const next = importResearchBriefFacts(current, brief, operatorId, this.deps);
    await this.persist(next);
    return next;
  }

  async correctFact(
    operatorId: string,
    input: {
      readonly factId: string;
      readonly value: string | null;
      readonly provenance: FactProvenance;
    },
  ): Promise<ProspectDiscoveryRecord> {
    if (!input.factId || input.factId.length > 160)
      throw new ApiError(400, 'Choose a discovery fact to correct.');
    if (
      input.value !== null &&
      (typeof input.value !== 'string' || !input.value.trim() || input.value.length > 1_000)
    )
      throw new ApiError(400, 'Provide a corrected value of up to 1,000 characters.');
    const provenance = validatedProvenance(input.provenance);
    const current = await this.requireActive(operatorId);
    validateHypothesisSources(current, provenance);
    const prior = currentFact(current, input.factId);
    if (prior.id !== input.factId)
      throw new ApiError(409, 'That fact was already corrected. Refresh the discovery record.', {
        code: 'stale_discovery_fact',
      });
    if (prior.provenance.class === 'public')
      throw new ApiError(
        409,
        'Use the fixed public-fact transition. Contradictions become unknown; observed evidence is a separate fact.',
        { code: 'invalid_public_transition' },
      );
    if (prior.id === current.hypothesisFactId)
      throw new ApiError(409, 'The demo hypothesis is immutable; record its outcome instead.', {
        code: 'immutable_demo_hypothesis',
      });
    if (
      hasPublicLineage(current, prior.id) &&
      (provenance.class === 'observed' || provenance.class === 'hypothesized')
    )
      throw new ApiError(
        409,
        'Public evidence must remain public or reported in its lineage; add observed or hypothesized evidence as a new fact.',
        { code: 'invalid_public_transition' },
      );
    if (
      provenance.class === 'observed' &&
      !(await this.verifyObservedEvidence({
        operatorId,
        prospectId: current.prospectId,
        evidence: provenance.evidence,
      }))
    )
      throw new ApiError(
        403,
        'That observed fact is not backed by approved file or execution evidence.',
        {
          code: 'unverified_observed_evidence',
        },
      );
    let next: ProspectDiscoveryRecord;
    try {
      next = appendFactCorrection(
        current,
        input.factId,
        input.value,
        provenance,
        operatorId,
        this.deps,
      );
    } catch (error) {
      throw refusal(error, 409, 'invalid_fact_correction');
    }
    await this.persist(next);
    return next;
  }

  async addFact(
    operatorId: string,
    input: {
      readonly field: string;
      readonly label: string;
      readonly value: string | null;
      readonly provenance: FactProvenance;
    },
  ): Promise<ProspectDiscoveryRecord> {
    if (
      !input.field.trim() ||
      input.field.length > 240 ||
      !input.label.trim() ||
      input.label.length > 160
    )
      throw new ApiError(400, 'Provide a fact field and label.');
    if (input.value !== null && (!input.value.trim() || input.value.length > 1_000))
      throw new ApiError(400, 'Provide a fact value of up to 1,000 characters.');
    const provenance = validatedProvenance(input.provenance);
    if (provenance.class === 'public')
      throw new ApiError(400, 'Public facts enter through a Prospect Research Brief import.');
    const current = await this.requireActive(operatorId);
    validateHypothesisSources(current, provenance);
    if (
      provenance.class === 'observed' &&
      !(await this.verifyObservedEvidence({
        operatorId,
        prospectId: current.prospectId,
        evidence: provenance.evidence,
      }))
    )
      throw new ApiError(
        403,
        'That observed fact is not backed by approved file or execution evidence.',
        {
          code: 'unverified_observed_evidence',
        },
      );
    let next: ProspectDiscoveryRecord;
    try {
      next = appendDiscoveryFact(current, { ...input, provenance }, operatorId, this.deps);
    } catch (error) {
      throw refusal(error, 409, 'invalid_discovery_fact');
    }
    await this.persist(next);
    return next;
  }

  async transitionPublicFact(
    operatorId: string,
    input:
      | {
          readonly factId: string;
          readonly to: 'reported';
          readonly reportedBy: 'owner' | 'consultant';
        }
      | { readonly factId: string; readonly to: 'unknown'; readonly reason: string }
      | {
          readonly factId: string;
          readonly to: string;
          readonly reportedBy?: 'owner' | 'consultant';
          readonly reason?: string;
        },
  ): Promise<ProspectDiscoveryRecord> {
    const current = await this.requireActive(operatorId);
    let next: ProspectDiscoveryRecord;
    try {
      next = transitionPublic(current, input, operatorId, this.deps);
    } catch (error) {
      throw refusal(error, 409, 'invalid_public_transition');
    }
    await this.persist(next);
    return next;
  }

  async setHypothesisOutcome(
    operatorId: string,
    input: { readonly outcome: HypothesisOutcome; readonly checkedAt: string },
  ): Promise<ProspectDiscoveryRecord> {
    if (
      !HYPOTHESIS_OUTCOMES.includes(input.outcome) ||
      !Number.isFinite(Date.parse(input.checkedAt))
    )
      throw new ApiError(400, 'Choose a hypothesis outcome and provide when it was checked.');
    const current = await this.requireActive(operatorId);
    const next = appendHypothesisOutcome(
      current,
      input.outcome,
      input.checkedAt,
      operatorId,
      this.deps,
    );
    await this.persist(next);
    return next;
  }

  async setClassification(
    operatorId: string,
    input: {
      readonly stage?: DiscoveryStage;
      readonly personalizationLevel?: PersonalizationLevel;
    },
  ): Promise<ProspectDiscoveryRecord> {
    const current = await this.requireActive(operatorId);
    let next: ProspectDiscoveryRecord;
    try {
      next = updateDiscoveryClassification(current, input, operatorId, this.deps);
    } catch (error) {
      throw refusal(error, 409, 'invalid_discovery_classification');
    }
    await this.persist(next);
    return next;
  }

  async exportActive(operatorId: string): Promise<DiscoveryArtifact> {
    return renderDiscoveryExport(await this.requireActive(operatorId));
  }

  /** Call only after the existing Files recorded-write path has returned its durable path. */
  async recordExport(
    operatorId: string,
    reference: Omit<DiscoveryExportReference, 'routeLabel'> & {
      readonly routeLabel?: typeof DISCOVERY_ROUTE_LABEL;
    },
  ): Promise<ProspectDiscoveryRecord> {
    const current = await this.requireActive(operatorId);
    if (!reference.id || !reference.path || !Number.isFinite(Date.parse(reference.createdAt)))
      throw new ApiError(400, 'The discovery export receipt is incomplete.');
    const exportReference: DiscoveryExportReference = {
      ...reference,
      routeLabel: DISCOVERY_ROUTE_LABEL,
    };
    const at = this.deps.now();
    const next: ProspectDiscoveryRecord = {
      ...current,
      exports: [...current.exports, exportReference],
      events: [
        ...current.events,
        {
          id: this.deps.id('event_'),
          kind: 'exported',
          at,
          by: operatorId,
          factIds: [],
          detail: 'Discovery record exported through Files.',
        },
      ],
      updatedAt: at,
    };
    await this.persist(next);
    return next;
  }
}
