'use strict';
const path = require('path');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const adminUsers = (process.env.ADMIN_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);

const { server, stop } = createApp({
  dataDir,
  worldFile: process.env.WORLD_FILE || path.join(__dirname, '..', 'world', 'index.html'),
  adminUsers,
  trustProxy: process.env.TRUST_PROXY === '1',
});
server.listen(port, () => console.log(`Luma server on http://localhost:${port}  (data: ${dataDir})`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop().then(() => process.exit(0)));
