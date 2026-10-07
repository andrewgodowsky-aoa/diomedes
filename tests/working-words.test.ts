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
  test('both pools describe ongoing work without inventing a stage or using a joke', () => {
    expect(WORKING_WORDS).toEqual(['working', 'continuing']);
    expect(EASTER_EGGS).toEqual(['still working', 'continuing the work']);
    expect(new Set([...WORKING_WORDS, ...EASTER_EGGS]).size).toBe(WORKING_WORDS.length + EASTER_EGGS.length);
  });
  test('the less frequent pool comes only from a low roll, and wording never repeats back to back', () => {
    expect(EASTER_EGGS).toContain(nextWorkingWord('working', 0.01, 0.5));
    expect(WORKING_WORDS).toContain(nextWorkingWord('working', 0.9, 0.5));
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
