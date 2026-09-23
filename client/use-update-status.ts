import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatusSnapshot } from '../shared/app-updates';
import { api } from './api';

/**
 * The host's own record of the application update, as Settings > App updates
 * reads it. One read path for every surface that shows it, so an inline card
 * in a reply and the Settings panel never disagree about what the host said.
 */
export function readUpdateStatus(): Promise<UpdateStatusSnapshot> {
  return api<UpdateStatusSnapshot>('/updates/status');
}

/** True while the host reports a phase that will change without anyone pressing anything. */
export function updateInMotion(status: UpdateStatusSnapshot | null): boolean {
  return status?.check.phase === 'checking' || status?.install.phase === 'installing';
}

/**
 * The update snapshot for a live card: read once, then again every few seconds
 * while the host reports a phase in motion. `failed` is true when the host
 * could not be read; the card says so instead of guessing.
 */
export function useUpdateStatus(pollMs = 3000): {
  status: UpdateStatusSnapshot | null;
  failed: boolean;
  loading: boolean;
} {
  const [status, setStatus] = useState<UpdateStatusSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const read = useCallback(async () => {
    try {
      setStatus(await readUpdateStatus());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read]);
  const moving = updateInMotion(status);
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => void read(), pollMs);
    return () => clearInterval(timer);
  }, [moving, pollMs, read]);
  return { status, failed, loading };
}
