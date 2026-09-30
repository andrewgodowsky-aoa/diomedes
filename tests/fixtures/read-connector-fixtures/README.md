# Read connector fixtures

All records are synthetic. Each invocation of `server.mjs` is an independent
local MCP server for one data kind in `data.json`. It uses JSON-RPC over stdio
and makes no network requests. Nothing in this folder is a customer connector.

The launch arguments are the data kind, an absolute JSONL receipt-file path,
and an optional literal argument used by the Windows launch tests. The host
configuration uses an absolute Node executable plus `server.mjs` and those
arguments. `helpers.ts` builds that configuration without environment secrets.

| Kind | Read tool | Synthetic records |
| --- | --- | --- |
| read-sales | daily_sales | Daily sales and refunds |
| read-accounting | outstanding_invoices | An unpaid supplier invoice |
| read-bank | account_snapshot | An operating balance and transaction |
| read-payroll | approved_timesheets | Approved hours for one employee |
| read-inventory | stock_levels | A stock count below its reorder level |
| read-reviews | latest_reviews | A customer review |
| read-leads | open_enquiries | An unanswered catering enquiry |

Discovery also advertises `read_private_notes` and `replace_record`. Neither is
approved by the test's owner configuration. If called, both return an unmistakable
sentinel and record the call; they do not change business data. This makes a host
scope-guard failure observable. A `readOnlyHint` on the first tool confers no
authority.

The receipt records process starts, MCP requests and stdin closure. Tests assert
the actual payload, exactly which calls reached the child, and closure after
discovery and each completed turn. Cleanup removes only the test's own temporary
directory under `%TEMP%/astra-read-connector-fixtures/`.

The conversation tests use real HTTP routes, persisted approval, the model-session
driver, native loop and default MCP transport. Only model response bytes are
scripted. Tool discovery is an explicit MCP client operation after approval; the
product's Ask path uses the owner's exact configured tool list. The tests do not
claim that Ask automatically discovers or approves tools.

The Windows tests create identical owned `.cmd` shims in two locations: a
`node_modules/.bin` directory and an ordinary directory outside that layout.
Each location is exercised through its absolute path and extensionless PATH
lookup, covering cross-spawn's distinct escaping branches. All four cases use
the same literal metacharacter argument, exact received-argument comparison and
absent output marker. No installed package runner is invoked and no package is
fetched. A direct Node launch supplies a shell-free control on all platforms.
The four Windows cases are explicitly skipped on other platforms. All four
forms and the direct Node control passed on Windows in the run recorded below.

## Verified integration evidence: 2026-09-28

The coordinator's focused run passed all 13 cases, with no failures or skips.
That run used repaired test blob `cea1f96ef2044f9ef596651085a1ab4c1d4b8068`
on integration base `ab5c805c3718c68efdd91e3235114a868651ebfd`; the sole test
change was then committed as `978e104e4751a01635a2ef4bb2f16a0493932bb6`.
On that clean commit, root TypeScript passed and the six-file covering run
passed 86 cases, with no failures or skips. The 13 new cases are included in 86.

Evidence is in `F:/Temp/andre/astra-read-connectors-integration/20260928-1120/`
for the focused run and `20260928-1128/` under the same directory for the
committed source freeze, TypeScript and covering run.

A temporary test-local partial mock removed only `approvedMcpTool`'s exact tool
allowlist. The selected `read-sales` case passed before the edit, failed its
existing refusal assertion with both forbidden-tool markers, and passed after
restoration. Each phase executed one case and filtered seven others. The mock
changed no production file. Restoration matched integration's original SHA-256
`55A019B9ADE290443CF68B499133C550C72AE77C0A32E3C563B22C6549B28BBF` and the
Git blob above. Logs under the same evidence directory are named
`20260928-1135-scope-mutation-{baseline,red,restored}.log`.

The coordinator independently reviewed the scoped source and evidence and found
no concrete defect. These results bind the integration candidate above. Current
main composition, required merge gates and product acceptance remain separate.

## Coverage limits

Plan proves only an allowed read. Separate negative Plan cases are not authored.
Revocation removes the last connector between completed Ask turns; retaining a
second connector, changing only the tool allowlist and in-flight revocation are
not covered. The child does not record an environment canary, and its stdin-close
receipt is not independent proof of OS exit or process-tree cleanup. Stalled or
stubborn children are not exercised. The argument probe does not cover
environment-variable or delayed expansion. These fixtures do not establish
installed `npx` compatibility, universal Windows launcher safety, real vendor
compatibility or installed-desktop acceptance.
