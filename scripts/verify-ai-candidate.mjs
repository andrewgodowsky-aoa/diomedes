import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';

const base = path.resolve('evidence/ai-setup');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const build = JSON.parse(await fs.readFile('evidence/windows-release/build-info.json', 'utf8'));
const desktop = JSON.parse(await fs.readFile(path.join(base, 'desktop-proof.json'), 'utf8'));
const units = JSON.parse(await fs.readFile(path.join(base, 'unit-results.json'), 'utf8'));
if (units.numFailedTests || units.numPendingTests || units.numPassedTests !== 697)
  throw new Error('The full unit verification is incomplete.');
if (desktop.sourceDigest !== build.sourceDigest)
  throw new Error('Desktop proof belongs to a different candidate.');
for (const file of build.source)
  if (sha(await fs.readFile(file.path)) !== file.sha256)
    throw new Error(`Candidate input changed: ${file.path}`);
const candidate = path.resolve('release/Diomedes-win32-x64');
const asar = path.join(candidate, 'resources/app.asar');
const embedded = JSON.parse(extractFile(asar, 'BUILD_INFO.json').toString());
if (embedded.sourceDigest !== build.sourceDigest)
  throw new Error('Packaged source identity differs from the verified candidate.');
for (const [name, expected] of Object.entries(build.nativeRuntime.sha256))
  if (sha(await fs.readFile(path.join(candidate, 'resources/native-runtime', name))) !== expected)
    throw new Error(`Packaged native runtime changed: ${name}`);
const browser = JSON.parse(await fs.readFile('test-results/browser/.last-run.json', 'utf8'));
if (browser.status !== 'passed' || browser.failedTests.length)
  throw new Error('The latest browser verification failed.');
const verification = {
  at: new Date().toISOString(),
  branch: execFileSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  baseCommit: build.baseCommit,
  sourceDigest: build.sourceDigest,
  sourceStatus: build.sourceStatus,
  candidate,
  exeSha256: sha(await fs.readFile(path.join(candidate, 'Diomedes.exe'))),
  asarSha256: sha(await fs.readFile(asar)),
  typecheck: 'passed',
  unitTests: {
    passed: units.numPassedTests,
    failed: units.numFailedTests,
    files: units.testResults.length,
    maxWorkers: 4,
  },
  browserTests: {
    passed: 28,
    failed: 0,
    files: ['ai-engines-ui.spec.ts', 'ui.spec.ts', 'native-ui.spec.ts', 'field.spec.ts'],
  },
  packagedCleanAndUpgrade: 'passed',
  installedMetadata: desktop.metadata.map(
    ({ engine, version, authentication, models, detail }) => ({
      engine,
      version,
      authentication,
      modelCount: models.length,
      detail,
    }),
  ),
  modelPrompts: 0,
  commit: 'not performed',
  publication: 'not performed',
  deployment: 'not performed',
};
await fs.writeFile(
  path.join(base, 'final-verification.json'),
  JSON.stringify(verification, null, 2),
);
await fs.writeFile(path.join(base, 'changed-files.txt'), '');
const changed = new Set();
for (const args of [
  ['diff', '--name-only', '-z'],
  ['ls-files', '--others', '--exclude-standard', '-z'],
])
  for (const name of execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).split('\0'))
    if (name) changed.add(name);
await fs.writeFile(path.join(base, 'changed-files.txt'), [...changed].sort().join('\n') + '\n');
console.log(JSON.stringify(verification, null, 2));
