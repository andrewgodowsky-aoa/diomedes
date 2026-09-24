/**
 * Which controls a native conversation may offer, read from its route contract
 * and nothing else (H04). A control appears only where the route answers the
 * command; a `host` steer is a queue Diomedes holds, and is named as one, never
 * as live steering. Pure, so the server and the Console read it the same way.
 */
import type { AdapterRouteContract } from './adapter-contract.js';

export interface SessionControls {
  routeId: string;
  /** The engine and build the contract's evidence covers: the attribution anchor. */
  engine: { id: string; version: string };
  followUp: boolean;
  /** `live`: into the running turn. `queued`: held and sent as the next turn. Null: no steering. */
  steer: 'live' | 'queued' | null;
  stop: boolean;
  resume: boolean;
  fork: boolean;
  close: boolean;
}

export function sessionControls(contract: AdapterRouteContract): SessionControls {
  const on = (command: keyof AdapterRouteContract['commands']) =>
    contract.commands[command].support !== 'unsupported';
  const steer = contract.commands.steer.support;
  return {
    routeId: contract.routeId,
    engine: { id: contract.engine.id, version: contract.engine.version },
    followUp: on('follow-up'),
    steer: steer === 'native' ? 'live' : steer === 'host' ? 'queued' : null,
    stop: on('interrupt'),
    resume: on('resume'),
    fork: on('fork'),
    close: on('close'),
  };
}

/**
 * H03: `GET /api/projects/:id/threads/:threadId/native-session`. What a Console thread may offer
 * for its open native conversation, and what the record says about it. `controls` is null where
 * the thread's open lineage is not a native session. `continuity` is null until its run exists.
 * `queued` is the host's steering queue (`controls.steer === 'queued'`), newest last, including
 * what became of each message; it is held in memory and a restart empties it.
 */
export interface ThreadSessionView {
  runId: string | null;
  controls: SessionControls | null;
  busy: boolean;
  continuity: {
    state: 'live' | 'resumable' | 'new' | 'start-again';
    detail: string;
    cursor: number;
  } | null;
  requestedModel: string | null;
  /** The model the engine itself reported for this session: the attribution (decision 8). */
  reportedModel: string | null;
  queued: {
    commandId: string;
    state: 'pending' | 'delivered' | 'logged-only' | 'rejected' | 'cancelled';
    detail: string;
    at: string;
  }[];
}
