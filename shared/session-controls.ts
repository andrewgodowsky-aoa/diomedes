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
