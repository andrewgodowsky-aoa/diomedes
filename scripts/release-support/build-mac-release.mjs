// Build the Apple silicon disk image and its release proof on a Mac, with the steps of the
// release workflow's `macos` job (.github/workflows/release.yml), from the commit checked out:
//
//   node scripts/release-support/build-mac-release.mjs --commit <40-character sha>
//
// --commit is the commit the Windows installer is built from. write-release-assets.mjs
// publishes a disk image only beside a proof whose build commit is the Windows record's, so
// this refuses a checkout at any other commit or with local changes. It writes, here:
//
//   release/Diomedes-Experimental-<version>-mac-arm64.dmg
//   release/mac-release-proof.json
//   test-results/mac/   the signature facts and the launch smoke's own proof
//
// Apple silicon and a native arm64 Node 22 only. The bundle gets the ad-hoc whole-bundle
// signature Andrew chose on 2026-09-25 (O43 option a in
// docs/implementation/2026-09-25-release-pipeline.md): no Developer ID, not notarized.
// The proof says it ran on this Mac (`hostedRunner: false`) and names the Mac, so the release
// README says where the launch was checked. The workflow job stays the same steps; change both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The bundle signature, in the words the workflow's proof uses. */
export const BUNDLE_SIGNATURE =
  'ad-hoc (codesign --force --deep --sign -), decided by Andrew on 2026-09-25; no Developer ID, not notarized';

/** Refuses any host but Apple silicon running a native arm64 Node 22. */
export function checkHost({ platform, arch, machine, nodeVersion }) {
  if (platform !== 'darwin' || arch !== 'arm64' || machine !== 'arm64')
    throw new Error(
      `This builds the Apple silicon image and runs only on an Apple silicon Mac with a native arm64 Node, not ${platform}/${arch} on ${machine}.`,
    );
  if (!/^v22\./.test(nodeVersion)) throw new Error(`Releases are built with Node 22; this is ${nodeVersion}.`);
}

/** The model name and chip from `system_profiler SPHardwareDataType`. */
export function parseHardware(text) {
  const field = (name) => new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm').exec(text)?.[1] ?? null;
  return { modelName: field('Model Name'), chip: field('Chip') };
}

/** Where the launch was checked, as the README and the manifest print it. */
export function machineDescription({ modelName, chip, productVersion }) {
  return `a ${modelName ?? 'Mac'}${chip ? ` (${chip})` : ''} with macOS ${productVersion}`;
}

/**
 * The signature facts the workflow records, read from codesign's and spctl's own output. Every
 * line loses the app's folder, where the workflow strips the first line only: on a person's Mac
 * that folder is under their home directory.
 */
export function signatureFacts({ verifyStatus, assessStatus, display, verify, spctl }) {
  return {
    bundleSignatureVerifies: verifyStatus === 0,
    gatekeeperAccepts: assessStatus === 0,
    codesignDisplay: display.trim().replace(/^Executable=.*\n/gm, ''),
    codesignVerify: verify.trim().replace(/^[^:]*Diomedes\.app: /gm, 'Diomedes.app: '),
    spctl: spctl.trim().replace(/^[^:]*Diomedes\.app: /gm, 'Diomedes.app: '),
  };
}

/** The release proof: the workflow's "Release proof for the disk image" step, plus `hostedRunner`. */
export function macReleaseProof({ launch, buildInfo, signature, dmgName, dmgBytes, dmgSha256, testedOn }) {
  return {
    ...launch,
    dmg: dmgName,
    dmgBytes,
    dmgSha256,
    build: {
      baseCommit: buildInfo.baseCommit,
      sourceStatus: buildInfo.sourceStatus,
      sourceDigest: buildInfo.sourceDigest,
      electronVersion: buildInfo.electronVersion,
      macFrameworkSignature: buildInfo.macFrameworkSignature ?? null,
    },
    testedOn,
    hostedRunner: false,
    signature,
    bundleSignature: BUNDLE_SIGNATURE,
  };
}

