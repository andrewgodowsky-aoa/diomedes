# Accounts and remote paired workers: design specification

Date: 2026-09-09
Status: design, approved for implementation after the owner decisions in section 8
Repos: `F:/Achilles/diomedes` (desktop app), `F:/Achilles/diomedes-site` (marketing site, Cloudflare Workers + D1)

This document is written for an implementer who does not know this product. Every claim about
existing code cites `file:line` and was verified against the working tree on 2026-09-09. Where a
decision is a **one-way door** it is marked as such inline.

---

## 0. Orientation: what this product already is

Diomedes is a Windows desktop application (Electron shell over a Node service) that runs a project
with an AI helper. The service binds loopback in both entry points: `server/index.ts:31`
(`app.listen(port, '127.0.0.1')`) and `desktop/main.mjs:120` (`server.listen(0, '127.0.0.1', resolve)`).

Two facts matter more than anything else in this spec.

**Fact one: the approval gate is content-derived, and it is computed on the machine that owns the
project.** `server/approval-admission.ts:83-137` builds an approval identity by hashing the Need's
text plus every preview hunk's before/after/current content. `server/approval-admission.ts:139-155`
re-derives that identity at decision time and refuses on mismatch.
`server/approval-admission.ts:216` re-derives it again on every project load. The model authors the
prose (`server/native-work.ts:501`, `why: proposal.summary`), but the bytes are re-hashed from the
real writes immediately before they are applied (`server/native-work.ts:575-586`). A model cannot
change what it already got approved for by changing what it says about it.

**Fact two: the only authenticated surface in the whole product is the team MCP endpoint.**
`server/team/routes.ts:40-74` checks a bearer token plus an `X-Slot-Id` header. Everything else under
`/api/*` has no caller identity at all. The global middleware at `server/app.ts:320-342` checks only
a `Host` regex (`server/app.ts:325`), an Origin allowlist (`server/app.ts:327`) and a required
`X-Diomedes-Client: 1` header on mutations (`server/app.ts:339`). Those are anti-CSRF and
anti-DNS-rebinding controls, not credentials, and any non-browser client forges all three trivially.
The product already says so publicly: `src/content/docs/architecture.md:15` states that most of the
loopback API has no local authentication and that any other process on this computer can reach it.

Therefore: **this is not "extend an existing auth model across a network". It is "build the first
network trust boundary this product has ever had, next to a small existing loopback capability
model, without letting the network reach the unauthenticated API."**

---

## 1. Problem statement, and what is explicitly out of scope

### 1.1 The problem

Two separate wants have been conflated under the word "accounts". They must stay separate.

**Want A, remote paired workers.** A person owns two machines. One holds the project (call it the
**host**). The other has compute, a different engine sign-in, or physical access to something (call
it the **worker**). Work should run on the worker while the record, the approvals and the History
stay on the host. This is already published as planned: `src/data/status.ts:25`, and the
engineering order is already published at `src/pages/remote.astro:122-124` as Pairing, Transport,
Authenticated event replay.

**Want B, a product account.** A Diomedes-operated identity that a person signs in to. Its only
defensible technical purpose is to let two machines that cannot see each other on a network find
each other's public keys, and to publish revocations. Its plausible commercial purpose is
entitlement for a paid tier or a gated download.

**Want A does not require Want B.** Two machines on one network, or on a network the person already
runs (a LAN, their own WireGuard or Tailscale), can prove who they are to each other with no third
party at all. That is the design taken here, and it is why pairing ships first.

### 1.2 What this spec delivers

1. A local credential lifecycle (rotation, revocation, generation, expiry, constant-time compare)
   and a device keypair, with no network involved. This also fixes several live defects.
2. Direct host-to-worker pairing over mutually authenticated TLS, with no Diomedes server, no
   account, and no relay.
3. A Cloudflare-hosted account service whose entire job is: prove which account a device public key
   belongs to, let two devices discover each other's keys, carry an opaque sealed envelope it cannot
   read, and publish revocations. It can never admit a worker to anyone's machine.
4. The enforcement point that makes "a remote worker cannot write to your project without your
   approval" a structural property of the code rather than a policy that nine call sites remember to
   follow.

### 1.3 Explicitly OUT of scope

Out of scope for this design entirely. Do not build these, do not design for them, and do not let
them influence the wire format:

- **Multi-user.** One person, several machines. Two humans sharing a project is a different product
  with a different permission model. The archived prior art at
  `F:/Achilles/planning/_archive/2026-09-05-v3-replan/02-contracts-modes-host-remote-local-liveedit.md`
  scopes itself the same way.
- **Cloud work.** `src/data/status.ts:33` lists "work that continues on a cloud worker with the same
  permissions and evidence" as planned. A Cloudflare-side worker that executes work needs plaintext
  project content on Cloudflare. That is a second trust tier and a second public promise. It must not
  share this protocol's name or its credential.
- **Project sync.** The host owns the project folder. The worker receives a task and returns a
  proposal. There is no two-way document synchronisation, no shared filesystem, and no merge.
- **Simultaneous editing of one document from two machines.** See section 3.6.
- **Telemetry of any kind.** Not now, not later, not "anonymous", not "crash reports only".
- **Phone access.** `src/data/status.ts:29`. A phone is rarely on the same network and cannot host a
  worker, so it is the first case that genuinely needs the account. It is V3, after V2 exists.
- **Always-on service.** `src/data/status.ts:30`. Independent of this work, and it breaks a different
  published claim (`src/content/docs/getting-started.md`, "Nothing is added to startup").
- **Passkeys and WebAuthn.** Correct eventual upgrade, wrong first build. Adding it later changes one
  confirmation page and no endpoint.
- **Any OAuth client registry, consent screen, or token exchange.** Two endpoints and a device list.
  The moment this grows an IdP it has stopped being groundwork.
- **Widening the existing loopback listener.** See section 3.1. This is a hard prohibition, not a
  scoping preference.

---

## 2. The positioning decision

The audience is explicitly technical people who are sceptical of AI marketing, plus business
operators. Local-first is a trust pillar, not an accident. This audience diffs published pages.

The governing rule for this section: **the code change and the copy change ship in the same commit.**
Not the same sprint. The same commit.

### 2.1 What is preserved verbatim, and must not be touched in these releases

Touching any of these turns a scoped clarification into a general retreat. Freeze them.

| Claim | Sites | Why it survives |
|---|---|---|
| No telemetry | `src/content/docs/architecture.md:15`, `harness.md:9`, `F:/Achilles/diomedes/README.md:9` | Nothing in this design reports anything about a person or their work. This is the claim that earns permission to change the others. |
| No full access mode | `src/content/docs/permissions.md:15`, `src/pages/security.astro:36`, `src/data/status.ts:8`, `src/data/harness.ts:21`, `src/data/docsIndex.ts:33` | Unaffected. Permission modes stay `show-first` and `task` (`shared/types.ts:169`). |
| A run works in a read-only sandbox with no network | `src/pages/security.astro:71`, `:99` | **Still true, and this is not obvious.** The sandbox constraint is sent to the engine child process: `server/integrations.ts` sends `sandboxPolicy: { type: 'readOnly', networkAccess: false }` and refuses the turn if the runtime does not acknowledge it. The pairing connection is held by the **Diomedes service process**, never by the sandboxed engine child. A worker's engine run is sandboxed exactly as a local run is. Section 7 requires a test that pins this. |
| Anything that leaves the building waits for your go-ahead | `src/pages/index.astro:117-118`, `src/pages/business.astro:91`, `src/pages/security.astro:50` | Preserved by design, but only because of section 5.4. Pairing setup is itself an explicit human action at both ends, and per-task traffic inside an already-approved pairing carries only what the person's own approval boundaries allow. |
| Diomedes uses the sign-in the engine already has, and holds no engine key | `src/pages/models.astro:55` and `src/pages/download.astro:33`, both in part | The account never brokers an engine credential. `server/integrations.ts:77-78` states the principle in code: keep the native login in its native home, never transplant credentials. That stays. |

### 2.2 Wave one, at V1 (pairing ships, no account, no server)

These sentences are already time-stamped with "today", "yet" or "planned", so changing them is a
promise kept, not a reversal. All of them move in the V1 commit.

| Site | Current text | Replacement |
|---|---|---|
| `src/content/docs/remote.md:9` | "Remote paired workers are planned. Today the service is loopback-only with no remote access or pairing." | "Pairing two machines you own is available. It is off until you turn it on, per project. With no pairing turned on, the service accepts loopback connections only." |
| `src/content/docs/remote.md:15` | "There is no remote access, no account pairing, no installer, no signature and no updater. Any other process on this computer can reach the loopback API..." | "Pairing is off until you turn it on. With no pairing turned on, the service accepts loopback connections only. There is no account: two machines on one network pair directly with each other, and no Diomedes service is involved. There is still no installer, no signature and no updater. Any other process on this computer can reach the loopback API, so treat this machine as the trust boundary." |
| `src/content/docs/remote.md:3` (frontmatter summary) | "Planned. What pairing will carry, and the loopback-only present." | "What pairing carries between two machines you own, and what stays put." |
| `src/content/docs/permissions.md:29` | "...There is no remote access or account pairing." | "...A paired worker proposes; it never writes. Every write to your project is made by this machine, under an approval you gave here." |
| `src/pages/remote.astro:118` | "The service listens on 127.0.0.1 only. Members run over the team service on this machine. There is no remote access and no pairing yet." | "The service listens on 127.0.0.1 only. Pairing adds a second door that is closed until you open it, for one project at a time, to one machine you have approved by hand." |
| `src/pages/product.astro:131` | "No installer, signature or updater, and no remote access or account pairing." | "No installer, signature or updater. Pairing is limited to machines that can already reach each other on a network you run." |
| `src/data/status.ts:25` | status `planned`, note "Today the service is loopback-only with no remote access or pairing." | status `available`, note "Two machines you own, on a network you already run. Off by default, per project, approved by hand at both ends." |
| `src/data/harness.ts:23` | "Paired machines that run work elsewhere. Loopback only today, no pairing yet." | "Paired machines that run work elsewhere. Off by default, approved by hand at both ends." |
| `src/data/docsIndex.ts:34` | "Planned: what will travel, and the loopback-only present." | "What travels to a paired machine, and what stays put." |
| `src/pages/security.astro:112` | "No remote access. Pairing a phone or a second machine is planned work." | "Pairing a second machine is opt-in and off by default. Pairing a phone is planned work." |
| `src/content/docs/agents.md:13` and `src/content/docs/architecture.md:31` | "Non-loopback connections are refused." | "The team endpoint on 127.0.0.1 refuses non-loopback connections. A paired machine reaches a separate endpoint that you open per project, with its own key check." |
| `src/pages/harness.astro:15` | "It answers on 127.0.0.1 only." | "It answers on 127.0.0.1 only. Pairing opens a second, separate door that is closed until you open it." |
| `F:/Achilles/diomedes/README.md:350` | "**No installer, signature or updater**, and no remote access or account pairing." | "**No installer, signature or updater.** Pairing is limited to machines that can already reach each other on a network you run." |
| `F:/Achilles/diomedes-site/PRODUCT.md:44` | lists remote paired workers under Planned | move to the available list, with the same wording as `status.ts:25`. |

`F:/Achilles/diomedes/README.md:9`, `src/content/docs/architecture.md:15` and
`src/content/docs/harness.md:9` **do not change at V1.** "No account, no server, no telemetry and no
remote service of its own" is still literally true after V1, because V1 involves no account and no
Diomedes-operated service. Saying so explicitly is the single strongest thing this release can do
for the trust pillar. Add one sentence to the V1 remote doc: "Pairing needed no account and no
service of ours to build, and it still does not use one."

