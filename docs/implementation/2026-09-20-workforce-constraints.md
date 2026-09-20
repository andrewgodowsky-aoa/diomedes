# Workforce constraints preparation

DEMO-03.PREP; base main 80263205133c410d590549efd1c8f40cedf33b1c.

A pure library validates explicitly expanded availability, absences, qualifications,
workweek minutes, preceding-shift rest, travel and overlap. Deterministic bounded
search distinguishes a feasible draft, exhausted infeasibility and an incomplete
search. A separate entry point validates supplied draft assignments. Availability
never becomes employee acceptance. Invalid or missing critical inputs do not default
to a feasible schedule. Whole-minute instants carry explicit offsets; recurrence
and local daylight-saving expansion remain the caller's responsibility.

This is a preparatory subset, not a scheduler or a released staffing capability.
Input references and owner rules are untrusted data until resolved by an accepted
Core caller. No UI, persistence, authority, notifications, vendor effects or live
model loop is connected. Past work and preceding-shift provenance must be confirmed
by that caller. No employment decision or legal staffing policy is encoded.

Full DEMO-03 stays OPEN pending independent review, Core/Configuration/FD integration,
the real owner-edit journey, full gates, exact merged evidence and meeting qualification.
Validation results are recorded in the parent delivery report.

On 20 September 2026, the repaired candidate passed all four coordinated gates:
TypeScript, 2,253 unit tests (one skipped), the Vite production build and 35 browser
tests. Evidence: personalized-demo-readiness-20260920/gates-workforce-constraints-1.
The focused suite has 14 cases, including the previously failing contiguous
availability regression. These results qualify this pure prerequisite, not the
unconnected scheduling workflow described above.
