import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AGENT_NAME,
  EASTER_EGGS,
  WORKING_WORDS,
  nextWorkingWord,
  useWorkingWord,
  workingLine,
} from '../client/console/working-words';

describe('working words', () => {
  test('the waiting line names the agent, never a model or route', () => {
    expect(AGENT_NAME).toBe('Nectovia');
    expect(workingLine('replying')).toBe('Nectovia is replying…');
  });
  test('there are enough ordinary sayings and a few rare ones', () => {
    expect(WORKING_WORDS.length).toBeGreaterThanOrEqual(10);
    expect(WORKING_WORDS.length).toBeLessThanOrEqual(20);
    expect(EASTER_EGGS.length).toBeGreaterThan(0);
    expect(new Set([...WORKING_WORDS, ...EASTER_EGGS]).size).toBe(WORKING_WORDS.length + EASTER_EGGS.length);
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
});
