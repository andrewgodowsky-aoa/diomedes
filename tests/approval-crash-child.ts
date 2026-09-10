import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';

const [root, projectId, taskId, phase] = process.argv.slice(2);
const phases = [
  'before-decision',
  'after-decision',
  'journal',
  'first-file',
  'after-files',
  'finalized',
];
if (!root || !projectId || !taskId || !phases.includes(phase))
  throw new Error('Invalid approval crash fixture arguments.');
const original = '\ufeff# Brief\r\n\r\nSynthetic before bytes.\r\n';
const app = await createApp({
  dataDir: path.join(root, 'data'),
  projectRoot: path.join(root, 'projects'),
  nativeGenerator: async () => {
    await fs.writeFile(path.join(root, 'adapter-invoked.txt'), 'once', { flag: 'wx' });
    return {
      model: 'crash-fixture',
      text: JSON.stringify({
        summary: 'Prepare two exact changes.',
        changes: [
          {
            path: 'Brief.md',
            text: `${original}Reviewed addition.\r\n`,
            summary: 'Append a sentence.',
          },
          { path: 'Draft.md', text: '# Draft\n', summary: 'Create a draft.' },
        ],
      }),
    };
  },
});
const store: Store = app.locals.store;
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const start = await fetch(`${base}/work/start`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    protocolVersion: 1,
    commandId: 'crash-work',
    taskId,
    route: 'codex',
    sources: ['Brief.md', 'Reference.md'],
    consent: true,
  }),
});
if (!start.ok) throw new Error(`Crash Work start failed: ${start.status}`);
for (let n = 0; n < 200 && !store.state(projectId).needs.some((need) => need.state === 'open'); n++)
  await new Promise((resolve) => setTimeout(resolve, 10));
const need = store.state(projectId).needs.find((item) => item.state === 'open');
if (!need?.approval) throw new Error('No exact approval was produced.');
const command = {
  protocolVersion: 1,
  commandId: 'crash-approval',
  resolution: 'go-ahead',
  proposalDigest: need.approval.proposalDigest,
  actionDigest: need.approval.actionDigest,
  baseDigest: need.approval.baseDigest,
};
await fs.writeFile(path.join(root, 'approval-command.json'), JSON.stringify(command));
const persist = store.persist.bind(store);
store.persist = async (state) => {
  const execution = state.needs.find((item) => item.id === need.id)?.execution?.state;
  if (execution === 'pending' && phase === 'before-decision') process.exit(80);
  if (execution === 'applied' && phase === 'after-files') process.exit(84);
  await persist(state);
  if (execution === 'pending' && phase === 'after-decision') process.exit(81);
};
const rename = fs.rename.bind(fs),
  unlink = fs.unlink.bind(fs);
const pending = path.join(root, 'data', 'pending');
fs.rename = async (from, to) => {
  await rename(from, to);
  if (phase === 'journal' && path.dirname(String(to)) === pending && String(to).endsWith('.json'))
    process.exit(82);
  if (
    phase === 'first-file' &&
    String(to) === path.join(store.state(projectId).project.folder, 'Brief.md')
  )
    process.exit(83);
};
fs.unlink = async (target) => {
  await unlink(target);
  if (
    phase === 'finalized' &&
    path.dirname(String(target)) === pending &&
    String(target).endsWith('.json')
  )
    process.exit(85);
};
await fetch(`${base}/needs/${need.id}/resolve`, {
  method: 'POST',
  headers,
  body: JSON.stringify(command),
});
throw new Error(`Approval crash phase ${phase} did not terminate at its boundary.`);
