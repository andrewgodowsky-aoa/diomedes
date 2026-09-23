# Home history sharing (0.1.8 fix)

Status: in progress on `feature/home-history-sharing`, from `bd684a6`, the 0.1.8 base.

## Why

The 0.1.8 candidate (`43e0fa5`) passed every gate but its release review found the All projects
conversation on the Nectovia page cannot remember earlier messages. The owner's cloud-sharing rule
of 2026-09-23 keeps Home's documents and history gated while letting its typed messages through, and
the screen that would let a person grant history there was never built: Cloud sharing lives only in a
project's top bar. On provider routes each Home message is answered alone and nothing says so; on
Claude Code a follow-up is refused.

Andrew held 0.1.8 for this fix on 2026-09-23 ("Hold for a small fix"): a way to turn history on for
that conversation (off by default, per the rule), a visible line whenever it is off, and a true
wording for Workspaces' "we pay for them" line. Home is still never upgraded.

## What changes

To be written by the lane.

## Tests

To be written by the lane.
