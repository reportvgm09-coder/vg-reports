// HTML helpers and page layout. Server-rendered, no build step.

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
/** ₹ amount with Indian grouping, e.g. ₹1,23,456 */
function rs(n) {
  if (n === null || n === undefined || n === '') return '';
  const v = Math.round(Number(n));
  return (v < 0 ? '−₹' : '₹') + inr.format(Math.abs(v));
}
/** Amount cell: blank for zero to keep tables readable. */
function rsCell(n) {
  return Math.round(Number(n || 0)) === 0 ? '<span class="muted">–</span>' : rs(n);
}
/** 'YYYY-MM-DD' -> 'DD-MM-YYYY' */
function dmy(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

const NAV = [
  ['/', 'Dashboard'],
  ['/followup', 'Follow-up'],
  ['/outstanding', 'Outstanding'],
  ['/bills', 'Bill ageing'],
  ['/collections', 'Collections'],
  ['/upload', 'Upload'],
  ['/settings', 'Settings'],
];

function layout({ title, user, active, body, flash }) {
  const nav = NAV.map(([href, label]) =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · VG Reports</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<header class="top">
  <div class="brand"><span class="mark">VG</span> Reports</div>
  ${user ? `<nav>${nav}</nav><form method="post" action="/logout" class="who"><span>${esc(user)}</span><button class="link">Log out</button></form>` : ''}
</header>
<main>
  ${flash ? `<div class="flash ${esc(flash.type || '')}">${flash.html}</div>` : ''}
  ${body}
</main>
</body></html>`;
}

function statusBadge(status, overdueDays) {
  if (status === 'overdue') return `<span class="badge red">${overdueDays} days overdue</span>`;
  if (status === 'not_due') return `<span class="badge green">Due in ${-overdueDays} days</span>`;
  if (status === 'advance') return '<span class="badge blue">Advance / on account</span>';
  return '<span class="badge grey">No date</span>';
}

/** Digits-only Indian mobile for wa.me / tel links, or '' if unusable. */
function cleanPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  if (d.length === 12 && d.startsWith('91')) return d;
  return '';
}

module.exports = { esc, rs, rsCell, dmy, layout, statusBadge, cleanPhone };
