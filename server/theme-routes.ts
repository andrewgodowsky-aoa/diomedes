/**
 * Design Studio theme routes.
 *
 * Loopback HTTP on the same Express app as everything else — there is no
 * preload and no IPC by design. Every mutating route runs inside `store.locked`
 * because activating, restoring and resetting all write settings, and the store
 * owns that serialization already.
 *
 * `PUT` carries the revision the caller was editing in `If-Match`, the same
 * shape `/api/settings` uses for its own concurrent-save guard. A caller that
 * sends none is refused on an existing theme rather than quietly winning.
 */
import express, { type Express, type Request, type Response } from 'express';
import { ApiError } from './paths.js';
import type { Store } from './store.js';
import { ASSET_UPLOAD_TYPES, ThemeAssetService } from './theme-assets.js';
import type { ThemeService } from './themes.js';
import { probeWebsiteStudio } from './website-studio.js';
import { THEME_PACK_LIMITS } from '../shared/theme-pack/types.js';

const themeId = (req: Request) => String(req.params.id ?? '');

/** The revision in `If-Match`, quoted or bare, or null when none was sent. */
function expectedRevision(req: Request): number | null {
  const header = req.headers['if-match'];
  if (typeof header !== 'string' || header.trim() === '' || header.trim() === '*') return null;
  const value = Number(header.trim().replace(/^"|"$/g, ''));
  if (!Number.isInteger(value) || value < 1)
    throw new ApiError(400, 'The revision you are editing must be a whole number from 1 up.', {
      code: 'invalid_if_match',
    });
  return value;
}

/**
 * The raw body of an imported picture, and nothing else.
 *
 * `express.json` upstream ignores these requests — it parses `application/json`
 * alone — so this is the only parser that sees them. The type list is the same
 * three the contract accepts, and the limit is the contract's own per-asset cap
 * rather than a number invented here.
 *
 * The parser's own "too large" is an `entity.too.large`, which the app's error
 * handler answers with a sentence about JSON. That would be a lie on this
 * route, so it is translated where the fact is still known.
 */
function assetBody(): (req: Request, res: Response, next: (error?: unknown) => void) => void {
  const parse = express.raw({ type: [...ASSET_UPLOAD_TYPES], limit: THEME_PACK_LIMITS.assetBytes });
  return (req, res, next) =>
    parse(req, res, (error?: unknown) => {
      if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large')
        return next(
          new ApiError(
            400,
            `That picture is larger than the ${THEME_PACK_LIMITS.assetBytes} byte limit for one picture.`,
            { code: 'asset_too_large' },
          ),
        );
      next(error);
    });
}

export function mountThemeRoutes(app: Express, store: Store, themes: ThemeService) {
  const assets = new ThemeAssetService(themes);
  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const result = locked ? await store.locked(() => action(req, res)) : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };

  app.get(
    '/api/themes',
    route(async () => ({ themes: await themes.list() }), false),
  );

  /**
   * What the renderer should paint, and why. Separate from `/api/themes/:id`
   * because the answer here is never an error: a theme that cannot be read
   * falls back to the last one that worked and then to the built-in package,
   * and carries the sentence that says so.
   */
  app.get(
    '/api/themes/active',
    route(async () => themes.active(), false),
  );

  app.get(
    '/api/themes/:id',
    route(async (req) => themes.read(themeId(req)), false),
  );

  /**
   * The name, the header and the pack are checked before the store lock is
   * taken. `store.locked` treats a throw as a failed write and reloads the
   * whole store behind it, and a pack that does not validate yet is the
   * ordinary case while someone is still editing — that must not cost a
   * recovery pass. Only the read-modify-write runs under the lock.
   */
  app.put(
    '/api/themes/:id',
    route(async (req, res) => {
      const id = themeId(req);
      // `draft: true` rides beside the pack rather than inside it: the contract
      // refuses unknown top-level keys, and a draft is a fact about this save,
      // not about the design. It is taken off before validation and the pack
      // itself is checked exactly as an explicit save would be.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { draft: flag, ...packBody } = body;
      // One value, or absent. A misspelled flag read as "not a draft" would
      // turn an autosave into a recorded revision without anyone asking.
      if (flag !== undefined && flag !== true)
        throw new ApiError(400, 'The draft flag is either true or left out.', {
          code: 'invalid_draft_flag',
        });
      const draft = flag === true;
      const pack = themes.validate(id, packBody);
      if (draft) {
        const saved = await store.locked(() => themes.saveDraft(id, pack));
        return { ...saved, draft: true };
      }
      const expected = expectedRevision(req);
      const saved = await store.locked(() => themes.save(id, pack, expected));
      res.setHeader('ETag', `"${saved.revision}"`);
      return saved;
    }, false),
  );

  /**
   * Import one picture into this theme.
   *
   * The body is the file's own bytes — there is no multipart form, no field
   * names and no filename, because none of that is information this app wants:
   * a picture is its content, and its name here is the hash of that content.
   * Everything is checked before the store lock is taken, because a refusal
   * inside `store.locked` costs a whole store reload and a person choosing the
   * wrong file is the ordinary case, not an emergency.
   */
  app.post(
    '/api/themes/:id/assets',
    assetBody(),
    route(async (req) => {
      const body: unknown = req.body;
      if (!(body instanceof Buffer))
        throw new ApiError(
          415,
          'Import a PNG, JPEG or WebP picture. SVG is not accepted in this release.',
          { code: 'asset_type_not_accepted' },
        );
      const id = themeId(req);
      const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      // Validated outside the lock, written under it: the write is the only
      // consequential half, and it is idempotent by construction.
      const stored = await store.locked(() => assets.store(id, bytes));
      return { hash: stored.hash, record: stored.record };
    }, false),
  );

  /**
   * The bytes of one stored picture.
   *
   * A `GET`, because this is what an `<img>` asks for and an image element
   * cannot send the client header that mutating routes require. Nothing here
   * writes, and the answer is the account's own file or nothing at all.
   */
  app.get('/api/themes/:id/assets/:hash', async (req, res, next) => {
    try {
      const { bytes, mime } = await assets.read(themeId(req), String(req.params.hash ?? ''));
      res.setHeader('Content-Type', mime);
      // The name is the content, so this file can never be a different file.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      // `X-Content-Type-Options: nosniff` is already set for every response by
      // the app's own header pass; it matters most here, where the body is the
      // one thing in this service that is not JSON.
      res.end(Buffer.from(bytes));
    } catch (error) {
      next(error);
    }
  });

  /** Throw away an autosave without touching the saved theme. */
  app.delete(
    '/api/themes/:id/draft',
    route(async (req) => {
      await themes.discardDraft(themeId(req));
      return { ok: true };
    }),
  );

  app.post(
    '/api/themes/reset',
    route(async () => {
      await themes.reset();
      return { settings: store.settings, active: await themes.active() };
    }),
  );

  app.post(
    '/api/themes/:id/activate',
    route(async (req) => {
      const { pack } = await themes.activate(themeId(req));
      return { pack, settings: store.settings };
    }),
  );

  app.post(
    '/api/themes/:id/restore/:revision',
    route(async (req) => themes.restore(themeId(req), Number(req.params.revision))),
  );

  /**
   * Whether the local Website Studio is running. Read-only, takes no lock, and
   * is the one place in the Design Center that opens a socket at all — to
   * loopback, for one second. See `server/website-studio.ts`.
   */
  app.get(
    '/api/design-center/website-studio',
    route(async () => probeWebsiteStudio(), false),
  );
}
