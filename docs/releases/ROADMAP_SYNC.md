# Exact proposed roadmap synchronization

The canonical Google Doc was reread during final verification. It remains version
2026-09-09.6 at the same revision captured at the start of this task. No cloud write,
sharing change or document permission change occurred.

The clean local implementation mirror is .7 and explicitly labels its cloud
synchronization as pending. It incorporates .6's Desktop/Core/Runtime/Agent naming,
first-class direct agents, Business on one product, separate Consulting, optional
Cloud, capital limits and behavior/evals-before-weights sequence. Its new status
claims are grounded in the named 0.1.1 build, not implied publication.

`ROADMAP_PATCH.json` is the exact unapplied replacement, as permitted by the brief.
It records the document ID, latest requiredRevisionId, target tab/range, actual
Google Docs request objects, and the companion Markdown mirror after successful
synchronization. This is a review payload, not another canonical roadmap.

Before applying it, the owner should reread the native document and controls,
compare this proposed clean reconciliation with any intervening decisions and
confirm the revision still matches. Execute only with requiredRevisionId; a
concurrent change must fail rather than be merged blindly. Read back the resulting
document, then use proposedMirrorMarkdown to remove the local pending-sync label
and record the returned revision. Until those operations succeed, do not claim
that cloud and mirror are synchronized.

The website handoff owns neither a competing roadmap revision nor a second app
release manifest. Its publication work consumes the integrator's approved contract.
