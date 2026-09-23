/**
 * The owner's approved read connectors, managed from Settings instead of by
 * hand-editing `<data>/read-connectors.json`.
 *
 *   GET    /api/ai/read-connectors          every entry, as names and state
 *   POST   /api/ai/read-connectors          approve one more connector
 *   PUT    /api/ai/read-connectors/:name    change an approved connector
 *   DELETE /api/ai/read-connectors/:name    remove every entry with that name
 *
 * Every entry is validated by `approvedReadServerSchema`, the same schema the
 * read turn loads with, so nothing here can approve what a read turn would
 * refuse. The host writes `approved: true` and `transport: 'stdio'` itself,
 * and only after the request carries the owner's consent.
 *
 * What the file holds is names: the command, its arguments, the names of the
 * environment variables forwarded to it and the exact read tools. A variable's
 * value is never accepted, stored or returned.
 *
 * A file that cannot be read is reported and never written over. Entries a
 * read turn skips (not approved, malformed, a repeated name) are kept exactly
 * as they are and listed, so saving one connector never silently drops another.
 * Writes are the store's one durable write (temp file, fsync, rename, with the
 * Windows rename retry), one at a time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { ReadConnectorsView, ReadConnectorView } from '../../shared/read-connectors.js';
import { ApiError } from '../paths.js';
import { jsonWrite, type Store } from '../store.js';
import {
  approvedReadServerSchema,
  approvedReadServersSchema,
  READ_CONNECTORS_FILE,
} from './read-scope.js';

const BASE = '/api/ai/read-connectors';
const MAX_SERVERS = 16;

/** The entry fields a person supplies, under the same rules, plus consent. */
const inputBody = approvedReadServerSchema
  .omit({ approved: true, transport: true })
  .extend({ consent: z.literal(true, 'Confirm that you approve these read tools.') });

type Entry = z.infer<typeof approvedReadServerSchema>;

interface FileState {
  /** The raw entries, in file order, kept verbatim. */
  servers: unknown[];
  exists: boolean;
}

const nameOf = (entry: unknown): string | null =>
  entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
    ? (entry as { name: string }).name
    : null;

class Malformed extends Error {}

