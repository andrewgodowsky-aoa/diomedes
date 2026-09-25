# Quarry Hill Cabinetworks: requests to hand Nectovia

Each request uses a feature marked **Available now** on the site's status list. Start from
a fresh reset.

## 1. Walnut ply on the rack

**Feature:** Ask mode (`modes`).

> How much of the three-quarter walnut ply is left after Tuesday's delivery?

A good answer: eleven sheets. Monday's count had none, Tuesday's delivery note (3312 line 2)
added fifteen, and four were issued to the Keller table (KEL-07) on Wednesday. Nothing else
drew on it, and Friday's count (row 9) agrees. It may add that ALV-02 needs six of them.

## 2. Where K-104's sheet stock went

**Feature:** Ask mode with a chart in the conversation (`modes`, `inline-visuals`).

> K-104 used more sheet stock than I allowed for. Where did it go?

A good answer:

- one sheet over the allowance of three: five sheets of 1/4 MDF were issued (three on 09-09,
  two on 09-11), four were cut and one came back whole on 09-12;
- the four cut sheets hold 128 square feet: 95 in parts, 25 in three labelled remnants back on
  rack C3 (R-0917, R-0918, R-0919) and 8 in kerf and waste, drawn as a chart;
- the extra sheet is the remake after the sink opening was measured again on 09-11 (site notes
  line 9), and the change order for it is not approved yet, so the job cost is provisional.

## 3. Check Brookfield's invoice before paying it

**Feature:** Ask mode (`modes`).

> Check Brookfield's invoice 3312 against what we signed for.

A good answer: line 2 bills 16 sheets of 3/4 walnut ply at $164.00; the delivery note signed
for 15, and the stock ledger and Friday count agree with 15. The overbilling is $164.00. The
other three lines match.

## 4. Why the Friday count never matches

**Feature:** Ask mode with a table (`modes`, `inline-visuals`).

> The Friday count never matches what I think we have. Reconcile it against Monday's count, the delivery and the issue log.

A good answer shows a table per material and finds one gap: 3/4 white oak ply. Monday 6,
delivered 8, issued 5 to PEN-05 (3 on 09-16, 2 on 09-17), so 9 expected and 7 counted: two
sheets ($236.00 at cost) with no issue recorded. Everything else balances.

## 5. The Marsh punch list, worked on the Board

**Feature:** Plan mode and the Task board (`modes`, `board`). This one moves tasks through
Ready, Working, Review and Done.

> Plan what's left on the Marsh kitchen before Friday's walk: one task per open item, with its owner.

A good plan counts six open items, not four: the scribe (item 4) and the crown nail holes
(item 8) were marked closed on 09-15 with no check recorded, so they are still open. Four
belong to the installer and two to the finisher, and three of the six carry a photo.

Then use **New task** on the Board once per open item; each arrives in **Ready**. Start the crown gap task in Build mode to write the
fix into a new `jobs/MAR-11/fixes-2026-09-21.md`: **Working**, then **Review**, then **Done**
once approved. Start the pantry sheen task the same way and leave its proposal in Review.
Leave the rest Ready.

## 6. Reserve walnut for the credenza

**Feature:** Build mode with Show me first, then History (`modes`, `threads`, `history`).

> Reserve six sheets of the 3/4 walnut ply for ALV-02.

A good proposal writes a new `stock/reservations.csv` (or an equivalent line) naming ALV-02,
3/4 walnut ply and six sheets, leaves the counts themselves unchanged, and waits for approval
under Show me first. After approval, History shows the new file.
