import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExternalEngine } from '../../shared/types.js';
import { EXTERNAL_ENGINES, type EngineBinding } from '../../shared/engines.js';
import { EngineError } from './process.js';

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

/**
 * The longest the calling thread may be held while a reader denies the rename.
 *
 * This wait is synchronous, and in the desktop application the caller is the
 * Electron main process. It stays synchronous because the write is: a choice
 * is recorded under the same settings lock that `/api/ai/select` holds, and it
 * must be on disk before the call that made it returns. So the cost is bounded
 * by the clock rather than by a count of attempts, and the budget is small
 * enough that a person cannot see it.
 */
export const RENAME_RETRY_BUDGET_MS = 200;
const RENAME_RETRY_PAUSE_MS = 20;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

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
  /**
   * Whether the file could not be read at all. A document that was read and
   * not understood and a file that was never read are different facts: the
   * first is evidence about its contents, the second is evidence about
   * nothing, so no part of it may be moved aside or written over.
   */
  private unread = false;
  constructor(readonly root: string) {
    this.file = path.join(root, FILE);
    this.load();
  }
  private damage(engine: ExternalEngine) {
    this.damaged.add(engine);
    this.damagedFile = true;
  }
  /**
   * Read the record, waiting out a reader that denies it for the same bounded
   * clock the write spends. On Windows a scan or a backup holds a file open
   * for a moment, and one such moment used to cost every route its choice for
   * the rest of the session.
   */
  private text(): { bytes: string } | { absent: true } | { denied: true } {
    const deadline = Date.now() + RENAME_RETRY_BUDGET_MS;
    for (;;) {
      try {
        return { bytes: fs.readFileSync(this.file, 'utf8') };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Nothing to read and something that cannot be read are different facts.
        if (code === 'ENOENT' || code === 'ENOTDIR') return { absent: true };
        if (!code || !RENAME_RETRY_CODES.has(code) || Date.now() + RENAME_RETRY_PAUSE_MS > deadline)
          return { denied: true };
        pause(RENAME_RETRY_PAUSE_MS);
      }
    }
  }
  private load() {
    this.rows.clear();
    this.damaged.clear();
    this.damagedFile = false;
    this.unread = false;
    const read = this.text();
    if ('absent' in read) return;
    if ('denied' in read) {
      // Every route waits, because what each one chose is unknown — but
      // nothing here is damaged, and nothing may be set aside on its strength.
      this.unread = true;
      for (const engine of EXTERNAL_ENGINES) this.damaged.add(engine);
      return;
    }
    const text = read.bytes;
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
    // These bytes are this build's own and were read exactly as written, so
    // they are not a record to set aside: the next choice replaces them.
    const carried = document?.unreadable;
    if (Array.isArray(carried))
      for (const engine of EXTERNAL_ENGINES)
        if (carried.includes(engine)) this.damaged.add(engine);
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
  /**
   * Whether every part of the record is one this build read as written. A
   * revision a check merely observed is held rather than written while this is
   * false, so no observation ever moves an unreadable record aside.
   */
  intact(): boolean {
    return !this.unread && this.damaged.size === 0;
  }
  /**
   * Try the read again for a record an earlier fault denied, and answer
   * whether that changed anything. A transient denial must not need a restart
   * to clear, so the routes that read it call this before they read it.
   */
  refresh(): boolean {
    if (!this.unread) return false;
    this.load();
    return !this.unread;
  }
  /**
   * Move a row in memory without touching the record on disk, for a revision
   * that was observed rather than chosen. The next explicit choice writes it
   * along with that choice. Only reachable while some row is unreadable, and
   * never while the file itself is unread, because then there is no row to
   * move.
   */
  hold(engine: ExternalEngine, value: StoredBinding) {
    this.rows.set(engine, structuredClone(value));
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
    this.recover();
    const previous = this.rows.get(engine);
    const wasDamaged = this.damaged.has(engine);
    apply();
    try {
      this.commit();
    } catch (error) {
      if (previous) this.rows.set(engine, previous);
      else this.rows.delete(engine);
      if (wasDamaged) this.damaged.add(engine);
      throw error;
    }
  }
  /**
   * A record this build has not read is not a record it may replace. The read
   * is tried again first, because the reader that denied it is usually gone a
   * moment later; a read that still fails refuses the save, rather than
   * setting aside, or writing over, a file whose contents nobody has seen —
   * which would take every other route's choice with it.
   */
  private recover() {
    if (!this.unread) return;
    this.load();
    if (this.unread)
      throw new EngineError(
        'RECORD_UNREADABLE',
        'Diomedes could not read the record of the installations you chose, so it did not replace it. Close anything scanning this folder, then choose again.',
        false,
        'runtime-verification',
      );
  }
  /**
   * Put the replacement on disk, in the one order that never leaves a person
   * with no record at all: stage the replacement first, then set an unreadable
   * original aside, then move the replacement into its place. A replacement
   * that cannot be staged leaves the original exactly where it was, and a
   * rename that fails after the original moved puts the original back.
   *
   * The alternative — move first, write second — deletes the evidence that
   * somebody chose anything whenever the second step fails, and a record that
   * is simply absent reads as "this person never chose one", which is what
   * lets a recommendation be adopted on their behalf.
   */
  private commit() {
    const temporary = this.stage();
    let aside: string | undefined;
    try {
      aside = this.preserve();
      this.place(temporary);
    } catch (error) {
      // Best effort: the bytes are beside the record either way, but a person
      // who restarts now must still meet a record this build cannot read
      // rather than one that is missing.
      if (aside)
        try {
          fs.renameSync(aside, this.file);
        } catch {
          // The sidecar still holds the bytes, and the state in memory still
          // says this route is waiting for a choice.
        }
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // The temporary file is not the record; leaving it changes nothing.
      }
      throw error;
    }
    // The record on disk is now one this build wrote and can read.
    this.damagedFile = false;
  }
  /**
   * Move an unreadable record aside, once its replacement is staged. A record a
   * newer build wrote is evidence of somebody's choice; it is never deleted to
   * make room for one taken later.
   */
  private preserve(): string | undefined {
    if (!this.damagedFile) return undefined;
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const aside = `${this.file}.unreadable-${stamp}`;
    try {
      fs.renameSync(this.file, aside);
    } catch (error) {
      // Already gone is the outcome this wanted. Anything else means the record
      // is still there, so the new choice is not written over it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
    return aside;
  }
  /** Write the replacement beside the record, whole, before anything moves. */
  private stage(): string {
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
    return temporary;
  }
  /** Move the staged replacement into place, inside the wait budget above. */
  private place(temporary: string) {
    // On Windows a reader holding the destination open denies the rename for a
    // moment. Retry until the budget above is spent; the destination keeps its
    // previous complete content until the replacement lands, so it is never
    // partial, and the process is never held past that budget.
    const deadline = Date.now() + RENAME_RETRY_BUDGET_MS;
    for (;;) {
      try {
        fs.renameSync(temporary, this.file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !RENAME_RETRY_CODES.has(code) || Date.now() + RENAME_RETRY_PAUSE_MS > deadline)
          throw error;
        pause(RENAME_RETRY_PAUSE_MS);
      }
    }
  }
}