export function mountReadConnectorRoutes(
  app: Express,
  deps: { store: Store; environment?: NodeJS.ProcessEnv },
) {
  const { store } = deps;
  const environment = deps.environment ?? process.env;
  const file = () => path.join(store.dataDir, READ_CONNECTORS_FILE);

  const route =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await action(req));
      } catch (error) {
        if (error instanceof z.ZodError) {
          const issue = error.issues[0];
          next(new ApiError(400, issue?.message ?? 'That connector is not valid.'));
        } else next(error);
      }
    };

  async function readFile(): Promise<FileState> {
    let text: string;
    try {
      text = await fs.readFile(file(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], exists: false };
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Malformed();
    }
    const parsed = approvedReadServersSchema.safeParse(raw);
    if (!parsed.success) throw new Malformed();
    return { servers: [...parsed.data.servers], exists: true };
  }

  /** What each entry means to a read turn: the one it loads per name, or why it is skipped. */
  function classify(servers: unknown[]) {
    const seen = new Set<string>();
    const loaded: { index: number; entry: Entry }[] = [];
    const ignored: ReadConnectorsView['ignored'] = [];
    servers.forEach((raw, index) => {
      const parsed = approvedReadServerSchema.safeParse(raw);
      if (!parsed.success) {
        ignored.push({
          index,
          name: nameOf(raw),
          reason:
            raw && typeof raw === 'object' && (raw as { approved?: unknown }).approved !== true
              ? 'Not approved, so Ask and Plan skip it.'
              : `Skipped: ${parsed.error.issues[0]?.message ?? 'this entry is not valid.'}`,
        });
        return;
      }
      if (seen.has(parsed.data.name)) {
        ignored.push({ index, name: parsed.data.name, reason: 'Repeats a name above it, so Ask and Plan skip it.' });
        return;
      }
      seen.add(parsed.data.name);
      loaded.push({ index, entry: parsed.data });
    });
    return { loaded, ignored };
  }

  const view = (entry: Entry): ReadConnectorView => ({
    name: entry.name,
    command: entry.command,
    args: [...entry.args],
    envFrom: [...entry.envFrom],
    missingEnv: entry.envFrom.filter((name) => !environment[name]),
    readTools: [...entry.readTools],
    provides: [...(entry.provides ?? [])],
    note: entry.note ?? null,
  });

  async function build(): Promise<ReadConnectorsView> {
    let state: FileState;
    try {
      state = await readFile();
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      return {
        state: 'malformed',
        problem: `${READ_CONNECTORS_FILE} in the data folder cannot be read. Fix or remove it; nothing here will write over it.`,
        connectors: [],
        ignored: [],
      };
    }
    const { loaded, ignored } = classify(state.servers);
    return {
      state: state.exists ? 'ok' : 'none',
      problem: null,
      connectors: loaded.map(({ entry }) => view(entry)),
      ignored,
    };
  }

  /**
   * Changes run one at a time. This file has no other writer, so a queue of its own is enough;
   * the store's lock would reload every project's state after a refused request.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  };

  /** Read, change and write back, one change at a time; a malformed file is refused whole. */
  const mutate = (change: (servers: unknown[]) => unknown[]) =>
    serial(async () => {
      let state: FileState;
      try {
        state = await readFile();
      } catch (error) {
        if (error instanceof Malformed)
          throw new ApiError(
            409,
            `${READ_CONNECTORS_FILE} in the data folder cannot be read. Fix or remove it first; nothing was changed.`,
          );
        throw error;
      }
      const servers = change(state.servers);
      if (servers.length > MAX_SERVERS)
        throw new ApiError(409, `At most ${MAX_SERVERS} connectors can be approved. Remove one first.`);
      await jsonWrite(file(), approvedReadServersSchema.parse({ version: 1, servers }));
      return build();
    });

  /** The entry the host will store: the owner's fields, approved by this request's consent. */
  const entryFrom = (body: unknown, name?: string): Entry => {
    const { consent: _consent, ...fields } = inputBody.parse(body);
    if (name !== undefined && fields.name !== name)
      throw new ApiError(400, 'A connector keeps its name. Remove it and add a new one to rename it.');
    return approvedReadServerSchema.parse({
      ...fields,
      approved: true,
      transport: 'stdio',
      envFrom: [...new Set(fields.envFrom)],
      readTools: [...new Set(fields.readTools)],
      ...(fields.provides ? { provides: [...new Set(fields.provides)] } : {}),
    });
  };

  app.get(BASE, route(build));

  app.post(
    BASE,
    route((req) => {
      const entry = entryFrom(req.body);
      return mutate((servers) => {
        if (servers.some((raw) => nameOf(raw) === entry.name))
          throw new ApiError(409, `A connector named ${entry.name} is already listed. Change or remove that one.`);
        return [...servers, entry];
      });
    }),
  );

  app.put(
    `${BASE}/:name`,
    route((req) => {
      const name = String(req.params.name);
      const entry = entryFrom(req.body, name);
      return mutate((servers) => {
        // The entry a read turn uses for this name, or else the first one to repair.
        const { loaded } = classify(servers);
        const index = loaded.find((item) => item.entry.name === name)?.index ?? servers.findIndex((raw) => nameOf(raw) === name);
        if (index < 0) throw new ApiError(404, `No connector named ${name} is listed.`);
        return servers.map((raw, i) => (i === index ? entry : raw));
      });
    }),
  );

  app.delete(
    `${BASE}/:name`,
    route((req) => {
      const name = String(req.params.name);
      return mutate((servers) => {
        if (!servers.some((raw) => nameOf(raw) === name)) throw new ApiError(404, `No connector named ${name} is listed.`);
        return servers.filter((raw) => nameOf(raw) !== name);
      });
    }),
  );
}
