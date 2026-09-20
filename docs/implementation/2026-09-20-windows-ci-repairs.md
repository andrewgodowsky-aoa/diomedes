# Windows CI: installer path identity and large-folder setup

PR 3's Windows runner exposed two failures on base
80263205133c410d590549efd1c8f40cedf33b1c. The event recovery implementation was not
on either failing path.

The installer proof compared WScript's expanded shortcut target with the literal
install target. On a profile path containing RUNNER~1, those strings name the
same executable but differ. A real local 8.3 fixture reproduced the runner's
exact refusal. The comparison now expands existing components with Windows
GetLongPathNameW. Only missing suffixes are retained for interrupted uninstall
recovery; other resolution failures do not establish ownership. The existing
snapshot-byte fallback and all foreign-change refusals remain.

The complete registration scenario runs under both an ordinary path and an
actual short path on the Windows profile volume. It verifies exact restoration,
timestamps, interrupted restoration, absence, foreign registrations/shortcuts,
and removal of the proof executable before restoration. Foreign shortcut bytes
are compared before and after refusal, including when the foreign target no
longer exists. A system with aliases disabled reports that particular physical
alias case as skipped; it never claims to have exercised alias resolution.

The large-folder test includes creation and a full walk of 3000 real documents.
Its setup deadline is now 120 seconds, while the cached HTTP read still must
finish in less than 200 ms and return all 3000 rows. Phase timings distinguish
fixture creation, project creation, explicit walk and the measured cached read.
No cache assertion or production cache behavior was weakened.

Local focused evidence: the new alias case failed on the original module; after
the repair, both registration scenarios and the selected cache test passed.
The explicit document walk took 8616 ms and the cached read took 11 ms on this
machine. This is not a hosted-runner performance measurement. Full gates and CI
are recorded separately before acceptance; neither installer execution nor
registration of the user's installed application was performed.

Fresh complete local gates on this candidate: TypeScript PASS; 2240 unit tests
passed, zero failed and one existing platform alias skip; Vite PASS; all 35
browser tests passed with no skips. Both new registration variants executed in
that unit run. Evidence is in
F:/Diomedes/deliverables/continuation-20260920/windows-ci-repairs/gates-2/.
The first full attempt stopped at a test callback typing error; its log remains
in gates-1. The test now uses one normal Vitest context per path variant.
Independent review and hosted CI remain required before merge.

Windows API reference:
https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlongpathnamew
