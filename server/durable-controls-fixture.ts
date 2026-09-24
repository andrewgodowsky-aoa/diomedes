/**
 * The H08 control fixture: a development route contract that declares all six
 * controls, and the driver that answers it over the scripted sample worker.
 *
 * It exists so the durable-control contract, the refusals and the Console can be
 * proven end to end without a live engine. It is mounted only in test mode, per
 * project, and it is not in `ROUTE_CONTRACTS`, so readiness and conformance never
 * count it as a route a person can use. What it proves is the plumbing — command
 * identity, receipts, availability and revalidation — not any engine's own
 * steering or session resume.
 */
import type { AdapterRouteContract } from '../shared/adapter-contract.js';
import type { WorkControlDriver } from './durable-controls.js';
import type { WorkService } from './work.js';

export const CONTROL_FIXTURE_ROUTE = 'control-fixture';

const native = (note: string) => ({ support: 'native' as const, note });
const host = (note: string) => ({ support: 'host' as const, note });
const unsupported = (note: string) => ({ support: 'unsupported' as const, note });

export const CONTROL_FIXTURE_CONTRACT: AdapterRouteContract = Object.freeze({
  contractVersion: 1,
  routeId: CONTROL_FIXTURE_ROUTE,
  mode: 'native-worker',
  engine: { id: CONTROL_FIXTURE_ROUTE, version: '1', protocolVersion: 'in-process' },
  commands: {
    start: native('The scripted sample worker starts a run.'),
    'follow-up': host('A follow-up is a new run for the same task.'),
    steer: native('The fixture hands the message to the scripted run, which reads it at its next step.'),
    interrupt: unsupported('Stop is the only interruption.'),
    resume: native('The fixture starts a run that continues the stopped one through ordinary admission.'),
    retry: host('Diomedes starts a new attempt with the recorded inputs.'),
    fork: host('Diomedes starts a new task and thread that refer to the origin run.'),
    status: native('The host tracks the worker run directly.'),
    reconcile: unsupported('Nothing external can outlive the worker.'),
    close: native('Stopping the worker ends it.'),
  },
  streaming: { transientPreview: 'none', durableEvents: 'host-record' },
  models: { source: 'none' },
  authentication: 'development-fixture',
  testedWith: null,
}) as AdapterRouteContract;

export function controlFixtureDriver(work: WorkService): WorkControlDriver {
  return {
    async steer({ projectId, session, text }) {
      return work.steer(projectId, session.id, text)
        ? { state: 'delivered', detail: 'The running turn received the message.' }
        : { state: 'rejected', detail: 'The run ended before the message reached it.' };
    },
    async resume(context) {
      const next = await context.start();
      return {
        sessionId: next.id,
        detail: `Resumed as ${next.id}, continuing ${context.session.id}.`,
      };
    },
  };
}
