import { z } from 'zod';
import type { ContentOrigin } from './rule-authority.js';

export const DISCOVERY_CONTRACT_VERSION = 1 as const;
export const DISCOVERY_ROUTE_LABEL = 'no-file discovery' as const;

export const DISCOVERY_STAGES = Object.freeze([
  'research',
  'opportunity',
  'demo',
  'discovery',
  'proposed-workflow',
  'pilot',
] as const);
export type DiscoveryStage = (typeof DISCOVERY_STAGES)[number];

export const PERSONALIZATION_LEVELS = Object.freeze([
  'generic',
  'industry',
  'account',
  'account-live-modified',
] as const);
export type PersonalizationLevel = (typeof PERSONALIZATION_LEVELS)[number];

export const HYPOTHESIS_OUTCOMES = Object.freeze([
  'confirmed',
  'not-a-weak-point',
  'unknown',
] as const);
export type HypothesisOutcome = (typeof HYPOTHESIS_OUTCOMES)[number];

export type ObservedEvidence =
  | {
      readonly kind: 'approved-file';
      readonly projectId: string;
      readonly path: string;
      readonly sha: string;
      readonly historyEntryId: string;
    }
  | {
      readonly kind: 'diomedes-execution';
      readonly projectId: string;
      readonly executionId: string;
      readonly historyEntryId: string;
    };

export type FactProvenance =
  | { readonly class: 'observed'; readonly evidence: ObservedEvidence }
  | { readonly class: 'reported'; readonly reportedBy: 'owner' | 'consultant' }
  | { readonly class: 'hypothesized'; readonly sourceFactIds: readonly string[] }
  | { readonly class: 'unknown'; readonly reason: string }
  | { readonly class: 'public'; readonly url: string; readonly retrievedAt: string };

export interface DiscoveryFact {
  readonly id: string;
  readonly field: string;
  readonly label: string;
  readonly value: string | null;
  readonly provenance: FactProvenance;
  readonly origin: ContentOrigin | 'facilitated-conversation';
  readonly recordedAt: string;
  readonly recordedBy: string;
  /** Corrections append; the prior fact is never rewritten or deleted. */
  readonly replacesFactId: string | null;
}

export interface CurrentProcessStep {
  readonly id: string;
  readonly sequence: number;
  readonly actionFactId: string;
  readonly actorFactId: string;
  readonly inputFactIds: readonly string[];
  readonly outputFactIds: readonly string[];
  readonly handoffFactIds: readonly string[];
  readonly timingFactId: string | null;
  readonly painPointFactIds: readonly string[];
}

export interface DiscoveryEvent {
  readonly id: string;
  readonly kind:
    | 'created'
    | 'fact-added'
    | 'fact-corrected'
    | 'brief-imported'
    | 'classification-changed'
    | 'hypothesis-checked'
    | 'exported';
  readonly at: string;
  readonly by: string;
  readonly factIds: readonly string[];
  readonly detail: string;
}

export interface HypothesisOutcomeRecord {
  readonly outcome: HypothesisOutcome;
  readonly checkedAt: string;
  readonly recordedAt: string;
}

export interface DiscoveryExportReference {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
  readonly routeLabel: typeof DISCOVERY_ROUTE_LABEL;
}

export interface ProspectDiscoveryRecord {
  readonly v: typeof DISCOVERY_CONTRACT_VERSION;
  readonly id: string;
  readonly prospectId: string;
  /** Consultant identity. The owner-facing projection never renders this. */
  readonly operatorId: string;
  readonly prospectName: string;
  readonly stage: DiscoveryStage;
  readonly personalizationLevel: PersonalizationLevel;
  readonly goalFactIds: readonly string[];
  readonly currentProcess: readonly CurrentProcessStep[];
  readonly facts: readonly DiscoveryFact[];
  readonly hypothesisFactId: string;
  readonly hypothesisWorkflowFamily: string;
  readonly hypothesisOutcomes: readonly HypothesisOutcomeRecord[];
  readonly events: readonly DiscoveryEvent[];
  readonly exports: readonly DiscoveryExportReference[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DiscoveryArtifact {
  readonly suggestedPath: string;
  readonly text: string;
  readonly routeLabel: typeof DISCOVERY_ROUTE_LABEL;
  readonly origin: 'generated-artifact';
  readonly prospectId: string;
  readonly recordId: string;
}

const shortText = (max: number) => z.string().trim().min(1).max(max);
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        context.addIssue({
          code: 'custom',
          message: 'Use an http(s) URL without embedded credentials.',
        });
    } catch {
      context.addIssue({ code: 'custom', message: 'Use a valid http(s) URL.' });
    }
  });
