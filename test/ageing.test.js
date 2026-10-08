const test = require('node:test');
const assert = require('node:assert/strict');
const { ageBill, summarizeParties, totals, daysBetween, addDays } = require('../src/ageing');

const asOf = '2026-10-08';

test('date maths', () => {
  assert.equal(daysBetween('2026-07-01', asOf), 99);
  assert.equal(addDays('2026-07-01', 60), '2026-08-30');
});

test('default 60-day credit: bill of 1 Jul is 39 days overdue on 8 Oct', () => {
  const b = ageBill({ party_key: 'A', bill_date: '2026-07-01', balance: 25000 }, asOf, null, 60);
  assert.equal(b.age, 99);
  assert.equal(b.bucket, 'b91_120');
  assert.equal(b.due_date, '2026-08-30');
  assert.equal(b.overdue_days, 39);
  assert.equal(b.status, 'overdue');
});

test("buyer's own credit days override the default and Marg's due date", () => {
  const b = ageBill({ bill_date: '2026-07-01', balance: 1000, marg_due_date: '2026-07-31' }, asOf, 120, 60);
  assert.equal(b.due_date, '2026-10-29');
  assert.equal(b.status, 'not_due');
  const m = ageBill({ bill_date: '2026-07-01', balance: 1000, marg_due_date: '2026-07-31' }, asOf, null, 60);
  assert.equal(m.due_date, '2026-07-31');
});

test('negative balance is an advance; missing date is undated', () => {
  assert.equal(ageBill({ bill_date: '2026-09-15', balance: -5000 }, asOf, null, 60).status, 'advance');
  assert.equal(ageBill({ bill_date: null, balance: 300 }, asOf, null, 60).bucket, 'undated');
});

test('party summary and credit limit', () => {
  const bills = [
    { party_key: 'S', party_name: 'Sharma', bill_date: '2026-07-01', balance: 25000 },
    { party_key: 'S', party_name: 'Sharma', bill_date: '2026-09-20', balance: 8500 },
    { party_key: 'G', party_name: 'Gupta', bill_date: '2026-09-02', balance: 40000 },
    { party_key: 'G', party_name: 'Gupta', bill_date: '2026-09-15', balance: -5000 },
  ].map((b) => ageBill(b, asOf, null, 60));
  const info = new Map([['S', { display_name: 'Sharma Traders', credit_limit: 30000 }]]);
  const parties = summarizeParties(bills, info);
  assert.equal(parties[0].party_name, 'Sharma Traders'); // only one with overdue
  assert.equal(parties[0].overdue, 25000);
  assert.equal(parties[0].not_due, 8500);
  assert.equal(parties[0].over_limit, true);
  const g = parties.find((p) => p.party_key === 'G');
  assert.equal(g.total, 35000);
  assert.equal(g.advance, -5000);
  const t = totals(parties);
  assert.equal(t.total, 68500);
  assert.equal(t.overdue, 25000);
  assert.equal(t.over_limit, 1);
});
