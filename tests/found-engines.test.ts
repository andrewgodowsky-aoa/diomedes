/** Spec decision 5: which engines a conversation may offer, and how a gone engine is refused. */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ENGINES,
  ENGINE_GONE_CODES,
  engineGoneSentence,
  foundConversationEngines,
  isChatGptFound,
  isFoundEngine,
} from '../shared/conversation-engines';
import type { EngineConnection } from '../shared/engines';
import type { IntegrationStatus } from '../shared/types';

const connection = (engine: string, over: Partial<EngineConnection> = {}) =>
  ({
    engine,
    installation: 'found',
    compatibility: 'supported',
    authentication: 'signed-in',
    accountRoute: `${engine}:fixture`,
    models: [{ slug: 'fixture-model', name: 'Fixture', description: '', efforts: [], defaultEffort: null }],
    checkedAt: '2026-09-27T00:00:00.000Z',
    detail: 'Fixture',
    usage: { state: 'unknown', checkedAt: null },
    repair: null,
    routeIssue: null,
    ...over,
  }) as unknown as EngineConnection;
const chatgpt = (over: Partial<IntegrationStatus> = {}) =>
  ({
    id: 'codex',
    name: 'ChatGPT',
    kind: 'online',
    found: true,
    available: true,
    enabled: true,
    signIn: 'signed-in',
    adapter: 'ready',
    installedVersion: '0.153.4',
    status: 'Ready',
    detail: 'Fixture',
    capabilities: [],
    disclosure: [],
    ...over,
  }) as unknown as IntegrationStatus;

describe('found engines', () => {
  it('finds an engine only when it is installed, compatible, signed in and lists a model', () => {
    expect(isFoundEngine(connection('cursor'))).toBe(true);
    expect(isFoundEngine(undefined)).toBe(false);
    expect(isFoundEngine(connection('cursor', { installation: 'missing' }))).toBe(false);
    expect(isFoundEngine(connection('cursor', { installation: 'not-checked' }))).toBe(false);
    expect(isFoundEngine(connection('cursor', { compatibility: 'unsupported' }))).toBe(false);
    expect(isFoundEngine(connection('cursor', { authentication: 'signed-out' }))).toBe(false);
    expect(isFoundEngine(connection('cursor', { authentication: 'unknown' }))).toBe(false);
    expect(isFoundEngine(connection('cursor', { models: [] }))).toBe(false);
    expect(isFoundEngine(connection('cursor', { repair: 'binding-missing' as never }))).toBe(false);
    expect(isFoundEngine(connection('cursor', { routeIssue: { required: 'x' } as never }))).toBe(false);
  });

  it("finds ChatGPT only when Diomedes' own Codex runtime answered and ChatGPT is signed in", () => {
    expect(isChatGptFound(chatgpt())).toBe(true);
    expect(isChatGptFound(undefined)).toBe(false);
    expect(isChatGptFound(chatgpt({ signIn: 'unknown' }))).toBe(false);
    expect(isChatGptFound(chatgpt({ signIn: 'not-signed-in' }))).toBe(false);
    expect(isChatGptFound(chatgpt({ found: false }))).toBe(false);
    expect(isChatGptFound(chatgpt({ id: 'localai' }))).toBe(false);
  });

  it('offers only found engines, in the order a person reads them, and suggests the plan only when none is found', () => {
    expect(CONVERSATION_ENGINES).toEqual(['claude-code', 'codex', 'opencode', 'cursor', 'devin']);
    expect(
      foundConversationEngines({
        connections: [
          connection('devin'),
          connection('claude-code', { authentication: 'signed-out' }),
          connection('opencode'),
          connection('oh-my-pi'),
        ],
        integrations: [chatgpt()],
      }),
    ).toEqual({ engines: ['codex', 'opencode', 'devin'], suggestPlan: false });
    expect(
      foundConversationEngines({
        connections: [connection('cursor', { installation: 'missing' })],
        integrations: [chatgpt({ signIn: 'not-signed-in' })],
      }),
    ).toEqual({ engines: [], suggestPlan: true });
  });

  it("refuses a gone engine in that engine's own words, and never tells a person to install or choose one", () => {
    expect(engineGoneSentence('codex', 'signed-out')).toBe(
      "ChatGPT isn't signed in on this computer, so this conversation can't continue here. Nothing was sent.",
    );
    expect(engineGoneSentence('cursor', 'not-installed')).toBe(
      "Cursor isn't installed on this computer, so this conversation can't continue here. Nothing was sent.",
    );
    for (const engine of CONVERSATION_ENGINES)
      for (const gone of ['not-installed', 'signed-out'] as const)
        expect(engineGoneSentence(engine, gone)).not.toMatch(/\b(install it|install one|choose|select|try)\b/i);
    expect(ENGINE_GONE_CODES).toEqual({
      NOT_INSTALLED: 'not-installed',
      NATIVE_NOT_INSTALLED: 'not-installed',
      AUTH_REQUIRED: 'signed-out',
      CHATGPT_REQUIRED: 'signed-out',
    });
  });
});