const retrievedAt = z
  .string()
  .trim()
  .max(40)
  .refine((value) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return false;
    const canonical = parsed.toISOString();
    return value.endsWith('.000Z')
      ? canonical === value
      : canonical.replace('.000Z', 'Z') === value;
  }, 'Use a real ISO date or UTC date-time.');
const optionalUrl = httpUrl.optional();
const sourceSchema = z
  .object({
    url: httpUrl,
    retrievedAt,
  })
  .strict();
const contactSchema = z
  .object({
    phone: shortText(80).optional(),
    email: z.email().max(320).optional(),
    website: httpUrl.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some(Boolean),
    'Provide at least one public business contact.',
  );
const sourcedLabelSchema = z.object({ label: shortText(160), url: optionalUrl }).strict();
const locationSchema = z
  .object({ name: shortText(160), city: shortText(120).optional(), url: optionalUrl })
  .strict();

export const prospectResearchBriefSchema = z
  .object({
    business: z
      .object({
        name: shortText(160),
        category: shortText(120),
        city: shortText(120),
        publicBusinessContact: contactSchema.optional(),
      })
      .strict(),
    locations: z.array(locationSchema).max(50),
    services: z.array(sourcedLabelSchema).max(100),
    namedSoftware: z.array(sourcedLabelSchema).max(100),
    sources: z.array(sourceSchema).min(1).max(100),
    observations: z
      .array(z.object({ text: shortText(500), source: z.number().int().min(0) }).strict())
      .max(100),
    hypothesis: z
      .object({ workflowFamily: shortText(120), variantId: shortText(120).optional() })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    value.observations.forEach((observation, index) => {
      if (observation.source >= value.sources.length)
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'source'],
          message: 'Reference an entry in sources.',
        });
    });
    const known = new Set(value.sources.map((source) => source.url));
    const cited = [
      {
        path: ['business', 'publicBusinessContact', 'website'],
        url: value.business.publicBusinessContact?.website,
      },
      ...value.locations.map((item, index) => ({
        path: ['locations', index, 'url'],
        url: item.url,
      })),
      ...value.services.map((item, index) => ({ path: ['services', index, 'url'], url: item.url })),
      ...value.namedSoftware.map((item, index) => ({
        path: ['namedSoftware', index, 'url'],
        url: item.url,
      })),
    ];
    for (const item of cited)
      if (item.url && !known.has(item.url))
        context.addIssue({ code: 'custom', path: item.path, message: 'Add this URL to sources.' });
  });
export type ProspectResearchBrief = z.infer<typeof prospectResearchBriefSchema>;

const processStepInputSchema = z
  .object({
    action: shortText(500),
    actor: shortText(200),
    inputs: z.array(shortText(300)).max(30),
    outputs: z.array(shortText(300)).max(30),
    handoffs: z.array(shortText(300)).max(30),
    timing: shortText(200).nullable().optional(),
    painPoints: z.array(shortText(500)).max(30),
  })
  .strict();

export const createProspectDiscoverySchema = z
  .object({
    prospectName: shortText(160),
    goals: z.array(shortText(500)).min(1).max(20),
    currentProcess: z.array(processStepInputSchema).min(1).max(50),
    hypothesis: z.object({ statement: shortText(500), workflowFamily: shortText(120) }).strict(),
    stage: z.enum(DISCOVERY_STAGES).default('discovery'),
    personalizationLevel: z.enum(PERSONALIZATION_LEVELS).default('account'),
  })
  .strict();
export type CreateProspectDiscoveryInput = z.input<typeof createProspectDiscoverySchema>;

const storedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), 'Stored text must not have surrounding whitespace.');
const storedId = storedText(160);
const isoTimestamp = z
  .string()
  .max(40)
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    {
      message: 'Use a canonical ISO timestamp.',
    },
  );

export const observedEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('approved-file'),
      projectId: storedId,
      path: storedText(1_000),
      sha: z.string().regex(/^[a-f0-9]{64}$/),
      historyEntryId: storedId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('diomedes-execution'),
      projectId: storedId,
      executionId: storedId,
      historyEntryId: storedId,
    })
    .strict(),
]);

export const factProvenanceSchema = z.discriminatedUnion('class', [
  z.object({ class: z.literal('observed'), evidence: observedEvidenceSchema }).strict(),
  z.object({ class: z.literal('reported'), reportedBy: z.enum(['owner', 'consultant']) }).strict(),
  z
    .object({
      class: z.literal('hypothesized'),
      sourceFactIds: z.array(storedId).max(100),
    })
    .strict(),
  z.object({ class: z.literal('unknown'), reason: storedText(500) }).strict(),
  z.object({ class: z.literal('public'), url: httpUrl, retrievedAt }).strict(),
]);

