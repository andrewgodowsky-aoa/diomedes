/**
 * Choosing what the main model sees.
 *
 * The goal is to give the model the information it needs, not as much as will
 * fit. That is the whole benefit of the feature, and it is also where its worst
 * failure lives: a wrong answer built on a plausible-looking selection reads
 * exactly like a right one, and the document that would have corrected it is
 * not in the transcript to be noticed.
 *
 * So the ranking is advisory over one narrow class of material and nothing
 * else. `validatePrepared` in the native loop already prevents a prepared
 * context from gaining tool authority, but it says nothing about messages — a
 * ranking there could drop any instruction it liked. This function is where
 * that protection actually lives.
 *
 * Three rules:
 *
 * 1. **A ranking never removes an obligation.** Protected material and anything
 *    the person explicitly named are kept whatever they score. A low score on a
 *    safety instruction is a fact about the ranking, not about the instruction.
 * 2. **A shortlist cannot support "there are none".** When the request asked
 *    for every location or every invoice, coverage is `partial` the moment
 *    anything is left out — and it is `unknown`, never `complete`, when no
 *    sweep was required. Not being asked for everything is not evidence of
 *    having seen everything.
 * 3. **A conflict is information.** Sources that contradict each other travel
 *    together. Keeping the higher-scoring one manufactures an agreement that
 *    does not exist, which is worse than either source alone.
 *
 * When the mandatory material does not fit the budget, nothing is discarded to
 * make room: the result escalates and says why. A task that quietly dropped its
 * own constraints is a different task from the one that was authorized.
 */

export type SourceAuthority =
  /** An obligation: policy, a standing instruction, an acceptance criterion. */
  | 'protected'
  /** The person named this one. Their request is not a ranking input. */
  | 'requested'
  /** Discovered material, which is what the ranking is actually for. */
  | 'optional';

export type OmitReason =
  /** The ranking did not choose it. */
  | 'not-selected'
  /** The ranking chose it, but the budget ran out first. */
  | 'over-budget';

export interface SelectableSource {
  readonly id: string;
  /** Pinned so a later change invalidates work that depended on this one. */
  readonly revision: number;
  readonly authority: SourceAuthority;
  readonly bytes: number;
  /** Ids this source contradicts. A conflict travels as a pair, never alone. */
  readonly conflictsWith: readonly string[];
}

export interface SelectionInput {
  readonly candidates: readonly SelectableSource[];
  /** Ids the evaluation recommended, best first. Unknown ids are ignored. */
  readonly ranked: readonly string[];
  readonly budgetBytes: number;
  /** The request asked for a complete sweep: every location, every invoice. */
  readonly coverageRequired: boolean;
}

export type SelectionEscalation = 'protected-context-exceeds-budget';

export interface Selection {
  readonly selected: readonly string[];
  readonly omitted: readonly { readonly id: string; readonly reason: OmitReason }[];
  /**
   * `complete` only when a required sweep left nothing out; `partial` when it
   * did; `unknown` when none was required. There is no fourth value, and
   * `unknown` never rounds up to `complete`.
   */
  readonly coverage: 'complete' | 'partial' | 'unknown';
  /** What was kept because it had to be, whatever it scored. */
  readonly protectedRetained: readonly string[];
  /** The revision of every selected source, so a later change is detectable. */
  readonly revisions: Readonly<Record<string, number>>;
  /** Non-null when the caller must change strategy rather than proceed. */
  readonly escalate: SelectionEscalation | null;
}

/**
 * Apply a validated ranking to an authorized candidate set.
 *
 * Every candidate ends up either selected or explained; nothing leaves without
 * a reason, because a silently dropped source is indistinguishable afterwards
 * from one that never existed.
 */
export function selectContext(input: SelectionInput): Selection {
  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));

  // Obligations first, in their own order, before the ranking is consulted at
  // all. They are not competing for the budget; they define it.
  const mandatory = input.candidates.filter(
    (candidate) => candidate.authority === 'protected' || candidate.authority === 'requested',
  );
  const mandatoryBytes = mandatory.reduce((sum, candidate) => sum + candidate.bytes, 0);

  const selected: string[] = mandatory.map((candidate) => candidate.id);
  const chosen = new Set(selected);
  let spent = mandatoryBytes;

  // The ranking, in its own order, over what is left. An id that is not a
  // candidate is ignored rather than refused: the contract already rejected
  // unknown options, and a selection is not the place to re-litigate it.
  const overBudget = new Set<string>();
  const wanted: string[] = [];
  for (const id of input.ranked) {
    const candidate = byId.get(id);
    if (!candidate || chosen.has(id)) continue;
    wanted.push(id);
  }

  // A conflict travels with its partner, so pull those in alongside.
  for (const id of [...wanted]) {
    for (const other of byId.get(id)?.conflictsWith ?? [])
      if (byId.has(other) && !wanted.includes(other) && !chosen.has(other)) wanted.push(other);
  }

  for (const id of wanted) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    // A conflicting pair is admitted together or not at all: admitting half of
    // a disagreement is what manufactures agreement.
    const partners = candidate.conflictsWith
      .filter((other) => byId.has(other) && !chosen.has(other) && other !== id)
      .map((other) => byId.get(other)!);
    const cost = candidate.bytes + partners.reduce((sum, partner) => sum + partner.bytes, 0);
    if (spent + cost > input.budgetBytes) {
      overBudget.add(id);
      for (const partner of partners) overBudget.add(partner.id);
      continue;
    }
    spent += cost;
    selected.push(candidate.id);
    chosen.add(candidate.id);
    for (const partner of partners) {
      selected.push(partner.id);
      chosen.add(partner.id);
    }
  }

  const omitted = input.candidates
    .filter((candidate) => !chosen.has(candidate.id))
    .map((candidate) => ({
      id: candidate.id,
      reason: (overBudget.has(candidate.id) ? 'over-budget' : 'not-selected') as OmitReason,
    }));

  const coverage: Selection['coverage'] = !input.coverageRequired
    ? 'unknown'
    : omitted.length === 0
      ? 'complete'
      : 'partial';

  return {
    selected: Object.freeze(selected),
    omitted: Object.freeze(omitted),
    coverage,
    protectedRetained: Object.freeze(
      input.candidates
        .filter((candidate) => candidate.authority === 'protected')
        .map((candidate) => candidate.id),
    ),
    revisions: Object.freeze(
      Object.fromEntries(selected.map((id) => [id, byId.get(id)?.revision ?? 0])),
    ),
    // The obligations were kept regardless. Saying so is the caller's cue to
    // change strategy — split the task, raise the budget, ask — rather than to
    // proceed with a context that silently no longer carries its constraints.
    escalate: mandatoryBytes > input.budgetBytes ? 'protected-context-exceeds-budget' : null,
  };
}
