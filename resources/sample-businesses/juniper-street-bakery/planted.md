# Juniper Street Bakery: what is planted

Fictional sample data. Today is Monday 2026-09-21 (ISO week 39); the history is W30 to W38.

`npm run samples:check` recomputes every row of the table below from the raw files in
`workspace/` and fails if a file and this table disagree, or if the files show a problem
that is not listed here. Only the `file`, `where` and `amount` cells are compared; the
`problem` cell is for people.

**Row convention.** A CSV "row" is its spreadsheet row: the header is row 1, the first
record is row 2. A Markdown "line" is its line number in the file.

| id | problem | file | where | amount |
|---|---|---|---|---|
| croissant-price-w36 | Butter croissant $4.25 to $4.75 and almond $4.95 to $5.45, the same week | `sales/weekly-sales-2026-W30-to-W38.csv` | 2026-W36, rows 50 and 51 | 0.50 |
| pumpkin-crosses-croissants-w38 | Pumpkin items outsell croissants for the first and only time | `sales/weekly-sales-2026-W30-to-W38.csv` | 2026-W38, rows 66 to 73 | pumpkin 492 vs croissants 483 |
| hollis-cultured-butter-rise | Cultured butter up 18.0% from the August sheet ($142.20 to $167.80) | `suppliers/hollis-prices-2026-09.csv` | row 2 | 25.60 |
| reorder-cultured-butter | At or below its reorder point on the Sunday count | `inventory/count-2026-09-20.csv` | row 2 | 1.5 case, reorder at 2 |
| reorder-pumpkin-puree | At or below its reorder point, while pumpkin sales climb | `inventory/count-2026-09-20.csv` | row 5 | 0.5 case, reorder at 1 |
| reorder-almond-paste | At its reorder point | `inventory/count-2026-09-20.csv` | row 6 | 1 tub, reorder at 1 |
| unpacked-c-0429 | Saturday 09-26 09:30 catering pickup inside the 9 to 11 rush, nobody assigned to pack it | `catering/orders-2026-W35-to-W39.csv` | row 8 | 262.00 |

## The crossing, stated once

Croissants are butter plus almond croissant units; pumpkin items are pumpkin loaf slices
plus pumpkin spice lattes. Pumpkin is below croissants every week from W30 to W37 (in W37,
412 against 488) and above them in W38 (492 against 483). The lines cross once, between
W37 and W38, and W38 is the first week pumpkin outsells croissants. No week ties. The check
fails if a future edit adds a second crossing or a tie.

This is the data the 2026-09-24 site captures were taken on. One answer in those captures
said the lines cross "around W35/W36 and pumpkin overtakes croissants by W37"; that is wrong
against these rows, and a good answer names W38.

## The week that went wrong

Saturday 2026-09-19: the Oakmont Soccer Boosters picked up six trays at 9:45 (row 7 of the
catering orders). Sam came off the counter from 9:30 to 10:05 to pack it
(`staff/schedule-2026-W38.md`), and the next day's two-star review says a customer waited
15 minutes while staff packed a big order (`customers/feedback-log.md`). Every Saturday
catering pickup since August has landed between 9 and 11, and the next one, C-0429, has
nobody assigned.

## Not planted, but true of the files

- The point-of-sale summary prints whole dollars and rounds half a dollar to the even
  dollar: W38 revenue is $11,612.50 in the item rows and $11,612 in the export. The check
  reproduces that rule rather than treating it as a discrepancy.
- `exports/pos-weekly-summary.txt` is byte for byte the export the 2026-09-24 board capture
  cites (SHA-256 `caacbc80...e37b18`).
