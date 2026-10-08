const express = require('express');
const { pool } = require('../db');
const orders = require('../orders');
const { esc, rs, dmy, layout } = require('../views');
const { sendCsv } = require('../csv');

const router = express.Router();

const VIEWS = { customer: 'By customer', brand: 'By brand', source: 'By exhibition / salesman', season: 'By season', list: 'Order lines' };
const STATE_LABEL = { open: 'Open', hold: 'On hold', half: '50%', cancelled: 'Cancelled' };

function notConfigured(user) {
  return layout({ title: 'Orders', user, active: '/orders', body: `
    <div class="card empty"><h2>Orders not connected yet</h2>
    <p>This page reads orders from your Sales Order app, <strong>read-only</strong>. To switch it on, add
    <code>ORDERS_MONGO_URL</code> on Render using a <em>read-only</em> MongoDB Atlas user. The README explains each step.</p></div>` });
}

function failed(user, e) {
  console.error('orders read failed:', e.message);
  return layout({ title: 'Orders', user, active: '/orders',
    flash: { type: 'error', html: 'Could not reach the Sales Order database just now. Try again in a minute. If it keeps failing, check ORDERS_MONGO_URL and that Atlas allows connections from Render.' }, body: '' });
}

/** Sales Order customer id -> Marg party key: automatic matches, then manual links on top. */
async function customerLinks(raw) {
  const { rows: marg } = await pool.query('SELECT party_key FROM parties');
  const links = orders.autoMatch(raw.customers, marg.map((r) => r.party_key));
  const { rows: manual } = await pool.query('SELECT * FROM order_customer_links');
  for (const m of manual) links.set(m.order_customer_id, m.party_key);
  return links;
}

/** All order rows with Marg links applied. Shared with the buyer page. */
async function loadRows() {
  const raw = await orders.fetchRaw();
  const links = await customerLinks(raw);
  return { raw, links, rows: orders.buildRows(raw, links) };
}

const n0 = (v) => Math.round(v || 0).toLocaleString('en-IN');