const discoveryFactSchema = z
  .object({
    id: storedId,
    field: storedText(240),
    label: storedText(160),
    value: z.string().max(1_000).nullable(),
    provenance: factProvenanceSchema,
    origin: z.enum([
      'administrative',
      'imported-document',
      'connector-output',
      'questionnaire-free-text',
      'model-output',
      'facilitated-conversation',
    ]),
    recordedAt: isoTimestamp,
    recordedBy: storedId,
    replacesFactId: storedId.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provenance.class === 'unknown' && value.value !== null)
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Unknown facts have no value.',
      });
    if (value.provenance.class !== 'unknown' && (value.value === null || !value.value.trim()))
      context.addIssue({ code: 'custom', path: ['value'], message: 'Known facts need a value.' });
  });

const currentProcessStepSchema = z
  .object({
    id: storedId,
    sequence: z.number().int().min(1).max(50),
    actionFactId: storedId,
    actorFactId: storedId,
    inputFactIds: z.array(storedId).max(30),
    outputFactIds: z.array(storedId).max(30),
    handoffFactIds: z.array(storedId).max(30),
    timingFactId: storedId.nullable(),
    painPointFactIds: z.array(storedId).max(30),
  })
  .strict();

const discoveryEventSchema = z
  .object({
    id: storedId,
    kind: z.enum([
      'created',
      'fact-added',
      'fact-corrected',
      'brief-imported',
      'classification-changed',
      'hypothesis-checked',
      'exported',
    ]),
    at: isoTimestamp,
    by: storedId,
    factIds: z.array(storedId).max(200),
    detail: storedText(1_000),
  })
  .strict();

const discoveryExportReferenceSchema = z
  .object({
    id: storedId,
    path: storedText(1_000),
    createdAt: isoTimestamp,
    routeLabel: z.literal(DISCOVERY_ROUTE_LABEL),
  })
  .strict();

