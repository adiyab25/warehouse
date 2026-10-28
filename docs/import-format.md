# Importing opening stock (CSV)

This is how the stock you already have on the shelves goes into the system **once**, on day one. It is strict on purpose: the numbers you import become the starting point of every report. If anything in the file is wrong, **nothing** is saved and you get a list of every problem with its line number.

## 1. The file

One CSV file, one row per item per location. The first line is a header with these 8 columns (any order, capital letters don't matter), plus one **optional** 9th column, `discrete`:

| sku | name_ar | family | uom | pack_factor | cost_egp | location_code | qty | discrete (optional) |
|---|---|---|---|---|---|---|---|---|
| PEN-0001 | قلم حبر أزرق | consumable | unit | 12 | 5.50 | MAIN | 240 | |
| RIC-0001 | أرز مصري | sellable | kg | 25 | 32.75 | BR1 | 150.5 | |
| FAB-0001 | قماش قطني | consumable | متر | 1 | 80.00 | MAIN | 12.5 | |
| KEY-0001 | قماش مخصوص | consumable | ذراع | 1 | 3.00 | MAIN | 12.5 | no |

A ready-made example (without the optional column) is in `docs/opening-sample.csv`; a file **without** the `discrete` column works exactly as before.

- **sku** — the item code, like `PEN-0001`: letters/digits joined by hyphens. It is also printed on the label, so it must be something the scanner can read. Capitals don't matter (`pen-0001` becomes `PEN-0001`).
- **name_ar** — the Arabic name. Not empty, at most 200 characters, no line breaks.
- **family** — exactly one of `sellable`, `consumable`, `asset`.
- **uom** — the unit, e.g. `unit`, `ream`, `kg`, `متر` (at most 20 characters).
- **pack_factor** — how many units in one pack, a whole number above zero (use `1` if there are no packs).
- **cost_egp** — cost per unit in pounds, up to 2 decimals (`120.50`). Zero is allowed.
- **location_code** — a place that **already exists** in the system (`MAIN`, `BR1`…). Capitals/spaces don't matter.
- **qty** — how many you have, up to 3 decimals.
- **discrete** *(optional)* — can this item only be counted in whole numbers? `yes` (whole units only) or `no` (fractions allowed). Also accepted: `true`, `false`, `1`, `0`, in any capitals, with spaces around. Only plain Latin letters/digits: `نعم` or `١` are refused. **Blank (or no such column) = decide from the unit** (next section). Any other value is an error on that line naming the allowed values.

### 1a. Whole units or fractions? (read this if you sell by the metre, kilo, litre…)

**This is decided once, when the item is created, and the import cannot change it afterwards** (nothing in the system edits it yet). So get it right the first time, and always read the line the dry run prints for each new item: it says `counted in whole units` or `may be fractional`, and whether that was `(given)` by your `discrete` column or `(derived)` from the unit.

When `discrete` is blank, a **new** item may be fractional only if its unit — after removing spaces, capitals and one trailing dot (`KG.` = `kg`) — is one of:

- Latin: `kg`, `g`, `gram`, `l`, `litre`, `liter`, `ml`, `m`, `metre`, `meter`, `cm`, `mm`, `ton`, `tonne`, `yard`, `yd`
- Arabic: `كيلو`, `كجم`, `جرام`, `جم`, `لتر`, `متر`, `سم`, `طن`, `ياردة`

**Every other unit is counted in whole units** (`unit`, `box`, `قطعة`, `علبة`, `m2`, `roll`…).

So if you sell fabric by `ذراع`, `لفة` or any unit not in the list and a quantity like `12.5` is possible, **write `no` in the `discrete` column for that item**. If a unit *is* in the list but the item is really counted whole (say `l` for a bottle), write `yes`. If one item appears on several rows, you only need to give the value on one of them; two rows that give *different* values are an error.

For an item that **already exists**, the stored flag is used. If you give a `discrete` value and it differs from what is stored, that is an error showing both values; a blank cell is never compared.

If you get the error `item X is counted in whole units, so qty 12.5 is not allowed`: either the quantity is wrong (fix it), or the item may be fractional — put `no` in the `discrete` column and import again (only possible while the item is still new).

## 2. The rules (one line each)

1. Nothing is saved unless the **whole** file is clean. One bad row = nothing saved.
2. A normal run is a **dry run**: it shows what would happen and saves nothing. Add `--apply` to really save.
3. Running the same file again changes nothing (rows show as "unchanged", and the result says `NOTHING TO DO`).
4. Running a file again with a **different** quantity for the same item and location is an **error** — it is never silently ignored.
5. The same item at the same location twice in one file is refused (merge the rows). The same item at **different** locations is fine.
6. Opening stock must come **first**: if an item already has any movement (a receipt, a sale…) at that location, the row is refused.
7. An item that already exists must match the file exactly (name, family, unit, pack, cost, and `discrete` if you give it). The import never changes an existing item — edit the item itself instead.
8. New items are created for you. The barcode is the same as the sku. Whole units or fractions: see 1a.
9. Locations are never created by the import. The location must be active and be a warehouse, branch or quarantine place.
10. Numbers use plain digits `0-9` and a dot: no `1,200`, no `1,5`, no Arabic digits `١٢٣`, no `1e3`, no `£`, no minus, no `+`. A **blank** number is an error.
11. A `qty` of exactly `0` is skipped (and counted in the summary).
12. Every posted movement records who imported it, and a note with the file name and line number.
13. Two imports for the same business never run at the same time; the second waits.
14. **Limits:** the file must be UTF-8, at most **5 MB** and at most **20,000 rows**. A single file may post opening stock for at most **4,000 items that already exist** (new items have no such limit). If you hit a limit, **split the file by location or by SKU range** (for example one file per location, or A–M and N–Z) and import the pieces **one after the other**.
15. **Run one import at a time.** Each existing item in a file holds a lock until the save finishes. Three or more big imports at once can exhaust the database's shared lock memory and fail with "out of shared memory". Wait for one to print its result before starting the next.

**What is forgiven:** spaces before/after any value, non-breaking spaces (the kind Excel pastes in), a stray carriage return at the end of a line, lower/upper case in sku, family, location and header names, and blank or `,,,,` lines (these are skipped; line numbers still count them). **What is never forgiven:** a value that is blank where one is required, and invisible characters *inside* a name, sku, unit or location code (see section 5).

## 3. Saving it from Excel

Choose **File → Save As → "CSV UTF-8 (Comma delimited) (*.csv)"**. Do **not** choose plain "CSV": it uses an old Windows Arabic encoding and the Arabic text would be garbled (the import detects this and refuses).

## 4. Running it on Windows

You need three things: the **tenant id**, a **username** (an owner or warehouse manager), and the **path of the CSV**.

**Finding the tenant id.** Each installation serves one business, and its id is written in the settings file `.env` in the application folder, on the line `TENANT_ID="…"` (a long code like `11111111-2222-3333-4444-555555555555`). Open `.env` in Notepad and copy the value between the quotes. If that file is not available, whoever runs the database can read it with the **database owner** account (the application account cannot list businesses, on purpose):

```sql
select id, name from tenants order by name;
```

**Tell the program how to reach the database.** Use the *application* connection string (`APP_DATABASE_URL` in `.env`; never the owner/superuser one — the import refuses it). The program does not read `.env` by itself, so set it in the window you will run the import from, then run from the application folder. Quote any path with spaces. Arabic folder names work as they are.

PowerShell:

```powershell
cd "C:\Users\Owner\warehouse"
$env:APP_DATABASE_URL = "postgresql://app_user:PASSWORD@localhost:5432/warehouse"
# 1) dry run: saves nothing
npm run import:opening -- --tenant 11111111-2222-3333-4444-555555555555 --user owner_x --file "C:\Users\Owner\Documents\مخزون المستودع\opening stock.csv"
# 2) when it says RESULT: dry run OK, save for real
npm run import:opening -- --tenant 11111111-2222-3333-4444-555555555555 --user owner_x --file "C:\Users\Owner\Documents\مخزون المستودع\opening stock.csv" --apply
```

cmd (Command Prompt):

```bat
cd /d "C:\Users\Owner\warehouse"
set "APP_DATABASE_URL=postgresql://app_user:PASSWORD@localhost:5432/warehouse"
npm run import:opening -- --tenant 11111111-2222-3333-4444-555555555555 --user owner_x --file "C:\Users\Owner\Documents\مخزون المستودع\opening stock.csv"
npm run import:opening -- --tenant 11111111-2222-3333-4444-555555555555 --user owner_x --file "C:\Users\Owner\Documents\مخزون المستودع\opening stock.csv" --apply
```

(Replace `PASSWORD`, the tenant id, the user name and the path with yours. Do not paste the password anywhere else, and do not send it to anyone.) If Arabic letters in the folder name look like `???` in an old cmd window, run `chcp 65001` first, or move the file to a folder with a Latin name.

- `--tenant` is required (there is no default). `--user` must be an **owner** or **warehouse manager** of that business; they are recorded as the person who imported.
- Exit code `0` = clean dry run or saved (or nothing to do); `1` = the import failed, nothing saved; `2` = the command line was wrong.
- The last line says what happened: `RESULT: dry run OK` (nothing saved yet), `RESULT: SAVED.`, `RESULT: NOTHING TO DO — every line was already imported` (a re-run; nothing new was written), or `RESULT: FAILED — nothing was saved.` The program only prints `SAVED` after the database confirmed the save.
- Anything it prints that came from your file (a name, a code) is shown safely: invisible or control characters appear as `\u202e`-style text, and long values are cut at 60 characters.

## 5. What the messages mean, and what to do

At most 50 errors are printed, then `... and N more`. Fix them all, then run again — nothing was saved.

| Message (shortened) | What it means / what to do |
|---|---|
| `unknown location "X"` | No location with that code. Fix the code in the file, or create the location in the system first. |
| `location "X" is a transit/vendor/bin… location` | Opening stock can only go in a warehouse, branch or quarantine place. Use another location. |
| `location "X" is inactive` | Reactivate the location in the system first. |
| `duplicate of line N` | The same item + location is listed twice. Merge into one row (add the quantities). |
| `already imported with a different quantity: stored A, this file says B` | A posted opening balance is not changed by importing again. Remove the row, or correct it with a **count session**. |
| `already has stock movements at X … double count` | Trading already started for that item there. Remove the row; fix the number with a **count session**. |
| `item X already exists but <field> differs` | The file disagrees with the existing item (this includes `discrete`). Fix the file so it matches the item, or edit the item first. |
| `item X is deactivated` | Reactivate the item in the system, then import again. |
| `code X is already used as the barcode of item Y` | A new sku equals another item's barcode. Use a different sku. |
| `sku "X" is not a code the scanner can read` | Use letters/digits joined by hyphens, like `PEN-0001`. |
| `… contains a hidden character` (name_ar, sku, uom, location_code) | An invisible mark (zero-width space, left-to-right/right-to-left override, BOM) is inside the value — often from copy/paste. Delete the cell's text and type it again. |
| `… contains a control character` | A line break or similar inside the cell. Retype it on one line. |
| `discrete "X" is not allowed` | Use `yes`, `no`, `true`, `false`, `1`, `0`, or leave it blank. |
| `item X is counted in whole units, so qty N is not allowed` | See 1a: fix the quantity, or put `no` in the `discrete` column if the item can be fractional. |
| `qty … has a thousands separator / uses a comma as the decimal point / Arabic-Indic digits / scientific notation / is negative / is blank` | Retype the number with plain digits and a dot. |
| `this row has N value(s) but the header has M` | A comma too many/few, or a name with a comma that isn't in quotes (`"قلم, أزرق"`). |
| `the file is not valid UTF-8` | Re-save from Excel as **CSV UTF-8**. |
| `header is missing / has unknown / repeats column(s)` | The first line must have the 8 required column names (and optionally `discrete`), each once. |
| `the file is larger than 5 MB` / `… data rows; the limit is 20000` | Split the file by location or SKU range and import the pieces one at a time. |
| `… items that already exist; the limit is 4000 per file` | Split the file by location or SKU range (see rule 14). |
| `movements appeared at this location while importing` | Someone posted stock for that item while the import ran. Nothing was saved; run it again. |
| `user "X" does not exist in this tenant` / `only an owner or warehouse_manager…` | Use the username of an owner or warehouse manager of that business. |
| `refusing to serve as role …` | The database connection is the owner/superuser. Point `APP_DATABASE_URL` at the application user. |
| `APP_DATABASE_URL is not set` | Set it in the same window first (see section 4). |
| `the transaction was rolled back instead of committed` | The database did not save. Nothing was written; run the dry run again and tell your technician if it repeats. |

## 6. Correcting a number after it is posted

Never re-import. A posted opening balance is part of the permanent record. Start a **count session** for that location: count the shelf, and the system posts a correction that keeps the history.
