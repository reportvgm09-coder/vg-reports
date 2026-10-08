// Simple login: users come from the APP_USERS env var ("name:password,name2:password2").
// The session is a signed cookie, so no session table is needed.
const crypto = require('crypto');

const COOKIE = 'vgr_session';
const MAX_AGE_DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set (at least 16 characters)');
  return s;
}

function users() {
  return String(process.env.APP_USERS || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      return { name: pair.slice(0, i).trim(), password: pair.slice(i + 1) };
    })
    .filter((u) => u.name && u.password);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkLogin(name, password) {
  const u = users().find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!u) { safeEqual(password, 'x'); return null; }
  return safeEqual(password, u.password) ? u.name : null;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    if (!users().some((u) => u.name === data.user)) return null; // user removed
    return data;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSession(res, user) {
  const token = sign({ user, exp: Date.now() + MAX_AGE_DAYS * 86400000 });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${secure}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Very small brute-force guard: 10 failed tries per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  return f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) failures.set(ip, { count: 1, first: Date.now() });
  else f.count += 1;
}

function requireLogin(req, res, next) {
  const session = verify(parseCookies(req.headers.cookie)[COOKIE]);
  if (!session) return res.redirect('/login');
  req.user = session.user;
  next();
}

module.exports = { checkLogin, setSession, clearSession, requireLogin, tooManyFailures, recordFailure, users };
