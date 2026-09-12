/**
 * Capability packs: what a pack declares, and the record of one being active in
 * one Project.
 *
 * This is the contract behind `AGENTS.md` decisions 13 and 14 and
 * `docs/product/2026-09-10-capability-packs.md`. A pack composes tools, Agents,
 * rules, context, workflows and UI affordances over the same Core Runtime,
 * Trust and Project contracts. It never introduces a second runtime, permission
 * model, file authority or application surface, and **activating a pack is not
 * an authorization event**: `needs` is what the pack would use, and Trust still
 * decides, exactly as changing Agent, model or Team never grants authority.
 *
 * It is deliberately separate from `shared/packs.ts`, which is the weekly-brief
 * configuration compiler: one approved-files workflow template that predates
 * this contract and keeps its stored identifiers. Nothing here renames it.
 *
 * Everything here is data. No clock, no filesystem, no network; the host
 * supplies time and does the discovery.
 */

export const CAPABILITY_PACK_CONTRACT_VERSION = 1 as const;

/** The first and, today, only pack. A second one is a new literal here, not a string. */
export type CapabilityPackId = 'diomedes.software-engineering';
export const CAPABILITY_PACK_IDS: readonly CapabilityPackId[] = Object.freeze([
  'diomedes.software-engineering',
]);
export function isCapabilityPackId(value: unknown): value is CapabilityPackId {
  return CAPABILITY_PACK_IDS.some((id) => id === value);
}

/** The six dimensions a pack may contribute to (capability-packs.md §2). */
export type PackContributionKind = 'tools' | 'agents' | 'rules' | 'context' | 'workflows' | 'ui';

/**
 * A capability the pack would use. Declared, never granted. The wording is the
 * plain sentence the person reads on the activation preview.
 */
export interface PackNeed {
  readonly capability: string;
  readonly reason: string;
}

/** Where on an existing Console surface a pack lights something up. Never a new surface. */
export interface PackUiAffordance {
  readonly id: string;
  readonly surface: 'files' | 'thread' | 'palette' | 'project-settings';
  readonly label: string;
}

export interface CapabilityPackManifest {
  readonly contractVersion: typeof CAPABILITY_PACK_CONTRACT_VERSION;
  readonly id: CapabilityPackId;
  /** Semantic version of the manifest. Recorded on every activation and instruction-file record. */
  readonly version: string;
  readonly name: string;
  /** One or two plain sentences: what activating this changes and what it does not. */
  readonly summary: string;
  readonly contributes: readonly PackContributionKind[];
  readonly needs: readonly PackNeed[];
  readonly ui: readonly PackUiAffordance[];
  /**
   * Repository instruction files the pack discovers as standing guidance, as
   * project-relative names in precedence order. Discovery goes through the
   * `server/paths.ts` guard and records what it found; it never pastes a file
   * into a prompt (capability-packs.md §4.1).
   */
  readonly instructionFiles: readonly string[];
  /** A literal, like `AgentDefinition.grantsAuthority`. Enforced at load. */
  readonly grantsAuthority: false;
}

/**
 * One pack being turned on or off in one Project. Activation is a Project-level
 * property; a workspace may offer or recommend a pack, the Project turns it on.
 * Records are appended, never rewritten, so History can say what was active
 * when a run happened.
 */
export interface PackActivation {
  readonly packId: CapabilityPackId;
  readonly packVersion: string;
  readonly state: 'active' | 'inactive';
  readonly at: string;
  /** Only a person activates a pack. Inference may offer; it never self-activates. */
  readonly by: 'you';
}

/**
 * What discovery recorded about one instruction file. `exceeds-view-budget`
 * means the file was found and hashed but is larger than the bounded
 * instruction view can carry whole; it is listed, readable, and explicitly
 * omitted from any model-bound view rather than cut midway (brief 03, HAR-05).
 */
export type InstructionFileState = 'loaded' | 'exceeds-view-budget' | 'unreadable';

export interface InstructionFileRecord {
  readonly path: string;
  readonly sha: string | null;
  readonly size: number | null;
  readonly discoveredAt: string;
  readonly packId: CapabilityPackId;
  readonly packVersion: string;
  readonly state: InstructionFileState;
  /** The project-authority rule this file became, when it did. */
  readonly ruleId?: string;
  readonly detail: string;
}

