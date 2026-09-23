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
  /**
   * What an Ask or Plan message may read from the project. Absent means the selected
   * documents only; `project` lets the route look through the folder for this one message.
   */
  readAccess?: import('./read-access.js').ReadAccess;
}

/** `POST .../messages/:commandId/select`. Bound to the proposal that was shown and to its project. */
export interface SelectionRequest {
  proposalDigest: string;
  projectId: string;
  consent: true;
}

/**
 * What a message-scoped Stop answers. `settled` comes only from the command's
 * own recorded turn result, never from the run being terminal. The other three
 * are the owning driver's acknowledgement: `requested` means the active entry
 * was this command's and its signal fired (a transport acknowledgement, not
 * proof the turn durably stopped), `idle` that nothing is running for the run,
 * `superseded` that its active command is a different one. The durable answer
 * is still read from the outcome.
 */
export type InterruptState = 'requested' | 'settled' | 'idle' | 'superseded';

/** `POST .../messages/:commandId/interrupt`. Strict empty body; the path names everything. */
export interface InterruptResponse {
  commandId: string;
  runId: string | null;
  state: InterruptState;
}

/**
 * `POST /api/projects/:id/threads/:threadId/answer-format`: "Update this conversation". The client
 * mints `commandId` once, when the person confirms, and retries with the same one.
 */
export interface ConversationUpdateRequest {
  commandId: string;
}

/**
 * What "Update this conversation" did. `updated` is false when every open conversation in the
 * thread already runs on the current instructions: nothing was retired and no note was written.
 * `noteId` names the one note turn the update wrote; a retry of the same command reads it back.
 */
export interface ConversationUpdate {
  updated: boolean;
  noteId: string | null;
}

/** Why "Update this conversation" was refused with 409, as the error's `code`. */
export type ConversationUpdateRefusal = 'conversation_busy' | 'proposal_waiting';
