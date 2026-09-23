import { toolSentence, type ToolLine } from './engine-activity';

const POINT: Record<ToolLine['phase'], string> = {
  started: 'live',
  finished: 'done',
  failed: 'fail',
};

/**
 * The tool calls of a reply or run as they happen: one plain sentence per call. With the
 * Technical detail level each call also names its tool, and a call that carries a detail
 * opens to it from its own summary, so it is one keypress away and never on screen unasked.
 *
 * The list is not a live region. One polite status repeats only the newest call still running,
 * so a reader hears each call start once, not every line again on every change.
 */
export function ToolActivityList({
  lines,
  technical,
}: {
  lines: readonly ToolLine[] | undefined;
  technical: boolean;
}) {
  if (!lines?.length) return null;
  const running = [...lines].reverse().find((line) => line.phase === 'started');
  return (
    <div className="tool-activity">
      <ul aria-label="Tool calls">
        {lines.map((line) => (
          <li key={line.callId} data-phase={line.phase}>
            <span className={`pt ${POINT[line.phase]}`} aria-hidden="true" />
            {technical && line.detail ? (
              <details>
                <summary>
                  <span className="say">{toolSentence(line)}</span>{' '}
                  <span className="mono lc">{line.tool}</span>
                </summary>
                <pre className="mono lc">{line.detail}</pre>
              </details>
            ) : (
              <span className="say">
                {toolSentence(line)}
                {technical && (
                  <>
                    {' '}
                    <span className="mono lc">{line.tool}</span>
                  </>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <span className="tool-said" role="status">
        {running ? toolSentence(running) : ''}
      </span>
    </div>
  );
}
