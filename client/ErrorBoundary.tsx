/**
 * The screen a render crash gets instead of an empty window.
 *
 * React unmounts the whole tree when a render throws and nothing catches it,
 * so until this existed a mistake in one component emptied the window: no
 * message, no control, nothing to do but close the application. Two such
 * crashes shipped.
 *
 * What it says is deliberately small. A person reading it has lost the screen
 * they were working in, so it tells them what happened, that their files and
 * their work were not touched by it, and gives them the one action that gets
 * them back. The error's own text is shown because a support request needs
 * something to name — but only its name and the first line of its message,
 * with this computer's paths taken out: an exception carries whatever the code
 * that threw put into it, and this screen is the one place nobody is checking
 * that against a contract.
 *
 * It imports nothing from the tree it is catching. A boundary that renders
 * through the components that just failed is a boundary that fails with them.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/** How much of a message a person is asked to read back over the phone. */
const MAX_LINE = 200;

/**
 * Every character that ends a line, written as a pattern rather than a literal
 * so the two invisible ones cannot break the file that holds them.
 */
const LINE_END = new RegExp('[\\r\\n\\u2028\\u2029]');

/**
 * Where this computer keeps things, in the spellings an exception uses. This
 * is a scrub, not a secret filter: the bundle's own scrubber is the one that
 * holds that line. Here it is enough that a person can read this line out, or
 * paste it, without reading out their account name.
 */
const PLACES: readonly (readonly [RegExp, string])[] = [
  [/\b[a-z]+:\/\/[^\s'"]+/gi, '[address]'],
  [/\b[A-Za-z]:[\\/][^\s'"]*/g, '[path]'],
  [/(?:^|\s)(?:\/[^\s'"/]+){2,}\/?/g, ' [path]'],
];

/**
 * The one line the screen may show about a failure: the error's name, and the
 * first line of what it said.
 */
export function failureLine(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'Error';
  let said = '';
  try {
    said = error instanceof Error ? error.message : String(error);
  } catch {
    // A thrown object whose own toString throws says nothing at all.
    said = '';
  }
  const first = said.split(LINE_END, 1)[0] ?? '';
  let text = first;
  for (const [pattern, replacement] of PLACES) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim();
  const line = text ? `${name}: ${text}` : name;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line;
}

interface BoundaryProps {
  children: ReactNode;
  /**
   * What this boundary is standing in front of, said to the person. The root
   * boundary answers for the application; a narrower one says which screen
   * stopped, so the rest of the Console can keep working around it.
   */
  scope?: 'app' | 'screen';
  /** Offered by a narrower boundary as the way out that is not a reload. */
  onLeave?: { label: string; act: () => void };
}

interface BoundaryState {
  failure: string;
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failure: '' };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failure: failureLine(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // There is no client error sink to report this to: nothing in this
    // application posts a client-side failure anywhere, and inventing a route
    // for it is a server change, not this screen's to make. The console is
    // where a crash has always been legible from the desktop shell's own
    // developer tools, so that is where it goes, whole — this is the developer
    // copy, and the screen below is the person's.
    console.error('Diomedes stopped drawing a screen.', error, info.componentStack);
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    const screen = this.props.scope === 'screen';
    const leave = this.props.onLeave;
    return (
      <div className="initial-state" role="alert">
        <h1>{screen ? 'This screen stopped' : 'Nectovia stopped drawing'}</h1>
        <p className="prose">
          {screen
            ? 'Something in this screen failed while it was being drawn, so Nectovia closed it rather than showing you half of it.'
            : 'Something failed while the window was being drawn, so there is nothing on it.'}{' '}
          Your files and your work were not changed by this, and nothing was sent.
        </p>
        <p className="code caption">{failure}</p>
        <div className="actions">
          {leave && (
            <button type="button" className="button" onClick={leave.act}>
              {leave.label}
            </button>
          )}
          <button
            type="button"
            className="button primary"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload Nectovia
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
