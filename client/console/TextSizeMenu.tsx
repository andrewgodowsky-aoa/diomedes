import type { Settings } from '../../shared/types';
import { CONVERSATION_TEXT_SCALES, conversationTextLabel } from '../../shared/interface-scale';

/**
 * Conversation text size in the ··· menu, beside Detail: the same preference as Settings >
 * Appearance > Conversation text size, one click from any thread.
 */
export function TextSizeMenuItems({
  settings,
  choose,
}: {
  settings: Settings;
  choose(scale: number): void;
}) {
  const current = settings.appearance.readingScale ?? 1;
  return (
    <>
      <p className="caption">Text size</p>
      {CONVERSATION_TEXT_SCALES.map((scale) => (
        <button
          key={scale}
          type="button"
          role="menuitemradio"
          aria-checked={current === scale}
          className={current === scale ? 'on' : ''}
          onClick={() => choose(scale)}
        >
          {conversationTextLabel(scale)}
        </button>
      ))}
    </>
  );
}
