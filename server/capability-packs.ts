/**
 * Turning the Software Engineering pack on for one Project, and recording what
 * that discovers.
 *
 * The contract this serves is `shared/capability-packs.ts` and `AGENTS.md`
 * decision 14. Three properties are the whole point of this file, and each one
 * is easy to lose by accident:
 *
 * 1. **Activation is not an authorization event.** Nothing here creates,
 *    widens or touches a `TaskScopeGrant`, a `Need` or a permission. A pack
 *    says what it would use; Trust still decides every effect.
 * 2. **Nothing loads for a project that did not ask.** Discovery refuses to
 *    run at all unless the pack is active in that Project, so a Personal
 *    project full of invoices never grows a rule because an `AGENTS.md`
 *    happens to sit next to it.
 * 3. **A file's body is data, never the rule.** Discovery records the path,
 *    the size and the sha, and the rule it produces is one host-authored
 *    sentence saying that those instructions apply. The body is referenced,
 *    not quoted, which is why `screenForInstructionText` runs over it: text
 *    that tries to instruct the harness is reported so a person can see it,
 *    and reporting it is not obeying it.
 *
 * Discovery reads through `server/paths.ts` and never around it. A name the
 * guard refuses is recorded `unreadable` with the guard's own reason; the
 * refusal is the record, not an error to route around.
 */
import fs from 'node:fs/promises';
import type { ProjectState } from '../shared/types.js';
import {
  activeInstructionFiles,
  CAPABILITY_PACK_IDS,
  CAPABILITY_PACKS,
  instructionRuleId,
  INSTRUCTION_FILE_MAX_BYTES,
  INSTRUCTION_FILE_VIEW_BUDGET_BYTES,
  isPackActive,
  validateManifest,
  type CapabilityPackId,
  type CapabilityPackManifest,
  type InstructionFileRecord,
  type PackActivation,
} from '../shared/capability-packs.js';
import { ruleSchema, type Rule } from '../shared/connection-rules.js';
import {
  screenForInstructionText,
  type ContentOrigin,
  type RuleAuthority,
} from '../shared/rule-authority.js';
import { ApiError, absent, projectFile, readTextOrNull } from './paths.js';
import { hash, now, type Store } from './store.js';

/**
 * Where an instruction file's content sits in the admissibility vocabulary.
 *
 * `admissibleAsRule` refuses this origin outright, and that is the correct
 * answer: the file's text may not become a rule. The rule this module makes is
 * host-authored - one sentence saying the file applies - so the two facts hold
 * together rather than contradicting each other.
 */
export const INSTRUCTION_FILE_ORIGIN: ContentOrigin = 'imported-document';

/** The authority an instruction file can reach, and the ceiling it cannot pass. */
export const INSTRUCTION_RULE_AUTHORITY: RuleAuthority = 'project';

/** Refuse to load a manifest that could grant something. Called before every activation. */
export function assertLoadable(manifest: CapabilityPackManifest): void {
  const problems = validateManifest(manifest);
  if (problems.length)
    throw new ApiError(500, `This capability pack cannot be loaded. ${problems.join(' ')}`, {
      problems,
    });
}

export function manifestFor(packId: CapabilityPackId): CapabilityPackManifest {
  const manifest = CAPABILITY_PACKS[packId];
  if (!manifest) throw new ApiError(404, 'This capability pack does not exist.');
  return manifest;
}

/**
 * The one rule a loaded instruction file becomes.
 *
 * The text is fixed and written here. The file is named by path and pinned by
 * sha in `provenance.source`, so a person reading the rule can go and read
 * exactly the bytes it stands for - and a changed file makes a changed rule
 * rather than silently meaning something else.
 */
export function instructionRule(record: InstructionFileRecord, projectId: string): Rule | null {
  if (record.state !== 'loaded' || !record.ruleId || !record.sha) return null;
  return ruleSchema.parse({
    id: record.ruleId,
    version: 1,
    enabled: true,
    scope: { projectId },
    provenance: {
      source: `${record.path}@${record.sha}`,
      connectorVersion: record.packVersion,
      trust: 'host-reviewed',
    },
    type: 'standing',
    text: `Project instructions from ${record.path} apply to work in this project.`,
    predicate: null,
    action: 'context',
  });
}

/**
 * The rules an active pack contributes, in the shape `assembleContext` takes.
 *
 * Delivery on a route is a separate slice (HAR-01). What exists here is the
 * hand-off: the rules exist, they carry project authority and nothing more,
 * and nothing in this module puts them in front of a model.
 */
export function instructionRules(state: ProjectState): { rule: Rule; authority: RuleAuthority }[] {
  return activeInstructionFiles(state.project.packs, state.instructionFiles)
    .map((record) => instructionRule(record, state.project.id))
    .filter((rule): rule is Rule => rule !== null)
    .map((rule) => ({ rule, authority: INSTRUCTION_RULE_AUTHORITY }));
}

/**
 * What `screenForInstructionText` found, in one clause.
 *
 * It is appended to every record made from content that was actually read,
 * including the over-budget ones: a 20 KB file that tries to instruct the
 * harness is exactly the file a person most needs to see said out loud, and
 * dropping the count on the larger branch would hide it there. Saying it is
 * not obeying it - the count decides nothing.
 */
const screened = (attempts: number) =>
  attempts === 0
    ? ''
    : ` ${attempts} ${attempts === 1 ? 'passage' : 'passages'} in it read like instructions to Diomedes; that is recorded, not obeyed.`;

/**
 * Look at one candidate name and say what was found.
 *
 * Returns `null` when the file is simply not there - an absent `CLAUDE.md` is
 * not a finding and does not belong in the record. Every other outcome,
 * including every refusal, becomes a record.
 */
