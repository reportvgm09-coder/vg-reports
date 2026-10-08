const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRows, autoMatch, group } = require('../src/orders');

// Shapes copied from the Sales Order app (backend/server.py models).
const raw = {
  customers: [
    { id: 'CUST-1', name: 'Sharma Traders', city: 'Indore' },
    { id: 'CUST-2', name: 'Gupta Garments', city: 'Bhopal' },
    { id: 'CUST-3', name: 'Raj Readymade', city: 'Katni' },
  ],
  brands: [{ id: 'B-AP', name: 'Appollo' }, { id: 'B-ZD', name: 'Zed' }],
  exhibitions: [{ id: 'EX-1', name: 'Indore Oct' }],
  salesmen: [{ id: 'SM-1', name: 'Gopal' }],
  seasons: [{ id: 'SS-1', name: 'Summer 27' }],
  lines: [{ id: 'LN-1', name: 'Amravati', salesman_id: 'SM-1' }],
  orders: [
    { id: 'SO-1', state: 'open', order_date: '2026-09-10', customer_id: 'CUST-1', event_type: 'exhibition', exhibition_id: 'EX-1', season_id: 'SS-1',
      items: [{ brand_id: 'B-AP', rate: 600, qty: 100 }, { brand_id: 'B-AP', rate: 700, qty: 100 }, { brand_id: 'B-ZD', rate: 500, qty: 50 }] },
    { id: 'SO-2', state: 'cancelled', order_date: '2026-09-12', customer_id: 'CUST-2', event_type: 'door_to_door', salesman_id: 'SM-1', line_id: 'LN-1', exhibition_id: 'EX-1',
      items: [{ brand_id: 'B-ZD', rate: 400, qty: 40 }] },
    { id: 'SO-3', order_date: '2026-09-15', customer_id: 'CUST-3', items: [{ brand_id: 'B-ZD', rate: 450, qty: 20 }] },
  ],
  dispatches: [
    // SO-1 Appollo: 50 with no amount, 30 with a real amount of 15,000
    { sale_order_id: 'SO-1', items: [{ brand_id: 'B-AP', qty: 50 }] },
    { sale_order_id: 'SO-1', items: [{ brand_id: 'B-AP', qty: 30, amount: 15000 }, { brand_id: 'B-ZD', qty: 60 }] },
    // SO-2 half shipped before it was cancelled
    { sale_order_id: 'SO-2', items: [{ brand_id: 'B-ZD', qty: 20, amount: 0 }] },
  ],
};

test('rows match the Sales Order app /reports maths', () => {
  const rows = buildRows(raw);
  const ap = rows.find((r) => r.order_id === 'SO-1' && r.brand === 'Appollo');
  assert.equal(ap.ordered_qty, 200);
  assert.equal(ap.amount, 130000);            // 100x600 + 100x700
  assert.equal(ap.dispatched_qty, 80);
  assert.equal(ap.pending_qty, 120);
  assert.equal(ap.pending_value, 78000);      // blended 650 x 120
  assert.equal(ap.dispatched_value, 47500);   // 15,000 actual + 50 x 650
  assert.equal(ap.status, 'partial');
  assert.equal(ap.exhibition, 'Indore Oct');
  assert.equal(ap.season, 'Summer 27');

  const zd = rows.find((r) => r.order_id === 'SO-1' && r.brand === 'Zed');
  assert.equal(zd.dispatched_qty, 50);        // capped at ordered
  assert.equal(zd.pending_qty, 0);
  assert.equal(zd.dispatched_value, 30000);   // uncapped 60 x 500, as brand_dispatched_value

  const c = rows.find((r) => r.order_id === 'SO-2');
  assert.equal(c.state, 'cancelled');
  assert.equal(c.pending_qty, 0);             // cancelled: nothing outstanding
  assert.equal(c.dispatched_qty, 20);         // ...but what went out stays
  assert.equal(c.dispatched_value, 0);        // shipped free: 0 is not blank
  assert.equal(c.status, 'partial');
  assert.equal(c.salesman, 'Gopal');
  assert.equal(c.line, 'Amravati');
  assert.equal(c.exhibition, null);           // door-to-door ignores exhibition_id

  const d = rows.find((r) => r.order_id === 'SO-3');
  assert.equal(d.state, 'open');              // missing state means open
  assert.equal(d.event_type, 'exhibition');
  assert.equal(d.status, 'pending');
});

test('auto-matching Sales Order customers to Marg buyers', () => {
  const marg = ['SHARMA TRADERS INDORE', 'GUPTA GARMENTS', 'SOMEONE ELSE'];
  const m = autoMatch(raw.customers, marg);
  assert.equal(m.get('CUST-1'), 'SHARMA TRADERS INDORE'); // name + city
  assert.equal(m.get('CUST-2'), 'GUPTA GARMENTS');        // name alone
  assert.equal(m.has('CUST-3'), false);

  const rows = buildRows(raw, new Map([...m, ['CUST-3', 'RAJ READYMADE KATNI']]));
  assert.equal(rows.find((r) => r.order_id === 'SO-3').party_key, 'RAJ READYMADE KATNI');
});

test('grouping totals add up', () => {
  const rows = buildRows(raw);
  const byBrand = group(rows, (r) => r.brand);
  const all = group(rows, () => 'all')[0];
  assert.equal(byBrand.reduce((a, g) => a + g.pending_value, 0), all.pending_value);
  assert.equal(all.orders, 3);
  assert.equal(byBrand.find((g) => g.key === 'Zed').orders, 3);
});
