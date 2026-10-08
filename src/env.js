// Loads settings from a .env file next to package.json, if there is one.
// Must be required before anything that reads process.env.
// Real environment variables (e.g. on Render) always win over the file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined && v !== '') process.env[m[1]] = v;
  }
}

// On your own computer there is no Render to generate the login secret, so
// make one once and keep it in the data folder.
if (!process.env.DATABASE_URL && !process.env.SESSION_SECRET) {
  const dir = path.join(ROOT, 'data');
  const file = path.join(dir, 'session-secret.txt');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
  process.env.SESSION_SECRET = fs.readFileSync(file, 'utf8').trim();
}
