import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { parseApprovalCommand } from '../server/approval-admission.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';

const [root, projectId, phase] = process.argv.slice(2);
if (!root || !projectId || !['after-decision', 'journal', 'after-write'].includes(phase))
  throw new Error('Invalid crash fixture arguments.');
const app = await createApp({
  dataDir: path.join(root, 'data'),
  projectRoot: path.join(root, 'projects'),
});
const store: Store = app.locals.store;
const host: HarnessHost = app.locals.harness;
await host.bridge.startNativeRun(
  projectId,
  null,
  'format-report',
  'Format the shipped fixture.',
  localHarnessPrincipal(projectId),
);
for (let n = 0; n < 200 && !store.state(projectId).needs.some((need) => need.state === 'open'); n++)
  await new Promise((done) => setTimeout(done, 10));
const need = store.state(projectId).needs.find((item) => item.state === 'open');
if (!need?.harness || !need.approval) throw new Error('The fixture produced no Need.');
await fs.writeFile(path.join(root, 'crash-run.txt'), need.harness.runId);
const persist = store.persist.bind(store);
store.persist = async (state) => {
  await persist(state);
  if (phase === 'after-decision' && state.needs.some((item) => item.execution?.state === 'pending'))
    process.exit(17);
};
const rename = fs.rename.bind(fs);
fs.rename = async (from, to) => {
  await rename(from, to);
  if (
    phase === 'journal' &&
    path.dirname(String(to)) === path.join(root, 'data', 'pending') &&
    String(to).endsWith('.json')
  )
    process.exit(17);
};
const write = store.writeRecorded.bind(store);
store.writeRecorded = async (...args) => {
  const result = await write(...args);
  if (phase === 'after-write') process.exit(17);
  return result;
};
const command = {
  protocolVersion: 1,
  commandId: 'crash-fixture-decision',
  resolution: 'go-ahead',
  proposalDigest: need.approval.proposalDigest,
  actionDigest: need.approval.actionDigest,
  baseDigest: need.approval.baseDigest,
};
await store.locked(() =>
  host.bridge.resolve(
    projectId,
    need.id,
    'go-ahead',
    false,
    parseApprovalCommand(projectId, need.id, command),
  ),
);
for (let n = 0; n < 200; n++) await new Promise((done) => setTimeout(done, 10));
throw new Error(`Crash phase ${phase} was not reached.`);
