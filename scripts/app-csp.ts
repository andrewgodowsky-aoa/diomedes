import path from 'node:path';
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';
import { APP_CSP } from '../shared/app-csp';

export { APP_CSP, APP_CSP_DIRECTIVES } from '../shared/app-csp';

// The app document's Content-Security-Policy, written into the built index.html
// as a <meta> (vite.config.ts). The policy itself, and why each of its directives
// is what it is, lives in shared/app-csp.ts, where the Console can read it too:
// Mermaid lays model-authored diagrams out in the app's own document
// (client/console/mermaid-render.ts), and draws math only under exactly this
// policy. The development server is left as it was: the plugin applies at build
// only, and every surface a person uses is built.
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
// tests/app-csp.test.ts pins the policy, and tests/artifacts-ui.spec.ts asserts
// that the built Console runs under it with no violation on its main surfaces.

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
