import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { readNativeRuntimeManifest } from './package-desktop.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1]))
  throw new Error('Usage: collect-package-notices.mjs [--output <directory>]');
const licenseDir = args.length ? path.resolve(args[1]) : path.join(root, 'licenses');
const lockPath = path.join(root, 'package-lock.json');


const fontNotices = new Map([
  ['@fontsource/big-shoulders-display', 'big-shoulders-display.txt'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono.txt'],
  ['@fontsource/ibm-plex-serif', 'ibm-plex-serif.txt'],
  ['@fontsource/schibsted-grotesk', 'schibsted-grotesk.txt'],
]);

// Fonts copied into the client tree rather than imported from an npm package, so the
// production graph below never sees them. Their license travels as a file of its own.
const vendoredFonts = [
  {
    source: 'client/fonts/instrument-serif/OFL.txt',
    output: 'instrument-serif.txt',
    note: 'Instrument Serif italic, woff2 files from `@fontsource/instrument-serif` 5.3.0 vendored in `client/fonts/`',
  },
];


function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
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

async function ensureCodexFiles(version) {
  const provenance = [];
  for (const name of ['LICENSE', 'NOTICE']) {
    const file = {
      output: 'codex-' + name + '.txt',
      url: 'https://raw.githubusercontent.com/openai/codex/rust-v' + version + '/' + name,
    };
    // These generated files describe the selected package snapshot. A missing
    // upstream tag fails instead of substituting another version's notices.
    const downloaded = await curl(file.url);
    if (downloaded.length > 2_000_000) throw new Error('Codex notice exceeded its size limit.');
    await fs.writeFile(path.join(licenseDir, file.output), downloaded);
    provenance.push({ ...file, sha256: sha256(downloaded), bytes: downloaded.length });
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

const selectedRuntime = await readNativeRuntimeManifest(root);
const codexProvenance = await ensureCodexFiles(selectedRuntime.version);
const nativeRuntime = [];
const vendoredFontProvenance = [];
for (const font of vendoredFonts) {
  const bytes = await fs.readFile(path.join(root, font.source));
  await fs.writeFile(path.join(licenseDir, font.output), bytes);
  vendoredFontProvenance.push({ ...font, bytes: bytes.length, sha256: sha256(bytes) });
}
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

for (const [name, expected] of Object.entries(selectedRuntime.hashes)) {
  const runtimePath = path.join(root, '.data', 'native-runtime', name);
  const actual = await sha256File(runtimePath);
  if (actual !== expected) throw new Error('Native runtime changed after preparation: ' + name);
  nativeRuntime.push({ name, bytes: (await fs.stat(runtimePath)).size, sha256: actual });
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

The Diomedes source tree carries a proprietary all-rights-reserved notice in the repository root \`LICENSE\`. The exact root license text follows so the packaged \`licenses\` directory carries it:

----- BEGIN DIOMEDES LICENSE -----
${rootLicense}
----- END DIOMEDES LICENSE -----

## Bundled fonts

The existing font-specific notices remain separate and were not rewritten:

${markdownList([...fontNotices.values()].map((name) => `\`${name}\``))}

Their matching \`@fontsource\` package code is also represented in the package notice groups below.

Vendored font files, which no npm package in the production graph supplies, carry their license as a copied file:

${markdownList(vendoredFontProvenance.map((font) => `\`${font.output}\`: ${font.note}; copied from \`${font.source}\`, ${font.bytes} bytes, SHA-256 \`${font.sha256}\``))}

## OpenAI Codex native runtime

Diomedes packages the runtime snapshot recorded by preparation: Codex \`${selectedRuntime.version}\`. Installed engines are discovered independently at connection time; this record does not restrict their versions. The upstream tag files downloaded for this snapshot are:

${markdownList(codexProvenance.map((file) => `\`${file.output}\`: ${file.url}, ${file.bytes} bytes, SHA-256 \`${file.sha256}\``))}

The package's executable bytes were verified against its preparation manifest:

${markdownList(nativeRuntime.map((runtime) => `\`${runtime.name}\`: ${runtime.bytes} bytes, SHA-256 \`${runtime.sha256}\``))}

These hashes identify the packaged files. A copy from an installed desktop build does not itself establish equivalence with a GitHub release asset. Retain the preparation manifest and any upstream artifact digests with the package; the matching upstream LICENSE and NOTICE alone do not establish a complete Rust/vendor notice chain.

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

// Publish the binding only after every generated file is complete. Packaging
// verifies this receipt again against the actual license files in its stage.
const noticeHashes = {};
for (const name of ['codex-LICENSE.txt', 'codex-NOTICE.txt', 'THIRD_PARTY_NOTICES.md', 'DEPENDENCIES.txt'])
  noticeHashes[name] = await sha256File(path.join(licenseDir, name));
if (JSON.stringify(await readNativeRuntimeManifest(root)) !== JSON.stringify(selectedRuntime))
  throw new Error('Native runtime snapshot changed while collecting notices.');
await fs.writeFile(path.join(licenseDir, 'NATIVE_RUNTIME.json'), JSON.stringify({
  ...selectedRuntime, notices: noticeHashes,
}, null, 2) + '\n');

console.log(`Production package paths: ${dependencyRows.length}`);
console.log(`Collected unique license/notice texts: ${noticeGroups.length}`);
console.log(`Missing top-level license texts: ${missingLicenseText.length}`);
console.log(`package-lock SHA-256: ${sha256(lockBytes)}`);
console.log(`Codex ${selectedRuntime.version} LICENSE/NOTICE provenance recorded`);