/** Instruction text larger than this is recorded and shown, never sent whole. */
export const INSTRUCTION_FILE_VIEW_BUDGET_BYTES = 16 * 1024;
/** Hard ceiling on what discovery will read at all. */
export const INSTRUCTION_FILE_MAX_BYTES = 256 * 1024;

export const SOFTWARE_ENGINEERING_PACK: CapabilityPackManifest = {
  contractVersion: CAPABILITY_PACK_CONTRACT_VERSION,
  id: 'diomedes.software-engineering',
  version: '0.1.0',
  name: 'Software Engineering',
  summary:
    'Reads a repository the way a developer does: finds project instruction files, shows them as standing guidance, and deepens the Files pane for source. It adds no permission; Trust still decides every effect.',
  contributes: ['rules', 'context', 'ui'],
  needs: [
    {
      capability: 'read-project-files',
      reason: 'To discover AGENTS.md and CLAUDE.md inside the project folder.',
    },
  ],
  ui: [
    { id: 'project-instructions', surface: 'thread', label: 'Project instructions loaded' },
    { id: 'repository-tree', surface: 'files', label: 'Repository-aware tree' },
  ],
  instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
  grantsAuthority: false,
};

export const CAPABILITY_PACKS: Readonly<Record<CapabilityPackId, CapabilityPackManifest>> = {
  'diomedes.software-engineering': SOFTWARE_ENGINEERING_PACK,
};

/** The latest activation record for a pack, or null when it was never touched. */
export function latestActivation(
  activations: readonly PackActivation[] | undefined,
  packId: CapabilityPackId,
): PackActivation | null {
  const own = (activations ?? []).filter((item) => item.packId === packId);
  return own.length ? own.reduce((a, b) => (b.at >= a.at ? b : a)) : null;
}

export function isPackActive(
  activations: readonly PackActivation[] | undefined,
  packId: CapabilityPackId,
): boolean {
  return latestActivation(activations, packId)?.state === 'active';
}

/**
 * A manifest is valid only if it cannot grant anything and names only known
 * dimensions. Called at load so a hand-edited or future downloaded manifest
 * cannot smuggle authority in through a field nobody reads.
 */
export function validateManifest(manifest: CapabilityPackManifest): string[] {
  const problems: string[] = [];
  if (manifest.contractVersion !== CAPABILITY_PACK_CONTRACT_VERSION)
    problems.push(`Unknown pack contract version ${String(manifest.contractVersion)}.`);
  if (!isCapabilityPackId(manifest.id)) problems.push(`Unknown pack id ${String(manifest.id)}.`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
    problems.push('A pack version is a plain X.Y.Z.');
  if ((manifest as { grantsAuthority: unknown }).grantsAuthority !== false)
    problems.push('A pack never grants authority.');
  const kinds: readonly string[] = ['tools', 'agents', 'rules', 'context', 'workflows', 'ui'];
  for (const kind of manifest.contributes)
    if (!kinds.includes(kind)) problems.push(`Unknown contribution kind ${String(kind)}.`);
  for (const file of manifest.instructionFiles)
    if (!/^[A-Za-z0-9._-]+$/.test(file))
      problems.push(`Instruction files are discovered by plain name, not path: ${file}.`);
  return problems;
}

/**
 * The rule identifier one instruction file always becomes.
 *
 * `ruleSchema.id` is `^[a-z][a-z0-9-]{0,63}$`, so the obvious spelling
 * `instructions:AGENTS.md` is not a legal rule id. The slug below is the same
 * idea inside that grammar: deterministic from the file name, so the rule a
 * file becomes keeps its identity across discoveries and History can be read
 * back against it.
 */
export function instructionRuleId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `instructions-${slug || 'file'}`.slice(0, 64);
}

/**
 * The records that still describe what is loaded right now.
 *
 * Turning a pack off leaves its records in place — History has to be able to
 * say what was active when a run happened — so "what was ever discovered" and
 * "what applies today" are two different questions. Rule derivation and the
 * thread indicator both ask this one, because a project that turned the pack
 * off and still reads `Project instructions loaded` is being told something
 * untrue.
 */
export function activeInstructionFiles(
  activations: readonly PackActivation[] | undefined,
  records: readonly InstructionFileRecord[] | undefined,
): readonly InstructionFileRecord[] {
  return (records ?? []).filter((record) => isPackActive(activations, record.packId));
}
