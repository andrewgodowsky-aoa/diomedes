import '../zod-config.js';
import { createRoot } from 'react-dom/client';
import '@fontsource/schibsted-grotesk/400';
import '@fontsource/schibsted-grotesk/600';
import '@fontsource/ibm-plex-mono/400';
import { InventoryReceipts } from '../console/InventoryReceipts.js';
import { ErrorBoundary } from '../ErrorBoundary.js';

// This entry is explicitly composed by the local fixture host, not desktop startup.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <InventoryReceipts />
  </ErrorBoundary>,
);
