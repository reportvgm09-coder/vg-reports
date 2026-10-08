const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, parseAmount, partyKey, detectHeader, extractRecords } = require('../src/excel');

test('parseDate handles Marg date shapes (day first)', () => {
  assert.equal(parseDate('05-07-2026'), '2026-07-05');
  assert.equal(parseDate('5/7/26'), '2026-07-05');
  assert.equal(parseDate('05.07.2026'), '2026-07-05');
  assert.equal(parseDate('05-Jul-2026'), '2026-07-05');
  assert.equal(parseDate('5 Jul 26'), '2026-07-05');
  assert.equal(parseDate('2026-07-05'), '2026-07-05');
  assert.equal(parseDate(46208), '2026-07-05'); // Excel serial
  assert.equal(parseDate('31-02-2026'), null);
  assert.equal(parseDate('Total'), null);
  assert.equal(parseDate(1500), null);
});

test('parseAmount handles commas, Dr/Cr and brackets', () => {
  assert.equal(parseAmount('1,23,456.50'), 123456.5);
  assert.equal(parseAmount('5000 Dr'), 5000);
  assert.equal(parseAmount('5000 Cr'), -5000);
  assert.equal(parseAmount('(500)'), -500);
  assert.equal(parseAmount('₹ 2,000'), 2000);
  assert.equal(parseAmount(750), 750);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
});

test('partyKey matches small spelling differences', () => {
  assert.equal(partyKey('M/s. Sharma Traders,'), partyKey('SHARMA  TRADERS'));
  assert.equal(partyKey('Gupta & Sons'), 'GUPTA AND SONS');
});

test('flat layout with a party column', () => {
  const rows = [
    ['VG MARKETING'], ['Bill-wise outstanding as on 08-10-2026'], [],
    ['S.No', 'Party Name', 'Bill No.', 'Date', 'Bill Amt', 'Balance'],
    [1, 'Sharma Traders', 'A-101', '01-07-2026', '25,000.00', '25,000.00'],
    [2, 'Sharma Traders', 'A-140', '20-08-2026', '18,500.00', '8,500.00'],
    [3, 'Gupta Garments', 'A-155', '02-09-2026', '40,000.00', '40,000.00'],
    ['', 'Grand Total', '', '', '', '73,500.00'],
  ];
  const { headerRow, mapping } = detectHeader(rows, 'outstanding');
  assert.equal(headerRow, 3);
  assert.deepEqual(mapping, { party: 1, bill_no: 2, bill_date: 3, bill_amount: 4, balance: 5 });
  const { records, skipped } = extractRecords(rows, 'outstanding', mapping, headerRow);
  assert.equal(records.length, 3);
  assert.equal(skipped.length, 0);
  assert.deepEqual(records[1], {
    party_name: 'Sharma Traders', party_key: 'SHARMA TRADERS', bill_no: 'A-140',
    bill_date: '2026-08-20', bill_amount: 18500, balance: 8500, marg_due_date: null,
  });
});

test('grouped layout: party heading then its bills', () => {
  const rows = [
    ['Bill No', 'Bill Date', 'Amount', 'Pending'],
    ['SHARMA TRADERS, INDORE', '', '', '33,500.00'],
    ['A-101', '01/07/2026', '25000', '25000'],
    ['A-140', '20/08/2026', '18500', '8500'],
    ['Party Total', '', '', '33500'],
    ['GUPTA GARMENTS', '', '', ''],
    ['A-155', '02/09/2026', '40000', '40000'],
    ['On Account', '15/09/2026', '', '5000 Cr'],
  ];
  const { headerRow, mapping } = detectHeader(rows, 'outstanding');
  assert.equal(headerRow, 0);
  assert.equal(mapping.party, undefined);
  const { records } = extractRecords(rows, 'outstanding', mapping, headerRow);
  assert.equal(records.length, 4);
  assert.equal(records[0].party_name, 'SHARMA TRADERS, INDORE');
  assert.equal(records[2].party_name, 'GUPTA GARMENTS');
  assert.equal(records[3].balance, -5000);
});

