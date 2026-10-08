// Makes Marg-style demo Excel files in ./demo-files so every report can be
// tried before real Marg exports are ready. Upload them on the Upload page.
// The names and amounts are made up.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const out = path.join(__dirname, '..', 'demo-files');
fs.mkdirSync(out, { recursive: true });

// ---- buyers' outstanding and receipts
{
const parties = ['Sharma Traders, Indore','Gupta Garments','Jain Cloth Emporium','New Fashion Point, Bhopal','Raj Readymade','VG Clothing Corporation','Agrawal Brothers','Shree Ganesh Textiles','Mahakal Menswear','Style Zone, Jabalpur','Patel Collection','Royal Mens Wear'];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const d2s = (d) => `${String(d.getUTCDate()).padStart(2,'0')}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${d.getUTCFullYear()}`;
const rows = [['V.G. MARKETING'], ['Bill-wise Outstanding (Debtors) as on 08-10-2026'], [], ['Bill No.', 'Bill Date', 'Bill Amount', 'Balance']];
let bn = 1001;
for (const p of parties) {
  rows.push([p, '', '', '']);
  let tot = 0;
  const n = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const daysAgo = Math.floor(rnd() * 170);
    const d = new Date(Date.UTC(2026, 9, 8) - daysAgo * 86400000);
    const amt = Math.round(8000 + rnd() * 60000);
    const bal = rnd() < 0.3 ? Math.round(amt * 0.4) : amt;
    tot += bal;
    rows.push([`VGM/${bn++}`, d2s(d), amt.toLocaleString('en-IN') + '.00', bal.toLocaleString('en-IN') + '.00']);
  }
  if (p.startsWith('Agrawal')) { rows.push(['On Account', '30-09-2026', '', '6,000.00 Cr']); tot -= 6000; }
  rows.push(['Party Total', '', '', tot.toLocaleString('en-IN') + '.00']);
}
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Outstanding');
XLSX.writeFile(wb, out + '/outstanding.xls', { bookType: 'biff8' });