export const prospectDiscoveryRecordSchema = z
  .object({
    v: z.literal(DISCOVERY_CONTRACT_VERSION),
    id: storedId,
    prospectId: storedId,
    operatorId: storedId,
    prospectName: storedText(160),
    stage: z.enum(DISCOVERY_STAGES),
    personalizationLevel: z.enum(PERSONALIZATION_LEVELS),
    goalFactIds: z.array(storedId).min(1).max(20),
    currentProcess: z.array(currentProcessStepSchema).min(1).max(50),
    facts: z.array(discoveryFactSchema).min(1).max(5_000),
    hypothesisFactId: storedId,
    hypothesisWorkflowFamily: storedText(120),
    hypothesisOutcomes: z
      .array(
        z
          .object({
            outcome: z.enum(HYPOTHESIS_OUTCOMES),
            checkedAt: isoTimestamp,
            recordedAt: isoTimestamp,
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    events: z.array(discoveryEventSchema).min(1).max(10_000),
    exports: z.array(discoveryExportReferenceSchema).max(1_000),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  })
  .strict()
  .superRefine((record, context) => {
    const factById = new Map<string, (typeof record.facts)[number]>();
    record.facts.forEach((fact, index) => {
      if (factById.has(fact.id))
        context.addIssue({
          code: 'custom',
          path: ['facts', index, 'id'],
          message: 'Fact ids must be unique.',
        });
      else factById.set(fact.id, fact);
    });
    const requireFact = (id: string, path: Array<string | number>) => {
      if (!factById.has(id))
        context.addIssue({
          code: 'custom',
          path,
          message: `Fact ${id} does not exist in this record.`,
        });
    };
    record.goalFactIds.forEach((id, index) => requireFact(id, ['goalFactIds', index]));
    record.currentProcess.forEach((step, index) => {
      const refs = [
        ['actionFactId', step.actionFactId],
        ['actorFactId', step.actorFactId],
        ...step.inputFactIds.map((id, item) => [`inputFactIds.${item}`, id]),
        ...step.outputFactIds.map((id, item) => [`outputFactIds.${item}`, id]),
        ...step.handoffFactIds.map((id, item) => [`handoffFactIds.${item}`, id]),
        ...(step.timingFactId ? [['timingFactId', step.timingFactId]] : []),
        ...step.painPointFactIds.map((id, item) => [`painPointFactIds.${item}`, id]),
      ] as const;
      refs.forEach(([field, id]) => requireFact(id, ['currentProcess', index, field]));
      if (step.sequence !== index + 1)
        context.addIssue({
          code: 'custom',
          path: ['currentProcess', index, 'sequence'],
          message: 'Process sequence must be contiguous.',
        });
    });
    requireFact(record.hypothesisFactId, ['hypothesisFactId']);
    const hypothesis = factById.get(record.hypothesisFactId);
    if (hypothesis?.field !== 'demoHypothesis' || hypothesis.provenance.class !== 'hypothesized')
      context.addIssue({
        code: 'custom',
        path: ['hypothesisFactId'],
        message: 'The demo hypothesis must name the distinguished hypothesized fact.',
      });
    if (record.facts.filter((fact) => fact.field === 'demoHypothesis').length !== 1)
      context.addIssue({
        code: 'custom',
        path: ['facts'],
        message: 'A discovery record has exactly one demo hypothesis.',
      });

    const replacementByPrior = new Map<string, string>();
    record.facts.forEach((fact, index) => {
      if (fact.provenance.class === 'hypothesized')
        fact.provenance.sourceFactIds.forEach((id, sourceIndex) =>
          requireFact(id, ['facts', index, 'provenance', 'sourceFactIds', sourceIndex]),
        );
      if (!fact.replacesFactId) return;
      const prior = factById.get(fact.replacesFactId);
      if (!prior) return requireFact(fact.replacesFactId, ['facts', index, 'replacesFactId']);
      if (replacementByPrior.has(prior.id))
        context.addIssue({
          code: 'custom',
          path: ['facts', index, 'replacesFactId'],
          message: 'Fact correction history cannot fork.',
        });
      replacementByPrior.set(prior.id, fact.id);
      if (prior.field !== fact.field || prior.label !== fact.label)
        context.addIssue({
          code: 'custom',
          path: ['facts', index],
          message: 'A correction keeps the same fact field and label.',
        });
      if (prior.provenance.class === 'public') {
        if (!['reported', 'unknown'].includes(fact.provenance.class))
          context.addIssue({
            code: 'custom',
            path: ['facts', index, 'provenance'],
            message: 'Public facts transition only to reported or unknown.',
          });
        if (fact.provenance.class === 'reported' && fact.value !== prior.value)
          context.addIssue({
            code: 'custom',
            path: ['facts', index, 'value'],
            message: 'Public confirmation keeps the public value.',
          });
      }
    });
    record.facts.forEach((fact, index) => {
      const seen = new Set<string>();
      let cursor: (typeof record.facts)[number] | undefined = fact;
      let publicLineage = false;
      while (cursor) {
        if (seen.has(cursor.id)) {
          context.addIssue({
            code: 'custom',
            path: ['facts', index, 'replacesFactId'],
            message: 'Fact correction history cannot contain a cycle.',
          });
          break;
        }
        seen.add(cursor.id);
        publicLineage ||= cursor.provenance.class === 'public';
        cursor = cursor.replacesFactId ? factById.get(cursor.replacesFactId) : undefined;
      }
      if (publicLineage && ['observed', 'hypothesized'].includes(fact.provenance.class))
        context.addIssue({
          code: 'custom',
          path: ['facts', index, 'provenance'],
          message: 'Public lineage cannot become observed or hypothesized.',
        });
    });
    record.events.forEach((event, index) =>
      event.factIds.forEach((id, item) => requireFact(id, ['events', index, 'factIds', item])),
    );
  });

export function parseProspectDiscoveryRecord(value: unknown): ProspectDiscoveryRecord {
  const result = prospectDiscoveryRecordSchema.safeParse(value);
  if (!result.success)
    throw new Error(`Stored discovery record refused: ${issuePath(result.error)}.`);
  return result.data as ProspectDiscoveryRecord;
}

function issuePath(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => {
      const base = issue.path.map(String).join('.');
      if (issue.code === 'unrecognized_keys')
        return issue.keys.map((key) => [base, key].filter(Boolean).join('.'));
      return [base || issue.message];
    })
    .join(', ');
}

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Bounded YAML front matter parser for this data-only schema; no tags, anchors or executable types. */
function parseSimpleYaml(text: string): unknown {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [
    { indent: -1, value: root },
  ];
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex]!;
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0)
      throw new Error(`Front matter line ${lineIndex + 1} must use two-space indentation.`);
    const content = raw.trim();
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop();
    const parent = stack.at(-1)!.value;

    if (content.startsWith('- ')) {
      if (!Array.isArray(parent))
        throw new Error(`Front matter line ${lineIndex + 1} is not inside a list.`);
      const item = content.slice(2);
      const colon = item.indexOf(':');
      if (colon < 1) {
        parent.push(scalar(item));
        continue;
      }
      const object: Record<string, unknown> = {};
      parent.push(object);
      const key = item.slice(0, colon).trim();
      const rest = item.slice(colon + 1).trim();
      object[key] = rest ? scalar(rest) : {};
      stack.push({ indent, value: object });
      if (!rest) stack.push({ indent: indent + 1, value: object[key] as Record<string, unknown> });
      continue;
    }

    if (Array.isArray(parent))
      throw new Error(`Front matter line ${lineIndex + 1} must be a list item.`);
    const colon = content.indexOf(':');
    if (colon < 1) throw new Error(`Front matter line ${lineIndex + 1} must contain a key.`);
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    if (rest) {
      parent[key] = scalar(rest);
      continue;
    }
    const next = lines
      .slice(lineIndex + 1)
      .find((candidate) => candidate.trim() && !candidate.trimStart().startsWith('#'));
    const child: Record<string, unknown> | unknown[] = next?.trimStart().startsWith('- ') ? [] : {};
    parent[key] = child;
    stack.push({ indent, value: child });
  }
  return root;
}

