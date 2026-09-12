import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildScriptId = 'scripts/build-windows-installer.mjs';
const productId = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001';
const productRegistryKey = `Software\\Diomedes\\Experimental\\${productId}`;
const uninstallRegistryKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productId}`;
const markerName = '.diomedes-experimental-20260909';
const tool = {
  name: 'NSIS',
  version: '3.12',
  url: 'https://sourceforge.net/projects/nsis/files/NSIS%203/3.12/nsis-3.12.zip/download',
  sha256: '56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f',
};

const defaults = {
  appDir: path.join(root, 'release', 'Diomedes-win32-x64'),
  outDir: path.resolve(root, '..', '..', 'deliverables', 'windows-release-20260909'),
  toolCache: path.join(root, 'test-results', 'installer-tools'),
};

function usage() {
  return `Build the unsigned, per-user Diomedes experimental Windows installer.

Usage:
  node scripts/build-windows-installer.mjs [options]

Options:
  --app-dir PATH       Packaged Electron app (default: release/Diomedes-win32-x64)
  --out-dir PATH       Installer output directory
  --output-name NAME   Installer file name (must be a base name ending in .exe)
  --tool-cache PATH    Cache for the portable NSIS ZIP and extraction
  --no-download        Fail instead of downloading the pinned portable NSIS ZIP
  --signed             Authenticode-sign Diomedes.exe and the installer through
                       scripts/sign-windows.ps1 (Azure Artifact Signing; needs the
                       DIOMEDES_SIGN_* environment). Without it the build is unsigned
                       and says so.
  --help               Show this help

Relative paths are resolved from the current working directory. Existing installer
files are replaced only when their adjacent JSON manifest says this script owns them.`;
}

function parseArgs(argv) {
  const result = { download: true };
  const pathOptions = new Map([
    ['--app-dir', 'appDir'],
    ['--out-dir', 'outDir'],
    ['--tool-cache', 'toolCache'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') result.help = true;
    else if (arg === '--no-download') result.download = false;
    else if (arg === '--signed') result.signed = true;
    else if (arg === '--output-name') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      result.outputName = value;
    } else if (pathOptions.has(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      result[pathOptions.get(arg)] = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return result;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}.\n${stdout}${stderr}`.trim()));
    });
  });
}

async function acquireNsis(toolCache, allowDownload) {
  const zipPath = path.join(toolCache, `nsis-${tool.version}.zip`);
  const extractRoot = path.join(toolCache, `nsis-${tool.version}`);
  const compilerPath = path.join(extractRoot, `nsis-${tool.version}`, 'makensis.exe');
  await fs.mkdir(toolCache, { recursive: true });

  if (!(await exists(zipPath))) {
    if (!allowDownload) {
      throw new Error(`Portable NSIS is missing at ${zipPath}; omit --no-download to fetch it.`);
    }
    const partialPath = `${zipPath}.partial-${process.pid}`;
    await run('curl.exe', [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--user-agent',
      'Diomedes experimental installer builder',
      '--output',
      partialPath,
      tool.url,
    ]);
    const downloadedHash = await sha256File(partialPath);
    if (downloadedHash !== tool.sha256) {
      throw new Error(
        `Downloaded NSIS SHA-256 mismatch. Expected ${tool.sha256}, received ${downloadedHash}. ` +
          `The untrusted partial download remains at ${partialPath}.`,
      );
    }
    await fs.rename(partialPath, zipPath);
  }

  const zipHash = await sha256File(zipPath);
  if (zipHash !== tool.sha256) {
    throw new Error(
      `NSIS cache SHA-256 mismatch at ${zipPath}. Expected ${tool.sha256}, received ${zipHash}.`,
    );
  }

  if (!(await exists(compilerPath))) {
    if (await exists(extractRoot)) {
      throw new Error(
        `NSIS extraction is incomplete at ${extractRoot}. Preserve it for inspection and use ` +
          `--tool-cache with a new empty cache path.`,
      );
    }
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:DIOMEDES_NSIS_ZIP -DestinationPath $env:DIOMEDES_NSIS_DEST',
      ],
      {
        env: {
          ...process.env,
          DIOMEDES_NSIS_ZIP: zipPath,
          DIOMEDES_NSIS_DEST: extractRoot,
        },
      },
    );
  }

  const versionResult = await run(compilerPath, ['/VERSION'], { cwd: path.dirname(compilerPath) });
  const compilerVersion = `${versionResult.stdout}${versionResult.stderr}`.trim();
  if (compilerVersion !== `v${tool.version}`) {
    throw new Error(`Unexpected NSIS compiler version ${JSON.stringify(compilerVersion)}.`);
  }
  return { compilerPath, compilerVersion, zipPath, zipHash };
}

