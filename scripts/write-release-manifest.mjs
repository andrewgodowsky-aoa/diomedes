import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = path.resolve(root, '../../deliverables/windows-release-20260909');
const evidence = path.join(root, 'evidence/windows-release');
const read = async (file) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
const sha = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const build = await read('evidence/windows-release/build-info.json');
const units = await read('evidence/windows-release/final-unit-tests.json');
const installer = JSON.parse(await fs.readFile(path.join(destination, 'Diomedes-Experimental-0.1.1-unsigned-setup.exe.json'), 'utf8'));
const files = await read('evidence/windows-release/package-files.json');
const proofPaths = {
  connections: 'test-results/package-connections-final/proof.json',
  relocated: 'test-results/package-relocated-final/proof.json',
  installer: 'test-results/installer-final-3/proof.json',
  upgrade: 'test-results/archive-upgrade-final-2/proof.json',
  provider: 'evidence/windows-release/provider-smoke-sol-1/proof.json',
  negative: 'evidence/windows-release/package-negative-final.json',
};
const proofs = Object.fromEntries(await Promise.all(Object.entries(proofPaths).map(async ([id, file]) => [id, await read(file)])));
if (!units.success || units.numPassedTests !== 615) throw new Error('Final source suite is not passing.');
for (const name of ['connections', 'installer', 'upgrade', 'provider', 'negative']) if (!proofs[name].passed) throw new Error(`${name} proof is not passing.`);
if (proofs.relocated.checks.length < 10 || proofs.relocated.errors.length) throw new Error('Relocated proof is incomplete.');
for (const input of build.source) if (await sha(path.join(root, input.path)) !== input.sha256) throw new Error(`App input changed after build: ${input.path}`);
const packageRoot = path.join(root, 'release/Diomedes-win32-x64');
for (const file of files) if (await sha(path.join(packageRoot, file.path)) !== file.sha256) throw new Error(`Package file changed: ${file.path}`);
const asar = path.join(packageRoot, 'resources/app.asar');
const embedded = JSON.parse(extractFile(asar, 'BUILD_INFO.json').toString('utf8'));
if (JSON.stringify(embedded) !== JSON.stringify(build)) throw new Error('Embedded build identity differs.');
for (const input of build.source.filter(item => item.path.startsWith('licenses/') || item.path === 'LICENSE')) {
  if (createHash('sha256').update(extractFile(asar, input.path)).digest('hex') !== input.sha256) throw new Error(`Shipped notice differs: ${input.path}`);
}
const allowed = new Set(['dist', 'main.mjs', 'server', 'fixtures', 'licenses', 'package.json', 'LICENSE', 'BUILD_INFO.json']);
for (const file of listPackage(asar)) {
  const top = file.replaceAll('\\', '/').replace(/^\//, '').split('/')[0];
  if (top && !allowed.has(top)) throw new Error(`Unexpected staged ASAR path: ${file}`);
  if (/[/\\](?:auth\.json|config\.toml|\.env|\.data|test-results)(?:[/\\]|$)/i.test(file)) throw new Error(`Private/test state in ASAR: ${file}`);
}
const releaseId = 'diomedes-0.1.1-windows-experimental-20260909-09e551958dfa';
const supportFile = path.join(destination, 'Start-Experimental.ps1');
const support = { kind: 'optional-isolated-launcher', filename: 'Start-Experimental.ps1', bytes: (await fs.stat(supportFile)).size, sha256: await sha(supportFile), signing: 'unsigned' };
const artifacts = [];
for (const [kind, filename] of [['portable-zip', 'Diomedes-Experimental-0.1.1-win32-x64.zip'], ['per-user-installer', 'Diomedes-Experimental-0.1.1-unsigned-setup.exe']]) {
  const absolute = path.join(destination, filename), stat = await fs.stat(absolute);
  artifacts.push({ kind, filename, bytes: stat.size, sha256: await sha(absolute), signing: 'unsigned', publisher: null });
}
if (artifacts[1].sha256 !== installer.outputSha256) throw new Error('Installer changed after verified build.');
const capability = (id, status, levels, claim, limit) => ({ id, status, evidenceLevels: levels, claim, limit });
const ledger = { schemaVersion: 1, releaseId, appVersion: '0.1.1', statusVocabulary: ['VERIFIED', 'PARTIAL', 'MISSING', 'DEFERRED'],
  capabilities: [
    capability('desktop-connections', 'VERIFIED', ['source', 'fixture', 'packaged', 'installer'], 'Connections in the Console with reviewed three-location synthetic scope, incomplete-intent questions and freshness.', 'Bounded Toast intent template; no general language-to-arbitrary-connector construction.'),
    capability('typed-availability', 'VERIFIED', ['source', 'fixture', 'packaged'], 'Current-authority typed reads preserve reported quantity, unknown and untracked availability.', 'Synthetic menu-item availability; no physical ingredient inventory or live Toast access.'),
    capability('scoped-rules-and-correction', 'VERIFIED', ['source', 'fixture', 'packaged'], 'Scoped frozen context, raw scripted bad output, final-output trigger, distinct bounded correction step and versioned evidence.', 'Final-output interception only; no stream-time or external-agent internal-tool interception.'),
    capability('signed-inbox-triage', 'VERIFIED', ['source', 'fixture', 'packaged', 'installer'], 'Raw-body signed durable ingress, service-window AND quantity condition, one internal Task and explicit-authority crash recovery.', 'Local synthetic signer/receiver while host online; no production webhook endpoint or continuous offline monitoring.'),
    capability('registered-write-denial', 'VERIFIED', ['source', 'fixture', 'packaged'], 'Actual registered test-only write operation denied by Runtime before its handler; zero dispatches.', 'Isolated test-mode probe; no live vendor write attempted.'),
    capability('generic-openapi-compiler', 'VERIFIED', ['source', 'fixture', 'packaged'], 'Two unrelated services compile from a constrained declarative OpenAPI subset into exact reviewed data-only adapters.', 'No arbitrary scripts, remote references, live auth/transport, writes, servers or unrestricted schema support.'),
    capability('mcp-projection', 'VERIFIED', ['source', 'fixture', 'packaged'], 'Official SDK Client/Server discovery and invocation through the same authorization and Runtime path.', 'In-memory host-local transport only; remotely accessible MCP and MCP Apps are absent.'),
    capability('exact-approval-and-history', 'VERIFIED', ['source', 'fixture', 'packaged', 'archive-extracted'], 'Exact proposal/base identity, bounded expiry, decline, Stop, one-write replay, waiting restart, History and restore.', 'Only existing supported local report/recorded-write capabilities; not general external-effect reconciliation.'),
    capability('improvement-loop', 'PARTIAL', ['source', 'fixture', 'packaged'], 'Correction history to pure offline coverage replay, exact versioned adoption and rollback with no privilege expansion.', 'Instruction coverage and deterministic outcomes only; no measured real-model quality/cost improvement.'),
    capability('real-codex-report', 'VERIFIED', ['real-provider', 'source'], 'One actual Sol turn over frozen synthetic connector evidence through existing native ChatGPT egress, Need and recorded write.', 'Host-only report proof; not ordinary authenticated-user starts or a combined live-model connector/correction loop.'),
    capability('second-model-route', 'MISSING', [], 'No second independently ready authorized adapter in this composition.', 'Planned external integrations and observe-only LocalAI are not substitutes for an implemented adapter.'),
    capability('windows-package', 'VERIFIED', ['packaged', 'archive-extracted', 'installer'], 'Exact x64 package, source-unavailable relocation, 76-file ZIP comparison, installed runtime, repair/uninstall and actual 0.1.0 profile upgrade.', 'Windows 11 build 26200 tested; no public download, other-OS matrix, signed updater or historic-version migration claim.'),
    capability('production-trust-and-connectors', 'DEFERRED', [], 'Production account/tenant/credential authority and live vendor transport remain separate work.', 'Synthetic prototype authority is explicit; local core does not require account service.'),
    capability('public-download', 'MISSING', [], 'Artifacts are staged locally; no public URL exists for this release.', 'Publication not authorized; complete native dependency-notice evidence remains unresolved.'),
  ] };
const idle = proofs.connections.idle.samples.at(-1);
const manifest = { schemaVersion: 1, product: 'Diomedes', releaseId, appVersion: '0.1.1', channel: 'experimental',
  build: { id: releaseId, builtAt: build.builtAt, baseCommit: build.baseCommit, sourceStatus: 'local-uncommitted', buildInputSha256: build.sourceDigest, identityEmbeddedIn: 'resources/app.asar:BUILD_INFO.json' },
  platform: { os: 'Windows', architecture: 'x64', tested: 'Windows 11 Home 10.0.26200 (64-bit)', otherVersions: 'unverified', minimumRam: null, extractedPayloadBytes: installer.appBytes, freeSpace: 'Allow additional space for extraction, installation and user data.', gpuOrCloudAccountRequiredForFixture: false },
  runtime: { electron: '44.2.0', codex: '0.153.4', nativeBinaryProvenance: 'Official program bytes verified; distinct valid OpenAI signing instances.' },
  artifacts,
  supportFiles: [support],
  internalPackageHashes: { executableSha256: await sha(path.join(packageRoot, 'Diomedes.exe')), asarSha256: await sha(asar), files: files.length, payloadTreeSha256: installer.appTreeSha256 },
  signing: { application: 'NotSigned', installer: 'NotSigned', publisher: null, automaticUpdater: false },
  installInstructions: { portable: 'Extract the complete ZIP into a new folder; keep every shipped file beside the executable.', installer: 'Per-user experimental installer, no elevation or automatic app launch. Choose a fresh target folder.', isolatedEvaluation: 'Use the supplied Start-Experimental.ps1 with an explicit executable; it starts a new fixture profile without copying accounts.', profileBehavior: 'A normal launch uses the existing Diomedes profile. Isolated evaluation uses a separate profile/data/projects and empty synthetic CODEX_HOME.', uninstall: 'Removes only its owned program files, registration and shortcut. Unknown files and user profiles are preserved.' },
  releaseNotes: ['Connections added to the Console.', 'Reviewed synthetic Toast scope, signed durable triage, scoped rules/correction and versioned replay/adoption/rollback.', 'Two generic declarative fixture adapters and official host-local MCP projection.', 'Prepared-tool narrowing, per-step transcript replay and signed-event session recovery repaired; Runtime and Trust preserved.'],
  verification: { unitTests: { passed: units.numPassedTests, failed: units.numFailedTests }, typecheck: 'passed', builtClient: 'passed', packagedConnectionsScenarios: proofs.connections.checks.length, sourceUnavailableRelocation: 'passed', zipAllFilesCompared: files.length, installedRuntime: 'passed', repairUninstallPreservation: 'passed', actualProfileUpgrade: '0.1.0 to 0.1.1 passed', realProvider: 'one synthetic Sol report passed', downloadedRelease: 'not-run-unpublished' },
  performance: { scope: 'Bounded local observations on a busy test machine; not a benchmark', startupReadyMs: proofs.connections.launches.map(l => l.readyMs), signedFixtureAckMs: proofs.connections.eventAckMs, idleWindowMs: proofs.connections.idle.windowMs, idleProcessWorkingSetTotalKiB: idle.reduce((n, p) => n + p.memory.workingSetSize, 0), idleProcessPrivateBytesTotalKiB: idle.reduce((n, p) => n + p.memory.privateBytes, 0), idleProcessCpuPercentTotal: idle.reduce((n, p) => n + p.cpu.percentCPUUsage, 0), workingSetCaveat: 'Shared memory may be counted more than once. First launch had an unexplained 30.9-second outlier.' },
  notices: { lockedProductionPackages: 102, uniqueLicenseNoticeTexts: 78, missingTopLevelTexts: 0, fonts: 4, electronAndChromium: 'included', codexRootLicenseAndNotice: 'exact official tag included', codexNativeDependencyInventory: 'Not published upstream and not independently generated here.' },
  capabilityLedger: 'capability-ledger.json',
  packagedNegativeProof: { passed: proofs.negative.checks.length, cases: ['reordered-event', 'privilege-expansion', 'changed-base', 'expired-approval'], expiryMethod: 'Controlled valid-state aging in a stopped isolated profile; no machine clock change.' },
  knownLimitations: ['Synthetic vendor access and prototype authority only.', 'Bounded intent parser and OpenAPI subset; no unrestricted connector generation.', 'Final-output hook only; direct-agent internal tools/stream are not intercepted.', 'Monitoring requires the local host online; no public receiver.', 'Offline improvement replay is instruction coverage, not measured model improvement.', 'One bounded real-provider report; no second ready route or combined live-model proof.', 'Unsigned application and installer; complete native third-party notice inventory unresolved.'],
  publication: { status: 'unpublished', eligible: false, owner: 'Separate Opus website task', blockers: ['Explicit authorization to publish these exact artifacts has not been given.', 'Complete Windows-x64 native dependency/license-notice inventory has not been established.'], afterUpload: 'Retrieve each actual download, verify length/SHA-256, exercise its extracted/installed application, then add its verified URL. Never overwrite immutable filenames with changed bytes.' },
};
const json = (value) => JSON.stringify(value, null, 2) + '\n';
for (const [filename, value] of [['release-manifest.json', manifest], ['capability-ledger.json', ledger]]) {
  const serialized = json(value);
  if (/[A-Za-z]:[\\/]|Users[\\/]andre|provider-smoke|test-results/.test(serialized)) throw new Error(`Private path in public metadata: ${filename}`);
  await fs.writeFile(path.join(destination, filename), serialized);
  await fs.writeFile(path.join(root, 'docs/releases', filename), serialized);
}
await fs.writeFile(path.join(destination, 'SHA256SUMS.txt'), [...artifacts, support].map(a => `${a.sha256}  ${a.filename}`).join('\n') + '\n');
await fs.writeFile(path.join(evidence, 'release-evidence.json'), json({ schemaVersion: 1, releaseId, generatedAt: new Date().toISOString(), checkout: root, destination,
  sourceSnapshotVerified: true, asarAllowlistVerified: true, packageFilesVerified: files.length,
  proofFiles: Object.fromEntries(Object.entries(proofPaths).map(([id, file]) => [id, { path: path.join(root, file), checks: proofs[id].checks ?? null }])),
  internalOnly: true }));
console.log(JSON.stringify({ releaseId, artifacts: artifacts.map(a => ({ filename: a.filename, sha256: a.sha256 })), sourceSnapshotVerified: true, publicMetadataHasNoLocalPaths: true }));
