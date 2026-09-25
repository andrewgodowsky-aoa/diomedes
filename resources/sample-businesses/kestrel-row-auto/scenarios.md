# Kestrel Row Auto Repair: requests to hand Nectovia

Each request uses a feature marked **Available now** on the site's status list. Start from
a fresh reset.

## 1. What each car is waiting on

**Feature:** Ask mode (`modes`).

> Which repair orders are waiting on a part, and which part?

A good answer:

- names three real waits: 4471 (rear wheel bearing, ordered 09-14 from Northgate and due
  09-15, not received), 4488 (cabin blower motor, back-ordered at Beltway with no date) and
  4492 (windshield sublet to Crestline, not booked, per `notes/glass.md` line 3);
- catches the fourth: 4465 still reads Waiting on parts, but its ignition coil was signed in
  on 09-14 (`exports/parts-received.csv` row 34), so it can move;
- cites the export rows.

## 2. A car that went home without a bill

**Feature:** Ask mode (`modes`).

> I keep hearing a car went home without a bill. Which one?

A good answer finds RO 4453 (2021 hatchback, O2 sensor), closed 09-16 with no invoice in
`exports/invoices.csv`. Its approved estimate was $358.40. It can add that the counter
rules say an order closes only after the invoice is raised and paid, and that the other 12
orders closed last week were all invoiced.

## 3. Finished, and nobody told

**Feature:** Ask mode (`modes`).

> Which cars are finished and whose owners haven't been told?

A good answer: two. RO 4459 (2021 sedan, finished 11:20 Friday) and RO 4470 (2017 van,
finished 14:05 Friday) have no line in Friday's calls note. RO 4462 was called at 12:40 and
is waiting on its owner, so it is not on the list.

## 4. Estimates out, followed up on the Board

**Feature:** Plan mode and the Task board (`modes`, `board`). This one moves tasks through
Ready, Working, Review and Done.

> Plan follow-ups for every estimate sent in the last week that hasn't come back approved.

A good plan:

- lists four: E-6651 ($1,340.00, 2019 pickup, sent Monday 9:12, the oldest), E-6653
  ($486.20), E-6659 ($795.00) and E-6665 ($264.50, sent at 7:45 this morning and still
  inside the two-hour window at 8:00);
- says E-6651 and E-6653 go to customers with no mobile number, so those are calls, not
  texts, per `notes/front-counter.md`.

Then make each follow-up a task (**Ready**). Start the E-6651 task in Build mode to write a
call script into a new `notes/follow-ups-2026-09-21.md`: **Working**, then **Review**, then
**Done** once approved. Start E-6659 the same way and leave its proposal in Review. Leave
the other two Ready.

## 5. Who takes the bearing job

**Feature:** Ask mode (`modes`).

> Ben's off Tuesday and Wednesday. If the bearing for 4471 shows up, who can do it and when?

A good answer reads `staff/tech-schedule-2026-W39.csv`: Ben (brakes, suspension, bearings)
is off Tuesday and Wednesday and back Thursday; Farid (general service) works Tuesday and
Wednesday and is off Thursday; Ana and Carl work every weekday. It also says the part is six
days overdue, so the first move is to call Northgate about PO-7731.

## 6. Last week at the counter

**Feature:** Weekly brief with a source on every line (`weekly-brief`).

> Write last week's brief: orders opened, closed and still open, with a source on every line.

A good brief: 24 orders opened in the week of 09-14; 13 closed, 12 of them invoiced for
$2,783.10 and one (4453) with no invoice; 13 still open at 8:00 today (four waiting on
parts, four waiting on approval, three complete and awaiting pickup, two in progress). Each
figure cites the export it came from.
