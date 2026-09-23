import type { UpdateStatusSnapshot } from '../shared/app-updates';

// The one rule the update card in a reply (InlineVisual's `update-progress`)
// and Settings > App updates both draw by, so the two never disagree about
// what the updater said. It is the segment bar's own order: steps when the
// updater lists them, then the bytes a running download has received over the
// size its server declared, then an indeterminate bar while something moves.
// The updater lists no steps: checking, downloading and installing are phases
// of one record, not counted steps, so none are made up here. Nothing draws a
// share the updater did not report: an update that is offered, downloaded or
// handed to its installer is a sentence, not a bar. Pure: no React, no clock.

const MIB = 1024 * 1024;

/** Bytes as the update panel writes them: one decimal, in MB. */
export function megabytes(bytes: number): string {
  return (bytes / MIB).toFixed(1);
}

/** A request this window has sent and not yet heard back from. */
export type UpdateRequest = 'checking' | 'downloading' | 'installing';

export interface UpdateBar {
  /** What is moving, as the bar's name and the start of its caption. */
  label: string;
  /** Bytes received over the size the server declared; null is the indeterminate bar. */
  fraction: number | null;
  /** The updater's own figures, when it gave any. */
  detail: string | null;
}

/**
 * The bar for the host's update record, or null when nothing is moving. A
 * request this window has sent (`pending`) is moving too, until the host's
 * record says more about it.
 */
export function updateBar(
  status: UpdateStatusSnapshot | null,
  pending: UpdateRequest | null = null,
): UpdateBar | null {
  const version = status ? (status.download.version ?? status.check.latestVersion) : null;
  const downloading = version ? `Downloading version ${version}` : 'Downloading the update';
  const progress = status?.download.progress;
  if (progress) {
    if (progress.total !== null && progress.total > 0)
      return {
        label: downloading,
        fraction: progress.transferred / progress.total,
        detail: `${megabytes(progress.transferred)} of ${megabytes(progress.total)} MB`,
      };
    // No size was declared, so there is nothing to be a fraction of.
    return {
      label: downloading,
      fraction: null,
      detail: progress.transferred > 0 ? `${megabytes(progress.transferred)} MB received` : null,
    };
  }
  if (status?.install.phase === 'installing' || pending === 'installing')
    return { label: 'Starting the installer', fraction: null, detail: null };
  if (pending === 'downloading') return { label: downloading, fraction: null, detail: null };
  if (status?.check.phase === 'checking' || pending === 'checking')
    return { label: 'Checking for updates', fraction: null, detail: null };
  return null;
}
