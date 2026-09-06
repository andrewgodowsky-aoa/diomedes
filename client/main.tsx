import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/big-shoulders-display/800';
import '@fontsource/schibsted-grotesk/400';
import '@fontsource/schibsted-grotesk/500';
import '@fontsource/schibsted-grotesk/600';
import '@fontsource/ibm-plex-serif/400';
import '@fontsource/ibm-plex-serif/400-italic';
import '@fontsource/ibm-plex-serif/600';
import '@fontsource/ibm-plex-serif/600-italic';
import '@fontsource/ibm-plex-mono/400';
import './styles.css';
import { App } from './App';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
