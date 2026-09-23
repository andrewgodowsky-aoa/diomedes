/**
 * Print the preflight's false-pass and false-escalation behaviour on the
 * synthetic examples, at the default thresholds and a small sweep around them.
 *
 *   npx tsx scripts/jev-advisor-measure.ts
 *
 * Offline: the transport is a fixture, no key is read and nothing is charged.
 * The examples and the "model answers" are authored, so the figures describe
 * the policy on answers of that shape, not Jev's accuracy.
 */
import {
  measurePreflight,
  SYNTHETIC_PREFLIGHT_CASES,
  type ConfusionCounts,
} from '../server/harness/jev-advisor-measure.js';
import { DEFAULT_PREFLIGHT_THRESHOLDS } from '../server/harness/jev-advisor.js';

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const counts = (c: ConfusionCounts) =>
  `TP ${c.truePositive}  FP ${c.falsePositive}  TN ${c.trueNegative}  FN ${c.falseNegative}  abstain ${c.abstained}`;

const sweep = [
  DEFAULT_PREFLIGHT_THRESHOLDS,
  { booleanTrue: 0.7, booleanFalse: 0.3, choice: 0.5 },
  { booleanTrue: 0.9, booleanFalse: 0.1, choice: 0.7 },
];

console.log(`Synthetic preflight measurement: ${SYNTHETIC_PREFLIGHT_CASES.length} authored cases, fixture transport.`);
for (const thresholds of sweep) {
  const m = await measurePreflight(SYNTHETIC_PREFLIGHT_CASES, thresholds);
  console.log(
    `\nThresholds true>=${thresholds.booleanTrue} false<=${thresholds.booleanFalse} choice>=${thresholds.choice}  (unavailable ${m.unavailable}/${m.cases})`,
  );
  console.log(
    `  Demanding  false pass ${pct(m.escalation.falsePassRate.baseline)} -> ${pct(m.escalation.falsePassRate.advised)}   false escalation ${pct(m.escalation.falseEscalationRate.baseline)} -> ${pct(m.escalation.falseEscalationRate.advised)}  (rule only -> rule + advice)`,
  );
  console.log(`  Missing evidence    ${counts(m.missingEvidence)}`);
  console.log(`  Clarify first       ${counts(m.needsClarification)}`);
  console.log(`  Additional review   ${counts(m.needsReview)}`);
}
