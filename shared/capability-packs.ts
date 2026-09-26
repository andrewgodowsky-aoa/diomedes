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

import { SMALL_BUSINESS_SKILLS } from './small-business-skills.js';

export const CAPABILITY_PACK_CONTRACT_VERSION = 1 as const;

/** Every pack is a literal here, never a free string: a third one is a new literal too. */
export type CapabilityPackId = 'diomedes.software-engineering' | 'diomedes.small-business';
export const CAPABILITY_PACK_IDS: readonly CapabilityPackId[] = Object.freeze([
  'diomedes.software-engineering',
  'diomedes.small-business',
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

/**
 * A skill a pack contributes: one playbook for one kind of recurring work, as
 * data. It is a workflow in the capability-packs.md section 2 sense and nothing
 * more: no tool, no runtime and no authority of its own.
 *
 * Four properties are enforced by `validateManifest`, because each is easy to
 * lose while writing content:
 *
 * - it runs in a read-and-draft Mode (`ask` or `plan`), never one that writes
 *   project files through a proposal;
 * - every input it reads is declared as one of its pack's `needs`, so what it
 *   would use is inspectable before activation and still decided by Trust;
 * - `acts` is the literal `false`: a skill drafts, and anything outward (a
 *   message, a review reply, a payment, a post) is a draft the owner sends, or
 *   goes through the existing approval flow;
 * - its rendered playbook fits `SKILL_SECTION_MAX_BYTES` whole.
 */
export type PackSkillMode = 'ask' | 'plan';
export type PackSkillOutput = 'brief' | 'table' | 'checklist' | 'draft';
/** The inline visual kinds a playbook may ask for, when the conversation can show them. */
export type PackSkillVisualKind = 'bar' | 'line' | 'area' | 'pie' | 'stat' | 'table' | 'progress';
/** Why a skill carries a not-professional-advice notice. */
export type PackSkillCaution = 'accounting' | 'tax' | 'legal' | 'employment';

export interface PackSkillInput {
  /** What the playbook reads, in the owner's words: `Sales by day for the week`. */
  readonly label: string;
  readonly required: boolean;
  /** The pack need this input is read under. Must be one of the pack's `needs[].capability`. */
  readonly need: string;
  /** Exactly what to export, upload or connect when it is missing. Said to the owner as written. */
  readonly howToProvide: string;
}

export interface PackSkill {
  /** Kebab case, unique inside its pack. */
  readonly id: string;
  /** The plain name a person reads: `Cash flow snapshot`. */
  readonly name: string;
  /** One line: what the owner gets. */
  readonly value: string;
  /** Phrases a person might say when this is the right playbook. Searchable, never parsed as commands. */
  readonly triggers: readonly string[];
  /** The Mode it launches in. */
  readonly mode: PackSkillMode;
  /** The words the composer is pre-filled with. The person may change them before sending. */
  readonly starter: string;
  readonly inputs: readonly PackSkillInput[];
  /** The playbook, one instruction per step, written for any model. */
  readonly steps: readonly string[];
  readonly output: { readonly shape: PackSkillOutput; readonly sections: readonly string[] };
  /** Where a picture helps, built only from supplied numbers. */
  readonly visual?: { readonly kind: PackSkillVisualKind; readonly about: string };
  /** Outward things it prepares as drafts for the owner to send themselves. Never performed. */
  readonly drafts: readonly string[];
  /** Present on every accounting, tax, legal or employment skill. */
  readonly caution?: PackSkillCaution;
  /** A literal, like `grantsAuthority`. A skill never sends, posts, pays or messages anyone. */
  readonly acts: false;
}

/** UTF-8 length, the same in the browser and on the host. */
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** The most one skill's rendered playbook may weigh. It goes whole or not at all. */
export const SKILL_SECTION_MAX_BYTES = 8 * 1024;

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
  /** Playbooks the pack contributes as workflows. Empty for a pack that contributes none. */
  readonly skills: readonly PackSkill[];
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
  /**
   * A built-in `CapabilityPackId`, or the id of an installed pack
   * (`shared/pack-manifest.ts`). Either way the same record, appended the same way.
   */
  readonly packId: string;
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
/**
 * The most the "Project instructions" prompt section may weigh in one request.
 *
 * The real bound is the 160 KB one every text route already enforces, and the
 * section takes only what the selected documents leave over
 * (`server/harness/instruction-delivery.ts`). This is the ceiling on top of
 * that: two files at the per-file budget, and no more, so a project cannot
 * spend its whole request on standing guidance.
 */
export const INSTRUCTION_SECTION_MAX_BYTES = 32 * 1024;
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
  skills: [],
  grantsAuthority: false,
};

export const SMALL_BUSINESS_PACK: CapabilityPackManifest = {
  contractVersion: CAPABILITY_PACK_CONTRACT_VERSION,
  id: 'diomedes.small-business',
  version: '0.1.0',
  name: 'Small Business',
  summary:
    'Playbooks for the recurring work of running a restaurant, shop or service business: the weekly numbers, cash, bills, invoices, payroll, stock, reviews, leads and marketing. They read what you give them and draft; they send, post and pay nothing, and turning them on adds no permission.',
  contributes: ['workflows', 'ui'],
  needs: [
    {
      capability: 'read-project-files',
      reason: 'To read the exports, spreadsheets and documents you add to this project.',
    },
    {
      capability: 'read-sales',
      reason: 'To read sales, tickets and items from a point-of-sale system or its export.',
    },
    {
      capability: 'read-accounting',
      reason: 'To read invoices, bills, balances and reports from accounting software or its export.',
    },
    {
      capability: 'read-bank',
      reason: 'To read balances and transactions from a bank statement or bank export.',
    },
    {
      capability: 'read-payroll',
      reason: 'To read timesheets, schedules and payroll registers.',
    },
    {
      capability: 'read-inventory',
      reason: 'To read stock counts, par levels and supplier price lists.',
    },
    {
      capability: 'read-reviews',
      reason: 'To read customer reviews and ratings you export or connect.',
    },
    {
      capability: 'read-leads',
      reason: 'To read enquiries, leads and customer lists from forms, email or a CRM export.',
    },
  ],
  ui: [{ id: 'skills', surface: 'palette', label: 'Small business skills' }],
  instructionFiles: [],
  skills: SMALL_BUSINESS_SKILLS,
  grantsAuthority: false,
};

export const CAPABILITY_PACKS: Readonly<Record<CapabilityPackId, CapabilityPackManifest>> = {
  'diomedes.software-engineering': SOFTWARE_ENGINEERING_PACK,
  'diomedes.small-business': SMALL_BUSINESS_PACK,
};

/** A skill by pack and id, or null. Never throws: an unknown id is an ordinary answer. */
export function findSkill(packId: CapabilityPackId, skillId: unknown): PackSkill | null {
  if (typeof skillId !== 'string') return null;
  return CAPABILITY_PACKS[packId]?.skills.find((skill) => skill.id === skillId) ?? null;
}

const CAUTION_TEXT: Record<PackSkillCaution, string> = {
  accounting:
    'Not professional advice: this is organisation, not accounting advice. Flag anything that changes the books, a tax figure or a filing for the owner to confirm with their bookkeeper or accountant.',
  tax: "Not professional advice: this is organisation, not tax advice. Never state what is deductible, owed or due as fact; list those as questions for the owner's accountant or tax preparer.",
  legal:
    'Not professional advice: this is a plain-language read, not legal advice. Never say a clause is enforceable, compliant or safe to sign; mark what the owner should take to a lawyer.',
  employment:
    'Not professional advice: this is organisation, not employment or payroll advice. Where wage, overtime, tip or leave rules decide an answer, flag it for the owner to confirm with their payroll provider or an adviser.',
};

/**
 * The playbook as the model reads it. Pure and deterministic: the same skill
 * renders the same bytes on every route, which is what lets the size budget be
 * tested once here and trusted wherever it is delivered.
 *
 * It names no provider, model or tool. "What you were given" covers supplied
 * documents and any connector data a route hands over, so the same text works
 * on every route.
 */
export function renderSkillPlaybook(skill: PackSkill, packVersion: string): string {
  const lines = [
    `Playbook: ${skill.name} (${skill.id}, version ${packVersion})`,
    `What the owner gets: ${skill.value}`,
    'Data it reads:',
    ...skill.inputs.map(
      (input) =>
        `- ${input.label} (${input.required ? 'required' : 'optional'}). If it is not in what you were given, tell the owner: ${input.howToProvide}`,
    ),
    'Steps:',
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`),
    `Result: a ${skill.output.shape} with these parts, in order: ${skill.output.sections.join('; ')}.`,
  ];
  if (skill.visual)
    lines.push(
      `Where a picture helps: ${skill.visual.about}. Add one fenced visual block of kind ${skill.visual.kind} built only from figures in what you were given. Never draw a figure you did not read.`,
    );
  if (skill.drafts.length)
    lines.push(
      `Drafts: ${skill.drafts.join('; ')}. Write each one ready to review, headed "Draft for you to send". You send, post and pay nothing, and never say that you did.`,
    );
  if (skill.caution) lines.push(CAUTION_TEXT[skill.caution]);
  return lines.join('\n');
}

/** The latest activation record for a pack, or null when it was never touched. */
export function latestActivation(
  activations: readonly PackActivation[] | undefined,
  packId: string,
): PackActivation | null {
  const own = (activations ?? []).filter((item) => item.packId === packId);
  return own.length ? own.reduce((a, b) => (b.at >= a.at ? b : a)) : null;
}

export function isPackActive(
  activations: readonly PackActivation[] | undefined,
  packId: string,
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
  const declared = new Set(manifest.needs.map((need) => need.capability));
  for (const capability of declared)
    if (OUTWARD.test(capability))
      problems.push(`A pack may not declare the outward capability ${capability}.`);
  const skills = manifest.skills ?? [];
  if (skills.length && !manifest.contributes.includes('workflows'))
    problems.push('A pack with skills contributes workflows.');
  const seen = new Set<string>();
  for (const skill of skills) problems.push(...validateSkill(skill, declared, manifest.version, seen));
  return problems;
}

/** Capabilities that would act outward. No pack may even declare one. */
export const OUTWARD =
  /^(send|post|pay|transfer|trade|publish|message|reply|submit|sign|delete|write-external)/;

/**
 * One skill's problems, in the words a reviewer reads. Exported for tests and
 * for a future downloaded pack; `validateManifest` is the caller at load.
 */
export function validateSkill(
  skill: PackSkill,
  declared: ReadonlySet<string>,
  packVersion: string,
  seen: Set<string> = new Set(),
): string[] {
  const problems: string[] = [];
  const name = typeof skill.id === 'string' ? skill.id : '(no id)';
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(String(skill.id)))
    problems.push(`Skill ids are short kebab case: ${name}.`);
  if (seen.has(name)) problems.push(`Skill ${name} is listed twice.`);
  seen.add(name);
  if ((skill as { acts: unknown }).acts !== false)
    problems.push(`Skill ${name} would act. A skill drafts; it never acts.`);
  if (skill.mode !== 'ask' && skill.mode !== 'plan')
    problems.push(`Skill ${name} runs in ${String(skill.mode)}. Skills run in Ask or Plan.`);
  if (!skill.name?.trim() || !skill.value?.trim() || !skill.starter?.trim())
    problems.push(`Skill ${name} needs a name, a one-line value and a starter.`);
  if (!skill.steps?.length) problems.push(`Skill ${name} has no steps.`);
  if (!skill.inputs?.length) problems.push(`Skill ${name} reads nothing, so it could only invent.`);
  else if (!skill.inputs.some((input) => input.required))
    problems.push(`Skill ${name} names no required input.`);
  for (const input of skill.inputs ?? []) {
    if (!declared.has(input.need))
      problems.push(`Skill ${name} reads ${input.need}, which its pack does not declare.`);
    if (!input.howToProvide?.trim())
      problems.push(`Skill ${name} does not say how to provide ${input.label}.`);
  }
  if (utf8Bytes(renderSkillPlaybook(skill, packVersion)) > SKILL_SECTION_MAX_BYTES)
    problems.push(
      `Skill ${name} is larger than the ${SKILL_SECTION_MAX_BYTES / 1024} KB playbook budget.`,
    );
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
  // A file at the project root keeps the id it always had. A nested one also
  // carries a short digest of its exact path: `pkg/api/AGENTS.md` and
  // `pkg-api/AGENTS.md` slug alike, and a long path would otherwise be cut to
  // the same 64 characters as its neighbour, and two files must never share
  // one rule.
  if (!name.includes('/')) return `instructions-${slug || 'file'}`.slice(0, 64);
  return `instructions-${slug.slice(0, 41).replace(/-+$/, '')}-${pathDigest(name)}`;
}

/** FNV-1a over UTF-16 code units, as 8 hex digits. An identifier, not a security digest. */
function pathDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// --- nested instruction files: scope and precedence -------------------------

/**
 * How far below the project folder discovery looks, and how much it will look
 * at. A monorepo's `packages/api/AGENTS.md` is two folders down; nothing
 * legitimate needs seven. The folder ceiling bounds the walk itself, so a
 * project folder that turns out to hold a whole drive costs a bounded,
 * predictable amount of work rather than a scan of everything under it.
 */
export const NESTED_INSTRUCTION_MAX_DEPTH = 6;
export const NESTED_INSTRUCTION_MAX_FOLDERS = 2000;
/** Nested records past this many are not discovered at all. */
export const NESTED_INSTRUCTION_MAX_FILES = 32;

/** The folder an instruction file governs, relative to the project; `''` is the project root. */
export function instructionScope(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** How many folders below the project root an instruction file sits. */
export function instructionDepth(path: string): number {
  const scope = instructionScope(path);
  return scope ? scope.split('/').length : 0;
}

/**
 * Whether one instruction file governs work on these paths.
 *
 * A root file governs everything in the project. A nested one governs work on
 * a path inside its own folder, compared a whole folder name at a time, so
 * `pkg/api/AGENTS.md` governs `pkg/api/src/x.ts` and never `pkg/apiary/x.ts`.
 * Work that names no path is scoped to the project root, and only root files
 * govern it.
 */
export function instructionAppliesTo(path: string, workPaths: readonly string[]): boolean {
  const scope = instructionScope(path);
  if (!scope) return true;
  return workPaths.some((work) => work.startsWith(`${scope}/`));
}

/**
 * The order instruction files take precedence in, strongest first. This list
 * is the documented contract; `compareInstructionPrecedence` is its one
 * implementation, and the tests read both.
 *
 * Authority comes before any of it and is not decided here: every instruction
 * file enters the rule path at project authority (`server/capability-packs.ts`),
 * so `resolveRules` already puts an organization rule above all of them and a
 * task or personal rule below, and an organization restriction can never be
 * loosened by a file. Activating a pack adds no authority of its own; a pack's
 * rules are these project rules. Files outside the project folder, a person's
 * home-folder `CLAUDE.md` included, are never read.
 */
export const INSTRUCTION_PRECEDENCE: readonly string[] = Object.freeze([
  'A file in a nearer folder governs over a file in a folder that contains it.',
  "In the same folder, the pack's file order decides: AGENTS.md, then CLAUDE.md.",
  'Otherwise, the path in plain character order.',
]);

/** Negative when `a` takes precedence over `b`. */
export function compareInstructionPrecedence(
  a: string,
  b: string,
  kinds: readonly string[] = SOFTWARE_ENGINEERING_PACK.instructionFiles,
): number {
  const kind = (path: string) => {
    const index = kinds.indexOf(path.slice(path.lastIndexOf('/') + 1));
    return index < 0 ? kinds.length : index;
  };
  return (
    instructionDepth(b) - instructionDepth(a) ||
    (instructionScope(a) === instructionScope(b) ? kind(a) - kind(b) : 0) ||
    (a < b ? -1 : a > b ? 1 : 0)
  );
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

/**
 * One instruction file, as it stood when a run actually sent it — or did not.
 *
 * Separate from `InstructionFileRecord` on purpose. That record says what
 * discovery found in the project folder; this says what one request did with
 * it. They can disagree honestly: a file discovered an hour ago may have
 * changed, grown past the budget, or been deleted, and `sha` here is always of
 * the bytes this run read.
 */
export interface DeliveredInstructionFile {
  readonly path: string;
  /** The sha of what was read for this run, or null when nothing was read. */
  readonly sha: string | null;
  readonly bytes: number | null;
  readonly packId: CapabilityPackId;
  readonly packVersion: string;
  /** The project-authority rule that carried it. Always present; delivery is rule-gated. */
  readonly ruleId: string;
  /** `omitted` is never a partial send. A body goes whole or it does not go. */
  readonly state: 'sent' | 'omitted';
  readonly detail: string;
  /** The folder this file governs; `''` is the project root. Absent on records before H11. */
  readonly scope?: string;
  /** 1 is the strongest. Files are recorded, read and rendered in this order. */
  readonly precedence?: number;
  /** Why an `omitted` file did not go. Absent when it was sent. */
  readonly exclusion?: InstructionExclusion;
}

/**
 * Why an instruction file was not sent, as a code the Console can print and a
 * test can assert. `over-file-limit` and `no-room` are the byte budget: the
 * file was left out whole rather than cut (`truncated` on the delivery).
 */
export type InstructionExclusion =
  | 'over-file-limit'
  | 'no-room'
  | 'refused'
  | 'missing'
  | 'out-of-scope'
  | 'not-shared'
  | 'not-loaded'
  /**
   * The business this work belongs to does not hold the `owner-rules` feature:
   * the file is kept, but it did not reach the work. It never reached the rule
   * path for this run either, so it stays on `excluded`, not `files`.
   */
  | 'not-included';

/**
 * A discovered instruction file that did not take part in this run, and why.
 * It never reached the rule path for this request, so it has no body read,
 * no rule applied and no precedence; the record exists so a person can see
 * that it was considered and what kept it out.
 */
export interface ExcludedInstructionFile {
  readonly path: string;
  readonly scope: string;
  /** The sha discovery recorded, when it read the file. */
  readonly sha: string | null;
  readonly bytes: number | null;
  readonly packId: CapabilityPackId;
  readonly exclusion: Extract<InstructionExclusion, 'out-of-scope' | 'not-shared' | 'not-loaded' | 'not-included'>;
  readonly detail: string;
}

/** What one run delivered, for the session record and History. Never the bodies. */
export interface InstructionDelivery {
  /** The instruction-view revision of the rules that governed this delivery. */
  readonly revision: string;
  readonly routeId: string;
  readonly at: string;
  readonly files: readonly DeliveredInstructionFile[];
  /** True when a file was left out. Nothing is ever cut part way through. */
  readonly truncated: boolean;
  /** Instruction bytes actually placed in the prompt. */
  readonly bytes: number;
  /** The paths this work was scoped to; nested files govern only work inside their folder. */
  readonly workPaths?: readonly string[];
  /** Discovered files that did not take part, with the reason. Absent on records before H11. */
  readonly excluded?: readonly ExcludedInstructionFile[];
}

/**
 * Which playbook a request ran under, recorded on the turn the person sent so
 * the thread can say so and History can be read back against it. Never the
 * playbook text: the pack version pins that.
 */
export interface SkillUse {
  readonly packId: CapabilityPackId;
  readonly packVersion: string;
  readonly skillId: string;
  readonly name: string;
  /** Bytes of playbook placed in the request; 0 on the no-engine sample route. */
  readonly bytes: number;
  /** P04: the digest of the playbook body that was loaded and checked. Absent before 2026-09-24. */
  readonly digest?: string;
}

/*
 * FD03 adds evidence to the existing Session record rather than introducing a
 * second run or history store. The receipt is prepared during context
 * assembly and may become sent only after the provider returns a response.
 */
declare module './types.js' {
  interface Session {
    productKnowledge?: import('./readiness.js').ProductKnowledgeReceipt;
  }
  interface Turn {
    /** The playbook this request ran under, on the turn the person sent. */
    skill?: SkillUse;
  }
}
