/**
 * P01: the versioned pack manifest, its contribution contracts and
 * deterministic dependency resolution.
 *
 * `shared/capability-packs.ts` is the runtime contract the two built-in packs
 * already load through, and nothing here changes it. This file is the
 * installable form every pack is described in: an id, a semver version, a
 * publisher, the range of the pack host contract it was written for, what it
 * contributes (each contribution typed), what it *requests* (a request only -
 * Trust decides at use, `AGENTS.md` decision 14), what it depends on, and a
 * content digest that pins exactly the bytes that were verified.
 *
 * The built-in Software Engineering and Small Business packs, the weekly-brief
 * template and the four industry variants are all expressed in this form
 * (`bundledPackBodies`), without changing how any of them behaves.
 *
 * Pure: no clock, no filesystem, no network, no hashing. The host computes the
 * sha-256 over `canonicalPackBytes` and compares it to `digest`.
 */
import { z } from 'zod';
import {
  CAPABILITY_PACK_CONTRACT_VERSION,
  OUTWARD,
  type CapabilityPackManifest,
} from './capability-packs.js';
import { compareVersions, isRange, isVersion, satisfies } from './semver.js';

/** The version of this manifest format. A store or manifest naming another is refused. */
export const PACK_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * The pack host contract this build serves, as a semver so a manifest can
 * name a range. Its major is `CAPABILITY_PACK_CONTRACT_VERSION`: a breaking
 * change there is a new major here, and every manifest written for `^1` stops
 * resolving rather than loading against a contract it was not written for.
 */
export const PACK_HOST_CONTRACT_REVISION = `${CAPABILITY_PACK_CONTRACT_VERSION}.0.0` as const;

export const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}(?:\.[a-z0-9][a-z0-9-]{0,39}){1,3}$/;
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{1,47}$/;
/** Contained relative paths. Braces are allowed after the first character: fixture templates use them. */
const FILE_PATH =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._{}-]{0,63}\/){0,3}[A-Za-z0-9_-][A-Za-z0-9._{}-]{0,63}$/;
export const PACK_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const text = (max: number) => z.string().trim().min(1).max(max);
const contributionId = z.string().regex(CONTRIBUTION_ID, 'a short kebab-case id');
const capability = z.string().regex(CAPABILITY, 'a kebab-case capability name');
const version = z.string().refine(isVersion, 'a semantic version X.Y.Z');
const range = z.string().refine(isRange, 'a semver range such as ^1.0.0');

/** A tool the pack would register. Its effect is declared; Trust decides whether it may run. */
export const packToolSchema = z.strictObject({
  id: contributionId,
  name: text(80),
  description: text(400),
  /** The most the tool could do. `local-write` still goes through the one recorded write path. */
  effect: z.enum(['read', 'draft', 'local-write']),
  /** Requested capabilities this tool would use. Each must be in `permissions.requested`. */
  uses: z.array(capability).max(16),
});

/** An Agent definition. Like every Agent, it carries no authority of its own. */
export const packAgentSchema = z.strictObject({
  id: contributionId,
  name: text(80),
  role: text(600),
  grantsAuthority: z.literal(false),
});

/** A rule or an instruction file, landing in the existing standing-guidance path. */
export const packRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: contributionId,
    kind: z.enum(['standing', 'correction']),
    description: text(2_000),
  }),
  z.strictObject({
    id: contributionId,
    kind: z.literal('instruction-file'),
    /** A plain project-relative name discovered through `server/paths.ts`, never a path. */
    file: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'a plain file name, not a path'),
    description: text(400),
  }),
]);

/** A context source. It reads inside the Project's guarded paths or the pack's own files. */
export const packContextSchema = z.strictObject({
  id: contributionId,
  kind: z.enum(['project-files', 'approved-files', 'pack-fixtures']),
  description: text(400),
  uses: z.array(capability).max(16),
});

/** A workflow or procedure. It runs on the Core Runtime; `acts` is the literal `false`. */
export const packWorkflowSchema = z.strictObject({
  id: contributionId,
  kind: z.enum(['skill', 'procedure', 'template']),
  name: text(80),
  description: text(400),
  mode: z.enum(['ask', 'plan']).nullable(),
  acts: z.literal(false),
});

/** Where on an existing Console surface the pack lights something up. Never a new surface. */
export const packUiSchema = z.strictObject({
  id: contributionId,
  surface: z.enum(['files', 'thread', 'palette', 'project-settings']),
  label: text(80),
});

export const packPermissionRequestSchema = z.strictObject({
  capability,
  reason: text(300),
});

