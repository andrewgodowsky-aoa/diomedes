/**
 * "Update this conversation" in the Console, the part that is not React
 * (client/console/conversation-update.ts): the one command an update is sent under until the
 * server answers it, where the conversation menu can act, and the confirmation's words, which are
 * the server's decision and never the client's own guess at the route.
 */
import { describe, expect, test } from 'vitest';
import {
  canUpdate,
  memorySentence,
  updateAnswered,
  updateCommand,
  updateUnanswered,
  updateUnconfirmed,
} from '../client/console/conversation-update';

const minted = () => {
  let n = 0;
  return () => `u-${++n}`;
};

describe('the command an update is sent under', () => {
  test('stays the same until the server answers it, so a press after a lost answer reads back', () => {
    const mint = minted();
    const first = updateCommand('p1', 't1', mint);
    // Closed and opened again before anything was sent: the same command.
    expect(updateCommand('p1', 't1', mint)).toBe(first);
    // Sent, and the answer never arrived: still the same command, and the thread says so.
    updateUnanswered('p1', 't1', first);
    expect(updateUnconfirmed('p1', 't1')).toBe(true);
    expect(updateCommand('p1', 't1', mint)).toBe(first);
    // Answered, whatever the answer: the next update is a new command.
    updateAnswered('p1', 't1', first);
    expect(updateUnconfirmed('p1', 't1')).toBe(false);
    expect(updateCommand('p1', 't1', mint)).not.toBe(first);
  });

  test('belongs to one thread, and an answer to an older command never clears a newer one', () => {
    const mint = minted();
    const here = updateCommand('p2', 't1', mint);
    const there = updateCommand('p2', 't2', mint);
    expect(there).not.toBe(here);
    updateUnanswered('p2', 't1', here);
    expect(updateUnconfirmed('p2', 't2')).toBe(false);
    updateAnswered('p2', 't1', 'u-old');
    expect(updateUnconfirmed('p2', 't1')).toBe(true);
    expect(updateCommand('p2', 't1', mint)).toBe(here);
  });
});

describe('the conversation menu', () => {
  test('can act only where the server would start something fresh, or an unanswered update can be checked', () => {
    expect(canUpdate(null, false)).toBe(false);
    expect(canUpdate({ retiring: 0, carried: false, route: 'aws-bedrock' }, false)).toBe(false);
    expect(canUpdate({ retiring: 1, carried: true, route: 'aws-bedrock' }, false)).toBe(true);
    expect(canUpdate({ retiring: 2, carried: false, route: null, reason: 'other' }, false)).toBe(true);
    expect(canUpdate({ retiring: 0, carried: false, route: 'aws-bedrock' }, true)).toBe(true);
    expect(canUpdate(null, true)).toBe(true);
  });
});

describe('the confirmation says what the server decided', () => {
  test('for each decision, naming the route the next message takes', () => {
    expect(memorySentence({ retiring: 1, carried: true, route: 'aws-bedrock' })).toBe(
      'History sharing is on for AWS Bedrock, so Nectovia will carry over your most recent messages.',
    );
    expect(memorySentence({ retiring: 1, carried: false, route: 'aws-bedrock', reason: 'history-off' })).toBe(
      "History sharing is off for AWS Bedrock, so your earlier messages stay on screen but Nectovia won't remember them. Updating doesn't turn sharing on.",
    );
    expect(memorySentence({ retiring: 1, carried: false, route: 'google-vertex', reason: 'other-route' })).toBe(
      "Your earlier messages were answered on another service, so Nectovia won't carry them over to Google Vertex AI. They stay on screen.",
    );
    for (const route of [null, 'claude-code'])
      expect(memorySentence({ retiring: 1, carried: false, route, reason: 'other' })).toBe(
        "Your earlier messages stay on screen, but Nectovia won't remember them.",
      );
    expect(memorySentence({ retiring: 1, carried: true, route: 'claude-code' })).toBe(
      'History sharing is on for Claude Code, so Nectovia will carry over your most recent messages.',
    );
  });
});
