/**
 * P04: a pack's playbooks on a model-API conversation turn, index first.
 *
 * The model is offered one read tool, `load_playbook`, whose description
 * carries the index of the playbooks this Project has turned on: an id, a
 * name, one line and a few trigger phrases each. That index is all a turn
 * pays for. When the person's request matches one, the model loads it by id;
 * the body comes through the contribution loader, pinned to what this message
 * was admitted with and checked against the digest the Project registered,
 * and the load is recorded (`server/pack-contributions.ts`).
 *
 * Triggers are hints a model reads, never commands the host parses
 * (`shared/capability-packs.ts`). Loading a playbook grants nothing: it is a
 * read of pack data, and the playbook's own terms say it acts on nothing.
 * Offered only in Ask and Plan, the Modes a skill runs in, and only for packs
 * whose playbooks this build runs.
 */
import { z } from 'zod';
import { isCapabilityPackId } from '../../../shared/capability-packs.js';
import { renderIndex, type RegisteredPackIndex } from '../../../shared/pack-contributions.js';
import type { PackContributions } from '../../pack-contributions.js';
import { ApiError } from '../../paths.js';
import type { Store } from '../../store.js';
import { SKILL_PREAMBLE } from '../instruction-delivery.js';
import { ToolRegistry } from '../tools.js';

export const PLAYBOOK_TOOL = 'load_playbook';

/** What one turn may load, and how. Built by the host at admission; never from a client or a model. */
export interface PlaybookAccess {
  /** The index lines the tool description carries. */
  readonly index: string;
  readonly ids: readonly string[];
  load(id: string): Promise<{ id: string; name: string; packVersion: string; digest: string; body: string }>;
}

/** The terms a loaded playbook runs under: the same four rules a chosen one does. */
const TERMS = SKILL_PREAMBLE.replace(
  'The person selected the playbook below for this request.',
  'You loaded this playbook because the request matched it.',
);

/** The one read tool, registered into a turn's registry. */
export function registerPlaybookTool(registry: ToolRegistry, access: PlaybookAccess): void {
  registry.register({
    name: PLAYBOOK_TOOL,
    version: '1',
    description: `Load one playbook's steps before following it. Load one only when the request clearly matches it, at most once each; answer without one otherwise. Playbooks turned on in this project:\n${access.index}`,
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
    schema: z.strictObject({ id: z.string().min(1).max(64) }),
    outputSchema: z.union([
      z.strictObject({ found: z.literal(false), id: z.string(), message: z.string() }),
      z.strictObject({
        found: z.literal(true),
        id: z.string(),
        name: z.string(),
        version: z.string(),
        digest: z.string(),
        terms: z.string(),
        playbook: z.string(),
      }),
    ]),
    execute: async ({ input }) => {
      if (!access.ids.includes(input.id))
        return { found: false, id: input.id, message: 'No playbook has that id. Use an id from the list.' };
      try {
        const loaded = await access.load(input.id);
        return {
          found: true,
          id: loaded.id,
          name: loaded.name,
          version: loaded.packVersion,
          digest: loaded.digest,
          terms: TERMS,
          playbook: loaded.body,
        };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return { found: false, id: input.id, message: error.message };
      }
    },
  });
}

/**
 * The playbook access one conversation message gets, or nothing: pinned now,
 * from the Project state as the message is admitted. Empty when no pack with
 * playbooks is on, or the Mode is not one a playbook runs in.
 */
export async function playbookAccess(
  contributions: PackContributions,
  state: Parameters<Store['persist']>[0],
  runKey: string,
  mode: string,
): Promise<{ playbooks?: PlaybookAccess }> {
  if (mode !== 'ask' && mode !== 'plan') return {};
  const pin = await contributions.admit(state, runKey);
  const runnable: RegisteredPackIndex[] = pin.indexes.filter((index) => isCapabilityPackId(index.packId));
  const index = renderIndex(runnable, 'workflow');
  if (!index) return {};
  const owner = new Map<string, string>();
  for (const pack of runnable)
    for (const entry of pack.entries)
      if (entry.kind === 'workflow' && !owner.has(entry.id)) owner.set(entry.id, pack.packId);
  return {
    playbooks: {
      index,
      ids: [...owner.keys()],
      load: (id) =>
        contributions.load(pin, { packId: owner.get(id)!, kind: 'workflow', id }, { reason: 'triggered' }),
    },
  };
}
