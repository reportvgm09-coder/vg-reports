// Sales and purchase reports from the item-wise registers. One page builder
// serves both: the only differences are the wording and where a party links.
const express = require('express');
const { pool } = require('../db');
const { todayIST, addDays, daysBetween } = require('../ageing');
const { esc, rs, dmy, layout } = require('../views');
const { sendCsv } = require('../csv');

const router = express.Router();

const CONF = {
  sales: { title: 'Sales', party: 'Buyer', parties: 'buyers', link: '/party/', active: '/sales' },
  purchase: { title: 'Purchase', party: 'Supplier', parties: 'suppliers', link: '/vendor/', active: '/purchase' },
};
const VIEWS = { brand: 'By brand', party: 'By party', item: 'By item', bills: 'Bills' };

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const n = (v) => Number(v || 0);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/** Change vs previous period, as a small coloured note. */
function change(now, before) {
  if (!before) return '';
  const p = Math.round(((now - before) / Math.abs(before)) * 100);
  if (p === 0) return '<small class="muted">same as before</small>';
  return `<small class="${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% vs previous period</small>`;
}

function filters(q) {
  const where = ['register = $1', 'bill_date BETWEEN $2 AND $3'];
  const args = [q.register, q.from, q.to];
  if (q.brand) { args.push(q.brand); where.push(`brand = $${args.length}`); }
  if (q.party) { args.push(q.party); where.push(`party_key = $${args.length}`); }
  if (q.search) {
    args.push(`%${q.search.toUpperCase()}%`);
    where.push(`(upper(party_name) LIKE $${args.length} OR upper(item) LIKE $${args.length} OR brand LIKE $${args.length} OR upper(bill_no) LIKE $${args.length})`);
  }
  return { where: where.join(' AND '), args };
}

