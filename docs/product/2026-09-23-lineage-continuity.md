# Lineage continuity: open conversations survive an instruction change

**Decision record.** Version 2026-09-23.0 (opened). Andrew's decisions of 2026-09-23 07:21 EDT:
- a lineage keeps the instruction text it started with, behind a code-owned digest list;
- a revoked digest forces a reset;
- every reset shows a visible note in the thread.

Release 0.1.8 is held until this is on main.

**Status: in progress in `feature/lineage-continuity` (worktree
`F:/Diomedes/diomedes-wt/lineage-continuity`, base `6ee757c`). Not merged and not released.**

## The defect

A conversation lineage records the instruction text it started with. When a release changes the
composed text, the next message in an open thread fails the scope check (`SESSION_MISMATCH`). The host
then retires the lineage (`scope-change`) and starts a new generation. That generation carries none of
the earlier turns:
- on the model-API routes, `history()` reads only its own run's steps;
- Claude Code starts a fresh native session.

Nothing in the client reads the retirement, so the person is never told. PR #38 (8597bb1) appended the
visual instructions to Ask and Plan after v0.1.7. Updating from 0.1.7 would therefore silently drop the
context of every open Ask and Plan thread.

## Findings, design and tests

To be completed by the lane.
