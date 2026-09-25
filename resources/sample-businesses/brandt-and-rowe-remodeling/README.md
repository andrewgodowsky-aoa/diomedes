# Brandt & Rowe Remodeling (sample business)

**Fictional.** Brandt & Rowe Remodeling, its clients, subcontractors, suppliers and staff
are invented for demonstrating Nectovia. No real business is described. Phone numbers are
in the 555-0100 to 555-0199 range and email addresses are on example.com.

A residential remodeler: owner Kat Brandt (the site's "K. Brandt"), partner Chris Rowe who
approves every invoice, project manager Sam Ortiz and site lead Jo Park. Three jobs are
active this week and two finished over the summer:

| Job | Client | Where it stands on Monday 2026-09-21 |
|---|---|---|
| HEN | Henderson residence, 418 Pine Street | Mid-flight: tile set, walkthrough Friday 09-25, progress invoice 2231 in draft |
| KES | Kessler residence | Early: cabinets ordered, nothing on site yet |
| MAR | Marsh residence | Punch list before a 10-02 walkthrough |
| ALV | Alvarez residence | Finished; passed final inspection 09-12 |
| OKA | Okafor residence | Finished in August |

- `workspace/` the company's files, copied into the project folder by a reset.
- `planted.md` every planted problem, with the exact file and row. Checked by `npm run samples:check`.
- `scenarios.md` requests to hand Nectovia, and what a good answer contains.

## What it matches on the site

- The remodeling **Lookback** (`src/data/lookback.ts`): the same nine items and $13,621.50,
  in change orders `alvarez-co-04`, `pine-st-co-07` and `okafor-co-02`, supplier invoices
  `ridgeline-58812`, `ridgeline-58940` and `summit-supply-1193`, sub invoices
  `pratt-tile-311` and `east-electric-88`, and the Alvarez final. The site names them `.pdf`;
  here they are `.md` and `.csv` with the same names, because the app reads text files. The
  check fails if the nine stop adding to $13,621.50.
- The **Henderson morning thread**: Pratt Tile confirmed Wednesday, nine punch items with
  seven closed, change order 7 for the 24-inch porcelain, vanity hardware not picked and the
  electrician asking to move from Wednesday to Thursday.
- The **allowance** and **walkthrough** scenarios: Kessler PO 4412 at $18,960 against a
  $17,500 cabinet allowance, and the Marsh bath's seven open punch items.

## Where the site disagrees with itself

The site's Henderson thread and its change-order scenario say change order 7 is missing
from progress invoice **1182**; its Lookback says invoice **2231**. This suite follows the
Lookback: the Hendersons are the Pine Street job and the draft is invoice 2231. A capture
that quotes the thread's "1182" will not match these files.
