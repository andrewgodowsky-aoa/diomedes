# Juniper Street Bakery & Cafe (sample business)

**Fictional.** Juniper Street Bakery & Cafe, its town (Millbrook), staff, customers and
supplier are invented for demonstrating Nectovia. No real business is described. Phone
numbers are in the 555-0100 to 555-0199 range and email addresses are on example.com.

A neighborhood bakery and cafe with six staff. The story in its files: a croissant price
rise in W36 after the butter price went up, pumpkin items climbing past croissants in W38,
three catering inquiries waiting on quotes, and Saturday catering pickups that keep
landing in the morning rush.

- `workspace/` the business's own files. This is what a reset copies into the project folder.
- `planted.md` every planted problem, with the exact file and row. Checked by `npm run samples:check`.
- `scenarios.md` requests to hand Nectovia, and what a good answer contains.

## Where it came from

This is the Juniper Street Bakery workspace the 2026-09-24 product captures on the site
were taken on (`deliverables/demo-0.1.11/projects/Juniper Street Bakery` on the owner's
machine), imported with these changes:

- Kept byte for byte: the point-of-sale export (`exports/pos-weekly-summary.txt`, the file
  the board capture cites by hash) and every sales, price, inventory and schedule figure.
- Left out, because the app produced them during the demo: the two plan files named after
  message text, `catering/replies-draft.md`, the generated `weekly-operations-brief.md`
  and the `Imports/` copy of the export.
- CSV files lost their `#` comment lines so every row number is a spreadsheet row; the
  fictional notice is in the README and every Markdown file instead.
- The inventory count is renamed `count-2026-09-20.csv`: it is the Sunday close count, and
  Sunday was the 20th.
- Added: the staff roster, last week's schedule, the catering order log and last week's
  operations brief, so a brief, a staffing question and a catering plan have a history to
  work from.
