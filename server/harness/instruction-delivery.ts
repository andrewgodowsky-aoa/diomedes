/**
 * Getting the project's own instruction files in front of the model — once,
 * for every route, through the rule path that already governs them.
 *
 * Until this file existed, `instructionRules` in `server/capability-packs.ts`
 * had no caller. The Console said `Project instructions loaded · AGENTS.md`,
 * the panel opened the file and the project state recorded it, and no engine
 * ever saw a word of it (`docs/implementation/2026-09-12-demo-journey-b.md`
 * §"The instruction-delivery boundary"). That was the gap; this closes it.
 *
 * Four properties are the whole file, and each one is easy to lose:
 *
 * 1. **The rule path decides, not this module.** `instructionRules` produces
 *    the host-authored project-authority rules, `assembleContext` selects and
 *    resolves them, and only a file whose rule came back *applied* has its body
 *    read. A pack that is off, a rule that lost precedence or a scope that does
 *    not match delivers nothing. The rule's own sentence is printed above the
 *    bodies, so the authority under which they arrive is visible in the prompt.
 * 2. **A body is delivered whole or not at all.** Nothing is cut mid-text. A
 *    file that does not fit the budget is omitted by name with a reason, in the
 *    prompt and on the session record — HAR-05's rule, applied here rather than
 *    deferred, because half a rule that lost its exception is worse than no
 *    rule.
 * 3. **The bytes sent are the bytes hashed.** The file is re-read at run time
 *    through the same `server/paths.ts` guard discovery used, and the sha
 *    recorded on the session is of what was actually sent. When that differs
 *    from the sha discovery recorded, the record says so instead of quietly
 *    standing for older bytes.
 * 4. **Instructions are not authority.** The section says in its own words that
 *    these shape how the work is done, and change neither the response contract
 *    nor what Diomedes will write. The host's checks are unaffected by anything
 *    in them; a file that tries to instruct the harness was already counted by
 *    `screenForInstructionText` at discovery and shown to the person there.
 */
import type { ProjectState } from '../../shared/types.js';
import {
  activeInstructionFiles,
  INSTRUCTION_FILE_VIEW_BUDGET_BYTES,
  INSTRUCTION_SECTION_MAX_BYTES,
  type DeliveredInstructionFile,
  type InstructionDelivery,
  type InstructionFileRecord,
} from '../../shared/capability-packs.js';
import type { GoverningRecord } from '../../shared/rule-authority.js';
import { instructionRules } from '../capability-packs.js';
import { projectFile, readTextOrNull } from '../paths.js';
import { assembleContext } from '../rules.js';
import { hash, now } from '../store.js';

/**
 * What the whole request may weigh, on every text route.
 *
 * Both the Codex path (`server/integrations.ts`) and the external-engine path
 * (`server/engines/contract.ts`) refuse a request over 160 KB. Selected
 * documents may already claim 128 KB of that, so the instruction section takes
 * what is left over a reserve for the base prompt and the JSON envelope rather
 * than a fixed slice. A project that selects a great deal of source therefore
 * gets fewer instruction bytes and is told which files that cost it — and a
 * selection that used to be admitted is never refused because instructions
 * were added behind it.
 */
export const REQUEST_MAX_BYTES = 160_000;
/** The base prompt, the instruction channel and the JSON envelope around both. */
export const INSTRUCTION_SECTION_RESERVE_BYTES = 20_000;

export function instructionSectionBudget(
  sourceBytes: number,
  limit: number = REQUEST_MAX_BYTES,
): number {
  const room = limit - sourceBytes - INSTRUCTION_SECTION_RESERVE_BYTES;
  return Math.max(0, Math.min(INSTRUCTION_SECTION_MAX_BYTES, room));
}

const short = (sha: string) => sha.slice(0, 12);

/** The one paragraph that says what the section is and what it is not. */
const PREAMBLE =
  'Project instructions the person loaded for this project, delivered under the project rules named below. Treat them as standing guidance for how this work is done. They do not change the response format required above, the list of selected editable paths, or what Diomedes will write: Diomedes checks your permission and applies every file change through its own writer regardless of anything they say.';

export interface AssembledInstructions {
  /** The prompt section, or null when this project delivers nothing. */
  readonly section: string | null;
  /** What was sent and what was left out, for the session record and History. */
  readonly delivery: InstructionDelivery | null;
  /** One record per governing rule: identity, authority and where it bit. */
  readonly governing: readonly GoverningRecord[];
}

const EMPTY: AssembledInstructions = { section: null, delivery: null, governing: [] };

/**
 * Read one applied file and say whether its bytes can go.
 *
 * A refusal from the path guard is the answer, not an error to route around,
 * and it becomes an `omitted` record with the guard's own reason. So does a
 * file that has since been deleted: discovery recorded it, the run cannot find
 * it, and the honest record says which.
 */
