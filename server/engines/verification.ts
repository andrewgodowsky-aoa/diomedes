import fs from 'node:fs';
import path from 'node:path';
import type { ExternalEngine } from '../../shared/types.js';
import { EXTERNAL_ENGINES, type ConnectionReceipt } from '../../shared/engines.js';

/**
 * Host-issued proof that one real, consented request answered through an exact
 * binding revision. Like `bindings.json` this is Diomedes's own record, not a
 * credential store: identifiers, a version, a route name, a model slug, a run
 * id and a timestamp. The prompt that was sent, the answer that came back, any
 * token and any environment value are never written here and never read back.
 *
 * A receipt is history. It is reloaded after a restart so a person can see what
 * last worked, and it authorises nothing: every dispatch still runs the live
 * admission in `EngineService.generate()`.
 *
 * It is written synchronously, for the same reason the binding is: a receipt
 * that is returned to a person must already be on disk.
 */
const FILE = 'receipts.json';

/** A receipt is authority only for the engine it is filed under. */
function readReceipt(value: unknown, engine: ExternalEngine): ConnectionReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  if (row.engine !== engine) return undefined;
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) return undefined;
  for (const key of ['candidateId', 'version', 'accountRoute', 'model', 'runId', 'verifiedAt'])
    if (!text(key)) return undefined;
  if (!Number.isFinite(Date.parse(text('verifiedAt')))) return undefined;
  return {
    engine,
    revision: row.revision as number,
    candidateId: text('candidateId'),
    version: text('version'),
    accountRoute: text('accountRoute'),
    model: text('model'),
    runId: text('runId'),
    buildId: text('buildId') || 'unknown',
    verifiedAt: text('verifiedAt'),
  };
}

/** A synchronous pause, for the bounded rename retry below. */
function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class VerificationStore {
  private readonly file: string;
  private readonly rows = new Map<ExternalEngine, ConnectionReceipt>();
  constructor(readonly root: string) {
    this.file = path.join(root, FILE);
    this.load();
  }
  private load() {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A damaged file proves nothing. Start with no receipt rather than
      // guessing at one; the next real result replaces the file.
      return;
    }
    const document = parsed as { engines?: Record<string, unknown> } | null;
    const engines = document?.engines;
    if (!engines || typeof engines !== 'object') return;
    for (const engine of EXTERNAL_ENGINES) {
      const receipt = readReceipt(engines[engine], engine);
      if (receipt) this.rows.set(engine, receipt);
    }
  }
  get(engine: ExternalEngine): ConnectionReceipt | undefined {
    const row = this.rows.get(engine);
    return row ? structuredClone(row) : undefined;
  }
  /**
   * A result Diomedes could not record is a result it does not claim. If the
   * file cannot be replaced the in-memory row goes back to what is on disk and
   * the caller hears about it, rather than showing a verification no restart
   * would find.
   */
  save(engine: ExternalEngine, receipt: ConnectionReceipt) {
    const previous = this.rows.get(engine);
    this.rows.set(engine, structuredClone(receipt));
    try {
      this.write();
    } catch (error) {
      if (previous) this.rows.set(engine, previous);
      else this.rows.delete(engine);
      throw error;
    }
  }
  private write() {
    const document = {
      version: 1,
      engines: Object.fromEntries([...this.rows].map(([engine, row]) => [engine, row])),
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
