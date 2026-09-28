/**
 * OPS-05's archive, without a store or a network: what each file holds, that
 * the account service's parts read back exactly through the strict schema,
 * how a large category is split, and what the credential check finds and
 * skips. The check is tested on the case that made it field by field: a
 * random id that is all digits where it matters and passes the card check.
 */
import { describe, expect, test } from 'vitest';
import { containsSecretLikeText } from '../shared/business-setup';
import type { OrganizationAccessView } from '../shared/business-access';
import type { ConfigurationManifest } from '../shared/configuration';
import {
  EXIT_STEPS,
  EXPORT_FORMATS,
  EXPORT_HISTORY_LIMIT,
  OMITTED_CATEGORIES,
  type OrganizationExportManifest,
} from '../shared/organization-export';
import {
  organizationAccountExportSchema,
  type ReadOrganizationExport,
} from '../services/control-plane/src/organization-export/schema';
import {
  archiveSecretLikePaths,
  assembleArchive,
  secretLikePaths,
  type Archive,
  type LocalRecords,
} from '../server/organization-export';

const ORG = 'organization_2f6d1c1e-9a55-4c7e-b1a8-0c4f3b2e7d10';
const TENANT = 'tenant_5b0e8e2a-3c1d-4f7a-9e2b-6d4c8a1f0b33';
const OWNER = 'person_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const MANAGER = 'person_9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';
const AT = '2026-09-26T22:00:00.000Z';
const FOLDER = 'Exports/business-records-2026-09-26T22-00-00Z';

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
/** The digits with the one check digit that makes them pass the card check. */
const luhnComplete = (digits: string) => `${digits}${[...'0123456789'].find((check) => luhnValid(`${digits}${check}`))}`;

const event = (index: number) => ({
  id: `account_event_${String(index).padStart(6, '0')}`,
  at: new Date(Date.parse(AT) - (1_000 - index) * 60_000).toISOString(),
  kind: 'membership-changed',
  actorPersonId: OWNER,
  targetId: MANAGER,
});

function payload(overrides: Partial<ReadOrganizationExport> = {}): ReadOrganizationExport {
  return {
    v: 1,
    organization: { id: ORG, name: 'Juniper Street Bakery', industry: 'Bakery', tenantId: TENANT, createdAt: '2026-09-01T12:00:00.000Z', createdBy: OWNER },
    exportedAt: AT,
    exportedBy: OWNER,
    people: [
      { personId: OWNER, name: 'Maya Ortiz', role: 'owner', state: 'active', joinedAt: '2026-09-01T12:00:00.000Z', revokedAt: null },
      { personId: MANAGER, name: 'Sam Rivera', role: 'admin', state: 'revoked', joinedAt: '2026-09-02T12:00:00.000Z', revokedAt: '2026-09-20T12:00:00.000Z' },
    ],
    invitations: [{ id: '0123456789abcdef', role: 'member', email: 'new.hire@juniper.test', createdAt: AT, expiresAt: '2026-09-27T22:00:00.000Z', invitedBy: OWNER }],
    access: {
      v: 1, organizationId: ORG, role: 'owner', roleLabel: 'Business owner',
      capabilities: { seePlan: true, managePeople: 'everyone', configure: true },
      state: 'active', planLabel: 'Business', planId: 'business', features: ['nectovia-agent', 'phone-relay'],
      agent: { included: true, reason: '' }, validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2027-09-01T00:00:00.000Z', revision: 3,
      grants: [{
        id: 'grant_7c6b5a49-3827-4165-9f0e-d1c2b3a49586', planId: 'business', planLabel: 'Business', features: ['nectovia-agent', 'phone-relay'],
        source: 'subscription', validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2027-09-01T00:00:00.000Z', state: 'active',
      }],
      checkedAt: AT,
    },
    devices: { included: true, devices: [{ deviceId: 'relay_device_3e2d1c0b-9a87-4654-b321-0fedcba98765', label: 'Front counter', createdAt: AT, lastSeenAt: null }] },
    setupRevisions: [1, 2].map((revision) => ({
      revision,
      writtenAt: `2026-09-2${revision}T12:00:00.000Z`,
      writtenBy: revision === 1 ? OWNER : MANAGER,
      record: {
        v: 1,
        setup: {
          v: 1, organizationId: ORG, tenantId: TENANT, schemaRevision: 1, state: 'drafting',
          answers: {
            name: { questionId: 'name', value: 'Juniper Street Bakery', unknown: false, origin: 'person', at: '2026-09-21T12:00:00.000Z', by: OWNER, prompt: 'What should we call your business, and what work do you do?' },
          },
          cursor: 'industry', startedAt: '2026-09-21T11:00:00.000Z', startedBy: OWNER, updatedAt: `2026-09-2${revision}T12:00:00.000Z`, proposalDigest: null,
        },
      },
    })),
    history: { events: [0, 1, 2].map(event), complete: true },
    ...overrides,
  } as ReadOrganizationExport;
}

