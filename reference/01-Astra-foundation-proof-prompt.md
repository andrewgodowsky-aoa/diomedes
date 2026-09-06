# GPT 6 Astra — Achilles foundation proof, before application implementation

You are taking over Andrew's Achilles project after Fable's 2026-09-05 v3 replan. This is a narrowly bounded feasibility task, not permission to build the full platform or execute the old V1-A bundle.

## Outcome

Determine whether the exact proposed AionCore Windows artifact is a viable foundation for Achilles's first real, permission-controlled Codex workflow. Produce a small reproducible probe, evidence, and a precise go / conditional-go / no-go / inconclusive report. Stop there. Do not scaffold the production client, gateway, full editor, or desktop application.

The product direction is an independent, distinctive project-first desktop plus a remote client, using existing native agent machinery where suitable. Required later capabilities include Chat/Plan/Agent/Review behavior, live human–agent editing, native Claude/Codex subscriptions where permitted, OpenCode Go, local models through the existing supervisor, readable skills, advising, scoped learning, and remote task creation/control. The consulting/Notion-style v4 vision is context, not scope for this probe.

## Read first, without implementation

1. `00-Review-and-recommended-decisions.md`, especially R01–R08 and R10.
2. `sources/fable-v3/00-executive-recommendation.md`.
3. `sources/fable-v3/01a-recheck-2026-09-05.md`.
4. `sources/fable-v3/research/source-inspection-2026-09-05.md` §§0–3 and §6.
5. `sources/fable-v3/02-contracts-modes-host-remote-local-liveedit.md` §§1–5.
6. `sources/fable-v3/03-architecture-and-reuse-matrix.md` §§1, 3–7.
7. `sources/fable-v3/06-astra-handoff-v3.md` as background only. Its automatic transition from V0.5 into V1-A is **superseded by this prompt**.

Do not treat documentation, inspected source, runtime declarations, and tested behavior as equivalent. Do not repeat the entire plan back to Andrew.

## Authorization boundary

You may first perform narrow read-only local inspection and public-source retrieval, and write a preflight report inside a new clearly identified Achilles planning/probe-output directory. Do not read credential contents, private profile personalities/memories, or conversation histories.

Before downloading or launching an executable, invoking Codex, or installing anything, present **one concise authorization request** containing:

- the exact download origin/artifact, current reported size, verified source/tag relationship, and digest plan;
- proposed new directories, ports, and native-agent side effects;
- whether any missing runtime or tool would require installation;
- a hard proposed ceiling of **eight model-backed Codex turns** on Andrew's existing ChatGPT subscription for this proof, with no API fallback;
- cleanup and stop conditions.

The eight-turn ceiling is a proposed maximum, not a quota and not pre-approved spending. If Andrew has already explicitly approved these exact side-effect classes in the current execution conversation, cite that approval and do not ask again. Otherwise stop and wait for one yes/no authorization. Do not ask separately about five details that read-only inspection can resolve.

This prompt does not authorize Claude use, model loads, global toolchain installation, an off-loopback listener, a public post/issue, or a production change. The later Tauri comparison is not part of this execution task.

## Reported environment — recheck narrowly

Fable reported the following; none is guaranteed current:

- `F:\Achilles`: planning root, not yet a Git repository at the time.
- `F:\LocalAI`: production repository, 166 dirty entries; read-only.
- `F:\LocalAI\hermes-home\hermes-agent`: `update/desktop-2026-09-04` at `63279301`, 20 dirty entries and 3 stashes; never modify.
- Hermes profiles: `default`, `freakbot`, `freakytoo`, `worker`; all production. ROLEPLAY is a route, not a profile.
- Supervisor: `127.0.0.1:8080`, worker `18080`; optional GET `/localai/status` only. Do not query other endpoints merely to discover what happens.
- Hermes gateway `8642`; unrelated OpenCode service on `4096`; do not adopt or stop them.
- Installed Codex 0.153.4, Claude 2.1.252, OpenCode 1.18.4; do not upgrade them.
- F: 40.4 GB free, D: 122.1 GB free, C: 27.7 GB free at the recorded time. Recheck capacity and device medium before recommending a live-data location. Do not assume more free space means faster storage.