test('payables: Cr is what we owe, Dr is an advance paid', () => {
  const rows = [
    ['Supplier Name', 'Bill No', 'Bill Date', 'Bill Amount', 'Balance'],
    ['Appollo Apparels', 'P-77', '10-06-2026', '1,20,000.00', '1,20,000.00 Cr'],
    ['Appollo Apparels', 'ADV', '01-09-2026', '', '15,000.00 Dr'],
    ['Zed Denim', 'Z-9', '15-08-2026', '50000', '50000'],
  ];
  const { headerRow, mapping } = detectHeader(rows, 'payables');
  assert.equal(mapping.party, 0);
  const { records } = extractRecords(rows, 'payables', mapping, headerRow);
  assert.deepEqual(records.map((r) => r.balance), [120000, -15000, 50000]);
});

test('item-wise sales register, grouped by bill', () => {
  const rows = [
    ['Sale Register 01-10-2026 to 08-10-2026'],
    ['Date', 'Bill No', 'Party Name', 'Item Name', 'Company', 'Qty', 'MRP', 'Rate', 'Taxable Amount', 'GST Amt', 'Net Amount'],
    ['02-10-2026', 'VGM/2001', 'Sharma Traders', '', '', '', '', '', '', '', '41,440.00'],
    ['', '', '', 'Formal Trouser 32', 'Appollo', '20', '1,999', '1,199.40', '23,988.00', '1,199.40', ''],
    ['', '', '', 'Casual Shirt M', 'Zed', '15', '1,399', '839.40', '12,591.00', '629.55', ''],
    ['', '', '', '', '', '35', '', '', '36,579.00', '1,828.95', ''],
    ['03-10-2026', 'VGM/2002', 'Gupta Garments', 'Denim 34', 'Zed', '10', '2,499', '1,499.40', '14,994.00', '749.70', '15,743.70'],
    ['', '', 'Grand Total', '', '', '45', '', '', '51,573.00', '', ''],
  ];
  const { headerRow, mapping } = detectHeader(rows, 'sales');
  assert.equal(headerRow, 1);
  assert.equal(mapping.brand, 4);
  assert.equal(mapping.amount, 8);
  assert.equal(mapping.total, 10);
  const { records, skipped } = extractRecords(rows, 'sales', mapping, headerRow);
  assert.equal(skipped.length, 0);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => [r.bill_date, r.bill_no, r.party_key, r.brand, r.qty, r.amount]),
    [
      ['2026-10-02', 'VGM/2001', 'SHARMA TRADERS', 'APPOLLO', 20, 23988],
      ['2026-10-02', 'VGM/2001', 'SHARMA TRADERS', 'ZED', 15, 12591],
      ['2026-10-03', 'VGM/2002', 'GUPTA GARMENTS', 'ZED', 10, 14994],
    ]);
});

test('bill-wise register (no item column) still imports one line per bill', () => {
  const rows = [
    ['Date', 'Bill No', 'Supplier', 'Taxable', 'Tax', 'Total'],
    ['01-10-2026', 'P-1', 'Appollo Apparels', '1,00,000', '5,000', '1,05,000'],
    ['04-10-2026', 'P-2', 'Zed Denim', '40,000', '2,000', '42,000'],
  ];
  const { headerRow, mapping } = detectHeader(rows, 'purchase');
  const { records } = extractRecords(rows, 'purchase', mapping, headerRow);
  assert.equal(records.length, 2);
  assert.equal(records[0].party_name, 'Appollo Apparels');
  assert.equal(records[0].brand, '');
  assert.equal(records[1].total, 42000);
});

test('receipts register', () => {
  const rows = [
    ['Date', 'Vch No', 'Party Name', 'Amount', 'Mode', 'Narration'],
    ['06-10-2026', 'R-12', 'Sharma Traders', '10,000', 'UPI', 'GPay'],
    ['07-10-2026', 'R-13', 'Gupta Garments', '15,000', 'Cheque', 'chq 445566'],
    ['', '', 'Total', '25,000', '', ''],
  ];
  const { headerRow, mapping } = detectHeader(rows, 'receipts');
  const { records } = extractRecords(rows, 'receipts', mapping, headerRow);
  assert.equal(records.length, 2);
  assert.equal(records[1].receipt_date, '2026-10-07');
  assert.equal(records[1].amount, 15000);
  assert.equal(records[1].mode, 'Cheque');
});
