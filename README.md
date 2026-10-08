# VG Reports

Reports for VG Marketing that Marg doesn't give well: bill-wise ageing, overdue follow-up, party-wise outstanding and collections. Data comes from Excel files exported from Marg and uploaded once a day. This app is separate from the Sales Order app and does not touch it.

## What's in it (phase 1: receivables)

| Page | What it shows |
|---|---|
| **Dashboard** | Total receivable, overdue, not yet due, collections this month vs last month, age buckets, top overdue buyers |
| **Follow-up** | Buyers with overdue bills, biggest first, with one-tap **Call** and **WhatsApp** (message lists the overdue bills) |
| **Outstanding** | Party-wise table split into 0–30 / 31–60 / 61–90 / 91–120 / 120+ days; filter by overdue, over credit limit, salesman; download to Excel |
| **Bill ageing** | Every pending bill with age, due date and status |
| **Buyer page** | Pending bills, recent payments, and settings: credit days, credit limit, mobile, salesman |
| **Collections** | Receipts by day and by buyer for any date range |
| **Upload** | Upload Marg Excel files; columns are matched automatically and remembered for the next day |

### How due dates work
Due date = bill date + credit days. Credit days come from the buyer's own setting in this app; if not set, Marg's due date (if the file has one); otherwise the default (60 days, changeable in Settings).

Example: bill of ₹25,000 dated 01-07-2026, default 60 days → due 30-08-2026 → on 08-10-2026 it is 39 days overdue and sits in the 91–120 days bucket (99 days old).

A negative balance (Marg shows "Cr", e.g. an unadjusted payment or credit note) is shown as **advance / on account** and is netted in the buyer's total. This app only reports; adjustments are still made in Marg.

## Daily routine (2 minutes)
1. In Marg, export **bill-wise outstanding of debtors** to Excel. Upload it under *Bill-wise outstanding*. It replaces yesterday's data.
2. Export the **receipt register** for the last few days. Upload it under *Receipts*. Days already uploaded are skipped automatically.
3. Open **Follow-up** and work the list.

The first time, check the column preview carefully. After that the app remembers which column is which.

## Deploying on Render
1. Render dashboard → **New → Blueprint** → choose this repo. It creates the web app and a separate PostgreSQL database (`render.yaml`).
2. When asked for `APP_USERS`, enter the logins as `name:password` pairs separated by commas, e.g. `owner:StrongPass1,accounts:StrongPass2`.
3. Open the app URL and log in.

**Database plan:** the blueprint starts on Render's free database plan. Render's free databases have time and size limits (check Render's current terms); move the database to a paid plan before relying on it, or the data can be lost.

## Running locally
```
cp .env.example .env        # fill in a local Postgres URL
npm install
node --env-file=.env src/server.js
npm test
```

## Code map
- `src/excel.js` – reads Marg Excel (.xls/.xlsx/.csv), finds the header row, matches columns, handles Marg's grouped layout (party heading followed by its bills), Indian dates, `Dr`/`Cr` amounts
- `src/ageing.js` – due dates, buckets, party roll-up
- `src/routes/` – pages (reports, upload, settings)
- `src/schema.sql` – tables, created automatically on start

## Next phases
- Sales and purchase registers, payables ageing (vendors)
- Orders from the Sales Order app via a **read-only** database connection (`ORDERS_DATABASE_URL`)

## Notes
- Uses the npm `xlsx` package (0.18.5). It only reads your own Marg exports after login, which keeps the known issues in that version low-risk.
- Real Marg files (`.xls`, `.xlsx`, `.csv`) are git-ignored so buyer data never lands in the repo.
