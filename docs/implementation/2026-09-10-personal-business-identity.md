# PB-01 — Personal and Business workspaces, membership, and the Business intake

September 10, 2026. Candidate `integration/autonomy-workbench-20260910` in
`diomedes-wt/integration-autonomy`, on top of the Trust/Agent checkpoint
(`docs/implementation/2026-09-10-reviewer-and-agents.md`). This record states
what was built, what is proven, and what is not.

Contract source: `docs/product/personal-business/01_PRODUCT_AND_EDITIONS.md`
and `02_IDENTITY_ONBOARDING.md`; delivery slice PB-01 in `07_DELIVERY_SEQUENCE.md`.

## 1. The governing invariant

**Nothing but a membership grants membership.**

Not a first-run onboarding preference, not an email domain, not a paid
invoice, not an answer someone typed into the company intake proposing who
should approve things. Every consequence below is that one sentence applied to
a different surface.

The second invariant follows from the first: **a questionnaire answer is
never a grant.** Answers describe goals, sources, reviewers and caps. They do
not connect anything, spend anything, send anything or invite anyone.

## 2. The records, and why they are separate

| Record | Owned by | Holds | Where |
| --- | --- | --- | --- |
| `Person` | the individual | identity and its assurance | `<data>/workspaces/identity.json` |
| Personal workspace | the individual | projects, settings, history | the existing store; it is the default `WorkspaceRef` |
| `Organization` | the organization | name, industry, `tenantId`, `identitySource` | `<data>/workspaces/registry.json` |
| `Membership` | the organization | one person's role and state in it | same registry |
| `Invitation` | the organization | a single-use code and the role it confers | same registry |
| `BusinessSetup` | the organization | the intake answers, by schema revision | `<data>/workspaces/setup/<org>.json` |
| `EntitlementView` | nobody — it is computed | always `none`, with a reason | `shared/workspaces.ts` |

Entitlement is deliberately **not** a stored field. A record that can hold a
plan is a record that can drift into claiming one that was never bought.
`entitlementFor()` returns `{ plan: 'none', managedInference: false, reason }`
and there is no code path that returns anything else.

A person keeps Personal and may belong to several organizations. A
one-person business is a valid Business customer. Creating an organization
here is not a claim that a legal entity was verified.

## 3. Where the active workspace lives, and why that is safe

`Settings.activeWorkspace` is a `WorkspaceRef` — `{ kind: 'personal' }` or
`{ kind: 'business', organizationId }`. It belongs in `Settings` because it is
genuinely a personal preference.

The risk that creates is direct: `PUT /api/settings` takes a whole settings
object, and the Console echoes back what it was given. If that route could
write this field, any client could move itself into a business it does not
belong to.

It cannot. `validateSettings` clones the stored settings and copies across
only the keys it has an explicit branch for; there is no branch for
`activeWorkspace`, and a comment at the top of the function says not to add
one. The key is present in `defaults()` so that a client echoing the full
object is not rejected — it is accepted and ignored. `POST /api/workspace/switch`
is the only writer, and it checks membership first.

Proven by `tests/workspaces.test.ts`, "a settings write cannot move someone
into a business workspace".

## 4. The one gate

`WorkspaceService.configuring()` in `server/workspaces.ts` runs before every
setup route and answers four questions:

1. Is this an **active Business workspace**, and is it *this* organization?
2. Is there an **active membership** for the current person?
3. May they **configure** the organization — owner or admin, never a member?
4. Is the stored setup one **this schema revision** understands?

It is a host gate, not a screen. Personal has no route into the intake at all:
there is no personal equivalent of the setup endpoints, and asking for an
organization's setup from Personal returns `409 workspace_not_active`.

Ordinary invitees join the configuration that exists. `setup.mayConfigure` is
false for them, `setup.resumable` is false, and `GET .../setup` returns
`403 not_configurator`. The owner's answers are untouched.

## 5. Revocation reuses Trust rather than inventing a second system

Each organization owns a `tenantId` (`org:<id>`). Revoking a membership calls
`revokeTenant(tenantId)` from `server/trust/`, which bumps that tenant's
identity generation — so every `PrincipalRef` minted under it fails its next
re-resolution and parks for reconciliation rather than writing. There is no new
revocation machinery, and no sweep to forget.

Two further rules:

- A stored Business reference is honoured **only while the membership behind
  it is active**, checked on every read. A stale settings file, or an
  organization that is gone, reads as Personal. Revocation does not have to
  find and rewrite anyone's settings to take effect.
- The **last active owner cannot be removed**, so an organization can never be
  left with nobody able to administer it.

## 6. The intake

Twelve questions at most, resumable by organization and schema revision, with
a one-line reason on every one. `shared/business-setup.ts` is a pure state
machine, and both the host and the renderer call the same functions — so
"which question is next" and "is this finished" cannot disagree between them.
The Console draws the `step` the host returned; it does not compute its own.

