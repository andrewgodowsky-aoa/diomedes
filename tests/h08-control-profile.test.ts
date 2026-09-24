/**
 * H08: which of the six controls each Work route offers is read from its adapter
 * contract and the drivers wired to Work runs, never from its name. These pin the
 * per-route table the implementation record publishes, so a contract change that
 * alters what the Console offers shows up here first.
 */
import { expect, test } from 'vitest';
import { COMMAND_FAMILY } from '../shared/adapter-contract.js';
import { COMMAND_FAMILIES, receiptRevision } from '../shared/contract-revision.js';
import { ROUTES } from '../shared/engines.js';
import { controlNotApplicable, workControlProfile } from '../shared/session-controls.js';
import {
  CONTROL_COMMANDS,
  CONTROL_FAMILY,
  WORK_CONTROL_CONTRACT_VERSION,
  WORK_CONTROL_REVISION,
  controlPayload,
  controlRequestSchema,
} from '../shared/work-control.js';
import { defaultWorkContract } from '../server/durable-controls.js';
import { CONTROL_FIXTURE_CONTRACT } from '../server/durable-controls-fixture.js';
import { checkAdapterContract } from '../shared/adapter-contract.js';

const offered = (route: string, wired = {}) => {
  const profile = workControlProfile(defaultWorkContract(route), route, wired);
  return CONTROL_COMMANDS.map((control) => profile.controls[control].support ?? '-').join(' ');
};

test('the revision is additive: contract version 1, a dated revision a receipt reader recognises', () => {
  expect(WORK_CONTROL_CONTRACT_VERSION).toBe(1);
  expect(receiptRevision({ contractRevision: WORK_CONTROL_REVISION })).toBe('2026-09-24.1');
  expect(receiptRevision({})).toBe('pre-2026-09-13.1');
});

test('each control carries the command family its adapter command already binds to', () => {
  for (const control of CONTROL_COMMANDS)
    expect(COMMAND_FAMILIES as readonly string[]).toContain(CONTROL_FAMILY[control]);
  expect(CONTROL_FAMILY.queue).toBe(COMMAND_FAMILY['follow-up']);
  expect(CONTROL_FAMILY.steer).toBe(COMMAND_FAMILY.steer);
  expect(CONTROL_FAMILY.resume).toBe(COMMAND_FAMILY.resume);
  expect(CONTROL_FAMILY.retry).toBe(COMMAND_FAMILY.retry);
  expect(CONTROL_FAMILY.fork).toBe(COMMAND_FAMILY.fork);
});

test('every Work route offers what its contract declares and nothing it does not', () => {
  //                        steer queue stop resume retry fork
  expect(offered('sample')).toBe('- host host - - -');
  for (const route of ROUTES.filter((item) => item !== 'sample'))
    expect(offered(route), route).toBe('- host host - host -');
  // A contract that declares native commands nobody wired to Work runs offers none of them.
  expect(offered('native-fixture')).toBe('- host host - - -');
  expect(offered('codex-report')).toBe('- host host - - -');
  const unwired = workControlProfile(defaultWorkContract('native-fixture'), 'native-fixture');
  expect(unwired.controls.resume.note).toBe(
    'This route declares resume, but this build has not wired it to Work runs, so it is not offered.',
  );
  expect(offered('native-fixture', { resume: true, retry: true, fork: true })).toBe(
    '- host host native native native',
  );
  // An unregistered route keeps Stop and Queue and says why nothing else is offered.
  const unknown = workControlProfile(null, 'somewhere');
  expect(unknown.controls.retry).toEqual({
    control: 'retry',
    support: null,
    note: 'No route contract is registered for this route.',
  });
  expect(unknown.stopScopes).toEqual(['task', 'queued']);
});

test('a host steer is a queue, so Steer is not offered and the note says what the route does', () => {
  const opencodeSession = defaultWorkContract('opencode-session')!;
  const profile = workControlProfile(opencodeSession, 'opencode', { steer: true });
  expect(profile.controls.steer.support).toBeNull();
  expect(profile.controls.steer.note).toMatch(
    /^This route holds a message until the running turn ends rather than reaching it: /,
  );
  expect(profile.controls.queue.support).toBe('host');
});

test('the control fixture is a valid contract that declares all six', () => {
  const contract = checkAdapterContract(CONTROL_FIXTURE_CONTRACT);
  const profile = workControlProfile(contract, 'sample', { steer: true, resume: true });
  expect(CONTROL_COMMANDS.map((control) => profile.controls[control].support)).toEqual([
    'native',
    'host',
    'host',
    'native',
    'host',
    'host',
  ]);
  expect(defaultWorkContract('control-fixture')).toBeNull();
});

test('a control applies only to a run in a state it can act on', () => {
  expect(controlNotApplicable('steer', 'working')).toBeNull();
  expect(controlNotApplicable('steer', 'done')).not.toBeNull();
  expect(controlNotApplicable('resume', 'stopped')).toBeNull();
  expect(controlNotApplicable('resume', 'failed')).toBe('Only a stopped run can be resumed.');
  expect(controlNotApplicable('retry', 'failed')).toBeNull();
  expect(controlNotApplicable('retry', 'done')).toBe(
    'Only a failed or stopped run can be retried.',
  );
  expect(controlNotApplicable('fork', 'waiting')).toBe(
    'Fork from a run once it has stopped or finished.',
  );
  expect(controlNotApplicable('fork', 'done')).toBeNull();
});

test('the digest covers what a control means, not how its keys were ordered', () => {
  const a = controlRequestSchema.parse({
    protocolVersion: 1,
    commandId: 'c1',
    taskId: 'T1',
    control: 'queue',
    text: 'Then price it.',
    waitsFor: 'turn',
    route: 'codex',
  });
  const b = controlRequestSchema.parse({
    route: 'codex',
    waitsFor: 'turn',
    text: 'Then price it.',
    control: 'queue',
    taskId: 'T1',
    commandId: 'c1',
    protocolVersion: 1,
    sources: [],
    model: null,
  });
  expect(JSON.stringify(controlPayload(a))).toBe(JSON.stringify(controlPayload(b)));
  expect(
    controlRequestSchema.safeParse({
      protocolVersion: 1,
      commandId: 'x'.repeat(121),
      taskId: 'T1',
      control: 'fork',
      sessionId: 'S1',
    }).success,
  ).toBe(false);
});
