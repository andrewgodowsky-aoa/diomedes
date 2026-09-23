// The artifact view's widths. The Files view keeps its own (FilesPane.tsx).
// Pure apart from `viewportWidth`, which reads the window when there is one.

export const ARTIFACT_MIN_WIDTH = 320;
export const ARTIFACT_MAX_WIDTH = 960;
export const ARTIFACT_DEFAULT_WIDTH = 480;

/** The widest the artifact view may be: 960 px, or 60% of the window when that is less. */
export function artifactMaxWidth(viewport: number | null): number {
  const cap = viewport && viewport > 0 ? Math.floor(viewport * 0.6) : ARTIFACT_MAX_WIDTH;
  return Math.max(ARTIFACT_MIN_WIDTH, Math.min(ARTIFACT_MAX_WIDTH, cap));
}

export function clampArtifactWidth(value: number, viewport: number | null): number {
  return Math.min(artifactMaxWidth(viewport), Math.max(ARTIFACT_MIN_WIDTH, Math.round(value)));
}

export const viewportWidth = (): number | null =>
  typeof window === 'undefined' ? null : window.innerWidth;

/**
 * Per-person interface memory, the way Shell.tsx keeps the Files pane's. A
 * browser that refuses storage still gets the panel; it just does not remember.
 */
export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // No storage: the choice lasts for this session only.
  }
}

/** The remembered artifact width, read once. */
export function storedArtifactWidth(): number {
  const saved = Number(stored('console.artifacts.width'));
  return Number.isFinite(saved) && saved > 0
    ? clampArtifactWidth(saved, viewportWidth())
    : ARTIFACT_DEFAULT_WIDTH;
}
