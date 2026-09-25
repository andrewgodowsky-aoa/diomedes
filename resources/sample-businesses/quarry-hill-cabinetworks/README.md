# Quarry Hill Cabinetworks (sample business)

**Fictional.** Quarry Hill Cabinetworks, its clients, its sheet-goods supplier (Brookfield
Panel Supply) and its staff are invented for demonstrating Nectovia. No real business is
described. Phone numbers are in the 555-0100 to 555-0199 range and email addresses are on
example.com.

A four-person cabinet and furniture shop: owner Mara Ellison, shop lead Tomas Reyes,
finisher June Albright and installer Ray Dunleavy. Sheet goods arrive on Tuesdays and are
counted on Monday and Friday. Five jobs: a vanity and linen tower (K-104) that went over on
sheet stock after a remake, a walnut dining table (KEL-07), a white oak bookcase (PEN-05), a
kitchen install on its punch list (MAR-11) and a walnut credenza not yet started (ALV-02).

- `workspace/` the shop's files, copied into the project folder by a reset.
- `planted.md` every planted problem, with the exact file and row. Checked by `npm run samples:check`.
- `scenarios.md` requests to hand Nectovia, and what a good answer contains.

## What it matches on the site

The woodworking trade page and its three scenarios in `src/data/scenarios.ts`:

- "How much walnut ply is left after Tuesday's delivery?": eleven sheets. Tuesday's
  delivery added fifteen, four went to the Keller table on Wednesday, and the Friday count
  shows 11 on row 9.
- K-104: five sheets of 1/4 MDF issued, four cut and one returned whole, against an
  allowance of three; 128 square feet cut, 95 in parts, 25 in three labelled remnants and 8
  in kerf and waste; the remake traced to the sink opening measured again on 09-11; the
  change order not approved yet.
- MAR-11: six open punch items, four the installer's and two the finisher's, three with a
  photo; rows 5 and 9 closed with no check recorded.

The site's scenario dates (a delivery on the Tuesday before, an issue on 09-03) are re-dated
into the week of 09-14 so they sit before this suite's "today", Monday 09-21. The site names
some sources `.pdf`; here every file is `.csv` or `.md`.
