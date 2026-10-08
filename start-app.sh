#!/bin/sh
# Start VG Reports on this computer (Mac / Linux). First run installs and asks for a login.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  exit 1
fi
node scripts/check-node.js || exit 1
if ! node scripts/needs-install.js; then
  echo "Installing the parts VG Reports needs..."
  npm install --no-audit --no-fund || exit 1
fi
[ -f .env ] || node scripts/setup-local.js
( sleep 4; (command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) ) >/dev/null 2>&1 &
exec node src/server.js
