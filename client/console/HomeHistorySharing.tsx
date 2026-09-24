import { useEffect, useRef, useState } from 'react';
import { isConversationRoute, routeDisplayName } from '../../shared/engines';
import { ApiError, api } from '../api';
import { Button, Modal } from '../components';
import { historyChange, historyRoutes, type HomeSharing } from './home-history';

/** Said when another window saved first: the boxes have been read again and show what is saved. */
const CHANGED_ELSEWHERE = 'Cloud sharing changed in another window. This now shows what is saved.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

/**
 * Cloud sharing for the All projects conversation (0.1.8). A project's dialog (CloudSharing.tsx)
 * chooses routes, documents, history and review packets; this one offers only history, one box
 * per route, because Home shares no documents and no review packets and its typed messages need
 * no grant. It reads the record when it opens, saves through the same endpoint with the version
 * it read, and sends documents and review packets back exactly as it read them
 * (`historyChange` in home-history.ts).
 *
 * The boxes show what is saved: opening this grants nothing. The route the next message takes
 * is always offered, and so is every route that receives earlier messages now, so any grant can
 * be taken back here.
 */
export function HomeHistorySharing({
  projectId,
  route,
  onClose,
  onSaved,
}: {
  /** The reserved Home project that holds the All projects conversation. */
  projectId: string;
  /** The route the conversation's next message takes. */
  route: string;
  onClose(): void;
  onSaved(policy: HomeSharing): void;
}) {
  const [policy, setPolicy] = useState<HomeSharing | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const path = `/projects/${encodeURIComponent(projectId)}/cloud-sharing`;

  const adopt = (current: HomeSharing) => {
    setPolicy(current);
    setChosen(historyRoutes(current));
  };
  useEffect(() => {
    live.current = true;
    api<HomeSharing>(path).then(
      (current) => {
        if (live.current) adopt(current);
      },
      (failure) => {
        if (live.current) setError(messageOf(failure));
      },
    );
    return () => {
      live.current = false;
    };
  }, [path]);

  const saved = policy ? historyRoutes(policy) : [];
  const offered = policy
    ? [...new Set([...(isConversationRoute(route) ? [route] : []), ...saved])]
    : [];
  const changed =
    policy !== null &&
    (chosen.length !== saved.length || chosen.some((entry) => !saved.includes(entry)));

  const save = () => {
    if (!policy || saving || !changed) return;
    setSaving(true);
    setError(null);
    api<HomeSharing>(path, 'PUT', historyChange(policy, chosen)).then(
      (next) => {
        if (!live.current) return;
        setSaving(false);
        onSaved(next);
      },
      (failure) => {
        if (!live.current) return;
        setSaving(false);
        if (!(failure instanceof ApiError && failure.status === 409))
          return setError(messageOf(failure));
        // Saved elsewhere first. Read it again, so the boxes show what is true before anyone
        // chooses again.
        setError(CHANGED_ELSEWHERE);
        api<HomeSharing>(path).then(
          (current) => {
            if (live.current) adopt(current);
          },
          (again) => {
            if (live.current) setError(messageOf(again));
          },
        );
      },
    );
  };

  return (
    <Modal title="Cloud sharing" onClose={onClose}>
      <p className="caption muted">
        All projects: what you type goes to the route this conversation is on. Earlier messages go
        with it only to a route checked here.
      </p>
      {policy === null ? (
        !error && <p className="caption muted">Reading what is shared now…</p>
      ) : offered.length === 0 ? (
        <p className="caption muted">
          This conversation is not on a cloud route, so nothing is sent.
        </p>
      ) : (
        offered.map((entry) => (
          <label key={entry} className="check">
            <input
              type="checkbox"
              checked={chosen.includes(entry)}
              onChange={(e) =>
                setChosen((now) =>
                  e.target.checked ? [...now, entry] : now.filter((item) => item !== entry),
                )
              }
            />
            Share earlier messages with {routeDisplayName(entry)}
          </label>
        ))
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
        <Button onClick={save} disabled={saving || !changed}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
}
