// The app document's Content-Security-Policy, as data both sides read. The build writes it into
// the built index.html as a <meta> (scripts/app-csp.ts), and the Console reads it back to know it
// is running under exactly this policy (client/console/mermaid-render.ts, carriesPolicy). It is
// kept here, free of Node and Vite, so the client can import it.
//
// Mermaid lays model-authored diagrams out in the app's own document, so the document itself must
// refuse to fetch from anywhere but the local service, and must refuse every script but the
// bundle's. Each directive names what in the app needs each source. Anything the app does not do
// is 'none'. tests/app-csp.test.ts pins the policy.

export const APP_CSP_DIRECTIVES: ReadonlyArray<{ directive: string; sources: string; why: string }> = [
  { directive: 'default-src', sources: "'self'", why: 'Anything not named below may come only from the local service.' },
  { directive: 'script-src', sources: "'self'", why: 'The built bundle and its lazily loaded chunks (Mermaid is one). No inline script, no eval.' },
  {
    directive: 'style-src',
    sources: "'self' 'unsafe-inline'",
    why: "The bundle's stylesheets, plus the <style> element and style attributes in the SVG Mermaid lays out in this document.",
  },
  {
    directive: 'img-src',
    sources: "'self' data:",
    why: 'Bundled art and theme pictures served by the local service; the Nectovia status glyph is a data: SVG mask (nectovia.css); and an artifact frame, which inherits this policy, carries its images as data: URLs.',
  },
  {
    directive: 'font-src',
    sources: "'self' data:",
    why: 'The bundled fonts (@fontsource and Instrument Serif), served with the bundle; and data: because an artifact frame inherits this policy and a design may carry its own font as a data: URL.',
  },
  { directive: 'connect-src', sources: "'self'", why: 'fetch to /api and the /api/events stream, both on the local service.' },
  {
    directive: 'media-src',
    sources: 'data:',
    why: 'The app plays no audio or video itself. An artifact frame inherits this policy, and a design may carry its own as a data: URL.',
  },
  { directive: 'worker-src', sources: "'none'", why: 'The app starts no workers.' },
  {
    directive: 'frame-src',
    sources: "'none'",
    why: 'Artifact frames are srcdoc documents, which frame-src does not govern; every navigation of a frame away from its srcdoc is refused.',
  },
  { directive: 'object-src', sources: "'none'", why: 'No plugins.' },
  { directive: 'base-uri', sources: "'none'", why: 'Nothing may re-point the document\'s relative URLs.' },
  { directive: 'form-action', sources: "'self'", why: "The Console's forms are handled in script; none may submit anywhere else." },
];

export const APP_CSP = APP_CSP_DIRECTIVES.map(({ directive, sources }) => `${directive} ${sources}`).join('; ');
