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
//     --tag v0.1.2 \
//     --notes <text file: this build's UPDATES and LIMITS sections>
//     [--mac-dmg <Diomedes-Experimental-<version>-mac-arm64.dmg> --mac-proof <launch smoke proof.json>]
//
// It refuses to proceed unless the installer's bytes hash to what the record
// says and the payload's nectovia.exe and app.asar hash to what the record says,
// so the assets can only describe the candidate that was tested. Output:
//
//   Diomedes-Experimental-<version>-win32-x64.zip   one folder, the whole payload
//   Diomedes-Experimental-<version>-unsigned-setup.exe  copied, not rebuilt
//   Start-Experimental.ps1                              isolated-profile launcher
//   README.txt                                          plain-words guide
//   Diomedes-Experimental-<version>-mac-arm64.dmg       only with --mac-dmg
//   release-manifest.json                               public-safe: no local paths
//   SHA256SUMS.txt                                      every asset above
//
// Nothing here uploads. The zip is built with the system bsdtar in zip mode.
//
// The README's every claim comes from two records: the candidate record for this
// build, and docs/reference/capability-record.json for the routes and for what
// is still unproven. A fact neither record carries is printed as not verified.
// It was not always so: the engine list and the verified-on-these-bytes block
// were literals, which is how a release README came to name an engine Diomedes
// does not ship and to assert an installer proof that had not been run for it.

const root = fileURLToPath(new URL('..', import.meta.url));
const CAPABILITY_RECORD = 'docs/reference/capability-record.json';

/**
 * A stable `v<version>` tag, an experimental `v<version>-experimental.<n>` tag and
 * a release-candidate `v<version>-rc.<n>` tag are accepted, and the choice decides
 * whether this release can ever update anyone. The app parses a release's version
 * out of its tag with an anchored `^v?X.Y.Z$`, so a tag carrying a suffix does not
 * parse at all and the update check reports a malformed feed rather than offering
 * the build. Only a stable tag is an update source.
 */
export const TAG = /^v(\d+\.\d+\.\d+)(?:-experimental\.\d+|-rc\.\d+)?$/;

/**
 * Every public file name one release carries. The Windows names are fixed by the
 * installed updater (shared/app-updates.ts UPDATE_ASSET_PATTERN) and by every
 * release since 0.1.1; the macOS name says its platform and architecture and
 * cannot match the Windows installer pattern, so a Windows updater never sees two.
 */
export function releaseAssetNames(version) {
  return {
    zip: `Diomedes-Experimental-${version}-win32-x64.zip`,
    installer: `Diomedes-Experimental-${version}-unsigned-setup.exe`,
    macDmg: `Diomedes-Experimental-${version}-mac-arm64.dmg`,
    launcher: 'Start-Experimental.ps1',
    readme: 'README.txt',
    manifest: 'release-manifest.json',
    sums: 'SHA256SUMS.txt',
  };
}

/** What a macOS disk image carries by way of a signature: Electron's ad-hoc one only. */
export const MAC_SIGNING =
  'ad-hoc only (no Developer ID signature, not notarized)';

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

/**
 * The gates the old text stated as literals, each with the key it is read from.
 * A gate the record does not carry is a gate nobody can show was run on these
 * bytes, and the README says exactly that rather than dropping the line: a
 * reader who has seen the claim before must be able to see it withdrawn.
 */
const VERIFIED_CLAIMS = [
  ['The packaged desktop smoke', 'desktopSmoke'],
  ["The installer's install, same-version repair and uninstall", 'installer'],
  ['The installed runtime', 'installedRuntime'],
];
const NOT_VERIFIED = 'NOT VERIFIED in this record';

/** What a record says about one gate, or null when it says nothing readable. */
function outcome(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return null;
  for (const key of ['result', 'outcome', 'status', 'lastRun'])
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  if (typeof value.passed === 'boolean') return value.passed ? 'passed' : 'failed';
  return null;
}

const claimed = (value) => outcome(value) ?? NOT_VERIFIED;

