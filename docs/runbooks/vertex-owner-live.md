# Owner-live proof: Gemini 3.8 Flash on Google Vertex AI

Who runs it: Andrew, on his own computer, with his own Google Cloud project.
Where from: the integrated app build that contains `feature/vertex-owner-setup`, with the
Google Vertex AI card mounted in AI setup.
Who pays: Andrew's Google Cloud project. This is not customer-managed inference and uses no
Nectovia credits. Customer launch is a separate gate (see
`docs/implementation/2026-09-23-vertex-customer-backend-design.md`).

Nothing in this runbook has been run by an agent. The owner runs every step that talks to
Google or spends money. Steps marked **APPROVAL** need Andrew's explicit go-ahead at that
moment.

## 0. Decisions (Andrew, 2026-09-23)

- **Project that pays:** `diomedes-dev`.
- **Credential:** a Vertex API key from `diomedes-dev`. The app keeps it in protected storage and
  sends it as the `x-goog-api-key` header to `diomedes-dev`'s own global endpoint. The gcloud
  sign-in (ADC) stays available as the alternative.
- **Spend limit:** $10 while testing (the same on OpenRouter, AWS Bedrock and Azure OpenAI). It is
  Nectovia's own estimate cap, not a Google budget.
- **Credits:** the app assumes none. It estimates every call at Google's standard rate ($1.50 /
  $0.15 cached / $7.50 per 1M tokens) and shows the introductory "50% credits back on net spend"
  separately, as unconfirmed; it is expected not to stack with Free Trial spend.

## 1. Project, billing and API

In the Google Cloud console, with project `diomedes-dev` selected:

1. Billing › confirm the project is linked to a billing account.
2. **APPROVAL: enable a paid API.** APIs & Services › Enable APIs › *Vertex AI API*
   (`aiplatform.googleapis.com`) › Enable.
3. Optional, recommended: Billing › Budgets & alerts, for example $10 with alerts at 50/90/100%.
   It alerts; it does not cap. The app's spend limit is the hard stop on this computer.

## 2. Create the API key

1. APIs & Services › Credentials › Create credentials › API key, in `diomedes-dev`.
   Google may offer to bind it to a service account; accept, and give that service account the
   *Vertex AI User* role on `diomedes-dev`.
2. Edit the key › API restrictions › *Restrict key* › Vertex AI API only.
3. Copy it once, straight into the app (next step). Do not paste it into chat, email, a file or a
   terminal.

Unverified until the first call: whether Google accepts this key type on the project endpoint.
If step 4.1 answers 401 or 403, the key needs the service-account binding above, and the call
costs nothing (Google bills only HTTP 200).

## 3. Connect in the app (no spend yet)

AI setup › Google Vertex AI:

1. Project id `diomedes-dev`; paste the key into *API key from this project*; tick *Bill this
   project, and no other…*; **Connect**. Nothing is sent to Google. The key field clears; the card
   shows *API key saved in protected storage*.
2. The rows read `diomedes-dev · gemini-3.8-flash · global` and the price card
   `google-vertex:gemini-3.8-flash:global:standard:gross-2026.1`.
3. **APPROVAL: spend limit.** Enter `10.00`, tick the approval, **Save limit**.
4. **Check setup**: every line says Yes. This check sends nothing.
5. Routing is the Focused tier (maps to Google Vertex), or the owner override in AI setup ›
   Advanced. The card itself sets no default.

The same $10 limit goes on the OpenRouter, AWS Bedrock and Azure OpenAI cards: *Spend limit for
this connection* › `10.00` › tick › **Save limit**, once each connection exists.

## 4. Live sequence (APPROVAL: paid calls; synthetic data only)

Use a new project folder containing only `synthetic/vertex-proof.txt`, with exactly this line:

```
Synthetic proof file. Codeword: HELIOTROPE-47. No real data.
```

| # | Do | Expect | Record |
|---|----|--------|--------|
| 1 | Ask: `Reply with exactly DIOMEDES_VERTEX_OK and nothing else.` | Exactly `DIOMEDES_VERTEX_OK` | Hold settled; request id on the card |
| 2 | Ask for a 300-word synthetic story; press **Stop** after the first lines stream | Text streams, then stops; no answer is committed after Stop | Hold state: settled with its usage, or uncertain with a reason. It is never silently zero. |
| 3 | Ask: `Read synthetic/vertex-proof.txt and tell me the codeword.` The file must be inside the project's read scope; approve it if asked. | One read of that file only, answer `HELIOTROPE-47` | Tool call and result in the run log |
| 4 | Ask: `Propose adding a second line "Checked." to synthetic/vertex-proof.txt.` | A proposal waits for approval. Decline it or approve it; the file changes only on approval. | Proposal record |
| 5 | Open AI setup › Google Vertex AI | Payer is your project, not Nectovia credits. You see the gross estimate, calls not yet settled, the expected promotion (unconfirmed), credits (not known here), Nectovia credits used $0.00, and the invoice (Google's). | Screenshot |
| 6 | For any **uncertain** call: next day, find its cost in Billing › Reports and record it, or accept it at its ceiling | Hold resolves | Note |

The next day, confirm in Billing › Reports (group by SKU, credits shown) that:
- the charges are on `diomedes-dev`;
- the SKUs are Gemini 3.8 Flash Global;
- the totals are at or below the app's gross estimate.

Send the lead:
- the request ids;
- one screenshot of the card;
- the billing-report line.

Leave out tokens and file contents.

## 5. Stop conditions

Stop and tell the lead if:
- any call answers from a model other than `gemini-3.8-flash`;
- a charge lands on a project other than `diomedes-dev`;
- a Stop does not stop streaming;
- the card shows a debit of Nectovia credits;
- the Google bill exceeds the app's gross estimate.