export async function recordInstructionFile(input: {
  root: string;
  name: string;
  manifest: CapabilityPackManifest;
  at: string;
}): Promise<InstructionFileRecord | null> {
  const base = {
    path: input.name,
    discoveredAt: input.at,
    packId: input.manifest.id,
    packVersion: input.manifest.version,
  };
  let absolute: string;
  let relative: string;
  try {
    ({ absolute, relative } = await projectFile(input.root, input.name));
  } catch (error) {
    // The guard's refusal is the record. Nothing was opened and nothing is retried.
    return {
      ...base,
      sha: null,
      size: null,
      state: 'unreadable',
      detail: error instanceof Error ? error.message : 'This file could not be opened.',
    };
  }
  try {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile())
      return {
        ...base,
        path: relative,
        sha: null,
        size: null,
        state: 'unreadable',
        detail: 'This path is not a regular file.',
      };
    if (stat.size > INSTRUCTION_FILE_MAX_BYTES)
      return {
        ...base,
        path: relative,
        sha: null,
        size: stat.size,
        state: 'unreadable',
        detail: `This file is ${Math.round(stat.size / 1024)} KB, past the ${
          INSTRUCTION_FILE_MAX_BYTES / 1024
        } KB ceiling on what discovery reads. It was listed and not read.`,
      };
    const text = await readTextOrNull(absolute);
    if (text === null) return null;
    const attempts = screenForInstructionText(text).length;
    const sha = hash(text);
    if (stat.size > INSTRUCTION_FILE_VIEW_BUDGET_BYTES)
      return {
        ...base,
        path: relative,
        sha,
        size: stat.size,
        state: 'exceeds-view-budget',
        detail: `This file is ${Math.round(stat.size / 1024)} KB, larger than the ${
          INSTRUCTION_FILE_VIEW_BUDGET_BYTES / 1024
        } KB instruction view. It is listed and readable here, and no rule was made from it.${screened(
          attempts,
        )}`,
      };
    return {
      ...base,
      path: relative,
      sha,
      size: stat.size,
      state: 'loaded',
      ruleId: instructionRuleId(relative),
      detail: `Recorded as standing guidance. It is referenced by path and version, never pasted into a prompt.${screened(
        attempts,
      )}`,
    };
  } catch (error) {
    if (absent(error)) return null;
    return {
      ...base,
      path: relative,
      sha: null,
      size: null,
      state: 'unreadable',
      detail: error instanceof Error ? error.message : 'This file could not be read.',
    };
  }
}

/** Two records describe the same finding when everything but the clock agrees. */
const sameFinding = (a: InstructionFileRecord, b: InstructionFileRecord) =>
  a.path === b.path &&
  a.sha === b.sha &&
  a.size === b.size &&
  a.state === b.state &&
  a.ruleId === b.ruleId &&
  a.packId === b.packId &&
  a.packVersion === b.packVersion &&
  a.detail === b.detail;

/**
 * What the active packs find in this project's folder, right now.
 *
 * With no pack active this does no filesystem work at all and returns what was
 * already recorded - which is nothing for a project that never activated one,
 * and the existing records for a project that turned one off. Deactivation
 * blocks new discovery; it never erases what discovery already said.
 */
export async function discoverInstructionFiles(
  store: Store,
  projectId: string,
  at: string = now(),
): Promise<InstructionFileRecord[]> {
  const state = store.state(projectId);
  const active = CAPABILITY_PACK_IDS.filter((id) => isPackActive(state.project.packs, id));
  if (!active.length) return [...(state.instructionFiles ?? [])];
  const found: InstructionFileRecord[] = [];
  for (const packId of active) {
    const manifest = manifestFor(packId);
    assertLoadable(manifest);
    for (const name of manifest.instructionFiles) {
      const record = await recordInstructionFile({
        root: state.project.folder,
        name,
        manifest,
        at,
      });
      if (record) found.push(record);
    }
  }
  const previous = state.instructionFiles ?? [];
  const unchanged =
    previous.length === found.length &&
    previous.every((record, index) => sameFinding(record, found[index]));
  if (unchanged) return [...previous];
  state.instructionFiles = found;
  await store.persist(state);
  return [...found];
}

async function setActivation(
  store: Store,
  projectId: string,
  packId: CapabilityPackId,
  next: PackActivation['state'],
  at: string,
): Promise<ProjectState> {
  const manifest = manifestFor(packId);
  assertLoadable(manifest);
  const state = store.state(projectId);
  const already = isPackActive(state.project.packs, packId);
  // Records are appended for every decision that changes something. Turning on
  // a pack that is already on decided nothing, so it writes nothing: a History
  // entry saying a person changed a setting they did not change would be
  // untrue, and the record is evidence before it is a log.
  if (already === (next === 'active')) return state;
  state.project.packs = [
    ...(state.project.packs ?? []),
    { packId, packVersion: manifest.version, state: next, at, by: 'you' },
  ];
  store.addEntry(state, {
    kind: 'pack',
    sentence:
      next === 'active'
        ? `You turned on ${manifest.name} for this project. It adds no permission.`
        : `You turned off ${manifest.name} for this project. What it already found stays recorded.`,
  });
  await store.persist(state);
  if (next === 'active') await discoverInstructionFiles(store, projectId, at);
  return store.state(projectId);
}

export const activatePack = (
  store: Store,
  projectId: string,
  packId: CapabilityPackId,
  at: string = now(),
) => setActivation(store, projectId, packId, 'active', at);

export const deactivatePack = (
  store: Store,
  projectId: string,
  packId: CapabilityPackId,
  at: string = now(),
) => setActivation(store, projectId, packId, 'inactive', at);
