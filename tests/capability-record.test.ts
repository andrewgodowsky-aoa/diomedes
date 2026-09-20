import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_ENGINES, ENGINE_NAMES } from '../shared/engines.js';
import { ENGINE_ROUTE_PROFILES } from '../shared/engine-routes.js';
import { TESTED_VERSIONS } from '../server/engines/service.js';
import { EngineInstaller } from '../server/engines/install.js';
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  type CapabilityRecordInput,
} from '../shared/capability-record.js';
import {
  commitPresent,
  engineAdapters,
  gatherCapabilityRecordInput,
  newestReleaseFrom,
  render,
} from '../scripts/write-capability-record.js';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const committedJson = read('docs/reference/capability-record.json');
const committed = JSON.parse(committedJson) as CapabilityRecord;

/** Every string the record puts in front of a reader, at any depth. */
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
};

/** One synthetic input, so the builder's rules are tested without reading the tree. */
const input = (overrides: Partial<CapabilityRecordInput> = {}): CapabilityRecordInput => ({
  appVersion: '9.9.9',
  generatedFrom: 'a'.repeat(40),
  routes: EXTERNAL_ENGINES.map((engine) => ({
    engine,
    displayName: ENGINE_NAMES[engine],
    routeLabel: ENGINE_ROUTE_PROFILES[engine].routeLabel,
    taskScope: ENGINE_ROUTE_PROFILES[engine].taskScope,
    limits: ENGINE_ROUTE_PROFILES[engine].limits,
    reviewedVersion: TESTED_VERSIONS[engine],
    guidedInstall: false,
    source: 'implemented' as const,
    cleanMachine: null,
  })),
  release: null,
  ...overrides,
});

const release = (versions: Partial<Record<(typeof EXTERNAL_ENGINES)[number], string>>) => ({
  releaseId: 'diomedes-9.9.9-windows-experimental-00000000-0123456789ab',
  appVersion: '9.9.9',
  channel: 'experimental',
  baseCommit: 'b'.repeat(40),
  recordedAt: '2026-01-01T00:00:00.000Z',
  installerFilename: 'Diomedes-Experimental-unsigned-setup.exe',
  installerSha256: 'c'.repeat(64),
  applicationSigning: 'NotSigned',
  installerSigning: 'NotSigned',
  evidencePath: 'evidence/release-candidates/synthetic.json',
  engineVersions: versions,
});

const routeOf = (record: CapabilityRecord, engine: string) => {
  const found = record.routes.find((route) => route.engine === engine);
  if (!found) throw new Error(`no route for ${engine}`);
  return found;
};

