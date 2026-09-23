import { describe, expect, test } from 'vitest';
import { directOrigin, formatOrigin, originForTurn, originForNeed } from '../shared/attribution.js';
import type { Need, Turn } from '../shared/types.js';

describe('historical origin formatter', () => {
  test('uses protocol model evidence, never generated self-identification or the current picker', () => {
    const turn: Turn = { id: 't', role: 'diomedes', at: '', mode: 'ask', sources: [], text: 'I am a different model',
      helper: { engine: 'codex', model: 'verified-model', verified: true } };
    expect(formatOrigin(originForTurn(turn)).primary).toBe('verified-model');
    expect(formatOrigin(originForTurn(turn)).secondary).toBe('via ChatGPT');
    expect(formatOrigin(originForTurn({ ...turn, helper: { engine: 'codex', model: 'unverified', verified: false } })).primary).toBe('ChatGPT');
  });
  test('legacy unknown records and actual supervisor/application actions stay distinguishable', () => {
    expect(formatOrigin().primary).toBe('Assistant');
    expect(formatOrigin().secondary).toBe('model not recorded');
    expect(formatOrigin({ protocolVersion: 1, mode: 'application', engine: null, model: { requested: null, reported: null, source: 'not-recorded' } }).detail).toContain('application');
    expect(formatOrigin({ protocolVersion: 1, mode: 'supervisor', engine: null, model: { requested: null, reported: null, source: 'not-recorded' } }).detail).toContain('supervisor');
  });
  test('a pending proposal keeps its own snapshot when a session later changes', () => {
    const captured = directOrigin({ engine: 'opencode', reportedModel: 'muse-reported', requestedModel: 'muse-requested', version: '1.18.4' });
    const need = { origin: captured } as Need;
    expect(formatOrigin(originForNeed(need)).label).toBe('muse-reported via OpenCode');
    expect(captured.model.requested).toBe('muse-requested');
  });
  test('control and bidirectional characters cannot spoof a label', () => {
    const origin = directOrigin({ engine: 'codex', reportedModel: '\u001b[31mmodel\u202Ename\n' });
    expect(formatOrigin(origin).primary).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/);
  });
  test('a run in flight names the model it was sent to as a request, never as the model that answered', () => {
    const running = formatOrigin(directOrigin({ engine: 'codex', requestedModel: 'gpt-6-astra' }));
    expect(running.primary).toBe('gpt-6-astra');
    expect(running.secondary).toBe('requested via ChatGPT');
    expect(running.detail).toContain('has not reported');
    // Once the runtime reports, the report wins and the request is not shown.
    const done = formatOrigin(directOrigin({ engine: 'codex', requestedModel: 'gpt-6-astra', reportedModel: 'gpt-6-astra-0918' }));
    expect(done.primary).toBe('gpt-6-astra-0918');
    expect(done.secondary).toBe('via ChatGPT');
    // Neither known: still says so.
    expect(formatOrigin(directOrigin({ engine: 'codex' })).secondary).toBe('model not recorded');
  });
  test('an engine id outside the registry is shown as itself', () => {
    expect(formatOrigin(directOrigin({ engine: 'some-new-engine', reportedModel: 'm' })).secondary).toBe('via some-new-engine');
  });
});
