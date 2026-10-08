// Reading Marg Excel exports: find the header row, match columns,
// and turn rows into clean records. Pure functions, no database.
const XLSX = require('xlsx');

// Field definitions per upload kind. Aliases are matched against header
// text after lower-casing and stripping dots / extra spaces.
const FIELDS = {
  outstanding: [
    { key: 'party', label: 'Party name', required: false,
      aliases: ['party name', 'party', 'customer name', 'customer', 'account name', 'ledger name', 'ledger', 'name of party', 'buyer'] },
    { key: 'bill_no', label: 'Bill no.', required: false,
      aliases: ['bill no', 'bill number', 'invoice no', 'inv no', 'voucher no', 'vch no', 'ref no', 'reference no', 'bill'] },
    { key: 'bill_date', label: 'Bill date', required: true,
      aliases: ['bill date', 'invoice date', 'inv date', 'vch date', 'voucher date', 'date'] },
    { key: 'bill_amount', label: 'Bill amount', required: false,
      aliases: ['bill amount', 'bill amt', 'invoice amount', 'inv amount', 'inv amt', 'net amount', 'amount', 'total'] },
    { key: 'balance', label: 'Balance (pending)', required: true,
      aliases: ['balance', 'bal amount', 'bal amt', 'balance amount', 'pending amount', 'pending', 'outstanding', 'due amount', 'net balance', 'bal'] },
    { key: 'due_date', label: 'Due date', required: false,
      aliases: ['due date', 'due on'] },
  ],
  receipts: [
    { key: 'party', label: 'Party name', required: false,
      aliases: ['party name', 'party', 'customer name', 'customer', 'account name', 'ledger name', 'ledger', 'particulars', 'received from'] },
    { key: 'date', label: 'Receipt date', required: true,
      aliases: ['receipt date', 'vch date', 'voucher date', 'date'] },
    { key: 'voucher_no', label: 'Voucher / receipt no.', required: false,
      aliases: ['receipt no', 'voucher no', 'vch no', 'rcpt no', 'ref no', 'cheque no', 'chq no'] },
    { key: 'amount', label: 'Amount received', required: true,
      aliases: ['amount received', 'received amount', 'receipt amount', 'amount', 'credit', 'cr amount', 'cr', 'received'] },
    { key: 'mode', label: 'Mode (cash/bank/UPI)', required: false,
      aliases: ['mode', 'payment mode', 'pay mode', 'cash/bank', 'bank', 'account'] },
    { key: 'narration', label: 'Narration', required: false,
      aliases: ['narration', 'remarks', 'remark', 'description'] },
  ],
};

