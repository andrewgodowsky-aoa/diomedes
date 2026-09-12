// A candidate is "named" only when commit, version, package hashes, protocol
// versions and test results agree, so this re-checks the build artifacts and
// writes one JSON record. It requires zero failures, never fixed test counts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { AGENT_PROTOCOL_VERSION } from '../shared/agents.js';
import { REVIEWER_PROTOCOL_VERSION } from '../shared/permissions.js';
// Imported so the record carries the adapter protocols, not copies of them.
import { ADAPTER_CAPABILITIES } from '../server/harness/adapters.js';
import { TESTED_VERSIONS } from '../server/engines/service.js';
import { CLAUDE_VERSION } from '../server/engines/claude.js';
import { OPENCODE_VERSION } from '../server/engines/opencode.js';
import { CURSOR_VERSION } from '../server/engines/cursor.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Records stay stable across platforms, so separators are always slashes.
const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');

interface BuildInfo {
  schemaVersion: 1; version: string; baseCommit: string;
  sourceStatus: 'committed' | 'local-uncommitted';
  sourceDigest: string; signing: string; builtAt: string;
  source: { path: string; sha256: string }[];
  nativeRuntime: { version: string; sha256: Record<string, string> };
}
interface UnitReport {
  success: boolean; numTotalTests: number; numTotalTestSuites: number;
  numPassedTests: number; numFailedTests: number; numPendingTests: number;
  // One entry per test file; numTotalTestSuites counts describe blocks, not files.
  testResults: unknown[];
}
interface BrowserStats { expected: number; unexpected: number; flaky: number; skipped: number }
interface InstallerManifest {
  schemaVersion: 1; productId: string; outputBytes: number; outputSha256: string;
  appDir: string; appVersion: string; appTreeSha256: string;
  compiler: { name: string; version: string };
}
interface InstallerRecord {
  filename: string; bytes: number; sha256: string;
  productId: string; appTreeSha256: string; compiler: { name: string; version: string };
}

const options = {
  unit: 'test-results/candidate/unit-results.json',
  browser: 'test-results/candidate/browser-results.json',
  installer: null as string | null,
  typecheck: 'not-recorded',
  allowUncommitted: false,
};
function parseArgs(): void {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`Missing value for ${flag}.`);
      i++;
      return next;
    };
    if (flag === '--unit') options.unit = value();
    else if (flag === '--browser') options.browser = value();
    else if (flag === '--installer') options.installer = value();
    else if (flag === '--typecheck') {
      if (value() !== 'passed') throw new Error(`Unknown --typecheck value; the only recorded result is 'passed'.`);
      options.typecheck = 'passed';
    } else if (flag === '--allow-uncommitted') options.allowUncommitted = true;
    else throw new Error(`Unknown flag ${JSON.stringify(String(flag))}; expected --unit, --browser, --installer, --typecheck or --allow-uncommitted.`);
  }
}

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function readRequired<T>(repoRel: string, why: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, repoRel), 'utf8')) as T;
  } catch (error) {
    if (isMissing(error)) throw new Error(`Missing required input ${repoRel}: ${why}.`);
    throw error;
  }
}
async function sha256File(abs: string): Promise<string> {
  // Streamed because the executable is too large to hold in memory.
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(abs)) hash.update(chunk);
  return hash.digest('hex');
}
async function hashRequired(abs: string, repoRel: string, label: string): Promise<string> {
  try {
    return await sha256File(abs);
  } catch (error) {
    if (isMissing(error)) throw new Error(`Missing ${label} ${repoRel}.`);
    throw error;
  }
}

