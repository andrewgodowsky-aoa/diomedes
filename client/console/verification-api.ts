import { api } from '../api';
import type { AcceptanceCheck, AcceptanceDeclaration, VerificationView } from '../../shared/verification';

const path = (value: string) => encodeURIComponent(value);

/** Replace a task's declared acceptance checks. Declaring grants nothing. */
export const declareAcceptance = (projectId: string, taskId: string, checks: readonly AcceptanceCheck[]) =>
  api<AcceptanceDeclaration>(`/projects/${path(projectId)}/tasks/${path(taskId)}/acceptance`, 'PUT', { checks });

/** Run the declared checks on a finished run. The result arrives with the next project state. */
export const runVerification = (projectId: string, sessionId: string) =>
  api<VerificationView>(`/projects/${path(projectId)}/sessions/${path(sessionId)}/verification`, 'POST', {});