describe('capability record builder', () => {
  it('carries every adapter route exactly once, in the declared order', () => {
    const record = buildCapabilityRecord(input());
    expect(record.routes.map((route) => route.engine)).toEqual([...EXTERNAL_ENGINES]);
  });

  it('repeats the route profile and the reviewed version without inventing either', () => {
    const record = buildCapabilityRecord(input());
    for (const engine of EXTERNAL_ENGINES) {
      const route = routeOf(record, engine);
      expect(route.displayName, engine).toBe(ENGINE_NAMES[engine]);
      expect(route.routeLabel, engine).toBe(ENGINE_ROUTE_PROFILES[engine].routeLabel);
      expect(route.taskScope, engine).toBe(ENGINE_ROUTE_PROFILES[engine].taskScope);
      expect(route.limits, engine).toBe(ENGINE_ROUTE_PROFILES[engine].limits);
      expect(route.reviewedVersion, engine).toBe(TESTED_VERSIONS[engine]);
    }
  });

  it('never reports packaged without a release record', () => {
    const record = buildCapabilityRecord(input({ release: null }));
    expect(record.release).toBeNull();
    for (const route of record.routes) expect(route.states.packaged, route.engine).toBeNull();
  });

  it('reports packaged only for a route the release record names at the reviewed version', () => {
    const record = buildCapabilityRecord(
      input({
        release: release({ opencode: TESTED_VERSIONS.opencode, cursor: '0.0.0' }),
      }),
    );
    const opencode = routeOf(record, 'opencode').states.packaged;
    expect(opencode?.release).toBe('diomedes-9.9.9-windows-experimental-00000000-0123456789ab');
    expect(opencode?.note).toMatch(/does not record a request through this route/i);
    expect(routeOf(record, 'cursor').states.packaged).toBeNull();
    expect(routeOf(record, 'devin').states.packaged).toBeNull();
  });

  it('says the candidate evidence is build-level and names the commit it was built from', () => {
    const record = buildCapabilityRecord(
      input({ release: release({ opencode: TESTED_VERSIONS.opencode }) }),
    );
    expect(record.release?.note).toMatch(/build-level/i);
    // The record is written when a build is packaged here. Whether it was then
    // published is a fact no candidate record carries.
    expect(record.release?.note).toMatch(/does not record whether this build was published/i);
    expect(routeOf(record, 'opencode').states.packaged?.note).toContain('b'.repeat(40));
  });

  it('never reports a clean machine without evidence, and reports one when it exists', () => {
    const none = buildCapabilityRecord(input());
    for (const route of none.routes) expect(route.states.cleanMachine, route.engine).toBeNull();

    const withEvidence = buildCapabilityRecord(
      input({
        routes: input().routes.map((route) =>
          route.engine === 'opencode'
            ? { ...route, cleanMachine: { evidence: 'evidence/clean-machine/opencode.json' } }
            : route,
        ),
      }),
    );
    expect(routeOf(withEvidence, 'opencode').states.cleanMachine).toEqual({
      evidence: 'evidence/clean-machine/opencode.json',
    });
    expect(routeOf(withEvidence, 'cursor').states.cleanMachine).toBeNull();
  });

  it('keeps the three states independent of each other', () => {
    const record = buildCapabilityRecord(
      input({ release: release({ opencode: TESTED_VERSIONS.opencode }) }),
    );
    const route = routeOf(record, 'opencode');
    expect(route.states.source).toBe('implemented');
    expect(route.states.packaged).not.toBeNull();
    expect(route.states.cleanMachine).toBeNull();
  });

  it('lists what is not proven, and drops a sentence when its evidence arrives', () => {
    const unproven = buildCapabilityRecord(input());
    expect(unproven.notProven.join(' ')).toMatch(/clean Windows standard-user install/i);
    expect(unproven.notProven.join(' ')).toMatch(/consented/i);
    expect(unproven.notProven.join(' ')).toMatch(/restart/i);

    const proven = buildCapabilityRecord(
      input({
        routes: input().routes.map((route) => ({
          ...route,
          cleanMachine: { evidence: `evidence/clean-machine/${route.engine}.json` },
        })),
        proofs: {
          consentedProviderResult: { evidence: 'evidence/consented/opencode.json' },
          restartAndRepeat: { evidence: 'evidence/restart/opencode.json' },
        },
      }),
    );
    expect(proven.notProven).toEqual([]);
  });

  it('produces the same bytes from the same input', () => {
    expect(JSON.stringify(buildCapabilityRecord(input()))).toBe(
      JSON.stringify(buildCapabilityRecord(input())),
    );
  });
});

