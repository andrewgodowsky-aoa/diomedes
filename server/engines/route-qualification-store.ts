/**
 * Where route check receipts are kept: one file per route beside the connection records,
 *
 *   <data>/connections/qualifications/<route>.json   { v: 1, route, receipts: [...] }
 *
 * holding the newest 20 receipts, newest last, each validated against the receipt schema
 * (`shared/route-qualification.ts`). A receipt is evidence of what one run observed, so nothing
 * here edits or re-labels one: a newer run is a new receipt, and the oldest past 20 drop off.
 *
 * Reading fails closed. A missing, unreadable or invalid file reads as no receipt, which leaves a
 * model that needs one refused. Recording over an unreadable file first moves that file aside,
 * untouched, so its bytes are kept for whoever looks at it, and starts a fresh one.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  QUALIFIABLE_ROUTES,
  routeQualificationReceiptSchema,
  type QualifiableRoute,
  type RouteQualificationReceipt,
} from '../../shared/route-qualification.js';
import { jsonWrite } from '../store.js';

/** How many receipts one route keeps. */
export const QUALIFICATION_RECEIPTS_KEPT = 20;

const fileSchema = z.strictObject({
  v: z.literal(1),
  route: z.enum(QUALIFIABLE_ROUTES),
  receipts: z.array(routeQualificationReceiptSchema).max(QUALIFICATION_RECEIPTS_KEPT),
});
type QualificationFile = z.infer<typeof fileSchema>;

/** Which receipts a caller wants: the connection's, and optionally one model or one deployment. */
export interface QualificationFilter {
  model?: string;
  deployment?: string | null;
}

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export class RouteQualifications {
  /** One change at a time, across every route: each record is a read, an append and a write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  private file(route: QualifiableRoute) {
    return path.join(this.dataDir, 'connections', 'qualifications', `${route}.json`);
  }

  /**
   * The route's file: `null` when there is none, `'unreadable'` when its bytes are not a valid
   * receipts file. A file the system could not read at all throws: it may be fine, so it is
   * never moved aside for that.
   */
  private async read(route: QualifiableRoute): Promise<QualificationFile | null | 'unreadable'> {
    let text: string;
    try {
      text = await fs.readFile(this.file(route), 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.route === route ? parsed.data : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  /** Every receipt kept for a route, oldest first. A file that cannot be read or trusted lists none. */
  async list(route: QualifiableRoute): Promise<RouteQualificationReceipt[]> {
    try {
      const saved = await this.read(route);
      return saved && saved !== 'unreadable' ? structuredClone(saved.receipts) : [];
    } catch {
      return [];
    }
  }

  /** The newest receipt for one connection, and one model or deployment when named. */
  async latest(
    route: QualifiableRoute,
    connectionId: string,
    filter: QualificationFilter = {},
  ): Promise<RouteQualificationReceipt | null> {
    const receipts = await this.list(route);
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const receipt = receipts[index];
      if (receipt.route !== route || receipt.connectionId !== connectionId) continue;
      if (filter.model !== undefined && receipt.model !== filter.model) continue;
      if (filter.deployment !== undefined && receipt.deployment !== filter.deployment) continue;
      return receipt;
    }
    return null;
  }

  /** Keep one more receipt, after validating it again. The oldest past the limit drop off. */
  record(receipt: RouteQualificationReceipt): Promise<RouteQualificationReceipt> {
    const next = this.queue.then(async () => {
      const parsed = routeQualificationReceiptSchema.parse(receipt);
      const target = this.file(parsed.route);
      const saved = await this.read(parsed.route);
      if (saved === 'unreadable') await this.setAside(target);
      const kept = saved && saved !== 'unreadable' ? saved.receipts : [];
      const file: QualificationFile = {
        v: 1,
        route: parsed.route,
        receipts: [...kept, parsed].slice(-QUALIFICATION_RECEIPTS_KEPT),
      };
      await jsonWrite(target, fileSchema.parse(file));
      return structuredClone(parsed);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** An unreadable file keeps its bytes under a new name; nothing is deleted. */
  private async setAside(target: string) {
    try {
      await fs.rename(target, `${target}.unreadable-${Date.now()}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