async function summary(q) {
  const f = filters(q);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::float AS amount, COALESCE(SUM(tax),0)::float AS tax, COALESCE(SUM(qty),0)::float AS qty,
            COUNT(DISTINCT (bill_no, bill_date, party_key))::int AS bills, COUNT(DISTINCT party_key)::int AS parties
       FROM register_lines WHERE ${f.where}`, f.args);
  return rows[0];
}

function page(register) {
  const c = CONF[register];
  return async (req, res) => {
    const today = todayIST();
    const from = isDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01';
    const to = isDate(req.query.to) && req.query.to >= from ? req.query.to : today;
    const view = VIEWS[req.query.view] ? req.query.view : 'brand';
    const q = { register, from, to, brand: String(req.query.brand || ''), party: String(req.query.party || ''), search: String(req.query.q || '').trim() };
    const f = filters(q);

    // Same-length window just before, for comparison.
    const span = daysBetween(from, to);
    const prev = { ...q, from: addDays(from, -(span + 1)), to: addDays(from, -1) };

    if (req.query.format === 'csv') {
      const { rows } = await pool.query(
        `SELECT * FROM register_lines WHERE ${f.where} ORDER BY bill_date, bill_no, id`, f.args);
      return sendCsv(res, `${register}-${from}-to-${to}.csv`,
        ['Date', 'Bill no', c.party, 'Item', 'Brand', 'Qty', 'MRP', 'Rate', 'Value before GST', 'GST', 'Total'],
        rows.map((r) => [dmy(r.bill_date), r.bill_no, r.party_name, r.item, r.brand, r.qty ?? '', r.mrp ?? '', r.rate ?? '',
          Math.round(n(r.amount)), r.tax === null ? '' : Math.round(n(r.tax)), r.total === null ? '' : Math.round(n(r.total))]));
    }

    const [now, before, { rows: anyRows }] = await Promise.all([
      summary(q), summary(prev),
      pool.query('SELECT MIN(bill_date) AS first, MAX(bill_date) AS last FROM register_lines WHERE register = $1', [register]),
    ]);
    const have = anyRows[0];

    if (!have.first) {
      return res.send(layout({ title: c.title, user: req.user, active: c.active, body: `
        <div class="card empty"><h2>No ${register} data yet</h2>
        <p>Export the item-wise ${register} register from Marg as Excel and <a href="/upload">upload it here</a>.</p></div>` }));
    }

    // Trend: by day for short ranges, by month for long ones.
    const byMonth = span > 62;
    const { rows: trend } = await pool.query(
      `SELECT to_char(${byMonth ? "date_trunc('month', bill_date)" : 'bill_date'}, ${byMonth ? "'YYYY-MM'" : "'YYYY-MM-DD'"}) AS k,
              SUM(amount)::float AS amount FROM register_lines WHERE ${f.where} GROUP BY 1 ORDER BY 1`, f.args);

    const table = await viewTable(view, q, f, now, c);
    const brands = (await pool.query(
      'SELECT DISTINCT brand FROM register_lines WHERE register = $1 AND brand <> \'\' ORDER BY brand', [register])).rows.map((r) => r.brand);
    const partyName = q.party ? ((await pool.query(
      'SELECT party_name FROM register_lines WHERE register = $1 AND party_key = $2 LIMIT 1', [register, q.party])).rows[0] || {}).party_name : '';

    const qs = (extra) => `?${new URLSearchParams({ ...req.query, ...extra })}`;
    const max = Math.max(1, ...trend.map((t) => t.amount));
    const body = `
    <h1>${c.title}</h1>
    <p class="fresh">Data available ${dmy(have.first)} to ${dmy(have.last)}${have.last < addDays(today, -2) ? ' · <strong>upload the latest register</strong>' : ''}</p>
    <form class="filters" method="get">
      <input type="hidden" name="view" value="${view}">
      ${q.party ? `<input type="hidden" name="party" value="${esc(q.party)}">` : ''}
      <label>From <input type="date" name="from" value="${from}"></label>
      <label>To <input type="date" name="to" value="${to}"></label>
      <select name="brand"><option value="">All brands</option>${brands.map((b) => `<option ${b === q.brand ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <input name="q" placeholder="Search ${c.party.toLowerCase()}, item, bill" value="${esc(q.search)}">
      <button class="btn">Show</button>
      <a class="btn ghost" href="${qs({ format: 'csv' })}">Download lines</a>
    </form>
    <p class="quick">
      <a href="${qs({ from: today.slice(0, 8) + '01', to: today })}">This month</a>
      <a href="${qs(lastMonth(today))}">Last month</a>
      <a href="${qs(finYear(today))}">This financial year</a>
      ${register === 'sales' ? '<a class="right" href="/sales/quiet">Buyers gone quiet →</a>' : ''}
    </p>
    ${q.party ? `<p class="note">Showing only <strong>${esc(partyName)}</strong> · <a href="${c.link}${encodeURIComponent(q.party)}">open ${c.party.toLowerCase()} page</a> · <a href="${qs({ party: '' })}">show all</a></p>` : ''}
    <div class="kpis">
      <div class="kpi"><span>Value before GST</span><strong>${rs(now.amount)}</strong>${change(now.amount, before.amount)}</div>
      <div class="kpi"><span>GST</span><strong>${rs(now.tax)}</strong><small>${dmy(from)} to ${dmy(to)}</small></div>
      <div class="kpi"><span>Pieces</span><strong>${Math.round(now.qty).toLocaleString('en-IN')}</strong>${change(now.qty, before.qty)}</div>
      <div class="kpi"><span>Bills</span><strong>${now.bills}</strong><small>${now.parties} ${c.parties}</small></div>
    </div>
    ${trend.length > 1 ? `<section class="card"><h2>${byMonth ? 'By month' : 'By day'}</h2>
      <div class="spark">${trend.map((t) => `<div class="spark-col" title="${byMonth ? t.k : dmy(t.k)}: ${rs(t.amount)}">
        <span style="height:${Math.max(2, (t.amount / max) * 100).toFixed(1)}%"></span><em>${byMonth ? monthLabel(t.k) : t.k.slice(8)}</em></div>`).join('')}</div>
    </section>` : ''}
    <nav class="tabs">${Object.entries(VIEWS).map(([k, label]) =>
      `<a class="${k === view ? 'on' : ''}" href="${qs({ view: k })}">${k === 'party' ? `By ${c.party.toLowerCase()}` : label}</a>`).join('')}</nav>
    <section class="card">${table}</section>`;
    res.send(layout({ title: c.title, user: req.user, active: c.active, body }));
  };
}

async function viewTable(view, q, f, now, c) {
  const link = (extra) => `?${new URLSearchParams({ from: q.from, to: q.to, brand: q.brand, party: q.party, q: q.search, ...extra })}`;
  if (view === 'brand') {
    const { rows } = await pool.query(
      `SELECT brand, SUM(amount)::float AS amount, SUM(qty)::float AS qty, COUNT(DISTINCT party_key)::int AS parties
         FROM register_lines WHERE ${f.where} GROUP BY brand ORDER BY amount DESC`, f.args);
    return `<div class="table-wrap"><table>
      <thead><tr><th>Brand</th><th class="num">Value</th><th class="num">Share</th><th class="num">Pieces</th><th class="num">Avg rate</th><th class="num">${c.parties}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><a href="${link({ brand: r.brand, view: 'party' })}">${esc(r.brand || '(no brand)')}</a></td>
        <td class="num"><strong>${rs(r.amount)}</strong></td><td class="num">${pct(r.amount, now.amount)}%</td>
        <td class="num">${r.qty ? Math.round(r.qty).toLocaleString('en-IN') : ''}</td>
        <td class="num">${r.qty ? rs(r.amount / r.qty) : ''}</td><td class="num">${r.parties}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }
  if (view === 'party') {
    const { rows } = await pool.query(
      `SELECT party_key, MAX(party_name) AS name, SUM(amount)::float AS amount, SUM(qty)::float AS qty,
              COUNT(DISTINCT (bill_no, bill_date))::int AS bills, MAX(bill_date) AS last,
              (array_agg(brand ORDER BY amount DESC))[1] AS top_brand
         FROM register_lines WHERE ${f.where} GROUP BY party_key ORDER BY amount DESC`, f.args);
    return `<div class="table-wrap"><table>
      <thead><tr><th>${c.party}</th><th class="num">Value</th><th class="num">Share</th><th class="num">Pieces</th><th class="num">Bills</th><th>Biggest brand</th><th>Last bill</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><a href="${c.link}${encodeURIComponent(r.party_key)}">${esc(r.name)}</a>
          <a class="muted small-link" href="${link({ party: r.party_key, view: 'brand' })}">brands →</a></td>
        <td class="num"><strong>${rs(r.amount)}</strong></td><td class="num">${pct(r.amount, now.amount)}%</td>
        <td class="num">${r.qty ? Math.round(r.qty).toLocaleString('en-IN') : ''}</td><td class="num">${r.bills}</td>
        <td>${esc(r.top_brand || '')}</td><td>${dmy(r.last)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }
  if (view === 'item') {
    const { rows } = await pool.query(
      `SELECT item, brand, SUM(amount)::float AS amount, SUM(qty)::float AS qty
         FROM register_lines WHERE ${f.where} GROUP BY item, brand ORDER BY amount DESC LIMIT 300`, f.args);
    return `<div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Brand</th><th class="num">Pieces</th><th class="num">Value</th><th class="num">Avg rate</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.item || '(bill-wise line)')}</td><td>${esc(r.brand)}</td>
        <td class="num">${r.qty ? Math.round(r.qty).toLocaleString('en-IN') : ''}</td><td class="num"><strong>${rs(r.amount)}</strong></td>
        <td class="num">${r.qty ? rs(r.amount / r.qty) : ''}</td></tr>`).join('')}</tbody>
    </table></div>${rows.length === 300 ? '<p class="muted">Top 300 items shown. Download for the full list.</p>' : ''}`;
  }
  const { rows } = await pool.query(
    `SELECT bill_date, bill_no, party_key, MAX(party_name) AS name, SUM(amount)::float AS amount, SUM(tax)::float AS tax,
            SUM(qty)::float AS qty, string_agg(DISTINCT NULLIF(brand,''), ', ') AS brands
       FROM register_lines WHERE ${f.where}
      GROUP BY bill_date, bill_no, party_key ORDER BY bill_date DESC, bill_no DESC LIMIT 500`, f.args);
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Bill no.</th><th>${c.party}</th><th>Brands</th><th class="num">Pieces</th><th class="num">Value</th><th class="num">GST</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${dmy(r.bill_date)}</td><td>${esc(r.bill_no)}</td>
      <td><a href="${c.link}${encodeURIComponent(r.party_key)}">${esc(r.name)}</a></td><td class="muted">${esc(r.brands || '')}</td>
      <td class="num">${r.qty ? Math.round(r.qty) : ''}</td><td class="num"><strong>${rs(r.amount)}</strong></td><td class="num">${r.tax ? rs(r.tax) : ''}</td></tr>`).join('')}</tbody>
  </table></div>${rows.length === 500 ? '<p class="muted">Latest 500 bills shown. Narrow the dates or download for more.</p>' : ''}`;
}

function lastMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const p = (x) => String(x).padStart(2, '0');
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { from: `${py}-${p(pm)}-01`, to: `${py}-${p(pm)}-${p(last)}` };
}

/** Indian financial year: 1 April to 31 March. */
function finYear(today) {
  const [y, m] = today.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: today };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(k) { const [y, m] = k.split('-'); return `${MON[+m - 1]} ${y.slice(2)}`; }

router.get('/sales', page('sales'));
router.get('/purchase', page('purchase'));

// Buyers who have gone quiet: bought before, nothing in the last N days.
router.get('/sales/quiet', async (req, res) => {
  const days = Math.min(365, Math.max(15, parseInt(req.query.days, 10) || 60));
  const today = todayIST();
  const { rows } = await pool.query(
    `SELECT l.party_key, COALESCE(MAX(p.display_name), MAX(l.party_name)) AS name, MAX(l.bill_date) AS last,
            SUM(l.amount) FILTER (WHERE l.bill_date > $1::date - 365)::float AS year_value,
            (array_agg(l.brand ORDER BY l.amount DESC))[1] AS top_brand,
            MAX(p.phone) AS phone, MAX(p.salesman) AS salesman
       FROM register_lines l LEFT JOIN parties p ON p.party_key = l.party_key
      WHERE l.register = 'sales'
      GROUP BY l.party_key
     HAVING MAX(l.bill_date) < $1::date - $2::int
      ORDER BY year_value DESC NULLS LAST`, [today, days]);
  const body = `
  <p><a href="/sales">← Sales</a></p>
  <h1>Buyers gone quiet</h1>
  <p class="muted">Bought from you before, but no sales bill in the last ${days} days. Biggest buyers (last 12 months) first: worth a call.</p>
  <form class="filters" method="get"><label>No bill for <select name="days" onchange="this.form.submit()">
    ${[30, 45, 60, 90, 120, 180].map((d) => `<option ${d === days ? 'selected' : ''}>${d}</option>`).join('')}</select> days</label></form>
  <div class="table-wrap"><table>
    <thead><tr><th>Buyer</th><th>Last bill</th><th class="num">Days</th><th class="num">Last 12 months</th><th>Usual brand</th><th>Salesman</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td><a href="/party/${encodeURIComponent(r.party_key)}">${esc(r.name)}</a></td>
      <td>${dmy(r.last)}</td><td class="num">${daysBetween(r.last, today)}</td><td class="num">${rs(r.year_value || 0)}</td>
      <td>${esc(r.top_brand || '')}</td><td>${esc(r.salesman || '')}</td></tr>`).join('') || '<tr><td colspan="6">Nobody. Every buyer has bought recently.</td></tr>'}</tbody>
  </table></div>`;
  res.send(layout({ title: 'Quiet buyers', user: req.user, active: '/sales', body }));
});

module.exports = router;
module.exports.finYear = finYear;
module.exports.lastMonth = lastMonth;
