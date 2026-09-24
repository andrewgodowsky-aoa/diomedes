/**
 * H02: the Codex app-server thread a Work run used, kept with the run's evidence.
 *
 * A Work run on the ChatGPT (Codex) route is one turn on one Codex thread. This
 * record is written once Codex has opened that thread and before any turn is
 * sent, so a Stop, a failure or a restart still leaves the id a Resume or a
 * Fork needs. It says what the installed Codex offered when it was asked
 * (`capabilities`, discovered from the app-server, never assumed from a
 * version) and how the thread came to be, including the truthful case where a
 * resume could not be honoured and a new thread was started instead.
 */

/** What the installed Codex app-server answered when asked for each method. */
export interface CodexCapabilities {
  /** `thread/resume`: continue a saved thread in a new process. */
  readonly resume: boolean;
  /** `thread/fork`: branch a saved thread into a new one. */
  readonly fork: boolean;
  /** `turn/steer`: add input to the turn that is running now. */
  readonly steer: boolean;
}

export type CodexThreadOrigin =
  /** A new thread for this run. */
  | 'started'
  /** Codex continued the thread an earlier run of this task used. */
  | 'resumed'
  /** A resume was asked for and could not be honoured; a new thread was started. */
  | 'restarted-fresh'
  /** Codex continued a thread it had branched from another run's (a Fork). */
  | 'forked';

export interface NativeThreadRecord {
  readonly provider: 'codex';
  /** The Codex app-server thread id. */
  readonly id: string;
  /**
   * Whether Codex was asked to keep the thread after its process ends. Only a
   * kept thread can be resumed or forked later; Diomedes keeps one only when
   * the installed Codex offers resume or fork.
   */
  readonly kept: boolean;
  readonly origin: CodexThreadOrigin;
  /** The thread this one resumed, was forked from, or failed to resume. */
  readonly from: string | null;
  /** One plain sentence for a thread that did not come about as asked. */
  readonly detail: string | null;
  readonly capabilities: CodexCapabilities;
  /** The app-server protocol version that answered. */
  readonly version: string;
  /** The model Codex reported for the thread when it opened it; never parsed from text. */
  readonly model: string | null;
  readonly recordedAt: string;
}
