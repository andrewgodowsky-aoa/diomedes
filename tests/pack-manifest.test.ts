import { describe, expect, test } from 'vitest';
import {
  canonicalJson,
  canonicalPackBytes,
  industryVariantPackManifest,
  manifestFromCapabilityPack,
  manifestProblems,
  packManifestBodySchema,
  PACK_HOST_CONTRACT_REVISION,
  resolvePacks,
  weeklyBriefPackManifest,
  type PackManifestBody,
} from '../shared/pack-manifest.js';
import {
  CAPABILITY_PACK_CONTRACT_VERSION,
  SMALL_BUSINESS_PACK,
  SOFTWARE_ENGINEERING_PACK,
} from '../shared/capability-packs.js';
import { compareVersions, isRange, maxSatisfying, satisfies } from '../shared/semver.js';

/** A minimal valid manifest body; tests override one field at a time. */
function body(overrides: Partial<PackManifestBody> = {}): PackManifestBody {
  return {
    schemaVersion: 1,
    id: 'acme.bookkeeping',
    version: '1.0.0',
    name: 'Bookkeeping',
    publisher: { id: 'acme', name: 'Acme' },
    description: 'Monthly close playbooks.',
    compatibility: { contract: '^1.0.0' },
    contributions: { tools: [], agents: [], rules: [], context: [], workflows: [], ui: [] },
    permissions: { requested: [], grantsAuthority: false },
    dependencies: [],
    files: [],
    ...overrides,
  };
}
const pack = (id: string, version: string, deps: Record<string, string> = {}, contract = '^1.0.0') =>
  body({
    id,
    version,
    compatibility: { contract },
    dependencies: Object.entries(deps).map(([dep, range]) => ({ id: dep, range })),
  });

describe('semver, the part packs use', () => {
  test.each([
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['1.2.9', '~1.2.0', true],
    ['1.3.0', '~1.2.0', false],
    ['1.4.0', '>=1.2.0 <2.0.0', true],
    ['1.0.0', '1.x', true],
    ['3.1.0', '*', true],
    ['1.0.0', '1.0.0', true],
    ['1.0.1', '1.0.0', false],
    ['2.5.0', '^1.0.0 || ^2.0.0', true],
    ['2.0.0-beta', '^1.0.0', false],
    ['2.0.0-beta', '>=2.0.0-alpha', true],
  ])('%s satisfies %s: %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  test('anything outside the grammar is refused rather than guessed at', () => {
    for (const range of ['', 'latest', '^^1.0.0', '1.0.0 -', 'v1', '>= 1.0.0', '1.0.0 ||'])
      expect(isRange(range), range).toBe(false);
    expect(satisfies('1.0.0', 'latest')).toBe(false);
  });

  test('ordering and newest-satisfying are deterministic', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(maxSatisfying(['1.0.0', '1.4.0', '2.0.0', '1.3.9'], '^1.0.0')).toBe('1.4.0');
    expect(maxSatisfying(['2.0.0'], '^1.0.0')).toBeNull();
  });
});

