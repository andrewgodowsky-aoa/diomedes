# Customer developer API

Implementation candidate, 2026-10-07. These routes remain unavailable until the
account service enables `DEVELOPER_API_ENABLED=1` and migration 021 is applied.
Creating a key is independent of buying a plan. Calls still require paid access
or eligible Personal bought credits, a published route, accepted privacy
preferences, and available credit under the existing spending limits.

Base: `https://accounts.diomedes.net/developer/v1`. Server applications only.
Keep the `ndk_` key in a secret manager. The application stores its SHA-256 hash,
returns plaintext once, and checks expiry, revocation, original identity mapping
and current Business owner/Manager membership on every authentication. Account
Center keys expire in 90 days. They cannot administer billing, accounts or staff.

Every request sends `Authorization: Bearer <key>` and exactly one scope:

| Scope | Headers |
| --- | --- |
| Personal | `X-Nectovia-Scope-Kind: individual`, `X-Nectovia-Account: <scope id>` |
| Business | `X-Nectovia-Scope-Kind: organization`, `X-Nectovia-Organization: <organization id>` |

Use the scope returned with the key, never an organization name. No credentials
or other parameters belong in the query string. Browser Origin/Fetch Metadata
requests are refused; browsers use Account Center's protected cookie session.

1. `GET /routing`: read the current `nectovia-managed/2` snapshot. Stop if the
   selected tier is null. Resolve setup in the app before retrying.
2. `POST /admissions` with JSON
   `{"surface":"work","routeKind":"managed","rootJobId":"your-unique-job-id"}`.
   Continue only when `decision.admitted` is true and before `validUntil`.
3. `POST /responses`: use a fresh attempt id per new provider call, the same job
   id, the admitted account, and the headers below. The result is a Responses
   event stream. This is an explicit Nectovia contract, not an unmodified OpenAI
   client endpoint. `POST /evaluations` shares the existing typed evaluation
   contract and the same paid metering requirement.

| Additional response header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Nectovia-Protocol` | `nectovia-managed/2` |
| `X-Nectovia-Admission` | admission response `admissionId` |
| `X-Nectovia-Job` | the admitted `rootJobId` |
| `X-Nectovia-Attempt` | unique attempt id, up to 128 letters/digits/`._:-` |
| `X-Nectovia-Tier` | `efficient`, `focused`, or `thorough` |
| `X-Nectovia-Usage-Class` | `metered-work` (required for every developer call) |
| `X-Nectovia-Policy-Revision` | routing snapshot `revision` |
| `X-Nectovia-Global-Revision` | snapshot `globalRevision` |
| `X-Nectovia-Scope-Revision` | snapshot `scopeRevision` |
| `X-Nectovia-Preference-Revision` | snapshot `preferenceRevision` |
| `X-Nectovia-Route-Revision` | selected tier `entryRevision` |

Example response body, with `model` taken from the selected routing tier:

```json
{"model":"MODEL_FROM_ROUTING","input":[{"role":"user","content":[{"type":"input_text","text":"Summarize this order."}]}],"max_output_tokens":300,"stream":true,"store":false}
```

No provider key or endpoint is accepted from the caller. The gateway reserves
credits before dispatch, settles confirmed usage, and preserves uncertain holds.
Read the existing managed gateway implementation and tests for supported input
items, tools and evaluations. A repeated attempt is not permission to send again.
After a disconnect, read `GET /attempts/<attempt-id>` with the same key and scope
headers. It returns the existing attempt's state, held credits and confirmed
debit without dispatching work. Do not blindly retry while its charge is pending
or uncertain.

401 means replace or reauthenticate the key; 402 means credits/spending controls
need attention; 403 means access is unavailable; 409 requires fresh routing or
admission and review of any prior charge; 422 means an invalid request; 503 means
setup or the provider is unavailable. A new key never bypasses any of these.