export function parseProspectResearchBriefDocument(
  filename: string,
  content: string,
): ProspectResearchBrief {
  const lower = filename.toLowerCase();
  let candidate: unknown;
  try {
    if (lower.endsWith('.json')) candidate = JSON.parse(content);
    else if (lower.endsWith('.md')) {
      const normalized = content.replaceAll('\r\n', '\n');
      if (!normalized.startsWith('---\n'))
        throw new Error('Markdown research briefs need front matter.');
      const end = normalized.indexOf('\n---', 4);
      if (end < 0) throw new Error('Markdown research brief front matter is not closed.');
      const frontMatter = normalized.slice(4, end).trim();
      try {
        candidate = JSON.parse(frontMatter);
      } catch {
        candidate = parseSimpleYaml(frontMatter);
      }
    } else throw new Error('Prospect Research Briefs must be .json or .md files.');
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'The Prospect Research Brief could not be read.',
    );
  }
  const result = prospectResearchBriefSchema.safeParse(candidate);
  if (!result.success)
    throw new Error(`Prospect Research Brief refused: ${issuePath(result.error)}.`);
  return result.data;
}

export interface DiscoveryFactoryDependencies {
  readonly now: () => string;
  readonly id: (prefix: string) => string;
}

function fact(
  deps: DiscoveryFactoryDependencies,
  by: string,
  input: Omit<DiscoveryFact, 'id' | 'recordedAt' | 'recordedBy' | 'replacesFactId'> & {
    replacesFactId?: string | null;
  },
): DiscoveryFact {
  return {
    ...input,
    id: deps.id('fact_'),
    recordedAt: deps.now(),
    recordedBy: by,
    replacesFactId: input.replacesFactId ?? null,
  };
}

export function createProspectDiscoveryRecord(
  operatorId: string,
  prospectId: string,
  recordId: string,
  candidate: CreateProspectDiscoveryInput,
  deps: DiscoveryFactoryDependencies,
): ProspectDiscoveryRecord {
  const input = createProspectDiscoverySchema.parse(candidate);
  const facts: DiscoveryFact[] = [];
  const reported = (field: string, label: string, value: string) => {
    const created = fact(deps, operatorId, {
      field,
      label,
      value,
      provenance: { class: 'reported', reportedBy: 'consultant' },
      origin: 'facilitated-conversation',
    });
    facts.push(created);
    return created.id;
  };
  const goalFactIds = input.goals.map((value, index) => reported(`goals.${index}`, 'Goal', value));
  const currentProcess = input.currentProcess.map(
    (step, index): CurrentProcessStep => ({
      id: deps.id('step_'),
      sequence: index + 1,
      actionFactId: reported(`currentProcess.${index}.action`, 'Action', step.action),
      actorFactId: reported(`currentProcess.${index}.actor`, 'Actor', step.actor),
      inputFactIds: step.inputs.map((value, item) =>
        reported(`currentProcess.${index}.inputs.${item}`, 'Input', value),
      ),
      outputFactIds: step.outputs.map((value, item) =>
        reported(`currentProcess.${index}.outputs.${item}`, 'Output', value),
      ),
      handoffFactIds: step.handoffs.map((value, item) =>
        reported(`currentProcess.${index}.handoffs.${item}`, 'Hand-off', value),
      ),
      timingFactId: step.timing
        ? reported(`currentProcess.${index}.timing`, 'Timing', step.timing)
        : null,
      painPointFactIds: step.painPoints.map((value, item) =>
        reported(`currentProcess.${index}.painPoints.${item}`, 'Pain point', value),
      ),
    }),
  );
  const hypothesis = fact(deps, operatorId, {
    field: 'demoHypothesis',
    label: 'Demo hypothesis',
    value: input.hypothesis.statement,
    provenance: {
      class: 'hypothesized',
      sourceFactIds: currentProcess.flatMap((step) => step.painPointFactIds),
    },
    origin: 'facilitated-conversation',
  });
  facts.push(hypothesis);
  const at = deps.now();
  return {
    v: DISCOVERY_CONTRACT_VERSION,
    id: recordId,
    prospectId,
    operatorId,
    prospectName: input.prospectName,
    stage: input.stage,
    personalizationLevel: input.personalizationLevel,
    goalFactIds,
    currentProcess,
    facts,
    hypothesisFactId: hypothesis.id,
    hypothesisWorkflowFamily: input.hypothesis.workflowFamily,
    hypothesisOutcomes: [{ outcome: 'unknown', checkedAt: at, recordedAt: at }],
    events: [
      {
        id: deps.id('event_'),
        kind: 'created',
        at,
        by: operatorId,
        factIds: facts.map((item) => item.id),
        detail: 'Facilitated discovery record created from the current-process conversation.',
      },
    ],
    exports: [],
    createdAt: at,
    updatedAt: at,
  };
}

