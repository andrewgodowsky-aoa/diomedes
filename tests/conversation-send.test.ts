import { beforeEach, describe, expect, test, vi } from 'vitest';

// The client half of contract I-1: one identity per message, saved before the first request,
// and carried unchanged by every retry. The server half is tests/interaction-seam.test.ts.

const PROJECT = 'proj-1';
const THREAD = 'thread-1';
const PENDING = `diomedes.conversation.pending.${PROJECT}|${THREAD}`;
const CLAIM = `diomedes.conversation.claim.${PROJECT}|${THREAD}`;
const LAST = `diomedes.conversation.last.${PROJECT}|${THREAD}`;
const LOCK = `diomedes.conversation.send.${PROJECT}|${THREAD}`;
const input = (text = 'Order the usual') => ({ text, mode: 'auto' as const, sources: [] });

function makeStorage() {
  const map = new Map<string, string>();
  let failSet = false;
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem(k: string, v: string) {
      if (failSet) throw new Error('quota');
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    failSet() {
      failSet = true;
    },
  };
}

/**
 * A browser's Web Locks, in process: one exclusive holder per name, everyone else queued in the
 * order they asked, and a wait the caller's signal can end. One manager is made per test and left
 * on `navigator`, so two module instances share it the way two windows of one browser do.
 */
