/**
 * What crosses the wire for one Diomedes conversation message. Types only: the server decides
 * every value here, and a client renders them. Nothing in this file is a status the client may
 * keep: an outcome is read from the run's phases and the project's receipts each time it is
 * asked for, and the client shows what it was last told.
 */

/** The conversation's Mode control. Build and Fix are work modes and never reach a conversation. */
export type ConversationMode = 'ask' | 'plan' | 'auto';

/** Why nothing was proposed or started. `refused` is an admission that was tried and turned down. */
export type NotStartedReason =
  | 'above-ceiling'
  | 'needs-target'
  | 'home-is-not-a-target'
  | 'unknown-target'
  | 'cross-project-read'
  | 'build-not-reachable'
  | 'send-not-reachable'
  | 'control-not-reachable'
  | 'stale-selection'
  | 'refused';

/** What the person is told about one message. Nothing reads as started that did not start. */
export type InteractionOutcome =
  | { status: 'answered' }
  | { status: 'read'; projectId: string }
  | {
      /** Shown, not started. The person's own selection of this exact proposal starts it. */
      status: 'proposed';
      projectId: string;
      operationClass: 'prepare_artifact' | 'write_internal';
      proposalDigest: string;
      summary: string;
    }
  | { status: 'started'; projectId: string; taskId: string; sessionId: string }
  | { status: 'not-started'; reason: NotStartedReason; message: string; taskId: string | null }
  | { status: 'unresolved'; message: string };

export interface MessageResult {
  runId: string;
  commandId: string;
  sourceMessageId: string;
  /** What the person reads. Null when nothing was answered, for example a turn that never finished. */
  answerText: string | null;
  interrupted: boolean;
  outcome: InteractionOutcome;
}

/** `POST /api/projects/:id/threads/:threadId/messages`. The client mints `commandId` once per message. */
export interface MessageRequest {
  commandId: string;
  text: string;
  mode: ConversationMode;
  sources: { path: string; sha: string }[];
  consent: true;
}

/** `POST …/messages/:commandId/select`. Bound to the proposal that was shown and to its project. */
export interface SelectionRequest {
  proposalDigest: string;
  projectId: string;
  consent: true;
}
