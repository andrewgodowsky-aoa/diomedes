/**
 * The theme routes, as the editor uses them.
 *
 * `api()` sends no `If-Match`, and an explicit save must carry the revision it
 * was editing or the service refuses it (A2's concurrent-save guard). So the
 * one call that needs a header is written out here rather than bending the
 * shared helper into a shape only this screen wants.
 */
import type { ThemePackV1 } from '../../../shared/theme-pack/types';
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
