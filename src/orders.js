// Orders from the Sales Order app. READ ONLY: this module only ever calls
// find() on that database and never writes to it. Use a database user that
// has read-only rights (see README) so even a bug here could not change it.
//
// The maths mirrors the Sales Order app's /api/reports endpoint
// (backend/server.py) so both apps show the same numbers:
//   - one row per order x brand
//   - dispatched qty is capped at what was ordered for that brand
//   - cancelled orders have nothing pending, but keep what was dispatched
//   - pending value = brand's blended rate x pending qty
//   - dispatched value = actual dispatch amounts where entered, rate x qty for the rest
const { partyKey } = require('./excel');

let client = null;
let cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;

function configured() {
  return Boolean(process.env.ORDERS_MONGO_URL);
}

async function db() {
  if (!client) {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(process.env.ORDERS_MONGO_URL, {
      readPreference: 'secondaryPreferred',
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 3,
      appName: 'vg-reports-readonly',
    });
    try {
      await client.connect();
    } catch (e) {
      client = null; // try a fresh connection next time
      throw e;
    }
  }
  return client.db(process.env.ORDERS_DB_NAME || 'sale_order_db');
}

/** Everything the reports need, fetched read-only and cached for a minute. */
async function fetchRaw({ fresh = false } = {}) {
  if (!configured()) return null;
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const d = await db();
  const all = (name) => d.collection(name).find({}, { projection: { _id: 0 } }).toArray();
  const [orders, dispatches, customers, brands, exhibitions, salesmen, seasons, lines] = await Promise.all([
    all('sale_orders'), all('dispatch_orders'), all('customers'), all('brands'),
    all('exhibitions'), all('salesmen'), all('seasons'), all('lines'),
  ]);
  cache = { at: Date.now(), data: { orders, dispatches, customers, brands, exhibitions, salesmen, seasons, lines } };
  return cache.data;
}

const nameMap = (docs) => new Map((docs || []).map((x) => [x.id, x.name]));

/** {order_id: {brand_id: {qty, amount, qty_priced}}}, as dispatched_detail_bulk. */
function dispatchDetail(dispatches) {
  const out = new Map();
  for (const d of dispatches || []) {
    if (!out.has(d.sale_order_id)) out.set(d.sale_order_id, new Map());
    const bucket = out.get(d.sale_order_id);
    for (const it of d.items || []) {
      if (!bucket.has(it.brand_id)) bucket.set(it.brand_id, { qty: 0, amount: 0, qty_priced: 0 });
      const b = bucket.get(it.brand_id);
      const qty = Number(it.qty) || 0;
      b.qty += qty;
      if (it.amount !== null && it.amount !== undefined) {
        b.amount += Number(it.amount) || 0;
        b.qty_priced += qty;
      }
    }
  }
  return out;
}

function brandDispatchedValue(detail, rate) {
  const d = detail || {};
  const unpriced = Math.max(0, (d.qty || 0) - (d.qty_priced || 0));
  return (d.amount || 0) + unpriced * rate;
}

/** Quantity-only status, as compute_order_totals: pending / partial / done. */
function orderStatus(order, detail) {
  const ordered = new Map();
  for (const it of order.items || []) ordered.set(it.brand_id, (ordered.get(it.brand_id) || 0) + (Number(it.qty) || 0));
  let orderedQty = 0, pendingQty = 0;
  for (const [bid, oq] of ordered) {
    orderedQty += oq;
    const disp = detail && detail.get(bid) ? detail.get(bid).qty : 0;
    pendingQty += Math.max(0, oq - disp);
  }
  const dispatchedQty = orderedQty - pendingQty;
  if (orderedQty === 0 || dispatchedQty <= 0) return 'pending';
  if (pendingQty <= 0) return 'done';
  return 'partial';
}

/**
 * Turn raw collections into flat rows (one per order x brand), with names
 * resolved and each customer's Marg party key attached.
 * `links` maps Sales Order customer id -> Marg party_key (manual overrides).
 */
