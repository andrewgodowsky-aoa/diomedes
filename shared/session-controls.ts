/**
 * Which controls a native conversation may offer, read from its route contract
 * and nothing else (H04). A control appears only where the route answers the
 * command; a `host` steer is a queue Diomedes holds, and is named as one, never
 * as live steering. Pure, so the server and the Console read it the same way.
 */
import type { AdapterRouteContract } from './adapter-contract.js';
import {
  WORK_CONTROL_CONTRACT_VERSION,
  WORK_CONTROL_REVISION,
  type ControlAvailability,
  type ControlCommand,
  type RouteControlProfile,
} from './work-control.js';

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

/**
 * Which of the six durable Work controls (H08, `shared/work-control.ts`) a run's
 * route offers, read from the same route contract as `sessionControls` plus the
 * drivers the host has wired to Work runs. Pure, so the server that enforces it
 * and the Console that offers it can never disagree.
 *
 * - Steer is offered only where the contract says `native` and a driver can reach
 *   the running turn. A `host` steer is a queue, so Queue is what is offered.
 * - Queue is Diomedes' own follow-up queue: host on every route.
 * - Stop's `task` and `queued` scopes hold everywhere; `generation` needs the
 *   route to answer `interrupt`.
 * - Resume needs a wired driver: a Work run keeps no continuable state of its own.
 * - Retry and Fork are composed by Diomedes where the contract says `host`, and
 *   need a wired driver where it says `native`.
 * A contract that declares a command the host has not wired is not offered it,
 * and the note says so rather than implying it works.
 */
export interface WiredControls {
  steer?: boolean;
  resume?: boolean;
  retry?: boolean;
  fork?: boolean;
}

export function workControlProfile(
  contract: AdapterRouteContract | null,
  workRoute: string,
  wired: WiredControls = {},
): RouteControlProfile {
  const notWired = (command: string) =>
    `This route declares ${command}, but this build has not wired it to Work runs, so it is not offered.`;
  const off = (control: ControlCommand, note: string): ControlAvailability => ({
    control,
    support: null,
    note,
  });
  const queue: ControlAvailability = {
    control: 'queue',
    support: 'host',
    note: 'Held, then sent through ordinary Work admission after this turn or the task.',
  };
  const stop: ControlAvailability = {
    control: 'stop',
    support: 'host',
    note: 'Ends the task’s run and cancels what it had queued; recorded changes stay in History.',
  };
  if (!contract)
    return {
      contractVersion: WORK_CONTROL_CONTRACT_VERSION,
      contractRevision: WORK_CONTROL_REVISION,
      workRoute,
      contractRouteId: null,
      engine: null,
      controls: {
        steer: off('steer', 'No route contract is registered for this route.'),
        queue,
        stop,
        resume: off('resume', 'No route contract is registered for this route.'),
        retry: off('retry', 'No route contract is registered for this route.'),
        fork: off('fork', 'No route contract is registered for this route.'),
      },
      stopScopes: ['task', 'queued'],
    };
  const answer = (command: keyof AdapterRouteContract['commands']) => contract.commands[command];
  const steerAnswer = answer('steer');
  const steer: ControlAvailability =
    steerAnswer.support === 'native'
      ? wired.steer
        ? { control: 'steer', support: 'native', note: steerAnswer.note }
        : off('steer', notWired('steer'))
      : steerAnswer.support === 'host'
        ? off(
            'steer',
            `This route holds a message until the running turn ends rather than reaching it: ${steerAnswer.note}`,
          )
        : off('steer', steerAnswer.note);
  const resumeAnswer = answer('resume');
  const resume: ControlAvailability =
    resumeAnswer.support === 'unsupported'
      ? off('resume', resumeAnswer.note)
      : wired.resume
        ? { control: 'resume', support: resumeAnswer.support, note: resumeAnswer.note }
        : off('resume', notWired('resume'));
  const composed = (control: 'retry' | 'fork'): ControlAvailability => {
    const declared = answer(control);
    if (declared.support === 'unsupported') return off(control, declared.note);
    if (declared.support === 'host') return { control, support: 'host', note: declared.note };
    return wired[control]
      ? { control, support: 'native', note: declared.note }
      : off(control, notWired(control));
  };
  return {
    contractVersion: WORK_CONTROL_CONTRACT_VERSION,
    contractRevision: WORK_CONTROL_REVISION,
    workRoute,
    contractRouteId: contract.routeId,
    engine: { id: contract.engine.id, version: contract.engine.version },
    controls: { steer, queue, stop, resume, retry: composed('retry'), fork: composed('fork') },
    stopScopes:
      answer('interrupt').support === 'unsupported'
        ? ['task', 'queued']
        : ['generation', 'task', 'queued'],
  };
}

/**
 * Whether a control applies to a run in its current state, beside whether the
 * route offers it. Steer needs a live run; Resume a stopped one; Retry a failed
 * or stopped one; Fork one that has settled. Null means it applies.
 */
export function controlNotApplicable(control: ControlCommand, sessionState: string): string | null {
  const live = ['queued', 'working', 'waiting'].includes(sessionState);
  switch (control) {
    case 'steer':
      return live ? null : 'Steering reaches a running turn, and this run is not running.';
    case 'resume':
      return sessionState === 'stopped' ? null : 'Only a stopped run can be resumed.';
    case 'retry':
      return ['failed', 'stopped'].includes(sessionState)
        ? null
        : 'Only a failed or stopped run can be retried.';
    case 'fork':
      return live ? 'Fork from a run once it has stopped or finished.' : null;
    default:
      return null;
  }
}
