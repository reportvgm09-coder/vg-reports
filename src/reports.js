// Database queries that feed the report pages.
const { pool, getSetting } = require('./db');
const { ageBill, summarizeParties, totals, todayIST } = require('./ageing');

// The two sides share one engine: buyers owe us (receivables, 'outstanding'
// uploads, parties table) and we owe suppliers (payables, vendors table).
const SIDES = {
  receivable: { kind: 'outstanding', table: 'parties', setting: 'default_credit_days', fallback: 60 },
  payable: { kind: 'payables', table: 'vendors', setting: 'default_vendor_credit_days', fallback: 120 },
};

async function defaultCreditDays(side = 'receivable') {
  const s = SIDES[side];
  const v = parseInt(await getSetting(s.setting, String(s.fallback)), 10);
  return Number.isFinite(v) && v >= 0 ? v : s.fallback;
}

async function latestOutstandingUpload(side = 'receivable') {
  const { rows } = await pool.query(
    'SELECT * FROM uploads WHERE kind = $1 ORDER BY id DESC LIMIT 1', [SIDES[side].kind]);
  return rows[0] || null;
}

async function partyInfoMap(side = 'receivable') {
  const { rows } = await pool.query(`SELECT * FROM ${SIDES[side].table}`);
  return new Map(rows.map((r) => [r.party_key, r]));
}

/** Supplier dues, same shape as receivables(). */
function payables() { return outstanding('payable'); }
function receivables() { return outstanding('receivable'); }

/**
 * Latest outstanding snapshot for one side, every bill aged as of today.
 * Returns { upload, asOf, bills, parties, totals, defaultDays }.
 */
async function outstanding(side) {
  const upload = await latestOutstandingUpload(side);
  const defaultDays = await defaultCreditDays(side);
  const asOf = todayIST();
  if (!upload) return { upload: null, asOf, bills: [], parties: [], totals: totals([]), defaultDays };

  const info = await partyInfoMap(side);
  const { rows } = await pool.query(
    `SELECT party_key, party_name, bill_no, bill_date, bill_amount, balance, marg_due_date
       FROM outstanding_bills WHERE upload_id = $1
      ORDER BY bill_date NULLS LAST, bill_no`, [upload.id]);

  const bills = rows.map((b) => {
    const p = info.get(b.party_key);
    const aged = ageBill(b, asOf, p ? p.credit_days : null, defaultDays);
    aged.party_name = (p && p.display_name) || b.party_name;
    return aged;
  });
  const parties = summarizeParties(bills, info);
  return { upload, asOf, bills, parties, totals: totals(parties), defaultDays };
}

/** Collections between two dates (inclusive). */
async function collections(from, to) {
  const { rows } = await pool.query(
    `SELECT r.*, COALESCE(p.display_name, r.party_name) AS name
       FROM receipts r LEFT JOIN parties p ON p.party_key = r.party_key
      WHERE r.receipt_date BETWEEN $1 AND $2
      ORDER BY r.receipt_date DESC, name`, [from, to]);
  return rows;
}

async function collectionTotal(from, to) {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS n FROM receipts WHERE receipt_date BETWEEN $1 AND $2',
    [from, to]);
  return rows[0];
}

/** Make sure every party seen in uploads has a row (for settings). */
async function ensureParties(records, side = 'receivable') {
  const seen = new Map();
  for (const r of records) if (!seen.has(r.party_key)) seen.set(r.party_key, r.party_name);
  if (!seen.size) return;
  await pool.query(
    `INSERT INTO ${SIDES[side].table} (party_key, display_name)
     SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (party_key) DO NOTHING`,
    [[...seen.keys()], [...seen.values()]]);
}

module.exports = {
  receivables, payables, outstanding, collections, collectionTotal, ensureParties,
  defaultCreditDays, latestOutstandingUpload, partyInfoMap, SIDES,
};
