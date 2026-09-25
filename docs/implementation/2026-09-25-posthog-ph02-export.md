# PostHog PH-02: export built, switched off, proven offline

Work order PH-02, on top of PH-01 (`2026-09-25-posthog-ph01-observation.md`). Branch
`feature/posthog-observation`. Everything here was proven against a fake network. No request
reached PostHog, no capture key exists anywhere but a test fixture, and no account was touched.

## What it adds

- **Transport** (`server/observability/posthog-transport.ts`).
  - One POST of one batch to `${host}/batch/` on the operator's https origin, with redirects
    refused.
  - `api_key` is added at send and nowhere else: the queue, the memory sink and `health()` never
    hold it. The body is byte-equal to `JSON.stringify({ api_key, batch })`.
  - Answers are classified from status and `Retry-After` only; the body is never read:

    | Answer | Classified as |
    |---|---|
    | 2xx | ok |
    | 429 | `http-429` |
    | 5xx | `http-5xx` |
    | other 4xx | `http-4xx` |
    | thrown | `network` |
    | aborted | `timeout` |

- **Exporter, for a paid sink.** These limits are enforced on a virtual clock in tests:
  - A failed batch is held and sent again before anything newer, three sends at most, with
    backoff `min(30 s, 1 s·2^(n−1))·U[0.5,1]`.
  - `Retry-After` is honoured up to 60 s; a longer one drops the batch as
    `retry-after-too-long`.
  - Any other 4xx drops the batch as `rejected`.
  - Three failed sends in a row pause export for five minutes. The queue stays capped meanwhile.
  - A waiting retry is rechecked, so a scope that ended is dropped, not resent.
- **Gate.** Funding and the daily budget are checked at enqueue and at flush.
  - **Funding.** `fundedUntil` null, malformed or past means `disabled:funding`: the queue is
    cleared and nothing is kept for later. Funding lasts through the end of its last UTC day.
  - **Budget.** `dailyEvents` is counted at first send per UTC day. Zero, the default, means
    `disabled:budget` and everything drops as `budget`.
- **Runtime.**
  - `posthog` mode constructs the transport only when the operator's host and capture key parse;
    otherwise it constructs nothing.
  - The gate comes from `NECTOVIA_OBSERVATION_FUNDED_UNTIL` and
    `NECTOVIA_OBSERVATION_DAILY_EVENTS`.
  - `memory` mode never uses the network.
- **Late cost.**
  - `SpendExposure.onResolved` is one optional listener, told with a copy when an open hold
    settles, is reconciled or is written off. It fires after the write, on a later turn
    (`setImmediate`), outside the ledger's queue and the caller's settle.
  - The projector remembers each byo generation sent while its hold was pending or uncertain.
    When that hold resolves, it emits exactly one `nectovia_cost_reconciled`, joined on the
    generation's span id. That event carries `reconciledFrom` and integer micro-USD. It is never a
    second `$ai_generation`.
  - A write-off counts the hold's ceiling. Managed generations are never registered: their cost
    is the gateway's.
- **Vendor record.** `services/control-plane/contract/vendors.ts` gets:
  - a new `VendorRole` `'observability'`;
  - a `posthog` entry: selected, `monthlyFixedMicroUsd: 0`, `accountState: 'unverified'`;
  - the free allowance and overage terms, with dated sources in PostHog's own docs repository.

  Award amounts and expiry stay in private operator configuration. The edit is one role literal
  and one entry.

## Tests

The run was under slot `slot_muhjmeqo_6db660b8`, since released.

```
npx vitest run tests/observability-eligibility.test.ts tests/observability-record.test.ts tests/observability-exporter.test.ts tests/observability-posthog-transport.test.ts tests/observability-runtime.test.ts tests/observability-first-trace.test.ts tests/spend-exposure.test.ts tests/b00-control-plane-contract.test.ts tests/b00-h01-repair.test.ts --maxWorkers=2
  9 files, 164 tests passed
```

Of these, 79 are in the six observability files:

| File | Tests |
|---|---|
| eligibility | 14 |
| record | 22 |
| exporter | 11 |
| posthog-transport | 12 |
| runtime | 11 |
| first-trace | 9 |

Before this clean run, two fixture bugs in the transport file were fixed:
- a 204 `Response` built with a body;
- a clock advanced past the one-hour queue age before a flush.

`npx tsc --noEmit` is clean.

`tests/observability-first-trace.test.ts` goes through the real `createApp`, the real transport and
a fake PostHog network.

**Export switched off (the headline).** In each case the fake network is never called:
- the default daily budget of zero;
- no funding date;
- ended funding;
- a business that is not internal;
- observation unset with the environment unset;
- observation null;
- `posthog` mode with no well-formed host and key;
- `memory` mode with a PostHog configuration present.

**Positive.** Export is funded and within budget. The internal owner's turn leaves as `/batch/`
POSTs whose bodies are exactly `api_key` then `batch`. The generation and trace are linked, carry
settled cost, and have `$process_person_profile: false` and `$geoip_disable: true`. None of these
appears in any body:
- the prompt;
- the provider answer;
- the email;
- the business name or id;
- the AWS account id.

## Not done offline

- **Live ingestion.** No PostHog project, capture key or network call, so PostHog's acceptance of
  these bodies, deduplication by `uuid`, trace assembly and pricing behaviour are not observed.
- **Credit and benefit.** Nothing was verified; `accountState` stays `unverified`.
- **Managed cost.** The managed gateway's attempt read (`GET /managed/v1/attempts/:id`) is not
  built, so a `nectovia` generation stays `gateway-pending`, with no late-cost event.
- **Managed route kind.** Every admission is `byo` until the managed lane passes
  `routeKind: 'managed'` at its `admitModelApi` call sites.