async function collectPayload(appDir) {
  const files = [];
  const directories = [];
  async function visit(relativeDir) {
    const absoluteDir = path.join(appDir, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      const absolutePath = path.join(appDir, relativePath);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `The packaged app contains a symbolic link, which is not supported: ${absolutePath}`,
        );
      }
      if (entry.isDirectory()) {
        directories.push(relativePath);
        await visit(relativePath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolutePath);
        files.push({
          absolutePath,
          relativePath,
          size: stat.size,
          sha256: await sha256File(absolutePath),
        });
      } else {
        throw new Error(`Unsupported payload entry: ${absolutePath}`);
      }
    }
  }
  await visit('');
  return { files, directories };
}

function nsis(value) {
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"');
}

function windowsRelative(value) {
  return value.split(path.sep).join('\\');
}

function numericFileVersion(version) {
  const parts = version
    .split('.')
    .slice(0, 3)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  while (parts.length < 3) parts.push(0);
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

function generateNsis({ outputPath, version, payload, signed = false }) {
  let previousInstallDirectory;
  const installFiles = payload.files
    .map(({ absolutePath, relativePath }) => {
      const relativeDirectory = windowsRelative(path.dirname(relativePath));
      const setOutput =
        relativeDirectory !== previousInstallDirectory
          ? `  SetOutPath \"$INSTDIR\\app${relativeDirectory === '.' ? '' : `\\${nsis(relativeDirectory)}`}\"\n`
          : '';
      previousInstallDirectory = relativeDirectory;
      return `${setOutput}  File \"${nsis(absolutePath)}\"`;
    })
    .join('\n');
  const deleteFiles = payload.files
    .map(({ relativePath }) => `  Delete \"$INSTDIR\\app\\${nsis(windowsRelative(relativePath))}\"`)
    .join('\n');
  const removeDirectories = [...payload.directories]
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || b.localeCompare(a))
    .map((relativePath) => `  RMDir \"$INSTDIR\\app\\${nsis(windowsRelative(relativePath))}\"`)
    .join('\n');

  return `; Generated by ${buildScriptId}. Do not hand-edit.
Unicode true
SetCompressor /SOLID zlib
RequestExecutionLevel user
!include \"MUI2.nsh\"

!define PRODUCT_ID \"${productId}\"
!define PRODUCT_NAME \"Diomedes Experimental 2026-09-09${signed ? '' : ' (Unsigned)'}\"
!define APP_VERSION \"${nsis(version)}\"
!define MARKER \"${markerName}\"
!define PRODUCT_KEY \"${productRegistryKey}\"
!define UNINSTALL_KEY \"${uninstallRegistryKey}\"

Name \"${'${PRODUCT_NAME}'}\"
OutFile \"${nsis(outputPath)}\"
InstallDir \"$LOCALAPPDATA\\Programs\\Diomedes Experimental 20260909\"
InstallDirRegKey HKCU \"${'${PRODUCT_KEY}'}\" \"InstallDir\"
BrandingText \"Experimental ${signed ? 'signed' : 'unsigned'} build\"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion \"${numericFileVersion(version)}\"
VIAddVersionKey /LANG=1033 \"ProductName\" \"${'${PRODUCT_NAME}'}\"
VIAddVersionKey /LANG=1033 \"FileDescription\" \"${signed ? 'Experimental' : 'Unsigned experimental'} per-user installer\"
VIAddVersionKey /LANG=1033 \"FileVersion\" \"${nsis(version)}\"
VIAddVersionKey /LANG=1033 \"ProductVersion\" \"${nsis(version)}\"
VIAddVersionKey /LANG=1033 \"CompanyName\" \"Diomedes\"
VIAddVersionKey /LANG=1033 \"LegalCopyright\" \"Copyright (C) 2026 Diomedes contributors\"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE \"English\"

Function EnsureSafeInstallDir
  IfFileExists \"$INSTDIR\\${'${MARKER}'}\" marker_present
  IfFileExists \"$INSTDIR\\*.*\" unsafe safe
marker_present:
  FileOpen $0 \"$INSTDIR\\${'${MARKER}'}\" r
  IfErrors unsafe
  FileRead $0 $1
  FileClose $0
  StrCmp $1 \"${'${PRODUCT_ID}'}\" safe unsafe
unsafe:
  MessageBox MB_OK|MB_ICONSTOP \"This folder is not an empty Diomedes experimental install owned by ${'${PRODUCT_ID}'}. Choose an empty folder.\" /SD IDOK
  SetErrorLevel 2
  Quit
safe:
FunctionEnd

Section \"Install Diomedes experimental app\" SectionInstall
  SetShellVarContext current
  Call EnsureSafeInstallDir
${installFiles}

  FileOpen $0 \"$INSTDIR\\${'${MARKER}'}\" w
  FileWrite $0 \"${'${PRODUCT_ID}'}\"
  FileClose $0
  WriteUninstaller \"$INSTDIR\\Uninstall Diomedes Experimental.exe\"

  CreateDirectory \"$SMPROGRAMS\\Diomedes Experimental 20260909\"
  CreateShortcut \"$SMPROGRAMS\\Diomedes Experimental 20260909\\Diomedes Experimental.lnk\" \"$INSTDIR\\app\\Diomedes.exe\"

  WriteRegStr HKCU \"${'${PRODUCT_KEY}'}\" \"InstallDir\" \"$INSTDIR\"
  WriteRegStr HKCU \"${'${PRODUCT_KEY}'}\" \"ProductId\" \"${'${PRODUCT_ID}'}\"
  WriteRegStr HKCU \"${'${UNINSTALL_KEY}'}\" \"DisplayName\" \"${'${PRODUCT_NAME}'}\"
  WriteRegStr HKCU \"${'${UNINSTALL_KEY}'}\" \"DisplayVersion\" \"${'${APP_VERSION}'}\"
  WriteRegStr HKCU \"${'${UNINSTALL_KEY}'}\" \"DisplayIcon\" \"$INSTDIR\\app\\Diomedes.exe\"
  WriteRegStr HKCU \"${'${UNINSTALL_KEY}'}\" \"InstallLocation\" \"$INSTDIR\"
  WriteRegStr HKCU \"${'${UNINSTALL_KEY}'}\" \"UninstallString\" '\"$INSTDIR\\Uninstall Diomedes Experimental.exe\"'
  WriteRegDWORD HKCU \"${'${UNINSTALL_KEY}'}\" \"NoModify\" 1
  WriteRegDWORD HKCU \"${'${UNINSTALL_KEY}'}\" \"NoRepair\" 1
SectionEnd

Function un.VerifyOwnership
  IfFileExists \"$INSTDIR\\${'${MARKER}'}\" marker_present
  Goto unsafe
marker_present:
  FileOpen $0 \"$INSTDIR\\${'${MARKER}'}\" r
  IfErrors unsafe
  FileRead $0 $1
  FileClose $0
  StrCmp $1 \"${'${PRODUCT_ID}'}\" safe unsafe
unsafe:
  MessageBox MB_OK|MB_ICONSTOP \"The experimental ownership marker is missing or does not match. Nothing was removed.\" /SD IDOK
  SetErrorLevel 2
  Quit
safe:
FunctionEnd

Section \"Uninstall\"
  SetShellVarContext current
  Call un.VerifyOwnership
  Delete \"$SMPROGRAMS\\Diomedes Experimental 20260909\\Diomedes Experimental.lnk\"
  RMDir \"$SMPROGRAMS\\Diomedes Experimental 20260909\"

${deleteFiles}
${removeDirectories}
  RMDir \"$INSTDIR\\app\"

  DeleteRegKey HKCU \"${'${UNINSTALL_KEY}'}\"
  DeleteRegKey HKCU \"${'${PRODUCT_KEY}'}\"
  Delete \"$INSTDIR\\${'${MARKER}'}\"
  Delete \"$INSTDIR\\Uninstall Diomedes Experimental.exe\"
  RMDir \"$INSTDIR\"
SectionEnd
`;
}

