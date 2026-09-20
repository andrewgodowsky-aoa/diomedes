/**
 * Hostile verification of the capability record and what reads it.
 *
 * The record exists so three states stop collapsing into each other, and
 * `npm run capability-record:check` is what keeps the committed file honest.
 * These tests try to make it claim proof that does not exist, and ask whether
 * the one fact it records about its own release reaches any reader.
 *
 * Read-only: no product file is written and no record is regenerated.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  type CapabilityRecordInput,
} from '../shared/capability-record.js';
import { gatherCapabilityRecordInput, render } from '../scripts/write-capability-record.js';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const committedText = read('docs/reference/capability-record.json');
const committed = JSON.parse(committedText) as CapabilityRecord;
const readme = read('README.md');

const fresh = async () =>
  render(buildCapabilityRecord(await gatherCapabilityRecordInput(committed.generatedFrom.commit)));

describe('what --check can and cannot catch', () => {
  it('catches a hand-written clean-machine proof', async () => {
    const tampered = JSON.parse(committedText) as CapabilityRecord;
    tampered.routes[0].states.cleanMachine = { evidence: 'evidence/never-happened.md' };
    expect(lf(`${JSON.stringify(tampered, null, 2)}\n`)).not.toBe(lf(await fresh()));
  });

  it('catches a reviewed version that no longer matches the service', async () => {
    const tampered = JSON.parse(committedText) as CapabilityRecord;
    tampered.routes[0].reviewedVersion = '99.99.99';
    expect(lf(`${JSON.stringify(tampered, null, 2)}\n`)).not.toBe(lf(await fresh()));
  });

  it('catches a route label that no longer matches the route profiles', async () => {
    const tampered = JSON.parse(committedText) as CapabilityRecord;
    tampered.routes[1].routeLabel = 'Any OpenCode account';
    expect(lf(`${JSON.stringify(tampered, null, 2)}\n`)).not.toBe(lf(await fresh()));
  });

  it('catches a deleted not-proven sentence', async () => {
    const tampered = JSON.parse(committedText) as CapabilityRecord;
    tampered.notProven = [];
    expect(lf(`${JSON.stringify(tampered, null, 2)}\n`)).not.toBe(lf(await fresh()));
  });

  it('cannot catch a wrong commit, because --check takes that field from the file', async () => {
    // scripts/write-capability-record.ts:191-192 reuses the committed
    // `generatedFrom.commit` in --check. Two records that name different
    // commits are therefore both self-consistent for the same tree.
    const input = await gatherCapabilityRecordInput('a'.repeat(40));
    const one = render(buildCapabilityRecord(input));
    const other = render(buildCapabilityRecord({ ...input, generatedFrom: 'b'.repeat(40) }));
    expect(one).not.toBe(other);
    // Nothing in the tree ties either value to a commit that exists.
    expect(JSON.parse(one).generatedFrom.commit).toBe('a'.repeat(40));
  });
});

describe('proof that does not exist', () => {
  it('cannot be made to claim a clean machine through any input the script supplies', async () => {
    const input = await gatherCapabilityRecordInput(committed.generatedFrom.commit);
    for (const route of input.routes) expect(route.cleanMachine).toBeNull();
    const record = buildCapabilityRecord(input);
    for (const route of record.routes) expect(route.states.cleanMachine).toBeNull();
  });

  it('reports packaged from a release record alone, never from the source tree', () => {
    const input: CapabilityRecordInput = {
      appVersion: '9.9.9',
      generatedFrom: 'c'.repeat(40),
      routes: [
        {
          engine: 'opencode',
          displayName: 'OpenCode',
          routeLabel: 'OpenCode Go',
          taskScope: 'Text and reviewed proposals',
          limits: 'Tools, plugins and MCP are off.',
          reviewedVersion: '1.18.4',
          guidedInstall: true,
          source: 'implemented',
          cleanMachine: null,
        },
      ],
      release: null,
    };
    expect(buildCapabilityRecord(input).routes[0].states.packaged).toBeNull();
  });

  it('says in every packaged note that no request through that route was recorded', () => {
    for (const route of committed.routes) {
      if (!route.states.packaged) continue;
      expect(route.states.packaged.note).toContain('does not record a request through this route');
    }
  });
});

describe('what the record is hand-typed rather than derived from', () => {
  it('states every route as implemented without consulting an adapter', async () => {
    // scripts/write-capability-record.ts:134 writes the literal
    // `source: 'implemented'` for every engine in EXTERNAL_ENGINES. Removing
    // an adapter from server/engines/ would not move this field.
    const input = await gatherCapabilityRecordInput(committed.generatedFrom.commit);
    expect(new Set(input.routes.map((route) => route.source))).toEqual(new Set(['implemented']));
  });
});

describe('the one release fact, and whether a reader ever sees it', () => {
  it('records that the published build is not this source version', () => {
    expect(committed.release).not.toBeNull();
    expect(committed.release!.appVersionMatchesSource).toBe(false);
    expect(committed.release!.appVersion).not.toBe(committed.appVersion);
  });

  it('is said somewhere a person reads, not only in the file they do not open', () => {
    // The README sends people to the releases page, says this tree is 0.1.5
    // and never says the newest published build is an older version. Naming
    // the number there is additionally constrained by
    // tests/engine-routes.test.ts:81-85, which rejects any version literal in
    // the README other than package.json's.
    expect(readme).toMatch(
      /(published|release[ds]?)[^.]{0,80}(older|earlier|previous) version|no published build of this version/i,
    );
  });

  it('reaches the README a downloader actually opens', () => {
    // scripts/write-release-assets.mjs writes the README.txt beside the
    // installer. It is generated from the release record, not from the
    // capability record, so nothing it prints is bound to `notProven`.
    const generator = read('scripts/write-release-assets.mjs');
    expect(generator).toContain('capability-record');
  });

  it('does not let a release README assert a verification it was not given', () => {
    // The verified-on-these-bytes block interpolates test counts but states
    // the desktop smoke, the installer's install, repair and uninstall, and
    // the installed runtime as literals that are printed whatever happened.
    const generator = read('scripts/write-release-assets.mjs');
    const hardcoded = "the packaged desktop smoke; the\n  installer's install, same-version repair and uninstall; the installed runtime.";
    expect(lf(generator)).not.toContain(hardcoded);
  });

  it('does not name Codex beside the adapter routes the record carries', () => {
    // AGENTS.md: nothing in the tree claims a capability is shipped that is
    // not. The capability record carries five adapter routes and no Codex row.
    const generator = read('scripts/write-release-assets.mjs');
    expect(committed.routes.map((route) => route.engine)).not.toContain('codex');
    expect(generator).not.toMatch(/sign-in an engine already has \(Codex/);
  });
});