export const packDependencySchema = z.strictObject({
  id: z.string().regex(PACK_ID_PATTERN),
  range,
});

/** A payload file shipped with a pack. Its sha is inside the digested manifest. */
export const packFileSchema = z.strictObject({
  path: z.string().regex(FILE_PATH, 'a contained relative path'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(0).max(1024 * 1024),
});

const unique = <T extends { id: string }>(items: readonly T[]) =>
  new Set(items.map((item) => item.id)).size === items.length;

const manifestShape = {
  schemaVersion: z.literal(PACK_MANIFEST_SCHEMA_VERSION),
  id: z.string().regex(PACK_ID_PATTERN, 'a dotted lowercase id such as acme.bookkeeping'),
  version,
  name: text(80),
  publisher: z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    name: text(80),
  }),
  description: text(600),
  compatibility: z.strictObject({
    /** The pack host contract range this pack was written for. */
    contract: range,
  }),
  contributions: z.strictObject({
    tools: z.array(packToolSchema).max(32),
    agents: z.array(packAgentSchema).max(16),
    rules: z.array(packRuleSchema).max(32),
    context: z.array(packContextSchema).max(16),
    workflows: z.array(packWorkflowSchema).max(64),
    ui: z.array(packUiSchema).max(16),
  }),
  permissions: z.strictObject({
    /** What the pack asks for. A request is never a grant: Trust decides at use. */
    requested: z.array(packPermissionRequestSchema).max(32),
    grantsAuthority: z.literal(false),
  }),
  dependencies: z.array(packDependencySchema).max(16),
  files: z.array(packFileSchema).max(64),
};

type ManifestShape = z.infer<z.ZodObject<typeof manifestShape>>;

function checkManifest(manifest: ManifestShape, ctx: z.RefinementCtx) {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  const requested = new Set(manifest.permissions.requested.map((item) => item.capability));
  if (requested.size !== manifest.permissions.requested.length)
    issue('A capability is requested twice.', ['permissions', 'requested']);
  for (const item of manifest.permissions.requested)
    if (OUTWARD.test(item.capability))
      issue(`A pack may not request the outward capability ${item.capability}.`, [
        'permissions',
        'requested',
      ]);
  for (const kind of ['tools', 'agents', 'rules', 'context', 'workflows', 'ui'] as const)
    if (!unique(manifest.contributions[kind] as readonly { id: string }[]))
      issue(`Two ${kind} contributions share an id.`, ['contributions', kind]);
  for (const kind of ['tools', 'context'] as const)
    manifest.contributions[kind].forEach((item, index) => {
      for (const used of item.uses)
        if (!requested.has(used))
          issue(`${item.id} uses ${used}, which the pack does not request.`, [
            'contributions',
            kind,
            index,
            'uses',
          ]);
    });
  const deps = manifest.dependencies.map((dep) => dep.id);
  if (new Set(deps).size !== deps.length) issue('A dependency is listed twice.', ['dependencies']);
  if (deps.includes(manifest.id)) issue('A pack cannot depend on itself.', ['dependencies']);
  const paths = manifest.files.map((file) => file.path.toLowerCase());
  if (new Set(paths).size !== paths.length) issue('A file is listed twice.', ['files']);
}

/** Everything but the digest: the part the digest is computed over. */
export const packManifestBodySchema = z.strictObject(manifestShape).superRefine(checkManifest);
export const packManifestSchema = z
  .strictObject({
    ...manifestShape,
    digest: z.string().regex(PACK_DIGEST_PATTERN, 'sha256:<64 lowercase hex>'),
  })
  .superRefine(checkManifest);

export type PackManifestBody = z.infer<typeof packManifestBodySchema>;
export type PackManifest = z.infer<typeof packManifestSchema>;
export type PackTool = z.infer<typeof packToolSchema>;
export type PackAgent = z.infer<typeof packAgentSchema>;
export type PackRule = z.infer<typeof packRuleSchema>;
export type PackContext = z.infer<typeof packContextSchema>;
export type PackWorkflow = z.infer<typeof packWorkflowSchema>;
export type PackUi = z.infer<typeof packUiSchema>;
export type PackDependency = z.infer<typeof packDependencySchema>;
export type PackContributionKey = keyof PackManifestBody['contributions'];

/** Problems in the words a person reads, or an empty list. */
export function manifestProblems(value: unknown, withDigest = true): string[] {
  const result = (withDigest ? packManifestSchema : packManifestBodySchema).safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) =>
    issue.path.length ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message,
  );
}

