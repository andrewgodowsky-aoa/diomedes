/**
 * The release gates, held to what this build can actually demonstrate.
 *
 * These tests pin the honest reading of doc 06: the paid managed-inference
 * gate is unmet and names the absent entitlement/gateway service as the
 * reason, so a future change that flips it to met without installing those
 * services fails here rather than passing quietly. The remaining tests hold
 * the structural invariants — four gates, non-empty notes, and no claimed
 * commercial or written-authorization evidence this build does not have.
 *
 * Every fixture is the gate structure itself. Nothing here is financial.
 */
import { describe, expect, test } from 'vitest';
import {
  RELEASE_GATES,
  gateStatus,
  highestMetGate,
  type ReleaseGate,
} from '../shared/release-gates.js';

const byId = (id: ReleaseGate['id']): ReleaseGate => {
  const gate = RELEASE_GATES.find((item) => item.id === id);
  if (!gate) throw new Error(`Release gate ${id} is missing.`);
  return gate;
};

describe('release gates', () => {
  test('the four gates exist in release order', () => {
    expect(RELEASE_GATES.map((gate) => gate.id)).toEqual([
      'development',
      'controlled-pilot',
      'paid-managed-inference',
      'broader-business',
    ]);
    for (const gate of RELEASE_GATES) {
      expect(gate.name.length).toBeGreaterThan(0);
      expect(gate.summary.length).toBeGreaterThan(20);
      expect(gate.requirements.length).toBeGreaterThan(0);
    }
  });

  test('paid managed inference is unmet: no entitlement or gateway service is installed', () => {
    const gate = byId('paid-managed-inference');
    const status = gateStatus(gate);
    expect(status.met).toBe(false);
    expect(status.missing.length).toBeGreaterThan(0);

    // The pin that matters: flipping this gate to met without installing the
    // services must fail here. The reason names exactly what is absent.
    const enforcement = gate.requirements.find(
      (item) => item.id === 'paid-managed-inference.entitlement-enforcement',
    )!;
    expect(enforcement.met).toBe(false);
    expect(enforcement.note).toMatch(/entitlement/i);
    expect(enforcement.note).toMatch(/gateway/i);

    // And the doc 06 warning is encoded, not just filed: a form and a
    // checkbox are not the services this gate asks for.
    expect(gate.summary).toMatch(/desktop checkbox/i);
  });

  test('every requirement says why, in its own words', () => {
    for (const gate of RELEASE_GATES)
      for (const requirement of gate.requirements) {
        expect(requirement.text.length).toBeGreaterThan(10);
        expect(requirement.note.length).toBeGreaterThan(10);
      }
  });

  test('this build claims no commercial or written-authorization evidence', () => {
    // There is no checkout, no approved price and no signed authorization in
    // this build, so any requirement asking for those kinds of evidence must
    // read as unmet. A future met:true there would be a claim of a commercial
    // or legal fact this tree cannot demonstrate.
    for (const gate of RELEASE_GATES)
      for (const requirement of gate.requirements)
        if (requirement.evidenceKind === 'commercial' || requirement.evidenceKind === 'written-authorization')
          expect(requirement.met).toBe(false);
  });

  test('only the development gate is met, so it is the highest met gate', () => {
    expect(gateStatus(byId('development')).met).toBe(true);
    expect(gateStatus(byId('controlled-pilot')).met).toBe(false);
    expect(gateStatus(byId('paid-managed-inference')).met).toBe(false);
    expect(gateStatus(byId('broader-business')).met).toBe(false);
    expect(highestMetGate()).toBe('development');
  });
});
