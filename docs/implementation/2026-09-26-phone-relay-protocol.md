# Phone relay protocol, version 1 (relay plan steps 1 and 2)

| | |
|---|---|
| Plan | `diomedes-ios/docs/RELAY_PLAN.md`, steps 1 and 2: device registration and revoke, the desktop's outbound client, presence |
| Feature | `phone-relay` (`PHONE_RELAY_FEATURE`); refused as `PHONE_RELAY_NOT_INCLUDED_REASON` |
| Branch | `feature/phone-relay`, worktree `F:/Diomedes/diomedes-wt/phone-relay` |
| Code | `services/control-plane/src/relay/protocol.ts` is the wire contract. This page is its prose |
| Status | Built and tested against the faux cloud over loopback. Not yet run on Cloudflare |

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

## How step 3 extends this

Step 3 adds message types **after `ready`** in both directions, such as a person's message to a named conversation, a turn's status, and Need summaries and decisions. Each type gets a strict schema in the closed sets of `protocol.ts`, a size cap and the relay plan's review. The endpoints, the handshake, `v: 1`, the ping and pong frames and the close codes stay as they are. A desktop that doesn't know a type ignores it, and the hub drops what it doesn't know, so either side can ship first. The phone's own connection to the hub is a new endpoint under `/relay/v1/organizations/:id/`. It uses the same envelope and needs no change to the desktop's handshake. A change that breaks the envelope would be `v: 2` on `/relay/v2`.