### 2.3 Wave two, at V2 (the account ships)

This is the wave that costs something. Five sites carry an unhedged account claim. Three carry the
canonical sentence; two more are on the highest-traffic pre-install pages and are easy to miss.

| Site | Current text | Replacement |
|---|---|---|
| `src/content/docs/architecture.md:15` | "There is no account, no server, no telemetry and no remote service of its own. Most of the loopback API has no local authentication: ..." | "No account is required. Install it, open a project and work. There is no telemetry: Diomedes reports nothing about you or your work to us, with or without an account. An account does one thing, which is to let two machines that cannot see each other on a network find each other's keys, and it does nothing until you create it. It holds your email, your device names, your device public keys and your revocations. It holds nothing from your projects. Most of the loopback API still has no local authentication: the team routes check a bearer token and slot, and Origin and Host checks with a required mutation header keep unrelated websites out, but any other process on this computer can reach it." |
| `src/content/docs/harness.md:9` | "It runs entirely on this computer. There is no account, no server, no telemetry and no remote service of its own." | "It runs on your own machines. No account is required, and there is no telemetry: Diomedes reports nothing about you or your work to us, with or without an account." |
| `F:/Achilles/diomedes/README.md:9-11` | "It runs entirely on this computer. There is no account, no server, no telemetry and no remote service of its own. When you switch a helper on, that helper's own sign-in ... is what talks to the outside world." | "It runs on your own machines. No account is required, and there is no telemetry: Diomedes reports nothing about you or your work to us, with or without an account. Two things can talk to the outside world and you switch each on yourself. A helper, using its own sign-in, today your existing ChatGPT sign-in for Codex. And pairing, if you pair a machine." |
| `src/pages/download.astro:33` | "Diomedes adds no account of its own and holds no key." | "Diomedes needs no account of its own to install or to work, and it holds no engine key." |
| `src/pages/product.astro:140` | "Diomedes signs you in to nothing and stores no key: it uses the sign-in the engine already has..." | "Diomedes signs you in to no engine and stores no engine key: it uses the sign-in the engine already has..." |
| `F:/Achilles/diomedes-site/PRODUCT.md:46` | "The site has no login, no analytics by default, no runtime AI calls." | "The site has an optional account for pairing machines across networks, no analytics by default, and no runtime AI calls." |

Four sub-claims cannot be preserved under any wording at V2. Retire them out loud rather than
letting a reader find the diff:

1. **"There is no account"** as an existential. Only "no account is required" is honest.
2. **"No server."** It was always the weakest word: `src/content/docs/architecture.md:13` documents an
   HTTP server two lines above the claim at `:15`. Retire it rather than reword it.
3. **"No remote service of its own."** This dies the moment any Diomedes-operated endpoint exists.
4. **"It runs entirely on this computer."** Replaced by "on your own machines", which is true for one
   machine and for a paired pair and never needs editing again.

### 2.4 Rules for whoever executes the copy change

- **Never edit `F:/Achilles/diomedes-site/docs/reference/app-README-2026-09-08.md`.** It is a dated
  snapshot, and `src/pages/product.astro` tells readers the limits section comes from the app README
  of that date. It is not published (`dist/` holds no copy of it), so its risk is lower than has
  sometimes been claimed, but editing dated evidence in place is still the wrong instinct. Add a
  dated successor beside it.
- **The site build gates copy.** `scripts/check-copy.mjs` runs inside `npm run build`
  (`package.json:12`) and fails the build on a banned-phrase list (`check-copy.mjs:3`), on em dashes
  (`:10`), on an en dash used as punctuation (`:11`) and on exclamation marks (`:12`). It walks
  `dist` only, so this spec file is not gated, but every replacement string above is. All the
  replacement wording above has been written to pass.
- **Add the `accounts` capability row to `src/data/status.ts` in the V2 commit, not before.**
  Publishing "Accounts, planned" onto pages that still read "Diomedes adds no account of its own"
  manufactures the contradiction. Do not add a separate `pairing` row: `remote-workers` at
  `status.ts:25` already covers it, and a duplicate string is a drift source.
- `src/data/status.ts` contains no account claim. The capability registry controls status labels
  only. It does not make the prose flip cheap; the prose is a real edit in real files.

---

## 3. Architecture

### 3.1 The three decisions that shape everything else

**Decision 1: the loopback listener is never widened. Pairing gets its own listener.**

The existing team endpoint's only transport control is `isLoopback` at `server/team/routes.ts:15-18`,
which reads `req.socket.remoteAddress`, applied at `server/team/routes.ts:42-45`. There is no
`trust proxy` setting and no `X-Forwarded-*` handling anywhere in `server/`. This has a lethal
consequence for the obvious designs:

> **Any transport that terminates locally and forwards to the loopback port makes every remote
> request read as `127.0.0.1`.** A relay client, an SSH tunnel, `cloudflared`, ngrok, a reverse
> proxy. `isLoopback` then returns true for the whole internet, and because `server/app.ts:322`
> exempts `/mcp/team/` from the Host check at `server/app.ts:325`, nothing else catches it. The 403
> stays in the source and stops being a control.

So: `server/index.ts:31` and `desktop/main.mjs:120` stay bound to `127.0.0.1` forever.
`isLoopback` stays exactly as it is, as defence in depth, and is never asked to carry remote
traffic. Pairing is a **second listener** with its own admission code that never consults
`remoteAddress`. Tunnel-terminated loopback is prohibited by the design, and section 7 requires a
test that a request arriving on the loopback listener with a paired credential is refused.

**One-way door.** Shipping a build that is *capable* of binding a socket off loopback retires
"the service listens on 127.0.0.1 only" even with the feature off by default. The copy in section
2.2 changes in the same commit as the capability, not in the commit where the first user enables it.

**Decision 2: the host listens, the worker dials in.**

The host owns the project folder, the History and the approval gate. The worker is compute. The
worker is also the machine more likely to be behind NAT (a shop machine, a laptop). Host-listens
matches the existing shape, where members dial in to the team endpoint.

**Decision 3: the worker proposes content; the host computes every digest and makes every write.**

This is the enforcement point and it is elaborated in section 5.4. The worker never writes to the
host's project folder, never mints a receipt, and never resolves an approval. It sends a proposal:
the Need text, the file paths, and the full before, after and current bytes of every preview hunk.
The host runs that through `identifyApproval` (`server/approval-admission.ts:83-137`) exactly as it
does for a local run, mints the receipt, shows it to the person, and applies it with its own
`writeRecorded` call.

The consequence, which must be stated in the docs because it qualifies a piece of marketing copy:
**the proposal content lives on the host.** `src/data/examples.ts` says the job files live on the
worker and the result and its evidence come back. The job's *source* files can live on the worker.
The *proposal* the person approves must be on the host in full, because that is what the person is
approving and what the digest is computed from. `src/content/docs/remote.md:19` is the normative
statement and it already says the right thing: "the project, the task state, the permissions and the
evidence travel with the work, and anything a remote worker proposes waits for approval under the
thread's permission mode, exactly as a local proposal does."

### 3.2 Topology

```mermaid
flowchart TB
  subgraph HOST["HOST MACHINE (owns the project)"]
    direction TB
    LOOP["Loopback listener<br/>127.0.0.1 only<br/>server/index.ts:31<br/>desktop/main.mjs:120<br/><i>never widened</i>"]
    TEAM["Team MCP endpoint<br/>POST /mcp/team/:projectId<br/>isLoopback + bearer + X-Slot-Id<br/>server/team/routes.ts:40-74"]
    PAIR["PAIRED LISTENER (new)<br/>off by default, per project<br/>mutual TLS, pinned device certs<br/>ignores remoteAddress entirely"]
    GATE{"Store.writeRecorded<br/>FAIL-CLOSED AUTHORITY GATE<br/>server/store.ts:784<br/><b>no remote authority kind exists</b>"}
    APPR["Approval identity<br/>identifyApproval / assertApprovalMatches<br/>server/approval-admission.ts:83-155<br/><i>digests computed here, always</i>"]
    HIST[("History and objects<br/>state.json<br/>history/objects/sha")]
    PROJ[("Project folder")]
    LOOP --> TEAM
    TEAM --> GATE
    PAIR -->|"proposal only<br/>never a write"| APPR
    APPR -->|"receipt minted on the host"| GATE
    GATE --> PROJ
    GATE --> HIST
  end

  subgraph WORKER["WORKER MACHINE (compute)"]
    direction TB
    WSVC["Diomedes service<br/>holds the pairing capability<br/>dials out to the host"]
    WLOOP["Its own loopback listener<br/>127.0.0.1 only"]
    WENG["Engine child process<br/>read-only sandbox<br/>networkAccess false"]
    WSVC --> WLOOP --> WENG
  end

  WSVC -->|"1. mutual TLS, pinned keys<br/>2. capability plus install ID<br/>3. task in, proposal out"| PAIR

  subgraph ACCT["ACCOUNT SERVICE (V2 only, diomedes.net Worker and D1)"]
    direction TB
    DIR["Key directory<br/>email to device public keys"]
    REV["Revocation feed<br/>monotonic seq cursor"]
    ENV["Sealed envelopes<br/>ciphertext it cannot read<br/>8 KB, 10 minute TTL"]
  end

  HOST -.->|"V2 only. Publishes its own key.<br/>Reads the peer's key.<br/>Polls revocations."| ACCT
  WORKER -.->|"V2 only. Same, from its side."| ACCT

  HUMAN(["The person"]) ==>|"reads a verification phrase on the host<br/>and confirms it on the worker"| PAIR
  HUMAN ==>|"approves every write, on the host"| APPR

  classDef gate fill:#3a2a00,stroke:#c89b3c,color:#f5f0e6
  classDef never fill:#2a0d0d,stroke:#c04040,color:#f5e6e6
  class GATE,APPR gate
  class LOOP,WLOOP never
```

Read the diagram this way. The dashed lines to the account service carry public keys, revocation
cursors and sealed envelopes. They never carry project content, and they do not exist at all in V1.
The double lines are the two places a human is structurally required. The solid line from worker to
host carries a task in and a proposal out, and it terminates on a listener that is separate from the
one the rest of the product uses.

### 3.3 Identity: the install key and the install ID

At first run (V0, no network involved) every install generates an **ECDSA P-256** keypair.

**Why P-256 and not Ed25519.** This is a one-way door: changing the algorithm after the first device
enrols means re-enrolling every device. P-256 with SHA-256 is fully standard WebCrypto, available
without qualification in the Workers runtime and in Node's WebCrypto inside Electron, and raw SPKI
public key import is standard. Cloudflare's own historical changelog documents Ed25519 on Workers
under the non-standard name `NODE-ED25519` with import restrictions; standard Ed25519 support is
plausibly present now, but the documentation is not unambiguous and this is not a decision worth
taking on a maybe. Take P-256. Revisit only if a concrete requirement appears.

**Install ID.** `base32(SHA-256(SPKI public key))`, padding stripped, giving 52 characters. Split
into four groups of 13, append one Luhn-mod-32 check digit per group (56 characters total), then
present as eight dash-separated groups of seven, following Syncthing's published device ID format.
This is a public identifier, not a secret. It is how a person tells one machine from another in the
interface and in History.

**The install ID is self-authenticating.** It is a hash of the public key, so a peer that presents a
certificate whose SPKI hashes to the expected ID has proved it holds the matching private key. No
registry is needed for identity. That is what lets V1 have no server.

### 3.4 The pairing ceremony

The direction of this ceremony is the single most important detail in it.

