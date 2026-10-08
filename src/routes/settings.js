const express = require('express');
const { pool, setSetting } = require('../db');
const { defaultCreditDays } = require('../reports');
const { users } = require('../auth');
const { esc, rs, layout } = require('../views');

const router = express.Router();

router.get('/settings', async (req, res) => {
  const days = await defaultCreditDays();
  const vdays = await defaultCreditDays('payable');
  const { rows: vendors } = await pool.query('SELECT * FROM vendors ORDER BY display_name');
  const { rows: parties } = await pool.query(
    'SELECT * FROM parties ORDER BY display_name');
  const saved = req.query.saved ? { type: 'ok', html: 'Saved.' } : null;
  const body = `
  <h1>Settings</h1>
  <section class="card">
    <h2>Default credit periods</h2>
    <p class="muted">Used for anyone without credit days of their own. Due date = bill date + credit days.</p>
    <form method="post" action="/settings" class="form-grid">
      <label>Buyers (what they get from us)<span class="inline"><input type="number" name="default_credit_days" min="0" max="365" value="${days}" required> days</span></label>
      <label>Suppliers (what we get from them)<span class="inline"><input type="number" name="default_vendor_credit_days" min="0" max="365" value="${vdays}" required> days</span></label>
      <div class="wide"><button class="btn">Save</button></div>
    </form>
  </section>
  <section class="card">
    <h2>Buyers (${parties.length})</h2>
    <p class="muted">Buyers are added automatically from uploads. Open one to set credit days, credit limit, mobile and salesman.</p>
    <input class="search" placeholder="Filter buyers" oninput="filterRows(this.value)">
    <div class="table-wrap"><table id="buyers">
      <thead><tr><th>Buyer</th><th class="num">Credit days</th><th class="num">Credit limit</th><th>Mobile</th><th>Salesman</th></tr></thead>
      <tbody>${parties.map((p) => `<tr>
        <td><a href="/party/${encodeURIComponent(p.party_key)}#edit">${esc(p.display_name)}</a></td>
        <td class="num">${p.credit_days ?? `<span class="muted">${days}</span>`}</td>
        <td class="num">${p.credit_limit ? rs(p.credit_limit) : '<span class="muted">–</span>'}</td>
        <td>${esc(p.phone)}</td><td>${esc(p.salesman)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>
  <section class="card">
    <h2>Suppliers (${vendors.length})</h2>
    <p class="muted">Added automatically from purchase and creditors uploads. Open one to set its credit days.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Supplier</th><th class="num">Credit days</th><th>Mobile</th></tr></thead>
      <tbody>${vendors.map((v) => `<tr><td><a href="/vendor/${encodeURIComponent(v.party_key)}#edit">${esc(v.display_name)}</a></td>
        <td class="num">${v.credit_days ?? `<span class="muted">${vdays}</span>`}</td><td>${esc(v.phone)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>
  <section class="card">
    <h2>Logins</h2>
    <p>${users().map((u) => esc(u.name)).join(', ')}</p>
    <p class="muted">Logins are set in the <code>APP_USERS</code> setting on Render (format <code>name:password,name2:password2</code>).</p>
  </section>
  <script>
    function filterRows(q) {
      q = q.toUpperCase();
      document.querySelectorAll('#buyers tbody tr').forEach(function (tr) {
        tr.style.display = tr.textContent.toUpperCase().indexOf(q) === -1 ? 'none' : '';
      });
    }
  </script>`;
  res.send(layout({ title: 'Settings', user: req.user, active: '/settings', body, flash: saved }));
});

router.post('/settings', express.urlencoded({ extended: false }), async (req, res) => {
  for (const key of ['default_credit_days', 'default_vendor_credit_days']) {
    const n = parseInt(req.body[key], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 365) await setSetting(key, n);
  }
  res.redirect('/settings?saved=1');
});

module.exports = router;
