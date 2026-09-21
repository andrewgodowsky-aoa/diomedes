# Observe durable test start

The hosted inventory-contract check on commit e71b4b9 failed in the existing
H01 restart test: recovery read `queued` instead of `reconcile_required`.
The test slept for 50 milliseconds after starting an asynchronous durable write.

The test now waits for the actual step handler to be entered. RunService awaits
the serialized durable running record before invoking that handler. A failure
before entry rejects the observation; the normal test timeout still bounds a
stuck operation. The handler remains unresolved, preserving the crash scenario.
Recovery, event and step-state assertions are unchanged. No runtime code changes.

The scoped-work observer deliberately also resolves parked `waiting` sessions:
its callers include tests asserting that unapproved and out-of-scope writes wait
for human review. Treating `waiting` as unfinished would prevent those callers
from observing the required state. That helper is unchanged here.

Validation is recorded under the personalized-demo-readiness delivery folder.
These changes are test prerequisites and do not complete H01 or a demo prompt.
