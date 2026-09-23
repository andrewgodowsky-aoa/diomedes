import { useEffect, useState } from 'react';
import { ROUTES, routeDisplayName } from '../../shared/engines';
import { ApiError, api, listDocuments } from '../api';
import { Button, Modal } from '../components';

interface CloudSharingPolicy {
  version: number;
  routes: string[];
  documents: string[];
  shareConversationHistory: boolean;
}

interface CloudSharingSaveBody {
  expectedVersion: number;
  routes: string[];
  documents: string[];
  shareConversationHistory: boolean;
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
  const [routes, setRoutes] = useState<string[]>([]);
  const [documents, setDocuments] = useState<string[]>([]);
  const [shareHistory, setShareHistory] = useState(false);
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

  const save = () => {
    if (version === null || saving) return;
    setSaving(true);
    setError(null);
    const body: CloudSharingSaveBody = {
      expectedVersion: version,
      routes,
      documents,
      shareConversationHistory: shareHistory,
    };
    api<CloudSharingPolicy>(`/projects/${encodeURIComponent(projectId)}/cloud-sharing`, 'PUT', body)
      .then((policy) => {
        setVersion(policy.version);
        setRoutes(policy.routes.filter((route) => (CLOUD_ROUTES as readonly string[]).includes(route)));
        setDocuments([...policy.documents]);
        setShareHistory(policy.shareConversationHistory);
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
      <p className="caption muted">
        {projectName}: nothing is shared until it is checked here.
      </p>
      <p className="caption">
        Native CLI helpers may read outside the selected documents, so cloud sharing must be used
        cautiously.
      </p>
      {loading ? (
        <p className="caption muted">Loading sharing policy…</p>
      ) : (
        <>
          <section aria-label="Cloud routes">
            <h3>Cloud routes</h3>
            {CLOUD_ROUTES.map((route) => (
              <label key={route} className="check">
                <input
                  type="checkbox"
                  checked={routes.includes(route)}
                  onChange={() => setRoutes((next) => toggle(next, route))}
                />
                <span className="mono">{routeDisplayName(route)}</span>
              </label>
            ))}
          </section>
          <section aria-label="Documents">
            <h3>Documents</h3>
            {paths.length === 0 ? (
              <p className="caption muted">This project has no documents to share.</p>
            ) : (
              paths.map((path) => (
                <label key={path} className="check">
                  <input
                    type="checkbox"
                    checked={documents.includes(path)}
                    onChange={() => setDocuments((next) => toggle(next, path))}
                  />
                  <span className="mono">{path}</span>
                </label>
              ))
            )}
          </section>
          <label className="check">
            <input
              type="checkbox"
              checked={shareHistory}
              onChange={(e) => setShareHistory(e.target.checked)}
            />
            Share conversation history
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
    </Modal>
  );
}
