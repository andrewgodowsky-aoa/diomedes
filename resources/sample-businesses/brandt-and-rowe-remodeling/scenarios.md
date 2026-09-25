# Brandt & Rowe Remodeling: requests to hand Nectovia

Each request uses a feature marked **Available now** on the site's status list. Start from
a fresh reset.

## 1. Ready for Friday's walkthrough

**Feature:** Ask mode (`modes`).

> Get the Henderson job ready for Friday's walkthrough. Tell me what's blocking us.

A good answer:

- reads `jobs/henderson/`: Pratt Tile confirmed for Wednesday; Delta Electric asked to move
  from Wednesday to Thursday and has no answer; the Hendersons have not picked vanity
  hardware (three options on the selections sheet);
- counts the punch list: nine items, seven closed, two open (vanity hardware, which waits on
  the selection, and the under-cabinet switch plate, which is Delta's);
- catches that signed change order 7 ($2,140.00, 24-inch porcelain) is not on draft invoice
  2231, which goes to the Hendersons on Friday after Chris approves it;
- may add that Pratt's invoice 311 came in $640.00 over its $3,600.00 bid.

## 2. Look back over the last 90 days

**Feature:** Ask mode, with a table in the conversation (`modes`, `inline-visuals`).

> Go back through the last 90 days: signed change orders we never billed, deliveries billed short, subs over their bids, and finished jobs we haven't fully billed.

A good answer finds nine items worth $13,621.50 and names the file behind each: three
unbilled change orders ($465.00, $1,180.00, $2,140.00), three short deliveries ($301.00,
$134.00, $86.50), two subs over bid ($640.00, $275.00) and the Alvarez final draw
($8,400.00, final passed 09-12). It says which are clean too, for example that HEN-CO-06
was declined and KES-CO-01 is unsigned, so neither is missing from an invoice.

## 3. Put change order 7 on Friday's invoice

**Feature:** Build mode with Show me first, then History (`modes`, `threads`, `history`).

> Add change order 7 to the Hendersons' draft invoice 2231.

A good proposal:

- adds one line to `billing/invoice-2231-draft.csv` (kind `change-order`, ref `HEN-CO-07`,
  $2,140.00), taking the invoice from $21,600.00 to $23,740.00, and updates that invoice's
  total in `billing/invoices.csv`;
- changes nothing else, and waits for approval: the invoice goes to a client;
- after approval, History shows both files' before and after.

## 4. Kessler against its allowances

**Feature:** Ask mode (`modes`).

> Which purchase orders on the Kessler kitchen are over their allowance?

A good answer: one. Cabinet PO 4412 is $18,960.00 against a $17,500.00 allowance, $1,460.00
over, and the difference is exactly the upgraded pulls ($1,930.00 line) Morgan Kessler chose
at the showroom on 08-28 (`selections/kessler.csv`). No change order was raised. The
countertop and appliance orders are under their allowances.

## 5. Close out the Marsh punch list on the Board

**Feature:** Plan mode and the Task board (`modes`, `board`). This one moves tasks through
Ready, Working, Review and Done.

> Plan closing out the Marsh bath punch list before the 10-02 walkthrough: one task per owner.

A good plan counts seven open items, not five: two were marked done on 09-15 with no
sign-off (towel bar anchors, toilet supply escutcheon). It groups them by owner (Delta
Electric: fan grille; Brandt & Rowe: baseboard gap, paint scuff, mirror, towel bar; Tolliver
Plumbing: escutcheon), says three have no photo, and flags the grout touch-up as unassigned.

Then make each step a task (**Ready**). Start the Brandt & Rowe task in Build mode to write a
checklist into a new `jobs/marsh/walkthrough-2026-10-02.md`: **Working** while it runs,
**Review** when the proposal is ready, **Done** once approved. Start the Delta task the same
way and leave its proposal in Review. Leave the rest Ready.

## 6. The Friday job cost report

**Feature:** Weekly brief with a source on every line (`weekly-brief`).

> Write this week's job cost report: every open job against its contract, with change orders and what's been billed.

A good report covers HEN, KES and MAR with a source on every figure:

- HEN: contract $86,400.00; signed change orders $2,920.00 (CO-05 and CO-07); billed
  $39,660.00 on invoices 2199 and 2212; draft 2231 is $21,600.00 and is missing CO-07;
- KES: contract $64,800.00; billed $12,960.00; cabinet PO $1,460.00 over allowance with no
  change order;
- MAR: contract $38,200.00; billed $19,100.00 on invoices 2201 and 2215 (2215 sent, not
  paid).

It can add that the finished Alvarez job still has an $8,400.00 draw unbilled.