function buildRows(raw, links = new Map()) {
  const customers = new Map((raw.customers || []).map((c) => [c.id, c]));
  const brands = nameMap(raw.brands);
  const exhibitions = nameMap(raw.exhibitions);
  const salesmen = nameMap(raw.salesmen);
  const seasons = nameMap(raw.seasons);
  const lines = nameMap(raw.lines);
  const detailMap = dispatchDetail(raw.dispatches);

  const rows = [];
  for (const o of raw.orders || []) {
    const detail = detailMap.get(o.id) || new Map();
    const state = o.state || 'open';
    const status = orderStatus(o, detail);
    const cust = customers.get(o.customer_id);
    const eventType = o.event_type || 'exhibition';
    const agg = new Map();
    for (const it of o.items || []) {
      const a = agg.get(it.brand_id) || { qty: 0, amount: 0 };
      const q = Number(it.qty) || 0;
      a.qty += q;
      a.amount += q * (Number(it.rate) || 0);
      agg.set(it.brand_id, a);
    }
    for (const [bid, a] of agg) {
      const d = detail.get(bid);
      const disp = Math.min(d ? d.qty : 0, a.qty);
      const pending = state === 'cancelled' ? 0 : Math.max(0, a.qty - disp);
      const perUnit = a.qty > 0 ? a.amount / a.qty : 0;
      rows.push({
        order_id: o.id,
        state,
        status,
        order_date: o.order_date || null,
        customer_id: o.customer_id || null,
        customer: cust ? cust.name : 'Unassigned',
        city: cust ? cust.city || '' : '',
        party_key: links.get(o.customer_id) || (cust ? customerKey(cust) : ''),
        event_type: eventType,
        exhibition: eventType === 'exhibition' ? exhibitions.get(o.exhibition_id) || null : null,
        salesman: eventType === 'door_to_door' ? salesmen.get(o.salesman_id) || null : null,
        line: eventType === 'door_to_door' ? lines.get(o.line_id) || null : null,
        season: seasons.get(o.season_id) || null,
        brand: brands.get(bid) || 'Unknown',
        ordered_qty: a.qty,
        dispatched_qty: disp,
        pending_qty: pending,
        amount: a.amount,
        pending_value: perUnit * pending,
        dispatched_value: brandDispatchedValue(d, perUnit),
      });
    }
  }
  return rows;
}

/** Default Marg key for a Sales Order customer: name alone. */
function customerKey(c) {
  return partyKey(c.name);
}

/**
 * Match Sales Order customers to Marg buyers. Tries the name, then
 * "name city" (Marg names often carry the town), then the name with a
 * trailing town removed. Returns Map(customer_id -> party_key) for matches.
 */
function autoMatch(customers, margKeys) {
  const keys = new Set(margKeys);
  const out = new Map();
  for (const c of customers || []) {
    const tries = [partyKey(c.name), partyKey(`${c.name} ${c.city || ''}`)];
    const hit = tries.find((k) => k && keys.has(k));
    if (hit) out.set(c.id, hit);
  }
  return out;
}

/** Sum rows into groups by a key function. */
function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let g = m.get(k);
    if (!g) {
      g = { key: k, ordered_qty: 0, dispatched_qty: 0, pending_qty: 0, amount: 0, pending_value: 0, dispatched_value: 0, orders: new Set() };
      m.set(k, g);
    }
    g.ordered_qty += r.ordered_qty; g.dispatched_qty += r.dispatched_qty; g.pending_qty += r.pending_qty;
    g.amount += r.amount; g.pending_value += r.pending_value; g.dispatched_value += r.dispatched_value;
    g.orders.add(r.order_id);
  }
  return [...m.values()].map((g) => ({ ...g, orders: g.orders.size }));
}

async function close() { if (client) await client.close(); client = null; }

module.exports = { configured, fetchRaw, buildRows, autoMatch, group, orderStatus, dispatchDetail, brandDispatchedValue, close };
