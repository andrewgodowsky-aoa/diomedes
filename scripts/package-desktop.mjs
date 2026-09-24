import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildDesktopAuth } from './build-desktop-auth.mjs';

// Export the same entry point for offline packaging-boundary tests. Invoking
// this script runs it once for the host target, unless `--platform`/`--arch`
// or DIOMEDES_DESKTOP_PLATFORM/ARCH name another supported one.
export async function packageDesktop(options = {}, dependencies = {}) {
  const root = options.root ?? fileURLToPath(new URL('../', import.meta.url));
  const bundle = dependencies.build ?? build;
  const packageApp = dependencies.packager ?? packager;
  const git = dependencies.git ?? execFileSync;
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const hostPlatform = options.hostPlatform ?? process.platform;
  const platform = options.platform ?? process.env.DIOMEDES_DESKTOP_PLATFORM ?? hostPlatform;
  const arch =
    options.arch ??
    process.env.DIOMEDES_DESKTOP_ARCH ??
    (platform === hostPlatform
      ? (options.hostArch ?? process.arch)
      : platform === 'darwin'
        ? 'arm64'
        : 'x64');
  if (!((platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64')))
    throw new Error(
      `Unsupported desktop target: ${platform}/${arch}. Use win32/x64 or darwin/arm64.`,
    );
  const electronVersion = JSON.parse(
    await fs.readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8'),
  ).version;
  const electronZipDir = options.electronZipDir ?? process.env.DIOMEDES_ELECTRON_ZIP_DIR;
  const archiveName = `electron-v${electronVersion}-${platform}-${arch}.zip`;
  // This new target must never silently fetch a platform artifact. An operator
  // supplies an already available Electron archive; Windows keeps its old default.
  if (platform === 'darwin' || electronZipDir) {
    const archive = electronZipDir && path.join(electronZipDir, archiveName);
    if (
      !archive ||
      !(
        await fs.stat(archive).catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        })
      )?.isFile()
    )
      throw new Error(
        `Missing offline Electron archive ${archiveName}. Set DIOMEDES_ELECTRON_ZIP_DIR to its existing directory; nothing was downloaded.`,
      );
  }
  if (
    platform === 'darwin' &&
    hostPlatform === 'darwin' &&
    Number(electronVersion.split('.')[0]) >= 41
  )
    throw new Error(
      "macOS packaging is blocked pending review of the installed packager's automatic ad-hoc Framework signing for ASAR integrity. This work order authorizes no signing; do not disable integrity. Installed-engine discovery is unaffected.",
    );
  async function sourceSnapshot() {
    const files = [];
    async function visit(relative) {
      for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile())
          files.push({ path: child, sha256: sha256(await fs.readFile(path.join(root, child))) });
        else throw new Error(`Unexpected source link: ${child}`);
      }
    }
    for (const directory of [
      'client',
      'server',
      'shared',
      'desktop',
      'fixtures',
      'licenses',
      'resources',
      'dist',
    ])
      await visit(directory);
    for (const name of [
      'package.json',
      'package-lock.json',
      'LICENSE',
      'scripts/package-desktop.mjs',
      'scripts/build-desktop-auth.mjs',
    ])
      files.push({ path: name, sha256: sha256(await fs.readFile(path.join(root, name))) });
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  const source = await sourceSnapshot();
  const sourceDigest = sha256(JSON.stringify(source));
  const baseCommit = git('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  // `sourceStatus` used to be the literal 'local-uncommitted', which stayed wrong once the
  // source was committed: a build stamped with a real commit still claimed it could not be
  // reproduced from one. Ask git instead, over the tracked inputs only -- `dist` and
  // `fixtures/projects` are gitignored build/test output and can never be committed, so
  // including them would pin the answer to 'local-uncommitted' forever.
  const trackedInputs = [
    'client',
    'server',
    'shared',
    'desktop',
    'licenses',
    'resources',
    'package.json',
    'package-lock.json',
    'LICENSE',
    'scripts/package-desktop.mjs',
    'scripts/build-desktop-auth.mjs',
  ];
  const dirty = git(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', ...trackedInputs],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ).trim();
  const sourceStatus = dirty ? 'local-uncommitted' : 'committed';
  // Each build gets an isolated staging folder; never copy app data or credentials.
  const stage = await fs.mkdtemp(path.join(root, '.desktop-stage-'));
  try {
    await fs.mkdir(path.join(stage, 'server'));
    await fs.mkdir(path.join(stage, 'fixtures/harness'), { recursive: true });
    await fs.copyFile(
      path.join(root, 'fixtures/harness/report-lines.txt'),
      path.join(stage, 'fixtures/harness/report-lines.txt'),
    );
    await fs.copyFile(path.join(root, 'desktop/main.mjs'), path.join(stage, 'main.mjs'));
    await buildDesktopAuth(root, stage);
    for (const helper of ['app-updates.mjs', 'update-helper.mjs', 'fresh-start.mjs'])
      await fs.copyFile(path.join(root, 'desktop', helper), path.join(stage, helper));
    await fs.cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
    await fs.cp(path.join(root, 'licenses'), path.join(stage, 'licenses'), { recursive: true });
    await fs.cp(path.join(root, 'resources'), path.join(stage, 'resources'), { recursive: true });
    await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
    await fs.writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify({
        name: 'diomedes',
        productName: 'Diomedes',
        version: manifest.version,
        type: 'module',
        main: 'main.mjs',
      }),
    );
    const runtime = path.join(stage, 'native-runtime');
    await fs.mkdir(runtime);
    const hashes =
      platform === 'win32'
        ? {
            'codex.exe': 'a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6',
            'codex-command-runner.exe':
              '08b56828cca57c83d14f03eb9ec62c73a2cd6648248cc731ae8fedd5fa3ae566',
            'codex-windows-sandbox-setup.exe':
              '682cf7b351a871f3479b78fe3b7ea7348554de655bd98b0f322cef2d006a8d62',
          }
        : {};
    for (const [name, expected] of Object.entries(hashes)) {
      const bytes = await fs.readFile(path.join(root, '.data/native-runtime', name));
      if (createHash('sha256').update(bytes).digest('hex') !== expected)
        throw new Error(`Native runtime hash mismatch: ${name}. Run prepare-native first.`);
      await fs.writeFile(path.join(runtime, name), bytes);
    }
    await bundle({
      entryPoints: [path.join(root, 'desktop/service.ts')],
      outfile: path.join(stage, 'server/app.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      define: { DIOMEDES_BUNDLED: 'true' },
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    if (sha256(JSON.stringify(await sourceSnapshot())) !== sourceDigest)
      throw new Error('Build inputs changed while packaging; repeat from a stable snapshot.');
    const buildInfo = {
      schemaVersion: 1,
      version: manifest.version,
      baseCommit,
      sourceStatus,
      sourceDigest,
      source,
      target: { platform, arch },
      electronVersion,
      nativeRuntime:
        platform === 'win32'
          ? { version: '0.153.4', sha256: hashes }
          : {
              bundled: false,
              sha256: hashes,
              expectedOnMachine: ['codex', 'claude', 'opencode', 'omp', 'agent', 'devin', 'ollama'],
              detail:
                'No reviewed macOS Codex runtime is bundled. Installed tools are discovered on that Mac; version, account and isolation checks still gate execution. Native Codex isolation remains Windows-only.',
            },
      signing: 'unsigned-experimental',
      builtAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(stage, 'BUILD_INFO.json'), JSON.stringify(buildInfo, null, 2));
    // The packager only warns about a missing icon and ships Electron's instead; fail here.
    const icon = platform === 'win32' ? path.join(root, 'desktop/diomedes.ico') : undefined;
    if (icon) await fs.access(icon);
    const outputs = await packageApp({
      dir: stage,
      out: path.join(root, 'release'),
      name: 'Diomedes',
      platform,
      arch,
      asar: true,
      ...(icon ? { icon } : {}),
      electronVersion,
      ...(electronZipDir ? { electronZipDir } : {}),
      extraResource: [runtime],
      ignore: /^\/native-runtime(?:\/|$)/,
      appVersion: manifest.version,
      overwrite: true,
      ...(platform === 'win32'
        ? {
            win32metadata: {
              ProductName: 'Diomedes',
              FileDescription: 'Diomedes desktop',
              CompanyName: 'Diomedes',
            },
          }
        : {}),
    });
    // Electron Packager resolves with nothing, and only logs, when it skips a
    // target. It skips macOS on a Windows host that cannot create symbolic
    // links. Reporting "Desktop release:" with no path would read as success.
    if (!outputs?.length)
      throw new Error(
        `The packager produced no ${platform}/${arch} output. Packaging macOS from Windows needs permission to create symbolic links (Windows Developer Mode, or an elevated shell); without it the packager skips the target. Nothing was built.`,
      );
    const evidenceDirectory = path.join(
      root,
      'evidence',
      platform === 'win32' ? 'windows-release' : 'macos-release',
    );
    await fs.mkdir(evidenceDirectory, { recursive: true });
    await fs.writeFile(
      path.join(evidenceDirectory, 'build-info.json'),
      JSON.stringify(buildInfo, null, 2),
    );
    for (const output of outputs) {
      const files = [];
      async function inventory(relative = '') {
        for (const entry of await fs.readdir(path.join(output, relative), {
          withFileTypes: true,
        })) {
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await inventory(child);
          else if (entry.isSymbolicLink())
            files.push({ path: child, link: await fs.readlink(path.join(output, child)) });
          else if (entry.isFile())
            files.push({
              path: child,
              sha256: sha256(await fs.readFile(path.join(output, child))),
            });
          else throw new Error(`Unexpected package entry: ${child}`);
        }
      }
      await inventory();
      await fs.writeFile(
        `${output}.manifest.json`,
        JSON.stringify(
          {
            schemaVersion: 1,
            baseCommit,
            sourceDigest,
            target: { platform, arch },
            signing: buildInfo.signing,
            nativeRuntime: buildInfo.nativeRuntime,
            files: files.sort((a, b) => a.path.localeCompare(b.path)),
          },
          null,
          2,
        ),
      );
    }
    console.log(`Desktop release: ${outputs.join(', ')}`);
  } finally {
    // The staging copy is fully derived from the repo; never leave it behind.
    if (
      path.resolve(path.dirname(stage)) !== path.resolve(root) ||
      !path.basename(stage).startsWith('.desktop-stage-')
    )
      throw new Error('Refusing to remove an unexpected staging directory.');
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// `--platform` and `--arch` name the target from an npm script, where setting
// an environment variable is not portable between cmd.exe and a Unix shell.
// An explicit argument outranks the environment, which outranks the host.
export function targetFromArgs(args) {
  const target = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    if (flag !== '--platform' && flag !== '--arch') throw new Error(`Unknown argument: ${flag}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    const key = flag.slice(2);
    if (key in target) throw new Error(`${flag} was given more than once.`);
    target[key] = value;
  }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await packageDesktop(targetFromArgs(process.argv.slice(2)));
