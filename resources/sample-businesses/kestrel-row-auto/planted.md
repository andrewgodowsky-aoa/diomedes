# Kestrel Row Auto Repair: what is planted

Fictional sample data. Today is Monday 2026-09-21; the exports were taken at 8:00 and run
from 2026-08-31.

`npm run samples:check` recomputes every row below from `workspace/` and fails if a file
and this table disagree, or if the files show a problem not listed here. Only `file`,
`where` and `amount` are compared.

**Row convention.** A CSV "row" is its spreadsheet row: header row 1, first record row 2.
A Markdown "line" is its line number in the file.

| id | problem | file | where | amount |
|---|---|---|---|---|
| stale-status-ro-4465 | Ignition coil for RO 4465 signed in, but the order still reads Waiting on parts | `exports/parts-received.csv` | row 34 | signed in 2026-09-14 |
| waiting-ro-4471 | Rear wheel bearing for RO 4471 | `exports/parts-orders.csv` | row 35 | ordered 2026-09-14, due 2026-09-15 |
| waiting-ro-4488 | Cabin blower motor for RO 4488 | `exports/parts-orders.csv` | row 45 | back-ordered, no date |
| waiting-ro-4492 | Windshield for RO 4492, sublet and not booked | `notes/glass.md` | line 3 | sublet, not booked |
| not-received-po-7731 | Bearing order past its due date, never received | `exports/parts-orders.csv` | row 35 | due 2026-09-15 |
| no-invoice-ro-4453 | RO 4453 closed 09-16 with no invoice raised | `exports/repair-orders.csv` | row 15 | 358.40 |
| not-told-ro-4459 | 2021 sedan finished at 11:20 Friday, no pickup call | `exports/repair-orders.csv` | row 21 | complete 2026-09-18 11:20 |
| not-told-ro-4470 | 2017 van finished at 14:05 Friday, no pickup call | `exports/repair-orders.csv` | row 32 | complete 2026-09-18 14:05 |
| estimate-open-e-6651 | $1,340.00 on a 2019 pickup, sent Monday 09-14 at 9:12, no answer | `exports/estimates.csv` | row 43 | 1340.00 |
| no-mobile-c322 | The customer behind E-6651 has no mobile number, so a text cannot reach them | `exports/customers.csv` | row 23 | - |
| estimate-open-e-6653 | Sent Monday 09-14 at 15:30, no answer | `exports/estimates.csv` | row 45 | 486.20 |
| no-mobile-c324 | The customer behind E-6653 has no mobile number | `exports/customers.csv` | row 25 | - |
| estimate-open-e-6659 | Sent Tuesday 09-15 at 10:05, no answer | `exports/estimates.csv` | row 51 | 795.00 |
| estimate-open-e-6665 | Sent this morning at 7:45; inside the two-hour follow-up window at 8:00 | `exports/estimates.csv` | row 57 | 264.50 |

## The rules the check applies

- **Waiting on parts:** for every order with that status, a part signed in for it means the
  status is stale; otherwise the part order (ordered or back-ordered) or the sublet note is
  what it waits on.
- **Never received:** a part order still `ordered`, due before today, with nothing signed in.
- **Closed without an invoice:** status `Closed` and no row in `exports/invoices.csv`. The
  amount is its approved estimate.
- **Not told:** status `Complete` and no line for it in a `notes/calls-*.md` note.
- **Estimates:** sent on or after Monday 09-14 and not approved, and whether the customer has
  a mobile number.

## Deliberately clean

RO 4462 is complete and was called at 12:40 Friday; the car is still on the lot, which is
the customer's move. Part order PO-7722 still reads `ordered`, but its coil was signed in on
09-14, which is exactly why RO 4465 can move. Every other closed order has its invoice; 13
orders closed last week and 12 were invoiced ($2,783.10).
