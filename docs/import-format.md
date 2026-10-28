# Importing opening stock (CSV)

This is how the stock you already have on the shelves goes into the system **once**, on day one. It is strict on purpose: the numbers you import become the starting point of every report. If anything in the file is wrong, **nothing** is saved and you get a list of every problem with its line number.

## 1. The file

One CSV file, one row per item per location. The first line is a header with exactly these 8 columns (any order, capital letters don't matter):

| sku | name_ar | family | uom | pack_factor | cost_egp | location_code | qty |
|---|---|---|---|---|---|---|---|
| PEN-0001 | قلم حبر أزرق | consumable | unit | 12 | 5.50 | MAIN | 240 |
| PPR-0001 | ورق تصوير A4 | consumable | ream | 5 | 120.50 | MAIN | 40 |
| RIC-0001 | أرز مصري | sellable | kg | 25 | 32.75 | BR1 | 150.5 |

A ready-made example is in `docs/opening-sample.csv`.

- **sku** — the item code, like `PEN-0001`: letters/digits joined by hyphens. It is also printed on the label, so it must be something the scanner can read. Capitals don't matter (`pen-0001` becomes `PEN-0001`).
- **name_ar** — the Arabic name. Not empty, at most 200 characters, no line breaks.
- **family** — exactly one of `sellable`, `consumable`, `asset`.
- **uom** — the unit, e.g. `unit`, `ream`, `kg` (at most 20 characters).
- **pack_factor** — how many units in one pack, a whole number above zero (use `1` if there are no packs).
- **cost_egp** — cost per unit in pounds, up to 2 decimals (`120.50`). Zero is allowed.
- **location_code** — a place that **already exists** in the system (`MAIN`, `BR1`…). Capitals/spaces don't matter.
- **qty** — how many you have, up to 3 decimals.

## 2. The rules (one line each)

1. Nothing is saved unless the **whole** file is clean. One bad row = nothing saved.
2. A normal run is a **dry run**: it shows what would happen and saves nothing. Add `--apply` to really save.
3. Running the same file again changes nothing (rows show as "unchanged").
4. Running a file again with a **different** quantity for the same item and location is an **error** — it is never silently ignored.
5. The same item at the same location twice in one file is refused (merge the rows). The same item at **different** locations is fine.
6. Opening stock must come **first**: if an item already has any movement (a receipt, a sale…) at that location, the row is refused.
7. An item that already exists must match the file exactly (name, family, unit, pack, cost). The import never changes an existing item — edit the item itself instead.
8. New items are created for you. The barcode is the same as the sku. Items in `kg, g, l, ml, m, cm, mm, ton` can have fractions (150.5); every other unit must be a whole number.
9. Locations are never created by the import. The location must be active and be a warehouse, branch or quarantine place.
10. Numbers use plain digits `0-9` and a dot: no `1,200`, no `1,5`, no Arabic digits `١٢٣`, no `1e3`, no `£`, no minus, no blanks.
11. A `qty` of exactly `0` is skipped (and counted in the summary).
12. Every posted movement records who imported it, and a note with the file name and line number.
13. Two imports for the same business never run at the same time; the second waits.
14. The file must be UTF-8 and at most 5 MB / 20,000 rows. A single file may post opening stock for at most 4,000 items that **already exist** (new items have no limit); split bigger files.

## 3. Saving it from Excel

Choose **File → Save As → "CSV UTF-8 (Comma delimited) (*.csv)"**. Do **not** choose plain "CSV": it uses an old Windows Arabic encoding and the Arabic text would be garbled (the import detects this and refuses).

## 4. Running it

Dry run first (saves nothing):

```
npm run import:opening -- --tenant <tenant-id> --user <username> --file <path.csv>
```

When the dry run says `RESULT: dry run OK`, save for real:

```
npm run import:opening -- --tenant <tenant-id> --user <username> --file <path.csv> --apply
```

- `--tenant` is required (there is no default). `--user` must be an **owner** or **warehouse manager** of that business; they are recorded as the person who imported.
- It connects as the normal application database user (`APP_DATABASE_URL`) and refuses to run as the database owner/superuser.
- Exit code `0` = clean dry run or saved; `1` = the import failed, nothing saved; `2` = the command line was wrong.

## 5. What the messages mean

| Message (shortened) | What it means / what to do |
|---|---|
| `unknown location "X"` | No location with that code. Fix the code, or create the location first. |
| `location "X" is a transit/vendor/bin… location` | Opening stock can only go in a warehouse, branch or quarantine place. |
| `location "X" is inactive` | Reactivate the location first. |
| `duplicate of line N` | The same item + location is listed twice. Merge into one row. |
| `already imported with a different quantity: stored A, this file says B` | A posted opening balance is not changed by importing again. Correct it with a **count session**. |
| `already has stock movements at X … double count` | Trading already started for that item there. Fix it with a **count session**. |
| `item X already exists but <field> differs` | The file disagrees with the existing item. Fix the file (or edit the item). |
| `sku "X" is not a code the scanner can read` | Use letters/digits joined by hyphens, like `PEN-0001`. |
| `qty … has a thousands separator / uses a comma as the decimal point / Arabic-Indic digits / scientific notation / is negative / is blank` | Retype the number with plain digits and a dot. |
| `qty … is not a whole number but item … is counted in whole units` | Only kg, g, l, ml, m, cm, mm, ton can have fractions. |
| `this row has N value(s) but the header has 8` | A comma too many/few, or a name with a comma that isn't in quotes (`"قلم, أزرق"`). |
| `the file is not valid UTF-8` | Re-save from Excel as **CSV UTF-8**. |
| `header is missing / has unknown / repeats column(s)` | The first line must be exactly the 8 column names. |
| `user "X" does not exist in this tenant` / `only an owner or warehouse_manager…` | Use the username of an owner or warehouse manager of that business. |
| `refusing to serve as role …` | The database connection is the owner/superuser. Point `APP_DATABASE_URL` at the app user. |

At most 50 errors are printed, then `... and N more`.

## 6. Correcting a number after it is posted

Never re-import. A posted opening balance is part of the permanent record. Start a **count session** for that location: count the shelf, and the system posts a correction that keeps the history.