| Rule | Where |
| --- | --- |
| Deeper questions appear only when the chosen job needs them | `Question.revealWhen`; a notes-only job is never asked where information lives, and a one-person business is never asked about multiple locations |
| A question that stops applying is skipped, not left blocking | `nextStep` walks `visibleQuestions` |
| Optional questions accept "I don't know"; required ones do not | `validateAnswer`, code `required` |
| Credentials and card numbers are refused, not stored | `containsSecretLikeText` — key prefixes, JWTs, PEM headers, `password:`-style pairs, and Luhn-valid 13–19 digit runs |
| A concurrent administrator conflicts rather than overwrites | `expectedDigest` against `answersDigest(answers)`, code `setup_conflict` |
| Explicit facts, model suggestions and unresolved answers stay distinguishable | `BusinessAnswer.origin` and `.unknown`; only `person` is produced in this build |
| Finishing a draft makes a **proposal**, not a change | state `proposal-ready` plus `proposalDigest`; changing an answer afterwards requires an explicit resume |

The secret check is deliberately blunt. A false refusal costs someone a
rephrase; a missed one puts a live key in a JSON file. Ordinary business text
is exercised against it in `tests/business-setup.test.ts`.

## 7. The identity boundary, stated rather than implied

`server/trust/` has a pluggable `TrustBackend`, and **it is not installed**.
That is the whole production-identity boundary, and this slice reads it rather
than restating it:

```
hostedAvailable() { return trustBackendInstalled(); }   // false in this build
```

Consequences, all visible in the interface:

- Hosted Business is unavailable, with the reason given in plain words.
- Every organization created here carries `identitySource: 'development-fixture'`
  and is labelled "Development identity — not verified" in the rail and panel.
- The `Person` record is a local fixture generated once per install. It
  authenticates nobody and does not claim to.
- Entitlement is `none`. Managed inference, included usage and billing are not
  available, and no local record can grant them.

`tests/workspaces.test.ts` simulates a second person by restarting the host
with a different `workspaces/identity.json`. That exercises the membership
rules against the real routes without pretending anyone was authenticated —
the fixture stays a fixture.

## 8. Contracts changed

| Change | Kind | Note |
| --- | --- | --- |
| `Settings.activeWorkspace?: WorkspaceRef` | additive | Absent means Personal, which is what every pre-existing settings file means. `migrateSettings` normalises a malformed value to Personal. |
| `defaults()` includes `activeWorkspace` | additive | So a client echoing full settings is accepted; the value is still ignored on write. |
| `jsonWrite` / `readJson` exported from `server/store.ts` | visibility | The workspace service reuses the one durable write (temp file, fsync, atomic rename) instead of adding a second persistence path. |
| `Rail` gains an optional `top` slot | additive | Where the workspace mark renders; every existing caller is unchanged. |
| `GET /api/workspace` is unlocked | behaviour | Reading the view writes nothing; it takes the store lock itself only on the rare pass with a stale reference to settle. A read that queues behind every mutation is how a fast surface becomes a slow one. |
| New routes under `/api/workspace/**` | additive | Listed in `server/workspace-routes.ts`. |

## 9. What is checked

Run in this worktree, ports free, no other agent verifying:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 1028 tests, 56 files, all passing |
| `npx vite build` | clean |
| `npx playwright test` | 45 tests, all passing |

45 of those unit tests are new (`tests/business-setup.test.ts`, 21;
`tests/workspaces.test.ts`, 24) and 5 of the browser tests are new
(`tests/workspace-ui.spec.ts`), with screenshots in `evidence/workspaces/`.

One caveat recorded honestly: on the first full browser run, the pre-existing
`ui.spec.ts` "F07-F08" test failed inside its own `openProject` helper — neither
the project nav nor the project card rendered. It passed in the targeted gate
run before it and in the full re-run after it, and it exercises the Workbook
surface this slice does not touch. It reads as a page-load flake, but it is
recorded rather than dismissed.

## 10. What is **not** implemented, and not claimed

- **No billing, entitlement service, payer resolution or usage accounting.**
  The `$300/$100` package is not represented in code at all.
- **No configuration activation.** The intake stops at a proposal. Compiling,
  validating, staging, rehearsing and activating return
  `409 setup_state_unsupported` with the reason, rather than a spinner that
  finishes.
- **No connector creation**, live or otherwise. Naming a source in the intake
  describes it; it does not connect or grant access to it.
- **No Team orchestration, Agent instantiation or rule packs** from the intake.
- **No production identity, hosted organization or multi-device membership.**
  A second person exists here only as a local fixture.
- **No cross-install invitations.** An invitation code is redeemed against the
  same local registry that minted it.
- App scoping cannot protect local files from an operating-system
  administrator, and revoking access here cannot recall anything already
  exported.

## 11. Prerequisites PB-02 inherits

1. `BusinessSetup.answers` — typed facts with origin, timestamp, tenant and
   schema revision — is the input to configuration compilation.
2. `BusinessSetup.proposalDigest` is the expected-base digest an activation
   must compare against, so a configuration cannot activate over answers that
   moved underneath it.
3. `SetupState` already names the full lifecycle; `IMPLEMENTED_SETUP_STATES`
   names the reachable subset. PB-02 extends the second, not the first.
4. `Organization.tenantId` is the scope key for anything organization-owned —
   Agents, rules, knowledge — and is already what revocation acts on.
5. `WorkspaceService.configuring()` is the authority predicate to reuse for
   configuration review and activation. Do not write a second one.
6. Entitlement is still computed and still `none`. PB-03 owns making it real;
   PB-02 must not assume a plan exists.
