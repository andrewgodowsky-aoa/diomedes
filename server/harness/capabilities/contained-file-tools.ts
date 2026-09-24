/**
 * H12: the contained project-file write, as a typed tool. It declares the one
 * path it will write as its target, needs `write-project-file` and waits for an
 * exact approval of its intent; the write goes through `containedWrite`, which
 * refuses anything but that declared target inside the resolved project root.
 *
 * No route or capability offers this tool today: a model-API turn is read-only
 * (owner decision 2026-09-23), and approved document changes keep going through
 * the recorded writer (`Store.writeRecorded`). It is the contained sink a
 * capability that declares a file write registers, and what the H12 attack
 * matrix exercises end to end through `ToolRegistry.dispatch`.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { containedPath, containedWrite } from '../containment.js';
import { digest } from '../policy.js';
import { ToolRegistry } from '../tools.js';

const MAX_TEXT = 1024 * 1024;

export function containedFileTools(
  root: string,
  seams: { beforeCommit?: (absolute: string) => Promise<void> } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'write_file',
    version: '1',
    description:
      'Replace one text file in the project, by its path relative to the project folder, with the given text. The folder must already exist. Waits for approval.',
    effect: 'idempotent',
    effectClass: 'idempotent-write',
    permission: 'write-project-file',
    approval: true,
    destination: 'local',
    trustedInputRequired: false,
    cost: 1,
    limits: { maxInputBytes: MAX_TEXT + 4096, maxOutputBytes: 4096, timeoutMs: 30_000 },
    schema: z.strictObject({ path: z.string().min(1).max(512), text: z.string().max(MAX_TEXT) }),
    outputSchema: z.strictObject({ path: z.string(), bytes: z.number().int().nonnegative() }),
    // Checked before the intent is recorded; checked again at the write.
    targets: async (input) => [(await containedPath(root, input.path, { write: true })).relative],
    // The write replaces the whole file: if the file holds exactly this text, it applied.
    // Anything else could be a later edit by someone, so a person decides.
    reconcile: async ({ input }) => {
      const { path: spelled, text } = input as { path: string; text: string };
      const found = await containedPath(root, spelled, { write: false });
      const now = await fs.readFile(found.absolute, 'utf8').catch(() => null);
      return now !== null && digest(now) === digest(text) ? 'applied' : 'unknown';
    },
    execute: async ({ input, targets, signal }) => {
      signal.throwIfAborted();
      const written = await containedWrite(root, input.path, input.text, {
        declared: targets ?? [],
        maxBytes: MAX_TEXT,
        beforeCommit: seams.beforeCommit,
      });
      return { path: written.relative, bytes: written.bytes };
    },
  });
  return registry;
}
