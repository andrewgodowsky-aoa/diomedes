import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Conversation, Mode, TeamMember } from '../../shared/types';

const MODE_ORDER: Mode[] = ['ask', 'plan', 'build', 'fix'];
const CAPS: Record<Mode, string> = {
  ask: 'Nothing in the project changes.',
  plan: 'A plan you read before work begins.',
  build: 'Changes proposed, applied only on your go-ahead.',
  fix: 'The smallest change that clears the failure.',
};
const PLACEHOLDERS: Record<Mode, string> = {
  ask: 'Ask or think out loud',
  plan: 'What should the plan cover?',
  build: 'What should be done?',
  fix: 'What went wrong?',
};
/** Trailing line per mode: width in px; plan draws dashed. */
const LINE_FOR: Record<Mode, [number, boolean]> = {
  ask: [0, false],
  plan: [22, true],
  build: [34, false],
  fix: [12, false],
};

interface ComposerProps {
  thread: Conversation;
  mode: Mode;
  onMode(mode: Mode): void;
  member: TeamMember | null;
  toTeam: boolean;
  onTeam(on: boolean): void;
  busy: boolean;
  online: boolean;
  onSend(text: string, failingDocument: string, failingText: string): void;
}

/**
 * The prototype composer 1:1: autosizing box, the mode strip with its
 * point-and-line indicator, the caption, Send and the Enter hint, plus the
 * Build/Fix aux rows and the Team strip item for member threads.
 */
export function Composer({
  thread,
  mode,
  onMode,
  member,
  toTeam,
  onTeam,
  busy,
  online,
  onSend,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [failingDocument, setFailingDocument] = useState('');
  const [failingText, setFailingText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const modes = useRef<HTMLDivElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const sources = [...new Set(thread.turns.flatMap((t) => t.sources ?? []))];
  const fixReady = failingDocument.trim() !== '' || failingText.trim() !== '';
  const ready = text.trim() !== '' && (toTeam || mode !== 'fix' || fixReady);

  useEffect(() => {
    setText('');
    setFailingDocument('');
    setFailingText('');
  }, [thread.id]);
  useEffect(() => {
    if (mode !== 'fix') {
      setFailingDocument('');
      setFailingText('');
    }
  }, [mode]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  useLayoutEffect(() => {
    const active = mode === 'ask' || mode === 'plan' || mode === 'build' || mode === 'fix'
      ? buttons.current.get(toTeam ? 'team' : mode)
      : undefined;
    const bar = ind.current;
    if (!active || !bar) return;
    bar.style.transform = `translateX(${active.offsetLeft + 10}px)`;
    const [width, dashed] = toTeam ? [0, false] : LINE_FOR[mode];
    if (line.current) {
      line.current.style.transform = `scaleX(${width / 34})`;
      line.current.classList.toggle('dash', dashed);
    }
  }, [mode, toTeam, member]);

  function submit() {
    const value = text.trim();
    if (!value || busy || !online) return;
    if (!toTeam && mode === 'fix' && !fixReady) return;
    onSend(value, failingDocument.trim(), failingText.trim());
    setText('');
    setFailingDocument('');
    setFailingText('');
  }

  return (
    <div className="col compose">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={box}
          rows={1}
          aria-label="Message this thread"
          placeholder={
            toTeam && member ? `Message ${member.name} through the team service...` : PLACEHOLDERS[mode]
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {mode === 'build' && !toTeam && (
          <div className="aux show">
            <span className="mono">may touch</span>
            <span className="mono lc" style={{ color: 'var(--t1)' }}>
              {sources.join(', ') || 'the documents you name'}
            </span>
            <span style={{ marginLeft: 'auto' }}>Nothing is written until you say go ahead.</span>
          </div>
        )}
        {mode === 'fix' && !toTeam && (
          <div className="aux show">
            <span>What is failing</span>
            <select
              aria-label="What is failing"
              value={failingDocument}
              onChange={(e) => setFailingDocument(e.target.value)}
            >
              <option value="">Not a document</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <textarea
              aria-label="Paste what went wrong"
              placeholder="Paste what went wrong..."
              value={failingText}
              onChange={(e) => setFailingText(e.target.value)}
              rows={1}
            />
            <span style={{ marginLeft: 'auto' }}>Up to three tries.</span>
          </div>
        )}
        <div className="bar">
          <div className="modes" ref={modes} role="radiogroup" aria-label="Mode">
            {MODE_ORDER.map((m) => (
              <button
                key={m}
                type="button"
                ref={(el) => {
                  if (el) buttons.current.set(m, el);
                  else buttons.current.delete(m);
                }}
                role="radio"
                aria-checked={mode === m && !toTeam}
                className={mode === m && !toTeam ? 'on' : ''}
                onClick={() => {
                  onTeam(false);
                  onMode(m);
                }}
              >
                {m}
              </button>
            ))}
            {member && (
              <button
                type="button"
                ref={(el) => {
                  if (el) buttons.current.set('team', el);
                  else buttons.current.delete('team');
                }}
                role="radio"
                aria-checked={toTeam}
                className={toTeam ? 'on' : ''}
                title="Send a team message through the Diomedes team service"
                onClick={() => onTeam(true)}
              >
                Team
              </button>
            )}
            <span className="ind" ref={ind}>
              <i />
              <b ref={line} />
            </span>
          </div>
          <span className="cap">
            {!toTeam && mode === 'fix' && !fixReady
              ? 'Pick the document or paste what went wrong to send.'
              : CAPS[mode]}
          </span>
          <button
            type="submit"
            className={`send ${ready ? 'ready' : ''}`}
            aria-disabled={!ready}
          >
            Send
          </button>
          <span className="hint">Enter</span>
        </div>
      </form>
    </div>
  );
}
