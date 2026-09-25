# Larch & Lantern Wine Shop: requests to hand Nectovia

Each request uses a feature marked **Available now** on the site's status list. Start from
a fresh reset.

## 1. The weekend reorder

**Feature:** Ask mode, with a table in the conversation (`modes`, `inline-visuals`).

> Build this week's reorder from the weekend sales and yesterday's count, using our reorder rule, grouped by distributor. Fall Line's cutoff is noon.

A good answer:

- applies the rule in `distributors/ordering-notes.md`: under two weeks of stock at the W35
  to W38 average, order whole cases up to four weeks;
- lists nine wines. Fall Line: Sancerre 2 cases, Champagne 3, Sauvignon Blanc 5, Côtes du
  Rhône 6, Barbera 3. Tidewater: Prosecco 6, Chianti 3, Pinot Grigio 3, Primitivo 4;
- prices them from the posted lists and notices six cases of Côtes du Rhône reaches the
  5-case break at $132.00: Fall Line $3,282.00, Tidewater $2,310.00;
- says the Fall Line order must go by noon today and Tidewater's by 3 PM Wednesday, and that
  the reorder waits for Lise's approval.

## 2. Check the distributor invoices against the posted prices

**Feature:** Ask mode (`modes`).

> Check every Fall Line and Tidewater invoice from the last 90 days against their posted price lists.

A good answer:

- finds two lines: Fall Line 30455 line 1, House Malbec 10 cases at $132.00 when the posted
  price at 10 cases is $120.00 ($120.00 over), and Tidewater 7788 line 3, Vinho Verde 5 cases
  at $96.00 against $90.00 at 5 cases ($30.00 over);
- shows it checked the rest: 30358 and 30311 on the Fall Line side, and 7654 and 7699 on the
  Tidewater side, reach a break and are billed correctly;
- names each invoice file and line.

## 3. Billed for what never came, and credits that never landed

**Feature:** Ask mode (`modes`).

> Were we billed for anything we never received, and did the Champagne and Chianti credits ever come through?

A good answer:

- matches the receiving log to the invoices: Fall Line 30418 line 4, 5 cases of rosé billed
  and 4 counted in ($156.00); Tidewater 7720 line 2, 3 cases of Prosecco billed and 2
  counted in ($138.00);
- finds credit memo 118 ($84.00, two broken bottles of Champagne) missing from Fall Line's
  September statement and memo 42 ($168.00, the corked Chianti) missing from Tidewater's;
- notes memos 109 and 37 were applied, so it read the statements rather than guessing;
- with question 2, totals seven items and $1,230.00 across the two distributors.

## 4. Declined club cards

**Feature:** Ask mode (`modes`).

> Which September club charges failed, and who still needs a note from us?

A good answer:

- finds six Cellar Six members declined on 09-20 with no retry and no note: rows 12, 31, 40,
  57, 63 and 88 of `club/september-run.csv` (Kira Northcott, Farah Galloway, Otto Jessup,
  Hana Ingram, Noor Kincaid, Otto Fairbrook), $534.00 in all;
- leaves out rows 23 and 71, which were declined and then retried to approval;
- offers drafts to the six members but does not send anything; messages to customers wait
  for approval.

## 5. One task per distributor claim, on the Board

**Feature:** Plan mode and the Task board (`modes`, `board`). This one moves tasks through
Ready, Working, Review and Done.

> Plan the money we're owed: one task per distributor, each with every overcharge, short delivery and missing credit, and a third task for the club notes.

A good plan has three steps: Fall Line (Malbec overcharge $120.00, rosé short $156.00, memo
118 $84.00: $360.00), Tidewater (Vinho Verde $30.00, Prosecco short $138.00, memo 42
$168.00: $336.00), and notes to the six club members.

Then make each step a task (all **Ready**). Start the Fall Line task in Build mode to write a
credit request into a new `claims/fall-line-2026-09.md`: **Working** while it runs, the
proposal in **Review**, approve it to **Done**. Start the Tidewater task the same way and
leave its proposal in Review. Leave the club task Ready.

## 6. What the shop sells as the season turns

**Feature:** Ask mode with a chart (`modes`, `inline-visuals`).

> Chart bottles sold by category for the last nine weeks.

A good answer draws one line or stacked bar per category from
`sales/weekly-sales-2026-W30-to-W38.csv` and says what moved: reds rise from 162 bottles in
W30 to 203 in W38, rosé falls from 18 to 14, whites and sparkling hold roughly level.
