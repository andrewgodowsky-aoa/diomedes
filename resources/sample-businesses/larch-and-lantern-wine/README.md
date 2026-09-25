# Larch & Lantern Wine Shop (sample business)

**Fictional.** Larch & Lantern Wine Shop, its distributors (Fall Line Wine Co., Tidewater
Imports), its club members and staff are invented for demonstrating Nectovia. No real
business or producer is described; wines are named by region and vintage only. Phone
numbers are in the 555-0100 to 555-0199 range and email addresses are on example.com.

A wine shop with a small bar, owner Lise Moreau (the site's "L. Moreau"). Ninety days of
distributor invoices, receiving counts, credit memos and monthly statements, nine weeks of
bottle sales, a Sunday shelf count and the September club charge run.

- `workspace/` the shop's own files, copied into the project folder by a reset.
- `planted.md` every planted problem, with the exact file and row. Checked by `npm run samples:check`.
- `scenarios.md` requests to hand Nectovia, and what a good answer contains.

## What it matches on the site

- The wine shop **Lookback** (`src/data/lookback.ts`): the same seven items and $1,230.00,
  in the same invoices, lines, memos and club rows. The site names the sources as `.pdf`;
  here they are `.csv` invoices and `.md` credit memos with the same names, because the app
  reads text files and only previews PDFs. The check fails if the seven items stop adding
  to $1,230.00.
- The **wine morning thread** and the Weekend reorder automation: a Monday reorder built
  before Fall Line's noon cutoff, nine wines under two weeks of stock, two cases of the
  Sancerre on it, and declined club cards caught.
