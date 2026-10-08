const fs = require('fs');
const path = require('path');

// Two ways to run:
//  - DATABASE_URL set (Render): a real PostgreSQL server.
//  - DATABASE_URL not set (your own computer): PGlite, PostgreSQL built into
//    the app, storing everything in the ./data folder. Nothing to install.
// Both speak the same SQL, so the rest of the app doesn't know the difference.

const LOCAL = !process.env.DATABASE_URL;
const DATA_DIR = path.join(__dirname, '..', 'data', 'db');

// DATE as 'YYYY-MM-DD' strings (no timezone shifting), NUMERIC as numbers.
const DATE_OID = 1082;
const NUMERIC_OID = 1700;
const parseDate = (v) => v;
const parseNumeric = (v) => (v === null ? null : parseFloat(v));

let pool;

if (LOCAL) {
  let pg = null; // PGlite instance, opened on first use
  let opening = null;
  // PGlite is one connection: run statements one after another, and keep a
  // transaction's statements together so two requests can't interleave.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const open = () => {
    if (!opening) {
      opening = (async () => {
        const { PGlite } = require('@electric-sql/pglite');
        fs.mkdirSync(DATA_DIR, { recursive: true });
        pg = new PGlite(DATA_DIR, { parsers: { [DATE_OID]: parseDate, [NUMERIC_OID]: parseNumeric } });
        await pg.waitReady;
      })();
    }
    return opening;
  };
  const shape = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  const raw = async (sql, params) => {
    await open();
    // Multi-statement scripts (schema.sql) go through exec; the rest through query.
    if (!params && sql.includes(';') && sql.trim().split(';').filter((s) => s.trim()).length > 1) {
      await pg.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    return shape(await pg.query(sql, params || []));
  };

  pool = {
    query: (sql, params) => serial(() => raw(sql, params)),
    // A "client" holds the queue for the whole transaction, released on release().
    connect: async () => {
      let release;
      const held = new Promise((r) => { release = r; });
      let ready;
      const gotTurn = new Promise((r) => { ready = r; });
      serial(() => { ready(); return held; });
      await gotTurn;
      return { query: (sql, params) => raw(sql, params), release: () => release() };
    },
    end: async () => { if (pg) await pg.close(); },
  };
} else {
  const { Pool, types } = require('pg');
  types.setTypeParser(DATE_OID, parseDate);
  types.setTypeParser(NUMERIC_OID, parseNumeric);
  const connectionString = process.env.DATABASE_URL;
  const useSsl = !/localhost|127\.0\.0\.1/.test(connectionString) && process.env.PGSSL !== 'off';
  pool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 5,
  });
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function getSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

module.exports = { pool, migrate, getSetting, setSetting, LOCAL, DATA_DIR };