export function currentFact(record: ProspectDiscoveryRecord, originalId: string): DiscoveryFact {
  const replacements = new Map(
    record.facts
      .filter((item) => item.replacesFactId)
      .map((item) => [item.replacesFactId!, item] as const),
  );
  let current = record.facts.find((item) => item.id === originalId);
  if (!current) throw new Error('That discovery fact does not exist.');
  const seen = new Set<string>();
  while (replacements.has(current.id)) {
    if (seen.has(current.id)) throw new Error('The discovery fact history is invalid.');
    seen.add(current.id);
    current = replacements.get(current.id)!;
  }
  return current;
}

export function activeDiscoveryFacts(record: ProspectDiscoveryRecord): readonly DiscoveryFact[] {
  const replaced = new Set(
    record.facts.flatMap((item) => (item.replacesFactId ? [item.replacesFactId] : [])),
  );
  return record.facts.filter((item) => !replaced.has(item.id));
}

export function discoveryProspectName(record: ProspectDiscoveryRecord): string {
  return record.prospectName;
}

function publicSource(brief: ProspectResearchBrief, url?: string) {
  return brief.sources.find((source) => source.url === url) ?? brief.sources[0]!;
}

export function importResearchBriefFacts(
  record: ProspectDiscoveryRecord,
  brief: ProspectResearchBrief,
  by: string,
  deps: DiscoveryFactoryDependencies,
): ProspectDiscoveryRecord {
  const added: DiscoveryFact[] = [];
  const existingPublicFacts = new Set(
    record.facts.flatMap((item) =>
      item.origin === 'imported-document' && item.provenance.class === 'public'
        ? [
            JSON.stringify([
              item.field,
              item.label,
              item.value,
              item.provenance.url,
              item.provenance.retrievedAt,
            ]),
          ]
        : [],
    ),
  );
  const add = (field: string, label: string, value: string, url?: string) => {
    const source = publicSource(brief, url);
    const identity = JSON.stringify([field, label, value, source.url, source.retrievedAt]);
    if (existingPublicFacts.has(identity)) return;
    existingPublicFacts.add(identity);
    added.push(
      fact(deps, by, {
        field,
        label,
        value,
        provenance: { class: 'public', url: source.url, retrievedAt: source.retrievedAt },
        origin: 'imported-document',
      }),
    );
  };
  add('business.name', 'Business name', brief.business.name);
  add('business.category', 'Business category', brief.business.category);
  add('business.city', 'Business city', brief.business.city);
  if (brief.business.publicBusinessContact?.phone)
    add(
      'business.publicBusinessContact.phone',
      'Public business phone',
      brief.business.publicBusinessContact.phone,
    );
  if (brief.business.publicBusinessContact?.email)
    add(
      'business.publicBusinessContact.email',
      'Public business email',
      brief.business.publicBusinessContact.email,
    );
  if (brief.business.publicBusinessContact?.website)
    add(
      'business.publicBusinessContact.website',
      'Public business website',
      brief.business.publicBusinessContact.website,
      brief.business.publicBusinessContact.website,
    );
  brief.locations.forEach((item, index) => {
    add(`locations.${index}.name`, 'Public location', item.name, item.url);
    if (item.city) add(`locations.${index}.city`, 'Location city', item.city, item.url);
  });
  brief.services.forEach((item, index) =>
    add(`services.${index}.label`, 'Published service', item.label, item.url),
  );
  brief.namedSoftware.forEach((item, index) =>
    add(`namedSoftware.${index}.label`, 'Publicly named software', item.label, item.url),
  );
  brief.sources.forEach((source, index) =>
    add(`sources.${index}.url`, 'Public source', source.url, source.url),
  );
  brief.observations.forEach((item, index) => {
    const source = brief.sources[item.source]!;
    add(`observations.${index}`, 'Public observation', item.text, source.url);
  });
  add(
    'researchHypothesis.workflowFamily',
    'Research workflow family',
    brief.hypothesis.workflowFamily,
  );
  if (brief.hypothesis.variantId)
    add('researchHypothesis.variantId', 'Research variant', brief.hypothesis.variantId);
  if (!added.length) return record;
  const at = deps.now();
  return {
    ...record,
    facts: [...record.facts, ...added],
    events: [
      ...record.events,
      {
        id: deps.id('event_'),
        kind: 'brief-imported',
        at,
        by,
        factIds: added.map((item) => item.id),
        detail: 'Imported a Prospect Research Brief as public facts.',
      },
    ],
    updatedAt: at,
  };
}

