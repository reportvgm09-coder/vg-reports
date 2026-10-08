const express = require('express');
const { pool } = require('../db');
const { payables } = require('../reports');
const { BUCKETS } = require('../ageing');
const { esc, rs, rsCell, dmy, layout, cleanPhone } = require('../views');
const { sendCsv } = require('../csv');

const router = express.Router();

function noData() {
  return `<div class="card empty"><h2>No supplier dues yet</h2>
    <p>Export the bill-wise outstanding of <strong>creditors</strong> (suppliers) from Marg as Excel and
    <a href="/upload">upload it here</a>.</p></div>`;
}

function freshness(upload) {
  const when = new Date(upload.uploaded_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `<p class="fresh">Marg creditors file uploaded ${esc(when)}</p>`;
}

/** Status wording from our side: we pay, so "due" not "overdue from them". */
function payBadge(b) {
  if (b.status === 'overdue') return `<span class="badge red">${b.overdue_days} days past due</span>`;
  if (b.status === 'not_due') {
    const d = -b.overdue_days;
    return d <= 15 ? `<span class="badge amber">Due in ${d} days</span>` : `<span class="badge green">Due in ${d} days</span>`;
  }
  if (b.status === 'advance') return '<span class="badge blue">Advance paid</span>';
  return '<span class="badge grey">No date</span>';
}

function dueSoon(bills, days) {
  return bills.filter((b) => b.status === 'not_due' && -b.overdue_days <= days);
}

function round(n) { return Math.round(Number(n || 0)); }

router.get('/payables', async (req, res) => {
  const r = await payables();
  if (!r.upload) return res.send(layout({ title: 'Payables', user: req.user, active: '/payables', body: noData() }));
  const t = r.totals;
  const soon = dueSoon(r.bills, 15);
  const soonTotal = soon.reduce((a, b) => a + b.balance, 0);
  const soonBy = new Map();
  for (const b of soon) soonBy.set(b.party_key, (soonBy.get(b.party_key) || 0) + b.balance);
  const q = String(req.query.q || '').trim().toUpperCase();
  let list = r.parties;
  if (q) list = list.filter((p) => p.party_name.toUpperCase().includes(q));

  if (req.query.format === 'csv') {
    return sendCsv(res, `payables-${r.asOf}.csv`,
      ['Supplier', 'Total payable', 'Past due', 'Due in 15 days', 'Not yet due', ...BUCKETS.map((b) => b.label), 'Advance paid', 'Credit days'],
      list.map((p) => [p.party_name, round(p.total), round(p.overdue), round(soonBy.get(p.party_key)), round(p.not_due),
        ...BUCKETS.map((b) => round(p[b.key])), round(p.advance), p.credit_days ?? r.defaultDays]));
  }

  const sum = (k) => list.reduce((a, p) => a + p[k], 0);
  const body = `
  <h1>Payables (suppliers)</h1>
  ${freshness(r.upload)}
  <div class="kpis">
    <div class="kpi"><span>Total payable</span><strong>${rs(t.total)}</strong><small>${t.parties} suppliers</small></div>
    <div class="kpi red"><span>Past due date</span><strong>${rs(t.overdue)}</strong><small>${t.overdue_parties} suppliers</small></div>
    <div class="kpi amber"><span>Falling due in 15 days</span><strong>${rs(soonTotal)}</strong><small>${soon.length} bills · <a href="/payables/bills?status=soon">see bills</a></small></div>
    <div class="kpi"><span>Not yet due</span><strong>${rs(t.not_due)}</strong><small>default ${r.defaultDays} days credit</small></div>
  </div>
  ${t.advance < 0 ? `<p class="note">Advances paid to suppliers, not yet adjusted: <strong>${rs(-t.advance)}</strong> (already netted above).</p>` : ''}
  <form class="filters" method="get">
    <input name="q" placeholder="Search supplier" value="${esc(req.query.q || '')}">
    <button class="btn">Search</button>
    <a class="btn ghost" href="/payables/bills">Bill-wise</a>
    <a class="btn ghost" href="?${new URLSearchParams({ ...req.query, format: 'csv' })}">Download</a>
  </form>
  <div class="table-wrap"><table class="dense">
    <thead><tr><th>Supplier</th><th class="num">Total</th><th class="num">Past due</th><th class="num">Due ≤15 days</th>
      ${BUCKETS.map((b) => `<th class="num">${b.label}</th>`).join('')}<th class="num">Credit</th></tr></thead>
    <tbody>${list.map((p) => `<tr>
      <td><a href="/vendor/${encodeURIComponent(p.party_key)}">${esc(p.party_name)}</a>${p.advance < 0 ? ` <span class="badge blue">adv ${rs(-p.advance)}</span>` : ''}</td>
      <td class="num"><strong>${rs(p.total)}</strong></td>
      <td class="num red-text">${rsCell(p.overdue)}</td>
      <td class="num">${rsCell(soonBy.get(p.party_key))}</td>
      ${BUCKETS.map((b) => `<td class="num">${rsCell(p[b.key])}</td>`).join('')}
      <td class="num muted">${p.credit_days ?? r.defaultDays}d</td></tr>`).join('')}</tbody>
    <tfoot><tr><th>${list.length} suppliers</th><th class="num">${rs(sum('total'))}</th><th class="num">${rs(sum('overdue'))}</th>
      <th class="num">${rs(list.reduce((a, p) => a + (soonBy.get(p.party_key) || 0), 0))}</th>
      ${BUCKETS.map((b) => `<th class="num">${rs(sum(b.key))}</th>`).join('')}<th></th></tr></tfoot>
  </table></div>`;
  res.send(layout({ title: 'Payables', user: req.user, active: '/payables', body }));
});

router.get('/payables/bills', async (req, res) => {
  const r = await payables();
  if (!r.upload) return res.send(layout({ title: 'Payable bills', user: req.user, active: '/payables', body: noData() }));
  const status = String(req.query.status || '');
  const q = String(req.query.q || '').trim().toUpperCase();
  let list = r.bills;
  if (status === 'soon') list = dueSoon(list, 15);
  else if (status) list = list.filter((b) => b.status === status);
  if (q) list = list.filter((b) => b.party_name.toUpperCase().includes(q) || String(b.bill_no).toUpperCase().includes(q));
  // Earliest due first: the order in which they need paying.
  list = [...list].sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));

  if (req.query.format === 'csv') {
    return sendCsv(res, `payable-bills-${r.asOf}.csv`,
      ['Supplier', 'Bill no', 'Bill date', 'Bill amount', 'Pending', 'Age (days)', 'Due date', 'Days past due', 'Status'],
      list.map((b) => [b.party_name, b.bill_no, dmy(b.bill_date), b.bill_amount ?? '', round(b.balance), b.age ?? '', dmy(b.due_date), b.overdue_days ?? '', b.status]));
  }
  const total = list.reduce((a, b) => a + b.balance, 0);
  const body = `
  <p><a href="/payables">← Payables</a></p>
  <h1>Supplier bills, by due date</h1>
  ${freshness(r.upload)}
  <form class="filters" method="get">
    <input name="q" placeholder="Supplier or bill no." value="${esc(req.query.q || '')}">
    <select name="status"><option value="">All bills</option>
      <option value="overdue" ${status === 'overdue' ? 'selected' : ''}>Past due</option>
      <option value="soon" ${status === 'soon' ? 'selected' : ''}>Due in next 15 days</option>
      <option value="not_due" ${status === 'not_due' ? 'selected' : ''}>Not yet due</option>
      <option value="advance" ${status === 'advance' ? 'selected' : ''}>Advance paid</option>
    </select>
    <button class="btn">Apply</button>
    <a class="btn ghost" href="?${new URLSearchParams({ ...req.query, format: 'csv' })}">Download</a>
  </form>
  <p class="muted">${list.length} bills · ${rs(total)}</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Due date</th><th>Supplier</th><th>Bill no.</th><th>Bill date</th><th class="num">Pending</th><th class="num">Age</th><th>Status</th></tr></thead>
    <tbody>${list.map((b) => `<tr><td>${dmy(b.due_date)}</td>
      <td><a href="/vendor/${encodeURIComponent(b.party_key)}">${esc(b.party_name)}</a></td>
      <td>${esc(b.bill_no)}</td><td>${dmy(b.bill_date)}</td><td class="num"><strong>${rs(b.balance)}</strong></td>
      <td class="num">${b.age ?? ''}</td><td>${payBadge(b)}</td></tr>`).join('')}</tbody>
  </table></div>`;
  res.send(layout({ title: 'Payable bills', user: req.user, active: '/payables', body }));
});

