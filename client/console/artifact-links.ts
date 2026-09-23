// Links in a model's markup, made inert before the markup becomes a frame.
//
// A frame with no sandbox permissions runs no script, sends no form, opens no
// popup and cannot move the window it sits in, but it can still follow a link:
// a click on <a href="http://host/?secret"> navigates the frame, and the
// request, query and all, leaves the machine. The desktop shell refuses that
// navigation (`will-frame-navigate`, desktop/main.mjs) and so does the built
// app document's policy (`frame-src 'none'`, scripts/app-csp.ts). A browser on
// the development server has neither, so the links themselves go.
//
// Before a srcdoc is built, the source is read with DOMParser into a document
// that runs nothing and loads nothing, and every way the markup can send the
// frame, or a request, somewhere is taken out:
//   - href and xlink:href on <a> and <area>, in HTML and SVG alike (the link's
//     text stays where it was, it just goes nowhere);
//   - action, formaction, ping and target, on any element;
//   - <base>, and <meta http-equiv="refresh">;
//   - SVG animation (<set>, <animate>) that would write one of those back;
//   - and all of that inside every <template> too, because a template with
//     `shadowrootmode` becomes live content when the frame parses it.
// The result is read again, and again, until reading it changes nothing, so
// markup that parses into something new the second time (mutation XSS) cannot
// bring a link back. Markup that never settles is not shown at all, and nor is
// anything when no parser is available: this fails closed.

/** How the frame will read the markup: a design is a whole page, a picture sits inside <body>. */
export type MarkupContext = 'page' | 'picture';

/** Attributes that send a frame, or a request, somewhere when a person clicks or a form is sent. */
export const LEAVING_ATTRIBUTES: readonly string[] = ['action', 'formaction', 'ping', 'target'];

/** Elements whose href is a link a person can follow. */
const LINKS = new Set(['a', 'area']);

/** How many further readings may still change the markup before it is refused. */
export const SETTLE_PASSES = 4;

/** Whether an SVG animation would write a link or one of the leaving attributes back. */
function writesLeaving(element: Element): boolean {
  const target = element.getAttribute('attributeName');
  if (target === null) return false;
  const name = target.trim().toLowerCase().split(':').at(-1) ?? '';
  return name === 'href' || LEAVING_ATTRIBUTES.includes(name);
}

/** Takes every way out of one tree, template contents included. */
function strip(root: ParentNode): void {
  for (const element of root.querySelectorAll('*')) {
    const name = element.localName;
    const refresh = name === 'meta' && /^\s*refresh\s*$/i.test(element.getAttribute('http-equiv') ?? '');
    if (name === 'base' || refresh || writesLeaving(element)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const local = attribute.localName.toLowerCase();
      if ((local === 'href' && LINKS.has(name)) || LEAVING_ATTRIBUTES.includes(local))
        element.removeAttributeNode(attribute);
    }
    if (element instanceof HTMLTemplateElement) strip(element.content);
  }
}

/** One reading: parse the markup as the frame will, strip it, write it out again. */
function readOnce(markup: string, context: MarkupContext): string {
  // The frame's own document starts with a doctype, so it is read the same way here.
  const parsed = new DOMParser().parseFromString(
    context === 'page' ? `<!doctype html>${markup}` : `<!doctype html><body>${markup}`,
    'text/html',
  );
  strip(parsed);
  return context === 'page' ? parsed.documentElement.outerHTML : parsed.body.innerHTML;
}

/**
 * Reads `first` again until a reading changes nothing, and returns that. Null
 * when it is still changing after `passes` more readings. Pure, so it is
 * tested on its own (tests/artifact-frame.test.ts).
 */
export function settle(first: string, again: (markup: string) => string, passes = SETTLE_PASSES): string | null {
  let current = first;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = again(current);
    if (next === current) return current;
    current = next;
  }
  return null;
}

/**
 * The markup with every link and every way to leave taken out, or null when
 * that cannot be made certain (no parser here, or markup that never settles),
 * in which case it must not be shown in a frame.
 */
export function withoutNavigation(markup: string, context: MarkupContext): string | null {
  if (typeof DOMParser === 'undefined') return null;
  return settle(readOnce(markup, context), (current) => readOnce(current, context));
}
