# Connections reference research

Checked against official documentation on 2026-09-09. These are documentation
findings, not evidence of an authenticated Toast account or production delivery.
All executable source/model/credential behavior in this branch is synthetic.

## Toast data and access

| Finding                                                                                                                                                                    | Consequence for this proof                                                                                                                       | Official source                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stock concerns menu items and modifiers, not a restaurant's ingredient ledger.                                                                                             | Call the capability menu availability; never infer physical ingredient inventory.                                                                | [Stock API overview](https://doc.toasttab.com/doc/devguide/apiStock.html)                                                                                                        |
| Bulk GET lists QUANTITY and OUT_OF_STOCK items and omits IN_STOCK items. Selected-item POST is a read.                                                                     | Model effects independently of HTTP method; use the selected-item read contract and label coverage selected-items.                               | [Bulk inventory](https://doc.toasttab.com/openapi/stock/operation/getInventory/), [Inventory search](https://doc.toasttab.com/openapi/stock/operation/postInventorySearch/)      |
| IN_STOCK does not provide a tracked numeric count. QUANTITY provides the count; missing or malformed QUANTITY is invalid. Item GUID validity matters.                      | Preserve null with a quantity-state reason; unknown never satisfies a numeric threshold. OUT_OF_STOCK does not justify inventing a numeric zero. | [Using the Stock API](https://doc.toasttab.com/doc/devguide/apiUsingTheStockApi.html)                                                                                            |
| A restaurant is addressed individually with Toast-Restaurant-External-ID; multiLocationId plus restaurant is the recommended cross-location identity.                      | Bind exactly the three synthetic restaurants. Key observations by connection, restaurant and item identity.                                      | [Using the Stock API](https://doc.toasttab.com/doc/devguide/apiUsingTheStockApi.html), [Search operation](https://doc.toasttab.com/openapi/stock/operation/postInventorySearch/) |
| Authentication uses client credentials and a returned expiring bearer token. The login body uses clientId, clientSecret and TOAST_MACHINE_CLIENT.                          | Future broker-managed token acquisition must use returned expiry; do not invent a refresh-token flow. No such token is acquired here.            | [Authentication](https://doc.toasttab.com/doc/devguide/authentication.html)                                                                                                      |
| stock:read and stock:write are separate scopes.                                                                                                                            | Only stock:read is admitted. A read grant cannot authorize ordering or stock changes.                                                            | [API scopes](https://doc.toasttab.com/doc/devguide/apiScopes.html)                                                                                                               |
| Standard API credentials are read only and scoped to approved locations. Access requires an eligible employee, Manage Integrations permission and RMS Essentials or above. | Verify each pilot's account eligibility and location grant before adding a real transport.                                                       | [Standard API guide](https://doc.toasttab.com/doc/devguide/devApiAccessUserGuide.html), [Requirements](https://doc.toasttab.com/doc/devguide/devApiAccessRequirements.html)      |
| Current standard API access supports self-managed stock webhook subscriptions when its documented credential, location and plan prerequisites are satisfied.               | Do not incorrectly assume that all stock subscriptions require partner status or a support-created subscription.                                 | [Standard webhook subscriptions](https://doc.toasttab.com/doc/devguide/devApiAccessWebhookSubscriptions.html)                                                                    |
| Sandbox access differs by integration type. Standard and analytics credentials are production-only; partner/custom integration paths can have assigned sandbox access.     | There is no fake production sandbox in this proof. The word fixture is used throughout.                                                          | [API environments](https://doc.toasttab.com/doc/devguide/apiEnvironments.html), [Integration types](https://doc.toasttab.com/doc/devguide/apiIntegrationTypes.html)              |

## Toast event and transport behavior

| Finding                                                                                                                                          | Implemented or deferred consequence                                                                                                                                                                                          | Official source                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stock events include in_stock, out_of_stock and low_quantity; Toast's low_quantity threshold is five and is not configurable.                    | Validate event/status consistency. A business rule's threshold is a separate condition evaluated on a reported quantity.                                                                                                     | [Stock webhook](https://doc.toasttab.com/doc/devguide/apiStockWebhook.html)                                                                                |
| The message envelope supplies timestamp, eventCategory, eventType, guid and details.                                                             | Validate the signed envelope before durable ingress; deduplicate using its guid within a connection.                                                                                                                         | [Message schema](https://doc.toasttab.com/doc/devguide/apiMessageDataSchema.html)                                                                          |
| Toast-Signature is Base64 HMAC-SHA256 over raw request body concatenated with its timestamp, using the subscription/environment secret.          | Verify exact UTF-8 body bytes and compare signatures in constant time. Timestamp comes from the signed body. Secret stays in a closure behind a verify-only interface.                                                       | [Message signing](https://doc.toasttab.com/doc/devguide/apiMessageSigning.html), [HTTP headers](https://doc.toasttab.com/doc/devguide/apiHttpHeaders.html) |
| A receiver must acknowledge promptly; connection/socket timeouts are two seconds.                                                                | Persist the small inbox record, return 202, then run triage. The measured local response is not a production SLA.                                                                                                            | [Timeouts](https://doc.toasttab.com/doc/devguide/apiTimeouts.html)                                                                                         |
| Documented stock/general retries cover timeouts, 404, 429 and 5xx: five minutes, then ten more minutes. Other 4xx and redirects are not retried. | Keep durable identity receipts; this receiver permits a conservative 30-minute timestamp window, but refuses to act on observations older than its five-minute freshness limit. Reconciliation is required after that limit. | [Retry support](https://doc.toasttab.com/doc/devguide/apiRetrySupport.html)                                                                                |
| Production delivery requires a public HTTPS endpoint, supported TLS/HTTP behavior and no redirect dependency.                                    | The loopback HTTP demo is unsuitable for Toast delivery. A customer-hosted HTTPS receiver or narrowly managed relay remains future work.                                                                                     | [Endpoint requirements](https://doc.toasttab.com/doc/devguide/apiEndpointRequirements.html)                                                                |
| Rate limiting returns 429 and timing headers including Retry-After or X-Toast-RateLimit-Reset.                                                   | A future HTTP adapter must implement bounded backoff from actual headers. The manifest describes this requirement; the fixture does not pretend to implement a provider rate limiter.                                        | [Rate limiting](https://doc.toasttab.com/doc/devguide/apiRateLimiting.html)                                                                                |

No full-inventory completeness claim is made from selected-item reads. Webhooks
alone cannot prove current complete state after offline time, missed delivery or
subscription changes. Full selected-scope refresh and a verified menu identity
mapping are prerequisites for a real pilot. The oldest approved location refresh
determines group freshness; refreshing one location must not hide the others.

## MCP, OpenAPI and reuse decision

The official [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
describes input/output schemas and tool metadata. Tool annotations are untrusted
hints rather than authorization. Diomedes already depends on the TypeScript MCP
SDK; its existing team endpoint is protocol plumbing and does not grant a business
connection permission. The new consumer therefore registers reviewed typed tools
inside the existing Runtime and independently checks resource/effect authority.

The current [OpenAPI specification](https://spec.openapis.org/oas/latest.html)
is 3.2.0. A small handwritten projection of the official
[Petstore example](https://github.com/OAI/OpenAPI-Specification/blob/main/_archive_/schemas/v3.0/pass/petstore.yaml)
demonstrates declarative generation. Only an explicitly selected GET with an
inline supported JSON schema and query parameters becomes a candidate. All refs,
security/server declarations, bodies, callbacks, inherited parameters, path
templates, writes and unsupported schema features require separate review.
No spec is fetched by the generator, no code is generated or launched, and the
documentation URL is never promoted to an approved execution destination.

[FastMCP's OpenAPI integration](https://gofastmcp.com/integrations/openapi)
provides automatic route generation and curation. Its current
[license](https://raw.githubusercontent.com/PrefectHQ/fastmcp/main/LICENSE)
is Apache-2.0. It is a separate Python framework and is not added to this existing
TypeScript application. No third-party implementation or SDK is copied. The
candidate keeps source licensing explicitly unreviewed before activation; the
sample's declared API license is not treated as a blanket redistribution grant.
This avoids a new runtime, dependencies and an executable supply-chain boundary
for a proof that needs only one curated read operation.

## Discovery and commercial progression

The intended discovery order is: a trusted Diomedes package; a vetted official
integration/MCP; a documented API with schema; a documented API without schema;
an authorized database/export/import; an authorized event feed; a separately
approved demonstration-to-automation workflow; or an explicit unsupported result.
Only the first fixture-registry step and offline schema-candidate step exist here.
No autonomous discovery, purchasing, account setup or browser workaround is built.

A pilot should progress through software/workflow identification, explicit scope,
fixture verification, live read verification, shadow evaluation, measured review
and activation. Reusable manifests/rules remain separate from customer connection
instances and broker-held credentials. Local execution has no mandatory hosting
cost; always-on delivery remains an explicit deployment choice.