router.get('/orders', async (req, res) => {
  if (!orders.configured()) return res.send(notConfigured(req.user));
  let data;
  try { data = await loadRows(); } catch (e) { return res.status(502).send(failed(req.user, e)); }
  const all = data.rows;

  const view = VIEWS[req.query.view] ? req.query.view : 'customer';
  const f = {
    season: String(req.query.season || ''), source: String(req.query.source || ''),
    brand: String(req.query.brand || ''), show: String(req.query.show || 'pending'),
    q: String(req.query.q || '').trim().toUpperCase(),
  };
  let rows = all;
  if (f.season) rows = rows.filter((r) => (r.season || '') === f.season);
  if (f.source === 'exhibition' || f.source === 'door_to_door') rows = rows.filter((r) => r.event_type === f.source);
  else if (f.source) rows = rows.filter((r) => r.exhibition === f.source || r.salesman === f.source);
  if (f.brand) rows = rows.filter((r) => r.brand === f.brand);
  if (f.q) rows = rows.filter((r) => r.customer.toUpperCase().includes(f.q) || r.order_id.toUpperCase().includes(f.q));
  if (f.show === 'pending') rows = rows.filter((r) => r.pending_qty > 0);
  else if (f.show === 'hold') rows = rows.filter((r) => r.state === 'hold');

  if (req.query.format === 'csv') {
    return sendCsv(res, 'orders.csv',
      ['Order', 'Order date', 'Customer', 'City', 'Season', 'Source', 'Brand', 'State', 'Status', 'Ordered qty', 'Dispatched qty', 'Pending qty', 'Order value', 'Dispatched value', 'Pending value'],
      rows.map((r) => [r.order_id, dmy(r.order_date), r.customer, r.city, r.season || '', r.exhibition || r.salesman || '', r.brand,
        STATE_LABEL[r.state] || r.state, r.status, r.ordered_qty, r.dispatched_qty, r.pending_qty,
        Math.round(r.amount), Math.round(r.dispatched_value), Math.round(r.pending_value)]));
  }

  const t = orders.group(rows, () => 'all')[0] || { ordered_qty: 0, dispatched_qty: 0, pending_qty: 0, amount: 0, pending_value: 0, dispatched_value: 0, orders: 0 };
  const seasons = [...new Set(all.map((r) => r.season).filter(Boolean))].sort();
  const brandsList = [...new Set(all.map((r) => r.brand))].sort();
  const exhibitions = [...new Set(all.map((r) => r.exhibition).filter(Boolean))].sort();
  const salesmen = [...new Set(all.map((r) => r.salesman).filter(Boolean))].sort();
  const qs = (extra) => `?${new URLSearchParams({ ...req.query, ...extra })}`;
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label || v)}</option>`;
  const unmatched = new Set(rows.filter((r) => r.customer_id && !data.links.has(r.customer_id)).map((r) => r.customer_id)).size;

  const body = `
  <h1>Orders</h1>
  <p class="fresh">Live from the Sales Order app (read-only, refreshed every minute)</p>
  <form class="filters" method="get">
    <input type="hidden" name="view" value="${view}">
    <select name="show">${opt('pending', f.show, 'Pending only')}${opt('all', f.show, 'All orders')}${opt('hold', f.show, 'On hold')}</select>
    <select name="season"><option value="">All seasons</option>${seasons.map((s) => opt(s, f.season)).join('')}</select>
    <select name="source"><option value="">All sources</option>
      ${opt('exhibition', f.source, 'All exhibitions')}${opt('door_to_door', f.source, 'All door-to-door')}
      ${exhibitions.length ? `<optgroup label="Exhibitions">${exhibitions.map((x) => opt(x, f.source)).join('')}</optgroup>` : ''}
      ${salesmen.length ? `<optgroup label="Salesmen">${salesmen.map((x) => opt(x, f.source)).join('')}</optgroup>` : ''}</select>
    <select name="brand"><option value="">All brands</option>${brandsList.map((b) => opt(b, f.brand)).join('')}</select>
    <input name="q" placeholder="Customer or order no." value="${esc(req.query.q || '')}">
    <button class="btn">Apply</button>
    <a class="btn ghost" href="${qs({ format: 'csv' })}">Download</a>
  </form>
  <div class="kpis">
    <div class="kpi"><span>Pending value</span><strong>${rs(t.pending_value)}</strong><small>${n0(t.pending_qty)} pieces</small></div>
    <div class="kpi"><span>Order value</span><strong>${rs(t.amount)}</strong><small>${t.orders} orders · ${n0(t.ordered_qty)} pieces</small></div>
    <div class="kpi"><span>Dispatched value</span><strong>${rs(t.dispatched_value)}</strong><small>${t.ordered_qty ? Math.round((t.dispatched_qty / t.ordered_qty) * 100) : 0}% of pieces dispatched</small></div>
  </div>
  ${unmatched ? `<p class="note">${unmatched} customer(s) here aren’t linked to a Marg buyer yet. <a href="/orders/links">Link them</a> to see orders on buyer pages.</p>` : ''}
  <nav class="tabs">${Object.entries(VIEWS).map(([k, label]) => `<a class="${k === view ? 'on' : ''}" href="${qs({ view: k })}">${label}</a>`).join('')}</nav>
  <section class="card">${viewTable(view, rows, data.links, qs)}</section>`;
  res.send(layout({ title: 'Orders', user: req.user, active: '/orders', body }));
});

function groupTable(groups, label, linkFn) {
  groups.sort((a, b) => b.pending_value - a.pending_value || b.amount - a.amount);
  const sum = (k) => groups.reduce((a, g) => a + g[k], 0);
  return `<div class="table-wrap"><table>
    <thead><tr><th>${label}</th><th class="num">Orders</th><th class="num">Ordered pcs</th><th class="num">Dispatched pcs</th><th class="num">Pending pcs</th>
      <th class="num">Order value</th><th class="num">Dispatched value</th><th class="num">Pending value</th></tr></thead>
    <tbody>${groups.map((g) => `<tr><td>${linkFn ? linkFn(g) : esc(g.key)}</td><td class="num">${g.orders}</td>
      <td class="num">${n0(g.ordered_qty)}</td><td class="num">${n0(g.dispatched_qty)}</td><td class="num"><strong>${n0(g.pending_qty)}</strong></td>
      <td class="num">${rs(g.amount)}</td><td class="num">${rs(g.dispatched_value)}</td><td class="num"><strong>${rs(g.pending_value)}</strong></td></tr>`).join('')}</tbody>
    <tfoot><tr><th>${groups.length}</th><th></th><th class="num">${n0(sum('ordered_qty'))}</th><th class="num">${n0(sum('dispatched_qty'))}</th>
      <th class="num">${n0(sum('pending_qty'))}</th><th class="num">${rs(sum('amount'))}</th><th class="num">${rs(sum('dispatched_value'))}</th><th class="num">${rs(sum('pending_value'))}</th></tr></tfoot>
  </table></div>`;
}

function viewTable(view, rows, links, qs) {
  if (!rows.length) return '<p class="muted">No orders match these filters.</p>';
  if (view === 'customer') {
    const byId = new Map(rows.map((r) => [r.customer_id || r.customer, r]));
    const groups = orders.group(rows, (r) => r.customer_id || r.customer);
    return groupTable(groups, 'Customer', (g) => {
      const r = byId.get(g.key);
      const name = `${esc(r.customer)}${r.city ? ` <span class="muted">${esc(r.city)}</span>` : ''}`;
      return links.has(r.customer_id) ? `<a href="/party/${encodeURIComponent(links.get(r.customer_id))}">${name}</a>` : name;
    });
  }
  if (view === 'brand') return groupTable(orders.group(rows, (r) => r.brand), 'Brand', (g) => `<a href="${qs({ brand: g.key, view: 'customer' })}">${esc(g.key)}</a>`);
  if (view === 'season') return groupTable(orders.group(rows, (r) => r.season || '(no season)'), 'Season');
  if (view === 'source') {
    return groupTable(orders.group(rows, (r) => (r.event_type === 'exhibition'
      ? `Exhibition: ${r.exhibition || '(not set)'}` : `Door-to-door: ${r.salesman || '(not set)'}${r.line ? ` · ${r.line}` : ''}`)), 'Source');
  }
  const list = [...rows].sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
  return `<div class="table-wrap"><table>
    <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Brand</th><th>State</th><th class="num">Ordered</th><th class="num">Dispatched</th><th class="num">Pending</th><th class="num">Pending value</th></tr></thead>
    <tbody>${list.slice(0, 1000).map((r) => `<tr><td>${esc(r.order_id)}</td><td>${dmy(r.order_date)}</td><td>${esc(r.customer)}</td><td>${esc(r.brand)}</td>
      <td>${stateBadge(r)}</td><td class="num">${n0(r.ordered_qty)}</td><td class="num">${n0(r.dispatched_qty)}</td>
      <td class="num"><strong>${n0(r.pending_qty)}</strong></td><td class="num">${rs(r.pending_value)}</td></tr>`).join('')}</tbody>
  </table></div>${list.length > 1000 ? '<p class="muted">First 1,000 lines shown. Download for all.</p>' : ''}`;
}

function stateBadge(r) {
  const s = r.state === 'cancelled' ? 'grey' : r.state === 'hold' ? 'amber' : r.state === 'half' ? 'amber' : '';
  const status = { pending: 'Not dispatched', partial: 'Part dispatched', done: 'Fully dispatched' }[r.status];
  return `${r.state !== 'open' ? `<span class="badge ${s}">${STATE_LABEL[r.state]}</span> ` : ''}<span class="muted">${status}</span>`;
}

// ---------- linking Sales Order customers to Marg buyers ----------

router.get('/orders/links', async (req, res) => {
  if (!orders.configured()) return res.send(notConfigured(req.user));
  let raw;
  try { raw = await orders.fetchRaw(); } catch (e) { return res.status(502).send(failed(req.user, e)); }
  const { rows: marg } = await pool.query('SELECT party_key, display_name FROM parties ORDER BY display_name');
  const margName = new Map(marg.map((m) => [m.party_key, m.display_name]));
  const auto = orders.autoMatch(raw.customers, marg.map((m) => m.party_key));
  const { rows: manual } = await pool.query('SELECT * FROM order_customer_links');
  const manualMap = new Map(manual.map((m) => [m.order_customer_id, m.party_key]));
  const customers = [...raw.customers].sort((a, b) => {
    const la = manualMap.has(a.id) || auto.has(a.id), lb = manualMap.has(b.id) || auto.has(b.id);
    return la === lb ? a.name.localeCompare(b.name) : la ? 1 : -1;
  });
  const saved = req.query.saved ? { type: 'ok', html: 'Saved.' } : null;
  const body = `
  <p><a href="/orders">← Orders</a></p>
  <h1>Link customers to Marg buyers</h1>
  <p class="muted">Customers in the Sales Order app are matched to Marg buyers by name automatically. For the ones that didn’t match, pick the Marg buyer below. Nothing is changed in either app; the link is kept here only.</p>
  <datalist id="marg">${marg.map((m) => `<option value="${esc(m.display_name)}">`).join('')}</datalist>
  <div class="table-wrap"><table>
    <thead><tr><th>Sales Order customer</th><th>City</th><th>Marg buyer</th><th></th></tr></thead>
    <tbody>${customers.map((c) => {
      const key = manualMap.get(c.id) || auto.get(c.id);
      return `<tr><td>${esc(c.name)}</td><td>${esc(c.city || '')}</td>
        <td><form method="post" action="/orders/links" class="inline">
          <input type="hidden" name="customer_id" value="${esc(c.id)}">
          <input name="marg_name" list="marg" placeholder="Type to pick a Marg buyer" value="${esc(key ? margName.get(key) || key : '')}">
          <button class="btn small ghost">Save</button></form></td>
        <td>${key ? (manualMap.has(c.id) ? '<span class="badge blue">linked by hand</span>' : '<span class="badge green">matched</span>') : '<span class="badge red">not linked</span>'}</td></tr>`;
    }).join('')}</tbody>
  </table></div>`;
  res.send(layout({ title: 'Link customers', user: req.user, active: '/orders', body, flash: saved }));
});

router.post('/orders/links', express.urlencoded({ extended: false }), async (req, res) => {
  const id = String(req.body.customer_id || '').slice(0, 100);
  const name = String(req.body.marg_name || '').trim();
  if (!id) return res.redirect('/orders/links');
  if (!name) {
    await pool.query('DELETE FROM order_customer_links WHERE order_customer_id = $1', [id]);
  } else {
    const { rows } = await pool.query('SELECT party_key FROM parties WHERE display_name = $1 OR party_key = upper($1) LIMIT 1', [name]);
    if (!rows.length) {
      return res.status(400).send(layout({ title: 'Link customers', user: req.user, active: '/orders',
        flash: { type: 'error', html: `No Marg buyer called “${esc(name)}”. Pick one from the list as you type.` }, body: '<p><a href="/orders/links">Back</a></p>' }));
    }
    await pool.query(
      `INSERT INTO order_customer_links (order_customer_id, party_key) VALUES ($1, $2)
       ON CONFLICT (order_customer_id) DO UPDATE SET party_key = $2`, [id, rows[0].party_key]);
  }
  res.redirect('/orders/links?saved=1');
});

module.exports = router;
module.exports.loadRows = loadRows;
