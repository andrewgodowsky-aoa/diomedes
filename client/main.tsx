import './zod-config';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/schibsted-grotesk/400';
import '@fontsource/schibsted-grotesk/500';
import '@fontsource/schibsted-grotesk/600';
import '@fontsource/ibm-plex-mono/400';
import '@fontsource/ibm-plex-mono/500';
import './fonts/instrument-serif.css';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
// Outside everything, because a render error that reaches React with nothing
// above it unmounts the whole tree and leaves an empty window. Two such
// crashes shipped as exactly that.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
