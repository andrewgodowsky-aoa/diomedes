# DIO-95: authorization on the inventory command surface

Lane `inventory-auth`, branch `bugfix/inventory-command-authorization`, base `559a1ab`.

**What this is:** local-principal authorization. Every inventory command and read now resolves
the acting principal from the local server's own identity path. That means this launch's desktop
session token plus the installation's local person. The route then checks that the person is an
active member of the organization that owns the project, with the right access-profile permission,
and refuses anything that did not arrive over loopback.

**What this is not:** device identity. Nothing here pairs, authenticates or distinguishes a phone,
a tablet, a shared login or a second person on another machine. That is still MI01 (DIO-62) on top
of B02/B03. The local person is the workspace's `development-fixture` identity, the same subject
the rest of the local server attributes work to, and this change does not make it anything more.

## 1. Surface map

| Surface | Reaches `server/inventory/*` | Gates before this change |
| --- | --- | --- |
| `server/app.ts` (desktop/local service) | **No.** Nothing in `server/` or `desktop/` imports the inventory routes or stock service. | Global gate: `Host` must be `127.0.0.1:<port>`, `Origin` must be allowlisted, the per-launch `X-Diomedes-Session` token when the desktop passes one, and `X-Diomedes-Client: 1` on mutations. Listeners: `server/index.ts` and `desktop/main.mjs` bind `127.0.0.1` only. The global gate checks the `Host` *header*, not the socket address. |
| `server/inventory/receipt-routes.ts` (`inventoryReceiptRoutes`) | `GET /view`, `GET /operations/:id`, `POST /receipts` → `InventoryStockService.view/status/execute` | None of its own. The composer's `claim(request)` was passed through, and the authorizer decided. |
| `scripts/inventory-receipts-demo.ts` | Mounts the routes at `/api/inventory` with the **test** authorizer from `tests/fixtures/inventory-receipts.ts`. | Socket must be loopback, `Host` exactly the listener authority, same-origin, `X-Diomedes-Inventory: 1`. The access is fixed to `demo-person`. A header can only reduce it. The script labels itself `simulated-test-authorizer`. It is used by `tests/inventory-receipt-ui.spec.ts`. |
| `InventoryStockService` (`server/inventory/stock-service.ts`) | The authority for stock effects | Calls the injected authorizer at admission, immediately before the effect, and for every read, and compares principal/scope/generation between them. **No production authorizer existed.** The only one in the tree, the fixture double, ignores the caller entirely. |
| Mobile/LAN listener | None exists. `docs/architecture/mobile-inventory-boundary.md` (MI00) keeps the desktop on loopback and gates any shared or device access on B01–B03 and MI01. | — |
| Feature gate | None. The Console has no inventory view. `inventory.html` is a separate build entry that only the demo serves. | — |

So the finding's risk was real but latent. The stock service and receipts are merged. Any
composition had to supply its own authorizer, and the only one available authorized every caller.
The routes also had no ingress guard of their own, so a mount on a wider listener would have taken
LAN requests.

## 2. Reproduction (pre-fix tree `559a1ab`)

A scratch vitest file mounted `inventoryReceiptRoutes` with the only authorizer in the tree. It
listened on `0.0.0.0` and sent a receive command:

```
(a) no identity:       200 {"status":"applied","receipt":{... "actorPersonId":"demo-person" ...}}
(b) other project:     403 {"status":"denied","reason":"Current authority does not match this inventory tenant and project."}
(b2) service, other:   {"status":"denied","reason":"Current authority does not match this inventory tenant and project."}
(c) from 192.0.2.2:    200 {"status":"applied", ...}
```

- (a): a request carrying no identity at all wrote stock, attributed to a fixed person.
- (b): a scope check existed, but it compared the fixture's own scope. The refusal was a 403 that
  differs from a missing project, and no membership was ever consulted.
- (c): the route took a request from the machine's non-loopback address.

## 3. Fix

