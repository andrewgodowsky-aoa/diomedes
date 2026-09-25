# Juniper Street Bakery: requests to hand Nectovia

Each request uses a feature marked **Available now** on the site's status list
(`src/data/status.json` in the site repository). Start from a fresh reset so the Board,
threads and History are empty.

## 1. Nine weeks at a glance

**Feature:** Ask mode, with a chart in the conversation (`modes`, `inline-visuals`).

> Chart croissants against pumpkin items for the last nine weeks and tell me the first week pumpkin outsold croissants.

A good answer:

- draws one line per series for W30 to W38 from `sales/weekly-sales-2026-W30-to-W38.csv`
  (croissants = butter + almond; pumpkin = loaf slices + lattes);
- names **W38** as the first and only week pumpkin is ahead: 492 against 483. In W37 it was
  still 412 against 488;
- notes croissants held at 588 to 619 a week through W35 and dropped to 487 in W36, the week
  both croissant prices rose by $0.50;
- does not say the lines cross in W35, W36 or W37.

## 2. Did the price rise pay for the butter?

**Feature:** Ask mode (`modes`).

> Did raising the croissant price actually cover the butter increase, or did I lose money on croissants?

A good answer:

- finds the Hollis cultured butter case at $142.20 in August and $167.80 in September, up
  $25.60 (18.0%), and the unit costs in the sales file moving from $1.12 to $1.38 (butter)
  and $1.41 to $1.66 (almond);
- shows the $0.50 rise more than covers the unit cost increase: margin per butter croissant
  goes from $3.13 to $3.37, per almond croissant from $3.54 to $3.79;
- shows volume fell enough that weekly croissant gross margin fell anyway: $1,914.65 in W35
  against $1,705.03, $1,707.56 and $1,694.07 in W36 to W38;
- cites the two price sheets and the sales file.

## 3. Saturday staffing against catering

**Feature:** Ask mode (`modes`).

> Who's packing Saturday's catering order, and does this week's Saturday schedule hold up against it?

A good answer:

- finds order C-0429 (Cedar Row Book Club, Saturday 09-26 at 9:30, four trays, a quiche and
  two carafes, $262.00) with nobody in `packed_by`;
- reads `staff/schedule-2026-W39.md`: Priya and Marco on the Saturday open, Sam and Dana mid,
  Leo closing;
- connects last Saturday: Sam left the counter from 9:30 to 10:05 to pack C-0426, and the
  09-20 review complains of a 15-minute wait while staff packed a big order;
- points out every Saturday pickup since August fell between 9 and 11, and offers the small
  fixes: name a packer from the open shift before 9, or move Saturday pickups to 8:00 as the
  owner's notes suggest.

## 4. This Monday's operations brief

**Feature:** Weekly brief with a source on every line (`weekly-brief`).

> Write this Monday's operations brief for last week, in the same shape as the one in briefs/.

A good answer:

- covers W38: revenue $11,612 (from $11,191), gross margin $8,856 (from $8,516), croissants
  483 (from 488), pumpkin items 492 (from 412), each with its source;
- says W38 is the first week pumpkin items outsold croissants;
- carries forward what is open: C-0429 has no packer, and butter, pumpkin puree and almond
  paste are at or below their reorder points on the Sunday count;
- invents no figure that is not in the files.

## 5. Plan the three catering quotes, then work them on the Board

**Feature:** Plan mode and the Task board (`modes`, `board`). This one moves tasks through
Ready, Working, Review and Done.

> Plan the three catering quotes in catering/inquiries.md, one task per quote, priced from the menu.

A good plan:

- has one step per inquiry: Brightline Dental (standing Friday order for 18, monthly
  invoice), Millbrook Library Friends (Saturday 10-10, 60 guests, about $300) and the Harper
  & Vale wedding brunch (Sunday 10-25, 45 guests, delivery 4 miles, gluten-free question);
- prices from the menu's catering line: pastry tray (12) $42, quiche $38, carafe (12 cups)
  $28. For the library, five trays and two carafes is $266, inside the budget;
- flags what the files cannot price (fruit, delivery) and does not promise gluten-free,
  because nothing in the files says the kitchen can keep it separate;
- notices the library event is a Saturday pickup in the 9 to 11 rush.

Then, on the Board, use **New task** once per step (name it after the step, with
`catering/inquiries.md` as its document); all three arrive in **Ready**. Start the
Brightline task in Build mode to write its reply into `catering/replies-draft.md`: it is
**Working** while the run is live, its proposal waits in **Review**, and approving it moves
it to **Done**. Start the library task the same way and leave its proposal unapproved in
Review. Leave the wedding task in Ready. The Board ends with one task each in Ready, Review
and Done.

## 6. Name the Saturday packer, with History

**Feature:** Build mode with Show me first, then History and restore (`modes`, `threads`, `history`).

> Add a Saturday pack-out line to staff/schedule-2026-W39.md naming who packs C-0429 before its 9:30 pickup.

A good proposal:

- changes only `staff/schedule-2026-W39.md`, keeps every existing row, and names someone
  already on the Saturday open shift (Priya or Marco);
- waits for approval under Show me first; after approval, History shows the before and
  after, and restoring it brings back the original file as a new History entry.
