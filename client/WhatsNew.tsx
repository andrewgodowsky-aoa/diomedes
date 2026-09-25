import { useEffect, useState } from 'react';
import bundledNotes from '../resources/release-notes/releases.json';
import type { ReleaseEntry } from '../shared/release-notes';
import { publishedReleases } from '../shared/release-notes';
import { useInstalledVersion } from './AppUpdates';
import { Button, Mark } from './components';
import { ReleaseNotesBody } from './ReleaseNotesBody';
import './release-notes.css';

/**
 * The release notes this build carries: stable releases only, newest first.
 * Read once from the bundled `resources/release-notes/releases.json`; a draft
 * is never shown, and a file that fails the contract shows nothing.
 */
export const bundledReleases: ReleaseEntry[] = publishedReleases(bundledNotes);

/** `YYYY-MM-DD` as a person reads it. The day is the release's own, never shifted by a time zone. */
export function releaseDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

const PLATFORM_NAMES: Record<string, string> = { windows: 'Windows', macos: 'macOS' };

/**
 * Settings > What's new: every stable release this build knows, newest first,
 * each one collapsible. The installed version is marked and starts open, as
 * does a version asked for by name (the post-update notice asks for its own).
 */
export function WhatsNew({
  releases = bundledReleases,
  focusVersion = null,
}: {
  releases?: ReleaseEntry[];
  focusVersion?: string | null;
}) {
  const installed = useInstalledVersion();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const wanted = focusVersion ?? installed;
    if (wanted) setOpen((last) => (wanted in last ? last : { ...last, [wanted]: true }));
  }, [focusVersion, installed]);
  if (releases.length === 0)
    return <p className="prose">This build carries no release notes.</p>;
  return (
    <div className="whats-new service-list">
      {releases.map((release) => {
        const current = release.version === installed;
        return (
          <section
            className={`service release-entry${current ? ' installed' : ''}`}
            key={release.version}
            aria-label={`Version ${release.version}`}
          >
            <details
              open={open[release.version] === true}
              onToggle={(event) => {
                // Read before the updater: React clears currentTarget once this returns.
                const next = event.currentTarget.open;
                setOpen((last) => ({ ...last, [release.version]: next }));
              }}
            >
              <summary className="row">
                <h3 className="release-version">Version {release.version}</h3>
                <span className="caption push-right release-meta">
                  {current && <strong>Installed · </strong>}
                  <time dateTime={release.date}>{releaseDay(release.date)}</time>
                  {' · '}
                  {release.platforms.map((p) => PLATFORM_NAMES[p] ?? p).join(', ')}
                </span>
              </summary>
              <ReleaseNotesBody release={release} />
            </details>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The quiet notice after an update: the new version's headline, once, with a
 * way to read the rest. Either button settles it for that version.
 */
export function ReleaseNotice({
  release,
  onRead,
  onDismiss,
}: {
  release: ReleaseEntry;
  onRead: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="error-bar release-notice" role="status">
      <Mark state="done" />
      <span>
        <strong>Updated to {release.version}.</strong> {release.headline}
      </span>
      <Button tone="quiet" onClick={onRead}>
        What's new
      </Button>
      <Button tone="quiet" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
