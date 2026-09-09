import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const licenseDir = path.join(root, 'licenses');
const lockPath = path.join(root, 'package-lock.json');

const codexFiles = [
  {
    output: 'codex-LICENSE.txt',
    url: 'https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/LICENSE',
    sha256: 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc',
  },
  {
    output: 'codex-NOTICE.txt',
    url: 'https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/NOTICE',
    sha256: '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915',
  },
];

const fontNotices = new Map([
  ['@fontsource/big-shoulders-display', 'big-shoulders-display.txt'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono.txt'],
  ['@fontsource/ibm-plex-serif', 'ibm-plex-serif.txt'],
  ['@fontsource/schibsted-grotesk', 'schibsted-grotesk.txt'],
]);

const nativeRuntime = [
  {
    name: 'codex.exe',
    bytes: 295408944,
    localSha256: 'a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6',
    releaseAsset: 'codex-x86_64-pc-windows-msvc.exe',
    releaseAssetBytes: 295408944,
    releaseAssetSha256: '444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b',
  },
  {
    name: 'codex-command-runner.exe',
    bytes: 8204592,
    localSha256: '08b56828cca57c83d14f03eb9ec62c73a2cd6648248cc731ae8fedd5fa3ae566',
    releaseAsset: 'codex-command-runner-x86_64-pc-windows-msvc.exe',
    releaseAssetBytes: 8204592,
    releaseAssetSha256: '3eb267dc1f0d1d80efeacc26a211f26ed0f414466d32a2aa7304a8a0beec170c',
  },
  {
    name: 'codex-windows-sandbox-setup.exe',
    bytes: 15413040,
    localSha256: '682cf7b351a871f3479b78fe3b7ea7348554de655bd98b0f322cef2d006a8d62',
    releaseAsset: 'codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe',
    releaseAssetBytes: 15413040,
    releaseAssetSha256: '0c3eeb7cee8d2bc4c8644def3c818e8b06760979572dcedc919c38d0f38f64c4',
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function curl(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'curl.exe',
      ['--silent', '--show-error', '--fail', '--location', '--retry', '3', url],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`curl.exe exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function ensurePinnedCodexFiles() {
  const provenance = [];
  for (const file of codexFiles) {
    const downloaded = await curl(file.url);
    const downloadedHash = sha256(downloaded);
    if (downloadedHash !== file.sha256) {
      throw new Error(
        `Pinned ${file.output} hash mismatch: expected ${file.sha256}, received ${downloadedHash}.`,
      );
    }
    const outputPath = path.join(licenseDir, file.output);
    if (await exists(outputPath)) {
      const existingHash = await sha256File(outputPath);
      if (existingHash !== file.sha256) {
        throw new Error(`Refusing to overwrite modified notice file: ${outputPath}`);
      }
    } else {
      await fs.writeFile(outputPath, downloaded);
    }
    provenance.push({ ...file, bytes: downloaded.length });
  }
  return provenance;
}

function packageNameFromLockPath(lockPackagePath) {
  const parts = lockPackagePath.split('node_modules/').at(-1).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function resolveLockedDependency(packages, fromPath, dependencyName) {
  let current = fromPath;
  while (true) {
    const candidate = `${current ? `${current}/` : ''}node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!current) return null;
    const nestedIndex = current.lastIndexOf('/node_modules/');
    current = nestedIndex >= 0 ? current.slice(0, nestedIndex) : '';
  }
}

async function productionGraph(lock) {
  const packages = lock.packages;
  const queue = Object.keys(packages[''].dependencies ?? {}).map((name) => ({
    fromPath: '',
    name,
    optional: false,
  }));
  const visited = new Set();
  const nodes = [];
  const skippedOptional = [];

  while (queue.length > 0) {
    const edge = queue.shift();
    const lockPackagePath = resolveLockedDependency(packages, edge.fromPath, edge.name);
    if (!lockPackagePath) {
      if (edge.optional) {
        skippedOptional.push(`${edge.name} from ${edge.fromPath || '<root>'}`);
        continue;
      }
      throw new Error(
        `package-lock cannot resolve ${edge.name} from ${edge.fromPath || '<root>'}.`,
      );
    }
    if (visited.has(lockPackagePath)) continue;

    const record = packages[lockPackagePath];
    const installedPackagePath = path.join(root, ...lockPackagePath.split('/'));
    const installedManifestPath = path.join(installedPackagePath, 'package.json');
    if (!(await exists(installedManifestPath))) {
      if (edge.optional) {
        skippedOptional.push(lockPackagePath);
        continue;
      }
      throw new Error(`Locked production package is not installed: ${lockPackagePath}`);
    }
    const installed = JSON.parse(await fs.readFile(installedManifestPath, 'utf8'));
    const expectedName = record.name ?? packageNameFromLockPath(lockPackagePath);
    if (installed.name !== expectedName || installed.version !== record.version) {
      throw new Error(
        `Installed package drift at ${lockPackagePath}: lock has ${expectedName}@${record.version}, ` +
          `installed has ${installed.name}@${installed.version}.`,
      );
    }

    visited.add(lockPackagePath);
    nodes.push({ lockPackagePath, installedPackagePath, record, installed });

    for (const name of Object.keys(record.dependencies ?? {})) {
      queue.push({ fromPath: lockPackagePath, name, optional: false });
    }
    for (const name of Object.keys(record.optionalDependencies ?? {})) {
      queue.push({ fromPath: lockPackagePath, name, optional: true });
    }
    for (const name of Object.keys(record.peerDependencies ?? {})) {
      const optional = record.peerDependenciesMeta?.[name]?.optional === true;
      queue.push({ fromPath: lockPackagePath, name, optional });
    }
  }

  nodes.sort(
    (a, b) =>
      a.installed.name.localeCompare(b.installed.name, 'en') ||
      a.installed.version.localeCompare(b.installed.version, 'en') ||
      a.lockPackagePath.localeCompare(b.lockPackagePath, 'en'),
  );
  skippedOptional.sort((a, b) => a.localeCompare(b, 'en'));
  return { nodes, skippedOptional };
}

async function packageNotices(node) {
  const entries = await fs.readdir(node.installedPackagePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^(license|licence|copying|notice)(?:[._-].*)?$/i.test(entry.name)) {
      continue;
    }
    const bytes = await fs.readFile(path.join(node.installedPackagePath, entry.name));
    files.push({
      name: entry.name,
      kind: /^notice(?:[._-].*)?$/i.test(entry.name) ? 'notice' : 'license',
      sha256: sha256(bytes),
      text: bytes.toString('utf8').replaceAll('\r\n', '\n').trimEnd(),
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return files;
}

function licenseMetadata(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(licenseMetadata).join(' OR ');
  if (value && typeof value === 'object') return value.type ?? JSON.stringify(value);
  return 'UNDECLARED';
}

function repositoryUrl(value) {
  if (typeof value === 'string') return value;
  return value?.url ?? '';
}

function markdownList(values) {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : '- None';
}

await fs.mkdir(licenseDir, { recursive: true });
const packageManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const lockBytes = await fs.readFile(lockPath);
const lock = JSON.parse(lockBytes.toString('utf8'));
if (lock.lockfileVersion !== 3)
  throw new Error(`Unsupported package-lock version ${lock.lockfileVersion}.`);
if (lock.packages['']?.version !== packageManifest.version) {
  throw new Error(
    `package.json version ${packageManifest.version} does not match package-lock root ${lock.packages['']?.version}.`,
  );
}

const codexProvenance = await ensurePinnedCodexFiles();
const graph = await productionGraph(lock);
const groups = new Map();
const dependencyRows = [];
const missingLicenseText = [];

for (const node of graph.nodes) {
  const notices = await packageNotices(node);
  const packageId = `${node.installed.name}@${node.installed.version}`;
  if (notices.every((notice) => notice.kind !== 'license')) missingLicenseText.push(packageId);
  for (const notice of notices) {
    const key = `${notice.kind}:${notice.sha256}`;
    const group = groups.get(key) ?? { ...notice, packages: [], sources: [] };
    group.packages.push(packageId);
    group.sources.push(`${node.lockPackagePath}/${notice.name}`);
    groups.set(key, group);
  }
  dependencyRows.push({
    packageId,
    lockPackagePath: node.lockPackagePath,
    license: licenseMetadata(node.installed.license ?? node.record.license),
    resolved:
      node.record.resolved ||
      repositoryUrl(node.installed.repository) ||
      node.installed.homepage ||
      '',
    integrity: node.record.integrity ?? 'not recorded',
    notices: notices.map((notice) => `${notice.name}:${notice.sha256}`),
    fontNotice: fontNotices.get(node.installed.name),
  });
}

for (const runtime of nativeRuntime) {
  const runtimePath = path.join(root, '.data', 'native-runtime', runtime.name);
  const actual = await sha256File(runtimePath);
  if (actual !== runtime.localSha256) {
    throw new Error(
      `Native runtime hash drift for ${runtime.name}: expected ${runtime.localSha256}, got ${actual}.`,
    );
  }
  const runtimeStat = await fs.stat(runtimePath);
  if (runtimeStat.size !== runtime.bytes) {
    throw new Error(
      `Native runtime size drift for ${runtime.name}: expected ${runtime.bytes}, got ${runtimeStat.size}.`,
    );
  }
}

const electronManifest = JSON.parse(
  await fs.readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
);
const electronNpmLicensePath = path.join(root, 'node_modules', 'electron', 'LICENSE');
const electronNpmLicense = {
  version: electronManifest.version,
  bytes: (await fs.stat(electronNpmLicensePath)).size,
  sha256: await sha256File(electronNpmLicensePath),
};

const dependencyText = [
  'DIOMEDES BUNDLED PRODUCTION DEPENDENCIES',
  '========================================',
  '',
  `Application version: ${packageManifest.version}`,
  `package-lock.json SHA-256: ${sha256(lockBytes)}`,
  `Reachable installed production package paths: ${dependencyRows.length}`,
  '',
  'Scope: every installed package reachable through dependencies, optional dependencies,',
  'and required installed peer dependencies from the package-lock root. This conservative',
  'inventory can include code removed by Vite or esbuild tree shaking.',
  '',
  ...dependencyRows.flatMap((row) => [
    `${row.packageId}`,
    `  lock path: ${row.lockPackagePath}`,
    `  declared license: ${row.license}`,
    `  source: ${row.resolved || 'not declared'}`,
    `  package-lock integrity: ${row.integrity}`,
    `  notice files: ${row.notices.join(', ') || 'MISSING'}`,
    ...(row.fontNotice ? [`  bundled font notice: ${row.fontNotice}`] : []),
    '',
  ]),
  'Skipped absent optional dependency edges:',
  ...graph.skippedOptional.map((value) => `  ${value}`),
  ...(graph.skippedOptional.length === 0 ? ['  None'] : []),
  '',
].join('\n');

const noticeGroups = [...groups.values()].sort(
  (a, b) => a.kind.localeCompare(b.kind, 'en') || a.sha256.localeCompare(b.sha256, 'en'),
);
const rootLicense = (await fs.readFile(path.join(root, 'LICENSE'), 'utf8'))
  .replaceAll('\r\n', '\n')
  .trimEnd();
const thirdPartyText = `# Diomedes license and third-party notices

Generated by \`${path.relative(root, fileURLToPath(import.meta.url)).replaceAll('\\', '/')}\` from package-lock SHA-256 \`${sha256(lockBytes)}\` and the installed production dependency graph. This is a mechanical inventory, not legal advice.

## Diomedes application license

The Diomedes source tree declares Apache License 2.0 in the repository root. The exact root license text follows so the packaged \`licenses\` directory carries it:

----- BEGIN DIOMEDES LICENSE -----
${rootLicense}
----- END DIOMEDES LICENSE -----

## Bundled fonts

The existing font-specific notices remain separate and were not rewritten:

${markdownList([...fontNotices.values()].map((name) => `\`${name}\``))}

