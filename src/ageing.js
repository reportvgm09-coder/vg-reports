// Ageing maths. Pure functions, dates are 'YYYY-MM-DD' strings.

const BUCKETS = [
  { key: 'b0_30', label: '0–30 days', max: 30 },
  { key: 'b31_60', label: '31–60 days', max: 60 },
  { key: 'b61_90', label: '61–90 days', max: 90 },
  { key: 'b91_120', label: '91–120 days', max: 120 },
  { key: 'b120p', label: 'Over 120 days', max: Infinity },
];

function todayIST() {
  const now = new Date(Date.now() + 330 * 60 * 1000); // UTC+5:30
  return now.toISOString().slice(0, 10);
}

function toUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysBetween(fromIso, toIso) {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / 86400000);
}

function addDays(iso, n) {
  return new Date(toUtc(iso) + n * 86400000).toISOString().slice(0, 10);
}

function bucketFor(age) {
  return BUCKETS.find((b) => age <= b.max).key;
}

/**
 * Age one bill.
 * Due date rule: the buyer's credit days set in this app win; otherwise
 * Marg's due date if the file had one; otherwise the default credit days.
 */
function ageBill(bill, asOf, partyCreditDays, defaultCreditDays) {
  const out = { ...bill };
  if (bill.balance < 0) {
    out.status = 'advance'; // unadjusted payment / credit note sitting on account
  }
  if (!bill.bill_date) {
    out.age = null;
    out.bucket = 'undated';
    out.due_date = null;
    out.overdue_days = null;
    out.status = out.status || 'undated';
    return out;
  }
  out.age = Math.max(0, daysBetween(bill.bill_date, asOf));
  out.bucket = bucketFor(out.age);
  if (partyCreditDays !== null && partyCreditDays !== undefined) {
    out.due_date = addDays(bill.bill_date, partyCreditDays);
  } else if (bill.marg_due_date) {
    out.due_date = bill.marg_due_date;
  } else {
    out.due_date = addDays(bill.bill_date, defaultCreditDays);
  }
  out.overdue_days = daysBetween(out.due_date, asOf);
  if (!out.status) out.status = out.overdue_days > 0 ? 'overdue' : 'not_due';
  return out;
}

/** Roll aged bills up to one line per party. */
function summarizeParties(agedBills, partyInfo) {
  const map = new Map();
  for (const b of agedBills) {
    let p = map.get(b.party_key);
    if (!p) {
      const info = partyInfo.get(b.party_key) || {};
      p = {
        party_key: b.party_key,
        party_name: info.display_name || b.party_name,
        phone: info.phone || '',
        salesman: info.salesman || '',
        credit_days: info.credit_days ?? null,
        credit_limit: info.credit_limit ?? null,
        total: 0, overdue: 0, not_due: 0, advance: 0, undated: 0,
        oldest_age: 0, max_overdue_days: 0, bills: 0,
      };
      for (const bk of BUCKETS) p[bk.key] = 0;
      map.set(b.party_key, p);
    }
    p.total += b.balance;
    p.bills += 1;
    if (b.status === 'advance') p.advance += b.balance;
    else if (b.bucket === 'undated') p.undated += b.balance;
    else {
      p[b.bucket] += b.balance;
      if (b.status === 'overdue') {
        p.overdue += b.balance;
        p.max_overdue_days = Math.max(p.max_overdue_days, b.overdue_days);
      } else p.not_due += b.balance;
      p.oldest_age = Math.max(p.oldest_age, b.age);
    }
  }
  const list = [...map.values()].map((p) => ({
    ...p,
    over_limit: p.credit_limit !== null && p.credit_limit > 0 && p.total > p.credit_limit,
  }));
  list.sort((a, b) => b.overdue - a.overdue || b.total - a.total);
  return list;
}

function totals(parties) {
  const t = { total: 0, overdue: 0, not_due: 0, advance: 0, undated: 0, parties: parties.length, over_limit: 0, overdue_parties: 0 };
  for (const bk of BUCKETS) t[bk.key] = 0;
  for (const p of parties) {
    t.total += p.total; t.overdue += p.overdue; t.not_due += p.not_due;
    t.advance += p.advance; t.undated += p.undated;
    for (const bk of BUCKETS) t[bk.key] += p[bk.key];
    if (p.over_limit) t.over_limit += 1;
    if (p.overdue > 0) t.overdue_parties += 1;
  }
  return t;
}

module.exports = { BUCKETS, todayIST, daysBetween, addDays, ageBill, summarizeParties, totals, bucketFor };