const manifestAt = (revision: number, state: string) => ({
  v: 1, owner: { kind: 'organization', organizationId: ORG, tenantId: TENANT }, organizationId: ORG, tenantId: TENANT, revision,
  digest: `sha256:${String(revision).repeat(64).slice(0, 64)}`, state, proposal: { profiles: [] }, readiness: { ready: true, problems: [] },
  stagedAt: AT, stagedBy: OWNER, activatedAt: state === 'active' ? AT : null, activatedBy: state === 'active' ? OWNER : null,
  activationId: null, supersededAt: null, failureReason: null,
}) as unknown as ConfigurationManifest;

const local = (overrides: Partial<LocalRecords> = {}): LocalRecords => ({
  configurations: [manifestAt(1, 'superseded'), manifestAt(2, 'active')],
  access: {
    v: 1, organizationId: ORG, tenantId: TENANT, organizationGeneration: 4, principalGeneration: 2,
    resources: [{ v: 1, organizationId: ORG, id: 'project:project_1', type: 'project', parentId: `organization:${ORG}`, externalId: 'project_1', label: 'Bakery', state: 'active', revision: 1 }],
    profiles: [], assignments: [], workerProfiles: [],
  } as unknown as OrganizationAccessView,
  projects: [{ projectId: 'project_1', name: 'Bakery', folder: 'C:/Users/maya/Nectovia/Bakery' }],
  output: { projectId: 'project_1', projectName: 'Bakery', boundAt: AT, boundBy: OWNER },
  ...overrides,
});

const assemble = (value = payload(), records = local(), partBytes?: number) =>
  assembleArchive(value, records, { at: AT, build: '0.2.1', folder: FOLDER, partBytes });

const read = (archive: Archive, name: string) => {
  const file = archive.files.find((item) => item.path === `${FOLDER}/${name}`);
  if (!file) throw new Error(`${name} is not in the archive`);
  return JSON.parse(file.text) as Record<string, unknown>;
};

/** The account service's answer, put back together from the files, as a reader without this app would. */
function reassemble(archive: Archive): unknown {
  const manifest = read(archive, 'manifest.json') as unknown as OrganizationExportManifest;
  const parts = (category: string) => manifest.files.filter((file) => file.category === category).sort((a, b) => a.part - b.part)
    .map((file) => read(archive, file.path));
  const business = parts('business');
  const history = parts('account-history');
  return {
    v: 1,
    organization: business[0].organization,
    exportedAt: business[0].exportedAt,
    exportedBy: business[0].exportedBy,
    people: business.flatMap((file) => file.people as unknown[]),
    invitations: business[0].invitations,
    access: business[0].plan,
    devices: business[0].phones,
    setupRevisions: parts('setup-revisions').flatMap((file) => file.revisions as unknown[]),
    history: { events: history.flatMap((file) => file.events as unknown[]), complete: history[0].complete },
  };
}

