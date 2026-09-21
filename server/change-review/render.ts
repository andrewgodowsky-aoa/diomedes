/**
 * The deterministic renderer: facts, flags and checks in — sentences out.
 *
 * Every sentence is a fixed template filled with structured values, stamped
 * with the template id and the fact ids that produced it. The final pass scans
 * each sentence for words the review is not allowed to say and throws on a
 * hit: an overclaim cannot ship inside a template any more than it can in a
 * one-off string.
 */

import {
  bannedWordHits,
  CHANGE_REVIEW_RULES_VERSION,
  countText,
  escapeVisible,
  plural,
  type ChangeEvidenceRef,
  type ChangeReviewManifest,
  type ReviewCheck,
  type ReviewFact,
  type ReviewFlag,
  type ReviewSentence,
} from '../../shared/change-manifest.js';

/**
 * One rendered sentence. `evidence` is mandatory: the evidence invariant is a
 * runtime guarantee, so an attempt to emit a claim nothing backs throws here.
 */
function sentence(
  id: string,
  templateId: string,
  text: string,
  evidence: readonly ChangeEvidenceRef[],
  factIds: readonly string[] = [],
  flagCodes: readonly string[] = [],
): ReviewSentence {
  const hits = bannedWordHits(text);
  if (hits.length)
    throw new Error(`Change-review template ${templateId} produced banned wording: ${hits.join(', ')}`);
  if (evidence.length === 0)
    throw new Error(`Change-review template ${templateId} produced a sentence with no evidence.`);
  return { id, templateId, text, factIds, flagCodes, evidence };
}

function param(fact: ReviewFact, key: string): string | number | boolean | null {
  return fact.params[key] ?? null;
}

const CHECK_STATE_TEXT: Record<ReviewCheck['state'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  'not-run': 'Not run',
  skipped: 'Skipped',
  error: 'Error',
};

function checkSentence(check: ReviewCheck, index: number): ReviewSentence {
  const state = CHECK_STATE_TEXT[check.state];
  let text = `${state} · ${check.label}`;
  if (check.detail) text += ` — ${escapeVisible(check.detail)}`;
  if (check.reason && check.state !== 'passed') text += ` (${escapeVisible(check.reason)})`;
  // The check's own inputs are its evidence; a not-run check cites itself —
  // the stored record that says nothing ran.
  const evidence = check.evidence.length
    ? check.evidence
    : [{ kind: 'check' as const, checkId: check.id }];
  return sentence(`s-check-${index}`, 'check-line', text, evidence);
}

/**
 * Render the three summary sections. The same facts always produce the same
 * sentences in the same order.
 */
