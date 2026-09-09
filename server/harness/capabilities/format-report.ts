import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CapabilityManifest } from '../../../shared/harness.js';
import type { Store } from '../../store.js';
import { ApiError } from '../../paths.js';
import { digest } from '../policy.js';
import { harnessWrites, writeInputSchema } from '../approval.js';
import type { RunService } from '../run-service.js';
import type { ToolRegistry } from '../tools.js';

export const FORMAT_REPORT = {
  id: 'format-report',
  version: 'v1',
  label: 'Format a fixture report',
  description: 'Format shipped synthetic lines, then review one recorded local write.',
  tools: ['read_fixture', 'format_lines', 'propose_write'],
  requestedPermissions: ['write-project-file'],
  approvalPolicy: 'show-first',
  maxTurns: 6,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
} satisfies CapabilityManifest;

export function registerFormatReport(tools: ToolRegistry, store: Store, runs: RunService) {
  const pure = {
    version: 'v1',
    effect: 'pure',
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
  } as const;
  tools.register({
    ...pure,
    name: 'read_fixture',
    description: 'Read the shipped synthetic report lines.',
    schema: z.strictObject({}),
    execute: async () => ({
      text: await fs.readFile(
        new URL('../../../fixtures/harness/report-lines.txt', import.meta.url),
        'utf8',
      ),
    }),
  });
  tools.register({
    ...pure,
    name: 'format_lines',
    description: 'Turn lines into a deterministic Markdown report.',
    schema: z.strictObject({ text: z.string().max(128000) }),
    execute: ({ input }) => ({
      text:
        '# Fixture report\n\n' +
        input.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => `- ${line}\n`)
          .join(''),
    }),
  });
  tools.register({
    ...pure,
    name: 'propose_write',
    description: 'Write the exact report after the person approves it.',
    effect: 'idempotent',
    permission: 'write-project-file',
    approval: true,
    schema: writeInputSchema,
    execute: (context) =>
      store.locked(async () => {
        context.signal.throwIfAborted();
        const input = context.input;
        const run = await runs.get(input.runId);
        const step = run.steps.find(
          (item) =>
            item.intent.name === 'propose_write' &&
            digest({ runId: run.id, stepId: item.intent.stepId, intentHash: item.intentHash }) ===
              context.idempotencyKey,
        );
        if (
          run.projectId !== input.projectId ||
          run.state !== 'running' ||
          step?.state !== 'running' ||
          digest(step.intent.input) !== digest(input)
        )
          throw new ApiError(409, 'The report write is not the active approved step.');
        const state = store.state(input.projectId);
        const need = [...state.needs]
          .reverse()
          .find(
            (item) =>
              item.harness?.runId === run.id &&
              item.approval?.actionDigest === step.intentHash &&
              item.approvalReceipt?.decision === 'go-ahead',
          );
        if (!need) throw new ApiError(409, 'The report needs its exact approval receipt.');
        const writes = harnessWrites(input.projectId, need);
        const prior = state.history.find((entry) => entry.label === context.idempotencyKey);
        if (prior) {
          if (
            prior.approvalId !== need.id ||
            need.execution?.state !== 'applied' ||
            prior.id !== need.execution.eventId ||
            prior.files.length !== 1 ||
            prior.files[0].path !== input.files[0] ||
            prior.files[0].before !== input.expected ||
            prior.files[0].after !== digestText(input.text)
          )
            throw new ApiError(
              409,
              'The recovered report needs inspection in History before continuing.',
            );
          return { entryId: prior.id, path: input.files[0], sha: prior.files[0].after };
        }
        if (need.execution?.state !== 'pending')
          throw new ApiError(409, 'This report decision cannot dispatch another write.');
        if (Date.now() >= Date.parse(need.approval!.expiresAt))
          throw new ApiError(409, 'The report approval expired before the write was prepared.');
        await store.writeRecorded(input.projectId, writes, {
          approvalId: need.id,
          actor: 'diomedes-with-ok',
          kind: 'changed',
          sessionId: need.sessionId,
          taskId: need.taskId,
          sample: false,
          review: true,
          merge: false,
          label: context.idempotencyKey,
        });
        const entry = store
          .state(input.projectId)
          .history.find((item) => item.label === context.idempotencyKey);
        if (!entry) throw new Error('The recorded report write has no History receipt.');
        return { entryId: entry.id, path: input.files[0], sha: entry.files[0].after };
      }),
  });
}

const digestText = (text: string) => createHash('sha256').update(text).digest('hex');