- **`server/inventory/local-access.ts`** (new): `createLocalInventoryAccess({ workspaces, sessionToken })`
  returns `claim` and `authorize`.
  - `inventoryIngressRefusal` is the explicit MI01 guard. It refuses unless the socket's remote and
    local addresses are loopback, `Host` is `127.0.0.1:<port>` or `[::1]:<port>`, and no
    `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` header is present.
    - Code: `inventory_loopback_only` (403).
  - `claim(request, need)` runs the ingress guard, then the session token (constant-time compare,
    the same `X-Diomedes-Session` credential the global gate uses), then the local person, then the
    owning organization. The owner is the project's single active access resource. Membership comes
    from `WorkspaceService.assertMine`.
    - It then checks the permissions `need` requires and mints an opaque claim that only this
      closure recognises.
    - Codes: `inventory_unauthenticated` (401), `inventory_not_found` (404, `Inventory is unavailable.`)
      and `inventory_forbidden` (403).
    - A project that does not exist, one owned by another tenant, one owned by nobody or by more than
      one organization, and one whose membership was revoked all get the identical 404 body. This
      matches the workspace `mine()` rule.
  - `authorize` is the stock service's authorizer. It refuses any claim it did not mint (401). It
    re-reads current person, owner, membership and permissions at every phase. It builds the
    `InventoryStockAuthorization`:
    - The actor is the resolved local person. It is never a request field, and the command schema
      already rejects actor or tenant fields.
    - The principal is `kind: 'local-owner'`, `assurance: 'loopback'`, `synthetic: false`, with no
      device and no session.
    - Capabilities: only `project.read` if `inventory:view` is granted, and `write.apply` only if a
      stock command permission is granted.
    - The generation is the workspace's organization and principal access generations. They advance
      on membership revocation and on every profile or assignment change, so the service's
      effect-time comparison refuses a write whose access changed after admission.
  - There is no unauthenticated mode: construction throws without a 64-hex session token.
- **Permission mapping** (proposed default, see §6), using the existing access-profile catalogue:

  | Action | Permission |
  | --- | --- |
  | view, operation status | `inventory:view` |
  | receive, use, transfer | `inventory:record` |
  | adjust | `inventory:adjust` |
  | record-count | `inventory:count` |
  | correction | adds `inventory:adjust` |

  The system Owner profile holds all of them.
- **Tenant label** (proposed default). Inventory scope IDs admit no `:`, but a local
  organization's tenant is `org:<organization id>`. `inventoryTenantId` maps exactly that local form
  to `org.<organization id>`. The mapping is one-to-one because organization IDs never contain `.`.
  Any other non-conforming tenant is unsupported and reads as unavailable, never guessed. The
  organization ID is checked on its own, so the label never stands in for membership.
- **`server/inventory/receipt-routes.ts`**:
  - The ingress guard is the first middleware on every request, whatever the composer supplies.
  - `claim` now receives what the route is about to do (`read`, or the parsed `command`), and it may
    be async or throw.
  - The error envelope carries `code` when the refusal has one.
- **`server/workspaces.ts`** gains two small public methods that reuse existing state:
  - `projectOwner(projectId)` reads the project's single active access resource.
  - `accessDecision(organizationId, permission, resourceId)` runs `authorizeBusinessAccess` with
    current generations. It uses `mine()`, so a non-member gets the same 404.
- **Receipts attribute truthfully** (decision 8): `actorPersonId` and the History sentence name the
  resolved local person. The test asserts both, plus the exact scope.
- **Unchanged:**
  - `server/app.ts`. Inventory stays unmounted, because mounting it would ship a product surface,
    and that decision belongs to Andrew.
  - `shared/inventory.ts` (the MI00 contract).
  - The client, and the demo. The demo keeps its labelled test authorizer but now also passes
    through the route's ingress guard.

## 4. Tests

`tests/inventory-command-authorization.test.ts` sets up a real `Store` and a real `WorkspaceService`
with three businesses on one install:
- the local person's own, created and bound through the ordinary flow;
- another tenant's, which the local person is not in;
- one where the local person is an ordinary member with a view-only profile.

| Case | Result now |
| --- | --- |
| Owner reads, receives, checks status, replays | 200 `applied`/`already-applied`. Actor, scope and History sentence match the local person. |
| (a) No, wrong or malformed session token on POST, view and status | 401 `inventory_unauthenticated`. Stock file and History unchanged. |
| (a) Actor named in the body | 422 (schema). |
| (a) A claim-shaped object the host did not mint, sent to `execute`, `view` or `status` | Denied or 401, no effect. |
| (b) Another tenant's project via POST, view and status | 404 `inventory_not_found`, byte-identical to a project that does not exist. |
| (b) Own-project claim pointed at the other project through the service | Denied `Inventory is unavailable.` Nothing written. |
| Member without `inventory:record` | View has `canReceive: false`. POST gets 403 `inventory_forbidden`. A stale claim is still refused by the service. |
| Access profile created between admission and effect | Refused: `Inventory authority changed before the stock effect…`. Nothing written. |
| (c) Guard, unit level: non-loopback remote or local address, non-loopback or `localhost` Host, `Forwarded`/`X-Forwarded-For` | 403 `inventory_loopback_only`. |
| (c) Real loopback socket with `X-Forwarded-For`, or with a LAN `Host` header | 403 `inventory_loopback_only`. |
| (c) Real listener on `0.0.0.0`, request from the machine's LAN address | 403 `inventory_loopback_only`, nothing written. Skipped only when the host has no non-internal IPv4 interface. |
| Composition boundary | No file in `server/` or `desktop/` imports the receipt test double. Any that mounts `inventoryReceiptRoutes` must also call `createLocalInventoryAccess`. |