export function renderSummary(
  facts: readonly ReviewFact[],
  flags: readonly ReviewFlag[],
  checks: readonly ReviewCheck[],
  manifest: Pick<ChangeReviewManifest, 'outcome' | 'baseline'>,
): { whatChanged: ReviewSentence[]; attention: ReviewSentence[]; checks: ReviewSentence[] } {
  const whatChanged: ReviewSentence[] = [];
  let seq = 0;
  const next = () => `s-${(seq += 1)}`;

  const files = facts.find((fact) => fact.code === 'files-changed');
  const noChanges = facts.find((fact) => fact.code === 'no-changes');
  const lines = facts.find((fact) => fact.code === 'lines-changed');
  const areas = facts.find((fact) => fact.code === 'focus-areas');
  const settled = facts.find((fact) => fact.code === 'changes-settled');

  if (noChanges) {
    const text =
      manifest.outcome === 'declined'
        ? 'The proposed change was declined. Nothing was written.'
        : manifest.outcome === 'stopped'
          ? 'The run was stopped. No recorded changes were made.'
          : manifest.outcome === 'failed'
            ? 'The run failed. No recorded changes were made.'
            : 'No changes were recorded while this task ran.';
    whatChanged.push(sentence(next(), 'no-changes', text, noChanges.evidence, [noChanges.id]));
  }

  if (files) {
    const total = Number(param(files, 'total'));
    const observed = Number(param(files, 'observed'));
    const parts: string[] = [];
    const add = Number(param(files, 'added'));
    const mod = Number(param(files, 'modified'));
    const del = Number(param(files, 'deleted'));
    const ren = Number(param(files, 'renamed'));
    if (add) parts.push(countText(add, 'added file'));
    if (mod) parts.push(countText(mod, 'modified file'));
    if (del) parts.push(countText(del, 'deleted file'));
    if (ren) parts.push(countText(ren, 'renamed file'));
    const head =
      observed > 0
        ? `${countText(total, 'file')} changed while this task ran (${parts.join(' · ')}).`
        : `${countText(total, 'file')} changed (${parts.join(' · ')}).`;
    whatChanged.push(sentence(next(), 'files-changed', head, files.evidence, [files.id]));
    if (lines) {
      whatChanged.push(
        sentence(
          next(),
          'lines-changed',
          `+${String(param(lines, 'added'))} · −${String(param(lines, 'removed'))} lines across ${countText(Number(param(lines, 'counted')), 'file')}.`,
          lines.evidence,
          [lines.id],
        ),
      );
    }
    if (areas) {
      whatChanged.push(
        sentence(
          next(),
          'focus-areas',
          `Most changes are in: ${String(param(areas, 'areas'))}.`,
          areas.evidence,
          [areas.id],
        ),
      );
    }
    if (settled) {
      const kept = Number(param(settled, 'kept'));
      const undone = Number(param(settled, 'undone'));
      const waiting = Number(param(settled, 'waiting'));
      const parts: string[] = [];
      if (kept) parts.push(countText(kept, 'kept change'));
      if (undone) parts.push(countText(undone, 'undone change'));
      if (waiting) parts.push(countText(waiting, 'awaiting change'));
      whatChanged.push(
        sentence(next(), 'changes-settled', `Review state: ${parts.join(' · ')}.`, settled.evidence, [settled.id]),
      );
    }
    if (!manifest.baseline)
      whatChanged.push(
        sentence(
          next(),
          'no-baseline',
          'No run-start baseline was captured, so changes before this feature or from earlier work may be included.',
          [{ kind: 'baseline', listingDigest: null, capturedAt: null }],
        ),
      );
  }

  // Git file-mode facts become plain mode sentences.
  for (const fact of facts.filter((item) => item.code === 'file-mode-changed')) {
    const path = String(param(fact, 'path'));
    const before = String(param(fact, 'before'));
    const after = String(param(fact, 'after'));
    const text =
      after === '100755' && before !== '100755'
        ? `${path} became executable.`
        : before === '100755' && after !== '100755'
          ? `${path} lost its executable bit.`
          : `${path}'s file mode changed (${before} → ${after}).`;
    whatChanged.push(sentence(next(), 'file-mode-changed', text, fact.evidence, [fact.id]));
  }

  // Structured (business) field facts become plain before → after sentences,
  // in the order the record's descriptors produced them — not regrouped.
  for (const fact of facts.filter(
    (item) => item.code === 'field-changed' || item.code === 'collection-changed',
  )) {
    const label = String(param(fact, 'label') ?? 'A field');
    const before = param(fact, 'before');
    const after = param(fact, 'after');
    if (fact.code === 'collection-changed') {
      const pieces: string[] = [];
      if (before !== null || after !== null)
        pieces.push(`${String(before ?? '0')} → ${String(after ?? '0')}`);
      const added = param(fact, 'added');
      const removed = param(fact, 'removed');
      const addedMore = Number(param(fact, 'addedMore') ?? 0);
      const removedMore = Number(param(fact, 'removedMore') ?? 0);
      if (added) pieces.push(`added: ${String(added)}${addedMore > 0 ? ` (+${addedMore} more)` : ''}`);
      if (removed)
        pieces.push(`removed: ${String(removed)}${removedMore > 0 ? ` (+${removedMore} more)` : ''}`);
      whatChanged.push(
        sentence(next(), 'collection-changed', `${label} changed (${pieces.join('; ')}).`, fact.evidence, [fact.id]),
      );
      continue;
    }
    const text =
      fact.params.sensitive === true
        ? `${label} changed. (Recorded, not shown.)`
        : before === null
          ? `${label} was added: ${String(after)}.`
          : after === null
            ? `${label} was removed (was ${String(before)}).`
            : `${label} changed: ${String(before)} → ${String(after)}${fact.params.valueTruncated === true ? ' (value truncated)' : ''}.`;
    whatChanged.push(sentence(next(), 'field-changed', text, fact.evidence, [fact.id]));
  }
  const unchanged = facts.find((fact) => fact.code === 'fields-unchanged');
  if (unchanged) {
    whatChanged.push(
      sentence(
        next(),
        'fields-unchanged',
        `Unchanged: ${String(param(unchanged, 'labels'))}.`,
        unchanged.evidence,
        [unchanged.id],
      ),
    );
  }

  const attention: ReviewSentence[] = flags
    .filter((flag) => flag.severity === 'attention')
    .map((flag, index) =>
      sentence(
        `s-attn-${index}`,
        'attention-flag',
        escapeVisible(flag.text),
        flag.evidence.length
          ? flag.evidence
          : [
              {
                kind: 'rule' as const,
                ruleId: flag.ruleId,
                rulesVersion: CHANGE_REVIEW_RULES_VERSION,
              },
            ],
        [],
        [flag.code],
      ),
    );

  const checkSentences = checks.map((check, index) => checkSentence(check, index));
  return { whatChanged, attention, checks: checkSentences };
}
