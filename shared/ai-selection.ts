import type { Conversation, Project, Route, Settings } from './types.js';
import { isRoute } from './engines.js';

export function selectedEngine(
  settings: Settings,
  project?: Project,
  thread?: Conversation | null,
): Route {
  if (thread?.engine) return thread.engine;
  const prior = thread
    ? [...thread.turns].reverse().find((turn) => turn.role !== 'you')
    : undefined;
  if (prior?.route) return prior.route;
  if (project?.ai) return project.ai.engine;
  const saved = settings.services?.defaultEngine;
  return isRoute(saved) ? saved : 'sample';
}

export function selectedModel(
  engine: Route,
  settings: Settings,
  project?: Project,
  thread?: Conversation | null,
): string | undefined {
  if (thread?.requested?.model && selectedEngine(settings, project, thread) === engine)
    return thread.requested.model;
  if (project?.ai?.engine === engine && project.ai.model) return project.ai.model;
  const saved = settings.services?.[`${engine}Model`];
  return typeof saved === 'string' && saved ? saved : undefined;
}