function normHeader(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[.:#()_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read the first sheet of an .xls/.xlsx/.csv buffer as an array of rows. */
function readRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  return rows.map((r) => r.map((c) => (c instanceof Date ? toIso(c) : c)));
}

function toIso(d) {
  // SheetJS dates are local-midnight; read the calendar parts directly.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Look through the first 40 rows for the row that matches the most field
 * aliases. Returns { headerRow, mapping } where mapping is field -> column.
 */
function detectHeader(rows, kind) {
  const fields = FIELDS[kind];
  let best = { headerRow: -1, mapping: {}, score: 0 };
  const limit = Math.min(rows.length, 40);
  for (let r = 0; r < limit; r++) {
    const mapping = matchColumns(rows[r], fields);
    const score = Object.keys(mapping).length;
    if (score > best.score) best = { headerRow: r, mapping, score };
  }
  return { headerRow: best.headerRow, mapping: best.mapping };
}

function matchColumns(row, fields) {
  const headers = row.map(normHeader);
  const used = new Set();
  const mapping = {};
  // Pass 1: exact alias matches (in alias priority order); pass 2: "contains".
  for (const pass of ['exact', 'contains']) {
    for (const f of fields) {
      if (mapping[f.key] !== undefined) continue;
      for (const alias of f.aliases) {
        const idx = headers.findIndex((h, i) =>
          !used.has(i) && h && (pass === 'exact' ? h === alias : alias.length > 3 && h.includes(alias)));
        if (idx !== -1) { mapping[f.key] = idx; used.add(idx); break; }
      }
    }
  }
  return mapping;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Parse many date shapes to 'YYYY-MM-DD'. Indian day-first order assumed. */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null; // not a plausible Excel serial
    const d = XLSX.SSF.parse_date_code(v);
    return valid(d.y, d.m, d.d);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) return valid(year(m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\/.\-\s]([A-Za-z]{3,4})[\/.\-\s,]*(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return valid(year(m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
function year(y) { y = +y; return y < 100 ? 2000 + y : y; }
function valid(y, mo, d) {
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parse '1,23,456.50', '5000 Dr', '(500)', '500 Cr' -> number (Cr/brackets negative). */
function parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  let sign = 1;
  if (/cr\.?$/i.test(s)) { sign = -1; s = s.replace(/cr\.?$/i, ''); }
  else if (/dr\.?$/i.test(s)) { s = s.replace(/dr\.?$/i, ''); }
  if (/^\(.*\)$/.test(s)) { sign = -sign; s = s.slice(1, -1); }
  s = s.replace(/[₹,\s]|rs\.?/gi, '');
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * parseFloat(s);
}

/** Normalised party key so 'M/s. Sharma Traders,' and 'SHARMA  TRADERS' match. */
function partyKey(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/^M\s*\/\s*S\.?\s*/, '')
    .replace(/[.,'"()]/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

const TOTAL_RE = /\b(total|grand total|sub total|subtotal|opening|closing)\b/i;

/**
 * Turn rows into records. If the party column is missing or empty, Marg's
 * grouped layout is assumed: a party heading row followed by its bills.
 */
function extractRecords(rows, kind, mapping, headerRow) {
  const dateKey = kind === 'outstanding' ? 'bill_date' : 'date';
  const amtKey = kind === 'outstanding' ? 'balance' : 'amount';
  const records = [];
  const skipped = [];
  let currentParty = '';

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const cells = row.map(cleanText);
    if (cells.every((c) => c === '')) continue;
    const rowText = cells.join(' ');

    const get = (k) => (mapping[k] === undefined || mapping[k] < 0 ? '' : row[mapping[k]]);
    const date = parseDate(get(dateKey));
    const amount = parseAmount(get(amtKey));
    const partyCell = cleanText(get('party'));

    if (TOTAL_RE.test(rowText) && !date) continue; // total / opening lines

    if (!date && (!partyCell || amount === null)) {
      // No date: in Marg's grouped layout this is a party heading line
      // (sometimes with the party total beside it).
      const firstText = cells.find((c) => c && parseAmount(c) === null && !parseDate(c));
      if (firstText && !TOTAL_RE.test(firstText)) currentParty = partyCell || firstText;
      else if (amount !== null) skipped.push({ row: r + 1, reason: 'no valid date' });
      continue;
    }

    const party = partyCell || currentParty;
    if (!party || amount === null || (!date && kind === 'receipts')) {
      skipped.push({ row: r + 1, reason: !party ? 'no party' : amount === null ? 'no amount' : 'no valid date' });
      continue;
    }
    if (amount === 0) continue;

    if (kind === 'outstanding') {
      records.push({
        party_name: party,
        party_key: partyKey(party),
        bill_no: cleanText(get('bill_no')),
        bill_date: date,
        bill_amount: parseAmount(get('bill_amount')),
        balance: amount,
        marg_due_date: parseDate(get('due_date')),
      });
    } else {
      records.push({
        party_name: party,
        party_key: partyKey(party),
        receipt_date: date,
        voucher_no: cleanText(get('voucher_no')),
        amount: Math.abs(amount),
        mode: cleanText(get('mode')),
        narration: cleanText(get('narration')),
      });
    }
  }
  return { records, skipped };
}

module.exports = {
  FIELDS, readRows, detectHeader, extractRecords,
  parseDate, parseAmount, partyKey, normHeader,
};
