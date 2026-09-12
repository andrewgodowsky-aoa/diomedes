import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Turn a named candidate into the public asset set for a GitHub prerelease:
//
//   node scripts/write-release-assets.mjs \
//     --record evidence/release-candidates/<releaseId>.json \
//     --installer <path to the exact installer the record names> \
//     --payload <packaged app directory the record hashes> \
//     --out <empty or script-owned output directory> \
//     --tag v0.1.1-experimental.3
//
// It refuses to proceed unless the installer's bytes hash to what the record
// says and the payload's Diomedes.exe and app.asar hash to what the record says,
// so the assets can only describe the candidate that was tested. Output:
//
//   Diomedes-Experimental-<version>-win32-x64.zip   one folder, the whole payload
//   Diomedes-Experimental-<version>-unsigned-setup.exe  copied, not rebuilt
//   Start-Experimental.ps1                              isolated-profile launcher
//   README.txt                                          plain-words guide
//   release-manifest.json                               public-safe: no local paths
//   SHA256SUMS.txt                                      every asset above
//
// Nothing here uploads. The zip is built with the system bsdtar in zip mode.

const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith('--')) args.set(key.slice(2), process.argv[i + 1] ?? ''), (i += 1);
}
const need = (name) => {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
};
const recordPath = path.resolve(need('record'));
const installerPath = path.resolve(need('installer'));
const payloadDir = path.resolve(need('payload'));
const outDir = path.resolve(need('out'));
const tag = need('tag');
if (!/^v\d+\.\d+\.\d+-experimental\.\d+$/.test(tag)) throw new Error(`Tag ${tag} is not v<version>-experimental.<n>.`);

const sha256 = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const run = (command, argv, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}\n${out}${err}`))));
  });

const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
if (record.named !== true) throw new Error('The record is not a named candidate.');
const version = record.appVersion;
if (!tag.startsWith(`v${version}-`)) throw new Error(`Tag ${tag} does not carry the record's version ${version}.`);

// The bytes must be the tested bytes.
const installerSha = await sha256(installerPath);
if (installerSha !== record.installer.sha256)
  throw new Error(`Installer hash ${installerSha} differs from the record's ${record.installer.sha256}.`);
if (path.basename(installerPath) !== record.installer.filename)
  throw new Error(`Installer is named ${path.basename(installerPath)}; the record names ${record.installer.filename}.`);
const exeSha = await sha256(path.join(payloadDir, 'Diomedes.exe'));
if (exeSha !== record.package.executableSha256) throw new Error('Payload Diomedes.exe differs from the record.');
const asarSha = await sha256(path.join(payloadDir, 'resources', 'app.asar'));
if (asarSha !== record.package.asarSha256) throw new Error('Payload app.asar differs from the record.');

// Output directory: empty, or owned by a previous run of this script.
await fs.mkdir(outDir, { recursive: true });
const existing = await fs.readdir(outDir);
const ownerFile = path.join(outDir, '.release-assets-owner.json');
if (existing.length && !existing.includes('.release-assets-owner.json'))
  throw new Error(`${outDir} is not empty and was not written by this script.`);
for (const entry of existing) await fs.rm(path.join(outDir, entry), { recursive: true, force: true });
await fs.writeFile(ownerFile, JSON.stringify({ ownedBy: 'scripts/write-release-assets.mjs', releaseId: record.releaseId, tag }, null, 2) + '\n');

const zipFolder = `Diomedes-Experimental-${version}-win32-x64`;
const zipName = `${zipFolder}.zip`;
const staging = path.join(outDir, zipFolder);
await fs.cp(payloadDir, staging, { recursive: true });
const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
await run(tarExe, ['-a', '-c', '-f', zipName, zipFolder], { cwd: outDir });
await fs.rm(staging, { recursive: true, force: true });

const installerName = record.installer.filename;
await fs.copyFile(installerPath, path.join(outDir, installerName));
const launcherName = 'Start-Experimental.ps1';
await fs.copyFile(path.join(root, 'scripts', 'release-support', launcherName), path.join(outDir, launcherName));

