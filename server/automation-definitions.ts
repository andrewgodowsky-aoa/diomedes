/**
 * Automations Milestone B: the stored, versioned definition and this computer's
 * heartbeat.
 *
 *   <data>/workspaces/automations/definitions/<organizationId>.json
 *   <data>/workspaces/automation-host.json
 *
 * Milestone A derived the definition from the active setup. B stores one,
 * because a schedule needs somewhere to live: its revisions (an edit adds one
 * and never rewrites another), whether it is on, paused or off and under whose
 * recorded authority, every change as an act, and the deduplicated attention
 * items the scheduler raised. Nothing is pruned (decision 10). A file from
 * another contract version is refused for that organization and left alone,
 * as the occurrence file is.
 *
 * The host record is the scheduler's heartbeat. It is the only thing "last
 * known" means on the Automations screen: this computer cannot announce its
 * own outage, so nothing here claims to (A03).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_DEFINITION_VERSION,
  type AutomationDefinition,
  type HostRecord,
  type StoredDefinitions,
} from '../shared/automations.js';
import { absent, ApiError } from './paths.js';
import { jsonWrite, readJson } from './store.js';
import { migrateRecord } from './migrations/framework.js';
import { AUTOMATION_DEFINITIONS } from './migrations/registry.js';

const ORGANIZATION_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

const refuse = (status: number, message: string, code: string) =>
  new ApiError(status, message, { code });

/**
 * One file per organization and an in-memory map as the read path, like the
 * occurrence store. Callers hold `store.locked()`.
 */
export class AutomationDefinitions {
  private readonly files = new Map<string, AutomationDefinition[]>();
  private readonly unreadable = new Set<string>();

  constructor(private readonly dataDir: string) {}

  private get root() {
    return path.join(this.dataDir, 'workspaces', 'automations', 'definitions');
  }

  private file(organizationId: string) {
    if (!ORGANIZATION_FILE.test(organizationId))
      throw refuse(404, 'That business workspace does not exist here.', 'organization_not_found');
    return path.join(this.root, `${organizationId}.json`);
  }

  async init(): Promise<void> {
    this.files.clear();
    this.unreadable.clear();
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if (!absent(error)) throw error;
      names = [];
    }
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      const organizationId = name.slice(0, -'.json'.length);
      let stored: StoredDefinitions | null;
      try {
        stored = await readJson<StoredDefinitions | null>(path.join(this.root, name), () => null);
      } catch {
        stored = null;
      }
      // Through the migration framework (H21): one version so far, so this is
      // the refusal of a newer file, which is left untouched.
      try {
        if (stored) migrateRecord(AUTOMATION_DEFINITIONS, stored);
      } catch {
        stored = null;
      }
      if (
        !stored ||
        stored.v !== AUTOMATION_DEFINITION_VERSION ||
        stored.organizationId !== organizationId ||
        !Array.isArray(stored.definitions) ||
        stored.definitions.some((item) => item?.v !== AUTOMATION_DEFINITION_VERSION)
      ) {
        console.warn(`The automation definition ${name} was written by another build and was left alone.`);
        this.unreadable.add(organizationId);
        continue;
      }
      this.files.set(organizationId, structuredClone([...stored.definitions]));
    }
  }

  /** Whether this organization's file could not be read. Its schedules never run. */
  isUnreadable(organizationId: string) {
    return this.unreadable.has(organizationId);
  }

  private readable(organizationId: string) {
    if (this.unreadable.has(organizationId))
      throw refuse(
        409,
        'This business’s automation definition was written by another version of Diomedes, so it was left untouched.',
        'automation_definition_unreadable',
      );
  }

  organizations(): string[] {
    return [...this.files.keys()];
  }

  get(organizationId: string, id: string): AutomationDefinition | null {
    this.readable(organizationId);
    const found = this.files.get(organizationId)?.find((item) => item.id === id);
    return found ? structuredClone(found) : null;
  }

  list(organizationId: string): AutomationDefinition[] {
    this.readable(organizationId);
    return structuredClone(this.files.get(organizationId) ?? []);
  }

  /** Insert or replace one definition by id. Never removes one. */
  async put(definition: AutomationDefinition): Promise<AutomationDefinition> {
    const organizationId = definition.organizationId;
    const target = this.file(organizationId);
    const current = this.list(organizationId);
    const index = current.findIndex((item) => item.id === definition.id);
    const next =
      index === -1
        ? [...current, definition]
        : current.map((item, at) => (at === index ? definition : item));
    await jsonWrite(target, {
      v: AUTOMATION_DEFINITION_VERSION,
      organizationId,
      definitions: next,
    } satisfies StoredDefinitions);
    this.files.set(organizationId, structuredClone(next));
    return structuredClone(definition);
  }
}

/**
 * This computer, as the scheduler knows it: a stable id minted once per data
 * folder, a name, and the last heartbeat. `previousSeenAt` is the heartbeat
 * before the latest one: after a restart or a sleep, when the computer was last
 * seen before the slots it missed.
 */
export class AutomationHost {
  private record: HostRecord | null = null;
  previousSeenAt: string | null = null;

  constructor(private readonly dataDir: string) {}

  private get file() {
    return path.join(this.dataDir, 'workspaces', 'automation-host.json');
  }

  async init(at: string): Promise<HostRecord> {
    const saved = await readJson<HostRecord | null>(this.file, () => null).catch(() => null);
    const valid =
      saved &&
      saved.v === 1 &&
      typeof saved.hostId === 'string' &&
      /^H-[A-Za-z0-9-]{8,64}$/.test(saved.hostId) &&
      typeof saved.lastSeenAt === 'string';
    this.previousSeenAt = valid ? saved.lastSeenAt : null;
    this.record = valid
      ? { ...saved, name: os.hostname().slice(0, 120) || saved.name }
      : {
          v: 1,
          hostId: `H-${randomUUID()}`,
          name: os.hostname().slice(0, 120) || 'This computer',
          firstSeenAt: at,
          lastSeenAt: at,
        };
    // The saved heartbeat stays until the first pass beats, so that pass can say
    // when the computer was last seen before it started.
    await jsonWrite(this.file, this.record);
    return this.record;
  }

  get current(): HostRecord {
    if (!this.record) throw new Error('The automation host was used before init().');
    return this.record;
  }

  get ready() {
    return this.record !== null;
  }

  async beat(at: string) {
    if (!this.record) return;
    this.previousSeenAt = this.record.lastSeenAt;
    this.record = { ...this.record, lastSeenAt: at };
    await jsonWrite(this.file, this.record);
  }
}
