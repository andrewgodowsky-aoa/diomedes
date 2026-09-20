import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExternalEngine } from '../../shared/types.js';
import { EXTERNAL_ENGINES, type EngineBinding } from '../../shared/engines.js';

/**
 * The installation a person chose for a route, and the semantic revision that
 * identifies it. This file is Diomedes's own record of a choice, not a
 * credential store: it holds identifiers, a path, a version, a digest and the
 * selected model, and never a token, an account name or provider output.
 *
 * It is written synchronously because `/api/ai/select` is a synchronous call
 * under the settings lock, and because a choice a person made must survive the
 * crash that happens one line later.
 */
export interface StoredBinding {
  binding: EngineBinding;
  /** Moves only when the binding identity, account route or model changes. */
  revision: number;
  /** The tuple `revision` was last moved for. Compared, never displayed. */
  key: string;
  model: string | null;
}

const FILE = 'bindings.json';
const SOURCES = new Set(['managed', 'manual', 'system']);
const ORIGINS = new Set(['explicit', 'adopted']);

function readBinding(value: unknown, engine: ExternalEngine): EngineBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  // A row is authority only for the engine it is filed under, and only when it
  // names a candidate, a path, a version and a digest in the expected shapes.
  if (row.engine !== engine) return undefined;
  if (!text('id') || !text('path') || !text('version') || !text('boundAt')) return undefined;
  if (!/^[a-f0-9]{64}$/.test(text('sha256'))) return undefined;
  if (!SOURCES.has(text('source')) || !ORIGINS.has(text('origin'))) return undefined;
  return {
    id: text('id'),
    engine,
    source: text('source') as EngineBinding['source'],
    path: text('path'),
    version: text('version'),
    sha256: text('sha256'),
    boundAt: text('boundAt'),
    origin: text('origin') as EngineBinding['origin'],
  };
}

/** A synchronous pause, for the bounded rename retry below. */
function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class BindingStore {
  private readonly file: string;
  private readonly rows = new Map<ExternalEngine, StoredBinding>();
  /**
   * Routes whose stored choice exists on disk and could not be read here: a
   * damaged file, a shape this build does not know, or a row written by a newer
   * build. It is a different fact from "this person never chose one", and it is
   * settled only by a new explicit choice.
   */
  private readonly damaged = new Set<ExternalEngine>();
  /** Whether the file on disk is one this build could not fully read. */
  private damagedFile = false;
  constructor(readonly root: string) {
    this.file = path.join(root, FILE);
    this.load();
  }
  private damage(engine: ExternalEngine) {
    this.damaged.add(engine);
    this.damagedFile = true;
  }
  private load() {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Nothing to read and something that cannot be read are different facts.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      for (const engine of EXTERNAL_ENGINES) this.damage(engine);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A damaged file is not authority, and it is not silence either. Which
      // routes it named cannot be known, so every route waits for a choice.
      for (const engine of EXTERNAL_ENGINES) this.damage(engine);
      return;
    }
    const document = parsed as
      | { engines?: Record<string, unknown>; unreadable?: unknown }
      | null;
    const engines = document?.engines;
    if (!engines || typeof engines !== 'object') {
      for (const engine of EXTERNAL_ENGINES) this.damage(engine);
      return;
    }
    // Routes an earlier repair set aside without a new choice, carried forward
    // so a restart does not quietly turn them back into "never chose one".
    const carried = document?.unreadable;
    if (Array.isArray(carried))
      for (const engine of EXTERNAL_ENGINES) if (carried.includes(engine)) this.damage(engine);
    for (const engine of EXTERNAL_ENGINES) {
      const row = engines[engine] as Record<string, unknown> | undefined;
      // No row at all is the ordinary "not chosen yet".
      if (row === undefined) continue;
      if (!row || typeof row !== 'object') {
        this.damage(engine);
        continue;
      }
      const binding = readBinding(row.binding, engine);
      if (!binding) {
        this.damage(engine);
        continue;
      }
      if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) {
        this.damage(engine);
        continue;
      }
      this.rows.set(engine, {
        binding,
        revision: row.revision as number,
        key: typeof row.key === 'string' ? row.key : '',
        model: typeof row.model === 'string' ? row.model : null,
      });
    }
  }
  get(engine: ExternalEngine): StoredBinding | undefined {
    const row = this.rows.get(engine);
    return row ? structuredClone(row) : undefined;
  }
  /** Whether a stored choice for this route exists and cannot be read here. */
  unreadable(engine: ExternalEngine): boolean {
    return this.damaged.has(engine);
  }
  save(engine: ExternalEngine, value: StoredBinding) {
    this.change(engine, () => {
      this.rows.set(engine, structuredClone(value));
      this.damaged.delete(engine);
    });
  }
  clear(engine: ExternalEngine) {
    if (this.rows.has(engine) || this.damaged.has(engine))
      this.change(engine, () => {
        this.rows.delete(engine);
        this.damaged.delete(engine);
      });
  }
  /**
   * A choice Diomedes could not record is a choice it does not claim. If the
   * file cannot be replaced, the in-memory row goes back to what is on disk and
   * the caller hears about it, rather than remembering a binding no restart
   * would find.
   */
  private change(engine: ExternalEngine, apply: () => void) {
    const previous = this.rows.get(engine);
    const wasDamaged = this.damaged.has(engine);
    apply();
    try {
      this.preserve();
      this.write();
    } catch (error) {
      if (previous) this.rows.set(engine, previous);
      else this.rows.delete(engine);
      if (wasDamaged) this.damaged.add(engine);
      throw error;
    }
  }
  /**
   * Move an unreadable record aside before the first record this build writes
   * in its place. A record a newer build wrote is evidence of somebody's
   * choice; it is never deleted to make room for one taken later.
   */
  private preserve() {
    if (!this.damagedFile) return;
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(this.file, `${this.file}.unreadable-${stamp}`);
    } catch (error) {
      // Already gone is the outcome this wanted. Anything else means the record
      // is still there, so the new choice is not written over it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.damagedFile = false;
  }
  private write() {
    const document = {
      version: 1,
      engines: Object.fromEntries([...this.rows].map(([engine, row]) => [engine, row])),
      // Written only while some route is still waiting for a choice, so an
      // ordinary record stays exactly the shape an older build reads.
      ...(this.damaged.size > 0 ? { unreadable: [...this.damaged] } : {}),
    };
    fs.mkdirSync(this.root, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    // On Windows a reader holding the destination open denies the rename for a
    // moment. Retry within a bounded window; the destination keeps its previous
    // complete content until the replacement lands, so it is never partial.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, this.file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 9 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
          try {
            fs.rmSync(temporary, { force: true });
          } catch {
            // The temporary file is not the record; leaving it changes nothing.
          }
          throw error;
        }
        pause(20);
      }
    }
  }
}
