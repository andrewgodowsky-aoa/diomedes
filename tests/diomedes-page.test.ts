import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Diomedes, routeName } from '../client/console/Diomedes';

// The Home route display: without a tier the caption names the route the conversation is on. There
// is no Route control: a customer chooses a tier, and the owner's tier map decides the route and the
// model (owner decision 2026-09-23).

describe('the route caption', () => {
  it('names the conversation default AWS Bedrock (Luna)', () => {
    expect(routeName('aws-bedrock')).toBe('AWS Bedrock (Luna)');
  });

  it('names Claude Code as itself, never as a stand-in for AWS', () => {
    expect(routeName('claude-code')).toBe('Claude Code');
  });

  it('names every other route as itself rather than hiding it', () => {
    expect(routeName('codex')).toBe('ChatGPT');
    expect(routeName('sample')).toBe('Sample');
    expect(routeName('opencode')).toBe('OpenCode');
  });
});

describe('the Home composer offers tiers, never routes or models', () => {
  const noAction = () => {};
  const render = (workStyle: 'efficient' | 'focused' | 'thorough' | null) =>
    renderToStaticMarkup(
      createElement(Diomedes, {
        projects: [], scopeId: null, onScope: noAction, turns: [], pending: false,
        restriction: 'automatic', onRestriction: noAction, onSend: async () => true, onStop: noAction,
        route: 'aws-bedrock', workStyle, onWorkStyle: noAction,
        unavailable: null, card: null, cardBusy: false, onCardAction: noAction, unconfirmed: null,
        onResend: noAction, onDiscard: noAction, notice: null, onReadAgain: null, results: [],
        onOpenResult: noAction, destinations: [], pinned: [], onDestination: noAction,
        onTogglePin: noAction, onNewProject: noAction,
      }),
    );

  it('has no Route control, and its only model control lists the three tiers', () => {
    const html = render('focused');
    expect(html).not.toContain('aria-label="Route"');
    const style = html.match(/<select aria-label="Style"[\s\S]*?<\/select>/)?.[0] ?? '';
    const options = [...style.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(['', 'efficient', 'focused', 'thorough']);
    for (const name of ['AWS', 'Bedrock', 'Azure', 'OpenRouter', 'Claude', 'Vertex', 'gpt-', 'gemini', 'luna'])
      expect(style.toLowerCase()).not.toContain(name.toLowerCase());
  });

  it('names a tiered conversation by its tier, and names the route only without one', () => {
    expect(render('thorough')).toContain('<span class="dio-route">Thorough</span>');
    expect(render(null)).toContain('<span class="dio-route">AWS Bedrock (Luna)</span>');
  });
});
