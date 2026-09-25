// A candidate is "named" only when commit, version, package hashes, protocol
// versions and test results agree, so this re-checks the build artifacts and
// writes one JSON record. It requires zero failures, never fixed test counts.
//
// Beyond the test reports it takes three gate proofs, each behind its own flag:
// --desktop-smoke, --installer-proof and --installed-runtime. They are what the
// release README reads out of `verification`. Until they were recorded here, no
// README could claim them however much had actually been run: the README has
// read them from this record since f143e9e, and this file never wrote them.
// A named flag is read strictly: the report must parse, record its own pass,
// and hash to the bytes this record already hashed, or the record is not
// written at all. An unnamed flag records nothing, and the README keeps saying
// the gate was not verified, which is the truth.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
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
import { DEVIN_VERSION } from '../server/engines/devin.js';

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
/**
 * What this record says about one gate that is not a test report: the packaged
 * desktop smoke, the installer's install/repair/uninstall proof, the installed
 * runtime. The release README reads these three out of `verification` and
 * prints "NOT VERIFIED in this record" for a key that is absent, so a key is
 * written only when its report was read here and agreed with the bytes this
 * record already hashes. `result` is the field that README reads.
 */
interface GateOutcome {
  result: 'passed';
  report: string;
  reportSha256: string;
  ranAt: string | null;
  checks?: number;
}

const options = {
  unit: 'test-results/candidate/unit-results.json',
  browser: 'test-results/candidate/browser-results.json',
  installer: null as string | null,
  // The three gate reports have no default path on purpose. A default would let
  // a leftover proof from an earlier build be picked up and claimed silently,
  // which is the one thing these gates must never do: an unrun gate has to stay
  // unrun. Naming the flag is the operator saying which run they mean.
  desktopSmoke: null as string | null,
  installerProof: null as string | null,
  installedRuntime: null as string | null,
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
    else if (flag === '--desktop-smoke') options.desktopSmoke = value();
    else if (flag === '--installer-proof') options.installerProof = value();
    else if (flag === '--installed-runtime') options.installedRuntime = value();
    else if (flag === '--typecheck') {
      if (value() !== 'passed') throw new Error(`Unknown --typecheck value; the only recorded result is 'passed'.`);
      options.typecheck = 'passed';
    } else if (flag === '--allow-uncommitted') options.allowUncommitted = true;
    else throw new Error(`Unknown flag ${JSON.stringify(String(flag))}; expected --unit, --browser, --installer, --desktop-smoke, --installer-proof, --installed-runtime, --typecheck or --allow-uncommitted.`);
  }
  // Each gate is claimable only beside the thing that binds it to these bytes:
  // the installer proof names an installer this record must have hashed, and
  // the runtime proof only describes an installed copy if there was an install.
  if (options.installerProof !== null && options.installer === null)
    throw new Error('--installer-proof needs --installer; without the installer this record hashes, the proof names bytes nothing here checked.');
  if (options.installedRuntime !== null && options.installerProof === null)
    throw new Error('--installed-runtime needs --installer-proof; without it nothing shows the runtime that was exercised was the installed one.');
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

// ---------------------------------------------------------------------------
// The three gates that are proofs rather than test reports.
//
// Each reader below refuses a report it cannot tie to this build. A report that
// is absent, unparseable, missing a field, recording a failure, or describing
// different bytes is an error and stops the record; it is never written as a
// weaker claim. Omitting the flag is the only way to a record without the gate,
// and the README then prints it as not verified, which is the truth.
// ---------------------------------------------------------------------------

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not a JSON object.`);
  return value as Record<string, unknown>;
};
const asText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing from the report.`);
  return value;
};
const mustBeTrue = (value: unknown, label: string): void => {
  if (value !== true) throw new Error(`${label} is ${value === undefined ? 'missing from the report' : JSON.stringify(value)}, not true.`);
};
const mustBeEmpty = (value: unknown, label: string): void => {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array in the report.`);
  if (value.length) throw new Error(`${label} records ${String(value.length)}; a candidate records no failure.`);
};
const countedChecks = (value: unknown, label: string): number => {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} lists no checks; the report is not a completed run.`);
  return value.length;
};
/** Windows paths, compared as the same run wrote them: case and separators only. */
const isInside = (child: string, parent: string): boolean => {
  const normalise = (value: string): string => value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return `${normalise(child)}\\`.startsWith(`${normalise(parent)}\\`);
};

