## What changed and why

<!-- Plain sentences. What a person sees or can do now that they couldn't before, and why. -->

Linear: DIO-

## Gates

<!-- Real counts from your own run on this branch's last commit. Never a sum of old totals, and
never a skipped test reported as passing. See AGENTS.md, "Required verification". -->

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | |
| `npx vitest run` | files, tests passed, failed, skipped |
| `npx vite build` | |
| `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | |

<!-- Add a row for each extra check that applies: `-c playwright.responsive.config.ts` for layout or
CSS, the control-plane `typecheck`, `test` and `build` for `services/control-plane`. A failure that
also fails on untouched main: name the test and say so. -->

## Implemented versus only recorded

<!-- What runs now, and what is only written down, approved or planned. -->

## Left undone

<!-- Anything not finished, not tested, or waiting on a decision. Write "Nothing" if so. -->

## Customer-facing words

<!-- Optional. Delete if no customer-visible text changed. Otherwise list the strings and confirm
they follow docs/reference/VOICE.md: no italics, no dashes as punctuation, no reassurance tails,
no typed model, vendor or price. -->

## PILLAR IMPACT / ROADMAP IMPACT

<!-- Optional. Delete if neither applies. Fill in when the change could drift from
docs/DIOMEDES_CORE_PILLARS.md or changes a roadmap status, with the evidence. -->
