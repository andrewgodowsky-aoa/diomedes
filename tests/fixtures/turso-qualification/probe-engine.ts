/**
 * NC-TS TS00 (DIO-227): one asynchronous probe surface over the reference node:sqlite driver and
 * a pinned Turso promise driver. Test-only. The production memory store and its asynchronous
 * facade belong to TS01 (DIO-228); nothing here stores memory.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export type Row = Record<string, unknown>;

export interface ProbeEngine {
  /** What was loaded. Identity comes from this, never from what the engine says about itself. */
  readonly artifact: string;
  exec(sql: string): Promise<void>;
  all(sql: string, ...params: unknown[]): Promise<Row[]>;
  get(sql: string, ...params: unknown[]): Promise<Row | undefined>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  inTransaction(): boolean;
  close(): Promise<void>;
}

export interface OpenOptions {
  readonly?: boolean;
  /** Application functions to register on the connection. A driver that cannot register one fails to open. */
  functions?: Record<string, () => string>;
}

/** Opens one engine family the same way every time, so a probe can reopen a file it wrote. */
export interface EngineFactory {
  readonly artifact: string;
  open(location: string, options?: OpenOptions): Promise<ProbeEngine>;
}

/**
 * A test double for a driver that answers some statements itself. TS-001 and TS-003 use it to stand
 * in for a build that reports a forged version or silently ignores a PRAGMA. Returning rows answers
 * the statement; returning undefined passes it to the real engine.
 */
export type Intercept = (sql: string) => Row[] | undefined;

export interface NodeSqliteDouble {
  intercept?: Intercept;
  /** Changes a statement before it runs, so a test can remove one guard and show its probe notices. */
  rewrite?: (sql: string, location: string) => string;
  /** Application functions registered on every connection, such as a forged sqlite_version(). */
  functions?: Record<string, () => string>;
  /** Replaces what a failed statement throws, so a test can strip the result code a probe reads. */
  failure?: (error: unknown) => unknown;
  /** Replaces the driver's answer to whether a transaction is open. */
  transactionState?: (actual: boolean) => boolean;
  /** Replaces whether a connection asked to be read-only actually opens that way. */
  readOnly?: (requested: boolean) => boolean;
}

const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ').replace(/;$/, '');

/**
 * The reference engine, opened with the options W01's local store uses
 * (feature/memory-ledger server/memory/local-store.ts, LocalMemoryStore.open).
 */
export function nodeSqliteFactory(double: NodeSqliteDouble = {}): EngineFactory {
  return {
    artifact: 'node:sqlite',
    async open(location, options = {}) {
      const requested = options.readonly === true;
      const db = new DatabaseSync(location, {
        readOnly: double.readOnly ? double.readOnly(requested) : requested,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
      });
      for (const [name, fn] of Object.entries({ ...double.functions, ...options.functions })) db.function(name, fn);
      const answer = (sql: string) => double.intercept?.(normalize(sql));
      const sql = (text: string) => double.rewrite?.(text, location) ?? text;
      const values = (params: unknown[]) => params as SQLInputValue[];
      const failing = <T>(operation: () => T): T => {
        try { return operation(); } catch (error) { throw double.failure ? double.failure(error) : error; }
      };
      return {
        artifact: 'node:sqlite',
        async exec(text) { if (!answer(text)) failing(() => db.exec(sql(text))); },
        async all(text, ...params) { return answer(text) ?? failing(() => db.prepare(sql(text)).all(...values(params)) as Row[]); },
        async get(text, ...params) {
          const rows = answer(text);
          return rows ? rows[0] : failing(() => db.prepare(sql(text)).get(...values(params)) as Row | undefined);
        },
        async run(text, ...params) { if (!answer(text)) failing(() => db.prepare(sql(text)).run(...values(params))); },
        inTransaction: () => (double.transactionState ? double.transactionState(db.isTransaction) : db.isTransaction),
        async close() { if (db.isOpen) db.close(); },
      };
    },
  };
}

interface PromiseStatement {
  all(...params: unknown[]): Promise<Row[]>;
  get(...params: unknown[]): Promise<Row | undefined>;
  run(...params: unknown[]): Promise<unknown>;
}

/** The shape shared by @tursodatabase/database and the handle AgentFS returns from getDatabase(). */
export interface PromiseDatabase {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): PromiseStatement | Promise<PromiseStatement>;
  readonly inTransaction: boolean;
  close(): unknown;
  /** better-sqlite3's signature. Turso's promise driver declares it and throws "not implemented". */
  function?(name: string, fn: () => string): unknown;
}

export function wrapPromiseDatabase(db: PromiseDatabase, artifact: string): ProbeEngine {
  return {
    artifact,
    async exec(sql) { await db.exec(sql); },
    async all(sql, ...params) { return (await db.prepare(sql)).all(...params); },
    async get(sql, ...params) { return (await db.prepare(sql)).get(...params); },
    async run(sql, ...params) { await (await db.prepare(sql)).run(...params); },
    inTransaction: () => db.inTransaction,
    async close() { await db.close(); },
  };
}

/**
 * A Turso promise driver loaded from outside this repository. The app does not depend on it:
 * vendoring waits for the notice gate recorded in evidence/turso-qualification/ts00.
 */
export async function promiseDriverFactory(moduleFile: string, artifact: string): Promise<EngineFactory> {
  const driver = await import(pathToFileURL(moduleFile).href) as {
    connect(location: string, options?: { readonly?: boolean }): Promise<PromiseDatabase>;
  };
  return {
    artifact,
    async open(location, options = {}) {
      const db = await driver.connect(location, options.readonly ? { readonly: true } : undefined);
      try {
        for (const [name, fn] of Object.entries(options.functions ?? {})) {
          if (typeof db.function !== 'function') throw new Error('the driver has no function()');
          await db.function(name, fn);
        }
      } catch (error) {
        await db.close();
        throw error;
      }
      return wrapPromiseDatabase(db, artifact);
    },
  };
}
