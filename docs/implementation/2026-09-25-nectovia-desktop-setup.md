# Nectovia executable and ChatGPT setup

Work order: NECTOVIA.DESKTOP.SETUP (owner request, no numbered roadmap prompt).
Owner: Codex, integrator seat; no delegation.
Branch: feature/nectovia-desktop-setup.
Worktree: F:/Diomedes/diomedes-wt/nectovia-desktop-setup.
Initial base: 2a446874fc8285cbb2b6d9c50545c1721904d624.
PR base after reconciliation: d27230b15dc93aa13a764e1f4004d9aaf6fe34ab.

Windows packages name the executable nectovia.exe. The installer marker, product ID,
registry keys, data directory, package directory and release asset names stay stable.
Shortcuts, release hashes, smoke tools and updater detection follow the new filename.
The updater also recognizes the old executable layout. An upgrade removes only the
legacy executable inside the install directory after the ownership check and payload copy.

The Windows package already includes Codex. Onboarding now shows ChatGPT setup;
Settings embeds the same controls in its existing ChatGPT row. Native account login
uses the bundled, version-checked app-server protocol and its native credential store.
Only a validated OpenAI authorization URL reaches the browser. No credential is copied,
no API-key fallback is selected, and no prompt is sent by the account checks.
Login completion does not enable a route; a fresh account and sandbox check gates use.
This does not extend Codex to the separate home-conversation adapter.

The two duplicate settings entries are one section: Helpers on this computer in Guided
and Standard, Engines in Technical. Existing section links resolve to the current label.
Claude's own 2.1.281 handshake reported Opus and Fable with a [1m] context suffix, which
the model-ID filter rejected. The picker now retains those native choices. Dispatch
accepts the runtime's corresponding underlying model while still rejecting other models.

Live read-only account/model discovery after the fix returned Opus (1M context), Fable,
Sonnet and Haiku. No Claude generation or paid provider prompt was sent. TypeScript
passed, and the final focused run passed 117 tests across 10 files (setup, Claude,
updater, installer generation and registration, icon, naming and release-record checks).
The owner narrowed delivery to a fix PR targeting main. No version bump, full desktop
build, release, merge or installation is part of this delivery. Browser, packaged upgrade
and interactive OAuth acceptance remain separate from the mocked unit tests.
