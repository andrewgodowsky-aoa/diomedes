import { useMemo } from 'react';
import type { Session } from '../../shared/types';
import { splitVisuals } from '../../shared/visual-spec';
import { paragraphs } from './diomedes-view';
import { InlineVisual, VisualBoundary, VisualNote, VisualPending } from './InlineVisual';

/**
 * A reply's text as a person reads it: paragraphs, with any `visual` block
 * drawn in place. Text with no visual block renders exactly as the plain
 * paragraph rule always did. While a reply streams, a visual block that has
 * not closed yet shows a placeholder, never its half-written JSON.
 *
 * `session` feeds the live `run-status` card; without one it says it is not
 * available here. No number in any `app` card comes from the reply.
 */
export function ReplyBody({
  text,
  streaming = false,
  session = null,
}: {
  text: string;
  streaming?: boolean;
  session?: Session | null;
}) {
  const segments = useMemo(() => splitVisuals(text, { streaming }), [text, streaming]);
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.type === 'text')
          return paragraphs(segment.text).map((p, j) => <p key={`${i}.${j}`}>{p}</p>);
        if (segment.type === 'visual')
          return (
            <VisualBoundary key={i}>
              <InlineVisual spec={segment.spec} session={session} />
            </VisualBoundary>
          );
        if (segment.type === 'pending') return <VisualPending key={i} />;
        return <VisualNote key={i} reason={segment.reason} />;
      })}
    </>
  );
}
