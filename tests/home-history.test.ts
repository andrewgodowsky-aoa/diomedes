import { describe, expect, test } from 'vitest';
import {
  historyLine,
  nextRoute,
  shareHistory,
  sharesHistoryWith,
  stopSharingHistory,
  type HomeSharing,
  type HomeSharingChange,
} from '../client/console/home-history';
import type { Route, Turn } from '../shared/types';

// The All projects conversation's history sharing, as the Nectovia page decides it: what a grant
// and a revoke send, when the line near the composer shows, and which route it names. Pure, so it
// runs under Node the way tests/diomedes-view.test.ts runs the page's view-model.

const policy = (patch: Partial<HomeSharing> = {}): HomeSharing => ({
  version: 3,
  routes: [],
  documents: [],
  shareConversationHistory: false,
  shareReviewPackets: false,
  ...patch,
});
/** What the host stores for a change it accepts (`changeCloudSharing`). */
const stored = (before: HomeSharing, change: HomeSharingChange): HomeSharing => ({
  version: before.version + 1,
  routes: change.routes,
  documents: change.documents,
  shareConversationHistory: change.shareConversationHistory,
  shareReviewPackets: change.shareReviewPackets,
});
let n = 0;
const turn = (role: Turn['role'], route: Route = 'aws-bedrock'): Turn => ({
  id: `t${++n}`,
  role,
  mode: 'auto',
  text: role,
  at: '2026-09-23T12:00:00.000Z',
  sources: [],
  route,
});
const exchange = () => [turn('you'), turn('assistant')];

describe('what a grant and a revoke send', () => {
  test('a grant adds the route and turns history on, and sends documents and review packets back as read', () => {
    const before = policy({ documents: ['menu.md'], shareReviewPackets: true });
    expect(shareHistory(before, 'aws-bedrock')).toEqual({
      expectedVersion: 3,
      routes: ['aws-bedrock'],
      documents: ['menu.md'],
      shareConversationHistory: true,
      shareReviewPackets: true,
    });
  });

  test('a grant keeps the routes that already have history', () => {
    const before = policy({ routes: ['claude-code'], shareConversationHistory: true });
    expect(shareHistory(before, 'aws-bedrock')).toMatchObject({
      routes: ['claude-code', 'aws-bedrock'],
      shareConversationHistory: true,
    });
  });

  test('revoking one route leaves history on for the routes still chosen', () => {
    const both = policy({ routes: ['aws-bedrock', 'claude-code'], shareConversationHistory: true });
    const after = stored(both, stopSharingHistory(both, 'aws-bedrock'));
    expect(sharesHistoryWith(after, 'aws-bedrock')).toBe(false);
    expect(sharesHistoryWith(after, 'claude-code')).toBe(true);
  });

  test('revoking the last route turns history off and lists no route', () => {
    const one = policy({ routes: ['aws-bedrock'], shareConversationHistory: true });
    expect(stopSharingHistory(one, 'aws-bedrock')).toEqual({
      expectedVersion: 3,
      routes: [],
      documents: [],
      shareConversationHistory: false,
      shareReviewPackets: false,
    });
  });

  test('a revoked route is not switched back on by a later grant for another route', () => {
    let current = policy();
    current = stored(current, shareHistory(current, 'aws-bedrock'));
    current = stored(current, stopSharingHistory(current, 'aws-bedrock'));
    current = stored(current, shareHistory(current, 'claude-code'));
    expect(sharesHistoryWith(current, 'claude-code')).toBe(true);
    expect(sharesHistoryWith(current, 'aws-bedrock')).toBe(false);
  });

  test('a route listed with history off never gains it when another route is granted', () => {
    // Only a direct write can list a route with history off (Home has no documents screen).
    const listed = policy({ routes: ['aws-bedrock'], documents: ['menu.md'] });
    const after = stored(listed, shareHistory(listed, 'claude-code'));
    expect(sharesHistoryWith(after, 'claude-code')).toBe(true);
    expect(sharesHistoryWith(after, 'aws-bedrock')).toBe(false);
    expect(after.documents).toEqual(['menu.md']);
  });

  test('history is shared with a route only while it is listed and the switch is on', () => {
    expect(sharesHistoryWith(policy({ routes: ['aws-bedrock'] }), 'aws-bedrock')).toBe(false);
    expect(sharesHistoryWith(policy({ shareConversationHistory: true }), 'aws-bedrock')).toBe(
      false,
    );
    expect(
      sharesHistoryWith(
        policy({ routes: ['aws-bedrock'], shareConversationHistory: true }),
        'aws-bedrock',
      ),
    ).toBe(true);
  });
});

