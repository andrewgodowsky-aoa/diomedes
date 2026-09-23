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

## 0. What you need to decide first

1. **Which project pays.** Pick one Google Cloud project whose billing account you are willing
   to charge. Record its id as `PROJECT_ID` below.
2. **Which credit you expect to cover it.** Check what the billing account has:
   - the new-customer Free Trial credit;
   - the Gemini 3.8 Flash introductory promotion. This is "50% credits back on net spend"
     through 2026-12-31, applied after the fact. It is expected not to stack with Free Trial
     spend.

   The app assumes neither. It estimates every call at Google's standard rate ($1.50 / $0.15
   cached / $7.50 per 1M tokens) and shows the promotion separately, as unconfirmed.
3. **A spend limit.** A few cents covers the whole live sequence below; $1.00 is ample. The
   limit is Nectovia's own estimate cap, not a Google budget.
4. **Auth method.** This runbook uses Application Default Credentials (ADC) from `gcloud`,
   which the route supports.
   - Someone has mentioned a Vertex API key (Express Mode). The route refuses Express Mode
     keys today on purpose.
   - Tell the lead if you want a key path instead; that is a separate change.

## 1. Project, billing and API (Google Cloud console or `gcloud`)

Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install), then:

```bash
gcloud init
```

```bash
gcloud config set project PROJECT_ID
```

```bash
gcloud billing projects describe PROJECT_ID
```

The output must show `billingEnabled: true`. If it doesn't, link a billing account in the
console under Billing › Account management.

**APPROVAL: enable a paid API on the project.**

```bash
gcloud services enable aiplatform.googleapis.com --project PROJECT_ID
```

Optional, recommended: a Google budget alert under Billing › Budgets & alerts, for example
$5 with alerts at 50/90/100%. It alerts; it does not cap. The app's spend limit is the
hard stop on this computer.

## 2. Local sign-in: complete it before connecting the app

The app fingerprints the ADC file when you connect. If you change the sign-in afterwards,
the app refuses to send until you connect again. So finish this whole section first.

```bash
gcloud auth application-default login
```

```bash
gcloud auth application-default set-quota-project PROJECT_ID
```

Don't run `print-access-token` or paste the ADC file anywhere; the app's card confirms the file was found.

The app reads only `%APPDATA%\gcloud\application_default_credentials.json`, or the file
`GOOGLE_APPLICATION_CREDENTIALS` names. It never uploads or logs the file.

## 3. Connect in the app (no spend yet)

AI setup › Google Vertex AI:

1. The **Google sign-in on this computer** row says *Found … quota project PROJECT_ID*.
2. Enter `PROJECT_ID`, tick *Bill this project, and no other…*, then press **Connect**.
   Nothing is sent to Google.
3. The rows now read Verified / `PROJECT_ID · gemini-3.8-flash · global` / price card
   `google-vertex:gemini-3.8-flash:global:standard:gross-2026.1`.
4. **APPROVAL: spend limit.** Enter the limit from step 0, tick the approval, then press
   **Save limit**.
5. Press **Check setup**. Every line should say Yes. This check sends nothing.
6. Routing: select the **Focused** tier, which maps to Google Vertex once the tier lane lands.
   Or use the owner override in AI setup › Advanced. The Vertex card itself sets no default.

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
- the charges are on `PROJECT_ID`;
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
- a charge lands on a project other than `PROJECT_ID`;
- a Stop does not stop streaming;
- the card shows a debit of Nectovia credits;
- the Google bill exceeds the app's gross estimate.