async function assertScriptOwnedOutput(outputPath, manifestPath) {
  if (!(await exists(outputPath))) return;
  if (!(await exists(manifestPath))) {
    throw new Error(
      `Refusing to overwrite existing deliverable without an ownership manifest: ${outputPath}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(
      `Refusing to overwrite existing deliverable with an unreadable manifest: ${outputPath}`,
    );
  }
  if (manifest.ownedBy !== buildScriptId || path.resolve(manifest.outputFile) !== outputPath) {
    throw new Error(`Refusing to overwrite deliverable not owned by this script: ${outputPath}`);
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function payloadTreeSha256(payload) {
  const digest = createHash('sha256');
  for (const file of payload.files) {
    digest.update(`${windowsRelative(file.relativePath)}\0${file.size}\0${file.sha256}\n`);
  }
  return digest.digest('hex');
}

async function getAuthenticodeStatus(outputPath) {
  const handle = await fs.open(outputPath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error(`Installer is not a valid PE file: ${outputPath}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(192);
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
    if (peRead.bytesRead !== peHeader.length || peHeader.toString('ascii', 0, 4) !== 'PE\0\0') {
      throw new Error(`Installer has an invalid PE header: ${outputPath}`);
    }
    const optionalHeaderOffset = 24;
    const magic = peHeader.readUInt16LE(optionalHeaderOffset);
    const dataDirectoriesOffset =
      optionalHeaderOffset + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0);
    if (dataDirectoriesOffset === optionalHeaderOffset) {
      throw new Error(`Installer has an unsupported PE optional-header format: ${outputPath}`);
    }
    const certificateTableOffset = dataDirectoriesOffset + 4 * 8;
    const certificateFileOffset = peHeader.readUInt32LE(certificateTableOffset);
    const certificateSize = peHeader.readUInt32LE(certificateTableOffset + 4);
    return certificateFileOffset === 0 && certificateSize === 0 ? 'NotSigned' : 'Signed';
  } finally {
    await handle.close();
  }
}

