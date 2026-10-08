// Exit 1 if packages need installing: first run, or package-lock.json changed since.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const marker = path.join(root, 'node_modules', '.package-lock.json');
const lock = path.join(root, 'package-lock.json');
try {
  process.exit(fs.statSync(marker).mtimeMs >= fs.statSync(lock).mtimeMs ? 0 : 1);
} catch {
  process.exit(1);
}