describe('the manifest schema', () => {
  test('a minimal manifest is valid, and the digest is required on the stored form', () => {
    expect(manifestProblems(body(), false)).toEqual([]);
    expect(manifestProblems(body())).toEqual([expect.stringContaining('digest')]);
    expect(manifestProblems({ ...body(), digest: `sha256:${'a'.repeat(64)}` })).toEqual([]);
    expect(manifestProblems({ ...body(), digest: 'sha256:short' })[0]).toContain('digest');
  });

  test.each<[string, unknown, string]>([
    ['an unknown schema version', { schemaVersion: 2 }, 'schemaVersion'],
    ['a free-text id', { id: 'Bookkeeping Pack' }, 'id'],
    ['a version that is not X.Y.Z', { version: '1.0' }, 'version'],
    ['a range nobody can read', { compatibility: { contract: 'latest' } }, 'compatibility.contract'],
    [
      'a pack that grants authority',
      { permissions: { requested: [], grantsAuthority: true } },
      'permissions.grantsAuthority',
    ],
    [
      'an outward capability request',
      {
        permissions: {
          requested: [{ capability: 'send-email', reason: 'To send the invoices.' }],
          grantsAuthority: false,
        },
      },
      'outward capability send-email',
    ],
    [
      'a tool using a capability the pack never requested',
      {
        contributions: {
          ...body().contributions,
          tools: [
            { id: 'ledger', name: 'Ledger', description: 'Reads it.', effect: 'read', uses: ['read-bank'] },
          ],
        },
      },
      'uses read-bank, which the pack does not request',
    ],
    [
      'an Agent carrying authority',
      {
        contributions: {
          ...body().contributions,
          agents: [{ id: 'clerk', name: 'Clerk', role: 'Files.', grantsAuthority: true }],
        },
      },
      'grantsAuthority',
    ],
    [
      'a workflow that acts',
      {
        contributions: {
          ...body().contributions,
          workflows: [
            { id: 'pay', kind: 'procedure', name: 'Pay', description: 'Pays.', mode: 'ask', acts: true },
          ],
        },
      },
      'acts',
    ],
    [
      'an instruction file given as a path',
      {
        contributions: {
          ...body().contributions,
          rules: [{ id: 'x', kind: 'instruction-file', file: '../AGENTS.md', description: 'x' }],
        },
      },
      'plain file name',
    ],
    ['a UI surface of its own', { contributions: { ...body().contributions, ui: [{ id: 'x', surface: 'ide', label: 'IDE' }] } }, 'surface'],
    ['a self-dependency', { dependencies: [{ id: 'acme.bookkeeping', range: '^1.0.0' }] }, 'depend on itself'],
    ['a file that escapes', { files: [{ path: '../x.md', sha256: 'a'.repeat(64), bytes: 1 }] }, 'files'],
    ['an unknown field', { runtime: 'node' }, 'runtime'],
  ])('refuses %s', (_label, change, expected) => {
    const problems = manifestProblems({ ...body(), ...(change as object) }, false);
    expect(problems.join(' ')).toContain(expected);
  });

  test('canonical bytes ignore key order and never include the digest', () => {
    const a = body();
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, item]) => [key, reverse(item)]),
            )
          : value;
    const reordered = reverse(a) as PackManifestBody;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(a));
    expect(canonicalPackBytes(reordered)).toBe(canonicalPackBytes(a));
    expect(canonicalPackBytes({ ...a, digest: `sha256:${'b'.repeat(64)}` } as never)).toBe(
      canonicalPackBytes(a),
    );
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('the bundled packs, expressed as manifests', () => {
  test('the host contract revision tracks the runtime pack contract major', () => {
    expect(PACK_HOST_CONTRACT_REVISION).toBe(`${CAPABILITY_PACK_CONTRACT_VERSION}.0.0`);
  });

  test('Software Engineering keeps its id, version, needs, instruction files and UI', () => {
    const manifest = packManifestBodySchema.parse(manifestFromCapabilityPack(SOFTWARE_ENGINEERING_PACK));
    expect(manifest.id).toBe(SOFTWARE_ENGINEERING_PACK.id);
    expect(manifest.version).toBe(SOFTWARE_ENGINEERING_PACK.version);
    expect(manifest.permissions.requested.map((r) => r.capability)).toEqual(
      SOFTWARE_ENGINEERING_PACK.needs.map((n) => n.capability),
    );
    expect(
      manifest.contributions.rules.flatMap((rule) => (rule.kind === 'instruction-file' ? [rule.file] : [])),
    ).toEqual([...SOFTWARE_ENGINEERING_PACK.instructionFiles]);
    expect(manifest.contributions.ui).toEqual(SOFTWARE_ENGINEERING_PACK.ui);
    expect(manifest.permissions.grantsAuthority).toBe(false);
  });

  test('Small Business keeps every skill as a read-and-draft workflow', () => {
    const manifest = packManifestBodySchema.parse(manifestFromCapabilityPack(SMALL_BUSINESS_PACK));
    expect(manifest.contributions.workflows.map((w) => w.id)).toEqual(
      SMALL_BUSINESS_PACK.skills.map((s) => s.id),
    );
    expect(manifest.contributions.workflows.every((w) => w.acts === false)).toBe(true);
    expect(manifest.permissions.requested).toHaveLength(SMALL_BUSINESS_PACK.needs.length);
  });

  test('an industry variant depends on the weekly brief and resolves against it', () => {
    const brief = packManifestBodySchema.parse(weeklyBriefPackManifest());
    const variant = packManifestBodySchema.parse(
      industryVariantPackManifest({
        id: 'carpentry',
        label: 'Carpentry and cabinetry',
        outputLabel: 'Weekly project brief',
        scopeLabel: 'Project and shop exports',
        guidanceText: 'Cite project and shop exports.',
        contractVersion: 1,
        files: [{ path: 'variant.json', sha256: 'c'.repeat(64), bytes: 10 }],
      }),
    );
    expect(variant.id).toBe('diomedes.industry.carpentry');
    expect(variant.permissions.requested).toEqual([]);
    const resolution = resolvePacks({
      requests: [{ id: variant.id, range: '^1.0.0' }],
      available: [brief, variant],
    });
    expect(resolution).toEqual({
      ok: true,
      order: [
        { id: 'diomedes.weekly-brief', version: '1.0.0', digest: '' },
        { id: 'diomedes.industry.carpentry', version: '1.0.0', digest: '' },
      ],
    });
  });
});