function makeLocks() {
  const tail = new Map<string, Promise<void>>();
  return {
    async request(name: string, options: { signal?: AbortSignal }, callback: () => unknown) {
      const signal = options?.signal;
      const previous = tail.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      tail.set(
        name,
        previous.then(() => mine),
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const stop = () => reject(new DOMException('aborted', 'AbortError'));
          if (signal?.aborted) return stop();
          signal?.addEventListener('abort', stop);
          void previous.then(() => {
            signal?.removeEventListener('abort', stop);
            resolve();
          });
        });
      } catch (error) {
        release();
        throw error;
      }
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}
/** One turn of the event loop, so a window that is waiting has had every chance to act. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let session: ReturnType<typeof makeStorage>;
let local: ReturnType<typeof makeStorage>;
let fetchMock: ReturnType<typeof vi.fn>;
let mod: typeof import('../client/conversation-send.js');

const sent = (n: number) => JSON.parse(fetchMock.mock.calls[n][1].body);
const answered = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    runId: 'run-1',
    commandId: sent(fetchMock.mock.calls.length - 1).commandId,
    sourceMessageId: 'sm.' + 'a'.repeat(32),
    answerText: 'Done.',
    interrupted: false,
    outcome: { status: 'answered' },
  }),
});
const refused = (status: number) => ({
  ok: false,
  status,
  json: async () => ({ error: { message: `refused ${status}` } }),
});

beforeEach(async () => {
  vi.resetModules();
  session = makeStorage();
  local = makeStorage();
  fetchMock = vi.fn();
  let n = 0;
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++n}` });
  vi.stubGlobal('navigator', { locks: makeLocks() });
  mod = await import('../client/conversation-send.js');
});

describe('sending one message', () => {
  test('the message is saved before the first request, and cleared once it is confirmed', async () => {
    fetchMock.mockImplementationOnce(async () => {
      expect(JSON.parse(session.getItem(PENDING)!).commandId).toBe('uuid-1');
      return answered();
    });
    const result = await mod.sendMessage(PROJECT, THREAD, input());
    expect(result.answerText).toBe('Done.');
    expect(sent(0)).toEqual({ ...input(), commandId: 'uuid-1', consent: true });
    expect(session.getItem(PENDING)).toBeNull();
    expect(local.getItem(LAST)).toBe('uuid-1');
    expect(mod.lastCommand(PROJECT, THREAD)).toBe('uuid-1');
  });

  test('an uncertain failure retries once with the same identity and the same body', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual(sent(0));
  });

  test('two uncertain failures keep the message, and sending it again reuses its identity', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    expect(mod.pendingMessage(PROJECT, THREAD)).toMatchObject({
      commandId: 'uuid-1',
      input: input(),
    });
    fetchMock.mockReset().mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(sent(0).commandId).toBe('uuid-1');
    expect(session.getItem(PENDING)).toBeNull();
  });

  test('a first attempt the server refuses is cleared, so the next send is a new message', async () => {
    fetchMock.mockResolvedValueOnce(refused(409));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toMatchObject({ status: 409 });
    expect(session.getItem(PENDING)).toBeNull();
    fetchMock.mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(sent(1).commandId).toBe('uuid-2');
  });

  test('a refusal after an uncertain attempt keeps the message: the first attempt may have landed', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(refused(409));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toMatchObject({ status: 409 });
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-1');
  });

  test('a different text while one is unconfirmed sends nothing', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow();
    fetchMock.mockReset();
    await expect(mod.sendMessage(PROJECT, THREAD, input('Order double'))).rejects.toThrow(
      /never confirmed/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // Discarding is the person's own act; after it the new text is a new message.
    expect(await mod.discardPendingMessage(PROJECT, THREAD, 'uuid-1')).toBe(true);
    fetchMock.mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input('Order double'));
    expect(sent(0).commandId).toBe('uuid-2');
  });

  test('stopping keeps the message and does not retry', async () => {
    const stop = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      stop.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(mod.sendMessage(PROJECT, THREAD, input(), stop.signal)).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-1');
  });

  test('a second identical send while the first is in flight is the same request', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(answered()))),
    );
    const first = mod.sendMessage(PROJECT, THREAD, input());
    const second = mod.sendMessage(PROJECT, THREAD, input());
    // Both are asked for before anything is sent: a lock is granted no sooner than the next turn.
    await settle();
    release();
    expect(await second).toBe(await first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a different message while one is in flight is refused as itself, never called unconfirmed', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(answered()))),
    );
    const first = mod.sendMessage(PROJECT, THREAD, input());
    const other = mod.sendMessage(PROJECT, THREAD, input('Something else'));
    // It was never sent, so the page may hand it back. Only the first can be unconfirmed.
    await expect(other).rejects.toThrow(/never confirmed/);
    await expect(other).rejects.not.toBeInstanceOf(mod.UnconfirmedMessage);
    await settle();
    release();
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0).text).toBe('Order the usual');
  });

  test('nothing is sent when the message cannot be saved first', async () => {
    session.failSet();
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/cannot save/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a damaged saved message sends nothing, and a reply for another command confirms nothing', async () => {
    session.setItem(PENDING, JSON.stringify({ commandId: 'x', projectId: 'other', threadId: THREAD }));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/damaged/);
    expect(fetchMock).not.toHaveBeenCalled();
    session.clear();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ commandId: 'someone-else', outcome: { status: 'answered' } }),
    });
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-1');
  });
});

describe('starting a proposal, and reading an outcome', () => {
  const started = {
    ok: true,
    status: 200,
    json: async () => ({ commandId: 'c1', outcome: { status: 'started' } }),
  };
  const selection = { proposalDigest: 'd'.repeat(64), projectId: 'target' };

  test('a selection carries consent, the digest and the target, to the message it belongs to', async () => {
    fetchMock.mockResolvedValueOnce(started);
    await mod.selectProposal(PROJECT, THREAD, 'c1', selection);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/projects/${PROJECT}/threads/${THREAD}/messages/c1/select`,
    );
    expect(sent(0)).toEqual({ ...selection, consent: true });
  });

  test('a selection retries once when uncertain and never after a refusal', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(started);
    await mod.selectProposal(PROJECT, THREAD, 'c1', selection);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset().mockResolvedValueOnce(refused(409));
    await expect(mod.selectProposal(PROJECT, THREAD, 'c1', selection)).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('an outcome this thread never held reads as null, and any other failure is a failure', async () => {
    fetchMock.mockResolvedValueOnce(refused(404));
    expect(await mod.readOutcome(PROJECT, THREAD, 'c1')).toBeNull();
    fetchMock.mockResolvedValueOnce(refused(500));
    await expect(mod.readOutcome(PROJECT, THREAD, 'c1')).rejects.toMatchObject({ status: 500 });
  });

  test('a stored last command that is not a command identity is ignored', () => {
    local.setItem(LAST, 'not a command id!');
    expect(mod.lastCommand(PROJECT, THREAD)).toBeNull();
  });
});

describe('one pending message, shared by every window', () => {
  /** A second window: this browser's local storage and locks, a new session store and module. */
  const newWindow = async () => {
    vi.stubGlobal('sessionStorage', makeStorage());
    vi.resetModules();
    return import('../client/conversation-send.js');
  };
  /** A send whose first request is held open, so another window meets a lock that is taken. */
  function heldSend(reply: () => unknown) {
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementationOnce(async () => {
      reached();
      await held;
      return reply();
    });
    return { arrived, release: () => release() };
  }

  test('a second window waits for the first, then sends its command and not a new one', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    const first = heldSend(() => {
      throw new TypeError('network');
    });
    const a = mod.sendMessage(PROJECT, THREAD, input());
    await first.arrived;
    const secondWindow = await newWindow();
    const b = secondWindow.sendMessage(PROJECT, THREAD, input());
    await settle();
    await settle();
    // The first window holds the lock, so the second has asked the server for nothing at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.release();
    await expect(a).rejects.toBeInstanceOf(mod.UnconfirmedMessage);
    await expect(b).rejects.toBeInstanceOf(secondWindow.UnconfirmedMessage);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sent(0).commandId).toBe('uuid-1');
    expect(sent(2)).toEqual(sent(0));
    expect(sent(3)).toEqual(sent(0));
  });

  test('equal text sent after the first was confirmed is a second message', async () => {
    fetchMock.mockImplementation(answered);
    const first = heldSend(answered);
    const a = mod.sendMessage(PROJECT, THREAD, input());
    await first.arrived;
    const secondWindow = await newWindow();
    const b = secondWindow.sendMessage(PROJECT, THREAD, input());
    await settle();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.release();
    await a;
    await b;
    // Only a pending claim is shared. Nothing deduplicates equal text once it is confirmed, so
    // this is what pressing Enter twice means, in one window or in two.
    expect(sent(0).commandId).toBe('uuid-1');
    expect(sent(1).commandId).toBe('uuid-2');
    expect(local.getItem(CLAIM)).toBeNull();
  });

  test('another window refuses a different message while one is pending', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    const secondWindow = await newWindow();
    fetchMock.mockReset();
    await expect(secondWindow.sendMessage(PROJECT, THREAD, input('Order double'))).rejects.toThrow(
      /never confirmed/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a reload finds the pending message and sends its command again', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    // The same window: its session storage and this browser's local storage both outlive the page.
    vi.resetModules();
    const reloaded = await import('../client/conversation-send.js');
    expect(reloaded.pendingMessage(PROJECT, THREAD)).toMatchObject({
      commandId: 'uuid-1',
      input: input(),
    });
    fetchMock.mockReset().mockImplementationOnce(answered);
    await reloaded.sendMessage(PROJECT, THREAD, input());
    expect(sent(0).commandId).toBe('uuid-1');
    expect(session.getItem(PENDING)).toBeNull();
    expect(local.getItem(CLAIM)).toBeNull();
  });

  test('a discard in another window is seen here, and the next send is a new message', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    const firstWindow = session;
    const secondWindow = await newWindow();
    expect(await secondWindow.discardPendingMessage(PROJECT, THREAD, 'uuid-1')).toBe(true);
    vi.stubGlobal('sessionStorage', firstWindow);
    expect(mod.pendingMessage(PROJECT, THREAD)).toBeNull();
    expect(firstWindow.getItem(PENDING)).toBeNull();
    fetchMock.mockReset().mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(sent(0).commandId).toBe('uuid-2');
  });

  test('a confirmation in another window is seen here, and drops the reference to it', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    const firstWindow = session;
    const secondWindow = await newWindow();
    fetchMock.mockImplementationOnce(answered);
    await secondWindow.sendMessage(PROJECT, THREAD, input());
    vi.stubGlobal('sessionStorage', firstWindow);
    expect(JSON.parse(firstWindow.getItem(PENDING)!).commandId).toBe('uuid-1');
    expect(mod.pendingMessage(PROJECT, THREAD)).toBeNull();
    expect(firstWindow.getItem(PENDING)).toBeNull();
  });

  test('a claim naming the last confirmed command is cleaned up, never offered back', async () => {
    fetchMock.mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    const record = JSON.stringify({
      commandId: 'uuid-1',
      projectId: PROJECT,
      threadId: THREAD,
      input: input(),
    });
    // What a cleanup that failed after the confirmation would have left behind.
    local.setItem(CLAIM, record);
    session.setItem(PENDING, record);
    expect(mod.lastCommand(PROJECT, THREAD)).toBe('uuid-1');
    expect(mod.pendingMessage(PROJECT, THREAD)).toBeNull();
    // The removal waits its turn for the lock, like every other change to the shared claim.
    await settle();
    expect(local.getItem(CLAIM)).toBeNull();
    expect(session.getItem(PENDING)).toBeNull();
  });

  /**
   * Another window, reduced to what matters here: it holds this conversation's lock, and before it
   * lets go it settles the pending message and claims a newer one.
   */
  function otherWindowHolds(replacement: string) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locks = (navigator as unknown as { locks: ReturnType<typeof makeLocks> }).locks;
    const done = locks.request(LOCK, {}, async () => {
      await held;
      local.setItem(LAST, 'uuid-1');
      local.setItem(
        CLAIM,
        JSON.stringify({
          commandId: replacement,
          projectId: PROJECT,
          threadId: THREAD,
          input: input('Order double'),
        }),
      );
    });
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }

  test('Discard gives up the command it names and no other', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    expect(await mod.discardPendingMessage(PROJECT, THREAD, 'uuid-9')).toBe(false);
    expect(JSON.parse(local.getItem(CLAIM)!).commandId).toBe('uuid-1');
    expect(JSON.parse(session.getItem(PENDING)!).commandId).toBe('uuid-1');
    expect(await mod.discardPendingMessage(PROJECT, THREAD, 'uuid-1')).toBe(true);
    expect(local.getItem(CLAIM)).toBeNull();
    expect(session.getItem(PENDING)).toBeNull();
  });

  test('a Discard that waited for the lock looks again, and leaves a newer message alone', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    const other = otherWindowHolds('uuid-9');
    // Pressed while the claim still named uuid-1; it is queued behind the other window.
    const discarded = mod.discardPendingMessage(PROJECT, THREAD, 'uuid-1');
    await settle();
    expect(JSON.parse(local.getItem(CLAIM)!).commandId).toBe('uuid-1');
    await other.release();
    expect(await discarded).toBe(false);
    expect(JSON.parse(local.getItem(CLAIM)!)).toMatchObject({
      commandId: 'uuid-9',
      input: input('Order double'),
    });
    // This window's own reference to the message it was shown is gone; the newer one is offered.
    expect(session.getItem(PENDING)).toBeNull();
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-9');
  });

  test('a cleanup that runs late never takes a newer message with it', async () => {
    fetchMock.mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    // What a cleanup that failed after the confirmation would have left behind.
    local.setItem(
      CLAIM,
      JSON.stringify({ commandId: 'uuid-1', projectId: PROJECT, threadId: THREAD, input: input() }),
    );
    const other = otherWindowHolds('uuid-9');
    // Reading schedules the cleanup of uuid-1. Another window claims a newer message first.
    expect(mod.pendingMessage(PROJECT, THREAD)).toBeNull();
    await settle();
    expect(JSON.parse(local.getItem(CLAIM)!).commandId).toBe('uuid-1');
    await other.release();
    await settle();
    expect(JSON.parse(local.getItem(CLAIM)!).commandId).toBe('uuid-9');
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-9');
  });

  test('a claim left by a failed cleanup neither blocks a new message nor lends it an identity', async () => {
    fetchMock.mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    const stale = JSON.stringify({
      commandId: 'uuid-1',
      projectId: PROJECT,
      threadId: THREAD,
      input: input(),
    });
    local.setItem(CLAIM, stale);
    session.setItem(PENDING, stale);
    // The same words again are a second message, not the first one sent twice.
    fetchMock.mockReset().mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(sent(0).commandId).toBe('uuid-2');
    // And different words are not refused for a message that was already confirmed.
    local.setItem(
      CLAIM,
      JSON.stringify({ commandId: 'uuid-2', projectId: PROJECT, threadId: THREAD, input: input() }),
    );
    fetchMock.mockReset().mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input('Order double'));
    expect(sent(0).commandId).toBe('uuid-3');
    expect(local.getItem(CLAIM)).toBeNull();
  });

  test('Send again dispatches the saved body under the command the claim holds', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    const original = sent(0);
    fetchMock.mockReset().mockImplementationOnce(answered);
    const result = await mod.resendPending(PROJECT, THREAD, 'uuid-1');
    expect(result.answerText).toBe('Done.');
    expect(sent(0)).toEqual(original);
    expect(local.getItem(CLAIM)).toBeNull();
    expect(session.getItem(PENDING)).toBeNull();
    expect(mod.lastCommand(PROJECT, THREAD)).toBe('uuid-1');
  });

  test('Send again reads the record when another window settled the message', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    local.removeItem(CLAIM);
    fetchMock.mockReset().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        runId: 'run-1',
        commandId: 'uuid-1',
        sourceMessageId: 'sm.' + 'a'.repeat(32),
        answerText: 'Answered there.',
        interrupted: false,
        outcome: { status: 'answered' },
      }),
    });
    const result = await mod.resendPending(PROJECT, THREAD, 'uuid-1');
    expect(result.answerText).toBe('Answered there.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(mod.lastCommand(PROJECT, THREAD)).toBe('uuid-1');
    expect(session.getItem(PENDING)).toBeNull();
  });

  test('Send again sends nothing for a message another window discarded', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    local.removeItem(CLAIM);
    fetchMock.mockReset().mockResolvedValueOnce(refused(404));
    await expect(mod.resendPending(PROJECT, THREAD, 'uuid-1')).rejects.toThrow(
      /discarded or settled/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(session.getItem(PENDING)).toBeNull();
  });

  test('Send again never sends a command the claim has replaced', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    fetchMock.mockReset().mockResolvedValueOnce(refused(404));
    await expect(mod.resendPending(PROJECT, THREAD, 'uuid-9')).rejects.toThrow(
      /discarded or settled/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/messages/uuid-9');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    // The message that is pending is still pending, and still this window's.
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-1');
    expect(JSON.parse(session.getItem(PENDING)!).commandId).toBe('uuid-1');
  });

  test('stopping while another window holds the lock sends nothing and saves nothing', async () => {
    fetchMock.mockImplementation(answered);
    const first = heldSend(answered);
    const a = mod.sendMessage(PROJECT, THREAD, input());
    await first.arrived;
    const secondSession = makeStorage();
    vi.stubGlobal('sessionStorage', secondSession);
    vi.resetModules();
    const secondWindow = await import('../client/conversation-send.js');
    const stop = new AbortController();
    const b = secondWindow.sendMessage(PROJECT, THREAD, input(), stop.signal);
    stop.abort();
    const failure = await b.catch((error: unknown) => error);
    // A wait that Stop ended held nothing and sent nothing; it is not a message that may have run.
    expect(failure).not.toBeInstanceOf(secondWindow.UnconfirmedMessage);
    expect((failure as Error).message).toMatch(/Another window is still sending/);
    expect(secondSession.getItem(PENDING)).toBeNull();
    expect(JSON.parse(local.getItem(CLAIM)!).commandId).toBe('uuid-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.release();
    await a;
  });

  test('without the Web Locks API nothing is sent and nothing is written', async () => {
    vi.stubGlobal('navigator', {});
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/cannot save/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.getItem(PENDING)).toBeNull();
    expect(local.getItem(CLAIM)).toBeNull();
  });

  test('a claim that cannot be written sends nothing and leaves no reference', async () => {
    local.failSet();
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/cannot save/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.getItem(PENDING)).toBeNull();
  });

  test('a reference no claim backs is dropped even when the next claim cannot be written', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    // Another window confirmed or discarded that message and left this reference behind.
    local.removeItem(CLAIM);
    local.failSet();
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/cannot save/);
    expect(session.getItem(PENDING)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a reference that cannot be written takes the claim back with it', async () => {
    session.failSet();
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/cannot save/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.getItem(CLAIM)).toBeNull();
  });
});

// CD-05.R-2's reproducer, pasted unchanged from docs/implementation/2026-09-21-core-agent-client-review-r2.md.
test('CD05-R-06: another window retries the pending command', async () => {
  fetchMock.mockRejectedValue(new TypeError('network'));
  await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
    mod.UnconfirmedMessage,
  );
  const original = sent(0);
  const firstWindow = session;
  // A new tab shares local storage, but has a new session storage and module instance.
  vi.stubGlobal('sessionStorage', makeStorage());
  vi.resetModules();
  const secondWindow = await import('../client/conversation-send.js');
  fetchMock.mockImplementationOnce(answered);
  await secondWindow.sendMessage(PROJECT, THREAD, input());
  expect(JSON.parse(firstWindow.getItem(PENDING)!).commandId).toBe(original.commandId);
  // Candidate sends uuid-2 here, after two attempts with uuid-1 in the first window.
  expect(sent(2)).toEqual(original);
});
