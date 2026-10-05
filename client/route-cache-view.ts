/**
 * DIO-215: the words of the Prompt caching block in AI setup, from the host's view only. Every
 * capability fact says where it comes from: a cited declaration, a route check that observed it,
 * or nothing. No sentence here states a window, a limit or a price of its own: the numbers are
 * the record's, and the record's are cited.
 */
import {
  BUILD_REFUSALS,
  type CachePolicy,
  type CapabilityFact,
  type FactSource,
  type RouteCapability,
} from '../shared/route-capabilities';

/** The three settings, in the order the owner reads them. */
export const CACHE_POLICY_CHOICES: readonly { value: CachePolicy; label: string; detail: string }[] = [
  {
    value: 'provider-default',
    label: 'Provider default',
    detail: 'No cache instruction is sent. The provider decides what it reuses.',
  },
  {
    value: 'off',
    label: 'Off',
    detail: 'Each call asks the provider to cache nothing. A route check shows whether it does.',
  },
  {
    value: 'explicit-prefix',
    label: 'Explicit prefix',
    detail:
      'The stable start of the instructions is marked for caching for 30 minutes. The key is kept to this business and route.',
  },
];

/** `store: false` and prompt caching are different things, said once beside the choice. */
export const STORE_FALSE_NOTE =
  'Every call is sent with store set to false, so the provider keeps no response object. That is not the same as caching off.';

export const FACT_SOURCE_WORDS: Record<FactSource, string> = {
  declared: 'Declared',
  observed: 'Observed by a route check',
  'not-known': 'Not known',
};

export interface CapabilityRow {
  id: string;
  label: string;
  value: string;
  source: FactSource;
  /** The citation, the route check, or why nothing is known. */
  evidence: string;
  /** What this build sends whatever the model can do, where that differs. */
  build: string | null;
}

const count = (value: number) => value.toLocaleString('en-US');
const tokens = (fact: CapabilityFact<number>) => (fact.value === null ? 'Not known' : `${count(fact.value)} tokens`);
const yesNo = (fact: CapabilityFact<boolean>) => (fact.value === null ? 'Not known' : fact.value ? 'Yes' : 'No');

/** One row per fact in the record, each with its source and evidence. */
export function capabilityRows(record: RouteCapability): CapabilityRow[] {
  const row = <T>(
    id: string,
    label: string,
    fact: CapabilityFact<T>,
    value: string,
    build: string | null = null,
  ): CapabilityRow => ({ id, label, value, source: fact.source, evidence: fact.evidence, build });
  return [
    row('context', 'Context window', record.contextTokens, tokens(record.contextTokens)),
    row('output', 'Output limit', record.outputTokens, tokens(record.outputTokens)),
    row('tools', 'Tool calls', record.tools, yesNo(record.tools)),
    row('parallel', 'Parallel tool calls', record.parallelToolCalls, yesNo(record.parallelToolCalls), BUILD_REFUSALS.parallelToolCalls),
    row('structured', 'Structured output', record.structuredOutput, yesNo(record.structuredOutput), BUILD_REFUSALS.structuredOutput),
    row('images', 'Image input', record.images, yesNo(record.images)),
    row('reasoning', 'Reasoning', record.reasoning, yesNo(record.reasoning)),
    row('explicit', 'Explicit prefix caching', record.cache.explicitPrefix, yesNo(record.cache.explicitPrefix)),
    row('minimum', 'Smallest prefix it caches', record.cache.minimumTokens, tokens(record.cache.minimumTokens)),
  ];
}

/** What the newest qualifying route check says about the `off` request shape on this identity. */
export function offVerdict(record: RouteCapability): string {
  switch (record.cache.off) {
    case 'verified':
      return 'Caching off is confirmed. The newest route check saw no cache reads or writes with it.';
    case 'not-verified':
      return 'Caching off is not confirmed. The newest route check still saw cache reads or writes with it.';
    case 'unsupported':
      return 'The provider refused the caching off request in the newest route check.';
    case 'unknown':
      return 'No current route check has tried caching off on this connection.';
  }
}

/** What the newest qualifying route check saw the provider do with no cache instruction. */
export function defaultVerdict(record: RouteCapability): string {
  switch (record.cache.byDefault) {
    case 'caches':
      return 'With no cache instruction, the newest route check saw a repeated prefix read from a cache.';
    case 'no-cache-observed':
      return 'With no cache instruction, the newest route check saw no cache reads.';
    case 'unknown':
      return 'No current route check shows what the provider caches by default.';
  }
}