The existing inventory and receipt suites pass unchanged, with no fixture or assertion edits. Their
compositions already listen on `127.0.0.1`.

## 5. What remains for MI01 (and neighbours)

- **Device identity.**
  - Pairing, a device key, per-device revocation, and a verified web session (B02) bridged to
    membership (B03).
  - Until then the guard refuses every non-loopback request, and the principal is the single local
    person.
- **A same-machine relay that strips forwarding headers** (a tunnel, `ssh -L`, a local reverse
  proxy) looks like loopback and is not detectable here. It still needs the per-launch session
  token, which only the desktop main process holds.
- **Mounting in the product.**
  - Before any Console/app mount: pass the desktop token into `createLocalInventoryAccess`, and put
    the header on the inventory client.
  - Also teach `InventoryReceiptClient.receive` that a 401/403/404 gate refusal happened before any
    effect. Today it would show such a refusal as "uncertain", which is safe but vague.
- **Stable codes on service-level denials.** A denial raised after admission, from the service's
  own `{status: 'denied', reason}` results, keeps the MI00 result shape without a `code`. Adding one
  is an MI00 contract change.
- **Tenant IDs.** Either widen the inventory ID grammar or adopt the tenant-label mapping in the
  MI00 contract. The architect owns that decision.
- **The demo** (`scripts/inventory-receipts-demo.ts`) still uses the labelled test authorizer. It is
  loopback-only and developer-run, and it is not shipped.

## 6. Proposed defaults recorded for Andrew

1. Command-to-permission mapping as in §3. Corrections additionally need `inventory:adjust`, and
   `inventory:approve` is not yet used.
2. Local tenant label `org:<id>` → `org.<id>` for inventory scopes. Anything else fails closed.
3. Inventory stays unmounted from `server/app.ts` until someone decides to ship an inventory
   surface.
4. The session token is mandatory for inventory, even in the standalone development browser
   service (`DIOMEDES_ALLOW_UNPROTECTED_BROWSER=1`). That service has no token, so it cannot serve
   inventory.

## Proposed canonical-doc patch

`docs/DIOMEDES_LIVE_ROADMAP.md`, in the section tracking security and trust fixes (or §1's
preservation notes if there is no such section), append:

> DIO-95 (2026-09-24): the inventory command surface now requires a local principal.
> - Every inventory read and command needs this launch's desktop session token and the local
>   person's active membership, plus the access-profile permission for the organization that owns
>   the project.
> - Another tenant's project reads as absent.
> - Non-loopback ingress is refused by an explicit guard until MI01.
>
> This is local-principal authorization, not device identity. MI01 (DIO-62) remains open for
> pairing and verified device/web identity. Inventory is still not mounted in the Console.
> Record: `docs/implementation/2026-09-24-inventory-auth.md`.

`docs/DIOMEDES_PROJECT_MEMORY.md`, glossary (if an inventory entry exists), append:

> **Local-principal inventory access**: the local person, authenticated by the per-launch desktop
> session over loopback, authorized by workspace membership and access profile for the project's
> organization. Distinct from device access (MI01).

No pillar text changes. `QUESTIONS.md`: none answered.

## PILLAR IMPACT

- **Trust / scoped authority** is advanced. The inventory permission comes only from membership
  and an assigned access profile, and is re-read at the effect. No grant is widened; the capability
  set is narrowed to exactly `project.read`/`write.apply`.
- **Truthful attribution** (decision 8) is held. The receipt actor is the resolved person.
- **Say nothing is shipped that is not** (decision 13) is held. The doc and code say
  local-principal, not device; no surface is mounted.
- No conflict found.

## ROADMAP IMPACT

- DIO-95 is closable as "local-principal authorization in place, loopback-only".
- MI01 / DIO-62 is unchanged (not started). This pulls forward only its authorization check.

## BUILD STATUS

- Branch `bugfix/inventory-command-authorization`, pushed. Not merged, not packaged, not
  published.
- Gates, run on Linux on this branch after merging `origin/main` (already up to date at `559a1ab`):
  - `npx tsc --noEmit`: clean.
  - vitest: 346 files passed and 1 skipped; 6092 tests passed and 16 skipped, 0 failed. The main
    baseline is 6082/16/0; the 10 new tests account for the difference.
  - `npx vite build`: succeeded.
  - Playwright `ui`, `native-ui` and `field` specs: 36 passed.
  - `playwright.inventory.config.ts` (the receipt demo through the guarded router): 30 passed.
- The new LAN-socket test ran here; it skips only on a host with no non-internal IPv4.
