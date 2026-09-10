import fs from 'node:fs/promises';
import path from 'node:path';
import { EngineInstaller, managedBinary, verifyManagedBinary } from '../server/engines/install.js';
// An already downloaded official ZIP; installs only into a disposable proof root.
// No global installation, PATH change, login, credentials or model request.
const archive = process.argv[2];
if (!archive) throw new Error('Supply the pinned OpenCode 1.18.4 Windows baseline ZIP.');
const root = await fs.mkdtemp(path.resolve('test-results/install-proof-'));
let downloads = 0;
const installer = new EngineInstaller(root, {
  fetch: async () => {
    downloads++;
    const bytes = await fs.readFile(archive);
    return new Response(new Uint8Array(bytes));
  },
});
try {
  await installer.install('opencode', true);
  await verifyManagedBinary(root, 'opencode');
  await installer.install('opencode', true);
  if (downloads !== 1) throw new Error('Retry downloaded an already verified installation.');
  await fs.appendFile(managedBinary(root, 'opencode'), 'changed');
  let changedRejected = false;
  try {
    await installer.install('opencode', true);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'INSTALL_CHECKSUM')
      changedRejected = true;
    else throw error;
  }
  if (!changedRejected) throw new Error('A changed managed binary was accepted.');
  await fs.mkdir('evidence/ai-setup', { recursive: true });
  await fs.writeFile(
    'evidence/ai-setup/install-proof.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        engine: 'opencode',
        version: '1.18.4',
        archive: path.resolve(archive),
        officialChecksumVerified: true,
        freshActivation: true,
        idempotentReuse: true,
        changedBinaryRejected: true,
        downloads,
        root,
        modelPrompts: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: verified official ZIP, fresh owned activation, reuse, changed-binary rejection.',
  );
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