/**
 * Canonical JSON: object keys sorted at every depth, no whitespace. The same
 * value always gives the same bytes, so the digest does not depend on how a
 * publisher happened to format their file.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The exact text the digest is the sha-256 of: the manifest without its `digest`. */
export function canonicalPackBytes(manifest: PackManifestBody | PackManifest): string {
  const { digest: _digest, ...body } = manifest as PackManifest;
  return canonicalJson(body);
}

// --- dependency resolution ----------------------------------------------------------

export interface PackRequest {
  readonly id: string;
  readonly range: string;
}

export type ResolutionRefusal =
  | {
      readonly code: 'missing';
      readonly packId: string;
      readonly requiredBy: readonly string[];
      readonly message: string;
    }
  | {
      readonly code: 'version-conflict';
      readonly packId: string;
      readonly requiredBy: readonly string[];
      readonly available: readonly string[];
      readonly message: string;
    }
  | {
      readonly code: 'cycle';
      readonly path: readonly string[];
      readonly message: string;
    }
  | {
      readonly code: 'incompatible-contract';
      readonly packId: string;
      readonly versions: readonly string[];
      readonly host: string;
      readonly message: string;
    };

export interface ResolvedPack {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export type PackResolution =
  | { readonly ok: true; readonly order: readonly ResolvedPack[] }
  | { readonly ok: false; readonly refusals: readonly ResolutionRefusal[] };

type Constraint = { readonly range: string; readonly by: string };

const describeBy = (constraints: readonly Constraint[]) =>
  constraints.map((c) => `${c.by} needs ${c.range}`).join('; ');

/**
 * Pick one version of every pack the requests reach, or say exactly why not.
 *
 * Deterministic: ids are visited in sorted order and each takes the newest
 * version that satisfies every range placed on it by the requests and by the
 * other selected packs, and whose contract range admits this host. Selection
 * repeats until it stops changing. There is no backtracking search: when the
 * newest admissible choice leads to a conflict, the conflict is reported with
 * every range that caused it, which is the answer a person can act on.
 *
 * `order` lists dependencies before the packs that need them, ties by id.
 */
export function resolvePacks(input: {
  readonly requests: readonly PackRequest[];
  readonly available: readonly (PackManifest | (PackManifestBody & { digest?: string }))[];
  readonly host?: string;
}): PackResolution {
  const host = input.host ?? PACK_HOST_CONTRACT_REVISION;
  const byId = new Map<string, (PackManifestBody & { digest?: string })[]>();
  for (const manifest of input.available)
    byId.set(manifest.id, [...(byId.get(manifest.id) ?? []), manifest]);
  for (const list of byId.values()) list.sort((a, b) => compareVersions(b.version, a.version));

  let selected = new Map<string, PackManifestBody & { digest?: string }>();
  for (let round = 0; round < 64; round++) {
    const constraints = new Map<string, Constraint[]>();
    const add = (id: string, constraint: Constraint) =>
      constraints.set(id, [...(constraints.get(id) ?? []), constraint]);
    for (const request of input.requests) add(request.id, { range: request.range, by: 'you' });
    for (const manifest of [...selected.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
      for (const dep of manifest.dependencies)
        add(dep.id, { range: dep.range, by: `${manifest.id}@${manifest.version}` });

    const refusals: ResolutionRefusal[] = [];
    const next = new Map<string, PackManifestBody & { digest?: string }>();
    for (const id of [...constraints.keys()].sort()) {
      const on = constraints.get(id)!;
      const all = byId.get(id) ?? [];
      const by = on.map((c) => c.by);
      if (!all.length) {
        refusals.push({
          code: 'missing',
          packId: id,
          requiredBy: by,
          message: `${id} is not available (${describeBy(on)}).`,
        });
        continue;
      }
      const ranged = all.filter((m) => on.every((c) => satisfies(m.version, c.range)));
      if (!ranged.length) {
        const eachAlone = on.every((c) => all.some((m) => satisfies(m.version, c.range)));
        const available = all.map((m) => m.version);
        refusals.push(
          on.length > 1 && eachAlone
            ? {
                code: 'version-conflict',
                packId: id,
                requiredBy: by,
                available,
                message: `No version of ${id} satisfies every range: ${describeBy(on)}. Available: ${available.join(', ')}.`,
              }
            : {
                code: 'missing',
                packId: id,
                requiredBy: by,
                message: `No available version of ${id} satisfies ${describeBy(on)}. Available: ${available.join(', ')}.`,
              },
        );
        continue;
      }
      const compatible = ranged.filter((m) => satisfies(host, m.compatibility.contract));
      if (!compatible.length) {
        refusals.push({
          code: 'incompatible-contract',
          packId: id,
          versions: ranged.map((m) => m.version),
          host,
          message: `${id} ${ranged.map((m) => m.version).join(', ')} was written for pack contract ${ranged[0].compatibility.contract}; this Diomedes serves ${host}.`,
        });
        continue;
      }
      next.set(id, compatible[0]);
    }
    if (refusals.length) return { ok: false, refusals };
    const same =
      next.size === selected.size &&
      [...next].every(([id, m]) => selected.get(id)?.version === m.version);
    selected = next;
    if (same) break;
    if (round === 63)
      return {
        ok: false,
        refusals: [
          {
            code: 'version-conflict',
            packId: [...next.keys()].sort()[0] ?? '',
            requiredBy: [],
            available: [],
            message: 'The dependency ranges never settle on one version of each pack.',
          },
        ],
      };
  }

  // Cycles: depth-first over the selected graph, ids in sorted order.
  const order: ResolvedPack[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): ResolutionRefusal | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') {
      const path = [...stack.slice(stack.indexOf(id)), id];
      return { code: 'cycle', path, message: `These packs depend on each other: ${path.join(' → ')}.` };
    }
    state.set(id, 'visiting');
    stack.push(id);
    const manifest = selected.get(id)!;
    for (const dep of [...manifest.dependencies].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const found = visit(dep.id);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    order.push({ id, version: manifest.version, digest: manifest.digest ?? '' });
    return null;
  };
  for (const id of [...selected.keys()].sort()) {
    const cycle = visit(id);
    if (cycle) return { ok: false, refusals: [cycle] };
  }
  return { ok: true, order };
}

// --- the bundled packs, expressed as manifests ----------------------------------------

const DIOMEDES_PUBLISHER = { id: 'diomedes', name: 'Diomedes' } as const;
const CONTRACT_RANGE = `^${PACK_HOST_CONTRACT_REVISION}`;
const emptyContributions = (): PackManifestBody['contributions'] => ({
  tools: [],
  agents: [],
  rules: [],
  context: [],
  workflows: [],
  ui: [],
});

/**
 * A runtime pack (`CapabilityPackManifest`) in the installable form, adding
 * nothing and removing nothing: its needs become requests, its instruction
 * files become instruction-file rules, its skills become workflows, and its
 * UI affordances are copied as they are.
 */
export function manifestFromCapabilityPack(pack: CapabilityPackManifest): PackManifestBody {
  const contributions = emptyContributions();
  contributions.rules = pack.instructionFiles.map((file) => ({
    id: `instructions-${file.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
    kind: 'instruction-file' as const,
    file,
    description: `Discovered in the project folder as standing guidance when the pack is on.`,
  }));
  if (pack.contributes.includes('context'))
    contributions.context = [
      {
        id: 'project-folder',
        kind: 'project-files',
        description: 'Reads inside the Project folder through the same path guard as everything else.',
        uses: pack.needs.some((need) => need.capability === 'read-project-files')
          ? ['read-project-files']
          : [],
      },
    ];
  contributions.workflows = pack.skills.map((skill) => ({
    id: skill.id,
    kind: 'skill' as const,
    name: skill.name,
    description: skill.value,
    mode: skill.mode,
    acts: false as const,
  }));
  contributions.ui = pack.ui.map((item) => ({ ...item }));
  return {
    schemaVersion: PACK_MANIFEST_SCHEMA_VERSION,
    id: pack.id,
    version: pack.version,
    name: pack.name,
    publisher: { ...DIOMEDES_PUBLISHER },
    description: pack.summary,
    compatibility: { contract: CONTRACT_RANGE },
    contributions,
    permissions: {
      requested: pack.needs.map((need) => ({ capability: need.capability, reason: need.reason })),
      grantsAuthority: false,
    },
    dependencies: [],
    files: [],
  };
}

export const WEEKLY_BRIEF_MANIFEST_ID = 'diomedes.weekly-brief';

/** The weekly-brief template (`shared/packs.ts`) as a manifest. Its variants depend on it. */
export function weeklyBriefPackManifest(): PackManifestBody {
  const contributions = emptyContributions();
  contributions.agents = [
    {
      id: 'weekly-operations-analyst',
      name: 'Weekly Operations Analyst',
      role: 'Prepares the weekly brief from the selected approved exports only, naming the source of each fact.',
      grantsAuthority: false,
    },
    {
      id: 'brief-reviewer',
      name: 'Brief Reviewer',
      role: 'Checks the brief draft against the selected sources and holds back anything they do not support.',
      grantsAuthority: false,
    },
  ];
  contributions.rules = [
    {
      id: 'weekly-brief-guidance',
      kind: 'standing',
      description: 'The guidance sentence the chosen industry variant supplies.',
    },
    {
      id: 'weekly-brief-correction',
      kind: 'correction',
      description: 'A correction the owner records against a brief is applied to the next one.',
    },
  ];
  contributions.context = [
    {
      id: 'approved-exports',
      kind: 'approved-files',
      description: 'Only the exports the owner selected for the brief.',
      uses: ['read-project-files'],
    },
  ];
  contributions.workflows = [
    {
      id: 'weekly-brief',
      kind: 'template',
      name: 'Weekly brief',
      description: 'One approved-files workflow: a short weekly brief drafted and reviewed before the owner reads it.',
      mode: null,
      acts: false,
    },
  ];
  return {
    schemaVersion: PACK_MANIFEST_SCHEMA_VERSION,
    id: WEEKLY_BRIEF_MANIFEST_ID,
    version: '1.0.0',
    name: 'Weekly brief',
    publisher: { ...DIOMEDES_PUBLISHER },
    description:
      'The weekly brief workflow business setup compiles: an analyst drafts from approved exports and a reviewer checks it. It proposes text and stops.',
    compatibility: { contract: CONTRACT_RANGE },
    contributions,
    permissions: {
      requested: [
        {
          capability: 'read-project-files',
          reason: 'To read the approved exports the owner selects for the brief.',
        },
      ],
      grantsAuthority: false,
    },
    dependencies: [],
    files: [],
  };
}

/** What an industry variant manifest needs from `variant.json`. */
export interface IndustryVariantSource {
  readonly id: string;
  readonly label: string;
  readonly outputLabel: string;
  readonly scopeLabel: string;
  readonly guidanceText: string;
  readonly contractVersion: number;
  /** Payload files and their sha-256, so the pack digest pins the variant's bytes. */
  readonly files: readonly { path: string; sha256: string; bytes: number }[];
}

export const industryPackId = (variantId: string) => `diomedes.industry.${variantId}`;

/**
 * One industry variant as a manifest. It depends on the weekly brief, which is
 * what it is a variant of; it contributes its guidance, its sample fixtures
 * and one named brief, and it requests nothing, because sample fixtures ship
 * with the pack.
 */
export function industryVariantPackManifest(variant: IndustryVariantSource): PackManifestBody {
  const contributions = emptyContributions();
  contributions.rules = [
    { id: 'variant-guidance', kind: 'standing', description: variant.guidanceText },
  ];
  contributions.context = [
    {
      id: 'sample-fixtures',
      kind: 'pack-fixtures',
      description: `Synthetic ${variant.scopeLabel.toLowerCase()} for rehearsal, shipped with the pack.`,
      uses: [],
    },
  ];
  contributions.workflows = [
    {
      id: 'weekly-brief-variant',
      kind: 'template',
      name: variant.outputLabel,
      description: `The weekly brief worded for ${variant.label.toLowerCase()}.`,
      mode: null,
      acts: false,
    },
  ];
  return {
    schemaVersion: PACK_MANIFEST_SCHEMA_VERSION,
    id: industryPackId(variant.id),
    version: `${variant.contractVersion}.0.0`,
    name: variant.label,
    publisher: { ...DIOMEDES_PUBLISHER },
    description: `The weekly brief for ${variant.label.toLowerCase()}: its labels, guidance and sample fixtures.`,
    compatibility: { contract: CONTRACT_RANGE },
    contributions,
    permissions: { requested: [], grantsAuthority: false },
    dependencies: [{ id: WEEKLY_BRIEF_MANIFEST_ID, range: '^1.0.0' }],
    files: [...variant.files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((file) => ({ ...file })),
  };
}

/** Every requested capability, in the words the person reads beside "Trust decides at use". */
export const requestedCapabilities = (manifest: PackManifestBody) =>
  manifest.permissions.requested.map((item) => item.capability);

/** Contribution counts by kind, for a compact line. Never the contribution bodies. */
export function contributionSummary(manifest: PackManifestBody): string {
  const parts = (Object.keys(manifest.contributions) as PackContributionKey[])
    .filter((key) => manifest.contributions[key].length)
    .map((key) => `${manifest.contributions[key].length} ${key}`);
  return parts.length ? parts.join(' · ') : 'nothing';
}