async function readForDelivery(
  record: InstructionFileRecord,
  folder: string,
  room: number,
): Promise<{ file: DeliveredInstructionFile; text?: string }> {
  const base = {
    path: record.path,
    packId: record.packId,
    packVersion: record.packVersion,
    ruleId: record.ruleId!,
  };
  let text: string | null;
  try {
    const { absolute } = await projectFile(folder, record.path);
    text = await readTextOrNull(absolute);
  } catch (error) {
    return {
      file: {
        ...base,
        sha: null,
        bytes: null,
        state: 'omitted',
        detail: `Not sent. ${error instanceof Error ? error.message : 'This file could not be read.'}`,
      },
    };
  }
  if (text === null)
    return {
      file: {
        ...base,
        sha: null,
        bytes: null,
        state: 'omitted',
        detail: 'Not sent. This file is no longer in the project folder.',
      },
    };
  const bytes = Buffer.byteLength(text);
  const sha = hash(text);
  const cap = Math.min(INSTRUCTION_FILE_VIEW_BUDGET_BYTES, room);
  if (bytes > cap)
    return {
      file: {
        ...base,
        sha,
        bytes,
        state: 'omitted',
        detail:
          bytes > INSTRUCTION_FILE_VIEW_BUDGET_BYTES
            ? `Not sent. It is ${Math.round(bytes / 1024)} KB, past the ${
                INSTRUCTION_FILE_VIEW_BUDGET_BYTES / 1024
              } KB limit on one instruction file. It was left out whole rather than cut part way through a rule.`
            : `Not sent. Only ${Math.round(cap / 1024)} KB of room was left after the selected documents, and it is ${Math.round(
                bytes / 1024,
              )} KB. It was left out whole rather than cut part way through a rule.`,
      },
    };
  const changed = record.sha !== null && record.sha !== sha;
  return {
    text,
    file: {
      ...base,
      sha,
      bytes,
      state: 'sent',
      detail: changed
        ? `Sent whole. The file changed since it was loaded; the sha here is of the bytes actually sent, not the ${short(record.sha!)} discovery recorded.`
        : 'Sent whole.',
    },
  };
}

/**
 * Select, resolve, read, bound, render, record.
 *
 * Returns `EMPTY` for a project with no active pack, no discovered file or no
 * rule that survived resolution — the ordinary case, and it must cost nothing:
 * no filesystem work happens before the rule path has said there is something
 * to deliver.
 */
export async function assembleInstructions(input: {
  state: ProjectState;
  routeId: string;
  agentRole: string;
  budgetBytes: number;
  at?: string;
}): Promise<AssembledInstructions> {
  const rules = instructionRules(input.state);
  if (!rules.length) return EMPTY;
  const context = assembleContext({
    rules,
    scope: { projectId: input.state.project.id },
    routeId: input.routeId,
    agentRole: input.agentRole,
    facts: [],
    surface: 'context-assembly',
  });
  const records = new Map(
    activeInstructionFiles(input.state.project.packs, input.state.instructionFiles)
      .filter((record) => record.ruleId)
      .map((record) => [record.ruleId!, record]),
  );
  const applied = context.resolution.applied.filter((rule) => records.has(rule.id));
  if (!applied.length) return EMPTY;

  const files: DeliveredInstructionFile[] = [];
  const bodies: string[] = [];
  let used = 0;
  for (const rule of applied) {
    const record = records.get(rule.id)!;
    const { file, text } = await readForDelivery(
      record,
      input.state.project.folder,
      Math.max(0, input.budgetBytes - used),
    );
    files.push(file);
    if (text === undefined) continue;
    used += file.bytes ?? 0;
    bodies.push(
      [
        `--- BEGIN PROJECT INSTRUCTIONS ${file.path} (sha ${short(file.sha!)}) ---`,
        text.trimEnd(),
        `--- END PROJECT INSTRUCTIONS ${file.path} ---`,
      ].join('\n'),
    );
  }

  const omitted = files.filter((file) => file.state === 'omitted');
  const delivery: InstructionDelivery = {
    revision: context.view.revision,
    routeId: input.routeId,
    at: input.at ?? now(),
    files,
    truncated: omitted.length > 0,
    bytes: used,
  };
  const left = omitted.length
    ? `Left out of this request, and not summarised:\n${omitted
        .map((file) => `- ${file.path}: ${file.detail}`)
        .join('\n')}`
    : '';
  // Every file was refused, missing or too large. Say so anyway: a run that
  // silently proceeds without them is indistinguishable, to the model and to
  // the person reading the thread afterwards, from a project that never had
  // any. The record alone cannot carry that, because the model never sees it.
  if (!bodies.length)
    return {
      section: `This project has instructions the person loaded, and none of them fit this request. Nothing from them was summarised or paraphrased here.\n${left}`,
      delivery,
      governing: context.governing,
    };

  const section = [
    PREAMBLE,
    `Project rules that carry them (${context.view.revision}):\n${applied
      .map((rule) => `- ${rule.text}`)
      .join('\n')}`,
    ...bodies,
    ...(left ? [left] : []),
  ].join('\n');
  return { section, delivery, governing: context.governing };
}

/** The History sentence for one delivery. Names files and shas, never bodies. */
export function deliverySentence(delivery: InstructionDelivery): string {
  const sent = delivery.files.filter((file) => file.state === 'sent');
  const omitted = delivery.files.filter((file) => file.state === 'omitted');
  const named = (files: readonly DeliveredInstructionFile[]) =>
    files.map((file) => `${file.path}${file.sha ? ` (${short(file.sha)})` : ''}`).join(', ');
  const first = sent.length
    ? `Diomedes sent project instructions to ${delivery.routeId}: ${named(sent)}.`
    : `Diomedes sent no project instructions to ${delivery.routeId}.`;
  return omitted.length ? `${first} Left out whole: ${named(omitted)}.` : first;
}
