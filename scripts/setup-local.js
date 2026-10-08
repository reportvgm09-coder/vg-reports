// First-run setup for using VG Reports on your own computer.
// Asks for a login and writes the .env file. Run again any time to change it.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const envFile = path.join(__dirname, '..', '.env');

function ask(question, { hidden = false, fallback = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the question, then hide what is typed.
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim() || fallback);
    });
  });
}

function readEnv() {
  const out = {};
  if (!fs.existsSync(envFile)) return out;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const env = readEnv();
  console.log('');
  console.log('  VG Reports: set up a login for this computer');
  console.log('  ---------------------------------------------');
  const name = (await ask('  Login name [owner]: ', { fallback: 'owner' })).replace(/[:,]/g, '');
  let password = '';
  for (;;) {
    password = await ask('  Password (nothing shows while you type): ', { hidden: true });
    if (password.length < 6) { console.log('  Use at least 6 characters.'); continue; }
    if (/[,]/.test(password)) { console.log('  Please leave out commas.'); continue; }
    const again = await ask('  Type it again: ', { hidden: true });
    if (again === password) break;
    console.log('  They did not match. Try again.');
  }

  const lines = [
    '# VG Reports on this computer. Created by start-app; run setup again to change.',
    '# Keep this file private: it holds your login.',
    `APP_USERS=${name}:${password}`,
    `PORT=${env.PORT || 3000}`,
    '',
    '# Orders page (optional): connection string of a READ-ONLY MongoDB Atlas user',
    '# for the Sales Order app. See README, "Orders from the Sales Order app".',
    `ORDERS_MONGO_URL=${env.ORDERS_MONGO_URL || ''}`,
    `ORDERS_DB_NAME=${env.ORDERS_DB_NAME || 'sale_order_db'}`,
    '',
  ];
  fs.writeFileSync(envFile, lines.join('\n'));
  console.log('');
  console.log(`  Saved. Log in as "${name}" with the password you just typed.`);
  console.log('');
})();
