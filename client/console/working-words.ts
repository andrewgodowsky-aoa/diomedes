import { useEffect, useState } from 'react';
import { AGENT_NAME } from '../../shared/agent-name';

export { AGENT_NAME };

/**
 * What the agent is "doing" while a person waits. Display only: the run log
 * and History keep their plain record, and none of this reaches either.
 */
export const WORKING_WORDS = [
  'flibbertigibbeting',
  'noodling on it',
  'percolating',
  'cogitating',
  'rummaging through the archives',
  'untangling the yarn',
  'consulting the oracle',
  'sharpening the quill',
  'polishing the bronze',
  'counting the ships',
  'brewing a fresh pot of ideas',
  'wrangling the words',
  'pacing the halls',
  'squinting at the details',
  'herding the thoughts',
  'doodling in the margins',
  'connecting the dots',
  'reading the tea leaves',
] as const;

/** Rare ones. Roughly one saying in eight comes from here. */
export const EASTER_EGGS = [
  "asking Dutch if we're still going to Tahiti",
  'playing one more round of Gwent',
  'following Ciri’s trail, again',
  'waiting for Johnny Silverhand to stop talking',
  'taking an arrow to the knee',
  'looking for one more Korok seed',
  'praising the sun',
  'checking whether the cake is a lie',
] as const;

const ROTATE_MS = 3200;
const EGG_CHANCE = 1 / 8;

/**
 * The next saying, never the one just shown. `roll` and `pick` are the two
 * random draws, passed in so the choice can be tested.
 */
export function nextWorkingWord(previous: string, roll: number, pick: number): string {
  const pool: readonly string[] = roll < EGG_CHANCE ? EASTER_EGGS : WORKING_WORDS;
  const choices = pool.filter((word) => word !== previous);
  return choices[Math.min(choices.length - 1, Math.floor(pick * choices.length))];
}

/** "Nectovia is replying…", the whole line. */
export function workingLine(word: string): string {
  return `${AGENT_NAME} is ${word}…`;
}

function holdsStill() {
  if (typeof navigator !== 'undefined' && (navigator as Navigator & { webdriver?: boolean }).webdriver === true)
    return true;
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * `first` (what is actually happening, such as "replying") while the wait is
 * young, then a new saying every few seconds. It holds still under automation
 * and reduced motion, so a test or a screenshot always reads the plain word.
 */
export function useWorkingWord(first: string, active = true): string {
  const [word, setWord] = useState(first);
  useEffect(() => {
    setWord(first);
    if (!active || holdsStill()) return;
    const timer = setInterval(
      () => setWord((previous) => nextWorkingWord(previous, Math.random(), Math.random())),
      ROTATE_MS,
    );
    return () => clearInterval(timer);
  }, [active, first]);
  return word;
}
