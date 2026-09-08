import { useCallback, useEffect, useRef, useState } from 'react';

interface UseWakeOptions {
  loaded: boolean;
  online: boolean;
  reduced: boolean;
  firstOpen?: boolean;
}

interface UseWakeResult {
  show: boolean;
  short: boolean;
  failed: boolean;
  done(): void;
}

function isWebdriver() {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { webdriver?: boolean }).webdriver === true
  );
}

// Owns when the wake shows. Full wake on first mount; `done` only completes
// once `loaded` is true (a sequence that ends early holds the field until the
// load lands); a failed initial load latches `failed`; after the first
// successful load, each false->true `online` transition plays the short wake
// once (spec section 9). Under Playwright or reduced motion the wake never
// shows, except the failed state.
export function useWake({ loaded, online, reduced, firstOpen = true }: UseWakeOptions): UseWakeResult {
  const [show, setShow] = useState(firstOpen);
  const [short, setShort] = useState(false);
  const [failed, setFailed] = useState(false);
  // `done` arrived before the load did: hide as soon as the load lands.
  const [held, setHeld] = useState(false);
  const settledOnce = useRef(false);
  const prevOnline = useRef(online);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const done = useCallback(() => {
    if (!loadedRef.current) {
      setHeld(true);
      return;
    }
    setHeld(false);
    setFailed(false);
    setShow(false);
    settledOnce.current = true;
  }, []);

  // A held `done` completes when the load lands.
  useEffect(() => {
    if (held && loaded) {
      setHeld(false);
      setFailed(false);
      setShow(false);
      settledOnce.current = true;
    }
  }, [held, loaded]);

  // The initial load failed while nothing is loaded: latch the failed layer.
  // A retry that succeeds clears it (the layer stays until retry succeeds).
  useEffect(() => {
    if (settledOnce.current) return;
    if (!loaded && !online) {
      setShort(false);
      setFailed(true);
      setShow(true);
    } else if (!loaded && online) {
      setFailed(false);
    }
    if (loaded && failed) {
      setFailed(false);
      setShow(false);
      settledOnce.current = true;
    }
  }, [loaded, online, failed]);

  // After the first successful load, each reconnect plays the short wake once.
  useEffect(() => {
    const was = prevOnline.current;
    prevOnline.current = online;
    if (settledOnce.current && !was && online && !show) {
      setShort(true);
      setShow(true);
    }
  }, [online, show]);

  const suppressed = (reduced || isWebdriver()) && !failed;
  return { show: suppressed ? false : show, short, failed, done };
}