describe('the archive', () => {
  test('each file names its format, source and count, and the manifest says what is left out and how leaving works', () => {
    const archive = assemble();
    expect(archive.files.map((file) => file.path.slice(FOLDER.length + 1))).toEqual([
      'business.json', 'setup-revisions.json', 'account-history.json', 'configuration.json', 'access.json', 'this-computer.json', 'manifest.json', 'README.md',
    ]);
    const manifest = read(archive, 'manifest.json') as unknown as OrganizationExportManifest & { format: string };
    expect(manifest).toMatchObject({
      format: EXPORT_FORMATS.manifest, v: 1, kind: 'nectovia.organization-export',
      organization: { id: ORG, name: 'Juniper Street Bakery', tenantId: TENANT },
      exportedAt: AT, exportedBy: { personId: OWNER, name: 'Maya Ortiz' }, build: '0.2.1',
    });
    expect(manifest.files.map((file) => [file.path, file.category, file.source, file.count, file.part, file.parts])).toEqual([
      ['business.json', 'business', 'account-service', 2, 1, 1],
      ['setup-revisions.json', 'setup-revisions', 'account-service', 2, 1, 1],
      ['account-history.json', 'account-history', 'account-service', 3, 1, 1],
      ['configuration.json', 'configuration', 'this-computer', 2, 1, 1],
      ['access.json', 'configuration', 'this-computer', 1, 1, 1],
      ['this-computer.json', 'this-computer', 'this-computer', 1, 1, 1],
    ]);
    // What is not here, and why, is part of the export itself.
    expect(manifest.omitted).toEqual(OMITTED_CATEGORIES);
    expect(manifest.omitted.map((item) => item.id)).toEqual(['credentials', 'billing', 'plan-notes', 'connected-services', 'other-computers', 'agent-records']);
    expect(manifest.leaving).toEqual(EXIT_STEPS);
    for (const file of manifest.files) expect(read(archive, file.path)).toMatchObject({ format: file.format, part: 1, parts: 1 });

    const readme = archive.files.at(-1)!.text;
    expect(readme).toContain('# Juniper Street Bakery: business records');
    expect(readme).toContain('Taking it changed nothing');
    for (const item of OMITTED_CATEGORIES) expect(readme).toContain(item.title);
    for (const step of EXIT_STEPS) expect(readme).toContain(step.title);
  });

  test("reads back: the account service's parts reassemble into exactly what it answered, through the strict schema", () => {
    const answer = payload();
    expect(organizationAccountExportSchema.parse(reassemble(assemble(answer)))).toEqual(answer);
  });

  test("this computer's configuration reads oldest first and names the active revision", () => {
    const archive = assemble();
    const configuration = read(archive, 'configuration.json');
    expect(configuration.active).toBe(2);
    expect((configuration.revisions as { revision: number }[]).map((item) => item.revision)).toEqual([1, 2]);
    expect(read(archive, 'this-computer.json')).toMatchObject({
      projects: [{ projectId: 'project_1', name: 'Bakery' }],
      output: { projectId: 'project_1' },
    });
  });

  test('a history cut short and a business without phones say so in the manifest and the README', () => {
    const archive = assemble(payload({
      devices: { included: false, reason: 'Reaching this computer from your phone is part of a Business plan.' },
      history: { events: [0, 1].map(event), complete: false },
    }));
    const manifest = read(archive, 'manifest.json') as unknown as OrganizationExportManifest;
    expect(manifest.files.find((file) => file.path === 'account-history.json')!.note)
      .toBe(`Only the newest ${EXPORT_HISTORY_LIMIT.toLocaleString('en-US')} events. The history held more.`);
    expect(manifest.files.find((file) => file.path === 'business.json')!.note).toContain('part of a Business plan');
    expect(read(archive, 'account-history.json').complete).toBe(false);
    expect(archive.files.at(-1)!.text).toContain('Only the newest 20,000 events');
  });

  test('a category too large for one file is split into ordered parts, and one record too large for any file stops the export', () => {
    const events = Array.from({ length: 60 }, (_, index) => event(index));
    const answer = payload({ history: { events, complete: true } });
    const archive = assemble(answer, local(), 4_000);
    const manifest = read(archive, 'manifest.json') as unknown as OrganizationExportManifest;
    const history = manifest.files.filter((file) => file.category === 'account-history');
    expect(history.length).toBeGreaterThan(2);
    expect(history.map((file) => file.path)).toEqual(history.map((_, index) => `account-history-${String(index + 1).padStart(3, '0')}.json`));
    expect(history.map((file) => [file.part, file.parts])).toEqual(history.map((_, index) => [index + 1, history.length]));
    expect(history.reduce((sum, file) => sum + file.count, 0)).toBe(60);
    // Every data file is within the limit; only the manifest and README, never split, are not held to it.
    for (const file of manifest.files) expect(Buffer.byteLength(archive.files.find((item) => item.path === `${FOLDER}/${file.path}`)!.text)).toBeLessThanOrEqual(4_000);
    expect(organizationAccountExportSchema.parse(reassemble(archive))).toEqual(answer);

    let refusal: unknown;
    try {
      assemble(payload(), local(), 600);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ status: 413, details: { code: 'export_too_large' } });
  });
});

