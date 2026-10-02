# Devin ACP review record

Requested and runtime-confirmed model: `swe-2-max` (SWE 2.0 Max).
Session: `guttural-turnover`.
Started: `2026-10-02T12:00:43.547Z`.
Completed: `2026-10-02T12:14:50.912Z`.
Transport: ACP stdio, read-only embedded source review; no reviewer tools or writes.
Prompt SHA-256: `50d96e8e3013183dd7d5988d93d2e0a4f5b911d3a46778a6ed1c9f63ac271f38`.

The reviewer saw interim gate results; the final results and resolution of its
verification questions are in `verification.json` and
`review-reconciliation.md`. The twelve source files did not change.

## Reviewer response (verbatim)

# Independent review — PR #196 reconstruction

**Verdict: APPROVE — no blocking defects found** in the frozen bundle bound to `contentDigest c8a6f945d5a0bbfb558019fe5ec84e8d0f8e2d6a2fbe777f83a1aad32f727f71` (base `f72c6ace`, original head `1b4705be`).

I verified by reading: (a) the 016 function body differs from the committed 012 validator **only** in the eligibility predicate — `?& ARRAY['nectovia-agent','maintained-profiles','owner-rules','phone-relay']` replacing the permissive `? 'nectovia-agent' AND (? 'managed-inference' OR ?& …)` — so `validatorMatches012ExceptEligibility` holds; owner, SECURITY DEFINER/search_path, `FOR SHARE OF g,b`, the 100 000 000 check, term-boundary/period-id/allocated-window checks, advisory lock, overlap guard, calendar branch and `REVOKE` are byte-identical. (b) The SQL predicate is equivalent to `individualIncludesMonthlyCredits` (`shared/individual-plan.ts` ~L56–59) for the array shape every writer produces; the only source class the repair removes is exactly the bug class (`nectovia-agent` + `managed-inference` without the full legacy set). (c) 016 is sequenced after actual 013–015 in all three enumerations (`scripts/migrate.ts`, `tests/migrations.test.ts` `names`, `tests/postgres.integration.test.ts`) and in both PG suites' derived manifests; the runner list regex `/'([0-9]{3}[^']*\.sql)'/g` is asserted equal to the on-disk directory. (d) Histories, purchases, payer/period identity, replay idempotency and late settlement are preserved by construction (additive `CREATE OR REPLACE`, byte-identical snapshot assertions around application and re-application, `functionIdentity` owner/ACL/secdef/config equality, restricted-role `42501` on `repairSql`).

Reported gate results I relied on but did not produce: restricted PG 24/24, historical 12/12, general 12/13, runner replay `applied: []`, root typecheck pass. Test counts are internally consistent with the files (24 = 1 always-on contiguity test + 23 restricted; 12 = the funding suite's `it` count; 13 = the general suite's).

---

## A. Defects in the reconstruction

None blocking. One informational note:

- **`?&` vs the TS shape check** — `016_individual_complete_plan_credits.sql` L31: on jsonb, `?&` tests top-level *keys* when the left operand is an object, while `individualIncludesMonthlyCredits` requires an array `.includes`. A `features` value shaped `{…keys…}` would satisfy the SQL but not the TS. Unreachable through any granted surface (only the service's typed `PersonFeatureGrant` serializer and direct owner SQL write `record`); 012 had the same property. Optional hardening: `AND jsonb_typeof(g.record->'features') = 'array'`. Not required.

## B. Test limitations (not defects)

1. **No offline pin on 016's predicate.** `tests/migrations.test.ts` pins 009's sha256 and structurally asserts 012/013/014/015 content, but nothing asserts 016's bytes. A byte-level revert to the permissive predicate would only fail the env-gated PG suites (`CP_LIMITED_INDIVIDUAL_DATABASE_URL`, `CP_INDIVIDUAL_TEST_DATABASE_URL`), which skip without disposable DBs. Cheap fix: in `migrations.test.ts` add `expect(files[15]).toMatchObject({ version: 16, name: '016_individual_complete_plan_credits.sql', sha256: '2ab62ae9…a8f911a' })`, `expect(files[15].sql).toContain("?& ARRAY['nectovia-agent','maintained-profiles','owner-rules','phone-relay']")`, and `not.toContain("? 'managed-inference'")`.
2. **New-reservation-on-preserved-period is faux-only.** The restricted suite (`individual-limited-grants-postgres.integration.test.ts` ~L170–180) proves a dispatched pre-repair hold *settles* on `'2026-09'` after 016, but never `reserve()`s a *new* attempt against the preserved calendar row — that path is covered only in the in-memory suite. The supersession trigger is 012-unchanged, so risk is low; one post-016 `reserve` on the preserved row would close it.
3. **`tests/individual-monthly-credits.test.ts` placement.** It lives at repo root while every other listed suite sits under `services/control-plane/tests/`. Confirm the runner glob actually includes root `tests/`, else the 32-mask offline predicate matrix is dead code.

## C. Pre-existing main issues (not introduced here)

- **`issuePersonGrant` overlap check ignores grant state** (`src/commercial.ts` ~L1150: `prior.filter(grant => grant.billingCycle)` — no `state` filter). A *revoked* grant's term still blocks a differently-anchored re-subscription overlapping its span (`billing_period_overlap`, 409). Possibly intentional conservatism, but it is over-broad for an unfunded revoked term. Unchanged by this PR; flag to the owner.
- **Reported general-PG failure** (duplicate webhook `UNIQUE` on `webhook_inbox`/`billing_customers`, 002/003-era tables) is orthogonal to 016's function-only change — consistent with a baseline/fixture residue issue. Do not count it green until the baseline investigation concludes, and do not attribute it to this repair.

## D. Residual items I could not verify from the bundle

- **402 for `no_period`.** `scoped-routing.test.ts` asserts HTTP 402 with `code: 'no_period'` while `funding.ts` `reserve()` throws `FundingError(409, …, 'no_period')`. The code→status mapping is in `managed-inference.ts`/worker error plumbing outside the embedded files. The same suite's `period_ended`→409 expectation is consistent with a pass-through, so a code-level map must exist for the 402. It matched the accepted repair; the fresh results you reported do not include the memory/faux suites, so confirm those ran green before merge rather than inferring.
- **No third copy of the eligibility rule** is visible in the bundle (SQL trigger + shared TS predicate only); a repo-wide grep for a stray `features` check is outside the frozen scope.

The repair preserves the accepted funding distinction end-to-end: issuance refuses a `billingCycle` and demands an explicit end for limited grants; the DB boundary returns 23514 for every limited shape in both calendar and term paths; complete four- and five-feature grants keep exactly one 1,000-credit allowance, idempotent across replay, replacement and lost commits.