Read executable versions, existence, relevant process/port ownership, and free-space information without dumping unrelated environment/configuration. Do not initialize a repository solely for a throwaway probe; do not edit existing plans in place. Use a new run-stamped directory and preserve earlier evidence.

## Step 1 — Resolve the source/artifact mismatch

The ledger associates AionCore default-branch head `a7cc6de` (September 3) with release `v0.2.1` (September 1). Resolve the exact release tag to its full commit. Inspect the required CLI, DTO, permission, custom-tool, and session code at that commit rather than at `main`.

Record:

- repository and read timestamp;
- tag, tag target and peeled full commit;
- release asset name/identifier and size;
- official checksum/attestation availability, recorded and locally computed digest;
- executable-reported build identity after authorized launch;
- any remaining provenance uncertainty.

The expected asset in Fable's handoff is `aioncore-v0.2.1-x86_64-pc-windows-msvc.zip`; its stated checksum is an input to verify, not unquestioned truth. Do not silently switch to a different release. A matching version string alone is not source provenance.

Inspect only the protocol and launch surfaces needed for this proof. Do not create a complete cross-language schema generator or mirror all 41 DTO modules. Capture representative actual wire fixtures and minimal validation instead.

Check managed-resource behavior before launch. The source ledger reports a default download mode. Use a documented restricted/local-only configuration if available; otherwise make expected automatic downloads part of the approval request. No opportunistic npm/bun/cargo/global installation or concealed bootstrap downloads.

## Step 2 — Establish isolated execution after approval

Create a tiny synthetic workspace, including Markdown and a few code/text files with a verifiable initial manifest. No actual AoA/Unreal assets or restaurant data. Initialize Git inside the synthetic workspace only if needed for this test and authorized; set any required identity locally for that fixture, not globally.

Use a separate AionCore data/log directory, never an existing AionUi/Hermes directory. Run on an available loopback port with authentication enabled. Validate the exact release's CLI syntax before using Fable's example. Do not use `--local`; do not tie host lifetime to the probe client or desktop process. Any temporary admin secret stays in protected throwaway state, not in the report, command arguments, or logged frames. Ensure password bootstrap addresses the same fixture data directory as the host.

Use a Node-built-in scripted client if the installed version actually provides the needed APIs. Do not add dependencies solely for convenience. If a required tool is absent, record the blocker and ask for only the specific installation; do not install a general toolchain bundle.

Native Codex may use its existing authentication store and create ordinary native session metadata. Neither your custom probe nor you may read/copy/transplant credential contents. Disclose normal native metadata writes instead of claiming literally zero writes outside Achilles. Remove conflicting API-routing overrides from the **child environment only**, without revealing values, and verify any host configuration that could reintroduce them. Never alter global Codex configuration or use a paid API fallback.

Maintain an ownership manifest for spawned processes (PID, start identity, parent chain) and newly created files/directories. Do not touch unrelated running agents.

## Step 3 — Bounded proof matrix

Use the fewest turns that establish the following. Reuse session state where appropriate, account for each turn, and remain within the approved ceiling. Prefer synthetic protocol tests for recovery/duplicate cases that do not need another model call.

### P1. Startup, authentication and native route

Host health, authenticated login, stream connection, one Codex conversation, and an actual response work against the pinned artifact. Record actual endpoint/payload shapes, native session identity, route class, account alias where exposed, and token/cost status as reported/estimated/unknown.

No API keys in the test path. Absence of environment overrides alone is not proof of account routing: use non-secret native authentication/route status where available. Do not inspect auth files to obtain it. If route identity remains uncertain, say so.

### P2. Required behavior/policy path through AionCore

Prove whether the host lets Achilles specify per-conversation sandbox/approval settings and relevant instructions without editing global engine config.

Plan should inspect source but not modify implementation files. Attempt at least one forbidden file edit and one command-based write in the fixture. Check actual filesystem results and native enforcement events. Do not count a model voluntarily obeying a reminder as enforcement.