**The code originates on the approving side, never on the joining side.** The host mints a one-time,
short-TTL, attempt-capped code. The person carries it to the worker. This is the inverse of the
standard OAuth device authorization grant, and the inversion is deliberate: the standard orientation
has the joining device mint the code and the human type it into their own trusted surface, which is
exactly the shape Microsoft attributes to the Storm-2372 campaign and now recommends blocking by
default, and the same shape as the 2025 Signal linked-device attacks documented by Google Threat
Intelligence. **Nothing a person is asked to act on may originate outside their own trusted
surface.** Do not ship a scannable pairing URI that can arrive in a message.

Steps:

1. On the **host**, in the project, the person turns on pairing. The host generates a code:
   8 characters from a 20-character alphabet excluding look-alikes (`BCDFGHJKLMNPQRSTVWXZ`), giving
   about 34.5 bits. That is the entropy floor RFC 8628 section 5.1 works through, and it holds only
   because of the attempt cap in step 5. The code is displayed with the host's install ID, LAN
   address and port. TTL 10 minutes, single use.
2. The host opens the paired listener on the interface the person chose, with a self-signed
   certificate whose key is the install key.
3. On the **worker**, the person enters the host address and the code.
4. The worker connects with TLS, presenting its own install-key certificate. Neither side trusts a
   CA. Each side pins the other's SPKI hash and compares it to the install ID it expects.
5. The worker proves knowledge of the code inside the TLS session using a PAKE (CPace or SPAKE2+
   over P-256), so the code never crosses the wire in a form an observer or a future relay could
   brute-force. The host enforces **five attempts, counted durably**, then burns the code. This
   counter must be a durable count on the pairing record, never an in-memory map. There is an
   existing cautionary example in the codebase: the auto-wake budget at
   `server/team/service.ts:85` is a process-local `Map` that resets on restart.
6. **Both machines independently derive and display a verification phrase** from
   `SHA-256(sorted(host SPKI, worker SPKI))`, rendered as six words from a fixed 2048-word list or
   as twelve groups of five digits in the manner of Signal's safety numbers. The person compares them
   and confirms on both. **The phrase is derived, never transmitted and never stored by any server.**
   Storing it server-side would let a compromised directory substitute both keys and show the same
   phrase to both ends, which nullifies the only human check in the protocol.
7. The host mints a **pairing capability** (section 4.2), stores only its hash, and returns the
   plaintext once, inside the confirmed session. The worker stores it sealed (section 4.3).
8. The host writes a History entry, `kind: 'pairing'`, naming the worker's install ID and the project.

**A second machine on a network you already run needs nothing else.** No account, no relay, no
Diomedes service. That is V1 complete.

### 3.5 What crosses the wire, per task

Host to worker, for one task:

- task id, name, description, and the thread's mode (`ask`, `plan`, `build` or `fix`);
- the source documents the person selected, by content, subject to the same limits the local path
  enforces (`server/native-work.ts:194` caps at eight sources, `:214` at 128 KB of source text);
- the thread's permission mode **as a read-only fact for display**, never as an instruction. See
  section 5.3.

Worker to host, for one task:

- a proposal: summary, the files it wants changed, and for each one the full before, after and
  current bytes;
- its own run log;
- nothing else. No digests, no receipts, no History entries, no board mutations.

**The worker never sends a digest the host will trust.** The host recomputes every digest from the
content it received. A worker-supplied digest would be a digest of the worker's own claim, which
proves nothing.

### 3.6 Concurrency, and the thing that will surprise the implementer

There is a hard per-project run mutex today: `server/native-work.ts:190-191` throws
`This project already has work in progress.` if any session is active or a run is registered for that
project, and it rechecks after the async secret read at `server/native-work.ts:236-237`. The same
rule appears at `server/app.ts:1233`, `server/app.ts:1587` and `server/work.ts:37`, and is published
as a current limit on `src/pages/product.astro`.

A remote worker running while the host is idle passes this trivially and proves nothing about
concurrency. **A second machine working at the same time as the host is the point of the feature and
the current code forbids it.** V1's exit criterion is therefore two machines running work on one
project simultaneously, which requires:

- keying the run registry by `projectId` plus `originDeviceId` rather than `projectId` alone;
- making the token lease at `server/native-work.ts:223-247` project-scoped. Today `tokenEnv` is
  derived from the slot id alone (`server/native-work.ts:223`, and the same name is built at
  `server/app.ts:291`), so two projects with colliding sanitised slot ids collide, and
  `server/native-work.ts:238` writes the plaintext token into the **Diomedes service's own**
  `process.env`, visible to every child spawned during the window.

Simultaneous editing of the same *document* from two machines is out of scope. Document writes
already use an optimistic precondition: `server/store.ts:804-809` compares the caller's `expected`
hash against the current one and raises 409 with `This document changed since you opened it. Read its
current version before saving.` A remote proposal that loses that race is refused with the same
error, surfaced as a normal conflict, and the person re-runs. That is the correct behaviour and it
needs no new concept.

---

## 4. Data model

### 4.1 Local: the desktop

New files under `dataDir` (which is `DIOMEDES_DATA_DIR` or `<userData>/data`, per
`desktop/main.mjs:11-13` and `server/index.ts:10`; the existing layout is `settings.json`,
`registry.json`, `service.lock`, `pending/`, and `projects/<id>/{state.json, team-secrets.json,
history/objects/<sha>}` per `server/store.ts:345-369`).

```
<dataDir>/identity/install.json     public: { installId, publicKeySpkiB64, name, platform, createdAt }
<dataDir>/identity/install.key      SECRET: the P-256 private key, sealed (see 4.3)
<dataDir>/identity/account.json     V2 only: { accountId, email, plan, lastVerifiedAt, session }, sealed
<dataDir>/identity/revocations.json V2 only: { cursor, checkedAt, entries[] }
<dataDir>/projects/<id>/pairings.json         non-secret: peer install IDs, names, state, limits
<dataDir>/projects/<id>/pairing-secrets.json  SECRET: { peerInstallId: { hash, generation,
                                              issuedAt, expiresAt, revokedAt, attempts } }
```

Three rules about these files.

1. **Credential state lives in its own file, never in `settings.json` or `state.json`.** Both are
   read unconditionally on every boot (`server/store.ts:254`) and on every recovery reload
   (`server/store.ts:312-326`). A parse failure there would make an account problem present as a
   corrupted install.
2. **`pairing-secrets.json` stores only `SHA-256(capability)`.** The host never needs the plaintext
   again: it verifies a presented capability by hashing it and comparing.
3. **`team-secrets.json` stays plaintext and stays as it is.** This is not an oversight. The service
   must hand the plaintext token to the spawned engine at run start: `server/native-work.ts:230`
   reads `(await this.store.readTeamSecrets(projectId))[member.slotId]` and
   `server/native-work.ts:238` writes it into `process.env[tokenEnv]`, which
   `server/integrations.ts:113-115` reads back and `server/integrations.ts:780` names as
   `bearer_token_env_var`. There is also a currently-green test pinning the plaintext round-trip
   through disk (`tests/team.test.ts:686-687`). Hashing that file at rest breaks local member runs.
   The local member token and the pairing capability are **different credentials with different
   lifecycles**, and conflating them is the mistake to avoid.

### 4.2 The pairing capability

A 32-byte random value, hex, minted by the host at step 7 of the ceremony. Structurally similar to
the existing member token (`server/team/service.ts:224`, `randomBytes(32).toString('hex')`) and
deliberately not the same object.

| Property | Member token (existing) | Pairing capability (new) |
|---|---|---|
| Scope | one slot in one project | one peer install in one project |
| Storage at rest | plaintext (required, see 4.1) | SHA-256 only |
| Comparison | `expected !== token`, `server/team/service.ts:162` | `crypto.timingSafeEqual` over equal-length digests |
| Expiry | none | mandatory, default 90 days |
| Rotation | none | supported, generation counter |
| Revocation | **none exists anywhere** | first-class, immediate, local |
| Crosses a network | never | yes, inside mutual TLS |
| Grants | all thirteen team tools | propose-only, see 5.4 |

**On revocation.** There is no revocation in the product today, at all. `writeTeamSecrets` is called
from exactly one place, `createMember` (`server/team/service.ts:227`). There is no member deletion.
`stopMember` (`server/team/service.ts:232-239`) only sets a status field, and `authenticate`
(`server/team/service.ts:154-165`) never reads `member.status`, so a stopped member keeps full access
to all thirteen tools while `maybeWake` skips it (`server/team/service.ts:276`) so the operator sees
no activity and believes it is contained. That is a live defect and V0 fixes it.

### 4.3 Sealing secrets at rest on Windows

Use Electron `safeStorage.encryptString` and `decryptString`, which is DPAPI via Chromium OSCrypt on
Windows. Construct it inside the existing `app.whenReady()` block at `desktop/main.mjs:111-134`,
where the Express service is already created, and inject it through `AppOptions`
(`server/app.ts:32-39`) down into the `Store` constructor (`server/store.ts:241-244`). Note that
`readTeamSecrets` and `writeTeamSecrets` are `Store` methods, so an `AppOptions` field alone does not
reach them; the constructor change has a blast radius of twelve direct `new Store(` sites in tests.

Also note that `desktop/main.mjs:115` imports `./server/app.mjs`, which is the esbuild bundle of
`desktop/service.ts`, so any new option must be threaded through that file too. And
`scripts/package-desktop.mjs` bundles with no `external` array, so **server code must never import
`electron` directly**: the npm shim resolves in plain Node and exports a path string, so a
try/catch around require will not catch it. Gate on `process.versions.electron`.

Three honesty constraints on how this is described.

- **Electron's own documentation states that Windows DPAPI "does not prevent other applications
  running in the same userspace from accessing the data."** Say exactly that. It defends against
  another Windows user, a stolen disk, a backup, a synced folder and a support bundle. It does not
  defend against malware running as the person.
- File permissions are not the control here. On Windows, Node can only modify the write bit, so
  location is the control, and the packaged app already picks the right one: `desktop/main.mjs:12`
  defaults to `app.getPath('userData')/data`. A development checkout on another volume can inherit
  far looser ACLs; that is a property of where the repo was cloned, not of the shipped default.
- **Decrypt failure is a designed state, not a crash.** `DIOMEDES_DESKTOP_PROFILE` overrides
  `userData` and `DIOMEDES_DATA_DIR` moves the data folder independently (`desktop/main.mjs:10-12`),
  so a person can end up with ciphertext sealed against different key material. The state is
  `sealed-unreadable`: prompt to pair again, never lose local function.

### 4.4 D1 schema (V2 only)

The site's D1 database is bound as `DB` (`wrangler.toml:34-37`) and today holds exactly one table
(`db/schema.sql:1-10`). Everything below is additive.

Constraints that shaped it.

- **WebCrypto only.** `wrangler.toml:2` declares `compatibility_date = "2026-09-01"` and no
  `compatibility_flags`. Whether `nodejs_compat` is on by default at that date is not worth
  depending on: write the Worker with WebCrypto exclusively, as `functions/_lib.ts:145-150` already
  does (`crypto.randomUUID()` and `crypto.subtle.digest('SHA-256', ...)`), and the question never
  arises. Do not add `compatibility_flags`.
- **Compare secrets with `crypto.subtle.timingSafeEqual`, hashing both sides to a fixed size first**
  so a length mismatch cannot short-circuit. That is the pattern in Cloudflare's own Workers
  best-practices guidance. Note this API is a Workers extension: the desktop side uses
  `crypto.timingSafeEqual` from `node:crypto` instead, which is a different API with different
  semantics (it throws on unequal lengths, so hash first there too).
- **No KV.** KV writes take up to 60 seconds or more to become visible in other locations. A
  revocation that keeps authenticating for a minute somewhere in the world is indefensible for this
  audience.
