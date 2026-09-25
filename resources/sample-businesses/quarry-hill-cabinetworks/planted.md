# Quarry Hill Cabinetworks: what is planted

Fictional sample data. Today is Monday 2026-09-21; the stock records run from 2026-09-02.

`npm run samples:check` recomputes every row below from `workspace/` and fails if a file
and this table disagree, or if the files show a problem not listed here. Only `file`,
`where` and `amount` are compared.

**Row convention.** A CSV "row" is its spreadsheet row: header row 1, first record row 2.
An invoice "line" is the value in its `line` column; a Markdown "line" is its line number.

| id | problem | file | where | amount |
|---|---|---|---|---|
| count-gap-white-oak-ply-3-4 | White oak ply: Monday 6 + delivered 8 - issued 5 = 9, Friday counted 7 | `stock/sheet-goods-count-2026-09-18.csv` | row 6 | 2 sheets, 236.00 |
| walnut-ply-3-4-on-hand | 3/4 walnut ply after Tuesday's delivery: Monday 0, delivered 15, issued 4 | `stock/sheet-goods-count-2026-09-18.csv` | row 9 | 11 sheets |
| invoice-over-delivery-3312-line-2 | Brookfield bills 16 sheets of walnut ply; the delivery note signed for 15 | `invoices/brookfield-3312.csv` | line 2 | 164.00 |
| k-104-over-allowance | Four sheets of 1/4 MDF cut against an allowance of three; S4 is the remake sheet | `jobs/K-104/sheets.csv` | row 5 | 1 sheet |
| k-104-remake-cause | Sink opening measured again on 09-11; remake cut | `jobs/K-104/site-notes.md` | line 9 | - |
| k-104-change-order-unapproved | The remake change order is not approved, so the job cost is provisional | `jobs/K-104/site-notes.md` | line 11 | - |
| mar-11-open | Six open: four installer, two finisher | `jobs/MAR-11/punch.csv` | rows 3, 4, 5, 7, 9 and 10 | 6 open: 4 installer, 2 finisher |
| mar-11-closed-unchecked | Marked closed on 09-15 with no check recorded | `jobs/MAR-11/punch.csv` | rows 5 and 9 | 2 |
| mar-11-open-with-photo | Three of the six open items carry a photo | `jobs/MAR-11/photo-log.csv` | 3 rows | 3 of 6 |

## The rules the check applies

- **Count against the ledger:** Monday's count, plus what the delivery note received between
  Tuesday and Friday, less what the issue log drew in that time, against Friday's count.
- **Invoice against delivery:** an invoice line above the quantity on the delivery note.
- **K-104:** sheets cut against the estimate's allowance; the cut list, remnants and waste
  must add to the cut sheets' 128 square feet (95 + 25 + 8), and the issue log's net draw
  must equal the sheets cut.
- **MAR-11:** an item is open unless it is closed and someone recorded the check.

## Deliberately clean

Every other material on the Friday count matches the ledger. Brookfield's other three lines
match the delivery note. The walnut count and the ledger agree at 11, so the invoice's
sixteenth sheet was billed, not delivered.
