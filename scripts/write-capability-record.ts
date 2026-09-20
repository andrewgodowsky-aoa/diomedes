/**
 * Write `docs/reference/capability-record.json` from the files that own each
 * fact, and with `--check` fail when the committed file no longer matches them.
 *
 *   npx tsx scripts/write-capability-record.ts
 *   npx tsx scripts/write-capability-record.ts --check
 *   npx tsx scripts/write-capability-record.ts --generated-from <commit>
 *
 * Sources, one per fact:
 *   appVersion        package.json
 *   route label,
 *   task scope        shared/engine-routes.ts
 *   display name      shared/engines.ts
 *   reviewed version  server/engines/service.ts (TESTED_VERSIONS)
 *   guided install    server/engines/install.ts (the installer's own offer)
 *   packaged          the newest record under evidence/release-candidates/
 *   clean machine     nothing: no such evidence exists, so every one is null
 *
 * It reads files and writes exactly one. It starts no process, so it never
 * shells out to git, and it opens no socket.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EXTERNAL_ENGINES, ENGINE_NAMES } from '../shared/engines.js';
import { ENGINE_ROUTE_PROFILES } from '../shared/engine-routes.js';
import { TESTED_VERSIONS } from '../server/engines/service.js';
import { EngineInstaller } from '../server/engines/install.js';
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  type CapabilityRecordInput,
  type ReleaseEvidenceInput,
} from '../shared/capability-record.js';

const ROOT = new URL('../', import.meta.url);
export const RECORD_PATH = 'docs/reference/capability-record.json';
const EVIDENCE_DIRECTORY = 'evidence/release-candidates';

const at = (relative: string) => fileURLToPath(new URL(relative, ROOT));
const read = (relative: string) => readFile(at(relative), 'utf8');
/** Git stores line endings as LF; a Windows checkout may hand them back as CRLF. */
const lf = (text: string) => text.replace(/\r\n/g, '\n');

export const render = (record: CapabilityRecord) => `${JSON.stringify(record, null, 2)}\n`;

/**
 * Guided installation is a property of the installer, not of this script, so
 * ask it. The platform is pinned to the one the offer supports, because the
 * record states what Diomedes offers and not what this machine happens to be.
 */
function guidedInstalls(): Record<string, boolean> {
  const installer = new EngineInstaller('capability-record', { platform: 'win32', arch: 'x64' });
  return Object.fromEntries(
    EXTERNAL_ENGINES.map((engine) => [engine, installer.offer(engine).available]),
  );
}

interface ReleaseEvidenceFile {
  schemaVersion?: number;
  releaseId?: string;
  appVersion?: string;
  channel?: string;
  recordedAt?: string;
  build?: { baseCommit?: string };
  installer?: { filename?: string; sha256?: string };
  signing?: { application?: string | null; installer?: string | null };
  protocols?: { engines?: { testedVersions?: Record<string, string> } };
}

/** A release record, not one of the sidecar proofs stored beside it. */
const isReleaseRecord = (value: ReleaseEvidenceFile) =>
  typeof value.schemaVersion === 'number' &&
  typeof value.releaseId === 'string' &&
  typeof value.appVersion === 'string' &&
  typeof value.recordedAt === 'string';

/** The newest release evidence record, read as data. Null when there is none. */
export async function newestRelease(): Promise<ReleaseEvidenceInput | null> {
  let newest: { file: string; value: ReleaseEvidenceFile } | null = null;
  for (const name of (await readdir(at(EVIDENCE_DIRECTORY))).sort()) {
    if (!name.endsWith('.json')) continue;
    const relative = `${EVIDENCE_DIRECTORY}/${name}`;
    let value: ReleaseEvidenceFile;
    try {
      value = JSON.parse(await read(relative)) as ReleaseEvidenceFile;
    } catch {
      continue;
    }
    if (!isReleaseRecord(value)) continue;
    if (!newest || value.recordedAt! > newest.value.recordedAt!) newest = { file: relative, value };
  }
  if (!newest) return null;
  const { file, value } = newest;
  const tested = value.protocols?.engines?.testedVersions ?? {};
  return {
    releaseId: value.releaseId!,
    appVersion: value.appVersion!,
    channel: value.channel ?? 'unknown',
    baseCommit: value.build?.baseCommit ?? 'unknown',
    recordedAt: value.recordedAt!,
    installerFilename: value.installer?.filename ?? null,
    installerSha256: value.installer?.sha256 ?? null,
    applicationSigning: value.signing?.application ?? null,
    installerSigning: value.signing?.installer ?? null,
    evidencePath: file,
    engineVersions: Object.fromEntries(
      EXTERNAL_ENGINES.filter((engine) => typeof tested[engine] === 'string').map((engine) => [
        engine,
        tested[engine],
      ]),
    ),
  };
}