const run = (command, args, options = {}) => {
  console.log(`\n> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
};
const read = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
const capture = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return { status: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : undefined;
  if (!/^[0-9a-f]{40}$/.test(commit ?? ''))
    throw new Error('--commit <40-character sha> is required: the commit the Windows installer is built from.');
  checkHost({ platform: process.platform, arch: process.arch, machine: os.machine(), nodeVersion: process.version });
  const head = read('git', ['rev-parse', 'HEAD']);
  if (head !== commit) throw new Error(`This checkout is at ${head}, not ${commit}. Run: git checkout --detach ${commit}`);
  const changed = read('git', ['status', '--porcelain', '--untracked-files=no']);
  if (changed) throw new Error(`This checkout has local changes:\n${changed}`);

  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  // macOS /var is a symbolic link, and the product's path guard refuses linked ancestors.
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nectovia-mac-release-'));
  const tmp = path.join(work, 'tmp');
  fs.mkdirSync(tmp);
  const zips = path.join(work, 'electron-zips');
  const app = path.join(root, 'release', 'Diomedes-darwin-arm64', 'Diomedes.app');
  const dmgName = `Diomedes-Experimental-${version}-mac-arm64.dmg`;
  const dmg = path.join(root, 'release', dmgName);
  const proofPath = path.join(root, 'release', 'mac-release-proof.json');
  const results = path.join(root, 'test-results', 'mac');
  for (const stale of [dmg, proofPath, results]) fs.rmSync(stale, { recursive: true, force: true });

  run('npm', ['ci']);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(root, 'services', 'control-plane') });
  run(process.execPath, ['scripts/release-support/acquire-electron-archive.mjs', '--platform', 'darwin', '--arch', 'arm64', '--dir', zips]);
  run('npm', ['run', 'package:mac'], {
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=4096',
      DIOMEDES_ELECTRON_ZIP_DIR: zips,
      DIOMEDES_MAC_ADHOC_FRAMEWORK_RESIGN: 'accept',
    },
  });

  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

  const stage = path.join(work, 'dmg-stage');
  fs.mkdirSync(stage);
  run('ditto', [app, path.join(stage, 'Diomedes.app')]);
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  run('hdiutil', ['create', '-volname', `Nectovia ${version}`, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
  run('hdiutil', ['verify', dmg]);

  fs.mkdirSync(results, { recursive: true });
  const display = capture('codesign', ['-dv', '--verbose=2', app]);
  const verify = capture('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const assess = capture('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  fs.writeFileSync(path.join(results, 'codesign-display.txt'), display.text);
  fs.writeFileSync(path.join(results, 'codesign-verify.txt'), verify.text);
  fs.writeFileSync(path.join(results, 'spctl.txt'), assess.text);
  const signature = signatureFacts({
    verifyStatus: verify.status,
    assessStatus: assess.status,
    display: display.text,
    verify: verify.text,
    spctl: assess.text,
  });
  fs.writeFileSync(path.join(results, 'signature.json'), JSON.stringify(signature, null, 2) + '\n');

  // The smoke runs the app from the mounted, read-only image, as the workflow does.
  const mount = path.join(work, 'dmg-mount');
  fs.mkdirSync(mount);
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  let smoke;
  try {
    console.log('\n> node scripts/packaged-launch-smoke.mjs (from the mounted image)');
    smoke = spawnSync(
      process.execPath,
      ['scripts/packaged-launch-smoke.mjs', path.join(mount, 'Diomedes.app', 'Contents', 'MacOS', 'Diomedes'), path.join(results, 'launch')],
      { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmp } },
    );
  } finally {
    if (spawnSync('hdiutil', ['detach', mount], { stdio: 'inherit' }).status !== 0)
      spawnSync('hdiutil', ['detach', '-force', mount], { stdio: 'inherit' });
  }
  if (smoke.status !== 0) throw new Error(`The launch smoke failed; its proof is ${path.join(results, 'launch', 'proof.json')}.`);

  const launch = JSON.parse(fs.readFileSync(path.join(results, 'launch', 'proof.json'), 'utf8'));
  const buildInfo = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'macos-release', 'build-info.json'), 'utf8'));
  const testedOn = machineDescription({
    ...parseHardware(capture('system_profiler', ['SPHardwareDataType']).text),
    productVersion: read('sw_vers', ['-productVersion']),
  });
  const dmgBytes = fs.statSync(dmg).size;
  const dmgSha256 = createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
  const proof = macReleaseProof({ launch, buildInfo, signature, dmgName, dmgBytes, dmgSha256, testedOn });
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');

  // The check write-release-assets.mjs makes before it will publish the image.
  const { macLaunchOutcome } = await import(pathToFileURL(path.join(root, 'scripts', 'write-release-assets.mjs')).href);
  let refusal = null;
  try {
    macLaunchOutcome(proof, version);
  } catch (error) {
    refusal = error.message;
  }
  if (!refusal && proof.build.baseCommit !== commit) refusal = `The build records commit ${proof.build.baseCommit}, not ${commit}.`;
  if (!refusal && proof.build.sourceStatus !== 'committed') refusal = `The build records its source as ${proof.build.sourceStatus}.`;
  console.log(
    [
      '',
      `Disk image: ${dmg}`,
      `Bytes:      ${dmgBytes.toLocaleString('en-US')}`,
      `SHA-256:    ${dmgSha256}`,
      `Proof:      ${proofPath}`,
      `Tested on:  ${testedOn}`,
      `Launch smoke ${proof.passed ? 'passed' : 'FAILED'} (${proof.checks?.length ?? 0} checks); bundle signature ${signature.bundleSignatureVerifies ? 'verifies' : 'DOES NOT VERIFY'}.`,
      refusal ? `NOT PUBLISHABLE: ${refusal}` : 'Publishable: copy the disk image and the proof to the Windows release machine.',
    ].join('\n'),
  );
  if (refusal) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
