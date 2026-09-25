# Kestrel Row Auto Repair (sample business)

**Fictional.** Kestrel Row Auto Repair, its customers, parts suppliers (Northgate Parts
Supply, Beltway Auto Parts), glass sublet (Crestline Auto Glass) and staff are invented for
demonstrating Nectovia. No real business is described. Phone numbers are in the 555-0100 to
555-0199 range and email addresses are on example.com.

An independent four-bay shop: owner Dee Hartman, service writer Luis Mendez and four
technicians. The shop system's nightly CSV exports cover three weeks of repair orders
(4440 to 4495), with their estimates, invoices, parts orders and parts received, plus the
counter rules, the glass sublet log, Friday's pickup calls and this week's technician
schedule.

- `workspace/` the shop's files, copied into the project folder by a reset.
- `planted.md` every planted problem, with the exact file and row. Checked by `npm run samples:check`.
- `scenarios.md` requests to hand Nectovia, and what a good answer contains.

## What it matches on the site

The auto shop scenarios in `src/data/scenarios.ts`, with their repair order numbers kept:
orders 4471 (rear wheel bearing, ordered and never received), 4488 (blower motor,
back-ordered), 4492 (windshield not booked) and 4465 (part signed in, status never
updated); finished cars 4459 and 4470 with no pickup call, and 4462 called at 12:40; four
open estimates, the oldest $1,340.00 on a 2019 pickup sent Monday at 9:12, two to customers
with no mobile number.

The site's scenarios are dated around Tuesday 09-15. This suite's "today" is Monday 09-21,
so the same events sit in the week of 09-14, and Friday's calls note is dated 09-18.