describe('committed capability record', () => {
  it('equals a fresh build from this tree', async () => {
    const fresh = render(
      buildCapabilityRecord(
        await gatherCapabilityRecordInput(committed.generatedFrom.commit),
      ),
    );
    expect(lf(fresh)).toBe(lf(committedJson));
  });

  it('states this application version and a forty-character commit', () => {
    const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(committed.appVersion).toBe(packageVersion);
    expect(committed.generatedFrom.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('names the guided installations the installer actually offers', () => {
    const installer = new EngineInstaller('capability-record-probe', {
      platform: 'win32',
      arch: 'x64',
    });
    for (const route of committed.routes)
      expect(route.guidedInstall, route.engine).toBe(installer.offer(route.engine).available);
  });

  it('claims no shipped engine, promises no charge and keeps a plain voice', () => {
    for (const entry of strings(committed)) {
      expect(entry, entry).not.toMatch(/codex/i);
      expect(entry, entry).not.toContain('!');
      expect(entry, entry).not.toMatch(/\bno (additional |extra |further )?charges?\b/i);
      expect(entry, entry).not.toMatch(/never (be )?charged|free of charge|without charge/i);
      expect(entry, entry).not.toMatch(
        /Diomedes (ships|includes|provides|bundles|runs) (an? )?(engine|model)\b/i,
      );
    }
  });
});

describe('what the record derives instead of typing by hand', () => {
  const registry = (lines: string[]) =>
    ['      adapter: (engine, file, cwd) => {', ...lines, '      },'].join('\n');

  it('reads each route from the adapter registry the service constructs', () => {
    const source = registry([
      "        if (engine === 'claude-code') return new ClaudeAdapter(file, cwd);",
      "        if (engine === 'opencode') return new OpenCodeAdapter(file, cwd);",
      '        return new OmpAdapter(file, cwd);',
    ]);
    expect(engineAdapters(source, ['claude-code', 'opencode', 'oh-my-pi'])).toEqual({
      'claude-code': 'ClaudeAdapter',
      opencode: 'OpenCodeAdapter',
      // The engine the registry does not name is the one its last line returns.
      'oh-my-pi': 'OmpAdapter',
    });
  });

  it('names no adapter for an engine no registry line constructs', () => {
    const source = registry([
      "        if (engine === 'claude-code') return new ClaudeAdapter(file, cwd);",
      "        if (engine === 'opencode') return new OpenCodeAdapter(file, cwd);",
    ]);
    expect(engineAdapters(source, ['claude-code', 'opencode', 'devin'])).toEqual({
      'claude-code': 'ClaudeAdapter',
      opencode: 'OpenCodeAdapter',
      devin: null,
    });
  });

  it('reports every route in this tree as implemented, from that registry', async () => {
    const gathered = await gatherCapabilityRecordInput(committed.generatedFrom.commit);
    for (const route of gathered.routes) expect(route.source, route.engine).toBe('implemented');
  });
});

describe('the commit a check run may trust', () => {
  // Git's own answer about this checkout, asked independently of the function
  // under test. A CI checkout is shallow by default, and a shallow clone is one
  // of the cases `commitPresent` must answer "cannot tell" for rather than
  // guess: it holds a fraction of the history, so neither "here" nor "absent"
  // would be a fact.
  const shallow =
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
    }).trim() === 'true';

  it('finds the commit the committed record names, or says it cannot tell', async () => {
    expect(await commitPresent(committed.generatedFrom.commit)).toBe(shallow ? null : true);
  });

  it('does not find a commit this repository never held, or says it cannot tell', async () => {
    expect(await commitPresent('a'.repeat(40))).toBe(shallow ? null : false);
  });

  it('calls a malformed commit absent without looking anywhere', async () => {
    expect(await commitPresent('not-a-commit')).toBe(false);
  });
});

describe('which recorded build the record may cite', () => {
  const candidate = (overrides: Record<string, unknown>) => ({
    schemaVersion: 1,
    named: true,
    releaseId: 'diomedes-0.1.4-named',
    appVersion: '0.1.4',
    channel: 'experimental',
    recordedAt: '2026-09-01T00:00:00.000Z',
    build: { baseCommit: 'b'.repeat(40) },
    protocols: { engines: { testedVersions: { opencode: '1.18.4' } } },
    ...overrides,
  });

  it('ignores a newer candidate that was never named', () => {
    // scripts/write-candidate-record.ts names a candidate only when its source
    // was committed, and scripts/write-release-assets.mjs refuses an unnamed
    // one. A local build of uncommitted source must not move this record.
    const chosen = newestReleaseFrom([
      { file: 'evidence/release-candidates/named.json', value: candidate({}) },
      {
        file: 'evidence/release-candidates/local.json',
        value: candidate({
          named: false,
          releaseId: 'diomedes-0.1.5-local',
          recordedAt: '2026-09-20T00:00:00.000Z',
        }),
      },
    ]);
    expect(chosen?.releaseId).toBe('diomedes-0.1.4-named');
  });

  it('says packaged means packaged and recorded here, never published', () => {
    // Nothing in a candidate record states that the build left this computer,
    // so the state this record defines may not claim it did.
    expect(committed.states.packaged).toMatch(/packaged and recorded/i);
    expect(committed.states.packaged).not.toMatch(/publish/i);
  });
});

describe('README adapter table', () => {
  const rows = read('README.md')
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    .map((line) =>
      line
        .slice(1, line.lastIndexOf('|'))
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 4 && cells[0] !== 'Tool');

  it('agrees with the record on every route label and reviewed version', () => {
    expect(rows.length).toBe(committed.routes.length);
    for (const route of committed.routes) {
      const row = rows.find((cells) => cells[0] === route.displayName);
      expect(row, route.engine).toBeDefined();
      expect(row?.[1], route.engine).toBe(route.routeLabel);
      // The table writes the scope and its limits as one cell; the record keeps
      // them apart so a caption can use the scope on its own.
      expect(row?.[2], route.engine).toBe(`${route.taskScope}. ${route.limits}`);
      expect(row?.[3], route.engine).toBe(route.reviewedVersion);
    }
  });

  it('points at the record as the generated source of those facts', () => {
    expect(read('README.md')).toContain('docs/reference/capability-record.json');
  });
});
