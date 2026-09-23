import { describe, expect, it } from 'vitest';
import { routeName, routeOptions } from '../client/console/Diomedes';

// The Home route display: the caption names the route the conversation is on, and the two-entry
// Route control offers Claude Code always and AWS Bedrock only while the availability rule holds
// -- or while it is the route the thread is on, offered or not, because the control must keep
// naming the truth.

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

describe("the Route control's entries", () => {
  it('offers Claude Code always, and AWS Bedrock only while it is offered', () => {
    expect(routeOptions('claude-code', true)).toEqual(['claude-code', 'aws-bedrock']);
    expect(routeOptions('claude-code', false)).toEqual(['claude-code']);
  });

  it('keeps an AWS current route listed when AWS is not offered', () => {
    // The thread is on AWS and the control must keep saying so, offered or not.
    expect(routeOptions('aws-bedrock', false)).toEqual(['claude-code', 'aws-bedrock']);
  });

  it('keeps a route outside the two listed, named as itself', () => {
    expect(routeOptions('sample', false)).toEqual(['claude-code', 'sample']);
    expect(routeOptions('sample', true)).toEqual(['claude-code', 'aws-bedrock', 'sample']);
  });
});