/**
 * The Windows this build's recorded verification ran on, read from the record's
 * own `host`: `host.tested` as the writer states it, or `host.name` and
 * `host.release` composed when it records the raw facts instead. A record that
 * carries none is a build nobody can show was tested on any Windows, and the
 * README says that rather than naming the version its author was sitting at.
 */
function testedOn(record) {
  const host = record.host;
  if (!host || typeof host !== 'object') return null;
  if (typeof host.tested === 'string' && host.tested.trim()) return host.tested.trim();
  const parts = ['name', 'release']
    .map((key) => (typeof host[key] === 'string' ? host[key].trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** Whether a recorded signing state is a signature or the absence of one. */
const unsignedState = (state) => /^(un|not\s*)signed/i.test(state);

/**
 * What the record says about signing, as a fact rather than a sentence: the
 * state as it is recorded, and whether that state is a signature. A string is
 * taken as written; this repository's own records carry an object with the
 * application's state, the installer's and the publisher. A record that says
 * nothing decides nothing, and the README prints the question as unanswered.
 */
export function signingFact(value) {
  if (typeof value === 'string' && value.trim()) {
    const stated = value.trim();
    return { stated, signed: !unsignedState(stated) };
  }
  if (!value || typeof value !== 'object') return null;
  const states = ['application', 'installer']
    .map((key) => [key, typeof value[key] === 'string' ? value[key].trim() : ''])
    .filter(([, state]) => state !== '');
  const publisher =
    typeof value.publisher === 'string' && value.publisher.trim() ? value.publisher.trim() : null;
  if (states.length === 0 && !publisher) return null;
  const parts = states.map(([key, state]) => `${key} ${state}`);
  if (publisher) parts.push(`publisher ${publisher}`);
  return {
    stated: parts.join(', '),
    signed: states.length > 0 && states.every(([, state]) => !unsignedState(state)),
  };
}

/** What a public manifest field says when the record answers nothing for it. */
const NOT_RECORDED = 'not recorded';

/** One asset's signing state, from the record's field for that kind of file. */
function assetSigning(value, key) {
  if (typeof value === 'string' && value.trim()) return { signing: value.trim(), publisher: null };
  if (!value || typeof value !== 'object') return { signing: NOT_RECORDED, publisher: null };
  const state = typeof value[key] === 'string' && value[key].trim() ? value[key].trim() : NOT_RECORDED;
  const publisher =
    typeof value.publisher === 'string' && value.publisher.trim() ? value.publisher.trim() : null;
  return { signing: state, publisher };
}

/** `a`, `a and b`, `a, b and c` — the routes as a person would say them. */
function list(names) {
  if (names.length === 0) return 'none';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The README beside the installer. Pure: it is given the two records and
 * returns text. Every sentence about what this build can do or has been shown
 * to do comes from one of them.
 */
export function releaseReadme({
  record,
  capability,
  tag,
  installerName,
  zipName,
  launcherName,
  notes,
  mac = null,
}) {
  // The capability record's release facts describe the newest named candidate
  // it saw. Printing them beside a different build would carry one build's
  // proof onto another, which is the confusion this file exists to end.
  const described = capability?.release?.releaseId ?? null;
  if (described !== record.releaseId)
    throw new Error(
      `${CAPABILITY_RECORD} describes ${described ?? 'no release'}, not ${record.releaseId}. Run: npm run capability-record`,
    );
  const version = record.appVersion;
  // The record keeps "the adapter is in the tree" and "it is inside this build"
  // apart, and this is the sentence that used to collapse them. A route these
  // bytes do not carry is named as that, not offered to the reader.
  const routes = capability.routes ?? [];
  const carried = routes.filter((route) => route.states?.packaged?.release === record.releaseId);
  const elsewhere = routes.filter((route) => !carried.includes(route));
  const engines = `The installed-tool routes this build carries are ${list(carried.map((r) => r.displayName))}.${
    elsewhere.length
      ? ` ${list(elsewhere.map((r) => r.displayName))}: in the source repository, not recorded in this build.`
      : ''
  }`;
  // The two claims this text used to state as literals. Both are read here, and
  // a record that answers neither prints the question rather than an answer.
  const tested = testedOn(record);
  const testedLine = tested
    ? `Tested on ${tested} only. Other Windows versions are unverified.`
    : `Which Windows version this build was tested on: ${NOT_VERIFIED}. Treat every Windows version as unverified.`;
  const signing = signingFact(record.signing);
  const signingLine =
    signing === null
      ? `It does not prove who built it: this build's signing is ${NOT_VERIFIED}.`
      : signing.signed
        ? `It does not prove who built it. The record states this build's signing as ${signing.stated}; check that publisher in the file's own properties.`
        : `It does not prove who built it: the record states this build's signing as ${signing.stated}, so it is NOT code signed.`;
  // An unsigned build and a signed one meet Windows differently, and the
  // paragraph that told every reader a signed build was still being prepared
  // was the same literal in both.
  const antivirus = signing?.signed
    ? `  Windows and some antivirus products apply a reputation heuristic to a
  program they have not seen before, whatever it carries a signature from. That
  is a heuristic about an unfamiliar file, not a finding about this code. Do not
  switch off your protection to run it. If a file was quarantined, restore it
  only if its SHA-256 matches SHA256SUMS.txt exactly; otherwise delete it and
  download again.`
    : `  Windows may warn about an unknown publisher, and some antivirus products flag
  new unsigned programs with a generic reputation detection (Norton calls it
  IDP.Generic). That is a heuristic about an unknown file, not a finding about
  this code. Do not switch off your protection to run it. If a file was
  quarantined, restore it only if its SHA-256 matches SHA256SUMS.txt exactly;
  otherwise delete it and download again. A signed build is being prepared; see
  docs/releases/CODE_SIGNING.md in the source repository.`;
  const verification = record.verification ?? {};
  const unit = verification.unit;
  const browser = verification.browser;
  const counted = (value, text) => (value && typeof value === 'object' ? text(value) : NOT_VERIFIED);
  const unproven = [
    ...(capability.notProven ?? []),
    capability.release.appVersionMatchesSource === false
      ? `This build is version ${version}; the source tree that record was written from is at a different version, so that repository holds work this build does not.`
      : null,
  ].filter(Boolean);

  const macFile = mac
    ? `
  ${mac.dmgName}
    macOS on Apple Silicon (arm64). Open the disk image and drag Diomedes.app
    to Applications. It is not signed with an Apple Developer ID and not
    notarized, so macOS will refuse to open it until you allow it, and that
    choice is yours. Its launch was checked on ${mac.testedOn}; no Mac
    computer has run it.`
    : '';
  return `Nectovia ${version} - ${mac ? 'Windows x64 and macOS arm64' : 'Windows x64'} experimental build (${tag})
Release ID: ${record.releaseId}
Built from commit ${record.build.baseCommit} on ${record.build.builtAt}.
${testedLine}

WHICH FILE
  ${installerName}
    Per-user installer. No administrator rights, no automatic launch. It installs
    into its own experimental product directory and upgrades an earlier
    experimental install in place. Uninstall removes only its own files, its two
    current-user registry keys and its shortcut; your projects and history stay.
  ${zipName}
    Portable. Extract the whole archive; it contains one folder. Run nectovia.exe
    from inside that folder and keep every file beside it. The bare executable is
    not the application and will not start alone.${macFile}

CHECK THE FILE FIRST
  In PowerShell:  Get-FileHash .\\${installerName} -Algorithm SHA256
  Compare the result with SHA256SUMS.txt. A match proves the file arrived whole.
  ${signingLine}

ANTIVIRUS AND SMARTSCREEN
${antivirus}

FIRST RUN
  Open Nectovia from the Start menu (installer) or from the extracted folder.
  On first run it offers to look for AI tools already on this computer and looks
  only if you say yes. An installed-tool route uses the sign-in a tool you
  installed already has. Set up each route in Settings, following this
  release's setup instructions in the notes below.
  ${engines}
  Which of those were exercised live on this build is under LIMITS.

ISOLATED EVALUATION
  ${launcherName} -Executable <path to nectovia.exe> starts the app with a
  separate profile, data and projects folder, and an empty home for the bundled
  native runtime's own configuration, so it copies no account and touches no
  existing Diomedes profile.

WHAT WAS VERIFIED ON THESE EXACT BYTES
  Every line here is read from the candidate record for this build. A check that
  record does not carry is named as not verified rather than left out.
  TypeScript: ${claimed(verification.typecheck)}
  Unit tests: ${counted(unit, (u) => `${u.passed} passed, ${u.failed} failed, in ${u.files} files`)}
  Browser tests: ${counted(browser, (b) => `${b.expected} expected, ${b.unexpected} unexpected`)}
${VERIFIED_CLAIMS.map(([label, key]) => `  ${label}: ${claimed(verification[key])}`).join('\n')}
  release-manifest.json lists the hashes. The source repository's
  evidence/release-candidates/${record.releaseId}.json is the full record.

WHAT THIS BUILD HAS NOT BEEN SHOWN TO DO
${unproven.map((sentence) => `  ${sentence}`).join('\n')}
  These are read from ${CAPABILITY_RECORD} in the source repository, written
  from commit ${capability.generatedFrom.commit}.

${notes}
`;
}

/**
 * The public manifest. Pure: given the record, the measured assets and the facts
 * this run established, it returns the object written as release-manifest.json.
 * The Windows fields keep the shape every release since schema 2 has published;
 * a macOS image is one more `artifacts` entry, named by its own `kind` and
 * `platform`, and the top-level `platform` still describes the Windows build.
 */
export function releaseManifest({ record, tag, artifacts, support, generatedAt }) {
  const mac = artifacts.find((entry) => entry.kind === 'macos-disk-image');
  return {
    schemaVersion: 2,
    product: record.product,
    releaseId: record.releaseId,
    tag,
    appVersion: record.appVersion,
    channel: record.channel,
    build: {
      commit: record.build.baseCommit,
      sourceStatus: record.build.sourceStatus,
      sourceDigest: record.build.sourceDigest,
      builtAt: record.build.builtAt,
      identityEmbeddedIn: record.build.identityEmbeddedIn,
    },
    // Read from the record, like the README's own line. A build whose record
    // names no tested Windows states that here too.
    platform: {
      os: 'Windows',
      architecture: 'x64',
      tested: testedOn(record) ?? NOT_RECORDED,
      otherVersions: 'unverified',
    },
    ...(mac ? { platforms: ['windows', 'macos'] } : { platforms: ['windows'] }),
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
    generatedAt,
    generatedBy: 'scripts/write-release-assets.mjs',
  };
}

/**
 * What the macOS launch smoke (scripts/packaged-launch-smoke.mjs) must say before
 * its disk image may be published: it passed, on darwin/arm64, for this version,
 * with no page error. Anything else is refused rather than published as weaker.
 */
export function macLaunchOutcome(proof, version) {
  if (!proof || typeof proof !== 'object') throw new Error('The macOS launch proof is not a JSON object.');
  if (proof.passed !== true) throw new Error(`The macOS launch proof did not pass${proof.error ? `: ${proof.error}` : '.'}`);
  if (proof.platform !== 'darwin' || proof.arch !== 'arm64')
    throw new Error(`The macOS launch proof ran on ${proof.platform}/${proof.arch}, not darwin/arm64.`);
  if (proof.appVersion !== version || proof.health?.version !== version)
    throw new Error(`The macOS launch proof is for version ${proof.health?.version ?? proof.appVersion}, not ${version}.`);
  if (!Array.isArray(proof.pageErrors) || proof.pageErrors.length)
    throw new Error('The macOS launch proof records page errors.');
  // The smoke runs the executable directly. A downloaded, quarantined copy is
  // judged by its bundle signature, and one that does not verify is refused as
  // damaged, so an image whose signature does not verify is never published.
  if (proof.signature?.bundleSignatureVerifies !== true)
    throw new Error(
      `The macOS app bundle's signature does not verify${proof.signature?.codesignVerify ? ` (${proof.signature.codesignVerify})` : ''}; macOS would refuse a downloaded copy.`,
    );
  return { result: 'passed', ranAt: proof.startedAt ?? null, checks: proof.checks?.length ?? 0 };
}

async function main() {
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
  const notesPath = path.resolve(need('notes'));
  const macDmgPath = args.get('mac-dmg') ? path.resolve(args.get('mac-dmg')) : null;
  const macProofPath = args.get('mac-proof') ? path.resolve(args.get('mac-proof')) : null;
  if (Boolean(macDmgPath) !== Boolean(macProofPath))
    throw new Error('--mac-dmg and --mac-proof go together: a disk image is published only beside the launch proof that passed on it.');
  const tagMatch = TAG.exec(tag);
  if (!tagMatch) throw new Error(`Tag ${tag} is not v<version>, v<version>-experimental.<n> or v<version>-rc.<n>.`);

  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  if (record.named !== true) throw new Error('The record is not a named candidate.');
  const version = record.appVersion;
  if (tagMatch[1] !== version) throw new Error(`Tag ${tag} does not carry the record's version ${version}.`);
  const capability = JSON.parse(await fs.readFile(path.join(root, CAPABILITY_RECORD), 'utf8'));
  const names = releaseAssetNames(version);

  // The bytes must be the tested bytes.
  const installerSha = await sha256(installerPath);
  if (installerSha !== record.installer.sha256)
    throw new Error(`Installer hash ${installerSha} differs from the record's ${record.installer.sha256}.`);
  if (path.basename(installerPath) !== record.installer.filename)
    throw new Error(`Installer is named ${path.basename(installerPath)}; the record names ${record.installer.filename}.`);
  const exeSha = await sha256(path.join(payloadDir, 'nectovia.exe'));
  if (exeSha !== record.package.executableSha256) throw new Error('Payload nectovia.exe differs from the record.');
  const asarSha = await sha256(path.join(payloadDir, 'resources', 'app.asar'));
  if (asarSha !== record.package.asarSha256) throw new Error('Payload app.asar differs from the record.');

  // The macOS image, when given, must be the one its launch proof drove.
  let mac = null;
  if (macDmgPath) {
    if (path.basename(macDmgPath) !== names.macDmg)
      throw new Error(`The disk image is named ${path.basename(macDmgPath)}; this release names it ${names.macDmg}.`);
    const proof = JSON.parse(await fs.readFile(macProofPath, 'utf8'));
    const outcome = macLaunchOutcome(proof, version);
    const dmgSha256 = await sha256(macDmgPath);
    if (proof.dmgSha256 !== dmgSha256)
      throw new Error(`The macOS launch proof drove a disk image hashing ${proof.dmgSha256 ?? 'nothing recorded'}, not ${dmgSha256}.`);
    if (proof.build?.baseCommit !== record.build.baseCommit)
      throw new Error(`The disk image was built from ${proof.build?.baseCommit ?? 'an unrecorded commit'}, not ${record.build.baseCommit}.`);
    mac = { dmgName: names.macDmg, testedOn: proof.testedOn ?? 'a hosted macOS runner', outcome, proof };
  }

  // Output directory: empty, or owned by a previous run of this script.
  await fs.mkdir(outDir, { recursive: true });
  const existing = await fs.readdir(outDir);
  const ownerFile = path.join(outDir, '.release-assets-owner.json');
  if (existing.length && !existing.includes('.release-assets-owner.json'))
    throw new Error(`${outDir} is not empty and was not written by this script.`);
  for (const entry of existing) await fs.rm(path.join(outDir, entry), { recursive: true, force: true });
  await fs.writeFile(ownerFile, JSON.stringify({ ownedBy: 'scripts/write-release-assets.mjs', releaseId: record.releaseId, tag }, null, 2) + '\n');

  const zipName = names.zip;
  const zipFolder = zipName.replace(/\.zip$/, '');
  const staging = path.join(outDir, zipFolder);
  await fs.cp(payloadDir, staging, { recursive: true });
  const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await run(tarExe, ['-a', '-c', '-f', zipName, zipFolder], { cwd: outDir });
  await fs.rm(staging, { recursive: true, force: true });

  const installerName = record.installer.filename;
  await fs.copyFile(installerPath, path.join(outDir, installerName));
  const launcherName = names.launcher;
  await fs.copyFile(path.join(root, 'scripts', 'release-support', launcherName), path.join(outDir, launcherName));
  if (mac) await fs.copyFile(macDmgPath, path.join(outDir, mac.dmgName));

  /**
   * Everything else in the README is derived from the two records. These closing
   * sections are the part only this build knows — what the update channel will do
   * with this release, and which engine routes were exercised live and on which
   * commit — so they are a required input rather than a constant in this file.
   * As a constant the text went stale and was corrected by hand after generation
   * twice, which is worse than stale: SHA256SUMS.txt below is computed from the
   * README this script writes, so a README edited afterwards no longer matches
   * the checksums published beside it.
   */
  const notes = (await fs.readFile(notesPath, 'utf8')).replace(/\r\n/g, '\n').trimEnd();
  if (!notes.trim()) throw new Error(`${notesPath} is empty; the build-specific notes are required.`);
  if (!/^[A-Z][A-Z ]+$/m.test(notes))
    throw new Error(`${notesPath} has no SECTION heading; it should continue the README's sections.`);

  const commit = record.build.baseCommit;
  const short = commit.slice(0, 7);
  const readme = releaseReadme({
    record,
    capability,
    tag,
    installerName,
    zipName,
    launcherName,
    notes,
    mac,
  });
  await fs.writeFile(path.join(outDir, names.readme), readme.replaceAll('\n', '\r\n'));

  // Each asset reports the record's state for the kind of file it is, rather
  // than the word "unsigned" every asset used to carry whatever was signed.
  const asset = async (filename, kind, signingKey) => {
    const file = path.join(outDir, filename);
    const stat = await fs.stat(file);
    return {
      kind,
      filename,
      bytes: stat.size,
      sha256: await sha256(file),
      ...assetSigning(record.signing, signingKey),
    };
  };
  const artifacts = [
    await asset(zipName, 'portable-zip', 'application'),
    await asset(installerName, 'per-user-installer', 'installer'),
  ];
  if (mac) {
    const file = path.join(outDir, mac.dmgName);
    artifacts.push({
      kind: 'macos-disk-image',
      filename: mac.dmgName,
      bytes: (await fs.stat(file)).size,
      sha256: await sha256(file),
      signing: MAC_SIGNING,
      publisher: null,
      platform: { os: 'macOS', architecture: 'arm64', tested: mac.testedOn },
      launchSmoke: mac.outcome.result,
    });
  }
  // A script this repository copies in; the record states nothing about it.
  const support = await asset(launcherName, 'optional-isolated-launcher', 'launcher');
  const manifest = releaseManifest({ record, tag, artifacts, support, generatedAt: new Date().toISOString() });
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  if (/[A-Za-z]:\\|\/f\/|\/c\/|\/Users\/|\/home\/|\/private\//i.test(manifestText))
    throw new Error('The public manifest contains a local path.');
  await fs.writeFile(path.join(outDir, names.manifest), manifestText);

  const sums = [];
  const published = [zipName, installerName, ...(mac ? [mac.dmgName] : []), launcherName, names.readme, names.manifest];
  for (const name of published) sums.push(`${await sha256(path.join(outDir, name))}  ${name}`);
  await fs.writeFile(path.join(outDir, names.sums), sums.join('\n') + '\n');

  console.log(JSON.stringify({ outDir, tag, releaseId: record.releaseId, commit: short, artifacts, support }, null, 2));
}

// Imported for its text builder, this file writes nothing and reads no argument.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