Their matching \`@fontsource\` package code is also represented in the package notice groups below.

## OpenAI Codex native runtime

Diomedes currently packages three locally pinned native executables. \`codex.exe --version\` was separately observed as \`codex-cli 0.153.4\`. The exact upstream tag files downloaded by this collector are:

${markdownList(codexProvenance.map((file) => `\`${file.output}\`: ${file.url}, ${file.bytes} bytes, SHA-256 \`${file.sha256}\``))}

The official \`rust-v0.153.4\` release workflow documents that the Windows Codex package contains \`codex-command-runner.exe\` and \`codex-windows-sandbox-setup.exe\` alongside the main binary. However, the three local hashes do **not** match the corresponding raw GitHub release-asset hashes observed through \`https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4\` on September 9, 2026:

${markdownList(
  nativeRuntime.map(
    (runtime) =>
      `\`${runtime.name}\`: local ${runtime.bytes} bytes, \`${runtime.localSha256}\`; official asset \`${runtime.releaseAsset}\`, ${runtime.releaseAssetBytes} bytes, \`${runtime.releaseAssetSha256}\``,
  ),
)}

Matching names, sizes, and reported version do not prove identical provenance. Signing or another distribution transformation could explain different bytes, but that has not been established. The upstream root LICENSE and NOTICE are included; an exact source-artifact chain and any generated Rust/vendor notices for these local bytes remain a public-redistribution gap.

