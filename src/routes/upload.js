const express = require('express');
const multer = require('multer');
const { pool, getSetting, setSetting } = require('../db');
const { FIELDS, readRows, detectHeader, extractRecords, normHeader } = require('../excel');
const { ensureParties } = require('../reports');
const { todayIST } = require('../ageing');
const { esc, rs, dmy, layout } = require('../views');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(xlsx|xls|csv)$/i.test(file.originalname)),
});

const KINDS = {
  outstanding: { label: 'Bill-wise outstanding (receivables)', hint: 'Marg → Outstanding → Bill-wise outstanding of debtors → export to Excel. Upload the full list every day; it replaces yesterday’s.' },
  receipts: { label: 'Receipts / collections', hint: 'Marg receipt register (or cash/bank book receipts) for the last few days. Overlapping days are fine; duplicates are skipped.' },
};

const KEEP_SNAPSHOT_DAYS = 90;

router.get('/upload', async (req, res) => {
  const { rows: recent } = await pool.query('SELECT * FROM uploads ORDER BY id DESC LIMIT 15');
  const body = `
  <h1>Upload Marg files</h1>
  <div class="grid2">
  ${Object.entries(KINDS).map(([kind, k]) => `
    <section class="card">
      <h2>${k.label}</h2>
      <p class="muted">${k.hint}</p>
      <form method="post" action="/upload" enctype="multipart/form-data" class="stack">
        <input type="hidden" name="kind" value="${kind}">
        <input type="file" name="file" accept=".xlsx,.xls,.csv" required>
        <button class="btn">Upload and check</button>
      </form>
    </section>`).join('')}
  </div>
  <section class="card"><h2>Recent uploads</h2>
  ${recent.length ? `<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Type</th><th>File</th><th class="num">Rows imported</th><th class="num">Skipped</th><th>By</th></tr></thead>
    <tbody>${recent.map((u) => `<tr>
      <td>${new Date(u.uploaded_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${esc(KINDS[u.kind] ? KINDS[u.kind].label : u.kind)}</td><td>${esc(u.filename)}</td>
      <td class="num">${u.rows_imported}</td><td class="num">${u.rows_skipped}</td><td>${esc(u.uploaded_by)}</td></tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">Nothing uploaded yet.</p>'}
  </section>`;
  res.send(layout({ title: 'Upload', user: req.user, active: '/upload', body }));
});

router.post('/upload', upload.single('file'), async (req, res) => {
  const kind = req.body.kind;
  if (!KINDS[kind] || !req.file) {
    return res.status(400).send(layout({ title: 'Upload', user: req.user, active: '/upload',
      flash: { type: 'error', html: 'Please choose an Excel file (.xlsx, .xls or .csv).' }, body: '<p><a href="/upload">Back</a></p>' }));
  }
  let rows;
  try { rows = readRows(req.file.buffer); } catch (e) {
    return res.status(400).send(layout({ title: 'Upload', user: req.user, active: '/upload',
      flash: { type: 'error', html: `Could not read this file: ${esc(e.message)}` }, body: '<p><a href="/upload">Back</a></p>' }));
  }
  rows = rows.slice(0, 50000).map((r) => r.slice(0, 60));
  // Clear abandoned previews
  await pool.query(`DELETE FROM pending_uploads WHERE created_at < now() - interval '1 day'`);
  const { rows: ins } = await pool.query(
    'INSERT INTO pending_uploads (kind, filename, rows_json) VALUES ($1, $2, $3) RETURNING id',
    [kind, req.file.originalname.slice(0, 200), JSON.stringify(rows)]);
  res.redirect(`/upload/${ins[0].id}`);
});

/** Use yesterday's confirmed header names first, then alias matching. */
async function initialMapping(rows, kind) {
  const saved = JSON.parse(await getSetting(`mapping_${kind}`, 'null') || 'null');
  if (saved && saved.fields) {
    for (let r = 0; r < Math.min(rows.length, 40); r++) {
      const headers = rows[r].map(normHeader);
      const mapping = {};
      let ok = true;
      for (const [field, header] of Object.entries(saved.fields)) {
        const idx = headers.indexOf(header);
        if (idx === -1) { ok = false; break; }
        mapping[field] = idx;
      }
      if (ok && Object.keys(mapping).length) return { headerRow: r, mapping, fromSaved: true };
    }
  }
  return { ...detectHeader(rows, kind), fromSaved: false };
}

function mappingFromQuery(query, kind) {
  const mapping = {};
  for (const f of FIELDS[kind]) {
    const v = parseInt(query[`col_${f.key}`], 10);
    if (Number.isFinite(v) && v >= 0) mapping[f.key] = v;
  }
  return mapping;
}

async function loadPending(id) {
  const { rows } = await pool.query('SELECT * FROM pending_uploads WHERE id = $1', [id]);
  return rows[0] || null;
}

router.get('/upload/:id', async (req, res) => {
  const pending = await loadPending(req.params.id);
  if (!pending) return res.redirect('/upload');
  const { kind } = pending;
  const rows = pending.rows_json;

  let headerRow, mapping, fromSaved = false;
  if (req.query.header_row !== undefined) {
    headerRow = Math.max(0, parseInt(req.query.header_row, 10) - 1 || 0);
    mapping = mappingFromQuery(req.query, kind);
  } else {
    ({ headerRow, mapping, fromSaved } = await initialMapping(rows, kind));
    if (headerRow < 0) headerRow = 0;
  }
  const headers = rows[headerRow] || [];
  const { records, skipped } = extractRecords(rows, kind, mapping, headerRow);
  const missing = FIELDS[kind].filter((f) => f.required && mapping[f.key] === undefined);
  const total = records.reduce((a, r) => a + (kind === 'outstanding' ? r.balance : r.amount), 0);
  const parties = new Set(records.map((r) => r.party_key)).size;
  const groupedNote = mapping.party === undefined
    ? '<p class="note">No party column chosen, so party names are taken from the heading line above each group of bills (Marg’s grouped layout).</p>' : '';

  const colOptions = (sel) => `<option value="-1">— not in file —</option>` +
    headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(colLetter(i))}: ${esc(String(h).slice(0, 40) || '(blank)')}</option>`).join('');

  const preview = records.slice(0, 8);
  const body = `
  <p><a href="/upload">← Upload</a></p>
  <h1>Check columns: ${esc(KINDS[kind].label)}</h1>
  <p class="muted">File: ${esc(pending.filename)} · ${rows.length} rows in sheet</p>
  ${fromSaved ? '<p class="note ok">Columns matched the same way as your last upload. Check the preview and import.</p>' : ''}
  <form method="get" action="/upload/${pending.id}" class="card">
    <h2>Which column is which?</h2>
    <div class="form-grid">
      <label>Header row number<input type="number" name="header_row" min="1" value="${headerRow + 1}"></label>
      ${FIELDS[kind].map((f) => `<label>${esc(f.label)}${f.required ? ' *' : ''}<select name="col_${f.key}">${colOptions(mapping[f.key])}</select></label>`).join('')}
    </div>
    <button class="btn ghost">Update preview</button>
  </form>
  ${groupedNote}
  ${missing.length ? `<div class="flash error">Choose a column for: ${missing.map((f) => esc(f.label)).join(', ')}</div>` : ''}
  <section class="card">
    <h2>Preview</h2>
    <p><strong>${records.length}</strong> ${kind === 'outstanding' ? 'bills' : 'receipts'} from <strong>${parties}</strong> buyers, total <strong>${rs(total)}</strong>${skipped.length ? ` · <span class="red-text">${skipped.length} rows skipped</span>` : ''}</p>
    ${preview.length ? `<div class="table-wrap"><table>${kind === 'outstanding'
      ? `<thead><tr><th>Buyer</th><th>Bill no.</th><th>Bill date</th><th class="num">Bill amt</th><th class="num">Pending</th></tr></thead>
         <tbody>${preview.map((r) => `<tr><td>${esc(r.party_name)}</td><td>${esc(r.bill_no)}</td><td>${dmy(r.bill_date)}</td><td class="num">${r.bill_amount !== null ? rs(r.bill_amount) : ''}</td><td class="num">${rs(r.balance)}</td></tr>`).join('')}</tbody>`
      : `<thead><tr><th>Date</th><th>Buyer</th><th>Voucher</th><th class="num">Amount</th><th>Mode</th></tr></thead>
         <tbody>${preview.map((r) => `<tr><td>${dmy(r.receipt_date)}</td><td>${esc(r.party_name)}</td><td>${esc(r.voucher_no)}</td><td class="num">${rs(r.amount)}</td><td>${esc(r.mode)}</td></tr>`).join('')}</tbody>`}
    </table></div>` : '<p class="muted">Nothing recognised yet. Fix the header row or columns above.</p>'}
    ${skipped.length ? `<details><summary>Skipped rows</summary><p class="muted">${skipped.slice(0, 50).map((s) => `row ${s.row}: ${esc(s.reason)}`).join(' · ')}${skipped.length > 50 ? ' …' : ''}</p></details>` : ''}
  </section>
  ${records.length && !missing.length ? `
  <form method="post" action="/upload/${pending.id}/import" class="card stack">
    <input type="hidden" name="header_row" value="${headerRow}">
    ${Object.entries(mapping).map(([k, v]) => `<input type="hidden" name="col_${k}" value="${v}">`).join('')}
    ${kind === 'outstanding' ? `<p>This replaces the current outstanding data with this file.</p>` : '<p>Receipts already imported earlier are skipped automatically.</p>'}
    <button class="btn">Import ${records.length} ${kind === 'outstanding' ? 'bills' : 'receipts'}</button>
  </form>` : ''}`;
  res.send(layout({ title: 'Check upload', user: req.user, active: '/upload', body }));
});

function colLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

router.post('/upload/:id/import', express.urlencoded({ extended: false }), async (req, res) => {
  const pending = await loadPending(req.params.id);
  if (!pending) return res.redirect('/upload');
  const { kind } = pending;
  const rows = pending.rows_json;
  const headerRow = Math.max(0, parseInt(req.body.header_row, 10) || 0);
  const mapping = mappingFromQuery(req.body, kind);
  const { records, skipped } = extractRecords(rows, kind, mapping, headerRow);
  if (!records.length) return res.redirect(`/upload/${pending.id}`);

  const client = await pool.connect();
  let imported = 0;
  try {
    await client.query('BEGIN');
    const { rows: u } = await client.query(
      `INSERT INTO uploads (kind, filename, as_of_date, rows_skipped, uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [kind, pending.filename, todayIST(), skipped.length, req.user]);
    const uploadId = u[0].id;

    if (kind === 'outstanding') {
      await client.query(
        `INSERT INTO outstanding_bills (upload_id, party_key, party_name, bill_no, bill_date, bill_amount, balance, marg_due_date)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::date[], $6::numeric[], $7::numeric[], $8::date[])`,
        [uploadId, col(records, 'party_key'), col(records, 'party_name'), col(records, 'bill_no'), col(records, 'bill_date'),
          col(records, 'bill_amount'), col(records, 'balance'), col(records, 'marg_due_date')]);
      imported = records.length;
      // Keep older snapshots for a while, then drop their bill rows.
      await client.query(
        `DELETE FROM outstanding_bills WHERE upload_id IN (
           SELECT id FROM uploads WHERE kind = 'outstanding' AND id <> $1
             AND uploaded_at < now() - ($2 || ' days')::interval)`, [uploadId, String(KEEP_SNAPSHOT_DAYS)]);
    } else {
      const r = await client.query(
        `INSERT INTO receipts (upload_id, party_key, party_name, receipt_date, voucher_no, amount, mode, narration)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::date[], $5::text[], $6::numeric[], $7::text[], $8::text[])
         ON CONFLICT (party_key, receipt_date, voucher_no, amount) DO NOTHING`,
        [uploadId, col(records, 'party_key'), col(records, 'party_name'), col(records, 'receipt_date'), col(records, 'voucher_no'),
          col(records, 'amount'), col(records, 'mode'), col(records, 'narration')]);
      imported = r.rowCount;
    }
    await client.query('UPDATE uploads SET rows_imported = $1 WHERE id = $2', [imported, uploadId]);
    await client.query('DELETE FROM pending_uploads WHERE id = $1', [pending.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await ensureParties(records);

  // Remember the header names so tomorrow's file maps itself.
  const headers = rows[headerRow] || [];
  const fields = {};
  for (const [k, v] of Object.entries(mapping)) if (headers[v] !== undefined && normHeader(headers[v])) fields[k] = normHeader(headers[v]);
  await setSetting(`mapping_${kind}`, JSON.stringify({ fields }));

  const dupes = kind === 'receipts' ? records.length - imported : 0;
  const msg = kind === 'outstanding'
    ? `Imported ${imported} pending bills. Reports now show this file.`
    : `Imported ${imported} new receipts${dupes ? ` (${dupes} already there, skipped)` : ''}.`;
  const next = kind === 'outstanding' ? '/' : '/collections';
  res.send(layout({ title: 'Imported', user: req.user, active: '/upload',
    flash: { type: 'ok', html: esc(msg) },
    body: `<p><a class="btn" href="${next}">See reports</a> <a class="btn ghost" href="/upload">Upload another file</a></p>` }));
});

function col(records, key) {
  return records.map((r) => (r[key] === undefined || r[key] === '' && /date/.test(key) ? null : r[key]));
}

module.exports = router;
