import { useEffect, useState } from 'react';
import { ROUTES, routeDisplayName } from '../../shared/engines';
import { ApiError, api, listDocuments } from '../api';
import { Button, Modal } from '../components';

interface CloudSharingPolicy {
  version: number;
  routes: string[];
  documents: string[];
  shareConversationHistory: boolean;
  shareReviewPackets: boolean;
}

interface CloudSharingSaveBody {
  expectedVersion: number;
  routes: string[];
  documents: string[];
  shareConversationHistory: boolean;
  shareReviewPackets: boolean;
}

const CLOUD_ROUTES = ROUTES.filter((route) => route !== 'sample');

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

export function CloudSharing({
  projectId,
  projectName,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [version, setVersion] = useState<number | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [futurePath, setFuturePath] = useState('');
  const [routes, setRoutes] = useState<string[]>([]);
  const [documents, setDocuments] = useState<string[]>([]);
  const [shareHistory, setShareHistory] = useState(false);
  const [shareReviews, setShareReviews] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api<CloudSharingPolicy>(`/projects/${encodeURIComponent(projectId)}/cloud-sharing`),
      listDocuments(projectId),
    ])
      .then(([policy, listing]) => {
        if (!live) return;
        setVersion(policy.version);
        setRoutes(policy.routes.filter((route) => (CLOUD_ROUTES as readonly string[]).includes(route)));
        setDocuments([...policy.documents]);
        setShareHistory(policy.shareConversationHistory);
        setShareReviews(policy.shareReviewPackets);
        setPaths(listing.documents.map((entry) => entry.path).sort((a, b) => a.localeCompare(b)));
      })
      .catch((failure) => {
        if (!live) return;
        setError(messageOf(failure));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const toggle = (selected: string[], value: string): string[] =>
    selected.includes(value)
      ? selected.filter((entry) => entry !== value)
      : [...selected, value];
  const shownPaths = [...new Set([...paths, ...documents])].sort((a, b) => a.localeCompare(b));
  const addPath = () => {
    const name = futurePath.trim();
    if (!name) return;
    setDocuments((next) => next.includes(name) ? next : [...next, name]);
    setFuturePath('');
  };

  const save = () => {
    if (version === null || saving) return;
    setSaving(true);
    setError(null);
    const body: CloudSharingSaveBody = {
      expectedVersion: version,
      routes,
      documents,
      shareConversationHistory: shareHistory,
      shareReviewPackets: shareReviews,
    };
    api<CloudSharingPolicy>(`/projects/${encodeURIComponent(projectId)}/cloud-sharing`, 'PUT', body)
      .then((policy) => {
        setVersion(policy.version);
        setRoutes(policy.routes.filter((route) => (CLOUD_ROUTES as readonly string[]).includes(route)));
        setDocuments([...policy.documents]);
        setShareHistory(policy.shareConversationHistory);
        setShareReviews(policy.shareReviewPackets);
        onSaved();
      })
      .catch((failure) => {
        setError(messageOf(failure));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <Modal title="Cloud sharing" onClose={onClose}>
      <div className="cloud-sharing">
      <p className="caption muted">
        {projectName}: cloud routes and project files start off. Your typed text and task instructions
        can be sent when you start an enabled route.
      </p>
      <p className="caption">
        Native CLI helpers may read outside the selected documents, so cloud sharing must be used
        cautiously.
      </p>
      {loading ? (
        <p className="caption muted">Loading sharing policy…</p>
      ) : (
        <>
          <section aria-label="Cloud routes" className="cloud-routes">
            <h3>Cloud routes</h3>
            {CLOUD_ROUTES.map((route) => (
              <label key={route} className="check">
                <input
                  type="checkbox"
                  checked={routes.includes(route)}
                  onChange={() => setRoutes((next) => toggle(next, route))}
                />
                <span>{routeDisplayName(route)}</span>
              </label>
            ))}
          </section>
          <section aria-label="Documents">
            <h3>Documents</h3>
            <p className="caption muted">
              Select existing files or add the exact path of a file you plan to create. Proposed
              changes can reach the AI reviewer only when every changed path is selected here.
            </p>
            {shownPaths.length === 0 ? (
              <p className="caption muted">No document paths selected yet.</p>
            ) : (
              shownPaths.map((path) => (
                <label key={path} className="check">
                  <input
                    type="checkbox"
                    checked={documents.includes(path)}
                    onChange={() => setDocuments((next) => toggle(next, path))}
                  />
                  <span className="mono lc">{path}</span>
                </label>
              ))
            )}
            <label className="field">
              Document path
              <input
                value={futurePath}
                onChange={(event) => setFuturePath(event.target.value)}
                placeholder="notes/Planned.md"
              />
            </label>
            <Button tone="quiet" onClick={addPath} disabled={!futurePath.trim()}>
              Add path
            </Button>
          </section>
          <label className="check">
            <input
              type="checkbox"
              checked={shareHistory}
              onChange={(e) => setShareHistory(e.target.checked)}
            />
            Share conversation history
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={shareReviews}
              onChange={(e) => setShareReviews(e.target.checked)}
            />
            Share proposed changes with the AI reviewer, including task details, scope and excerpts
            from the document paths selected above
          </label>
        </>
      )}
      {error && (
        <p className="caption ws-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <Button tone="quiet" onClick={onClose}>
          Close
        </Button>
        <Button onClick={save} disabled={loading || saving || version === null}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      </div>
    </Modal>
  );
}
