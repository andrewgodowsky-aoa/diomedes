# Phone relay protocol, version 1 (relay plan steps 1 to 4)

| | |
|---|---|
| Plan | `diomedes-ios/docs/RELAY_PLAN.md`, steps 1 and 2: device registration and revoke, the desktop's outbound client, presence. Steps 3 and 4: the phone's socket, typed messages after `ready`, hub routing and the desktop's handlers |
| Feature | `phone-relay` (`PHONE_RELAY_FEATURE`); refused as `PHONE_RELAY_NOT_INCLUDED_REASON` |
| Branch | Steps 1 and 2: `feature/phone-relay`. Steps 3 and 4: `feature/phone-relay-messages`, worktree `F:/Diomedes/diomedes-wt/phone-relay-messages` |
| Code | `services/control-plane/src/relay/protocol.ts` is the wire contract. This page is its prose |
| Status | Built and tested against the faux cloud over loopback. Not yet run on Cloudflare. No phone app speaks steps 3 and 4 yet |

The desktop never listens. The phone and the desktop both dial **out** to the account service. Each business has one relay hub: a Durable Object named by organization id (`RELAY_HUB`, class `RelayHub`). In the faux cloud it's an in-process hub on the same RFC 6455 wire. There's no tunnel, no open port and no path to the desktop's loopback API.

## Endpoints

Every call carries the person's bearer (`Authorization: Bearer <access token>`). Every refusal is `{ "error": "<one sentence>", "code": "<code>" }`. No answer carries a key, public or private.