/**
 * Sign through scripts/sign-windows.ps1, which holds no key and refuses to run
 * on a machine that is not configured for Azure Artifact Signing. A missing
 * configuration is an error here, because --signed was asked for explicitly.
 */
async function signFiles(files) {
  const script = path.join(root, 'scripts', 'sign-windows.ps1');
  // run() rejects on a non-zero exit with the script's output in the message.
  try {
    const result = await run('pwsh', ['-NoProfile', '-File', script, '-Path', ...files], { cwd: root });
    process.stdout.write(result.stdout);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes('[sign-windows] not configured')) {
      throw new Error(
        'Signing was requested but this machine is not configured: set DIOMEDES_SIGN_METADATA, DIOMEDES_SIGNTOOL and DIOMEDES_SIGN_DLIB (docs/releases/CODE_SIGNING.md).',
      );
    }
    throw new Error(`Signing failed.
${text}`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('This installer builder requires Windows.');

const appDir = args.appDir ?? defaults.appDir;
const outDir = args.outDir ?? defaults.outDir;
const toolCache = args.toolCache ?? defaults.toolCache;
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const signed = args.signed === true;
const outputName =
  args.outputName ??
  `Diomedes-Experimental-${manifest.version}-${signed ? 'setup' : 'unsigned-setup'}.exe`;
if (path.basename(outputName) !== outputName || !outputName.toLowerCase().endsWith('.exe')) {
  throw new Error('--output-name must be a file base name ending in .exe.');
}
const appStat = await fs.stat(appDir).catch(() => null);
if (!appStat?.isDirectory()) throw new Error(`Packaged app directory is missing: ${appDir}`);
if (!(await exists(path.join(appDir, 'Diomedes.exe')))) {
  throw new Error(`Packaged app does not contain Diomedes.exe: ${appDir}`);
}
const outputPath = path.join(outDir, outputName);
const manifestPath = `${outputPath}.json`;
if (isWithin(outDir, appDir)) {
  throw new Error(`Installer output must be outside the packaged app directory: ${outDir}`);
}
if (isWithin(toolCache, appDir)) {
  throw new Error(`NSIS tool cache must be outside the packaged app directory: ${toolCache}`);
}

if (signed) await signFiles([path.join(appDir, 'Diomedes.exe')]);
const payload = await collectPayload(appDir);
if (payload.files.length === 0) throw new Error(`Packaged app is empty: ${appDir}`);
const appTreeSha256 = payloadTreeSha256(payload);
const nsisTool = await acquireNsis(toolCache, args.download);
await fs.mkdir(outDir, { recursive: true });
await assertScriptOwnedOutput(outputPath, manifestPath);

const generatedDir = path.join(toolCache, 'generated');
await fs.mkdir(generatedDir, { recursive: true });
const generatedScript = path.join(generatedDir, `${path.parse(outputName).name}.nsi`);
await fs.writeFile(
  generatedScript,
  generateNsis({ outputPath, version: manifest.version, payload, signed }),
  'utf8',
);

await fs.writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      ownedBy: buildScriptId,
      outputFile: outputPath,
      state: 'building',
      generatedScript,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const compile = await run(nsisTool.compilerPath, ['/V4', '/WX', generatedScript], {
  cwd: path.dirname(nsisTool.compilerPath),
});
if (!(await exists(outputPath)))
  throw new Error(`NSIS reported success but did not create ${outputPath}.`);
const postCompilePayload = await collectPayload(appDir);
if (payloadTreeSha256(postCompilePayload) !== appTreeSha256) {
  throw new Error(
    'Packaged app changed while NSIS was compiling. Preserve the output for inspection and rebuild from a stable app directory.',
  );
}
if (signed) await signFiles([outputPath]);
const authenticodeStatus = await getAuthenticodeStatus(outputPath);
if (!signed && authenticodeStatus !== 'NotSigned') {
  throw new Error(`Expected an unsigned installer; Authenticode status is ${authenticodeStatus}.`);
}
if (signed && authenticodeStatus !== 'Signed') {
  throw new Error(`--signed was requested but the installer carries no signature (${authenticodeStatus}).`);
}

const installerStat = await fs.stat(outputPath);
const buildManifest = {
  schemaVersion: 1,
  ownedBy: buildScriptId,
  productId,
  experimental: true,
  unsigned: !signed,
  signing: signed ? 'azure-artifact-signing' : 'unsigned-experimental',
  authenticodeStatus,
  outputFile: outputPath,
  outputBytes: installerStat.size,
  outputSha256: await sha256File(outputPath),
  appDir,
  appVersion: manifest.version,
  appFileCount: payload.files.length,
  appBytes: payload.files.reduce((total, file) => total + file.size, 0),
  appTreeSha256,
  compiler: {
    name: tool.name,
    version: tool.version,
    reportedVersion: nsisTool.compilerVersion,
    sourceUrl: tool.url,
    archivePath: nsisTool.zipPath,
    archiveSha256: nsisTool.zipHash,
  },
  generatedScript,
  builtAt: new Date().toISOString(),
};
await fs.writeFile(manifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`, 'utf8');

process.stdout.write(compile.stdout);
process.stderr.write(compile.stderr);
console.log(`Installer: ${outputPath}`);
console.log(`Manifest: ${manifestPath}`);
console.log(`SHA-256: ${buildManifest.outputSha256}`);
console.log(`Authenticode: ${authenticodeStatus} (${signed ? 'signed' : 'unsigned'} experimental build)`);