## Electron and Chromium

Installed Electron \`${electronNpmLicense.version}\` is a packaging/runtime dependency rather than part of the production npm graph below. Its npm-package \`LICENSE\` is ${electronNpmLicense.bytes} bytes with SHA-256 \`${electronNpmLicense.sha256}\`.

The Electron runtime distribution supplies its own \`LICENSE\` and \`LICENSES.chromium.html\` beside the packaged executable. Those packager-produced files remain the authoritative Electron/Chromium notice payload and must be retained; this collector does not duplicate or replace them. The shared \`node_modules/electron\` currently has no downloaded \`dist\` directory, so the Chromium notice cannot be hashed until the packaging step materializes the Electron runtime. Its presence and hashes are a package-output verification item.

## Production npm dependency inventory

The full machine-readable-style inventory is in \`DEPENDENCIES.txt\`. Packages without a discovered top-level license text are listed here as an evidence gap even when package metadata declares a license expression:

${markdownList(missingLicenseText.map((name) => `\`${name}\``))}

## Collected package license and notice texts

${noticeGroups
  .map(
    (group) => `### ${group.kind === 'notice' ? 'Notice' : 'License'} text \`${group.sha256}\`

Packages:

${markdownList([...new Set(group.packages)].sort().map((name) => `\`${name}\``))}

Installed sources:

${markdownList([...new Set(group.sources)].sort().map((name) => `\`${name}\``))}

----- BEGIN ${group.kind.toUpperCase()} TEXT -----
${group.text}
----- END ${group.kind.toUpperCase()} TEXT -----`,
  )
  .join('\n\n')}
`;

await fs.writeFile(path.join(licenseDir, 'DEPENDENCIES.txt'), `${dependencyText}\n`, 'utf8');
await fs.writeFile(path.join(licenseDir, 'THIRD_PARTY_NOTICES.md'), `${thirdPartyText}\n`, 'utf8');

console.log(`Production package paths: ${dependencyRows.length}`);
console.log(`Collected unique license/notice texts: ${noticeGroups.length}`);
console.log(`Missing top-level license texts: ${missingLicenseText.length}`);
console.log(`package-lock SHA-256: ${sha256(lockBytes)}`);
console.log('Codex LICENSE/NOTICE pins: verified');