| Method and path | Who | Answer |
|---|---|---|
| `POST /relay/v1/organizations/:id/devices` `{ publicKey, label }` | Active Business owner or Manager. The plan must include phone access. At most 50 live devices | `201 { deviceId, organizationId, label, createdAt }`. `publicKey` is the raw 32-byte Ed25519 key in base64url (43 characters). `label` is 1 to 60 characters with no control characters |
| `GET /relay/v1/organizations/:id/devices` | Any active member. The plan must include phone access | `{ organizationId, devices: [{ deviceId, label, online, lastSeenAt, createdAt, mine, canRevoke }], checkedAt }` |
| `DELETE /relay/v1/organizations/:id/devices/:deviceId` | The person who registered it, or the Business owner. **No plan is needed**, because stopping only takes access away | `204`. The record becomes a tombstone (`revoked_at`), is never deleted and can never connect again. The hub closes the live socket at once with `4410` |
| `GET /relay/v1/organizations/:id/presence` | Any active member (the phone's read). The plan must include phone access | `{ organizationId, devices: [{ deviceId, label, online, lastSeenAt }], checkedAt }` |
| `GET /relay/v1/organizations/:id/desktop` with `Upgrade: websocket` and `Nectovia-Relay-Device: <deviceId>` | The person who registered the device | The desktop's socket (below) |
| The same `GET` without `Upgrade` | The same person | The same checks, answered in JSON: `{ organizationId, deviceId, authorizedUntil }` or the refusal. A WebSocket client never sees why an upgrade was refused, so the desktop asks this way after a failed dial |

The device record (migration `007_relay_devices.sql`) holds the device id, the business, the person who turned it on, the public key, the label, `created_at`, `revoked_at`, `revoked_by` and `last_seen_at`. The private key stays sealed on the desktop by its SecretBox (DPAPI or Keychain), the same protected storage as a kept sign-in.

## Handshake

1. **The front checks.** The Worker verifies the bearer, then under one transaction confirms five things. The device is registered, not revoked and was registered by this person. The person is an active member. Their role is owner or Manager. The plan includes phone access. Their sign-in isn't revoked. It then hands the hub a grant of ids only (business, tenant, device, person, public key, issuer, session id and `authorizedUntil`), never the bearer.
2. **Challenge.** Hub to desktop: `{ "v":1, "type":"challenge", "organizationId", "deviceId", "nonce", "expiresInMs":10000 }`. The nonce is 32 random bytes in base64url.
3. **Proof.** The desktop signs only a challenge that names its own business and device. It answers `{ "v":1, "type":"prove", "signature" }`. The signature is Ed25519 over the UTF-8 bytes of `nectovia-relay/1\ndesktop-challenge\n<organizationId>\n<deviceId>\n<nonce>`, in base64url (86 characters). The first two lines keep a relay signature from reading as anything else.
4. **Ready.** Hub to desktop: `{ "v":1, "type":"ready", "deviceId", "heartbeatMs":20000, "timeoutMs":60000, "authorizedUntil" }`.

Each challenge takes one answer. The nonce is cleared before the signature is checked. While a socket is challenged, anything but one valid `prove` closes it with `4400`. A second proof, or a frame that isn't JSON from the closed set, also closes it with `4400`. A proof that doesn't verify closes it with `4401 bad_signature`, and so does a proof replayed from another connection, whose nonce differs. A proof that arrives after 10 seconds closes it with `4002`.

## Envelope

Every message is one JSON text frame, `{ "v": 1, "type": "<name>", ... }`, strictly shaped and at most 4,096 bytes. Version 1's closed set:

| Direction | Types |
|---|---|
| hub to desktop | `challenge`, `ready`, `pong` |
| desktop to hub | `prove`, `ping` |

After `ready`, the hub drops frames outside the set, and the desktop ignores types it doesn't know. The hub logs ids, events and close codes only, never a frame's content.

## Heartbeats and timings

| What | Value |
|---|---|
| Challenge must be answered within | 10 s |
| Desktop pings every | 20 s, exactly `{"v":1,"type":"ping"}` |
| Hub answers | exactly `{"v":1,"type":"pong"}`. On Cloudflare the runtime's auto-response answers without waking the object, and those answers count as heard |
| Hub closes a silent ready socket after | 60 s (`4001`) |
| Desktop gives up on a silent hub after | more than 60 s without any frame, checked at each ping, then dials again |
| Hub rechecks device, member, role, plan and sign-in, by id | every 20 s, retried after 5 s if the check can't run |
| Longest a socket lives past its last passing check | 30 s (`4003`) |
| Hub writes `last_seen_at` | at ready, every 5 minutes and at close |
| Hub closes at the bearer's `authorizedUntil` | `4000` |
| Desktop renews | at `authorizedUntil − 30 s` (at least 15 s after ready): a second socket proves the same key and the hub replaces the first |
| Desktop dials again after a drop | 1, 2, 4 … s, at most 60 s, each within ±20 %. At once after `4000`. Backoff resets at `ready` |

## Close codes

`4000`–`4099` are transient: the desktop dials again. `4400`–`4499` stop the desktop, which then says why in one sentence.

| Code | Reason | Desktop |
|---|---|---|
| 4000 | `session_expired` | Dials again at once with a fresh bearer |
| 4001 | `heartbeat_timeout` | Backs off, then dials again |
| 4002 | `challenge_timeout` | Backs off, then dials again |
| 4003 | `recheck_unavailable` | Backs off, then dials again |
| 4400 | `protocol_error` | Stops |
| 4401 | `session_ended` | Stops. Signing in again resumes it |
| 4401 | `bad_signature` | Stops. Turning the setting off and on makes a new key |
| 4403 | `not_a_member`, `role_not_allowed`, `phone_relay_not_included` | Stops with that refusal's sentence. The next sign-in or refresh may dial again |
| 4409 | `replaced` | Expected during its own renewal. Otherwise another copy of Nectovia holds the key, and this one stops |
| 4410 | `device_revoked` | Stops and forgets its key. The setting shows it was stopped from another device |

**Replace, not refuse.** When a device proves its key again, the hub closes the older ready socket with `4409` and keeps the newer one. The private key never leaves one computer, so two proofs of one device are that computer: a restart, a changed network or a renewal. Refusing the newer socket would strand it behind a dead half-open one for up to 60 seconds, and would rule out renewing before the bearer expires. The hub holds one live socket per device.

**Stopping.** Turning the setting off, signing out, switching accounts or forgetting the account closes the socket, drops the key and deletes the device record. If the service can't be reached, the desktop keeps a tombstone without the key and deletes the record at its next chance. Without the key, the record can never connect. Stopping from another device closes the socket with `4410`. Nothing on the desktop is deleted: not its files, and not its history.

## Steps 3 and 4: messages after `ready`

Steps 3 and 4 add the phone's own socket and a closed set of messages after `ready`, in both directions. Everything above stays as it is: the endpoints, the handshake, `v: 1`, ping and pong, the close codes and the 4,096-byte cap. The hub drops a type it doesn't know and a desktop ignores one, so either side can ship first. A change that breaks the envelope would be `v: 2` on `/relay/v2`.

### The phone's socket

| Method and path | Who | Answer |
|---|---|---|
| `GET /relay/v1/organizations/:id/phone` with `Upgrade: websocket` | Any active member: owner, Manager or Employee. The plan must include phone access, and the sign-in mustn't be revoked | The phone's socket, open at once. A phone holds no key, so there's no challenge. The hub sends it nothing until a desktop does |
| The same `GET` without `Upgrade` | The same person | The same checks, answered in JSON: `{ organizationId, authorizedUntil }` or the refusal |

The front checks are presence's: the bearer, an active membership, the plan and a sign-in that isn't revoked. The hub gets a grant of ids only (business, tenant, person, issuer, session id and `authorizedUntil`), never the bearer. A phone pings and is answered exactly as a desktop is. Its socket closes after 60 s of silence (`4001`), at `authorizedUntil` (`4000`), 30 s past its last passing check (`4003`), or with the refusal's code when a recheck fails. A frame that arrives past one of those deadlines closes it with the same code before the hub passes anything on or answers a ping. The hub rechecks member, plan and sign-in every 20 s. A person keeps at most 5 phone sockets: a sixth closes the oldest with `4409`.

### What each side may send

| Direction | Type | Carries |
|---|---|---|
| desktop to phone | `work.rows` | A project's worker rows (`shared/work-rows.ts`): at most 8, each with a label, a title of at most 80 characters, a state, `startedAt`, its verification and who pays |
| | `board.counts` | The Board's column counts (at most 8 columns) and at most 10 cards a page, with `page` and `pages` |
| | `need.summary` | One open Need: the task's title, what (300 characters), why (300), the consequence (600), at most 10 file names, `expiresAt`, and `part` of `parts` (at most 100) |
| | `turn.update` | A conversation turn's text, at most 3,000 characters a frame, in order by `seq` |
| | `result` | The answer to one command: `accepted`, `refused`, `already-done` or `expired`, with `code` (at most 40 characters) and `message` (at most 200) |
| phone to desktop | `hello` | The phone is looking: send the picture |
| | `board.page` | One page of a project's Board |
| | `need.decision` | `go-ahead` or `declined` on one Need. There's no `allowForTask`, and a frame that carries one is refused |
| | `stop.request` | Stop a task, or one run of it |
| | `message.send` | A person's message of 1 to 2,000 characters, to Home, a project's conversation or a Team member |
| | `member.wake` | Wake a Team member to read its waiting mail |

Every phone frame names its desktop by `deviceId`. A command carries a `commandId` of 8 to 64 characters from `A-Z a-z 0-9 _ -`, minted once by the phone. A conversation is `{ "kind": "home" }`, `{ "kind": "project", projectId }` or `{ "kind": "member", projectId, slotId }`. Every schema is strict: an unknown key, an unknown type, a string over its cap or a frame over 4,096 bytes is refused whole. A file is named by its last part, never by a path. A summary that doesn't fit one frame continues in the next part, field by field, and its consequence is never cut short. The phone joins the parts in order.

### The hub

- **Stamping.** The hub sets `from: { personId, sessionId }` on each phone frame from the phone's own verified sign-in, over anything the phone sent. A desktop reads a phone frame only with `from`.
- **Routing.** A phone's frame goes to the ready desktop it names, and only when the same person registered that desktop. A desktop's frame goes only to the live phones of the person who registered it.
- **Refusals.** A command the hub can't pass on is answered with a `result` whose `code` is `rate_limited`, `device_offline`, `not_your_device` or `too_large`. `too_large` means the stamped frame would pass 4,096 bytes, so a phone keeps 300 bytes of each frame free for the stamp. `hello` and `board.page` have no `commandId`, so the hub drops them instead.
- **Limits.** 30 frames a minute per person from phones, pings aside, and 120 frames a minute per desktop to phones. Over the limit, a phone's command is refused `rate_limited` and a desktop's frame is dropped.
- **Logging.** Ids, events, types and reasons only (`relay-phone-opened`, `relay-phone-closed`, `relay-frame-refused`), never a frame's content. Presence still counts desktops only.

### The desktop

Each registration of this computer answers its phones through `server/relay/messages.ts`, one handler per type, and nothing else. There's no generic path to an endpoint and no route to the loopback API.

- **Authority.** The person signed in on this computer now. A command whose `from.personId` is anyone else is refused `not_signed_in_person`, and `phone_relay_not_included` when the plan leaves phone access out. A `hello` or `board.page` from them gets no answer. A phone reaches only the projects of the registration's business, and Home only once Home exists and is linked to that business. Anything else is `not_this_business`.
- **The desktop's own paths.** Each command runs the path the Console's own control runs, under the same Store lock, checked again as it acts. While an accepted update closes the app, each is refused `updating`.
  - `need.decision` takes the Need answer path, with the body the Console sends for that kind of Need and never `allowForTask`. It's recorded `decidedFrom: "phone"`, with a History entry (`phone-decision`: "You went ahead from your phone" or "You declined from your phone") attributed to `diomedes:phone-relay` and the person. A Need already answered is `already-done` with "Already answered on your computer".
  - `stop.request` takes Work control's Stop for the task. A run is a work session, or a RunService run that names one. It's `accepted` once the Stop is recorded, and the rows say `stop-requested` until the run ends.
  - `message.send` to Home or a project takes the conversation's own message path, with no documents and no `readAccess`. The phone's send stands for the Console's `consent: true`. To a Team member it takes the owner's mailbox path.
  - `member.wake` takes the Team wake path. It's refused `member_not_found`, `nothing_waiting`, or `names_documents` when the waiting mail names documents, which a person hands over on the computer. The wake hands over all of the waiting mail, so that mail is judged again inside the Store lock the wake takes, including mail that arrived in between.
  - A message or a wake the job cap would question first is refused `cap_question`. A cap is raised on the computer.
- **The decision window.** A Need takes a phone's decision for 10 minutes from when its summary is queued. The window is kept per Need on the desktop and never trusted from the phone, and `expiresAt` in the summary is its end. A `hello` sends every open Need again and opens a fresh window. A redial or a renewal keeps the windows. After a restart none is open, so a decision is `expired` until the phone says hello.
- **Once per command.** Each answer is kept for 24 hours per desktop in `<data>/relay/commands.json`: ids and answers only, at most 1,000 per desktop. A repeated `commandId` gets the first answer and does nothing again, across a restart too. A refused command is final for its id, `updating` and `not_signed_in_person` included, so the phone mints a new id to try again.
- **Turns.** A `message.send` to a conversation is `accepted` once its turn starts, or once the desktop has its answer if that comes first. Then `turn.update` frames follow: `running` with no text at `seq` 0, then the saved answer from `seq` 1, the last frame saying `done`, `stopped` or `failed`. The answer goes once it's saved, never as it streams, because the live stream still carries the decision block and redactions that only the saved answer has settled. `turnId` is the phone's `commandId`, and the desktop's own command id is `phone.<commandId>`.
- **What it sends, and when.** After a `hello`: each business project's rows, the first Board page and every open Need. After that, only changes, and only while a phone has spoken in the last 5 minutes. At most one frame of a type goes per project each second, each built as it goes, and about 102 frames a minute in all, under the hub's 120. Answers (`result` and `turn.update`) go in order and are never replaced. Every frame is checked against the contract before it leaves, and one that fails is dropped and named by its type only.
- **Errors.** A refusal names a code and one fixed sentence. An error's own message never reaches the phone, because it may name a file.

### Never relayed

The payer switch, settings, routes, Trust, access profiles, files and the shell (owner decisions D9 and D10, and the relay plan's never-list). No frame names them and no handler reaches them. Frames carry titles, states, counts, file names and a turn's saved answer. A path in their text is cut to its last part, folder names with spaces included. Only a folder written without a root, like `notes/winter`, stays as written, and dates and links stay whole. They never carry a document's contents, an answer's reasoning, a mailbox message, a log line, a setting or an account. Phone access stays a paid feature.

### Worker rows

`shared/work-rows.ts` is the frozen shape. `server/relay/work-rows.ts` is a minimal, read-only source over the desktop's own records: first the workers of the newest H14 lead still running (from the handoff ledger and the RunService's runs), then running work sessions and Team members, newest first, then work that finished in the last 30 minutes. Who pays is read from the route alone: the Nectovia route is Nectovia credits, a provider route or oh-my-pi is your key, an engine on this computer is your subscription, and sample work is this computer. A richer source can replace it behind the same interface.

### Status

Built and tested against the faux cloud over loopback. `services/control-plane/tests/relay-phone.test.ts` covers the wire contract and the hub's routing, stamping, limits and rechecks. `tests/phone-relay-messages.test.ts` covers the desktop's frames, outbound gate, command memory, worker rows and handlers. `tests/phone-relay-desktop.test.ts` decides one Need end to end, from a phone's socket through the desktop's Need answer path. That sample Need's decision is the only path proven end to end against the desktop's real ports. The other Need kinds' answer bodies, Stop, the conversation's message path, the Team mailbox and the Team wake ran against stand-in ports only. Not run on Cloudflare. No phone app speaks it yet. Push notifications, end-to-end encryption and the Personal hub are later work.
