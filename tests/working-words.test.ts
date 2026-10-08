import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AGENT_NAME,
  EASTER_EGGS,
  TOOL_SAYINGS,
  WORKING_WORDS,
  nextWorkingWord,
  toolKind,
  toolSaying,
  toolWorkingWord,
  useWorkingWord,
  workingLine,
} from '../client/console/working-words';

describe('working words', () => {
  test('the waiting line names the agent, never a model or route', () => {
    expect(AGENT_NAME).toBe('Nectovia');
    expect(workingLine('replying')).toBe('Nectovia is replying…');
  });
  test('there are plenty of ordinary sayings and a few rare ones, each short enough for one line', () => {
    // Andrew keeps them playful and asked for more variety (docs/reference/VOICE.md, section 4).
    expect(WORKING_WORDS.length).toBeGreaterThanOrEqual(25);
    expect(WORKING_WORDS.length).toBeLessThanOrEqual(40);
    expect(EASTER_EGGS.length).toBeGreaterThan(0);
    expect(EASTER_EGGS.length).toBeLessThan(WORKING_WORDS.length);
    expect(new Set([...WORKING_WORDS, ...EASTER_EGGS]).size).toBe(WORKING_WORDS.length + EASTER_EGGS.length);
    for (const saying of [...WORKING_WORDS, ...EASTER_EGGS, ...Object.values(TOOL_SAYINGS).flat()]) {
      expect(saying.length, saying).toBeLessThanOrEqual(48);
      expect(saying, saying).toMatch(/^[a-z]/);
      expect(saying, saying).not.toMatch(/[.!?\u2013\u2014]$|\u2014|\u2013/);
    }
  });
  test('an easter egg comes only from a low roll, and a saying never repeats back to back', () => {
    expect(EASTER_EGGS).toContain(nextWorkingWord('noodling on it', 0.01, 0.5));
    expect(WORKING_WORDS).toContain(nextWorkingWord('noodling on it', 0.9, 0.5));
    for (const pick of [0, 0.3, 0.6, 0.999])
      expect(nextWorkingWord(WORKING_WORDS[0], 0.9, pick)).not.toBe(WORKING_WORDS[0]);
  });
  test('the first render says what is actually happening', () => {
    function Probe() {
      return createElement('span', null, workingLine(useWorkingWord('writing the proposal')));
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>Nectovia is writing the proposal…</span>');
  });
  test('a running tool is said in the same voice, by what kind of tool it is', () => {
    const cases: [string, keyof typeof TOOL_SAYINGS | null][] = [
      ['Read', 'read'],
      ['read', 'read'],
      ['Grep', 'read'],
      ['glob', 'read'],
      ['read_file', 'read'],
      ['pos_list_orders', 'read'],
      ['WebSearch', 'search'],
      ['websearch', 'search'],
      ['web_search', 'search'],
      ['WebFetch', 'fetch'],
      ['webfetch', 'fetch'],
      ['Write', 'write'],
      ['Edit', 'write'],
      ['apply_patch', 'write'],
      ['NotebookEdit', 'write'],
      ['Bash', 'run'],
      ['shell', 'run'],
      ['exec_command', 'run'],
      ['Task', 'delegate'],
      ['TodoWrite', 'plan'],
      ['mcp__pos__refund', 'connect'],
      ['pos_refund', null],
    ];
    for (const [tool, kind] of cases) expect(toolKind(tool), tool).toBe(kind);
    expect(TOOL_SAYINGS.write).toContain(toolSaying('Write', 'call-1'));
    expect(toolSaying('pos_refund', 'call-1')).toBeNull();
    // One call keeps its saying while it runs.
    expect(toolSaying('Write', 'call-7')).toBe(toolSaying('Write', 'call-7'));
  });
  test('the working line follows the newest tool call still running', () => {
    const line = (callId: string, tool: string, phase: 'started' | 'finished' | 'failed') => ({ callId, tool, phase });
    expect(toolWorkingWord(null)).toBeNull();
    expect(toolWorkingWord([line('a', 'Read', 'finished')])).toBeNull();
    expect(TOOL_SAYINGS.search).toContain(toolWorkingWord([line('a', 'Read', 'started'), line('b', 'websearch', 'started')]));
    expect(TOOL_SAYINGS.read).toContain(toolWorkingWord([line('a', 'Read', 'started'), line('b', 'websearch', 'finished')]));
    // A tool this does not know leaves the line to the ordinary sayings.
    expect(toolWorkingWord([line('a', 'pos_refund', 'started')])).toBeNull();
  });
});
