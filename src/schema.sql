-- VG Reports schema. Safe to run on every start (idempotent).

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('default_credit_days', '60')
  ON CONFLICT (key) DO NOTHING;

-- One row per buyer. party_key is the normalised name used to match Marg rows.
CREATE TABLE IF NOT EXISTS parties (
  party_key     TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  credit_days   INTEGER,          -- NULL = use default_credit_days
  credit_limit  NUMERIC(14,2),    -- NULL = no limit set
  phone         TEXT,
  salesman      TEXT,
  city          TEXT,
  notes         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every file uploaded, kept for history.
CREATE TABLE IF NOT EXISTS uploads (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,     -- 'outstanding' | 'receipts'
  filename      TEXT NOT NULL,
  as_of_date    DATE NOT NULL,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  uploaded_by   TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Parsed file waiting for the user to confirm column mapping.
CREATE TABLE IF NOT EXISTS pending_uploads (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  filename    TEXT NOT NULL,
  rows_json   JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Snapshot of Marg's bill-wise outstanding. Each new outstanding upload
-- replaces the previous snapshot (reports always use the latest).
CREATE TABLE IF NOT EXISTS outstanding_bills (
  id          SERIAL PRIMARY KEY,
  upload_id   INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  party_key   TEXT NOT NULL,
  party_name  TEXT NOT NULL,
  bill_no     TEXT,
  bill_date   DATE,
  bill_amount NUMERIC(14,2),
  balance     NUMERIC(14,2) NOT NULL,
  marg_due_date DATE
);
CREATE INDEX IF NOT EXISTS idx_ob_upload ON outstanding_bills(upload_id);
CREATE INDEX IF NOT EXISTS idx_ob_party  ON outstanding_bills(party_key);

-- Payments received. Daily uploads may overlap, so duplicates are ignored.
CREATE TABLE IF NOT EXISTS receipts (
  id           SERIAL PRIMARY KEY,
  upload_id    INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  party_key    TEXT NOT NULL,
  party_name   TEXT NOT NULL,
  receipt_date DATE NOT NULL,
  voucher_no   TEXT NOT NULL DEFAULT '',
  amount       NUMERIC(14,2) NOT NULL,
  mode         TEXT,
  narration    TEXT,
  UNIQUE (party_key, receipt_date, voucher_no, amount)
);
CREATE INDEX IF NOT EXISTS idx_rc_date  ON receipts(receipt_date);
CREATE INDEX IF NOT EXISTS idx_rc_party ON receipts(party_key);
