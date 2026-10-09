import { describe, expect, test } from 'vitest';
import { narrowForAgent } from '../server/agent-tools.js';
import type { ReadScope } from '../server/engines/read-scope.js';
import { AGENT_CATALOG } from '../shared/agents.js';

/** DIO-292: one turn's read scope as an agent may use it. It narrows; it never widens. */
const connector = { name: 'pos', command: 'pos-mcp', args: [], envFrom: [], readTools: ['sales_by_day'] };
const scope = Object.freeze({
  root: 'C:/projects/harbor',
  web: true,
  mcp: [connector],
  access: 'selected',
  files: [],
  shared: [],
  grant: 'g1',
}) as unknown as ReadScope;
const FILES = ['list_files', 'read_file', 'search_files'];
const toolsOf = (id: string) => AGENT_CATALOG.find((item) => item.id === id)!.tools;

describe("one turn's read scope as an agent may use it", () => {
  test("Researcher's tools leave the scope exactly as it is", () => {
    expect(narrowForAgent(scope, toolsOf('diomedes.researcher'))).toBe(scope);
  });
  test('without a web tool there is no web; without the connector tool, no connectors', () => {
    const narrowed = narrowForAgent(scope, toolsOf('diomedes.explorer'))!;
    expect(narrowed.web).toBe(false);
    expect(narrowed.mcp).toEqual([]);
    expect(narrowed.files).toBe(scope.files);
    expect(narrowed.access).toBe('selected');
    expect(narrowed.grant).toBe('g1');
  });
  test('Analyst keeps connectors and loses the web', () => {
    const narrowed = narrowForAgent(scope, toolsOf('diomedes.analyst'))!;
    expect(narrowed.web).toBe(false);
    expect(narrowed.mcp).toEqual([connector]);
  });
  test("it never widens, and an agent that lists no tools reads with its kind's own", () => {
    const closed = { ...scope, web: false } as ReadScope;
    expect(narrowForAgent(closed, [...FILES, 'fetch_page'])!.web).toBe(false);
    expect(narrowForAgent(scope, [])).toBe(scope);
    expect(narrowForAgent(undefined, FILES)).toBeUndefined();
  });
});
