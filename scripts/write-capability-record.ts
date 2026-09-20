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
 *   task scope,
 *   limits            shared/engine-routes.ts
 *   display name      shared/engines.ts
 *   reviewed version  server/engines/service.ts (TESTED_VERSIONS)
 *   source            server/engines/service.ts (the adapter registry itself)
 *   guided install    server/engines/install.ts (the installer's own offer)
 *   packaged          the newest NAMED record under evidence/release-candidates/
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
  type SourceState,
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

export interface ReleaseEvidenceFile {
  schemaVersion?: number;
  releaseId?: string;
  /** Written by scripts/write-candidate-record.ts only for committed source. */
  named?: boolean;
  appVersion?: string;
  channel?: string;
  recordedAt?: string;
  build?: { baseCommit?: string };
  installer?: { filename?: string; sha256?: string };
  signing?: { application?: string | null; installer?: string | null };
  protocols?: { engines?: { testedVersions?: Record<string, string> } };
}

/**
 * A named candidate record, not one of the sidecar proofs stored beside it and
 * not a local build of uncommitted source. `named` is the only marker these
 * files carry about their own standing: `scripts/write-candidate-record.ts`
 * writes it when the build's source was committed, and
 * `scripts/write-release-assets.mjs` refuses to publish an unnamed one. None of
 * them records whether the build was published, which is why the record's
 * `packaged` state says packaged and recorded rather than published.
 */
const isReleaseRecord = (value: ReleaseEvidenceFile) =>
  typeof value.schemaVersion === 'number' &&
  typeof value.releaseId === 'string' &&
  typeof value.appVersion === 'string' &&
  typeof value.recordedAt === 'string' &&
  value.named === true;

/** The newest named candidate among the files already read. Pure. */
export function newestReleaseFrom(
  entries: readonly { file: string; value: ReleaseEvidenceFile }[],
): ReleaseEvidenceInput | null {
  let newest: { file: string; value: ReleaseEvidenceFile } | null = null;
  for (const entry of entries) {
    if (!isReleaseRecord(entry.value)) continue;
    if (!newest || entry.value.recordedAt! > newest.value.recordedAt!) newest = entry;
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

/** The newest named candidate record on disk. Null when there is none. */
export async function newestRelease(): Promise<ReleaseEvidenceInput | null> {
  const entries: { file: string; value: ReleaseEvidenceFile }[] = [];
  for (const name of (await readdir(at(EVIDENCE_DIRECTORY))).sort()) {
    if (!name.endsWith('.json')) continue;
    const relative = `${EVIDENCE_DIRECTORY}/${name}`;
    try {
      entries.push({ file: relative, value: JSON.parse(await read(relative)) as ReleaseEvidenceFile });
    } catch {
      continue;
    }
  }
  return newestReleaseFrom(entries);
}

/**
 * Which adapter class `EngineService` constructs for each engine, read from the
 * registry in its own constructor. An engine no line of that registry names has
 * no adapter, and the registry's last line answers for whatever it does not
 * name by id. Pure: it is given the source, and reads nothing.
 */
export function engineAdapters(
  serviceSource: string,
  engines: readonly string[],
): Record<string, string | null> {
  const block = /adapter:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(serviceSource);
  const body = block?.[1] ?? '';
  const named = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = /engine === '([^']+)'\)\s*return new (\w+)\(/.exec(line);
    if (match) named.set(match[1], match[2]);
  }
  const fallback = /(?:^|\n)\s*return new (\w+)\(/.exec(
    body
      .split('\n')
      .filter((line) => !line.includes('engine ==='))
      .join('\n'),
  )?.[1];
  return Object.fromEntries(
    engines.map((engine) => [engine, named.get(engine) ?? fallback ?? null]),
  );
}

/**
 * Whether the class that registry names is exported by the module the service
 * imports it from. The two together are what `source: 'implemented'` claims:
 * the service builds an adapter for this route out of code in this tree.
 */
async function adapterSources(): Promise<Record<string, SourceState>> {
  const service = await read('server/engines/service.ts');
  const adapters = engineAdapters(service, EXTERNAL_ENGINES);
  const entries = await Promise.all(
    Object.entries(adapters).map(async ([engine, adapter]) => {
      if (!adapter) return [engine, 'not-implemented' as SourceState];
      const from = new RegExp(`import \\{[^}]*\\b${adapter}\\b[^}]*\\} from '([^']+)'`).exec(
        service,
      )?.[1];
      if (!from) return [engine, 'not-implemented' as SourceState];
      const module = `server/engines/${path.basename(from).replace(/\.js$/, '.ts')}`;
      const source = await read(module).catch(() => null);
      const implemented = source !== null && new RegExp(`export class ${adapter}\\b`).test(source);
      return [engine, implemented ? 'implemented' : 'not-implemented'];
    }),
  );
  return Object.fromEntries(entries) as Record<string, SourceState>;
}

export async function gatherCapabilityRecordInput(
  generatedFrom: string,
): Promise<CapabilityRecordInput> {
  const appVersion = (JSON.parse(await read('package.json')) as { version: string }).version;
  const guided = guidedInstalls();
  const sources = await adapterSources();
  return {
    appVersion,
    generatedFrom,
    routes: EXTERNAL_ENGINES.map((engine) => ({
      engine,
      displayName: ENGINE_NAMES[engine],
      routeLabel: ENGINE_ROUTE_PROFILES[engine].routeLabel,
      taskScope: ENGINE_ROUTE_PROFILES[engine].taskScope,
      limits: ENGINE_ROUTE_PROFILES[engine].limits,
      reviewedVersion: TESTED_VERSIONS[engine],
      guidedInstall: guided[engine] ?? false,
      // Read from the registry the service builds its adapters with, so
      // deleting an adapter moves this field instead of leaving a claim behind.
      // It says the code is here; it says nothing about a packaged build.
      source: sources[engine] ?? 'not-implemented',
      // No clean-machine run of a published build has been recorded for any
      // route. The installer proof beside the release ran on the machine that
      // built it, with an isolated profile, so it is not this.
      cleanMachine: null,
    })),
    release: await newestRelease(),
  };
}

const sha = (value: string) => (/^[0-9a-f]{40}$/.test(value.trim()) ? value.trim() : null);
const slurp = async (file: string) => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * This checkout's git directory and, for a worktree, the common one beside it.
 * A worktree's `.git` is a pointer file rather than a directory.
 */
async function gitDirectories(): Promise<string[]> {
  const pointer = await slurp(at('.git'));
  let gitDir = at('.git');
  if (pointer?.startsWith('gitdir:')) gitDir = path.resolve(at('.'), pointer.slice(7).trim());
  const common = await slurp(path.join(gitDir, 'commondir'));
  return [gitDir, ...(common ? [path.resolve(gitDir, common.trim())] : [])];
}

/**
 * Whether this repository's object store holds that commit: loose, or listed in
 * a version 2 pack index. This proves the object is here, not that HEAD
 * descends from it — reachability would need a commit walk, and this script
 * starts no process and inflates nothing.
 *
 * `null` means it could not be determined: no repository, a shallow clone, an
 * alternates file pointing elsewhere, or a pack index this cannot read. A
 * caller must treat `null` as "no answer" and never as "absent".
 */
export async function commitPresent(commit: string): Promise<boolean | null> {
  if (!sha(commit)) return false;
  const dirs = await gitDirectories();
  let readable = false;
  for (const dir of dirs) {
    if (await slurp(path.join(dir, 'shallow'))) return null;
    if (await slurp(path.join(dir, 'objects', 'info', 'alternates'))) return null;
    const loose = path.join(dir, 'objects', commit.slice(0, 2), commit.slice(2));
    try {
      await readFile(loose);
      return true;
    } catch {
      // Not loose here; the packs below are the other half of the answer.
    }
    let packs: string[];
    try {
      packs = (await readdir(path.join(dir, 'objects', 'pack'))).filter((name) =>
        name.endsWith('.idx'),
      );
    } catch {
      continue;
    }
    readable = true;
    for (const name of packs) {
      const found = await packHolds(path.join(dir, 'objects', 'pack', name), commit);
      if (found === null) return null;
      if (found) return true;
    }
  }
  return readable ? false : null;
}

/** One version 2 pack index, searched by its own fanout table. */
async function packHolds(file: string, commit: string): Promise<boolean | null> {
  let index: Buffer;
  try {
    index = await readFile(file);
  } catch {
    return null;
  }
  // \377tOc, then the version. Version 1 has neither and is not read here.
  if (index.length < 1032 || index.readUInt32BE(0) !== 0xff744f63 || index.readUInt32BE(4) !== 2)
    return null;
  const id = Buffer.from(commit, 'hex');
  const bucket = id[0];
  let low = bucket === 0 ? 0 : index.readUInt32BE(8 + (bucket - 1) * 4);
  let high = index.readUInt32BE(8 + bucket * 4);
  const names = 8 + 1024;
  if (names + high * 20 > index.length) return null;
  while (low < high) {
    const middle = (low + high) >> 1;
    const order = index.compare(id, 0, 20, names + middle * 20, names + middle * 20 + 20);
    if (order === 0) return true;
    if (order < 0) high = middle;
    else low = middle + 1;
  }
  return false;
}

/**
 * The commit checked out right now, read from the repository's own files. Its
 * branch ref lives in the common directory or in `packed-refs`. Returns null
 * when it cannot be resolved.
 */
async function currentCommit(): Promise<string | null> {
  const dirs = await gitDirectories();
  const head = await slurp(path.join(dirs[0], 'HEAD'));
  if (!head) return null;
  if (!head.startsWith('ref:')) return sha(head);
  const ref = head.slice(4).trim();
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

  // Reusing the file's own commit means `--check` cannot compare that field
  // against anything, so it is checked for what it can be: a commit this
  // repository actually holds. The record is regenerated rarely, so its commit
  // is usually an ancestor rather than HEAD, and that is allowed. An answer of
  // "cannot tell" — a shallow clone, no repository, an unreadable pack — is not
  // a failure; only a definite absence is.
  if (check) {
    const present = await commitPresent(generatedFrom);
    if (present === false) {
      console.error(
        `${RECORD_PATH} names commit ${generatedFrom}, which this repository does not hold. Run: npm run capability-record`,
      );
      process.exitCode = 1;
      return;
    }
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