const commit = record.build.baseCommit;
const short = commit.slice(0, 7);
const readme = `Diomedes ${version} - Windows x64 experimental build (${tag})
Release ID: ${record.releaseId}
Built from commit ${commit} on ${record.build.builtAt}.
Tested on Windows 11 build 26200 only. Other Windows versions are unverified.

WHICH FILE
  ${installerName}
    Per-user installer. No administrator rights, no automatic launch. It installs
    into its own experimental product directory and upgrades an earlier
    experimental install in place. Uninstall removes only its own files, its two
    current-user registry keys and its shortcut; your projects and history stay.
  ${zipName}
    Portable. Extract the whole archive; it contains one folder. Run Diomedes.exe
    from inside that folder and keep every file beside it. The bare executable is
    not the application and will not start alone.

CHECK THE FILE FIRST
  In PowerShell:  Get-FileHash .\\${installerName} -Algorithm SHA256
  Compare the result with SHA256SUMS.txt. A match proves the file arrived whole.
  It does not prove who built it: this build is NOT code signed.

ANTIVIRUS AND SMARTSCREEN
  Windows may warn about an unknown publisher, and some antivirus products flag
  new unsigned programs with a generic reputation detection (Norton calls it
  IDP.Generic). That is a heuristic about an unknown file, not a finding about
  this code. Do not switch off your protection to run it. If a file was
  quarantined, restore it only if its SHA-256 matches SHA256SUMS.txt exactly;
  otherwise delete it and download again. A signed build is being prepared; see
  docs/releases/CODE_SIGNING.md in the source repository.

FIRST RUN
  Open Diomedes from the Start menu (installer) or from the extracted folder.
  On first run it offers to look for AI engines already on this computer and
  looks only if you say yes. Diomedes holds no credential of its own: it uses the
  sign-in an engine already has (Codex, Claude Code, OpenCode or Cursor).

ISOLATED EVALUATION
  ${launcherName} -Executable <path to Diomedes.exe> starts the app with a
  separate profile, data and projects folder and an empty synthetic Codex home,
  so it copies no account and touches no existing Diomedes profile.

WHAT WAS VERIFIED ON THESE EXACT BYTES
  TypeScript ${record.verification.typecheck}; ${record.verification.unit.passed} unit tests in ${record.verification.unit.files} files, ${record.verification.unit.failed} failed;
  ${record.verification.browser.expected} browser tests, ${record.verification.browser.unexpected} unexpected; the packaged desktop smoke; the
  installer's install, same-version repair and uninstall; the installed runtime.
  release-manifest.json lists the hashes. The source repository's
  evidence/release-candidates/${record.releaseId}.json is the full record.

LIMITS
  Unsigned, experimental, one machine tested. Codex, Claude Code and OpenCode
  can each produce a reviewed file proposal; Cursor's live route is unproven.
  Connections runs on synthetic data only. The local service is loopback-only.
`;
await fs.writeFile(path.join(outDir, 'README.txt'), readme.replaceAll('\n', '\r\n'));

const asset = async (filename, kind) => {
  const file = path.join(outDir, filename);
  const stat = await fs.stat(file);
  return { kind, filename, bytes: stat.size, sha256: await sha256(file), signing: 'unsigned', publisher: null };
};
const artifacts = [await asset(zipName, 'portable-zip'), await asset(installerName, 'per-user-installer')];
const support = await asset(launcherName, 'optional-isolated-launcher');
const manifest = {
  schemaVersion: 2,
  product: record.product,
  releaseId: record.releaseId,
  tag,
  appVersion: version,
  channel: record.channel,
  build: {
    commit,
    sourceStatus: record.build.sourceStatus,
    sourceDigest: record.build.sourceDigest,
    builtAt: record.build.builtAt,
    identityEmbeddedIn: record.build.identityEmbeddedIn,
  },
  platform: { os: 'Windows', architecture: 'x64', tested: 'Windows 11 build 26200', otherVersions: 'unverified' },
  runtime: { electron: record.package.electron, nativeRuntime: record.nativeRuntime?.version ?? null },
  protocols: record.protocols,
  artifacts,
  supportFiles: [support],
  internalPackageHashes: {
    executableSha256: record.package.executableSha256,
    asarSha256: record.package.asarSha256,
    payloadTreeSha256: record.installer.appTreeSha256,
  },
  installer: { productId: record.installer.productId, compiler: record.installer.compiler },
  signing: record.signing,
  verification: {
    typecheck: record.verification.typecheck,
    unit: { passed: record.verification.unit.passed, failed: record.verification.unit.failed, files: record.verification.unit.files },
    browser: { expected: record.verification.browser.expected, unexpected: record.verification.browser.unexpected },
    record: `evidence/release-candidates/${record.releaseId}.json`,
  },
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/write-release-assets.mjs',
};
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
if (/[A-Za-z]:\\|\/f\/|\/c\//i.test(manifestText)) throw new Error('The public manifest contains a local path.');
await fs.writeFile(path.join(outDir, 'release-manifest.json'), manifestText);

const sums = [];
for (const name of [zipName, installerName, launcherName, 'README.txt', 'release-manifest.json'])
  sums.push(`${await sha256(path.join(outDir, name))}  ${name}`);
await fs.writeFile(path.join(outDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

console.log(JSON.stringify({ outDir, tag, releaseId: record.releaseId, commit: short, artifacts, support }, null, 2));
