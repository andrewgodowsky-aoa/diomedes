# Brandt & Rowe Remodeling: what is planted

Fictional sample data. Today is Monday 2026-09-21; records run from May to September 2026.

`npm run samples:check` recomputes every row below from `workspace/` and fails if a file
and this table disagree, or if the files show a problem not listed here. Only `file`,
`where` and `amount` are compared.

**Row convention.** A CSV "row" is its spreadsheet row: header row 1, first record row 2.
An invoice "line" is the value in its `line` column.

| id | problem | file | where | amount |
|---|---|---|---|---|
| unbilled-co-oka-co-02 | Extra garage circuit, signed and never billed; the final invoice went out without it | `change-orders/okafor-co-02.md` | signed 2026-07-29, not on invoice 2219 | 465.00 |
| unbilled-co-alv-co-04 | Pantry pull-outs, signed and never billed | `change-orders/alvarez-co-04.md` | signed 2026-08-14, not on invoice 2207 | 1180.00 |
| unbilled-co-hen-co-07 | 24-inch porcelain upgrade, signed and missing from Friday's draft | `change-orders/pine-st-co-07.md` | signed 2026-09-03, not on invoice 2231 | 2140.00 |
| short-ridgeline-58812-line-2 | 3/4-inch plywood: 45 billed, 38 on the delivery ticket | `invoices/ridgeline-58812.csv` | line 2 | 301.00 |
| short-summit-supply-1193-line-1 | Drywall: 60 billed, 52 on the ticket | `invoices/summit-supply-1193.csv` | line 1 | 134.00 |
| short-ridgeline-58940-line-5 | Joist hangers: 2 boxes billed, 1 on the ticket | `invoices/ridgeline-58940.csv` | line 5 | 86.50 |
| over-bid-pratt-tile-311 | Pratt Tile at Pine Street billed above its bid | `subs/pratt-tile-311.csv` | bid 3600.00, billed 4240.00 | 640.00 |
| over-bid-east-electric-88 | East Electric rough-in at Okafor billed above its bid | `subs/east-electric-88.csv` | bid 2850.00, billed 3125.00 | 275.00 |
| unbilled-draw-alv-d5 | Alvarez passed final inspection; the last draw was never invoiced | `permits/alvarez-final.md` | final passed 2026-09-12, draw ALV-D5 not invoiced | 8400.00 |
| over-allowance-po-4412 | Kessler cabinets over the allowance after the upgraded pulls; no change order raised | `purchase-orders/4412.csv` | total 18960.00, cabinets allowance 17500.00 | 1460.00 |
| henderson-punch-open | Vanity hardware not installed; switch plate missing | `jobs/henderson/punch-list.csv` | rows 9 and 10 | 2 of 9 open |
| henderson-unconfirmed-electrical | Delta Electric asked to move Wednesday's finish visit to Thursday | `jobs/henderson/schedule-2026-W39.csv` | row 4 | asked to move to Thu |
| henderson-selection-vanity-hardware | The Hendersons have not picked from three options | `jobs/henderson/selections.csv` | row 4 | waiting on the Hendersons |
| marsh-punch-open | Open items, counting two marked done with no sign-off | `jobs/marsh/punch.csv` | rows 4, 5, 6, 7, 9, 10 and 11 | 7 of 11 open |
| marsh-punch-done-unsigned | Marked done by the crew, never signed off | `jobs/marsh/punch.csv` | rows 6 and 10 | 2 |
| marsh-punch-no-photo | Open items with no photo | `jobs/marsh/punch.csv` | rows 7, 9 and 10 | 3 |
| marsh-punch-unassigned-mar-14-04 | Grout touch-up at the niche has no owner | `jobs/marsh/punch.csv` | row 5 | Unassigned |

The first nine rows are the site's remodeling Lookback: 9 items, $13,621.50.

## The rules the check applies

- **Change order never billed:** a change order with status `signed` that appears as no line
  on any client invoice. `where` names the first invoice for that job on or after signing.
- **Short delivery:** a supplier invoice line above the quantity on its delivery ticket.
- **Over bid:** a sub's invoices for one job adding to more than its bid for that job.
- **Last draw never billed:** a job with a passed final inspection and a draw in its schedule
  that no invoice carries.
- **Over allowance:** a purchase order above its category's allowance, with no signed change
  order for the difference.
- **Punch lists:** Henderson items not `closed`; Marsh items not `done` or done without a
  sign-off, per the Marsh site notes.

## Deliberately clean

Change orders OKA-CO-01, ALV-CO-03 and HEN-CO-05 are signed and billed; HEN-CO-06 was
declined and KES-CO-01 is not signed, so neither belongs on an invoice. East Electric's two
Alvarez invoices add to its bid exactly. Okafor passed final and every draw was billed. The
Kessler countertop and appliance orders are under their allowances.

The Hendersons approved the tile upgrade by text on 09-02, the day before they signed:
`messages/henderson.md` line 12.
