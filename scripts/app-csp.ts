import path from 'node:path';
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';

// The app document's Content-Security-Policy, written into the built index.html
// as a <meta> (vite.config.ts). Mermaid lays model-authored diagrams out in the
// app's own document (client/console/mermaid-render.ts), so the document itself
// must refuse to fetch from anywhere but the local service, and must refuse
// every script but the bundle's. The development server is left as it was: the
// plugin applies at build only, and every surface a person uses is built.
//
// A policy delivered by <meta> cannot carry `frame-ancestors` (nor `report-uri`
// or `sandbox`): browsers ignore those there. Keeping the Console out of another
// page's frame would need a response header from the local service.
//
// Every artifact frame is a srcdoc document, and a srcdoc document inherits this
// policy on top of its own (FRAME_CSP, client/console/artifact-frame.ts): what a
// frame may load is what both allow. So each source the frame policy allows is
// allowed here too (tests/app-csp.test.ts checks it).
//
// Each directive names what in the app needs each source. Anything the app does
// not do is 'none'. tests/app-csp.test.ts pins the policy, and
// tests/artifacts-ui.spec.ts asserts that the built Console runs under it with no
// violation on its main surfaces.

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

/** The <meta> the built index.html carries, first in its <head>. */
export const APP_CSP_TAG: HtmlTagDescriptor = {
  tag: 'meta',
  attrs: { 'http-equiv': 'Content-Security-Policy', content: APP_CSP },
  injectTo: 'head-prepend',
};

/** Writes the policy into the built index.html, and into no other page and no development server. */
export function appContentSecurityPolicy(): Plugin & {
  transformIndexHtml: (html: string, context: Pick<IndexHtmlTransformContext, 'filename'>) => HtmlTagDescriptor[] | undefined;
} {
  return {
    name: 'app-content-security-policy',
    apply: 'build',
    transformIndexHtml(_html: string, context: Pick<IndexHtmlTransformContext, 'filename'>) {
      if (path.basename(context.filename) !== 'index.html') return undefined;
      return [APP_CSP_TAG];
    },
  };
}