/**
 * `scripts/desktop-smoke.mjs` on the packaged executable. It writes its proof
 * only on the passing path, so the record's question is not "did it pass" but
 * "was the thing it drove these bytes", and only the proof can answer that: its
 * `executableSha256` is taken from the executable the smoke launched, when it
 * launched it. A proof without one is refused rather than completed by hashing
 * the path it names, because that hash is taken now, not then — after a rebuild
 * to the same path it describes the new bytes, and would pass a smoke that only
 * ever ran on the old ones.
 */
export function desktopSmokeOutcome(
  proof: unknown,
  context: { report: string; reportSha256: string; appVersion: string; executableSha256: string },
): GateOutcome {
  const it = asObject(proof, 'The desktop smoke report');
  for (const key of ['rendererNodeDisabled', 'serviceStopsOnClose', 'dataLockReleased', 'persistedOnRestart'])
    mustBeTrue(it[key], `The desktop smoke report's ${key}`);
  mustBeEmpty(it.pageErrors, "The desktop smoke report's pageErrors");
  if (it.passed !== undefined) mustBeTrue(it.passed, "The desktop smoke report's passed");

  const version = asObject(it.startup, "The desktop smoke report's startup").version;
  if (version !== context.appVersion)
    throw new Error(`The desktop smoke ran against version ${JSON.stringify(version)}, not this build's ${context.appVersion}.`);

  if (typeof it.executableSha256 !== 'string' || !it.executableSha256.trim())
    throw new Error('The desktop smoke report names no executableSha256, so nothing ties it to the bytes it drove. Re-run npm run test:desktop on this build.');
  const drove = it.executableSha256.trim();
  if (drove.toLowerCase() !== context.executableSha256.toLowerCase())
    throw new Error(`The desktop smoke ran against an executable hashing ${drove}, not this build's ${context.executableSha256}.`);

  return {
    result: 'passed',
    report: context.report,
    reportSha256: context.reportSha256,
    ranAt: typeof it.checkedAt === 'string' ? it.checkedAt : null,
  };
}

/**
 * `scripts/verify-windows-installer.ps1`. Its `passed` is a real outcome — the
 * script writes `false` when the body, a check or the registration hand-back
 * failed — and its `installerSha256` is the installer it actually ran, which
 * must be the installer this record hashed.
 */
export function installerProofOutcome(
  proof: unknown,
  context: { report: string; reportSha256: string; installerSha256: string },
): GateOutcome {
  const it = asObject(proof, 'The installer proof');
  mustBeTrue(it.passed, "The installer proof's passed");
  const checks = countedChecks(it.checks, 'The installer proof');
  const ran = asText(it.installerSha256, "The installer proof's installerSha256");
  if (ran.toLowerCase() !== context.installerSha256.toLowerCase())
    throw new Error(`The installer proof ran the installer hashing ${ran}, not the one this record hashed, ${context.installerSha256}.`);
  // Present from the moment the proof installs, and the anchor the runtime
  // proof is checked against below.
  asText(it.installTarget, "The installer proof's installTarget");
  return { result: 'passed', report: context.report, reportSha256: context.reportSha256, ranAt: typeof it.startedAt === 'string' ? it.startedAt : null, checks };
}

/**
 * `scripts/connections-desktop-smoke.mjs` against the installed copy, which the
 * installer proof launches from its own install target. The installed files are
 * gone by the time this record is written — uninstall is part of the proof — so
 * the tie is that the installer proof reached the runtime step and that the
 * executable exercised was inside that proof's install target.
 */
export function installedRuntimeOutcome(
  proof: unknown,
  context: { report: string; reportSha256: string; appVersion: string; installerProof: unknown },
): GateOutcome {
  const it = asObject(proof, 'The installed runtime proof');
  mustBeTrue(it.passed, "The installed runtime proof's passed");
  mustBeEmpty(it.errors, "The installed runtime proof's errors");
  const checks = countedChecks(it.checks, 'The installed runtime proof');
  if (it.version !== context.appVersion)
    throw new Error(`The installed runtime proof records version ${JSON.stringify(it.version)}, not this build's ${context.appVersion}.`);

  const installer = asObject(context.installerProof, 'The installer proof');
  asText(installer.runtime, "The installer proof's runtime");
  const installTarget = asText(installer.installTarget, "The installer proof's installTarget");
  const executablePath = asText(it.executablePath, "The installed runtime proof's executablePath");
  if (!isInside(executablePath, installTarget))
    throw new Error(`The installed runtime proof exercised ${executablePath}, which is not inside the installer proof's install target ${installTarget}.`);

  return { result: 'passed', report: context.report, reportSha256: context.reportSha256, ranAt: typeof it.startedAt === 'string' ? it.startedAt : null, checks };
}

