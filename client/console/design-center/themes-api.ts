/**
 * The theme routes, as the editor uses them.
 *
 * `api()` sends no `If-Match`, and an explicit save must carry the revision it
 * was editing or the service refuses it (A2's concurrent-save guard). So the
 * one call that needs a header is written out here rather than bending the
 * shared helper into a shape only this screen wants.
 */
import {
  exportThemePackage,
  type ThemePackage,
} from '../../../shared/theme-pack/package';
import type { AssetRecord, ThemePackV1 } from '../../../shared/theme-pack/types';
import { ApiError, api } from '../../api';

export interface ThemeSummary {
  id: string;
  name: string;
  revision: number;
  baseTheme: string;
  updatedAt: string | null;
  active: boolean;
  isDraft: boolean;
  hasDraft: boolean;
}

export interface ThemeRead {
  pack: ThemePackV1 | null;
  revisions: number[];
  draft: { pack: ThemePackV1; basedOnRevision: number; savedAt: string } | null;
}

export const listThemes = () => api<{ themes: ThemeSummary[] }>('/themes').then((r) => r.themes);

export const readTheme = (id: string) => api<ThemeRead>(`/themes/${encodeURIComponent(id)}`);

export const activateTheme = (id: string) =>
  api<{ pack: ThemePackV1 }>(`/themes/${encodeURIComponent(id)}/activate`, 'POST');

export const resetTheme = () => api<unknown>('/themes/reset', 'POST');

export const restoreRevision = (id: string, revision: number) =>
  api<{ pack: ThemePackV1; revision: number }>(
    `/themes/${encodeURIComponent(id)}/restore/${revision}`,
    'POST',
  );

export const discardDraft = (id: string) =>
  api<unknown>(`/themes/${encodeURIComponent(id)}/draft`, 'DELETE');

/**
 * An explicit save. `expected` is the stored revision this edit started from,
 * or null for a theme that has never been saved.
 */
export async function saveTheme(
  pack: ThemePackV1,
  expected: number | null,
): Promise<{ pack: ThemePackV1; revision: number }> {
  const response = await fetch(`/api/themes/${encodeURIComponent(pack.id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Diomedes-Client': '1',
      ...(expected && expected >= 1 ? { 'If-Match': `"${expected}"` } : {}),
    },
    body: JSON.stringify(pack),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const nested = payload.error as { message?: string } | string | undefined;
    throw new ApiError(
      (typeof nested === 'object' ? nested?.message : undefined) ??
        (typeof nested === 'string' ? nested : 'The theme could not be saved.'),
      response.status,
      payload,
    );
  }
  return payload as unknown as { pack: ThemePackV1; revision: number };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/**
 * Where a stored picture is read from.
 *
 * Built here from a validated theme id and a hash, never from anything a theme
 * file said. A theme carries a hash, and this app decides what URL that means:
 * that is the difference between data and a link somebody else chose.
 */
export const assetUrl = (themeId: string, hash: string) =>
  `/api/themes/${encodeURIComponent(themeId)}/assets/${encodeURIComponent(hash)}`;

/**
 * Import a picture into a theme.
 *
 * The body is the file itself. There is no multipart form and no filename,
 * because the service names the picture after its own bytes and a filename is
 * one more thing to have to distrust.
 */
export async function uploadAsset(
  themeId: string,
  file: Blob,
): Promise<{ hash: string; record: AssetRecord }> {
  const response = await fetch(`/api/themes/${encodeURIComponent(themeId)}/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Diomedes-Client': '1',
    },
    body: file,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new ApiError(
      typeof payload.error === 'string' ? payload.error : 'That picture could not be imported.',
      response.status,
      payload,
    );
  return payload as unknown as { hash: string; record: AssetRecord };
}

/** The bytes of one stored picture, for the export container. */
export async function fetchAssetBytes(themeId: string, hash: string): Promise<Uint8Array> {
  const response = await fetch(assetUrl(themeId, hash));
  if (!response.ok) throw new ApiError('A picture in this theme could not be read.', response.status, {});
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The `.diomedes-theme` container for a pack, with the bytes of every picture
 * it declares.
 *
 * One builder for both places that write the file — the toolbar's Export and
 * the Website target's own — because A3 already had to fix these two drifting
 * apart once, and now they have assets to disagree about as well.
 */
export async function buildPackage(pack: ThemePackV1): Promise<ThemePackage> {
  const bytes: Record<string, Uint8Array> = {};
  for (const hash of Object.keys(pack.assets)) bytes[hash] = await fetchAssetBytes(pack.id, hash);
  const result = exportThemePackage(pack, bytes);
  if (!result.ok) throw new ApiError(result.errors[0], 400, {});
  return result.package;
}

/**
 * Put the pictures from an imported package back on disk, under this account.
 *
 * Every hash is checked against what the service says it stored. A package that
 * carried bytes under the wrong name would otherwise produce a pack naming a
 * picture nobody holds — which the save refuses, at the point where it is far
 * less obvious why.
 */
export async function restoreAssets(
  themeId: string,
  pack: ThemePackV1,
  assets: Record<string, Uint8Array>,
): Promise<void> {
  for (const [hash, data] of Object.entries(assets)) {
    // The type the pack records, which `importThemePackage` has already checked
    // against the bytes themselves. The upload route accepts the three picture
    // types and nothing else, so a Blob with no type at all would be refused at
    // the door — and the service would then never get to read the bytes it
    // would have accepted.
    const type = pack.assets[hash]?.mime ?? 'image/png';
    // A fresh copy: a view onto a larger buffer would send the whole buffer.
    const stored = await uploadAsset(themeId, new Blob([new Uint8Array(data)], { type }));
    if (stored.hash !== hash)
      throw new ApiError(
        'A picture in that file is not the picture it is named after.',
        400,
        {},
      );
  }
}
