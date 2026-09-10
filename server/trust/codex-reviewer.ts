/**
 * The default reviewer route: a separate Codex invocation.
 *
 * "Separate" here is exactly what the code can prove and no more. Each review
 * starts its own app-server client and its own thread, with reviewer-only
 * instructions and no team tool host, so it is a different invocation and a
 * different conversation from the proposing run. It may use the same account,
 * and it may resolve to the same model weights: whether it did is recorded
 * per decision from the runtime's own report, never assumed. Weight-level or
 * vendor-level independence is not claimed anywhere.
 */
import { askCodex } from '../integrations.js';
import { REVIEWER_TIMEOUT_MS } from '../../shared/permissions.js';
import type { ReviewerAdapter } from './reviewer.js';

export const REVIEWER_INDEPENDENCE_STATEMENT =
  'The reviewer is a separate invocation and a separate thread with review-only instructions and no tools. It may use the same account and the same model as the worker; each decision records which model the runtime actually reported. Diomedes does not claim independent weights or an independent vendor.';

export function codexReviewerAdapter(
  generate: typeof askCodex = askCodex,
): ReviewerAdapter {
  return async (request) => {
    const result = await generate({
      prompt: request.prompt,
      // The packet rides as a document, so its untrusted text is never spliced
      // into the instruction channel.
      documents: [
        {
          path: `review-packet-${request.invocationId}.json`,
          text: JSON.stringify(request.packet),
        },
      ],
      instructions: request.instructions,
      ...(request.model ? { model: request.model } : {}),
      signal: request.signal,
    });
    return {
      text: result.text,
      ...(result.model ? { model: result.model } : {}),
      ...(result.version ? { version: result.version } : {}),
      ...(result.threadId ? { threadId: result.threadId } : {}),
    };
  };
}

export const REVIEWER_TIMEOUT_SECONDS = Math.round(REVIEWER_TIMEOUT_MS / 1000);