describe('dependency resolution: one table, each refusal named', () => {
  test('picks the newest admissible version and orders dependencies first', () => {
    const result = resolvePacks({
      requests: [{ id: 'a.app', range: '^1.0.0' }],
      available: [
        pack('a.app', '1.0.0', { 'a.lib': '^1.0.0' }),
        pack('a.app', '1.2.0', { 'a.lib': '^1.1.0' }),
        pack('a.lib', '1.0.0'),
        pack('a.lib', '1.1.0'),
        pack('a.lib', '1.3.0'),
        pack('a.lib', '2.0.0'),
      ],
    });
    expect(result.ok && result.order.map((p) => `${p.id}@${p.version}`)).toEqual([
      'a.lib@1.3.0',
      'a.app@1.2.0',
    ]);
  });

  test('the same input always resolves the same way, whatever order it arrives in', () => {
    const available = [
      pack('a.app', '1.0.0', { 'a.lib': '^1.0.0', 'a.util': '^1.0.0' }),
      pack('a.lib', '1.0.0', { 'a.util': '^1.0.0' }),
      pack('a.util', '1.0.0'),
      pack('a.util', '1.1.0'),
    ];
    const one = resolvePacks({ requests: [{ id: 'a.app', range: '*' }], available });
    const two = resolvePacks({ requests: [{ id: 'a.app', range: '*' }], available: [...available].reverse() });
    expect(two).toEqual(one);
    expect(one.ok && one.order.map((p) => p.id)).toEqual(['a.util', 'a.lib', 'a.app']);
  });

  test.each<[string, Parameters<typeof resolvePacks>[0], string, RegExp]>([
    [
      'missing dependency',
      { requests: [{ id: 'a.app', range: '^1.0.0' }], available: [pack('a.app', '1.0.0', { 'a.lib': '^1.0.0' })] },
      'missing',
      /a\.lib is not available \(a\.app@1\.0\.0 needs \^1\.0\.0\)/,
    ],
    [
      'no version in range',
      {
        requests: [{ id: 'a.app', range: '^1.0.0' }],
        available: [pack('a.app', '1.0.0', { 'a.lib': '^2.0.0' }), pack('a.lib', '1.0.0')],
      },
      'missing',
      /No available version of a\.lib satisfies .*Available: 1\.0\.0/,
    ],
    [
      'version conflict',
      {
        requests: [
          { id: 'a.one', range: '*' },
          { id: 'a.two', range: '*' },
        ],
        available: [
          pack('a.one', '1.0.0', { 'a.lib': '^1.0.0' }),
          pack('a.two', '1.0.0', { 'a.lib': '^2.0.0' }),
          pack('a.lib', '1.0.0'),
          pack('a.lib', '2.0.0'),
        ],
      },
      'version-conflict',
      /No version of a\.lib satisfies every range: a\.one@1\.0\.0 needs \^1\.0\.0; a\.two@1\.0\.0 needs \^2\.0\.0/,
    ],
    [
      'cycle',
      {
        requests: [{ id: 'a.one', range: '*' }],
        available: [
          pack('a.one', '1.0.0', { 'a.two': '*' }),
          pack('a.two', '1.0.0', { 'a.three': '*' }),
          pack('a.three', '1.0.0', { 'a.one': '*' }),
        ],
      },
      'cycle',
      /a\.one → a\.two → a\.three → a\.one/,
    ],
    [
      'incompatible contract revision',
      {
        requests: [{ id: 'a.app', range: '*' }],
        available: [pack('a.app', '1.0.0', {}, '^2.0.0')],
      },
      'incompatible-contract',
      /written for pack contract \^2\.0\.0; this Diomedes serves 1\.0\.0/,
    ],
  ])('%s', (_label, input, code, message) => {
    const result = resolvePacks(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0].code).toBe(code);
    expect(result.refusals[0].message).toMatch(message);
  });

  test('an incompatible newest version is passed over for a compatible older one', () => {
    const result = resolvePacks({
      requests: [{ id: 'a.app', range: '*' }],
      available: [pack('a.app', '1.0.0'), pack('a.app', '2.0.0', {}, '^2.0.0')],
    });
    expect(result.ok && result.order[0].version).toBe('1.0.0');
  });
});
