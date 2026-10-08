const express = require('express');
const { pool } = require('../db');
const { receivables, collections, collectionTotal } = require('../reports');
const { BUCKETS, todayIST, addDays } = require('../ageing');
const { esc, rs, rsCell, dmy, layout, statusBadge, cleanPhone } = require('../views');
const { sendCsv } = require('../csv');

const router = express.Router();

// ---------- shared bits ----------

function noDataNotice() {
  return `<div class="card empty"><h2>No outstanding data yet</h2>
    <p>Export the bill-wise outstanding report from Marg as Excel and <a href="/upload">upload it here</a>.</p></div>`;
}

function freshness(upload) {
  if (!upload) return '';
  const when = new Date(upload.uploaded_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const stale = (Date.now() - new Date(upload.uploaded_at).getTime()) > 36 * 3600 * 1000;
  return `<p class="fresh ${stale ? 'stale' : ''}">Marg outstanding file uploaded ${esc(when)}${stale ? ' · <strong>more than a day old, upload today’s file</strong>' : ''}</p>`;
}

function monthStart(iso) { return iso.slice(0, 8) + '01'; }
function prevMonthSamePeriod(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  return { from: `${py}-${p(pm)}-01`, to: `${py}-${p(pm)}-${p(Math.min(d, lastDay))}` };
}

function bucketBars(t) {
  const max = Math.max(1, ...BUCKETS.map((b) => t[b.key]));
  return `<div class="bars">${BUCKETS.map((b) => `
    <div class="bar-row">
      <span class="bar-label">${b.label}</span>
      <span class="bar-track"><span class="bar-fill ${b.max > 90 ? 'hot' : b.max > 60 ? 'warm' : ''}" style="width:${Math.max(0, (t[b.key] / max) * 100).toFixed(1)}%"></span></span>
      <a class="bar-val" href="/bills?bucket=${b.key}">${rs(t[b.key])}</a>
    </div>`).join('')}</div>`;
}

function whatsappText(party, bills, asOf) {
  const lines = [`Namaste ${party.party_name} ji,`, '',
    `Your pending balance with VG Marketing as on ${dmy(asOf)} is ${rs(party.total)}.`];
  const due = bills.filter((b) => b.status === 'overdue').slice(0, 10);
  if (due.length) {
    lines.push('', 'Overdue bills:');
    for (const b of due) lines.push(`• Bill ${b.bill_no || '-'} dt ${dmy(b.bill_date)}: ${rs(b.balance)} (${b.overdue_days} days overdue)`);
  }
  lines.push('', 'Kindly arrange the payment. Thank you.', 'VG Marketing');
  return lines.join('\n');
}

function contactButtons(party, bills, asOf) {
  const phone = cleanPhone(party.phone);
  if (!phone) return `<a class="btn small ghost" href="/party/${encodeURIComponent(party.party_key)}#edit">Add phone</a>`;
  const wa = `https://wa.me/${phone}?text=${encodeURIComponent(whatsappText(party, bills, asOf))}`;
  return `<a class="btn small" href="tel:+${phone}">Call</a> <a class="btn small wa" target="_blank" rel="noopener" href="${wa}">WhatsApp</a>`;
}

// ---------- dashboard ----------

router.get('/', async (req, res) => {
  const r = await receivables();
  const today = todayIST();
  const thisMonth = await collectionTotal(monthStart(today), today);
  const prev = prevMonthSamePeriod(today);
  const lastMonth = await collectionTotal(prev.from, prev.to);
  const last7 = await collectionTotal(addDays(today, -6), today);

  if (!r.upload) {
    return res.send(layout({ title: 'Dashboard', user: req.user, active: '/', body: noDataNotice() }));
  }
  const t = r.totals;
  const overduePct = t.total > 0 ? Math.round((t.overdue / t.total) * 100) : 0;
  const top = r.parties.filter((p) => p.overdue > 0).slice(0, 10);

  const body = `
  <h1>Receivables</h1>
  ${freshness(r.upload)}
  <div class="kpis">
    <div class="kpi"><span>Total receivable</span><strong>${rs(t.total)}</strong><small>${t.parties} buyers</small></div>
    <div class="kpi red"><span>Overdue</span><strong>${rs(t.overdue)}</strong><small>${overduePct}% · ${t.overdue_parties} buyers</small></div>
    <div class="kpi"><span>Not yet due</span><strong>${rs(t.not_due)}</strong><small>within credit period</small></div>
    <div class="kpi"><span>Collected this month</span><strong>${rs(thisMonth.total)}</strong><small>Last month same period ${rs(lastMonth.total)}</small></div>
  </div>
  ${t.advance < 0 ? `<p class="note">Advances / unadjusted payments sitting on account: <strong>${rs(t.advance)}</strong> (already netted in the totals above).</p>` : ''}
  ${t.over_limit ? `<p class="note warn"><a href="/outstanding?show=overlimit">${t.over_limit} buyer(s) are over their credit limit →</a></p>` : ''}

  <div class="grid2">
    <section class="card">
      <h2>Age of pending bills</h2>
      <p class="muted">Days since bill date. Click a row for the bills.</p>
      ${bucketBars(t)}
    </section>
    <section class="card">
      <h2>Collections, last 7 days</h2>
      <p class="big">${rs(last7.total)}</p>
      <p class="muted">${last7.n} receipts · <a href="/collections">see all collections</a></p>
    </section>
  </div>

  <section class="card">
    <div class="card-head"><h2>Top overdue buyers</h2><a href="/followup">Full follow-up list →</a></div>
    ${top.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Buyer</th><th class="num">Overdue</th><th class="num">Total pending</th><th class="num">Most overdue</th><th>Salesman</th></tr></thead>
      <tbody>${top.map((p) => `<tr>
        <td><a href="/party/${encodeURIComponent(p.party_key)}">${esc(p.party_name)}</a>${p.over_limit ? ' <span class="badge red">over limit</span>' : ''}</td>
        <td class="num red-text">${rs(p.overdue)}</td><td class="num">${rs(p.total)}</td>
        <td class="num">${p.max_overdue_days} days</td><td>${esc(p.salesman)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p>Nothing overdue. 🎉</p>'}
  </section>`;
  res.send(layout({ title: 'Dashboard', user: req.user, active: '/', body }));
});

// ---------- follow-up list ----------

router.get('/followup', async (req, res) => {
  const r = await receivables();
  if (!r.upload) return res.send(layout({ title: 'Follow-up', user: req.user, active: '/followup', body: noDataNotice() }));
  const salesman = String(req.query.salesman || '');
  const { rows: lastRc } = await pool.query(
    `SELECT DISTINCT ON (party_key) party_key, receipt_date, amount
       FROM receipts ORDER BY party_key, receipt_date DESC, id DESC`);
  const last = new Map(lastRc.map((x) => [x.party_key, x]));
  const billsBy = groupBills(r.bills);

  let list = r.parties.filter((p) => p.overdue > 0);
  if (salesman) list = list.filter((p) => p.salesman === salesman);
  const salesmen = [...new Set(r.parties.map((p) => p.salesman).filter(Boolean))].sort();

  const body = `
  <h1>Follow-up list</h1>
  ${freshness(r.upload)}
  <p class="muted">Buyers with overdue bills, biggest overdue first. Call or send a WhatsApp reminder with the bill list in one tap.</p>
  <form class="filters" method="get">
    <select name="salesman" onchange="this.form.submit()"><option value="">All salesmen</option>
      ${salesmen.map((s) => `<option ${s === salesman ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
  </form>
  <div class="cards">
  ${list.map((p) => {
    const lr = last.get(p.party_key);
    return `<div class="card fu">
      <div class="fu-head"><a href="/party/${encodeURIComponent(p.party_key)}"><strong>${esc(p.party_name)}</strong></a>
        ${p.over_limit ? '<span class="badge red">over limit</span>' : ''}</div>
      <div class="fu-nums">
        <div><span>Overdue</span><strong class="red-text">${rs(p.overdue)}</strong></div>
        <div><span>Total</span><strong>${rs(p.total)}</strong></div>
        <div><span>Oldest overdue</span><strong>${p.max_overdue_days} days</strong></div>
      </div>
      <p class="muted">Last payment: ${lr ? `${rs(lr.amount)} on ${dmy(lr.receipt_date)}` : 'none in uploaded receipts'}${p.salesman ? ` · Salesman: ${esc(p.salesman)}` : ''}</p>
      <div class="fu-actions">${contactButtons(p, billsBy.get(p.party_key) || [], r.asOf)}</div>
    </div>`;
  }).join('') || '<p>Nothing overdue.</p>'}
  </div>`;
  res.send(layout({ title: 'Follow-up', user: req.user, active: '/followup', body }));
});

function groupBills(bills) {
  const m = new Map();
  for (const b of bills) {
    if (!m.has(b.party_key)) m.set(b.party_key, []);
    m.get(b.party_key).push(b);
  }
  return m;
}

// ---------- party-wise outstanding ----------

router.get('/outstanding', async (req, res) => {
  const r = await receivables();
  if (!r.upload) return res.send(layout({ title: 'Outstanding', user: req.user, active: '/outstanding', body: noDataNotice() }));
  const q = String(req.query.q || '').trim().toUpperCase();
  const show = String(req.query.show || 'all');
  const salesman = String(req.query.salesman || '');
  let list = r.parties;
  if (q) list = list.filter((p) => p.party_name.toUpperCase().includes(q));
  if (show === 'overdue') list = list.filter((p) => p.overdue > 0);
  if (show === 'overlimit') list = list.filter((p) => p.over_limit);
  if (salesman) list = list.filter((p) => p.salesman === salesman);

  if (req.query.format === 'csv') {
    return sendCsv(res, `outstanding-${r.asOf}.csv`,
      ['Buyer', 'Salesman', 'Total', 'Overdue', 'Not due', ...BUCKETS.map((b) => b.label), 'Advance', 'Credit days', 'Credit limit', 'Most overdue days'],
      list.map((p) => [p.party_name, p.salesman, round(p.total), round(p.overdue), round(p.not_due), ...BUCKETS.map((b) => round(p[b.key])),
        round(p.advance), p.credit_days ?? r.defaultDays, p.credit_limit ?? '', p.max_overdue_days]));
  }

  const salesmen = [...new Set(r.parties.map((p) => p.salesman).filter(Boolean))].sort();
  const sum = (k) => list.reduce((a, p) => a + p[k], 0);
  const body = `
  <h1>Party-wise outstanding</h1>
  ${freshness(r.upload)}
  <form class="filters" method="get">
    <input name="q" placeholder="Search buyer" value="${esc(req.query.q || '')}">
    <select name="show">
      <option value="all">All buyers</option>
      <option value="overdue" ${show === 'overdue' ? 'selected' : ''}>Only overdue</option>
      <option value="overlimit" ${show === 'overlimit' ? 'selected' : ''}>Over credit limit</option>
    </select>
    <select name="salesman"><option value="">All salesmen</option>
      ${salesmen.map((s) => `<option ${s === salesman ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
    <button class="btn">Apply</button>
    <a class="btn ghost" href="?${new URLSearchParams({ ...req.query, format: 'csv' })}">Download</a>
  </form>
  <div class="table-wrap"><table class="dense">
    <thead><tr><th>Buyer</th><th class="num">Total</th><th class="num">Overdue</th>
      ${BUCKETS.map((b) => `<th class="num">${b.label}</th>`).join('')}<th class="num">Credit</th></tr></thead>
    <tbody>${list.map((p) => `<tr>
      <td><a href="/party/${encodeURIComponent(p.party_key)}">${esc(p.party_name)}</a>${p.over_limit ? ' <span class="badge red">over limit</span>' : ''}${p.advance < 0 ? ` <span class="badge blue">adv ${rs(p.advance)}</span>` : ''}</td>
      <td class="num"><strong>${rs(p.total)}</strong></td>
      <td class="num red-text">${rsCell(p.overdue)}</td>
      ${BUCKETS.map((b) => `<td class="num">${rsCell(p[b.key])}</td>`).join('')}
      <td class="num muted">${p.credit_days ?? r.defaultDays}d${p.credit_limit ? ` / ${rs(p.credit_limit)}` : ''}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><th>${list.length} buyers</th><th class="num">${rs(sum('total'))}</th><th class="num">${rs(sum('overdue'))}</th>
      ${BUCKETS.map((b) => `<th class="num">${rs(sum(b.key))}</th>`).join('')}<th></th></tr></tfoot>
  </table></div>`;
  res.send(layout({ title: 'Outstanding', user: req.user, active: '/outstanding', body }));
});

function round(n) { return Math.round(Number(n || 0)); }

// ---------- bill-wise ageing ----------

router.get('/bills', async (req, res) => {
  const r = await receivables();
  if (!r.upload) return res.send(layout({ title: 'Bill ageing', user: req.user, active: '/bills', body: noDataNotice() }));
  const bucket = String(req.query.bucket || '');
  const status = String(req.query.status || '');
  const q = String(req.query.q || '').trim().toUpperCase();
  let list = r.bills;
  if (bucket) list = list.filter((b) => b.bucket === bucket && b.status !== 'advance');
  if (status) list = list.filter((b) => b.status === status);
  if (q) list = list.filter((b) => b.party_name.toUpperCase().includes(q) || String(b.bill_no).toUpperCase().includes(q));
  list = [...list].sort((a, b) => (b.age ?? -1) - (a.age ?? -1));

  if (req.query.format === 'csv') {
    return sendCsv(res, `bill-ageing-${r.asOf}.csv`,
      ['Buyer', 'Bill no', 'Bill date', 'Bill amount', 'Pending', 'Age (days)', 'Due date', 'Overdue days', 'Status'],
      list.map((b) => [b.party_name, b.bill_no, dmy(b.bill_date), b.bill_amount ?? '', round(b.balance), b.age ?? '', dmy(b.due_date), b.overdue_days ?? '', b.status]));
  }
  const total = list.reduce((a, b) => a + b.balance, 0);
  const body = `
  <h1>Bill-wise ageing</h1>
  ${freshness(r.upload)}
  <form class="filters" method="get">
    <input name="q" placeholder="Buyer or bill no." value="${esc(req.query.q || '')}">
    <select name="bucket"><option value="">All ages</option>
      ${BUCKETS.map((b) => `<option value="${b.key}" ${b.key === bucket ? 'selected' : ''}>${b.label}</option>`).join('')}</select>
    <select name="status"><option value="">Any status</option>
      <option value="overdue" ${status === 'overdue' ? 'selected' : ''}>Overdue</option>
      <option value="not_due" ${status === 'not_due' ? 'selected' : ''}>Not yet due</option>
      <option value="advance" ${status === 'advance' ? 'selected' : ''}>Advance / on account</option>
    </select>
    <button class="btn">Apply</button>
    <a class="btn ghost" href="?${new URLSearchParams({ ...req.query, format: 'csv' })}">Download</a>
  </form>
  <p class="muted">${list.length} bills · ${rs(total)} pending</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Buyer</th><th>Bill no.</th><th>Bill date</th><th class="num">Bill amt</th><th class="num">Pending</th><th class="num">Age</th><th>Due date</th><th>Status</th></tr></thead>
    <tbody>${list.map((b) => `<tr>
      <td><a href="/party/${encodeURIComponent(b.party_key)}">${esc(b.party_name)}</a></td>
      <td>${esc(b.bill_no)}</td><td>${dmy(b.bill_date)}</td>
      <td class="num muted">${b.bill_amount ? rs(b.bill_amount) : ''}</td>
      <td class="num"><strong>${rs(b.balance)}</strong></td>
      <td class="num">${b.age ?? ''}</td><td>${dmy(b.due_date)}</td>
      <td>${statusBadge(b.status, b.overdue_days)}</td></tr>`).join('')}</tbody>
  </table></div>`;
  res.send(layout({ title: 'Bill ageing', user: req.user, active: '/bills', body }));
});

// ---------- one buyer ----------

router.get('/party/:key', async (req, res) => {
  const key = req.params.key;
  const r = await receivables();
  const { rows: pr } = await pool.query('SELECT * FROM parties WHERE party_key = $1', [key]);
  const info = pr[0];
  const summary = r.parties.find((p) => p.party_key === key);
  if (!info && !summary) return res.status(404).send(layout({ title: 'Not found', user: req.user, body: '<p>Buyer not found.</p>' }));
  const bills = r.bills.filter((b) => b.party_key === key).sort((a, b) => (b.age ?? -1) - (a.age ?? -1));
  const { rows: rcpts } = await pool.query(
    'SELECT * FROM receipts WHERE party_key = $1 ORDER BY receipt_date DESC, id DESC LIMIT 25', [key]);
  const name = (info && info.display_name) || summary.party_name;
  const p = summary || { party_key: key, party_name: name, total: 0, overdue: 0, not_due: 0, phone: info.phone };

  const body = `
  <p><a href="/outstanding">← All buyers</a></p>
  <h1>${esc(name)}</h1>
  <div class="kpis">
    <div class="kpi"><span>Total pending</span><strong>${rs(p.total)}</strong></div>
    <div class="kpi red"><span>Overdue</span><strong>${rs(p.overdue)}</strong></div>
    <div class="kpi"><span>Not yet due</span><strong>${rs(p.not_due)}</strong></div>
    <div class="kpi"><span>Credit</span><strong>${info && info.credit_days !== null ? info.credit_days : r.defaultDays} days</strong>
      <small>${info && info.credit_limit ? `limit ${rs(info.credit_limit)}` : 'no limit set'}</small></div>
  </div>
  <p class="fu-actions">${contactButtons({ ...p, party_name: name, phone: info && info.phone }, bills, r.asOf)}</p>

  <section class="card"><h2>Pending bills</h2>
  ${bills.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Bill no.</th><th>Bill date</th><th class="num">Bill amt</th><th class="num">Pending</th><th class="num">Age</th><th>Due date</th><th>Status</th></tr></thead>
    <tbody>${bills.map((b) => `<tr><td>${esc(b.bill_no)}</td><td>${dmy(b.bill_date)}</td>
      <td class="num muted">${b.bill_amount ? rs(b.bill_amount) : ''}</td><td class="num"><strong>${rs(b.balance)}</strong></td>
      <td class="num">${b.age ?? ''}</td><td>${dmy(b.due_date)}</td><td>${statusBadge(b.status, b.overdue_days)}</td></tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">No pending bills in the latest outstanding file.</p>'}
  </section>

  <section class="card"><h2>Recent payments</h2>
  ${rcpts.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Voucher</th><th class="num">Amount</th><th>Mode</th><th>Narration</th></tr></thead>
    <tbody>${rcpts.map((x) => `<tr><td>${dmy(x.receipt_date)}</td><td>${esc(x.voucher_no)}</td><td class="num">${rs(x.amount)}</td><td>${esc(x.mode)}</td><td class="muted">${esc(x.narration)}</td></tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">No payments in uploaded receipt files.</p>'}
  </section>

  <section class="card" id="edit"><h2>Buyer settings</h2>
  <form method="post" action="/party/${encodeURIComponent(key)}" class="form-grid">
    <label>Name to show<input name="display_name" value="${esc(name)}" required></label>
    <label>Credit days <small>blank = default ${r.defaultDays}</small><input name="credit_days" type="number" min="0" max="365" value="${esc(info && info.credit_days !== null ? info.credit_days : '')}"></label>
    <label>Credit limit ₹ <small>blank = no limit</small><input name="credit_limit" type="number" min="0" step="1" value="${esc(info && info.credit_limit !== null ? Math.round(info.credit_limit) : '')}"></label>
    <label>Mobile<input name="phone" inputmode="tel" value="${esc(info && info.phone)}"></label>
    <label>Salesman<input name="salesman" value="${esc(info && info.salesman)}"></label>
    <label>City<input name="city" value="${esc(info && info.city)}"></label>
    <label class="wide">Notes<textarea name="notes" rows="2">${esc(info && info.notes)}</textarea></label>
    <div class="wide"><button class="btn">Save</button></div>
  </form></section>`;
  res.send(layout({ title: name, user: req.user, active: '/outstanding', body }));
});

router.post('/party/:key', express.urlencoded({ extended: false }), async (req, res) => {
  const key = req.params.key;
  const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
  const numOrNull = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const txt = (v) => String(v || '').trim().slice(0, 200);
  await pool.query(
    `INSERT INTO parties (party_key, display_name, credit_days, credit_limit, phone, salesman, city, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (party_key) DO UPDATE SET display_name=$2, credit_days=$3, credit_limit=$4,
       phone=$5, salesman=$6, city=$7, notes=$8, updated_at=now()`,
    [key, txt(req.body.display_name) || key, intOrNull(req.body.credit_days), numOrNull(req.body.credit_limit),
      txt(req.body.phone), txt(req.body.salesman), txt(req.body.city), String(req.body.notes || '').slice(0, 2000)]);
  res.redirect(`/party/${encodeURIComponent(key)}`);
});

// ---------- collections ----------

router.get('/collections', async (req, res) => {
  const today = todayIST();
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const from = isDate(req.query.from) ? req.query.from : monthStart(today);
  const to = isDate(req.query.to) ? req.query.to : today;
  const rows = await collections(from, to);

  if (req.query.format === 'csv') {
    return sendCsv(res, `collections-${from}-to-${to}.csv`,
      ['Date', 'Buyer', 'Voucher', 'Amount', 'Mode', 'Narration'],
      rows.map((x) => [dmy(x.receipt_date), x.name, x.voucher_no, round(x.amount), x.mode, x.narration]));
  }
  const total = rows.reduce((a, x) => a + x.amount, 0);
  const byDay = new Map(), byParty = new Map();
  for (const x of rows) {
    byDay.set(x.receipt_date, (byDay.get(x.receipt_date) || 0) + x.amount);
    const p = byParty.get(x.party_key) || { name: x.name, key: x.party_key, amount: 0, n: 0 };
    p.amount += x.amount; p.n += 1; byParty.set(x.party_key, p);
  }
  const parties = [...byParty.values()].sort((a, b) => b.amount - a.amount);
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  const body = `
  <h1>Collections</h1>
  <form class="filters" method="get">
    <label>From <input type="date" name="from" value="${from}"></label>
    <label>To <input type="date" name="to" value="${to}"></label>
    <button class="btn">Show</button>
    <a class="btn ghost" href="?${new URLSearchParams({ from, to, format: 'csv' })}">Download</a>
  </form>
  <div class="kpis">
    <div class="kpi"><span>Collected</span><strong>${rs(total)}</strong><small>${dmy(from)} to ${dmy(to)}</small></div>
    <div class="kpi"><span>Receipts</span><strong>${rows.length}</strong><small>from ${parties.length} buyers</small></div>
  </div>
  ${rows.length ? `<div class="grid2">
    <section class="card"><h2>By day</h2><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th class="num">Amount</th></tr></thead>
      <tbody>${days.map(([d, a]) => `<tr><td>${dmy(d)}</td><td class="num">${rs(a)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h2>By buyer</h2><div class="table-wrap"><table>
      <thead><tr><th>Buyer</th><th class="num">Receipts</th><th class="num">Amount</th></tr></thead>
      <tbody>${parties.map((p) => `<tr><td><a href="/party/${encodeURIComponent(p.key)}">${esc(p.name)}</a></td><td class="num">${p.n}</td><td class="num">${rs(p.amount)}</td></tr>`).join('')}</tbody></table></div></section>
  </div>
  <section class="card"><h2>All receipts</h2><div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Buyer</th><th>Voucher</th><th class="num">Amount</th><th>Mode</th><th>Narration</th></tr></thead>
    <tbody>${rows.map((x) => `<tr><td>${dmy(x.receipt_date)}</td><td>${esc(x.name)}</td><td>${esc(x.voucher_no)}</td><td class="num">${rs(x.amount)}</td><td>${esc(x.mode)}</td><td class="muted">${esc(x.narration)}</td></tr>`).join('')}</tbody>
  </table></div></section>` : '<div class="card empty"><p>No receipts in this period. Upload Marg’s receipt register on the <a href="/upload">Upload</a> page.</p></div>'}`;
  res.send(layout({ title: 'Collections', user: req.user, active: '/collections', body }));
});

module.exports = router;
