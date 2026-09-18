/**
 * Theme storage for the Design Studio.
 *
 *   <data>/themes/<scope>/<id>/pack.json            the current pack
 *   <data>/themes/<scope>/<id>/revisions/<n>.json   every revision, immutable
 *   <data>/themes/<scope>/<id>/assets/              bytes a pack declares
 *   <data>/themes/<scope>/<id>/last-known-good.json the last pack that applied
 *
 * Three boundaries this module exists to hold:
 *
 * 1. **A theme is data.** Nothing here trusts a stored file. Every pack goes
 *    through `validateThemePack` on the way in *and* on the way out, and
 *    through `checkCompatibility` for this surface, so a file edited by hand or
 *    corrupted on disk is refused rather than applied.
 *
 * 2. **A revision is history.** `revisions/<n>.json` is written with a guard
 *    that refuses an existing target, so no save can rewrite what an earlier
 *    save recorded. Restoring an old revision writes a *new* one carrying the
 *    old content; it never moves the number back.
 *
 * 3. **Scope is not a convenience.** Every path is built from a scope key
 *    derived from the live workspace and person, so one account's drafts are
 *    not another's. The key is a hash: an id never becomes a path segment, and
 *    two ids that differ only in case cannot share a folder on Windows.
 *
 * Nothing here calls a provider, starts an agent, or reaches the network.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkCompatibility } from '../shared/theme-pack/compatibility.js';
import { validateThemePack } from '../shared/theme-pack/validate.js';
import { THEME_PACK_ID_PATTERN, type ThemePackV1 } from '../shared/theme-pack/types.js';
import type { WorkspaceRef } from '../shared/workspaces.js';
import { ApiError } from './paths.js';
import { durableWrite, jsonWrite, type Store } from './store.js';

export { THEME_PACK_ID_PATTERN };

/** The surface these packs are stored for. The website stores its own. */
const SURFACE = 'app-console' as const;

const refuse = (status: number, message: string, code: string) =>
  new ApiError(status, message, { code });

/**
 * The folder one account's themes live in.
 *
 * Mirrored in `desktop/main.mjs` (`themeScopeKey`), which reads the active
 * pack to colour the titlebar and has no way to import this file. Change one
 * and change the other; the desktop test for a custom titlebar is what catches
 * a drift.
 */
export function themeScopeKey(workspace: WorkspaceRef, personId: string): string {
  const of = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  return workspace.kind === 'business'
    ? `business-${of(workspace.organizationId)}`
    : `personal-${of(personId)}`;
}

export interface ThemeSummary {
  id: string;
  name: string;
  revision: number;
  baseTheme: string;
  updatedAt: string | null;
  active: boolean;
}

/** What the renderer needs to paint, and why it is painting that and not the pack. */
export interface ActiveTheme {
  pack: ThemePackV1 | null;
  source: 'pack' | 'last-known-good' | 'none';
  /** One sentence for the person when what they chose is not what they got. */
  notice: string | null;
}

/** Where a scope's themes live, and who that scope is. Injectable for tests. */
export interface ThemeScopeSource {
  workspace(): WorkspaceRef;
  personId(): string;
}

