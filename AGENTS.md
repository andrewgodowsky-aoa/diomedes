# Diomedes project instructions

Before substantial work, read the canonical live roadmap or the latest documented
local snapshot and report its version. Canonical document:
https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit
Repository mirror: docs/DIOMEDES_LIVE_ROADMAP.md.
Planning cache: F:\Achilles\planning\DIOMEDES-LIVE-ROADMAP.md.
The cloud and repository mirror must have the same explicit version and materially
equivalent decisions. The planning cache is not a third authority. Reconcile
concurrent edits after their writer is idle; do not force-overwrite live work.

Reconcile planned direction with current code and evidence. Read
docs/harness/RUNTIME_VERIFICATION.md and docs/harness/CHANGES.md before the historical
CURRENT_STATE.md inspection. Preserve active worker boundaries in
F:\Achilles\planning\DIOMEDES-RUNTIME-OWNERSHIP-2026-09-09.md and current
coordination notes. Coordinate Trust interfaces before widening them.

After a meaningful slice, include ROADMAP IMPACT with exact status changes and
evidence, and separate BUILD / PUBLICATION / DEPLOYMENT STATUS. Refresh the cloud
document before an authorized write and use requiredRevisionId. Otherwise leave
an exact proposed patch and state that cloud synchronization is pending.

Build in an isolated checkout: npm run build also packages and overwrites that
checkout's release directory. Test only with owned profiles, data and processes.
Never replace the running installation, copy account credentials, or silently
change provider/billing routes. Commits, pushes and releases require Andrew's
explicit approval for the current patch.
