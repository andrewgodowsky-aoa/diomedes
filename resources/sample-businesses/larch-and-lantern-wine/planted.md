# Larch & Lantern Wine Shop: what is planted

Fictional sample data. Today is Monday 2026-09-21; invoices run from 2026-06-23 to
2026-09-17, sales from W30 to W38.

`npm run samples:check` recomputes every row below from `workspace/` and fails if a file
and this table disagree, or if the files show a problem not listed here. Only `file`,
`where` and `amount` are compared.

**Row convention.** A CSV "row" is its spreadsheet row: header row 1, first record row 2.
An invoice "line" is the value in its `line` column.

| id | problem | file | where | amount |
|---|---|---|---|---|
| case-price-7788-line-3 | Vinho Verde, 5 cases at $96.00; the posted price at 5 cases is $90.00 | `invoices/tidewater-7788.csv` | line 3 | 30.00 |
| case-price-30455-line-1 | House Malbec, 10 cases at $132.00; the posted price at 10 cases is $120.00 | `invoices/fall-line-30455.csv` | line 1 | 120.00 |
| short-7720-line-2 | Prosecco, 3 cases billed, 2 counted in | `invoices/tidewater-7720.csv` | line 2 | 138.00 |
| short-30418-line-4 | Dry rosé, 5 cases billed, 4 counted in | `invoices/fall-line-30418.csv` | line 4 | 156.00 |
| credit-fall-line-118 | 2 broken bottles of Champagne; memo issued 09-02, never on a statement | `credits/fall-line-cm-118.md` | memo 118, not on statements/fall-line-statement-2026-09.csv | 84.00 |
| credit-tidewater-42 | Corked case of Chianti returned; memo issued 08-24, never on a statement | `credits/tidewater-cm-042.md` | memo 42, not on statements/tidewater-statement-2026-09.csv | 168.00 |
| club-declined-2026-09-20 | Six Cellar Six cards declined 09-20, no retry and no note | `club/september-run.csv` | rows 12, 31, 40, 57, 63 and 88 | 534.00 |
| reorder-fl-101 | Sancerre 2024: 10 bottles, 1.3 weeks at 8 a week | `inventory/shelf-count-2026-09-20.csv` | row 2 | 2 cases |
| reorder-fl-104 | Champagne Brut NV: 7 bottles, 1.4 weeks | `inventory/shelf-count-2026-09-20.csv` | row 5 | 3 cases |
| reorder-fl-106 | Sauvignon Blanc: 29 bottles, 1.4 weeks | `inventory/shelf-count-2026-09-20.csv` | row 7 | 5 cases |
| reorder-fl-109 | Côtes du Rhône: 25 bottles, 1.1 weeks; 6 cases reaches the 5-case break | `inventory/shelf-count-2026-09-20.csv` | row 10 | 6 cases |
| reorder-fl-113 | Barbera d'Asti: 8 bottles, 0.8 weeks | `inventory/shelf-count-2026-09-20.csv` | row 14 | 3 cases |
| reorder-tw-201 | Prosecco NV: 20 bottles, 1.0 weeks | `inventory/shelf-count-2026-09-20.csv` | row 18 | 6 cases |
| reorder-tw-203 | Chianti Classico: 20 bottles, 1.5 weeks | `inventory/shelf-count-2026-09-20.csv` | row 20 | 3 cases |
| reorder-tw-205 | Pinot Grigio: 17 bottles, 1.3 weeks | `inventory/shelf-count-2026-09-20.csv` | row 22 | 3 cases |
| reorder-tw-211 | Primitivo: 15 bottles, 1.1 weeks | `inventory/shelf-count-2026-09-20.csv` | row 28 | 4 cases |

The first seven rows are the site's wine Lookback: 7 items, $1,230.00.

## The rules the check applies

- **Case discount / price over list:** an invoice line's case price above the posted price
  for that quantity (the break price when the line reaches the break).
- **Short delivery:** cases billed on an invoice line above the cases counted in against
  that line in the receiving log. Amount: missing cases at the billed case price.
- **Credit never applied:** a credit memo whose date falls inside a statement period and
  whose `Credit memo <n>` row is on no statement.
- **Club:** a September charge declined and not retried to approval.
- **Reorder** (from `distributors/ordering-notes.md`): under two weeks of stock at the W35 to
  W38 average; order whole cases up to four weeks.

## Deliberately clean, so the rules have something to pass

Invoices 30358 (Malbec, 10 cases at $120.00), 30311 (Côtes du Rhône, 5 at $132.00), 7654
and 7699 reach a case break and are billed correctly. Credit memos 109 and 37 do appear on
their statements. Club rows 23 and 71 were declined and then retried to approval by hand.