function readRevision(name: string): number | null {
  const match = /^(\d+)\.json$/.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

async function readJsonOrNull(target: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * A stored pack, or the reason it cannot be used. Returns the reason rather
 * than throwing, because every caller has somewhere better to go than an
 * exception: a listing skips the entry, the active read falls back.
 */
function accept(raw: unknown): { pack: ThemePackV1 } | { reason: string } {
  if (raw === null) return { reason: 'the file is missing or is not readable JSON' };
  const result = validateThemePack(raw);
  if (!result.ok) return { reason: result.errors.join('; ') };
  const compatibility = checkCompatibility(result.pack, SURFACE);
  if (!compatibility.ok) return { reason: compatibility.errors.join('; ') };
  return { pack: result.pack };
}

export class ThemeService {
  constructor(
    private readonly store: Store,
    private readonly scope: ThemeScopeSource,
  ) {}

  private scopeDir(): string {
    return path.join(
      this.store.dataDir,
      'themes',
      themeScopeKey(this.scope.workspace(), this.scope.personId()),
    );
  }

  private themeDir(id: string): string {
    if (!THEME_PACK_ID_PATTERN.test(id))
      throw refuse(
        400,
        'A theme name is 3 to 64 characters of lower-case letters, numbers and hyphens.',
        'invalid_theme_id',
      );
    return path.join(this.scopeDir(), id);
  }

  // --- reads ------------------------------------------------------------------

  /** Every theme this account has, newest revision first, corrupt ones skipped. */
  async list(): Promise<ThemeSummary[]> {
    const dir = this.scopeDir();
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const activeId = this.store.settings.appearance.activeTheme?.id ?? null;
    const summaries: ThemeSummary[] = [];
    for (const id of entries.sort()) {
      if (!THEME_PACK_ID_PATTERN.test(id)) continue;
      const file = path.join(dir, id, 'pack.json');
      const read = accept(await readJsonOrNull(file));
      if ('reason' in read) {
        // Skipped, loudly. A theme that vanished from the list without a word
        // would read as deleted, which is a different and worse story.
        console.warn(`Skipping the stored theme ${id}: ${read.reason}`);
        continue;
      }
      let updatedAt: string | null = null;
      try {
        updatedAt = (await fs.stat(file)).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
      summaries.push({
        id: read.pack.id,
        name: read.pack.name,
        revision: read.pack.revision,
        baseTheme: read.pack.baseTheme,
        updatedAt,
        active: read.pack.id === activeId,
      });
    }
    return summaries;
  }

  /** One theme with its revision history, or a refusal naming what is wrong. */
  async read(id: string): Promise<{ pack: ThemePackV1; revisions: number[] }> {
    const dir = this.themeDir(id);
    const read = accept(await readJsonOrNull(path.join(dir, 'pack.json')));
    if ('reason' in read)
      throw refuse(404, `That theme cannot be read here: ${read.reason}.`, 'theme_unreadable');
    return { pack: read.pack, revisions: await this.revisions(id) };
  }

  async revisions(id: string): Promise<number[]> {
    try {
      const names = await fs.readdir(path.join(this.themeDir(id), 'revisions'));
      return names
        .map(readRevision)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /**
   * What to paint right now.
   *
   * The chain is deliberate: the pack this person chose, then the last pack
   * that was known to apply, then the built-in base scheme. A blank window is
   * not one of the outcomes, and every step but the first says why it happened.
   */
  async active(): Promise<ActiveTheme> {
    const pointer = this.store.settings.appearance.activeTheme;
    if (!pointer) return { pack: null, source: 'none', notice: null };
    if (!THEME_PACK_ID_PATTERN.test(pointer.id))
      return {
        pack: null,
        source: 'none',
        notice: 'The saved theme name is not one this computer can store. The built-in appearance package is showing.',
      };
    const dir = path.join(this.scopeDir(), pointer.id);
    const current = accept(await readJsonOrNull(path.join(dir, 'pack.json')));
    if ('pack' in current) return { pack: current.pack, source: 'pack', notice: null };
    console.warn(`The active theme ${pointer.id} could not be applied: ${current.reason}`);
    const good = accept(await readJsonOrNull(path.join(dir, 'last-known-good.json')));
    if ('pack' in good)
      return {
        pack: good.pack,
        source: 'last-known-good',
        notice: `“${good.pack.name}” could not be read as saved, so the last version that worked is showing instead.`,
      };
    return {
      pack: null,
      source: 'none',
      notice:
        'The theme you chose could not be read, and there is no earlier version to fall back to. The built-in appearance package is showing.',
    };
  }

  // --- writes -------------------------------------------------------------------

  /**
   * Save a pack as the theme's next revision.
   *
   * The revision is the store's to assign, never the caller's: a client that
   * sent one could overwrite a revision it had not seen. `expected` is the
   * revision the caller believed it was editing, and a mismatch is refused
   * rather than merged, so two screens saving at once lose nothing silently.
   */
  async save(
    id: string,
    body: unknown,
    expected: number | null,
  ): Promise<{ pack: ThemePackV1; revision: number }> {
    const dir = this.themeDir(id);
    const validated = validateThemePack(body);
    if (!validated.ok)
      throw new ApiError(400, 'That theme is not one this computer can apply.', {
        code: 'invalid_theme_pack',
        errors: validated.errors,
      });
    if (validated.pack.id !== id)
      throw refuse(400, 'The theme in the body is not the theme in the address.', 'theme_id_mismatch');
    const compatibility = checkCompatibility(validated.pack, SURFACE);
    if (!compatibility.ok)
      throw new ApiError(400, 'That theme was not built for this app.', {
        code: 'theme_incompatible',
        errors: compatibility.errors,
      });

    const existing = accept(await readJsonOrNull(path.join(dir, 'pack.json')));
    const stored = 'pack' in existing ? existing.pack : null;
    if (stored) {
      if (expected === null)
        throw refuse(
          409,
          'This theme already exists here. Send the revision you are editing so an earlier save is not overwritten.',
          'theme_revision_required',
        );
      if (expected !== stored.revision)
        throw refuse(
          409,
          'This theme changed while you were editing it. Reload it and apply your change to the saved version.',
          'theme_revision_conflict',
        );
    }

    const history = await this.revisions(id);
    const revision = Math.max(stored?.revision ?? 0, ...history, 0) + 1;
    const pack: ThemePackV1 = { ...validated.pack, revision };
    // History first: a revision file that exists without a current pack is a
    // recoverable state, and a current pack with no history is not.
    await this.writeRevision(dir, revision, pack);
    await jsonWrite(path.join(dir, 'pack.json'), pack);
    await jsonWrite(path.join(dir, 'last-known-good.json'), pack);
    // The bytes a pack declares travel in the `.diomedes-theme` container and
    // are written by the import route, not here. The folder exists so that
    // route has somewhere to land and so the layout is one shape on disk.
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    // Editing the theme that is applied shows the edit. The pointer carries the
    // revision, so leaving it behind would paint an older pack than the one the
    // editor is looking at, and say nothing about the difference.
    if (this.store.settings.appearance.activeTheme?.id === id) await this.point(id, revision);
    return { pack, revision };
  }

  /** Write one revision, refusing a target that is already there. */
  private async writeRevision(dir: string, revision: number, pack: ThemePackV1): Promise<void> {
    const target = path.join(dir, 'revisions', `${revision}.json`);
    await durableWrite(target, JSON.stringify(pack, null, 2), async () => {
      // `rename` replaces silently on both platforms, so the only thing
      // standing between a save and a rewritten history is this check. It runs
      // immediately before the rename, inside the store lock.
      try {
        await fs.access(target);
      } catch {
        return;
      }
      throw refuse(
        409,
        `Revision ${revision} of this theme is already recorded and cannot be rewritten.`,
        'theme_revision_exists',
      );
    });
  }

  /** Bring an earlier revision back as a new one. History only ever grows. */
  async restore(id: string, revision: number): Promise<{ pack: ThemePackV1; revision: number }> {
    if (!Number.isInteger(revision) || revision < 1)
      throw refuse(400, 'A theme revision is a whole number from 1 up.', 'invalid_revision');
    const dir = this.themeDir(id);
    const read = accept(await readJsonOrNull(path.join(dir, 'revisions', `${revision}.json`)));
    if ('reason' in read)
      throw refuse(
        404,
        `Revision ${revision} of this theme cannot be restored: ${read.reason}.`,
        'revision_unreadable',
      );
    const current = accept(await readJsonOrNull(path.join(dir, 'pack.json')));
    const stored = 'pack' in current ? current.pack : null;
    const history = await this.revisions(id);
    const next = Math.max(stored?.revision ?? 0, ...history, 0) + 1;
    const pack: ThemePackV1 = { ...read.pack, revision: next };
    await this.writeRevision(dir, next, pack);
    await jsonWrite(path.join(dir, 'pack.json'), pack);
    await jsonWrite(path.join(dir, 'last-known-good.json'), pack);
    if (this.store.settings.appearance.activeTheme?.id === id) await this.point(id, next);
    return { pack, revision: next };
  }

  /** Apply a theme. It must be readable here first: activation cannot fail open. */
  async activate(id: string): Promise<{ pack: ThemePackV1 }> {
    const { pack } = await this.read(id);
    await this.point(pack.id, pack.revision);
    return { pack };
  }

  /** Back to the built-in appearance package. The themes themselves stay. */
  async reset(): Promise<void> {
    if (!this.store.settings.appearance.activeTheme) return;
    await this.store.saveSettings({
      ...this.store.settings,
      appearance: { ...this.store.settings.appearance, activeTheme: null },
    });
  }

  /**
   * Move the pointer and nothing else. One appearance field, written the narrow
   * way the interface-scale shortcut writes its own, so a theme change cannot
   * carry an unrelated settings screen's stale copy of everything else with it.
   */
  private async point(id: string, revision: number): Promise<void> {
    await this.store.saveSettings({
      ...this.store.settings,
      appearance: { ...this.store.settings.appearance, activeTheme: { id, revision } },
    });
  }
}
