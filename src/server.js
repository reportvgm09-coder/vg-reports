const path = require('path');
const express = require('express');
const { migrate } = require('./db');
const auth = require('./auth');
const { layout, esc } = require('./views');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/healthz', (req, res) => res.send('ok'));

// ---------- login ----------
app.get('/login', (req, res) => {
  res.send(layout({ title: 'Log in', body: loginForm() }));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip;
  if (auth.tooManyFailures(ip)) {
    return res.status(429).send(layout({ title: 'Log in', body: loginForm('Too many tries. Wait 15 minutes.') }));
  }
  const user = auth.checkLogin(req.body.name, req.body.password);
  if (!user) {
    auth.recordFailure(ip);
    return res.status(401).send(layout({ title: 'Log in', body: loginForm('Wrong name or password.', req.body.name) }));
  }
  auth.setSession(res, user);
  res.redirect('/');
});

app.post('/logout', (req, res) => { auth.clearSession(res); res.redirect('/login'); });

function loginForm(error, name) {
  return `<div class="login card">
    <h1>VG Reports</h1>
    ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
    <form method="post" action="/login" class="stack">
      <label>Name<input name="name" value="${esc(name || '')}" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn">Log in</button>
    </form></div>`;
}

// ---------- app pages (login required) ----------
app.use(auth.requireLogin);
app.use(require('./routes/reports'));
app.use(require('./routes/upload'));
app.use(require('./routes/settings'));

app.use((req, res) => res.status(404).send(layout({ title: 'Not found', user: req.user, body: '<p>Page not found. <a href="/">Go to dashboard</a></p>' })));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(layout({ title: 'Error', user: req.user,
    flash: { type: 'error', html: 'Something went wrong. Please try again; if it repeats, note what you clicked.' }, body: '' }));
});

const port = process.env.PORT || 3000;
(async () => {
  if (!auth.users().length) console.warn('APP_USERS is empty: nobody can log in yet.');
  await migrate();
  app.listen(port, () => console.log(`VG Reports running on port ${port}`));
})().catch((e) => { console.error(e); process.exit(1); });
