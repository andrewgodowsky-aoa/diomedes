import { describe, expect, it } from 'vitest';
import { canQueue, queuedLabel, sessionLine } from '../client/console/native-session-view';
import { sessionControls } from '../shared/session-controls';
import { routeContractFor } from '../server/harness/route-contract';
import type { ThreadSessionView } from '../shared/session-controls';

const claude = sessionControls(routeContractFor('claude-code-session'));
const view = (patch: Partial<ThreadSessionView> = {}): ThreadSessionView => ({
  runId: 'claude-run',
  controls: claude,
  busy: false,
  continuity: { state: 'live', detail: 'Claude Code is running this conversation now.', cursor: 4 },
  requestedModel: 'sonnet',
  reportedModel: 'claude-sonnet-4-6',
  queued: [],
  ...patch,
});

describe('what the Console says about a native session (H03)', () => {
  it('says nothing on a thread whose route has no native session', () => {
    expect(sessionLine(null)).toBeNull();
    expect(sessionLine(view({ controls: null }))).toBeNull();
    expect(canQueue(view({ controls: null, busy: true }), true)).toBe(false);
  });

  it('names the engine and the model the engine reported, never the requested alias', () => {
    expect(sessionLine(view())).toEqual({
      state: 'Live session',
      detail: null,
      attribution: 'Claude Code · claude-sonnet-4-6',
      tone: 'quiet',
    });
    expect(sessionLine(view({ reportedModel: null }))?.attribution).toBe('Claude Code');
  });

  it('says a saved session resumes, and says why one cannot', () => {
    expect(sessionLine(view({ continuity: { state: 'resumable', detail: 'x', cursor: 1 } }))?.state).toBe(
      'Resumes on your next message',
    );
    const broken = sessionLine(
      view({
        continuity: {
          state: 'start-again',
          detail: "Couldn't resume. Diomedes stopped while Claude Code was answering, so that answer's outcome is unknown. The next message starts a new session.",
          cursor: 9,
        },
      }),
    );
    expect(broken).toMatchObject({ state: "Couldn't resume", tone: 'warn' });
    expect(broken?.detail).toContain('outcome is unknown');
    expect(sessionLine(view({ continuity: null }))?.state).toBeNull();
  });

  it('offers the queue only while an answer runs, and only where the contract queues steering', () => {
    expect(claude.steer).toBe('queued');
    expect(canQueue(view(), false)).toBe(false);
    expect(canQueue(view(), true)).toBe(true);
    expect(canQueue(view({ busy: true }), false)).toBe(true);
    expect(canQueue(view({ controls: { ...claude, steer: null } }), true)).toBe(false);
    expect(canQueue(view({ controls: { ...claude, steer: 'live' } }), true)).toBe(false);
  });

  it('labels a queued message by what the record says became of it', () => {
    const at = new Date().toISOString();
    expect(queuedLabel({ commandId: 'c', state: 'pending', detail: 'x', at })).toBe(
      'Queued: sent when the current answer finishes',
    );
    expect(queuedLabel({ commandId: 'c', state: 'delivered', detail: 'x', at })).toBe('Sent');
    expect(queuedLabel({ commandId: 'c', state: 'cancelled', detail: 'Withdrawn by Stop before it was sent.', at })).toBe(
      'Withdrawn by Stop before it was sent.',
    );
  });
});