/** A gate report as it is named on the command line: its content, and how the record will cite it. */
async function readProof(given: string, label: string): Promise<{ proof: unknown; report: string; reportSha256: string }> {
  const abs = path.resolve(root, given);
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new Error(`Missing ${label} report ${given}.`);
    throw error;
  }
  let proof: unknown;
  try {
    proof = JSON.parse(text);
  } catch {
    throw new Error(`The ${label} report ${given} is not readable JSON.`);
  }
  // A proof is usually copied in beside the record, but it may be read from a
  // sibling worktree. The record is committed, so it cites a repository path or
  // a bare filename, never one machine's absolute path.
  const relative = rel(abs);
  const report = relative.startsWith('../') || path.isAbsolute(relative) ? path.basename(abs) : relative;
  return { proof, report, reportSha256: await sha256File(abs) };
}

async function main(): Promise<void> {
  // Parsed here so a bad flag fails with the same one-line message as a bad artifact.
  parseArgs();
  const buildInfo = await readRequired<BuildInfo>('evidence/windows-release/build-info.json', 'run the Windows release build first');
  const packageJson = await readRequired<{ version: string }>('package.json', 'the repository root is misresolved');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const appDirRel = 'release/Diomedes-win32-x64';
  const asarRel = `${appDirRel}/resources/app.asar`;
  const executableSha256 = await hashRequired(path.join(root, `${appDirRel}/nectovia.exe`), `${appDirRel}/nectovia.exe`, 'packaged executable');
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
  let installerSha256: string | null = null;
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
    installerSha256 = installerSha;
  }

  // The gates that are proofs. Each is read only when its flag named a report,
  // and each reader throws rather than record a claim it cannot tie to these
  // bytes, so `null` here means nobody showed the gate was run on this build.
  let desktopSmoke: GateOutcome | null = null;
  if (options.desktopSmoke !== null) {
    const read = await readProof(options.desktopSmoke, 'desktop smoke');
    desktopSmoke = desktopSmokeOutcome(read.proof, {
      report: read.report, reportSha256: read.reportSha256,
      appVersion: packageJson.version, executableSha256,
    });
  }

  let installerProof: GateOutcome | null = null;
  let installerProofReport: unknown = null;
  if (options.installerProof !== null) {
    // parseArgs already refused this flag without --installer, so the hash is set.
    if (installerSha256 === null) throw new Error('--installer-proof needs --installer.');
    const read = await readProof(options.installerProof, 'installer proof');
    installerProofReport = read.proof;
    installerProof = installerProofOutcome(read.proof, { report: read.report, reportSha256: read.reportSha256, installerSha256 });
  }

  let installedRuntime: GateOutcome | null = null;
  if (options.installedRuntime !== null) {
    const read = await readProof(options.installedRuntime, 'installed runtime');
    installedRuntime = installedRuntimeOutcome(read.proof, {
      report: read.report, reportSha256: read.reportSha256,
      appVersion: packageJson.version, installerProof: installerProofReport,
    });
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
      engines: { testedVersions: TESTED_VERSIONS, claude: CLAUDE_VERSION, opencode: OPENCODE_VERSION, cursor: CURSOR_VERSION, devin: DEVIN_VERSION },
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
      // The three proof gates, written only when their report was read and
      // agreed with these bytes. `installer` here is the gate's outcome; the
      // top-level `installer` above is the artifact it ran. An absent key is
      // what the release README prints as not verified, and that is correct:
      // a gate this record does not carry is one nobody can show was run.
      ...(desktopSmoke === null ? {} : { desktopSmoke }),
      ...(installerProof === null ? {} : { installer: installerProof }),
      ...(installedRuntime === null ? {} : { installedRuntime }),
    },
    signing: { application: 'NotSigned', installer: 'NotSigned', publisher: null },
    // The computer this record was written on, which is the one the gate
    // reports above were produced on when the release steps run in one place.
    // The release README prints `host.tested`, and says the question is not
    // verified when a record carries none. `os.version()` is the product name
    // ("Windows 11 Home"); `os.release()` alone reads "10.0.26200", which a
    // person takes for Windows 10.
    host: {
      tested: `${os.version()} (${os.release()})`,
      platform: process.platform,
      arch: process.arch,
    },
    recordedAt: new Date().toISOString(),
  };
  const outRel = `evidence/release-candidates/${releaseId}.json`;
  await fs.mkdir(path.join(root, 'evidence/release-candidates'), { recursive: true });
  await fs.writeFile(path.join(root, outRel), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(`Candidate ${releaseId} recorded at ${outRel}.`);
}

// A gate script must fail with its own one-sentence disagreement, never a stack trace.
// Imported for its gate readers, this file reads no argument and writes nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
