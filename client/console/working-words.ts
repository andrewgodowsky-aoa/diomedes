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
  'charting the stars',
  'trimming the lamp',
  'tuning the lyre',
  'plotting the course',
  'unfurling the sails',
  'dusting off the old tomes',
  'warming the hearth',
  'lining up the arguments',
  'weaving the threads together',
  'reading the winds',
  'turning it over twice',
  'lighting the lanterns',
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
  'waiting for Odysseus to get home',
  'asking the oracle at Delphi about the Wi-Fi',
  'checking the wooden horse for Greeks',
  'reminding Achilles about his heel',
  'rolling for initiative',
] as const;

/** The kinds of tool call that have sayings of their own. */
export type ToolKind = 'read' | 'search' | 'fetch' | 'write' | 'run' | 'delegate' | 'plan' | 'connect';

/**
 * What a running tool call is doing, in the same voice as the sayings. The plain line for the
 * call ("Reading menu.md") stays in the tool list; this is only the working line above it.
 */
export const TOOL_SAYINGS: Readonly<Record<ToolKind, readonly string[]>> = {
  read: ['leafing through the scrolls', 'rummaging through the archives', 'reading the fine print'],
  search: ['consulting the oracle', 'sending out scouts', 'searching the far shores'],
  fetch: ['sending a messenger', 'fetching a far-off scroll'],
  write: ['putting ink to the quill', 'inking the parchment', 'setting it down in ink'],
  run: ['stoking the forge', 'turning the gears', 'working the bellows'],
  delegate: ['rallying the crew', 'dispatching the heralds'],
  plan: ['drafting the battle plan', 'sketching the map'],
  connect: ['calling on an ally', 'sending word to an ally'],
};

/**
 * A tool's kind, read from the name its engine gives it (`Read`, `websearch`, `apply_patch`,
 * `mcp__pos__list_orders` and so on), or null when the name says nothing this knows.
 */
export function toolKind(tool: string): ToolKind | null {
  const name = tool.toLowerCase();
  if (/todo|plan/.test(name)) return 'plan';
  if (/search/.test(name)) return 'search';
  if (/fetch|browse|url/.test(name)) return 'fetch';
  if (/write|edit|patch|create|insert|replace|notebook/.test(name)) return 'write';
  if (/read|grep|glob|list|find|view|open|^ls$|^cat$/.test(name)) return 'read';
  if (/bash|shell|exec|command|terminal|^run/.test(name)) return 'run';
  if (/task|agent|delegate|spawn/.test(name)) return 'delegate';
  if (/^mcp|__/.test(name)) return 'connect';
  return null;
}

/** The saying for one tool call. The same call keeps its saying; the next call may differ. */
export function toolSaying(tool: string, callId: string): string | null {
  const kind = toolKind(tool);
  if (!kind) return null;
  const sayings = TOOL_SAYINGS[kind];
  let hash = 0;
  for (const char of callId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return sayings[hash % sayings.length];
}

/** The saying for the newest tool call still running, or null when none is, or none fits. */
export function toolWorkingWord(
  lines: readonly { callId: string; tool: string; phase: string }[] | null | undefined,
): string | null {
  const running = lines ? [...lines].reverse().find((line) => line.phase === 'started') : undefined;
  return running ? toolSaying(running.tool, running.callId) : null;
}

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