export function appendFactCorrection(
  record: ProspectDiscoveryRecord,
  factId: string,
  value: string | null,
  provenance: FactProvenance,
  by: string,
  deps: DiscoveryFactoryDependencies,
): ProspectDiscoveryRecord {
  const prior = currentFact(record, factId);
  if (prior.id !== factId) throw new Error('Correct the current fact, not an earlier version.');
  if (provenance.class === 'public')
    throw new Error('Public facts can only come from an imported research brief.');
  const replacement = fact(deps, by, {
    field: prior.field,
    label: prior.label,
    value,
    provenance,
    origin: 'facilitated-conversation',
    replacesFactId: prior.id,
  });
  const at = deps.now();
  return {
    ...record,
    facts: [...record.facts, replacement],
    events: [
      ...record.events,
      {
        id: deps.id('event_'),
        kind: 'fact-corrected',
        at,
        by,
        factIds: [prior.id, replacement.id],
        detail: 'A correction replaced the active value while preserving the earlier fact.',
      },
    ],
    updatedAt: at,
  };
}

export function appendDiscoveryFact(
  record: ProspectDiscoveryRecord,
  input: {
    readonly field: string;
    readonly label: string;
    readonly value: string | null;
    readonly provenance: FactProvenance;
  },
  by: string,
  deps: DiscoveryFactoryDependencies,
): ProspectDiscoveryRecord {
  if (input.field === 'demoHypothesis' || input.label === 'Demo hypothesis')
    throw new Error('This record already has its one demo hypothesis.');
  const created = fact(deps, by, {
    ...input,
    origin: 'facilitated-conversation',
  });
  const at = deps.now();
  return {
    ...record,
    facts: [...record.facts, created],
    events: [
      ...record.events,
      {
        id: deps.id('event_'),
        kind: 'fact-added',
        at,
        by,
        factIds: [created.id],
        detail: 'A discovery fact was added with its source class.',
      },
    ],
    updatedAt: at,
  };
}

export function transitionPublicFact(
  record: ProspectDiscoveryRecord,
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
  by: string,
  deps: DiscoveryFactoryDependencies,
): ProspectDiscoveryRecord {
  const prior = currentFact(record, input.factId);
  if (prior.provenance.class !== 'public')
    throw new Error('Only a current public fact uses this transition.');
  if (input.to === 'reported')
    return appendFactCorrection(
      record,
      input.factId,
      prior.value,
      { class: 'reported', reportedBy: input.reportedBy ?? 'owner' },
      by,
      deps,
    );
  if (input.to === 'unknown')
    return appendFactCorrection(
      record,
      input.factId,
      null,
      {
        class: 'unknown',
        reason: input.reason?.trim() || 'The owner contradicted the public source.',
      },
      by,
      deps,
    );
  throw new Error(
    `A public fact cannot become ${input.to}. Create a separate fact with its own source.`,
  );
}

export function appendHypothesisOutcome(
  record: ProspectDiscoveryRecord,
  outcome: HypothesisOutcome,
  checkedAt: string,
  by: string,
  deps: DiscoveryFactoryDependencies,
): ProspectDiscoveryRecord {
  const at = deps.now();
  return {
    ...record,
    hypothesisOutcomes: [...record.hypothesisOutcomes, { outcome, checkedAt, recordedAt: at }],
    events: [
      ...record.events,
      {
        id: deps.id('event_'),
        kind: 'hypothesis-checked',
        at,
        by,
        factIds: [record.hypothesisFactId],
        detail: `Demo hypothesis outcome recorded as ${outcome}.`,
      },
    ],
    updatedAt: at,
  };
}