export async function gatherCapabilityRecordInput(
  generatedFrom: string,
): Promise<CapabilityRecordInput> {
  const appVersion = (JSON.parse(await read('package.json')) as { version: string }).version;
  const guided = guidedInstalls();
  return {
    appVersion,
    generatedFrom,
    routes: EXTERNAL_ENGINES.map((engine) => ({
      engine,
      displayName: ENGINE_NAMES[engine],
      routeLabel: ENGINE_ROUTE_PROFILES[engine].routeLabel,
      taskScope: ENGINE_ROUTE_PROFILES[engine].taskScope,
      reviewedVersion: TESTED_VERSIONS[engine],
      guidedInstall: guided[engine] ?? false,
      // The adapter is in this tree, which is the only thing this state claims.
      source: 'implemented' as const,
      // No clean-machine run of a published build has been recorded for any
      // route. The installer proof beside the release ran on the machine that
      // built it, with an isolated profile, so it is not this.
      cleanMachine: null,
    })),
    release: await newestRelease(),
  };
}

/**
 * The commit checked out right now, read from the repository's own files. A
 * worktree's `.git` is a pointer file, and its branch ref lives in the common
 * directory or in `packed-refs`. Returns null when it cannot be resolved.
 */
async function currentCommit(): Promise<string | null> {
  const sha = (value: string) => (/^[0-9a-f]{40}$/.test(value.trim()) ? value.trim() : null);
  const slurp = async (file: string) => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  };
  const pointer = await slurp(at('.git'));
  let gitDir = at('.git');
  if (pointer?.startsWith('gitdir:')) gitDir = path.resolve(at('.'), pointer.slice(7).trim());
  const head = await slurp(path.join(gitDir, 'HEAD'));
  if (!head) return null;
  if (!head.startsWith('ref:')) return sha(head);
  const ref = head.slice(4).trim();
  const common = await slurp(path.join(gitDir, 'commondir'));
  const dirs = [gitDir, ...(common ? [path.resolve(gitDir, common.trim())] : [])];
  for (const dir of dirs) {
    const loose = await slurp(path.join(dir, ref));
    if (loose && sha(loose)) return sha(loose);
  }
  for (const dir of dirs) {
    const packed = await slurp(path.join(dir, 'packed-refs'));
    for (const line of lf(packed ?? '').split('\n')) {
      const [value, name] = line.split(' ');
      if (name === ref && sha(value ?? '')) return sha(value!);
    }
  }
  return null;
}

async function main(argv: string[]) {
  const check = argv.includes('--check');
  const flagged = argv[argv.indexOf('--generated-from') + 1];
  const committedText = await readFile(at(RECORD_PATH), 'utf8').catch(() => null);
  const committed = committedText
    ? (JSON.parse(committedText) as Partial<CapabilityRecord>)
    : null;

  // In `--check` the committed commit is reused, because the file can never
  // carry the id of the commit that adds it. Everything else must still match.
  const generatedFrom = check
    ? (committed?.generatedFrom?.commit ?? null)
    : (argv.includes('--generated-from') ? flagged : null) ??
      (await currentCommit()) ??
      committed?.generatedFrom?.commit ??
      null;
  if (!generatedFrom) {
    console.error(
      `Could not determine the commit for ${RECORD_PATH}. Pass --generated-from <commit>.`,
    );
    process.exitCode = 1;
    return;
  }

  const expected = render(buildCapabilityRecord(await gatherCapabilityRecordInput(generatedFrom)));
  if (!check) {
    await writeFile(at(RECORD_PATH), expected, 'utf8');
    console.log(`Wrote ${RECORD_PATH} from commit ${generatedFrom}.`);
    return;
  }
  if (committedText && lf(committedText) === lf(expected)) {
    console.log(`${RECORD_PATH} matches this tree.`);
    return;
  }
  console.error(
    committedText
      ? `${RECORD_PATH} is out of date. Run: npm run capability-record`
      : `${RECORD_PATH} is missing. Run: npm run capability-record`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
