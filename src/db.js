const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting)
types.setTypeParser(1082, (v) => v);
// Return NUMERIC as JS numbers (amounts here are well within float precision)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const useSsl = !/localhost|127\.0\.0\.1/.test(connectionString) && process.env.PGSSL !== 'off';
const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

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

module.exports = { pool, migrate, getSetting, setSetting };