export function updateDiscoveryClassification(
  record: ProspectDiscoveryRecord,
  input: { readonly stage?: DiscoveryStage; readonly personalizationLevel?: PersonalizationLevel },
  by: string,
  deps: DiscoveryFactoryDependencies,
): ProspectDiscoveryRecord {
  if (input.stage === 'pilot')
    throw new Error('Only the later pilot promotion path may set pilot.');
  if (input.stage && DISCOVERY_STAGES.indexOf(input.stage) < DISCOVERY_STAGES.indexOf(record.stage))
    throw new Error('Discovery stage moves forward; an earlier stage cannot replace this one.');
  if (
    input.personalizationLevel &&
    PERSONALIZATION_LEVELS.indexOf(input.personalizationLevel) <
      PERSONALIZATION_LEVELS.indexOf(record.personalizationLevel)
  )
    throw new Error('Personalization level cannot move backward.');
  const at = deps.now();
  return {
    ...record,
    stage: input.stage ?? record.stage,
    personalizationLevel: input.personalizationLevel ?? record.personalizationLevel,
    events: [
      ...record.events,
      {
        id: deps.id('event_'),
        kind: 'classification-changed',
        at,
        by,
        factIds: [],
        detail: 'Discovery stage or personalization level changed.',
      },
    ],
    updatedAt: at,
  };
}

function provenanceText(provenance: FactProvenance): string {
  switch (provenance.class) {
    case 'observed':
      return provenance.evidence.kind === 'approved-file'
        ? `Observed from approved file ${provenance.evidence.path} (${provenance.evidence.sha})`
        : `Observed from Diomedes execution ${provenance.evidence.executionId}`;
    case 'reported':
      return `Reported by ${provenance.reportedBy}`;
    case 'hypothesized':
      return 'Hypothesized';
    case 'unknown':
      return `Unknown: ${provenance.reason}`;
    case 'public':
      return `Public: ${provenance.url} (retrieved ${provenance.retrievedAt})`;
  }
}

export function displayProvenance(provenance: FactProvenance): string {
  return provenanceText(provenance);
}

const valueOf = (record: ProspectDiscoveryRecord, id: string) =>
  currentFact(record, id).value ?? 'Unknown';
const listLine = (record: ProspectDiscoveryRecord, id: string) => {
  const item = currentFact(record, id);
  return `- ${item.value ?? 'Unknown'} — ${provenanceText(item.provenance)}`;
};

export function renderDiscoveryExport(record: ProspectDiscoveryRecord): DiscoveryArtifact {
  const prospectName = discoveryProspectName(record);
  const hypothesis = currentFact(record, record.hypothesisFactId);
  const outcome = record.hypothesisOutcomes.at(-1)!;
  const lines = [
    `# Discovery — ${prospectName}`,
    '',
    `Route: ${DISCOVERY_ROUTE_LABEL}`,
    `Stage: ${record.stage}`,
    `Personalization: ${record.personalizationLevel}`,
    '',
    '## Goals',
    ...record.goalFactIds.map((id) => listLine(record, id)),
    '',
    '## Current process',
  ];
  for (const step of record.currentProcess) {
    lines.push('', `### ${step.sequence}. ${valueOf(record, step.actionFactId)}`);
    lines.push(`- Actor: ${listLine(record, step.actorFactId).slice(2)}`);
    for (const id of step.inputFactIds) lines.push(`- Input: ${listLine(record, id).slice(2)}`);
    for (const id of step.outputFactIds) lines.push(`- Output: ${listLine(record, id).slice(2)}`);
    for (const id of step.handoffFactIds)
      lines.push(`- Hand-off: ${listLine(record, id).slice(2)}`);
    if (step.timingFactId) lines.push(`- Timing: ${listLine(record, step.timingFactId).slice(2)}`);
    for (const id of step.painPointFactIds)
      lines.push(`- Pain point: ${listLine(record, id).slice(2)}`);
  }
  lines.push(
    '',
    '## Demo hypothesis',
    `${hypothesis.value ?? 'Unknown'} — ${provenanceText(hypothesis.provenance)}`,
    `Outcome: ${outcome.outcome === 'not-a-weak-point' ? 'Not a weak point' : outcome.outcome === 'confirmed' ? 'Confirmed' : 'Unknown'} (checked ${outcome.checkedAt})`,
    '',
    '## Active facts',
    ...activeDiscoveryFacts(record).map(
      (item) => `- ${item.label}: ${item.value ?? 'Unknown'} — ${provenanceText(item.provenance)}`,
    ),
    '',
    '## Fact history',
    ...record.facts.map(
      (item) =>
        `- ${item.recordedAt} · ${item.label}: ${item.value ?? 'Unknown'} — ${provenanceText(item.provenance)}${item.replacesFactId ? ` · corrected ${item.replacesFactId}` : ''}`,
    ),
    '',
  );
  const safeName = prospectName.replaceAll(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'Prospect';
  return {
    suggestedPath: `Discovery/${safeName}.md`,
    text: lines.join('\n'),
    routeLabel: DISCOVERY_ROUTE_LABEL,
    origin: 'generated-artifact',
    prospectId: record.prospectId,
    recordId: record.id,
  };
}