describe('the line near the composer', () => {
  test('says each answer stands alone on a model route whose history is off', () => {
    expect(historyLine({ policy: policy(), route: 'aws-bedrock', turns: exchange() })).toBe(
      "Earlier messages aren't shared with AWS Bedrock, so each answer stands alone.",
    );
    expect(historyLine({ policy: policy(), route: 'google-vertex', turns: exchange() })).toBe(
      "Earlier messages aren't shared with Google Vertex AI, so each answer stands alone.",
    );
  });

  test('says Claude Code cannot answer a follow-up, because that follow-up is refused', () => {
    expect(historyLine({ policy: policy(), route: 'claude-code', turns: exchange() })).toBe(
      "Earlier messages aren't shared with Claude Code, so it can't answer a follow-up.",
    );
  });

  test('is gone once that route has history, and stays while only another route has it', () => {
    const aws = policy({ routes: ['aws-bedrock'], shareConversationHistory: true });
    expect(historyLine({ policy: aws, route: 'aws-bedrock', turns: exchange() })).toBe(null);
    expect(historyLine({ policy: aws, route: 'claude-code', turns: exchange() })).not.toBe(null);
  });

  test('waits for an earlier exchange', () => {
    expect(historyLine({ policy: policy(), route: 'aws-bedrock', turns: [] })).toBe(null);
    expect(historyLine({ policy: policy(), route: 'aws-bedrock', turns: [turn('you')] })).toBe(
      null,
    );
  });

  test('never shows on the sample route', () => {
    expect(historyLine({ policy: policy(), route: 'sample', turns: exchange() })).toBe(null);
  });

  test('says nothing while the sharing record is unread', () => {
    expect(historyLine({ policy: null, route: 'aws-bedrock', turns: exchange() })).toBe(null);
  });
});

describe('the route the next message takes', () => {
  test('is the thread route without a tier, and the default before there is one', () => {
    expect(nextRoute({ engine: 'claude-code', workStyle: null })).toBe('claude-code');
    expect(nextRoute({ engine: null, workStyle: null })).toBe('aws-bedrock');
  });

  test("is the tier's route when the thread has a tier", () => {
    expect(nextRoute({ engine: 'aws-bedrock', workStyle: 'focused' })).toBe('google-vertex');
  });

  test('follows the Settings default tier when the thread has none', () => {
    expect(
      nextRoute({ engine: 'aws-bedrock', workStyle: null, services: { workStyle: 'focused' } }),
    ).toBe('google-vertex');
  });

  test("follows the owner's tier map and the owner-testing pin", () => {
    expect(
      nextRoute({
        engine: 'aws-bedrock',
        workStyle: 'focused',
        services: { focusedRoute: 'azure-openai' },
      }),
    ).toBe('azure-openai');
    expect(
      nextRoute({
        engine: 'aws-bedrock',
        workStyle: 'efficient',
        services: { ownerPinRoute: 'claude-code' },
      }),
    ).toBe('claude-code');
  });

  test('stays on the thread route when the thread pins a model', () => {
    expect(
      nextRoute({ engine: 'aws-bedrock', workStyle: 'focused', requestedModel: 'pinned' }),
    ).toBe('aws-bedrock');
  });
});
