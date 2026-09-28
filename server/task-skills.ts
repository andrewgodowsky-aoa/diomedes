/**
 * The task work loop's playbook: one selected skill, loaded whole, pinned and recorded.
 *
 * `Task.workflow.skill` (shared/types.ts, `TaskWorkflowSkill`) is guidance
 * only: `{ packId, skillId }` naming the method the run should follow. It
 * grants nothing, activates nothing and selects no model or engine.
 *
 * Four properties, the same as every other skill path:
 *
 * 1. **Absent is ordinary.** A task with no workflow or no skill returns null;
 *    the loop runs exactly as before.
 * 2. **Active and known is checked before anything is loaded.** The first
 *    `assembleSkillSection` call (runtime Mode `work`, one of
 *    SKILL_COMPATIBLE_MODES) refuses an inactive pack (409 `pack_inactive`),
 *    an unknown skill (404) or a room too small (413) before the contribution
 *    loader is touched, so a budget failure happens before any paid start.
 *    `PackSkill.mode` stays the recommended launch Mode; `work` is the runtime
 *    Mode a task loop runs in.
 * 3. **The exact version and digest are pinned in use.** The body loads through
 *    the run's own pin (`contributions.admit` then `contributions.load` in the
 *    same store transaction, reason `chosen`: the person selected it),
 *    checked against the digest the Project registered. A missing body or a
 *    digest mismatch is refused and propagated; there is no silent fallback to
 *    a rendered playbook. The second `assembleSkillSection` call carries the
 *    loaded body, so `use.packVersion` and `use.digest` name what was sent.
 * 4. **Terms and budget are unchanged.** The section keeps the response-format,
 *    input, no-authority and outward-send terms and the whole-or-nothing
 *    `instructionSectionBudget` room the person-selected path uses.
 */
import type { Task } from '../shared/types.js';
import type { PackContributions } from './pack-contributions.js';
import type { Store } from './store.js';
import { assembleSkillSection, type AssembledSkill } from './harness/instruction-delivery.js';

/** The live Project state the store persists. */
type Stored = Parameters<Store['persist']>[0];

/**
 * Assemble the task's selected playbook for a work-loop run, or null when the
 * task names none. Throws 404/409/413 with the same sentences the
 * person-selected path uses; the caller records `use` on the Session.
 */
export async function prepareTaskSkill(
  contributions: PackContributions,
  state: Stored,
  task: Task,
  runKey: string,
  budgetBytes: number,
): Promise<AssembledSkill | null> {
  const ref = task.workflow?.skill;
  if (!ref) return null;
  // Verify active, known and fitting before the loader is touched: a refusal
  // here leaves no contribution record behind and costs no paid start.
  assembleSkillSection({
    state,
    packId: ref.packId,
    skillId: ref.skillId,
    mode: 'work',
    budgetBytes,
  });
  const pin = await contributions.admit(state, runKey);
  const loaded = await contributions.load(
    pin,
    { packId: ref.packId, kind: 'workflow', id: ref.skillId },
    { reason: 'chosen', state },
  );
  // Pin what was loaded: the exact pack version and digest go on the turn, and
  // the body sent is the body whose digest was checked. Never falls back.
  return assembleSkillSection({
    state,
    packId: ref.packId,
    skillId: ref.skillId,
    mode: 'work',
    budgetBytes,
    loaded: { body: loaded.body, digest: loaded.digest, packVersion: loaded.packVersion },
  });
}