- **No Durable Object.** `main` is `./.worker/index.js` (`wrangler.toml:3`), a generated bundle from
  `wrangler pages functions build` (`package.json:18`) whose only export is the default. A DO class
  must be exported from the entrypoint, so it needs a hand-written wrapper or a second Worker. Not
  worth it for a key directory. Revisit only if an always-on relay with hibernating WebSockets is
  actually built, and note that outbound WebSockets do not hibernate, so a desktop dialling out would
  hold a standing connection to Cloudflare whenever pairing is on. That fact would belong in the docs.
- **D1 gives the atomicity needed.** Every D1 query runs inside an implicit transaction, `RETURNING`
  is supported, and `batch()` is a SQL transaction that rolls back on failure. So
  `UPDATE ... WHERE consumed_at IS NULL ... RETURNING *` is a correct atomic compare-and-consume,
  which is what a one-time code needs.
- **Do not enable D1 read replication on this database.** Without the Sessions API all queries go to
  the primary, which is what a revocation feed needs. If replication is ever wanted for site latency,
  move identity to its own database first.
- **Do not rely on the Workers Rate Limiting binding for the attempt cap.** Its counters are
  per-location and its documentation says it is intentionally not an accurate accounting system, and
  its period must be 10 or 60 seconds, so it cannot express a cap across a 600-second code lifetime.
  Use it as a cheap outer guard only; the authoritative cap is the `attempts` column.

Adopt `wrangler d1 migrations` before there is anything to lose. Create
`db/migrations/0000_initial_submissions.sql` as a byte-identical copy of the current `db/schema.sql`
(every statement is `IF NOT EXISTS`, so replaying it against the live database is a no-op), then
`0001_accounts_devices_pairings.sql` with the DDL below, and add `migrations_dir = "db/migrations"`
to the `[[d1_databases]]` block. **Freeze `0000` in review forever.** Update the two places that
document the old command: the comment at `wrangler.toml:32-33` and `README.md:93-97`. Use exactly
one ledger, wrangler's `d1_migrations` table; do not also write a `schema_meta` version row.

```sql
-- 0001_accounts_devices_pairings.sql
-- Style follows db/schema.sql: TEXT primary keys, IF NOT EXISTS, ISO-8601 defaults,
-- CHECK on closed sets. Every statement is idempotent.

-- One person. Closure is a status change, never a DELETE: devices must keep
-- authenticating long enough to learn they were revoked.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  email_norm    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  closed_at     TEXT,
  -- No CHECK on plan on purpose: a pricing change must not be a table rebuild.
  plan          TEXT NOT NULL DEFAULT 'free',
  device_limit  INTEGER NOT NULL DEFAULT 10
);

-- Emailed one-time sign-in codes. A code, not a clickable link: corporate mail
-- scanners consume links before the person clicks, and a code typed back into the
-- tab that asked for it is bound to that session.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id           TEXT PRIMARY KEY,
  email_norm   TEXT NOT NULL,
  code_hash    TEXT NOT NULL,               -- SHA-256 of the 6-digit code, never the code
  session_hash TEXT NOT NULL,               -- binds the code to the browser session that asked
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,  -- authoritative cap, not the Rate Limiting binding
  consumed_at  TEXT
);
CREATE INDEX IF NOT EXISTS auth_challenges_email ON auth_challenges (email_norm, created_at);

-- A device is a public key with a person-chosen name. The private key never leaves
-- the machine and this table never sees it.
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,           -- the install ID, base32 of SHA-256(SPKI)
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL,
  app_version   TEXT NOT NULL,
  pubkey_spki   TEXT NOT NULL UNIQUE,       -- base64 SPKI
  pubkey_alg    TEXT NOT NULL DEFAULT 'p256' CHECK (pubkey_alg IN ('p256')),
  enrolled_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT,
  -- Rotation: a device replaced by another keeps its row and points at the successor.
  replaced_by   TEXT REFERENCES devices(id),
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS devices_account ON devices (account_id, enrolled_at);

-- Device enrolment. The person is signed in in a browser and approves this machine.
-- The device public key is bound at request time, so an approval cannot be moved to a
-- different key after the fact.
CREATE TABLE IF NOT EXISTS device_enrolments (
  id               TEXT PRIMARY KEY,
  user_code        TEXT NOT NULL UNIQUE,    -- shown in the desktop app, typed in the browser
  device_code_hash TEXT NOT NULL,           -- SHA-256 of the value the app polls with
  device_pubkey    TEXT NOT NULL,           -- bound at request time
  device_name      TEXT NOT NULL,
  platform         TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at       TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  approved_by      TEXT REFERENCES accounts(id),
  approved_at      TEXT,
  denied_at        TEXT,
  consumed_at      TEXT,
  ip_hash          TEXT                     -- enrolment only; see the note below
);

-- Browser sessions and device sessions. Refresh rotation via rotated_to.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('browser','device')),
  device_id    TEXT REFERENCES devices(id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  rotated_to   TEXT REFERENCES sessions(id),
  revoked_at   TEXT,
  -- A device session must name a device; a browser session must not.
  CHECK ((kind = 'device') = (device_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id, created_at);

-- The directory entry for one pair of machines. Deliberately absent:
--   verification_code  - DERIVED on each device from both public keys. Storing it would
--                        let a compromised directory substitute both keys and show the
--                        same phrase to both ends, defeating the only human check.
--   capability_digest  - the capability is host-minted and host-verified. Uploading a
--                        digest of it buys nothing and creates a membership oracle.
CREATE TABLE IF NOT EXISTS pairings (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  host_device_id   TEXT NOT NULL REFERENCES devices(id),
  worker_device_id TEXT NOT NULL REFERENCES devices(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  revoked_at       TEXT,
  -- A count, never a list of project identifiers. The directory must not learn how many
  -- projects are named what, or anything at all about them.
  project_count    INTEGER NOT NULL DEFAULT 0,
  -- How stale a revocation cursor may be before the host refuses new remote work.
  max_staleness_hours INTEGER NOT NULL DEFAULT 24,
  CHECK (host_device_id <> worker_device_id),
  UNIQUE (host_device_id, worker_device_id)
);

-- A dead drop. The Worker can neither read nor produce these. Used only to carry a
-- sealed pairing offer between two machines that cannot reach each other directly.
CREATE TABLE IF NOT EXISTS pairing_envelopes (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_device_id   TEXT NOT NULL REFERENCES devices(id),
  from_device_id TEXT NOT NULL REFERENCES devices(id),
  ciphertext     TEXT NOT NULL CHECK (length(ciphertext) <= 8192),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT
);
CREATE INDEX IF NOT EXISTS pairing_envelopes_to ON pairing_envelopes (to_device_id, created_at);

-- Tombstones. NOTE THE DELIBERATE ABSENCE OF A FOREIGN KEY on account_id: a device that
-- comes back online after an account is closed must still be able to learn it was cut
-- off. These rows hold opaque identifiers only, never an email or a name. seq is the
-- pull cursor, not a timestamp: a device polling "since seq N" under concurrent inserts
-- cannot silently miss a row.
CREATE TABLE IF NOT EXISTS revocations (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('device','pairing','session','account')),
  subject_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason       TEXT NOT NULL DEFAULT 'owner' CHECK (reason IN ('owner','rotation','expiry','abuse'))
);
CREATE INDEX IF NOT EXISTS revocations_account_seq ON revocations (account_id, seq);

-- A security log the PERSON reads on their account page. Note there is no free-text
-- detail column: that is where personal data creeps in. If this is ever not shown to the
-- person, delete the table rather than keep it, because at that point it is telemetry
-- under another name.
CREATE TABLE IF NOT EXISTS account_events (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind       TEXT NOT NULL CHECK (kind IN (
               'account.created','account.closed','signin.requested','signin.succeeded',
               'signin.failed','device.enrolled','device.revoked','device.rotated',
               'pairing.recorded','pairing.revoked')),
  device_id  TEXT REFERENCES devices(id)
);
CREATE INDEX IF NOT EXISTS account_events_account ON account_events (account_id, at);
```

Three notes on the boundary this schema draws.

**Account closure is `status = 'closed'`, never `DELETE FROM accounts`.** `sessions.account_id` and
`devices.account_id` both cascade, so a deleted account leaves no way for a device to authenticate a
poll for the tombstones that were meant to outlive it. Closing rather than deleting is what makes
the missing foreign key on `revocations.account_id` actually useful.

**`ip_hash` appears on `device_enrolments` only, not on `account_events`.** The site already has a
salted-hash helper (`functions/_lib.ts:147-151`) that stores an `ip_hash` when `IP_SALT` is set. Be
honest about what it is: a single global salt makes the hash a stable cross-request pseudonym, and
`SHA-256(ipv4 + salt)` is exhaustible over the whole IPv4 space by anyone holding both the database
and the salt. It is abuse mitigation on one endpoint, not anonymisation. `IP_SALT` is optional in
`functions/_lib.ts:5` and the helper silently stores null when unset; for identity endpoints make it
required and rotate it. Note that `devices.last_seen_at`, `sessions.last_used_at` and a revocation
poll together form a per-device activity timeline; keep the retention on those columns short and say
so on the account page.

**Do not link `submissions` to `accounts`.** `db/schema.sql:1-9` is a marketing dataset holding
name, email and `ip_hash`. Adding `submissions.account_id` invites joining enquiries to accounts for
no product benefit.

One integration gotcha. `functions/_middleware.ts:1-16` returns 403 for any POST carrying a
cross-origin `Origin` header. That is the site's CSRF guard. **Exempt only the two desktop-called
endpoints** (enrolment request and poll) if an Electron main-process fetch turns out to send an
`Origin`; never exempt the browser approval POST, which is the one request in the whole flow where
CSRF actually matters, because it is the click that authorises a machine. Verify the main-process
behaviour with a real request before building on an assumption about it: `desktop/main.mjs` contains
no outbound fetch today, so there is no precedent in this codebase.

### 4.5 Type changes in the app

**`Owner` gains a value, and `HistoryEntry` gains a field.** Today `shared/types.ts:9` is
`export type Owner = 'you' | 'diomedes' | 'diomedes-with-ok'` and `shared/types.ts:221` is
`actor: Owner` on `HistoryEntry`. Every action a team member takes is already recorded as
`actor: 'diomedes'` (`server/team/service.ts:480`, `:572`) with the member's name surviving only as
prose inside `sentence` via `memberAttribution` (`server/team/board.ts:26-28`). History therefore
cannot structurally say which principal acted. Widen it:

```ts
export type Owner = 'you' | 'diomedes' | 'diomedes-with-ok' | 'paired-worker';
// on HistoryEntry:
originDeviceId?: string;   // the install ID of the machine the action came from
```

This is safe to add. `HistoryEntry` has **no zod schema anywhere** in `server/` (verified), unlike
the receipts, and the codebase already establishes backfill-on-load as the pattern
(`server/store.ts:69-110` `migrateConversation`, `:113-124` `migrateSettings`, whose comment notes
that old values are read forever and only the current ones are written).

**`WorkReceipt` gains `slotId` and both receipts gain a version 2.** See section 5.5. That is the
one-way door and it is handled there.

---

## 5. Security model

### 5.1 Threat model

Assets, in the order an attacker would want them: the ability to write to the project folder; the
ability to cause an outbound run that ships project text to a third-party engine; the project
content itself; the integrity of the History record; the person's belief that History is accurate.