router.get('/vendor/:key', async (req, res) => {
  const key = req.params.key;
  const r = await payables();
  const { rows: vr } = await pool.query('SELECT * FROM vendors WHERE party_key = $1', [key]);
  const info = vr[0];
  const summary = r.parties.find((p) => p.party_key === key);
  if (!info && !summary) return res.status(404).send(layout({ title: 'Not found', user: req.user, body: '<p>Supplier not found.</p>' }));
  const name = (info && info.display_name) || summary.party_name;
  const p = summary || { total: 0, overdue: 0, not_due: 0 };
  const bills = r.bills.filter((b) => b.party_key === key)
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  const { rows: purch } = await pool.query(
    `SELECT to_char(date_trunc('month', bill_date), 'YYYY-MM') AS month, SUM(amount)::float AS amount, SUM(qty)::float AS qty
       FROM register_lines WHERE register = 'purchase' AND party_key = $1
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, [key]);
  const phone = cleanPhone(info && info.phone);

  const body = `
  <p><a href="/payables">← All suppliers</a></p>
  <h1>${esc(name)}</h1>
  <div class="kpis">
    <div class="kpi"><span>Total payable</span><strong>${rs(p.total)}</strong></div>
    <div class="kpi red"><span>Past due</span><strong>${rs(p.overdue)}</strong></div>
    <div class="kpi"><span>Not yet due</span><strong>${rs(p.not_due)}</strong></div>
    <div class="kpi"><span>Credit</span><strong>${info && info.credit_days !== null ? info.credit_days : r.defaultDays} days</strong></div>
  </div>
  ${phone ? `<p class="fu-actions"><a class="btn small" href="tel:+${phone}">Call</a></p>` : ''}
  <section class="card"><h2>Pending bills</h2>
  ${bills.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Due date</th><th>Bill no.</th><th>Bill date</th><th class="num">Bill amt</th><th class="num">Pending</th><th>Status</th></tr></thead>
    <tbody>${bills.map((b) => `<tr><td>${dmy(b.due_date)}</td><td>${esc(b.bill_no)}</td><td>${dmy(b.bill_date)}</td>
      <td class="num muted">${b.bill_amount ? rs(b.bill_amount) : ''}</td><td class="num"><strong>${rs(b.balance)}</strong></td><td>${payBadge(b)}</td></tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">Nothing pending in the latest creditors file.</p>'}
  </section>
  ${purch.length ? `<section class="card"><h2>Purchases by month</h2><div class="table-wrap"><table>
    <thead><tr><th>Month</th><th class="num">Qty</th><th class="num">Value before GST</th></tr></thead>
    <tbody>${purch.map((m) => `<tr><td>${m.month}</td><td class="num">${m.qty ? Math.round(m.qty) : ''}</td><td class="num">${rs(m.amount)}</td></tr>`).join('')}</tbody>
  </table></div></section>` : ''}
  <section class="card" id="edit"><h2>Supplier settings</h2>
  <form method="post" action="/vendor/${encodeURIComponent(key)}" class="form-grid">
    <label>Name to show<input name="display_name" value="${esc(name)}" required></label>
    <label>Credit days <small>blank = default ${r.defaultDays}</small><input name="credit_days" type="number" min="0" max="365" value="${esc(info && info.credit_days !== null ? info.credit_days : '')}"></label>
    <label>Mobile<input name="phone" inputmode="tel" value="${esc(info && info.phone)}"></label>
    <label class="wide">Notes<textarea name="notes" rows="2">${esc(info && info.notes)}</textarea></label>
    <div class="wide"><button class="btn">Save</button></div>
  </form></section>`;
  res.send(layout({ title: name, user: req.user, active: '/payables', body }));
});

router.post('/vendor/:key', express.urlencoded({ extended: false }), async (req, res) => {
  const key = req.params.key;
  const n = parseInt(req.body.credit_days, 10);
  const days = Number.isFinite(n) && n >= 0 && n <= 365 ? n : null;
  const txt = (v) => String(v || '').trim().slice(0, 200);
  await pool.query(
    `INSERT INTO vendors (party_key, display_name, credit_days, phone, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (party_key) DO UPDATE SET display_name=$2, credit_days=$3, phone=$4, notes=$5, updated_at=now()`,
    [key, txt(req.body.display_name) || key, days, txt(req.body.phone), String(req.body.notes || '').slice(0, 2000)]);
  res.redirect(`/vendor/${encodeURIComponent(key)}`);
});

module.exports = router;
