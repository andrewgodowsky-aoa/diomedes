/**
 * The Website target.
 *
 * The app never edits website pages. This panel does three things and no more:
 * says what the website will and will not render of this theme, hands over the
 * `.diomedes-theme` package, and says whether the local Website Studio is
 * running — with plain instructions for starting it when it is not.
 *
 * The reachability question is asked of the service (`GET
 * /api/design-center/website-studio`), which makes one loopback request with a
 * one-second budget. Nothing here reaches a provider, a gateway or any host
 * that is not this computer.
 */
import { useCallback, useEffect, useState } from 'react';
import { checkCompatibility, THEME_PACK_COMPATIBILITY } from '../../../shared/theme-pack/compatibility';
import { THEME_PACKAGE_EXTENSION } from '../../../shared/theme-pack/package';
import type { ThemePackV1 } from '../../../shared/theme-pack/types';
import { api } from '../../api';
import { Button } from '../../components';
import { buildPackage } from './themes-api';

interface Probe {
  reachable: boolean;
  url: string;
  version: string | null;
  detail: string;
}

export function WebsiteTarget({ pack }: { pack: ThemePackV1 }) {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState('');

  const check = useCallback(async () => {
    setChecking(true);
    setProblem('');
    try {
      setProbe(await api<Probe>('/design-center/website-studio'));
    } catch (error) {
      setProbe(null);
      setProblem(error instanceof Error ? error.message : 'The check could not be made.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const report = checkCompatibility(pack, 'website');
  const ignored = THEME_PACK_COMPATIBILITY.filter((entry) => entry.support.website === 'ignores');
  const rendered = THEME_PACK_COMPATIBILITY.filter((entry) => entry.support.website === 'renders');

  const exportPackage = async () => {
    setProblem('');
    try {
      // The same builder the toolbar's Export uses, so the two files cannot
      // differ — they already drifted apart once, and now they have pictures
      // to disagree about as well. The bytes come from this computer's own
      // service on loopback.
      const built = await buildPackage(pack);
      // A Blob and an object URL: the file is built in this page and saved by
      // the browser. Nothing is uploaded and no service sees it.
      const blob = new Blob([JSON.stringify(built, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${pack.id}${THEME_PACKAGE_EXTENSION}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'This theme could not be written to a file.',
      );
    }
  };

  return (
    <div className="dc-website">
      <section className="service">
        <div className="row">
          <h3>What the website does with this theme</h3>
        </div>
        {report.ok ? (
          <p className="prose">
            This theme is built for the website as well as this app, so the website will use it.
          </p>
        ) : (
          <>
            <p className="prose">This theme was not built for the website.</p>
            <ul className="dc-list">
              {report.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </>
        )}
        <h4>The website renders</h4>
        <ul className="dc-list">
          {rendered.map((entry) => (
            <li key={entry.field}>
              <span className="mono">{entry.field}</span> — {entry.note}
            </li>
          ))}
        </ul>
        <h4>The website ignores</h4>
        <ul className="dc-list">
          {ignored.map((entry) => (
            <li key={entry.field}>
              <span className="mono">{entry.field}</span> — {entry.note}
            </li>
          ))}
        </ul>
        {report.warnings.length > 0 && (
          <p className="caption">
            In this theme: {report.warnings.join('; ')}. The rest of it applies.
          </p>
        )}
        <div className="actions">
          <Button tone="primary" onClick={exportPackage}>
            Export for website
          </Button>
        </div>
        <p className="caption">
          The export is one file ending {THEME_PACKAGE_EXTENSION}. It carries the theme and its
          pictures and is saved to this computer.
        </p>
      </section>

      <section className="service">
        <div className="row">
          <h3>Website Studio</h3>
          <span className="caption push-right">
            {checking ? 'Checking…' : probe?.reachable ? 'Running' : 'Not running'}
          </span>
        </div>
        <p className="prose">{probe?.detail ?? 'Checking whether the Website Studio is running.'}</p>
        {problem && <p role="alert">{problem}</p>}
        {probe?.reachable ? (
          <p className="prose">
            {/* One anchor serves both paths: in the desktop app the window-open
                handler passes this exact URL to the external-link allowlist in
                desktop/main.mjs; in a browser it is an ordinary new tab. */}
            <a href={probe.url} target="_blank" rel="noreferrer">
              Open Website Studio
            </a>
          </p>
        ) : (
          <>
            <h4>Starting it</h4>
            <ol className="dc-list">
              <li>Open the folder where the website lives on this computer.</li>
              <li>
                Double-click <strong>Start Website Studio</strong>.
              </li>
              <li>Wait for the black window to say it is ready, then press Check again.</li>
            </ol>
          </>
        )}
        <div className="actions">
          <Button onClick={() => void check()} disabled={checking}>
            Check again
          </Button>
        </div>
      </section>
    </div>
  );
}