| # | Adversary | Can reach | Must not achieve | Control |
|---|---|---|---|---|
| T1 | A stolen pairing capability | The paired listener | Any write. Any approval. Any board mutation that clears a review flag | Section 5.4: the capability grants propose-only. Section 5.6: revocation |
| T2 | A compromised worker (the person's own second machine, now hostile) | Everything a legitimate worker can | Convince the host to apply bytes the person did not see; convince the person that work was done which was not | Host recomputes every digest from received content (`server/approval-admission.ts:83-137`) and re-verifies immediately before writing (`server/native-work.ts:575-586`). It can still lie in prose; History marks its entries `actor: 'paired-worker'` with `originDeviceId` |
| T3 | A network attacker between host and worker | The TLS session | Read or modify task content; impersonate either end | Mutual TLS with SPKI pinning to install IDs on both sides. No CA is trusted |
| T4 | A hostile web page in the person's browser | The loopback API via the browser | Reach `/mcp/team/` or the paired listener | The loopback listener keeps its Host check (`server/app.ts:325`) and mutation header (`server/app.ts:339`). The paired listener requires a client certificate, which a browser will not present. **Do not add CORS headers to `/mcp/team/`**: today a browser is blocked only incidentally, because no CORS headers are emitted so the preflight for `Authorization` and `X-Slot-Id` fails |
| T5 | Another local process on the host | The whole unauthenticated `/api/*` | Anything | Not defended today and not defended by this design. `src/content/docs/architecture.md:15` already says so. V0 narrows the two worst verbs; see 5.2 |
| T6 | A compromised account service (V2) | The key directory, the envelope store, the revocation feed | Admit a device to anyone's machine; read project content | The directory publishes keys; the **host** mints capabilities. A substituted key fails the human verification phrase, which is derived on the devices and never stored. Envelopes are ciphertext the Worker cannot produce or read |
| T7 | Device-code phishing | The person | Trick the person into admitting the attacker's machine | The code originates on the approving side (3.4), so there is no attacker-minted artefact for the person to enter. The approval screen names the install ID, the device name and the project |
| T8 | Prompt injection from a peer | Another member's run instruction | Steer a run | See 5.7. Three concatenation points must be fenced |

**Explicitly not in the threat model:** malware running as the person on the host. DPAPI does not
stop it (Electron's docs say so), the unauthenticated `/api/*` does not stop it, and pretending
otherwise would be the kind of overclaim this audience punishes.

### 5.2 The unauthenticated API is the real hazard, and two verbs must close first

`POST /api/projects/:id/team/members` (`server/team/routes.ts:83-95`) has no authentication and
returns a freshly minted 32-byte token in the response body (`server/team/service.ts:229`), and it
accepts `role: 'lead'`. `POST /api/projects/:id/team/messages` (`server/team/routes.ts:100-112`) has
no authentication and reaches `ownerSendMessage` and therefore `maybeWake`, which starts a Codex run.

Neither is exposed to the network by this design, because the paired listener is separate and never
routes to `/api/*`. Two things follow anyway.

1. **Never expose `/api/*` remotely, in any form, for any reason, including read-only.** It carries
   the approval verb (`server/app.ts:957-974`, `POST /api/projects/:id/needs/:needId/resolve`, with
   no caller identity), the settings verb (`server/app.ts:397-400`, which can set `services.codex`
   and flip `permissions.sending`), the document write verbs (`server/app.ts:615`, `:629`), the
   restore verbs (`server/app.ts:670`, `:689`) and the credential mint above.
2. **V0 adds authentication to the mint and the mailbox verbs** on their own merits. They are the
   sharpest local verbs and they are free to fix now.

### 5.3 The permission mode is machine-local and is never syncable

`maybeWake` (`server/team/service.ts:270-329`) starts a run only when the recipient thread's
permission is `task` (`server/team/service.ts:280`), which is the person's "Go ahead for this task"
setting. That field is written by `PUT /api/projects/:id/threads/:threadId`
(`server/app.ts:1141-1142`).

"Wake is local" is therefore **not** the right invariant. The right one is:

> **The inputs to the wake gate are machine-local. The thread permission mode is never carried by
> pairing, never writable by a paired peer, and never inferred from a peer's state.**

Write this into the protocol as a refusal, not a convention. A person choosing "Go ahead for this
task" is reasoning about a run they can watch on the machine in front of them. That reasoning does
not transfer to an unattended machine somewhere else.

Related, and it must be fixed: the wake path passes `consent: true` unconditionally at
`server/app.ts:361`, while the person-initiated path passes `b.consent === true`
(`server/app.ts:1444`) and `server/native-work.ts:183-188` throws `consentRequired` without it.
Consent is the "your instruction and selected documents will be sent to Codex" gate. Route the wake
path through the stored consent state (`seen.onlineServiceNotice`, `server/store.ts:165`, validated
at `server/app.ts:243-246`) instead of asserting it.

### 5.4 THE ENFORCEMENT POINT: `Store.writeRecorded` becomes a fail-closed authority gate

This is the most important change in the document. Do it first, before any network code, because it
is testable today with no pairing in existence.

**The problem.** `server/store.ts:784` is the last common point before bytes touch the project
folder, and it fails **open**:

```ts
// server/store.ts:787-791 (current)
const approval = options.approvalId ? state.needs.find((need) => need.id === options.approvalId) : undefined;
if (options.approvalId && (!approval?.approvalReceipt || approval.execution?.state !== 'pending' || ...))
  throw new ApiError(409, 'The write does not match its exact approval receipt.');
```

A call that omits `approvalId` performs **no approval check at all**. Five of the nine call sites do
exactly that. So the product's headline guarantee is currently a property of nine call sites
remembering to be careful, and any tenth call site silently opts out.

**The change.** Add a required `authority` to `WriteOptions`. The **writer** decides sufficiency, not
the caller. An absent authority throws.

```ts
type WriteAuthority =
  | { kind: 'person' }                        // a person acting at the local surface
  | { kind: 'approval'; approvalId: string }  // the existing receipt-checked path
  | { kind: 'assistant-draft' }               // model output written as a new document
  | { kind: 'sample' }                        // the scripted demo route
  | { kind: 'seed' }                          // demo content written at project creation
  | { kind: 'restore'; ofEntryId: string };   // History restore
// There is deliberately NO remote kind. A remote request produces a proposal and nothing else.
```

Assign every existing call site, exhaustively. Do not leave one out; a missing kind either throws in
production or is a silent hole.

| Call site | Kind | Note |
|---|---|---|
| `server/app.ts:481` | `seed` | Demo file content on project creation |
| `server/app.ts:615` | `person` | Document save |
| `server/app.ts:629` | `person` | Document create |
| `server/app.ts:830` | `person` | Plan-to-tasks. Note `server/app.ts:827` writes the numeric task id back into the person's plan document, which matters for section 7 |
| `server/app.ts:1569` | `assistant-draft` | **Writes the model's answer to a new .md with `actor: 'diomedes'` (`server/app.ts:1570`) and no approval receipt.** This is a model-authored write with no Need today. Do not label it `person`; that would launder it |
| `server/native-work.ts:602` | `approval` | Unchanged, the receipt-checked path |
| `server/work.ts:252` | `sample` | Fixed filename, fixed text |
| `server/work.ts:285` | `sample` | Fixed paragraph, server-chosen target (`server/work.ts:42-46`) |
| `server/store.ts:1175` | `restore` | History restore |

Then add a test that enumerates every `writeRecorded` call site in the tree and asserts each one
names an authority. That test is what converts the guarantee from discipline into structure.

**Why this preserves the approval gate across the network.** A paired worker's request never reaches
`writeRecorded`. It reaches a proposal handler that builds a `Need` from received content, and the
host's own approval path takes over unchanged. There is no code path that can express "a remote actor
wrote a file", so there is nothing to get wrong later.

**Two adjacent gaps to close in the same change**, both reachable today by any authenticated local
member:

- `taskUpdateAsMember` gates `completed` with `checkCompletionAllowed` (`server/team/service.ts:544`,
  refusing while an open Need or a waiting Change exists, `server/team/board.ts:95-111`) but does
  **not** gate the `deleted` branch (`server/team/service.ts:536-540`). Gate it the same way.
- The team status round-trip destroys the owner's review flag. `taskStateToTeamStatus`
  (`server/team/board.ts:51`) maps `waiting` to `{status:'in_progress', waiting_for:'owner'}` and
  `teamStatusToTaskState` (`server/team/board.ts:43`) maps `in_progress` back to `working`. So a
  read-modify-write of `status` clears `waiting`, which is the state set on approval settlement
  (`server/store.ts:427`, `moveTask(state, task, 'waiting', 'diomedes')` with
  `task.reason = 'changes-ready'` at `server/store.ts:429`). Either add an explicit `waiting` value
  to `TeamTaskStatus` (`server/team/board.ts:5`) or refuse any status write that would move a task
  out of `waiting`. **This is an approval-gate regression that is live on loopback today and is
  invisible to any transport-level control.**

### 5.5 Receipt provenance, and the one-way door

`ApprovalReceipt` pins `actor: 'local-client'` and `scope: 'local-prototype'` as TypeScript literals
(`shared/types.ts:151-152`) and `WorkReceipt` pins `scope: 'local-prototype'`
(`shared/types.ts:182`, whose own comment reads "This is the existing loopback trust boundary, not a
device authentication claim"). They are enforced three layers deep.

1. As `z.literal` inside `z.strictObject` (`server/approval-admission.ts:174-175`,
   `server/work-admission.ts:87`). `strictObject` means **no new field can be added at all**, not
   just that a literal cannot be widened.
2. As client-side equality predicates (`client/approval-decisions.ts:154-155`,
   `client/work-start.ts:139`).
3. **As part of the digest preimage.** `server/approval-admission.ts:57-58` folds both constants into
   `canonicalDigest`, and the resulting `payloadDigest` is the replay key, compared at
   `server/approval-admission.ts:272` (`if (admission?.payloadDigest !== receipt.payloadDigest) throw
   incompatible();`). Changing them changes the replay identity of every command.

Note also that these are **server-side constants, not caller input**: `requestSchema` at
`server/approval-admission.ts:25-33` does not accept `actor` or `scope`. Folding a constant into a
hash today gives domain separation and no authentication. Widening only binds anything if the server
derives the value from an authenticated channel, which is exactly what this design does.

The validators run on every load: `server/store.ts:268-269`, `:319-320`, and in journal recovery at
`server/store.ts:932`. `server/work-admission.ts:111-113` **throws** rather than discarding
(`A saved Work receipt is incompatible or inconsistent. Project state was not rewritten.`). That is
fail-closed and correct, and it explicitly preserves data. Keep it; do not "fix" it.

**The decision.** Introduce `protocolVersion: 2` as a discriminated union alongside version 1, never
as a widening of version 1.

```ts
export interface ApprovalReceiptV2 {
  readonly protocolVersion: 2;
  // ... every v1 field, unchanged ...
  readonly actor: 'local-client' | 'paired-device';
  readonly scope: 'local-prototype' | 'paired-v1';
  readonly decidedOnDeviceId: string;           // which install the person decided on
  readonly proposedByDeviceId: string | null;   // which install proposed it, null for local
}
export interface WorkReceiptV2 {
  readonly protocolVersion: 2;
  // ... every v1 field, unchanged ...
  readonly scope: 'local-prototype' | 'paired-v1';
  readonly route: 'sample' | 'codex' | 'paired';  // widen server/work-admission.ts:86
  readonly slotId: string | null;  // Session already carries slotId (shared/types.ts:187); the
                                   // immutable receipt does not, so a member-triggered run is
                                   // currently attributable only by joining mutable state
}
```

Readers accept `z.discriminatedUnion('protocolVersion', [v1Schema, v2Schema])`. V1 records keep
their exact digest preimage, byte for byte, so `server/approval-admission.ts:272` keeps matching for
every receipt already on disk.

**One-way door, and how it is bounded.** A v2 receipt read by an older build throws at
`server/store.ts:268`, `:320` or `:932`, which makes that project unloadable on the older build. So:

> **A project writes v2 receipts only if it has at least one pairing.** An unpaired project keeps
> writing v1 forever, so downgrade and rollback stay safe for everyone who has not used the feature.
> For a paired project, downgrading below the version that introduced pairing is a stated one-way
> door, and the release notes must say so.

Test the **failing** direction, not the safe one. "A v1 receipt still reads under a v2 build" passes
trivially and proves nothing. The test that matters is: a paired project's v2 receipt, loaded by a v1
reader, produces the documented refusal and does not corrupt state.

**Receipt capacity is a prerequisite.** `MAX_APPROVAL_RECEIPTS = 1024`
(`server/approval-admission.ts:23`) and `MAX_WORK_RECEIPTS = 1024` (`server/work-admission.ts:72`)
are hard ceilings that **refuse new work** with 409 `approval_receipt_capacity`
(`server/store.ts:393`) and `work_receipt_capacity` (`server/store.ts:453`), with no eviction. The
comment at `server/work-admission.ts:70-71` states the rule: never evict a receipt and silently make
an old command executable again, and a future retention migration must define an explicit
expired-command response first. Remote workers multiply command volume. **Do that retention
migration in V0**, before the volume arrives, and give remote commands their own separately-capped
ledger so exhausting it degrades pairing rather than blocking local approvals.

### 5.6 Revocation, and its honest limit

Three checkpoints, in order of authority.

1. **Local, on every paired connection.** The host reads `pairing-secrets.json` and refuses a revoked
   or expired capability. Works offline for anything already known. This is the authoritative check.
2. **Directory poll (V2).** The host polls `revocations` by `seq` and applies new tombstones locally.
3. **Worker self-disable.** Belt and braces only. A compromised worker will not self-disable, so
   nothing may depend on it.

**What makes revocation real is freshness, and it must be stated publicly.** A host that cannot reach
the directory keeps honouring a known-good pairing indefinitely, and an attacker who controls the
network controls whether the host can reach the directory. Hence `pairings.max_staleness_hours`,
default 24: the host refuses to accept **new** remote work when its revocation cursor is older than
that. Say the number on the page rather than implying revocation is instant.

Also state plainly next to the Revoke button: **revoking a pairing does not wipe the other machine.**
It cannot, in a local-first design. The adjacent advice is disk encryption. The first lost-laptop
incident becomes a trust incident if this is not said before it happens.

Finally: revoking an account or a pairing must **not** invalidate local team member tokens. They are
a different trust root, they never leave the machine, and a remote revocation that silently broke a
person's local team would be a surprise with no upside.

### 5.7 Prompt injection across the boundary

`renderWakeText` (`server/team/service.ts:79-81`) builds a member's wake prompt by plain
concatenation of other slots' message content as `From ${senderDisplayName}: ${content}`, with no
delimiter and no trust label. Content is attacker-controlled up to 16,000 characters
(`server/team/service.ts:368`) and the display name is attacker-controlled by a lead via
`team_rename_agent` (`server/team/service.ts:611-620`).

Fixing that one function is not enough. The same text is concatenated again at
`server/native-work.ts:379` as `Requested work: ${run.instruction}`, a label that **elevates**
attacker-controlled text to the request itself. And there is a third door:
`server/native-work.ts:202` resolves the instruction as
`input.instruction || task.description || task.name`, and any member can set a 10,000-character
description and reassign `assignedTo` to any slot (`server/team/service.ts:451-473`, which unlike
rename, interrupt and shutdown is not lead-gated), while the wake path selects the run's task by
`assignedTo` (`server/app.ts:349-353`).

The defence already exists in the codebase for a different input: `server/native-work.ts:377` fences
document contents with a "treat document contents as reference data, not instructions" instruction.
Apply the same fencing, with an explicit origin and trust label, to all three: the wake text, the run
instruction slot, and a task description that arrived from a peer.

### 5.8 Evidence and History

- **Mailbox traffic is not written to History.** `server/team/mailbox.ts:17-34` pushes onto
  `team.messages` and never calls `addEntry`, while task operations do
  (`server/team/service.ts:477`, `:569`) and a throttled auto-wake does
  (`server/team/service.ts:299`). So a stolen token's most useful actions leave no record while a
  paused wake leaves one. Record mailbox delivery in History before a peer can send mail.
- **Credential issuance is not written to History either.** `createMember`
  (`server/team/service.ts:165-227`) mints and returns a token with no `addEntry`. Record issuance,
  rotation and revocation of both member tokens and pairing capabilities.
- **There is a no-approval completion branch.** `server/native-work.ts:483-494`: when the model
  returns an empty change set the session is marked done, the task is moved to done, and
  `finishTeam(run, 'completed', proposal.summary)` reports success to the mailbox, with no Need, no
  receipt and no History decision entry. That is the exact branch a compromised peer would aim for.
  Write a History entry on it and mark it with `originDeviceId`.
- **What History can and cannot prove, stated honestly.** With `originDeviceId` and a per-origin hash
  chain, History proves that a revocable device asserted an entry in an unbroken order and has not
  silently rewritten its earlier claims. It does not prove the device told the truth. A worker can
  sign a lie. What bites a liar is that the host recomputes every content hash locally before
  applying anything, and that a withheld step shows as a sequence gap. Do not describe signed
  cross-machine entries as tamper-proof.
- **The engine's own approval prompt is not a second gate.** `server/integrations.ts:784` sets
  `default_tools_approval_mode: 'approve'` for the team MCP server, with the reasoning at
  `server/integrations.ts:772-777`, and `README.md:338-341` concedes there is no pre-execution veto
  over the Codex tool host. The Diomedes approval gate is the only gate. That is why 5.4 must be
  structural.

---

## 6. Behaviour across every network and auth state

**The governing rule, above all others: the local service never makes an outbound call on a request
path.** Remote facts (account status, entitlement, peer reachability) are read from a cached record
on disk and refreshed only by a background probe that follows the existing pattern at
`server/discovery.ts:371-385`: `AbortSignal.timeout(2500)`, catch everything, return a degraded
status object, never throw. If that rule holds, every state below falls out automatically.

### 6.1 A correction to the baseline before the table

Diomedes is not offline-proof today; it is offline-fragile today and nobody has measured it.
`shared/types.ts:330` classifies engines as `online | local | sample`, and the only proven engine,
Codex with ChatGPT, is declared `kind: 'online'` in `server/integrations.ts`. It reaches
chatgpt.com through a spawned child process, and `README.md:11` says so: the helper's own sign-in is
what talks to the outside world. So the honest baseline is: **the local shell (documents, board,
tasks, approvals, History, Restore, durable state at `server/store.ts:370-374`, `:878-887`,
`:930-982`) is network-independent and must stay that way; the work engine is already
network-dependent.** Accounts must not extend the second property into the first.

`codexStatus()` in `server/integrations.ts` sets `available = true` after a non-refreshing
`account/read` and deliberately swallows a rate-limit failure ("keep whatever the service last
reported"), so offline the Helpers panel may read Ready while every turn burns the two-minute turn
timeout. **Measure this before building anything** (see V0 exit criteria) and, if confirmed, fix it
on its own merits. A product that says "Codex is signed in but this machine is offline; Ollama and
Sample still work" is the strongest possible demonstration of the local-first claim.

### 6.2 The states

| State | What works | What does not | What the person sees |
|---|---|---|---|
| **1. Never signed in, no pairing** (the default, and where most installs stay forever) | The whole local shell: projects, documents, all four modes, the board, tasks, approvals under both permission modes, Review, undo, History, Restore, local team members over loopback MCP, and every engine reachable from this machine | Cross-network pairing. Cloud engines when the machine is offline, as today | Nothing new. One "Pair a machine" item in Settings. Zero banners, badges, nags or interstitials |
| **2. Paired, peer reachable** | State 1, plus remote work | Nothing | The peer listed as reachable |
| **3. Paired, peer unreachable** | State 1, unchanged | Remote work | The peer listed as unreachable the way Hermes shows "Not running". Mail to it queues and the member parks as `waiting`, which is what `server/team/service.ts:316-319` already does when the run starter throws. The board never blocks on a peer; the person can reassign the task locally |
| **4. Signed in (V2) and online** | State 2, plus directory lookups and revocation refresh | Nothing | Plan and a "last verified" timestamp on the account panel |
| **5. Signed in and offline** | **The local shell exactly as in State 1**, plus paired peers listed unreachable and cloud engines showing an offline reason rather than hanging | New cross-network pairing setup | Plan and "last verified", in Settings only. No re-auth prompt, no sign-out, no countdown, no banner over local work |
| **6. Account credential expired while offline** | All local work. Existing pairings on a reachable network keep working until the capability itself expires | New pairing setup; cross-network rendezvous | "Verify when you can" in Settings after 7 days. A hard stop on **outbound pairing setup only** at 30 days. There is no state in which an expired credential makes a document unreadable, a thread unrunnable, or a project unopenable |
| **7. Revoked remotely** | All local work. Local team members are completely unaffected (5.6) | The revoked pairing, from the moment the host learns of it or `max_staleness_hours` lapses | One dismissible notice in Settings. No read-only mode, no lockout, no data hold. Revoked is not signed out, and signed out is not data gone |
| **8. Sealed store unreadable** (moved profile, reset Local State) | All local work | Anything that needed the sealed credential | "Pair this machine again." A designed state, never a crash. A sealed credential is deleted only on an authoritative revocation, never because a read failed |
| **9. Partial partition** (host up, worker reply lost; envelope service 503; half-open link) | Everything else | The uncertain command only | See 6.4 |

Two credentials with different lifetimes make state 6 work. A long-lived local **account record**
(identity, plan, last-verified) with a 30-day grace, whose expiry disables outbound pairing setup and
nothing else; and a short-lived **peer-facing capability** that carries revocation pressure and is
never needed for local work, so its expiry is invisible offline. Expiry is checked against wall clock
everywhere today (`server/native-work.ts:553`, `server/store.ts:389`), so store a monotonic floor
alongside `lastVerifiedAt`: a backwards clock jump may not extend grace, but it must never shorten
local function. Note that `server/native-work.ts:553-556` already fails an in-flight run on a
backwards clock jump; that is a pre-existing defect, and accounts must not add a second one.

### 6.3 Boot must never wait on the network

`loadInitial` in `client/App.tsx:104-122` awaits only `/api/settings` and `/api/projects`, sets
`initialLoaded` at `client/App.tsx:111`, and only then fires integrations and usage with `void` at
`client/App.tsx:118`. The Wake screen (`client/console/useWake.ts:30-58`) holds the whole app until
`loaded` and latches a failure state if that awaited pair rejects.

**Do not add any account or pairing call to that awaited pair.** Serve account and pairing state from
disk on the existing settings route; refresh remotely after `setInitialLoaded(true)`, as `void`.
Note also that `/api/settings` is a **locked** route (`server/app.ts:370-374` defaults `locked = true`,
while `/api/integrations` is explicitly `false` at `server/app.ts:411`), so an outbound call on any
locked route serialises against the whole store and stalls every mutation in the app, not just its
own request.

Also: **do not overload the word `online`.** In the client (`client/App.tsx:45`, `:131-132`, `:304`,
`:473`) it means loopback-service reachability, driven by `EventSource('/api/events')`, and it drives
the visible string "Connection lost. Reconnecting." and a `disconnected` class on the page frame.
Reusing it for internet reachability would make the app announce it is broken when only the account
service is unreachable. Introduce a distinctly named value and keep it out of `status` and the
`disconnected` class.

Two things to know while working near this code, both real today:

- **The renderer origin changes every launch in the packaged app.** `desktop/main.mjs:120` uses
  `listen(0, ...)`, so `http://127.0.0.1:${port}` differs each start and browser storage is orphaned.
  Development hides it because vite pins 5173 with `--strictPort` (`package.json:9`). This already
  silently loses Ask drafts (`client/App.tsx:278`) and document drafts
  (`client/Workspace.tsx:242-247`) and, more seriously, it orphans the approval-decision receipts in
  `client/approval-decisions.ts:175`, `:298` and `client/work-start.ts:153`, `:227`. **No credential
  may live in the renderer**, and this is one reason why. The architecture already prevents it
  structurally: there is no preload and no IPC, and the window runs `nodeIntegration:false`,
  `contextIsolation:true`, `sandbox:true` (`desktop/main.mjs:147`), with popups denied
  (`desktop/main.mjs:176`) and off-origin navigation blocked (`desktop/main.mjs:177-179`).
- **Sign-in must not weaken that.** Do not add `shell.openExternal` plus a preload or IPC channel to
  get a login button; `desktop/main.mjs:1` currently imports only `app`, `BrowserWindow`, `dialog`
  and `Menu`, and the file states that this stays in the shell with no IPC or preload. Use the
  device-code flow: the local service displays a short code and a URL, the person opens it on any
  device they like, and the local service polls with a bounded timeout. Be honest that this adds the
  first non-loopback `fetch()` in `server/`, which is a real change to the disclosure story at
  `server/discovery.ts:11` ("Diomedes does not start this service or send anything to it"), and put
  it behind an explicit action in Settings with its own disclosure line. It must never start on its
  own.

### 6.4 Partial partition, and exactly-once

Reuse the discipline that already exists at `client/work-start.ts:188-218`: a minted `commandId`, a
canonical `payloadDigest`, 4xx-except-408 treated as terminal, anything else escalating to
`uncertain` with one retry and then surfacing "unresolved" rather than guessing, and an outright
refusal to send when the idempotency store is unavailable (`client/work-start.ts:228-231`).

Three corrections when applying it across a network.

1. **Persist the record server-side**, not in `sessionStorage`. `client/work-start.ts:225` keeps the
   uncertain-command record there, so a crash during an uncertain command loses it, and the retry
   mints a fresh `crypto.randomUUID()` (`client/work-start.ts:250`) which is a different command to
   the server. That is duplicate execution through the mechanism meant to prevent it.
2. **Namespace `commandId` by originating device.** The existing namespace is project-scoped
   (`server/command-admission.ts:29`), so a peer could otherwise collide into it.
3. **Rejections leave no receipt.** `findCommand` scans succeeded entities
   (`server/command-admission.ts:29-36`: `session.receipt` and `need.approvalReceipt`), so a rejected
   command has nothing to replay against. Reconciliation therefore needs a durable command log, which
   is the same work as the retention migration in 5.5.

There is also a competing, weaker idempotency scheme to reconcile: `server/team/service.ts:442-450`
and `:475-476` map an `idempotency_key` to a task id in `meta.idempotency` with **no payload
digest**, so a reused key with a different payload silently returns the old task instead of raising a
conflict, and the map is unbounded and persisted in `state.json`. Fold it into the command protocol.

### 6.5 Never poll on a schedule when there is nothing to poll for

A signed-in machine with no active pairing must make no outbound call at all. Not a revocation poll,
not a session refresh, not an update check. To a person watching with a firewall, a periodic outbound
connection from a product that says "no telemetry" is indistinguishable from telemetry, and this
audience watches. Gate every outbound call on "at least one active pairing exists", and back it with
a test.

---

## 7. Phased delivery

### V0: Named credentials, no network

**Repo:** `F:/Achilles/diomedes` only. The site diff must be empty.

**Entry criteria:** `main` green (`npm test`, `npm run check`).

**Step zero, before anything else: measure the present.** Add one test that boots the service and
client with all non-loopback egress blocked and records, as evidence, the time to interactive, what
the Helpers panel reports for Codex, and how long an Ask takes to fail. Until that exists, every
offline claim in this document is inference. If it confirms the green-badge-plus-two-minute-hang case
in 6.1, fix that first: it is a live defect, it costs almost nothing, and it is worth more to the
trust pillar than the whole accounts feature.

**Build:**

1. Generate the P-256 install keypair at first run; write `identity/install.json` and the sealed
   `identity/install.key`. Compute and display the install ID.
2. Add the `SecretBox` seam: optional on `AppOptions` (`server/app.ts:32-39`), threaded through
   `desktop/service.ts` into the `Store` constructor (`server/store.ts:241-244`). Implemented only in
   `desktop/main.mjs` inside the existing `app.whenReady()` block (`desktop/main.mjs:111-134`).
   Server code never imports `electron`. When no `SecretBox` is supplied (the `tsx server/index.ts`
   path, `package.json:8`, and tests), fall back to plaintext with a **visible** "not sealed on this
   platform" status, never a silent downgrade. The envelope is reversible: plaintext stays readable
   and is re-sealed on write, so a shared `DIOMEDES_DATA_DIR` keeps working across both entry points.
3. Make `authenticate` (`server/team/service.ts:154-165`) reject members whose status is `stopped`.
   Two lines. Today a stopped member keeps all thirteen tools while `maybeWake` hides the activity
   (`server/team/service.ts:276`), which gives the operator a false containment signal.
4. Add real member removal that deletes the secret, plus rotation with a generation counter, plus
   `issuedAt`, `expiresAt` and `revokedAt`. Restructure `team-secrets.json` from
   `Record<string,string>` to a record shape **with an explicit reader migration in the same commit**:
   it is read through a bare `readJson` with no schema (`server/store.ts:351`), so an unmigrated file
   would 401 every existing member with no diagnosis.
5. Replace `expected !== token` (`server/team/service.ts:162`) with `crypto.timingSafeEqual` from
   `node:crypto`, hashing both sides to a fixed size first so the equal-length precondition holds and
   nothing short-circuits. Do **not** reach for `crypto.subtle.timingSafeEqual`; that is a Workers
   extension and does not exist in this runtime.
6. Authenticate `POST /api/projects/:id/team/members` (`server/team/routes.ts:83-95`) and
   `POST /api/projects/:id/team/messages` (`server/team/routes.ts:100-112`).
7. Route the wake path's consent through the stored consent state instead of the hardcoded
   `consent: true` at `server/app.ts:361`.
8. Fix the wake budget so a **failed** start also consumes it: `server/team/service.ts:327` currently
   sets `wakeLog` only on the success path, after `acceptRun` at `:321`, while the catch at `:316-319`
   returns at `:319`. Persist `wakeLog` rather than holding it in a `Map`
   (`server/team/service.ts:85`), and write a History entry on the failure path.
9. Gate the `deleted` branch of `taskUpdateAsMember` (`server/team/service.ts:536-540`) with
   `checkCompletionAllowed`, as `completed` already is at `:544`.
10. Fix the `waiting` and `in_progress` round-trip (`server/team/board.ts:43`, `:51`) per 5.4.
11. Fix the mailbox cursor: `peekForSlot` (`server/team/mailbox.ts:40-50`) uses an **array index** as
    its cursor and returns the entire mailbox on an unknown id (`server/team/mailbox.ts:48`). Replace
    with a monotone per-recipient sequence and make an unresolvable cursor an explicit error.
12. Ship the receipt retention migration with an explicit expired-command response
    (`server/work-admission.ts:70-71` says this must come first).
13. Convert `Store.writeRecorded` to the fail-closed authority gate (5.4), with the six kinds
    assigned to all nine call sites and the enumeration test.
14. Move the `/mcp/team/` exemption at `server/app.ts:322` **below** the Host check at
    `server/app.ts:325-326`, keeping the exemption only for the CORS and mutation-header portion. Do
    not set the MCP SDK's `enableDnsRebindingProtection`: in the pinned SDK it is deprecated in favour
    of external middleware, and the correct middleware is already five lines away.
15. Fix the ephemeral renderer origin (`desktop/main.mjs:120`): persist and reuse a port, or move the
    approval-decision receipts and drafts into the service.
16. Change `Task.id` from `T${Math.max(0, ...ids) + 1}` (`server/store.ts:1197`) to
    `identifier('T')`, with a migration that keeps old ids readable. This is a data-corruption risk
    the moment two machines mint task ids independently: two partitioned machines both mint `T7`.
    It is **not one line**: `server/store.ts:1195` parses the numeric form with `Number(t.id.slice(1))`,
    and `server/app.ts:827` writes the numeric id into the person's plan document on disk.

**Deliberately NOT built in V0:** any network call of any kind; any account; any change to
`protocolVersion`, `scope`, `actor` or `route` literals; hashing `team-secrets.json` at rest (it
breaks `server/native-work.ts:230` and the currently-green test at `tests/team.test.ts:686-687`); an
OS keychain beyond `safeStorage`; a Windows Hello presence gate; any site copy change. Do **not**
give the local person an authenticable "owner" identity: the owner refusal is enforced twice
(`server/team/service.ts:156` and `server/integrations.ts:105`, the latter inside `teamEnvironment`
whose stated purpose at `server/integrations.ts:111-112` is keeping provider keys and `NODE_OPTIONS`
out of the token namespace), and turning an unconditional refusal into a credential check inside a
hardening boundary is not cleanup.

**Exit criteria:** extend the existing falsifier block at `tests/team.test.ts:159` to prove a rotated
token is refused, a revoked member is refused, the pre-rotation token is refused, a stopped member is
refused, and the non-loopback 403 at `server/team/routes.ts:42-45` still holds. Boot the client with
all non-loopback egress blocked and assert time-to-interactive is unchanged. `npm test` green.
`git diff` in `diomedes-site` is empty.

**Reversibility:** fully reversible. Nothing crosses a wire and nothing is published.

### V0-parallel: what to do about the site

Different repo, different session, concurrent. **Do not build a download entitlement.** A gate on the
download is an account on the page whose line 33 currently reads "Diomedes adds no account of its
own", and it would also falsify `src/data/status.ts:6` ("No public download, installer, signature or
updater yet"). Keep the existing mailing-list forms exactly as they are: no per-person identity, no
gate, no copy change. The only V0 site work is adopting `wrangler d1 migrations` per 4.4, which
touches no copy.

### V1: One owner, two machines. No server, no account.

**Entry criteria:** V0 merged. A decision recorded on the harness principal model (section 8,
question 6), because two identity models must not land in the same release.

**Build:** the paired listener (3.1), the pairing ceremony (3.4), the pairing capability (4.2), the
propose-only protocol (3.5), the concurrency changes (3.6), the receipt v2 union scoped to paired
projects (5.5), the `Owner` and `HistoryEntry` widening (4.5), the injection fencing (5.7), the
History gaps (5.8), and the wave-one copy change (2.2), all in the same release.

**Deliberately NOT built:** NAT traversal; any relay, rendezvous or envelope service; mDNS or any
discovery (the person types an address); phone access; cloud work; multi-user; any account; any
coupling to an installer or updater; any transitive trust. A worker may never vouch for another
worker: Syncthing's own introducer documentation concedes that a manually removed device is
re-added automatically while the introducer is still marked as such, and that two mutual introducers
re-introduce whatever is removed.

**Exit criteria:**

1. Two real machines run work on one project **simultaneously**, and evidence returns to the host.
2. A paired worker cannot cause a write without a local approval. Prove it by attempting one and
   observing the refusal, not by reading the code.
3. A revoked pairing is refused immediately and locally, with the host offline.
4. A request arriving on the **loopback** listener carrying a paired credential is refused, and a
   request arriving on the **paired** listener carrying a member bearer token is refused.
5. A paired project's v2 receipt loaded by a v1 reader produces the documented refusal without
   corrupting state.
6. The engine child on the worker still runs with `networkAccess: false` in a read-only sandbox,
   proving `src/pages/security.astro:71` stays true.
7. Unpaired projects still write v1 receipts, verified byte for byte.
8. With pairing turned off, the app makes no outbound connection of its own (6.5).

**Reversibility:** the feature is reversible. **Two one-way doors:** shipping a build capable of
binding off loopback, and writing v2 receipts in a paired project.

### V2: The account, and only what it must do

**The entry criterion is demand, not engineering.** Build it when named people are blocked because
their machines are not on one network, or when a paid tier needs entitlement. Until one of those is
true, do not build it. This is the only step that is a genuine one-way door on positioning.

**Scope:** the D1 schema in 4.4, the email-code sign-in, the device enrolment flow, the key
directory, the sealed envelope dead drop, the revocation feed, and an account page showing devices
and `account_events`. Plus the wave-two copy change (2.3).

**Non-negotiable properties, which are the whole point:** the account is optional and no local
capability depends on it; it holds no project content; it brokers no engine credential; it cannot
admit a device to anyone's machine; a fully compromised account service can deny service and observe
metadata and nothing more.

**Deliberately NOT built even here:** telemetry, cloud execution, project sync, multi-user, a general
IdP, and any account gate on a local feature.

**Reversibility:** none on positioning. Publishing a sign-in retires "There is no account, no server"
permanently.

### V3 and beyond, named only

Phone access, the always-on service and cloud work all need what V2 provides. Leave them uncommitted
until V2 exists. Cloud work in particular is a different trust tier and needs its own public promise.

---

## 8. Open questions the owner must decide before implementation starts

These are decisions, not research tasks. Each one changes code or copy.

1. **Does an account ever gate anything local?** A paid appearance package, a higher History
   retention cap, a business plugin, the download. This spec assumes a hard **no**. If the answer is
   yes, states 6 and 7 in 6.2 stop being no-ops, the whole degradation story weakens, and "no account
   is required" needs a qualifier on the download page. Record the answer; do not let it emerge from
   an implementation.

2. **Is the account a licence or a rendezvous?** They have different entry criteria, different data
   and different failure modes, and must not be specified as one deliverable. This spec designs the
   rendezvous. A licence adds a table and an offline grace window, and it changes the marketing copy
   more than the code.

3. **What is `max_staleness_hours`, and what happens when it lapses?** The default here is 24 and it
   refuses only **new** remote work. Does it also stop an in-flight run? This is the number that
   decides whether revocation is real, and it is a product decision, not an engineering one.

4. **Does a paired worker ever get its own approval authority?** This spec says no: every proposal
   routes back to the single local owner, and `decidedOnDeviceId` records where the person tapped.
   The alternative (a phone approving directly) means a phone key can authorise file writes. Decide
   before the receipt v2 shape is fixed, because it is inside the digest.

5. **Does the account gate the download?** If yes, `src/pages/download.astro:33` and
   `src/data/status.ts:6` both change at V2, and "no account is required" becomes false on the page
   people read immediately before installing.

6. **Does the harness branch merge before V1?** `server/harness/` does not exist on `main` (verified).
   Worktrees under `F:/Achilles/diomedes-wt/` carry a `HarnessPrincipal` with `tenantId`,
   `capabilities` and `identityGeneration`, plus cross-tenant refusals, and a newer branch also pins
   the approval gate to local in several more places. If it lands after V1, two identity models must
   be reconciled at the exact moment a trust boundary is introduced. Pick an order. If it lands
   first, V0's generation counter should be named to match `identityGeneration` rather than inventing
   a second one.

7. **Does `diomedes.net` itself gain a sign-in at V2, or does identity get its own Worker?**
   `PRODUCT.md:46` currently says the site has no login. A separate `id.diomedes.net` Worker with its
   own D1 gives a smaller blast radius and keeps account credentials out of the same database as the
   `submissions` marketing table (`db/schema.sql:1-9`, which holds email and `ip_hash`), at the cost
   of a second deploy and secret surface. This spec assumes the same Worker and the same D1. Confirm
   or change it.

8. **Is BYO-network the whole answer?** Documenting "use your own LAN, WireGuard or Tailscale" as the
   supported path, shipping V0 and V1, and never building V2 is a legitimate product answer. It
   preserves every current claim except "no remote access", requires no relay, no metadata to
   disclose and no signing story, and it is what the nearest prior art does. Price V2 against it
   explicitly rather than treating V2 as inevitable.

---

## 9. Rejected alternatives, and why

**Relax `isLoopback` and let remote traffic in through the existing listener.** Rejected. It is one
conditional at `server/team/routes.ts:42-45`, it will look harmless, and it converts a local-only
service into a network listener for everyone. Worse, `server/app.ts:322` exempts that exact route
from the Host check, so nothing else catches the traffic.

**Outbound-dial to a relay that terminates on loopback.** Rejected, and this is the trap most likely
to be walked into because it is the shortest path to a working demo. The relay client connects to
`127.0.0.1`, so `req.socket.remoteAddress` reads loopback for every remote caller and `isLoopback`
becomes an attestation of trust rather than a control, while continuing to look safe in the source.
It also does not preserve the claims it appears to: a vendor-operated relay is "a remote service of
its own", so it breaks `architecture.md:15` exactly as much as an inbound port breaks `remote.md:15`.
And it does not even leave the second whitelist intact: `server/integrations.ts:95-102` accepts only
`127.0.0.1` and `[::1]`, which every relayed worker would satisfy on its own machine, so that check
would stop distinguishing local from remote too.

**Reuse the member bearer token as the remote credential.** Rejected. It is stored in plaintext
(`server/store.ts:351-356`), compared with `!==` (`server/team/service.ts:162`), never expires, has
no audience or proof of possession, cannot be revoked by any code path, and is leased into the
service's own `process.env` (`server/native-work.ts:238`). It is a local convenience credential.
Publishing it as the trust story invites exactly the audit that discredits it. Note also that
"capability-scoped machine identity" is the wrong phrase for it: authentication as any member grants
the full thirteen-tool surface with no per-tool scopes, so it is **principal-scoped**, not
capability-scoped. The honest and still-strong framing is that the slot-to-token binding is checked
server-side, which is a real property and is stronger than the upstream project this code follows.

**Hash `team-secrets.json` at rest as a first step.** Rejected. `server/native-work.ts:230` reads the
plaintext at run start, which is arbitrarily later than issuance and survives restarts, so there is
no in-memory copy to hold; `tests/team.test.ts:686-687` pins the plaintext round-trip and is
currently green; and there is no OS keychain in the repo. Hashing is right for the **new** pairing
capability, which the host never has to re-present.

**Adopt the OAuth device authorization grant in its standard orientation.** Rejected. It is currently
the most abused modern auth flow, Microsoft recommends blocking it wherever possible after the
Storm-2372 campaign, and the structural flaw is direction: the code is minted by the remote party and
typed by a human who cannot tell whose device they are admitting. The mechanics are worth copying
(the polling contract with `authorization_pending` and `slow_down`, the entropy floor and attempt cap
from RFC 8628 section 5.1, and section 5.4's requirement that the approver be told exactly what device
is being authorised); the orientation is not. Section 3.4 inverts it.

**Any scannable pairing artefact that can arrive from outside the app.** Rejected. This reproduces
the 2025 Signal linked-device attacks documented by Google Threat Intelligence, where device-linking
links were substituted into legitimate-looking invitations and scanning silently attached an attacker
device that received all future messages. The code must originate on the approving side only.

**Cloudflare Workers KV for sessions, capabilities or revocations.** Rejected. KV writes may take 60
seconds or more to become visible in other locations, so a revoked worker keeps authenticating
somewhere in the world. That is the easiest mistake to make here and the hardest to catch in testing,
because it only manifests cross-region.

**A Durable Object as the identity system of record.** Rejected for now. DOs are strongly consistent
and would suit an always-on hibernating-WebSocket relay, but `main` is a generated Pages-Functions
bundle (`wrangler.toml:3`, `package.json:18`) exporting only the default, so a DO class needs a
hand-written wrapper entrypoint or a second Worker. Putting accounts in a DO also trades SQL joins
and one queryable table for a single-region pin, and the Free plan caps storage per account across
all objects, not just per object. Revisit only when a relay is actually built.

**Cloudflare's `workers-oauth-provider` library.** Rejected. It does not implement the device grant
(its grant types are authorization code, refresh token, token exchange and JWT bearer) and it
requires a KV namespace this project does not have and should not adopt for revocation state.

**A VPS with Postgres.** Rejected. Strictly more capable, and it adds an operational surface a
one-person company running a static Worker does not have.

**Ed25519 for device keys.** Rejected in favour of ECDSA P-256, on one-way-door grounds. See 3.3.

**Widening `actor` and `scope` in place on `protocolVersion: 1`.** Rejected. They are `z.literal`
inside `z.strictObject` in two validators, they are compared client-side, and they are inside the
digest preimage whose result is the replay key. Widening in place invalidates every receipt already
on disk, and the validators throw on load rather than discarding. Use the v1/v2 discriminated union
in 5.5.

**Porting AionCore's team transport or auth model.** Rejected. Diomedes already follows
`iOfficeAI/AionCore` `crates/aionui-team` for tool names and mailbox semantics (the attribution
comment is at the top of `server/team/routes.ts:1`), but on authentication Diomedes is already
**stronger**: upstream uses a single team-wide shared token compared with a plain `!=`, and reads the
slot id from caller-supplied parameters defaulting to `"unknown"`, so any member holding the token can
claim any slot. Diomedes issues per member and binds the slot server-side
(`server/team/service.ts:154-164`, `:224-227`). Adopting upstream's model would be a regression.
Upstream's actual remote story is a deployment recipe rather than a protocol: bind `0.0.0.0` and put
a VPN in front, single admin. Two things there are worth studying: their one-time short-TTL pairing
code store shape, and the fact that they keep accounts in a separate crate from teams, which is the
right seam here too.

**Transitive trust of any kind.** Rejected outright. A worker may never vouch for another worker.
Every paired machine is admitted by an explicit local approval or not at all.

**Building the account first, then pairing on top of it.** Rejected. It inverts the site's own
published order (`src/pages/remote.astro:122-124`), it retires the strongest trust claims in the
product before delivering the feature people asked for, and it is not required: two machines on one
network need no third party. Pairing first also means the account, if it is built at all, arrives
with a working protocol to serve rather than a hypothesis.

---

## Appendix: verification note

Every `file:line` citation in this document was checked against the working tree on 2026-09-09.
Where the research this design was built from disagreed with the code, the code won. Four
corrections worth carrying forward, because they will otherwise be repeated:

1. `docs/architecture.md` and `docs/remote.md` do **not** exist in the app repo. The equivalent
   claims live at `F:/Achilles/diomedes/README.md:9` and `:350`, and the site copies are under
   `F:/Achilles/diomedes-site/src/content/docs/`.
2. `MAX_WORK_RECEIPTS` and `MAX_APPROVAL_RECEIPTS` are **capacity ceilings that refuse new work**,
   not retention floors with eviction. Nothing is ever evicted today.
3. `checkCompletionAllowed` (`server/team/board.ts:95-111`) reads only in-memory `needs` and
   `changes`. It does not touch disk, and it **is** enforced against authenticated team members
   today, at `server/team/service.ts:544`.
4. The auto-wake budget is consumed only on the **success** path
   (`server/team/service.ts:327`, after `acceptRun` at `:321`); the failure branch at `:316-319`
   returns before it. A failing peer would be retried without limit until this is fixed.