const rc = [['Receipt Register 01-09-2026 to 08-10-2026'], ['Date', 'Vch No', 'Party Name', 'Amount', 'Mode', 'Narration']];
for (let i = 0; i < 25; i++) {
  const d = new Date(Date.UTC(2026, 9, 8) - Math.floor(rnd() * 37) * 86400000);
  rc.push([d, `RCT-${200 + i}`, parties[Math.floor(rnd() * parties.length)], Math.round(5000 + rnd() * 40000), ['UPI','Cheque','Cash','NEFT'][Math.floor(rnd()*4)], 'by salesman']);
}
const wb2 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(rc, { cellDates: true }), 'Receipts');
XLSX.writeFile(wb2, out + '/receipts.xlsx');

}
// ---- sales, purchase and suppliers' outstanding
{
let seed;
seed = 11; const rnd2 = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd2() * a.length)];
const d2sSlash = (d) => `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;
const buyers = ['Sharma Traders, Indore','Gupta Garments','Jain Cloth Emporium','New Fashion Point, Bhopal','Raj Readymade','VG Clothing Corporation','Agrawal Brothers','Shree Ganesh Textiles','Mahakal Menswear','Style Zone, Jabalpur','Patel Collection','Royal Mens Wear','Old Customer Katni'];
const brands = { APPOLLO: ['Formal Trouser 30','Formal Trouser 32','Formal Trouser 34'], 'ZED DENIM': ['Denim Jeans 32','Denim Jeans 34'], 'URBAN CASUAL': ['Casual Shirt M','Casual Shirt L','Polo T-Shirt L'] };
const mrp = { APPOLLO: 1999, 'ZED DENIM': 2499, 'URBAN CASUAL': 1399 };
// Item-wise sale register, grouped by bill (Marg style), Apr-Oct 2026
const s = [['V.G. MARKETING'], ['Item Wise Sale Register from 01/04/2026 to 08/10/2026'], [], ['Date', 'Bill No', 'Party Name', 'Item Name', 'Company', 'Qty', 'MRP', 'Rate', 'Taxable Amount', 'GST Amt', 'Net Amount']];
let bn = 3001;
for (let i = 0; i < 90; i++) {
  const d = new Date(Date.UTC(2026, 3, 1) + Math.floor(rnd2() * 190) * 86400000);
  let party = pick(buyers);
  if (party === 'Old Customer Katni' && d > new Date(Date.UTC(2026, 6, 1))) party = 'Royal Mens Wear';
  const lines = []; let tot = 0;
  for (let k = 0; k < 1 + Math.floor(rnd2() * 3); k++) {
    const b = pick(Object.keys(brands)); const qty = 5 + Math.floor(rnd2() * 30); const rate = +(mrp[b] * 0.6).toFixed(2);
    const amt = +(qty * rate).toFixed(2); const gst = +(amt * 0.05).toFixed(2); tot += amt + gst;
    lines.push(['', '', '', pick(brands[b]), b, qty, mrp[b], rate, amt, gst, '']);
  }
  s.push([d2sSlash(d), `VGM/${bn++}`, party, '', '', '', '', '', '', '', tot.toFixed(2)], ...lines);
}
s.push(['', '', 'Grand Total', '', '', '', '', '', '', '', '']);
let wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s), 'Sale'); XLSX.writeFile(wb, out + '/sales.xls', { bookType: 'biff8' });
// Item-wise purchase register, flat
const vendors = { APPOLLO: 'Appollo Apparels Pvt Ltd', 'ZED DENIM': 'Zed Denim Co, Ahmedabad', 'URBAN CASUAL': 'Urban Casual Wear, Surat' };
const p = [['Date', 'Inv No', 'Supplier Name', 'Product', 'Company', 'Qty', 'MRP', 'Pur Rate', 'Taxable Value', 'Tax Amt', 'Total']];
for (let i = 0; i < 40; i++) {
  const d = new Date(Date.UTC(2026, 3, 1) + Math.floor(rnd2() * 190) * 86400000);
  const b = pick(Object.keys(brands)); const qty = 20 + Math.floor(rnd2() * 80); const rate = +(mrp[b] * 0.6 * 0.78).toFixed(2);
  const amt = +(qty * rate).toFixed(2);
  p.push([d2sSlash(d), `PI-${500 + i}`, vendors[b], pick(brands[b]), b, qty, mrp[b], rate, amt, +(amt * 0.05).toFixed(2), +(amt * 1.05).toFixed(2)]);
}
wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(p), 'Purchase'); XLSX.writeFile(wb, out + '/purchase.xlsx');
// Creditors bill-wise outstanding, Cr balances
const c = [['Bill-wise Outstanding (Creditors) as on 08-10-2026'], ['Party Name', 'Bill No', 'Bill Date', 'Bill Amount', 'Balance']];
const dates = ['12-05-2026', '20-06-2026', '02-07-2026', '18-08-2026', '05-09-2026', '28-09-2026'];
let j = 0;
for (const v of Object.values(vendors)) for (let k = 0; k < 3; k++) { const a = Math.round(40000 + rnd2() * 150000); c.push([v, `PI-${600 + j}`, dates[j++ % 6], a.toLocaleString('en-IN') + '.00', a.toLocaleString('en-IN') + '.00 Cr']); }
c.push(['Zed Denim Co, Ahmedabad', 'ADV-1', '01-10-2026', '', '20,000.00 Dr']);
wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(c), 'Creditors'); XLSX.writeFile(wb, out + '/creditors.xlsx');

}
console.log('');
console.log('  Demo files made in: ' + out);
console.log('  On the Upload page, upload each one under its matching heading:');
console.log('    outstanding.xls  -> Buyers\' outstanding');
console.log('    receipts.xlsx    -> Receipts');
console.log('    sales.xls        -> Sales register');
console.log('    purchase.xlsx    -> Purchase register');
console.log('    creditors.xlsx   -> Suppliers\' outstanding');
console.log('');
