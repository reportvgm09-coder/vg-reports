// Database queries that feed the report pages.
const { pool, getSetting } = require('./db');
const { ageBill, summarizeParties, totals, todayIST } = require('./ageing');

async function defaultCreditDays() {
  const v = parseInt(await getSetting('default_credit_days', '60'), 10);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

async function latestOutstandingUpload() {
  const { rows } = await pool.query(
    `SELECT * FROM uploads WHERE kind = 'outstanding' ORDER BY id DESC LIMIT 1`);
  return rows[0] || null;
}

async function partyInfoMap() {
  const { rows } = await pool.query('SELECT * FROM parties');
  return new Map(rows.map((r) => [r.party_key, r]));
}

/**
 * Latest outstanding snapshot, every bill aged as of today.
 * Returns { upload, asOf, bills, parties, totals, defaultDays }.
 */
async function receivables() {
  const upload = await latestOutstandingUpload();
  const defaultDays = await defaultCreditDays();
  const asOf = todayIST();
  if (!upload) return { upload: null, asOf, bills: [], parties: [], totals: totals([]), defaultDays };

  const info = await partyInfoMap();
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

/** Make sure every party seen in uploads has a row in parties (for settings). */
async function ensureParties(records) {
  const seen = new Map();
  for (const r of records) if (!seen.has(r.party_key)) seen.set(r.party_key, r.party_name);
  for (const [key, name] of seen) {
    await pool.query(
      `INSERT INTO parties (party_key, display_name) VALUES ($1, $2)
       ON CONFLICT (party_key) DO NOTHING`, [key, name]);
  }
}

module.exports = { receivables, collections, collectionTotal, ensureParties, defaultCreditDays, latestOutstandingUpload };
