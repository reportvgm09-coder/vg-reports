// Exit 1 if Node.js is older than 20.
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.log(`  Node.js ${process.versions.node} is too old. Install the LTS version from https://nodejs.org`);
  process.exit(1);
}
