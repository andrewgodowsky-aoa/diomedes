// Offline validation of the committed proof; does not launch apps or use credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = async (name) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const hash = async (name) => createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
const runtime = await read('run-06/runtime-proof.json');
const installer = await read('run-06/installer-proof.json');
const manifest = await read('run-06/published-manifest.json');
const native = await read('run-06/native-installer-completed.json');
const before = await read('run-06/state-before.json');
assert.equal(runtime.passed, true);
assert.equal(installer.passed, true);
assert.equal(runtime.checks.length, 5);
assert.ok(runtime.checks.every((item) => item.passed));
assert.deepEqual(runtime.errors, []);
assert.equal(runtime.cleanup.length, 4);
assert.ok(runtime.cleanup.every((item) => item.closed));
assert.equal(runtime.oldProcessExited, true);
assert.deepEqual(runtime.launches.map((item) => item.version), ['0.1.6', '0.1.6', '0.1.7', '0.1.7']);
assert.equal(runtime.handoffResult.parentPid, runtime.launches[1].pid);
assert.equal(runtime.handoffResult.status, 'launched');
assert.equal(runtime.handoffResult.artifact.path, path.join(installer.installTarget, '../data/updates', runtime.installRequest.body.assetName));
assert.equal(runtime.handoffResult.artifact.sha256, runtime.installRequest.body.sha256);
assert.equal(runtime.handoffResult.artifact.sha256, manifest.artifacts.find((item) => item.kind === 'per-user-installer').sha256);
assert.equal(runtime.handoffResult.artifact.size, 266655455);
assert.equal(manifest.build.commit, '6e2f033b4778d88ff544d11874f3c1aedb2051f7');
for (const launch of runtime.launches.slice(2)) {
  assert.equal(launch.executableSha256, manifest.internalPackageHashes.executableSha256);
  assert.equal(launch.asarSha256, manifest.internalPackageHashes.asarSha256);
}
assert.equal(runtime.currentUpdaterStatus.check.outcome, 'current');
assert.equal(runtime.currentUpdaterStatus.installedVersion, '0.1.7');
assert.equal(installer.priorRegistration.displayVersion, '0.1.6');
assert.equal(installer.upgradedRegistration.displayVersion, '0.1.7');
assert.equal(installer.priorRegistration.installDir, installer.upgradedRegistration.installDir);
assert.equal(installer.runtimeExit, 0);
assert.equal(installer.originalInstallFileCount, 78);
for (const key of ['registrationRestored', 'originalInstallUnchanged', 'taskbarPinsUnchanged', 'taskbandUnchanged', 'pendingRestoreCleared']) assert.equal(installer[key], true, key);
assert.deepEqual(await read('run-06/original-install-before.json'), await read('run-06/original-install-after.json'));
assert.equal(native.installTarget, installer.installTarget);
for (const key of ['observedSuccess', 'observedDestination', 'installerWindowClosed']) assert.equal(native[key], true, key);
assert.deepEqual(before, await read('run-06/state-after.json'));
assert.deepEqual(before, await read('run-06/state-restarted.json'));
assert.equal(before.state.tasks.length, 2);
assert.equal(before.state.history.length, 2);
assert.equal(before.files.length, 4);
assert.equal(runtime.isolation.testMode, false);
assert.equal(runtime.isolation.providerCredentials, false);
assert.equal(runtime.isolation.accountFilesCopied, false);
assert.ok(!runtime.isolation.environmentKeys.some((key) => /AWS|TOKEN|SECRET|API_KEY/.test(key)));
for (const item of await read('run-06/driver-hashes.json')) {
  assert.equal(await hash(path.win32.basename(item.Path)), item.Hash.toLowerCase());
}
for (let i = 1; i <= 5; i++) assert.equal((await read(`attempts/run-${String(i).padStart(2, '0')}/installer-proof.json`)).passed, false);
const sums = (await fs.readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
for (const line of sums) {
  const match = /^([a-f0-9]{64})  ([\w./-]+)$/.exec(line);
  assert.ok(match, 'Malformed evidence checksum entry');
  assert.ok(!match[2].split('/').includes('..'), 'Checksum entry escapes evidence root');
  assert.equal(await hash(match[2]), match[1], match[2]);
}
console.log(JSON.stringify({ passed: true, runtimeChecks: 5, launches: 4, tasksPreserved: 2, historyEntriesPreserved: 2, projectFilesPreserved: 4, originalInstallFilesUnchanged: 78, earlierFailedAttemptsRetained: 5 }, null, 2));
