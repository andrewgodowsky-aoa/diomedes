import { describe, expect, test } from 'vitest';
import {
  agentChoiceOf,
  controlOf,
  keepAgentOnly,
  recordRunKind,
  throughConversation,
  withoutAgent,
} from '../shared/agent-choice.js';
import type { Conversation } from '../shared/types.js';

/** DIO-292: what a thread's Agent box holds, and what it decides. */
const thread = (mode: Conversation['mode'], requested: Conversation['requested'] = null) => ({ mode, requested });
const chose = (agent: string) => ({ model: null, effort: null, agent });

describe("a thread's Agent box", () => {
  test('a thread saved before agents keeps behaving as its mode did', () => {
    expect(agentChoiceOf(thread('ask'))).toBe('diomedes.researcher');
    expect(agentChoiceOf(thread('plan'))).toBe('diomedes.architect');
    expect(agentChoiceOf(thread('build'))).toBe('diomedes.builder');
    expect(agentChoiceOf(thread('fix', { model: 'm', effort: null }))).toBe('diomedes.debugger');
    expect(agentChoiceOf(thread('auto'))).toBe('auto');
  });
  test('a chosen agent wins over the stored mode; the general worker and a profile read as Auto', () => {
    expect(agentChoiceOf(thread('ask', chose('diomedes.reviewer')))).toBe('diomedes.reviewer');
    expect(agentChoiceOf(thread('build', chose('diomedes.general')))).toBe('auto');
    expect(agentChoiceOf(thread('build', { model: null, effort: null, profile: 'pr-fast' }))).toBe('auto');
  });
  test('Auto holds proposals to Automatic whatever the last message was picked as', () => {
    expect(controlOf(thread('ask', chose('auto')))).toBe('auto');
    expect(controlOf(thread('build', chose('auto')))).toBe('auto');
    expect(controlOf(thread('plan', chose('diomedes.architect')))).toBe('plan');
    expect(controlOf(thread('build', chose('diomedes.builder')))).toBe('ask');
    // A chosen built-in holds its catalog kind, whatever kind the thread last stored.
    expect(controlOf(thread('auto', chose('diomedes.builder')))).toBe('ask');
    expect(controlOf(thread('ask', chose('diomedes.architect')))).toBe('plan');
    // The four mappings the control sites made from a mode, unchanged for a thread with no agent.
    expect(controlOf(thread('ask'))).toBe('ask');
    expect(controlOf(thread('plan'))).toBe('plan');
    expect(controlOf(thread('build'))).toBe('ask');
    expect(controlOf(thread('fix'))).toBe('ask');
    expect(controlOf(thread('auto'))).toBe('auto');
  });
  test('a route change drops the model and keeps the agent', () => {
    expect(keepAgentOnly({ model: 'm', effort: 'high', agent: 'diomedes.writer' })).toEqual(chose('diomedes.writer'));
    expect(keepAgentOnly({ model: 'm', effort: null })).toBeNull();
    expect(keepAgentOnly({ model: null, effort: null, profile: 'pr-fast' })).toBeNull();
    expect(keepAgentOnly(null)).toBeNull();
  });
  test('a mode an API caller names drops a saved agent, so the thread reads as that mode did', () => {
    expect(withoutAgent({ model: 'm', effort: 'high', agent: 'auto' })).toEqual({ model: 'm', effort: 'high' });
    expect(withoutAgent({ model: null, effort: null, agent: 'auto' })).toBeNull();
    expect(withoutAgent({ model: null, effort: null, profile: 'pr-fast' })).toEqual({
      model: null,
      effort: null,
      profile: 'pr-fast',
    });
    expect(withoutAgent({ model: 'm', effort: null })).toEqual({ model: 'm', effort: null });
    expect(withoutAgent(null)).toBeNull();
  });
});

describe('a send records the kind it ran as only where the kind is the choice', () => {
  test('an Auto thread keeps its stored kind, whatever Auto picks for a message', () => {
    // Saved before agents, its Automatic kind is what says it is on Auto, and what finds a
    // project's own conversation.
    const legacy = { mode: 'auto', requested: { model: 'm', effort: 'low' } } as Conversation;
    recordRunKind(legacy, 'build');
    expect(legacy).toEqual({ mode: 'auto', requested: { model: 'm', effort: 'low' } });
    expect(agentChoiceOf(legacy)).toBe('auto');
    // A new thread is on Auto in its box and stays Ask in its stored kind.
    const fresh = { mode: 'ask', requested: chose('auto') } as Conversation;
    recordRunKind(fresh, 'plan');
    expect(fresh).toEqual({ mode: 'ask', requested: chose('auto') });
  });
  test('a chosen agent or a profile keeps its own kind', () => {
    const writer = { mode: 'build', requested: chose('diomedes.writer') } as Conversation;
    recordRunKind(writer, 'build');
    expect(writer).toEqual({ mode: 'build', requested: chose('diomedes.writer') });
    // The phone relays a Builder thread as Automatic; the thread is still Builder's.
    const builder = { mode: 'build', requested: chose('diomedes.builder') } as Conversation;
    recordRunKind(builder, 'auto');
    expect(builder.mode).toBe('build');
    const profiled = { mode: 'ask', requested: { model: null, effort: null, profile: 'pr-fast' } } as Conversation;
    recordRunKind(profiled, 'plan');
    expect(profiled.mode).toBe('ask');
  });
  test('a thread on its kind default moves with its kind, as a mode did', () => {
    const legacy = { mode: 'ask', requested: null } as Conversation;
    recordRunKind(legacy, 'plan');
    expect(legacy).toEqual({ mode: 'plan', requested: null });
    expect(agentChoiceOf(legacy)).toBe('diomedes.architect');
  });
});

describe('where Auto can answer a message itself', () => {
  test('model-API and kept-session routes answer in the conversation; Claude Code project threads go direct', () => {
    expect(throughConversation('aws-bedrock')).toBe(true);
    expect(throughConversation('codex')).toBe(true);
    expect(throughConversation('claude-code')).toBe(false);
    expect(throughConversation('sample')).toBe(false);
  });
});
