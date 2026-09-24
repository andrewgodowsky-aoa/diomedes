import type {
  AttentionView,
  AutomationView,
  ScheduleChangeResult,
} from '../../shared/automations';
import type { AutomationSchedule } from '../../shared/automation-schedule';
import { api } from '../api';

/**
 * Automations Milestone B: the schedule's client calls. Kept beside the page
 * rather than in `client/api.ts`, so the shared API file does not grow.
 */
const automationPath = (organizationId: string, automationId: string) =>
  `/workspace/organizations/${encodeURIComponent(organizationId)}/automations/${encodeURIComponent(automationId)}`;

export type ScheduleAction =
  | { action: 'edit'; schedule: AutomationSchedule; catchUpMinutes: number }
  | { action: 'enable' }
  | { action: 'pause'; reason?: string }
  | { action: 'resume' }
  | { action: 'turn-off' };

/** One recorded act, sent against the generation the person read (a stale read is a 409). */
export const changeSchedule = (
  organizationId: string,
  automationId: string,
  expectedGeneration: number,
  change: ScheduleAction,
) =>
  api<ScheduleChangeResult>(`${automationPath(organizationId, automationId)}/schedule`, 'POST', {
    ...change,
    expectedGeneration,
  });

export const markAttentionSeen = (organizationId: string, automationId: string, attentionId: string) =>
  api<AutomationView>(
    `${automationPath(organizationId, automationId)}/attention/${encodeURIComponent(attentionId)}/seen`,
    'POST',
    {},
  );

export const projectAttention = (projectId: string, signal?: AbortSignal) =>
  api<{ items: AttentionView[] }>(
    `/projects/${encodeURIComponent(projectId)}/automation-attention`,
    'GET',
    undefined,
    signal,
  );
