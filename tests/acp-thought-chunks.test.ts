import { describe, expect, test } from 'vitest';
import { acpSessionUpdate, type AcpTurn } from '../server/engines/acp-client.js';

const profile = { name: 'Cursor' } as Parameters<typeof acpSessionUpdate>[0];
const rpc = { replaying: false, sessionId: 's-1' } as Parameters<typeof acpSessionUpdate>[1];
const thought = (content: unknown) => ({
  sessionId: 's-1',
  update: { sessionUpdate: 'agent_thought_chunk', content },
});

describe('ACP thought chunks', () => {
  test('text thought inside the prompted turn reaches the thinking sink, never the answer', () => {
    const thoughts: string[] = [];
    const turn: AcpTurn = { text: '', model: 'm', prompting: true, onReasoningDelta: (text) => thoughts.push(text) };
    acpSessionUpdate(profile, rpc, thought({ type: 'text', text: 'Weighing the menu.' }), turn, {});
    expect(thoughts).toEqual(['Weighing the menu.']);
    expect(turn.text).toBe('');
  });

  test('thought outside a turn, or not text, is dropped without stopping anything', () => {
    const thoughts: string[] = [];
    const idle: AcpTurn = { text: '', model: 'm', prompting: false, onReasoningDelta: (text) => thoughts.push(text) };
    expect(() => acpSessionUpdate(profile, rpc, thought({ type: 'text', text: 'late' }), idle, {})).not.toThrow();
    const busy: AcpTurn = { ...idle, prompting: true };
    expect(() => acpSessionUpdate(profile, rpc, thought({ type: 'image', data: '' }), busy, {})).not.toThrow();
    expect(() => acpSessionUpdate(profile, rpc, thought(null), busy, {})).not.toThrow();
    expect(thoughts).toEqual([]);
  });
});