describe('the credential check', () => {
  // A random id whose last two groups are all digits and pass the card check.
  const digits = luhnComplete('812345678901234');
  const unlucky = `person_1b2c3d4e-5f6a-4b7c-${digits.slice(0, 4)}-${digits.slice(4)}`;

  test('the case it exists for: an unlucky random id looks like a card number on its own', () => {
    expect(containsSecretLikeText(unlucky)).toBe(true);
    expect(containsSecretLikeText(digits)).toBe(true);
  });

  test('skips ids, times and digests in the fields that hold them, and nowhere else', () => {
    expect(secretLikePaths({ id: unlucky, personId: unlucky, writtenBy: unlucky, targetId: unlucky, memberIds: [unlucky] })).toEqual([]);
    // An invitation code's id is 16 hex characters, and can be 16 digits that pass the card check.
    expect(secretLikePaths({ id: digits, invitations: [{ id: digits }] })).toEqual([]);
    // The same text in a field a person typed is found.
    expect(secretLikePaths({ name: unlucky, label: digits })).toEqual(['$.name', '$.label']);
    // A generated field that holds something that isn't a generated value is still checked.
    expect(secretLikePaths({ id: 'sk_live_0123456789abcdefghijkl' })).toEqual(['$.id']);
  });

  test('an audit actor UUID remains exportable when its digits resemble a card', () => {
    expect(secretLikePaths({ events: [{ actorPersonId: unlucky }] })).toEqual([]);
  });

  test('an audit actor field still refuses card numbers and credentials', () => {
    for (const actorPersonId of [digits, Number(digits), 'sk_live_0123456789abcdefghijkl'])
      expect(secretLikePaths({ actorPersonId })).toEqual(['$.actorPersonId']);
    expect(secretLikePaths({ name: unlucky })).toEqual(['$.name']);
  });

  test('finds a key in a name, a card number in an answer (as text or a number), and a field named like a key', () => {
    const answer = payload();
    answer.people[1] = { ...answer.people[1], name: 'Sam sk_live_0123456789abcdefghijkl' };
    expect(secretLikePaths(answer)).toEqual(['$.people[1].name']);
    const card = luhnComplete('411111111111111');
    expect(secretLikePaths({ answers: { card: { value: `Pay with ${card}` } } })).toEqual(['$.answers.card.value']);
    expect(secretLikePaths({ answers: { budget: { value: Number(card) } } })).toEqual(['$.answers.budget.value']);
    expect(secretLikePaths({ 'api_key=abc123': true })).toEqual(['$ (a field name)']);
  });

  test('a real archive has nothing to find, and one planted value is found by file and path', () => {
    const clean = assemble();
    expect(archiveSecretLikePaths(clean)).toEqual([]);
    const planted = payload();
    if (planted.devices.included) planted.devices.devices[0] = { ...planted.devices.devices[0], label: 'password: hunter22' };
    expect(archiveSecretLikePaths(assemble(planted))).toEqual(['business.json $.phones.devices[0].label']);
  });
});
