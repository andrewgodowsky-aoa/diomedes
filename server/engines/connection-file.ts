/**
 * One model-API connection record, kept as a plain file beside the other data:
 * `connections/<route>.json`. The same storage `AwsConnections` uses, for the
 * routes added after it. The record holds identifiers only; the credential
 * lives in protected storage under the connection id.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { HarnessError } from '../harness/policy.js';
import { jsonWrite } from '../store.js';

export class ConnectionFile<S extends z.ZodType> {
  constructor(
    private readonly dataDir: string,
    private readonly route: string,
    private readonly schema: S,
    private readonly label: string,
  ) {}
  private get file() {
    return path.join(this.dataDir, 'connections', `${this.route}.json`);
  }
  async read(): Promise<z.infer<S> | null> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    const parsed = this.schema.safeParse(raw);
    if (!parsed.success)
      throw new HarnessError('connection_corrupt', `The saved ${this.label} connection record is not readable.`);
    return parsed.data;
  }
  /**
   * The saved record for listing what the route offers, read synchronously. A missing or
   * unreadable record lists nothing here; `read()` is where an unreadable one is reported.
   */
  peek(): z.infer<S> | null {
    try {
      const parsed = this.schema.safeParse(JSON.parse(fsSync.readFileSync(this.file, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  async write(connection: z.infer<S>): Promise<z.infer<S>> {
    const parsed = this.schema.parse(connection);
    await jsonWrite(this.file, parsed);
    return parsed;
  }
  async remove(): Promise<void> {
    try {
      await fs.unlink(this.file);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
