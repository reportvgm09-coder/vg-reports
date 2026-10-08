# VG Reports

Reports for VG Marketing that Marg doesn't give well: receivables and payables ageing, overdue follow-up, collections, item-wise sales and purchase, and orders. Marg data comes from Excel files exported and uploaded each day. Orders are read live from the Sales Order app's database, **read-only**. This app never changes the Sales Order app or Marg.

## Pages

| Page | What it shows |
|---|---|
| **Dashboard** | This month's sales, collections, purchase, what's due to suppliers in 15 days, orders pending dispatch; then receivables, age buckets, top overdue buyers |
| **Follow-up** | Buyers with overdue bills, biggest first, with one-tap **Call** and **WhatsApp** (the message lists the overdue bills) |
| **Receivables** | Party-wise outstanding split 0–30 / 31–60 / 61–90 / 91–120 / 120+ days, and bill-wise ageing; filter by overdue, over credit limit, salesman |
| **Collections** | Receipts by day and by buyer for any date range |
| **Sales** | Item-wise sales by brand, buyer, item or bill for any period, compared with the previous period; monthly/daily trend; **Buyers gone quiet** (bought before, nothing in 60 days) |
| **Orders** | Pending orders from the Sales Order app by customer, brand, exhibition/salesman or season; on hold; order lines |
| **Purchase** | Item-wise purchases by brand, supplier, item or bill |
| **Payables** | What you owe suppliers: past due, falling due in 15 days, age buckets, bills in the order they need paying |
| **Buyer page** | Pending bills, recent payments, what they buy (brands, last 12 months), orders still to dispatch, settings (credit days, limit, mobile, salesman) |
| **Supplier page** | Pending bills by due date, purchases by month, credit days |
| **Upload** | The five Marg files; columns are matched automatically and remembered for next time |
| **Settings** | Default credit days for buyers (60) and suppliers (120); buyer and supplier lists |

Every table has a **Download** button that opens in Excel.

### How due dates work
Due date = bill date + credit days. Credit days come from the party's own setting in this app; otherwise Marg's due date (if the file has one); otherwise the default in Settings.

Example: a ₹25,000 bill dated 01-07-2026 with the default 60 days is due 30-08-2026. On 08-10-2026 it is 39 days overdue and sits in the 91–120 days bucket (99 days old).

Negative balances are shown as **advances**: for a buyer, a payment or credit note not yet adjusted ("Cr" in Marg); for a supplier, money paid in advance ("Dr"). They are netted in the totals. Adjustments are still made in Marg.

## Marg files to upload

| File | How often | What happens on upload |
|---|---|---|
| Bill-wise outstanding of **debtors** | Daily | Replaces the previous one |
| **Receipt** register (last few days) | Daily | Adds new receipts, skips ones already there |
| **Item-wise sale** register (any date range) | Daily | Replaces sales already uploaded for those dates |
| **Item-wise purchase** register (any date range) | Weekly or daily | Replaces purchases already uploaded for those dates |
| Bill-wise outstanding of **creditors** | Weekly or daily | Replaces the previous one |

The first time, check the column preview carefully (the brand is usually Marg's **Company** column). After that the app remembers which column is which. Both flat lists and Marg's grouped layout (a bill or party heading followed by its lines) are read.

## Orders from the Sales Order app (read-only)

The Orders page reads the Sales Order app's MongoDB Atlas database. Its figures are worked out exactly the way the Sales Order app's own Reports page does (per brand: pending value = rate × pending pieces; dispatched value = actual dispatch amounts where entered). This was checked by running the Sales Order app's Python code and this app's code on the same data.

**Use a read-only database user**, so nothing in this app can ever change your orders:

1. Open MongoDB Atlas → your project → **Database Access** → **Add New Database User**.
2. Password login. Username e.g. `vg-reports-readonly`, with a strong password.
3. Under **Database User Privileges** choose **Specific Privileges** → `read` on database `sale_order_db` (or the built-in role *Only read any database*).
4. Copy the connection string you already use for the Sales Order app and swap in this new username and password.
5. Put it in Render as `ORDERS_MONGO_URL`.

Customers are matched to Marg buyers by name (also "name + city"). Any that don't match are listed on **Orders → Link them**, where you pick the Marg buyer once.

## Deploying on Render
1. Render dashboard → **New → Blueprint** → choose this repo. It creates the web app and a separate PostgreSQL database (`render.yaml`).
2. When asked, fill in `APP_USERS` (logins as `name:password` pairs, e.g. `owner:StrongPass1,accounts:StrongPass2`) and `ORDERS_MONGO_URL` (above; leave blank to skip orders for now).
3. Open the app URL and log in.

**Database plan:** the blueprint starts on Render's free database plan. Render's free databases have time and size limits (check Render's current terms); move the database to a paid plan before relying on it, or the data can be lost. The free web service also sleeps when idle, so the first page after a quiet spell takes a little longer.

## Running locally
```
cp .env.example .env        # fill in a local Postgres URL
npm install
node --env-file=.env src/server.js
npm test
```

## Code map
- `src/excel.js`: reads Marg Excel (.xls/.xlsx/.csv), finds the header row, matches columns, handles grouped layouts, Indian dates and `Dr`/`Cr` amounts
- `src/ageing.js`: due dates, buckets, party roll-up (used for both receivables and payables)
- `src/orders.js`: read-only Sales Order database access and its order maths
- `src/routes/`: pages (`reports` receivables/collections/buyer, `payables`, `registers` sales/purchase, `orders`, `upload`, `settings`)
- `src/schema.sql`: tables, created/updated automatically on start
- `test/`: unit tests (`npm test`)

## Notes
- Uses the npm `xlsx` package (0.18.5). It only reads your own Marg exports after login, which keeps the known issues in that version low-risk.
- Real Marg files (`.xls`, `.xlsx`, `.csv`) are git-ignored so buyer data never lands in the repo.
