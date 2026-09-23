import type { Express, NextFunction, Request, Response } from 'express';
import { ApiError } from './paths.js';
import type { Mode } from '../shared/types.js';
import {
  resolveWorkStyle,
  type WorkStyle,
  type WorkStyleInput,
} from '../shared/work-style.js';
import {
  workStyleInputWithAdvice,
  type JevAdvisor,
  type PreflightSource,
} from './harness/jev-advisor.js';

/**
 * What the host knows about a thread, read under its own lock and released
 * before any provider is asked. `workStyle` is the exact input the thread's
 * next dispatch would resolve with, minus the message; null when its route
 * takes no WorkStyle.
 */
export interface PreflightThreadContext {
  readonly tenant: string;
  readonly mode: Mode;
  readonly style: WorkStyle | null;
  readonly workStyle: Omit<WorkStyleInput, 'hints'> | null;
}

const MAX_TEXT = 10_000;
const MAX_SOURCES = 50;

function parseSources(value: unknown): PreflightSource[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCES)
    throw new ApiError(400, `Choose at most ${MAX_SOURCES} sources.`);
  return value.map((entry) => {
    const item = entry as { path?: unknown; sha?: unknown };
    if (
      typeof item?.path !== 'string' ||
      !item.path.trim() ||
      item.path.length > 500 ||
      typeof item.sha !== 'string' ||
      item.sha.length > 128
    )
      throw new ApiError(400, 'Give each source as a path and its revision.');
    return { path: item.path, sha: item.sha };
  });
}

/**
 * The Jev preflight for a thread's next message (NC-2026-09-22.1, Phase F).
 *
 * Mounted only when the host is given an advisor, which nothing does by
 * default, so the route does not exist in an ordinary build. It is a preview:
 * it returns the advice and the WorkStyle resolution with and without it, and
 * changes nothing. Dispatch does not read it. Carrying advice into dispatch
 * waits on a decided home for a pre-run evaluation charge, because a preflight
 * runs before there is a run to charge.
 *
 * The provider is asked outside the store lock, bounded by the advisor's own
 * timeout, and abandoned if the caller disconnects. Whatever the provider does,
 * the response carries the deterministic resolution.
 */
export function mountJevAdvisorRoutes(
  app: Express,
  advisor: JevAdvisor,
  context: (projectId: string, threadId: string) => Promise<PreflightThreadContext>,
): void {
  app.post(
    '/api/projects/:id/threads/:threadId/preflight',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = (req.body ?? {}) as { text?: unknown; sources?: unknown };
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT)
          throw new ApiError(400, `Provide the message, up to ${MAX_TEXT} characters.`);
        const text = body.text;
        const sources = parseSources(body.sources);
        const projectId = String(req.params.id);
        const threadId = String(req.params.threadId);
        const thread = await context(projectId, threadId);

        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const advice = await advisor.preflight(
          {
            scope: { tenant: thread.tenant, project: projectId, thread: threadId },
            intent: text,
            mode: thread.mode,
            style: thread.style,
            sources,
            // No tool shortlist is offered from here yet: the host has no
            // per-thread list of authorized tools to offer, and advice may only
            // choose among what it is given.
            shortlist: [],
          },
          controller.signal,
        );

        const base = thread.workStyle ? { ...thread.workStyle, hints: { text } } : null;
        res.json({
          advice,
          resolution: base
            ? {
                deterministic: resolveWorkStyle(base),
                advised: resolveWorkStyle(workStyleInputWithAdvice(base, advice)),
              }
            : null,
        });
      } catch (error) {
        next(error);
      }
    },
  );
}