Investigate the proposed scoped `plan.write` tool through the same host path: can it be attached at the conversation/session boundary, and limited to the fixture's plan directory? Use a minimal synthetic test tool if supported and within approved scope; validate resolved paths. If this cannot be configured through the selected host, record the exact missing control. Do not fake the tool or grant broad implementation write permissions to make the demonstration pass.

Then explicitly authorize a narrowly scoped Agent-mode edit and verify the requested change is real. Ensure the read-only and execution paths are different effective permission states, not just different system prompts.

### P3. Approval and steering

Trigger one real native approval and deny or approve the precisely described fixture action; verify the file/process result. Identify the stable native request/action identifiers and available arguments. Determine whether they are sufficient for Achilles's planned binding/reconciliation layer.

Test a supported mid-turn steering boundary or record precisely why it was unavailable in the pinned build. Preserve native distinction between queued, delivered and acknowledged; do not interpret a transport acknowledgement as proof that the model understood or correctly acted on the content. Interruption is not undo.

### P4. Client detach versus host recovery

Disconnect the scripted client while the host stays running. Reconnect and determine which pending approval, conversation history, session identity, and events are recoverable.

Separately test a bounded loss of the host-facing stream or a disposable host restart where feasible. Identify which events are durably stored upstream, which exist only in the gateway/probe, and which are lost. Do not claim full replay because a live reconnect happened to show the current state.

For the window between command acceptance and acknowledgement, identify how an ambiguous outcome can be reconciled. If upstream idempotency/query support is insufficient, the proposed product response is **outcome unknown / reconciliation required**, not blind retry. Record this limitation rather than building a distributed exactly-once layer during the probe.

### P5. Owned lifecycle and baseline

Verify that stopping/detaching the client is distinct from terminating the host or active run. After the final authorized test, stop only the test host and its proven child processes. Verify those owned processes/ports are gone without terminating any unrelated Codex/Node/AionCore process.

Capture a modest baseline: process tree, startup timing, observed streaming intervals, and memory before/after the test. This is a foundation baseline, not an Electron/Tauri benchmark or a leak-free certification.

## Step 4 — Stop conditions and interpretation

- Authentication absent, subscription exhausted, or provider unavailable: report the actual cause; do not use another account or API route. No infinite retries.
- Unsupported mandatory permission/tool boundary: conditional-go or no-go for the stated behavior; identify the smallest remedy. No broad permission bypass.
- Release/provenance mismatch: stop dependency adoption until a pinned choice is explicit.
- An external maintainer licensing answer is not a runtime test and must not block this personal fixture report indefinitely. Mark it unresolved; no redistribution or public contact in this task.
- Eight approved turns exhausted: stop, report what remains untested, and request a specific extension only if necessary.
- Unexpected resource install, production modification, or off-loopback listening: stop, report, and clean up only your own artifacts/processes.

A source comment or capability declaration can support a hypothesis, not a passed test. A missing required control may justify a targeted native-protocol adapter or fallback proposal; it does not authorize implementing a second full host.

## Output files

Inside the new run-stamped directory, produce:

1. `REPORT.md` — executive verdict, P1–P5 results, exact evidence references, blockers, and recommendation for the first implementation slice.
2. `artifact-manifest.json` — provenance, versions, asset checksum, tool versions, test roots, owned process identities, no secrets.
3. Minimal `probe/` scripts and synthetic fixtures, explicitly labeled experimental/throwaway.
4. `evidence/` — sanitized relevant frames, command outputs, fixture before/after checks, lifecycle checks, actual usage count. No credential tokens or whole process environment dumps.
5. `NEXT-SLICE.md` — the smallest working product flow that the evidence supports; dependencies; shell-comparison plan; no automatic start.

Use outcomes `PASS`, `FAIL`, `NOT TESTED`, or `INCONCLUSIVE`, with the scope stated for each. Do not mark the product ready on the basis of the probe. Preserve evidence after cleanup. Do not overwrite Fable's source package.

End by explaining what worked, what did not, what still needs permission, and the exact next decision. **Do not continue into V1-A, install Tauri, implement remote pairing, modify LocalAI, or scaffold the full application.**