async function main(): Promise<void> {
  // Parsed here so a bad flag fails with the same one-line message as a bad artifact.
  parseArgs();
  const buildInfo = await readRequired<BuildInfo>('evidence/windows-release/build-info.json', 'run the Windows release build first');
  const packageJson = await readRequired<{ version: string }>('package.json', 'the repository root is misresolved');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const appDirRel = 'release/Diomedes-win32-x64';
  const asarRel = `${appDirRel}/resources/app.asar`;
  const executableSha256 = await hashRequired(path.join(root, `${appDirRel}/Diomedes.exe`), `${appDirRel}/Diomedes.exe`, 'packaged executable');
  const asarSha256 = await hashRequired(path.join(root, asarRel), asarRel, 'packaged asar');

  if (buildInfo.version !== packageJson.version)
    throw new Error(`Build version ${buildInfo.version} does not match package.json version ${packageJson.version}.`);
  if (buildInfo.baseCommit !== head)
    throw new Error(`Build base commit ${buildInfo.baseCommit} does not match git HEAD ${head}.`);
  if (buildInfo.sourceStatus !== 'committed' && !options.allowUncommitted)
    throw new Error(`Build source status is '${buildInfo.sourceStatus}', not 'committed'; pass --allow-uncommitted to record it as an unnamed candidate.`);

  const embedded = JSON.parse(extractFile(path.join(root, asarRel), 'BUILD_INFO.json').toString('utf8')) as unknown;
  if (JSON.stringify(embedded) !== JSON.stringify(buildInfo))
    throw new Error(`Embedded BUILD_INFO.json in ${asarRel} does not deep-equal the build-info file.`);

  for (const entry of buildInfo.source) {
    const actual = await hashRequired(path.join(root, entry.path), entry.path, 'build source file');
    if (actual !== entry.sha256)
      throw new Error(`Build source file ${entry.path} changed after the build and no longer matches its recorded hash.`);
  }

  const unit = await readRequired<UnitReport>(options.unit, 'run the unit suite with the JSON reporter first');
  if (!unit.success || unit.numFailedTests !== 0)
    throw new Error(`Unit report ${options.unit} does not record a passing run (success=${String(unit.success)}, failed=${String(unit.numFailedTests)}).`);

  const browser = await readRequired<{ stats: BrowserStats }>(options.browser, 'run the Playwright suite with the JSON reporter first');
  if (browser.stats.unexpected !== 0)
    throw new Error(`Browser report ${options.browser} records ${String(browser.stats.unexpected)} unexpected failures.`);

  const lastRunRel = 'test-results/browser/.last-run.json';
  let lastRun: string | null = null;
  try {
    lastRun = (JSON.parse(await fs.readFile(path.join(root, lastRunRel), 'utf8')) as { status: string }).status;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (lastRun !== null && lastRun !== 'passed') throw new Error(`Browser last-run status is '${lastRun}', not 'passed'.`);

  let installer: InstallerRecord | null = null;
  if (options.installer !== null) {
    const given = options.installer;
    const manifest = await readRequired<InstallerManifest>(rel(`${path.resolve(root, given)}.json`), 'it was not written by scripts/build-windows-installer.mjs');
    const installerSha = await hashRequired(path.resolve(root, given), given, 'installer');
    if (installerSha !== manifest.outputSha256)
      throw new Error(`Installer hash ${installerSha} does not match manifest outputSha256 ${manifest.outputSha256}.`);
    if (manifest.appVersion !== packageJson.version)
      throw new Error(`Installer manifest appVersion ${manifest.appVersion} does not match package.json version ${packageJson.version}.`);
    if (path.resolve(root, manifest.appDir) !== path.resolve(root, appDirRel))
      throw new Error(`Installer manifest appDir ${manifest.appDir} does not match the packaged app directory ${appDirRel}.`);
    // Named fields only: the manifest carries archive URLs and hashes the record must not repeat.
    installer = { filename: path.basename(given), bytes: manifest.outputBytes, sha256: installerSha, productId: manifest.productId, appTreeSha256: manifest.appTreeSha256, compiler: { name: manifest.compiler.name, version: manifest.compiler.version } };
  }

  const electron = (await readRequired<{ version: string }>('node_modules/electron/package.json', 'run npm install first')).version;
  const harness = [...new Set(Object.values(ADAPTER_CAPABILITIES).map((caps) => caps.protocolVersion))];
  const builtAt = new Date(buildInfo.builtAt);
  const stamp = `${String(builtAt.getUTCFullYear())}${String(builtAt.getUTCMonth() + 1).padStart(2, '0')}${String(builtAt.getUTCDate()).padStart(2, '0')}`;
  const releaseId = `diomedes-${buildInfo.version}-windows-experimental-${stamp}-${buildInfo.baseCommit.slice(0, 12)}`;

  const record = {
    schemaVersion: 1, releaseId, named: buildInfo.sourceStatus === 'committed',
    product: 'Diomedes', appVersion: buildInfo.version, channel: 'experimental',
    build: {
      baseCommit: buildInfo.baseCommit, sourceStatus: buildInfo.sourceStatus, sourceDigest: buildInfo.sourceDigest,
      builtAt: buildInfo.builtAt, identityEmbeddedIn: 'resources/app.asar:BUILD_INFO.json', sourceFiles: buildInfo.source.length,
    },
    package: { directory: appDirRel, executableSha256, asarSha256, electron },
    installer,
    nativeRuntime: { version: buildInfo.nativeRuntime.version, sha256: buildInfo.nativeRuntime.sha256 },
    protocols: {
      // server/command-admission.ts admits only protocolVersion 1; it exports no constant.
      workCommand: 1,
      // shared/permissions.ts declares protocolVersion 2 on the grant type; it exports no constant.
      scopedGrant: 2,
      reviewer: REVIEWER_PROTOCOL_VERSION, agent: AGENT_PROTOCOL_VERSION, harness,
      engines: { testedVersions: TESTED_VERSIONS, claude: CLAUDE_VERSION, opencode: OPENCODE_VERSION, cursor: CURSOR_VERSION },
    },
    verification: {
      typecheck: options.typecheck,
      unit: {
        passed: unit.numPassedTests, failed: unit.numFailedTests, pending: unit.numPendingTests,
        total: unit.numTotalTests, files: unit.testResults.length, report: rel(path.resolve(root, options.unit)),
      },
      browser: {
        expected: browser.stats.expected, unexpected: browser.stats.unexpected, flaky: browser.stats.flaky,
        skipped: browser.stats.skipped, report: rel(path.resolve(root, options.browser)), lastRun,
      },
    },
    signing: { application: 'NotSigned', installer: 'NotSigned', publisher: null },
    recordedAt: new Date().toISOString(),
  };
  const outRel = `evidence/release-candidates/${releaseId}.json`;
  await fs.mkdir(path.join(root, 'evidence/release-candidates'), { recursive: true });
  await fs.writeFile(path.join(root, outRel), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(`Candidate ${releaseId} recorded at ${outRel}.`);
}

// A gate script must fail with its own one-sentence disagreement, never a stack trace.
try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
