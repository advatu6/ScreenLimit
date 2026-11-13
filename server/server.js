'use strict';
const path = require('path');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
// on Railway the attached volume's path arrives in RAILWAY_VOLUME_MOUNT_PATH, and it wins:
// writing anywhere else there would be lost on the next deploy
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const hosted = !!process.env.RAILWAY_ENVIRONMENT;
if (hosted && !process.env.RAILWAY_VOLUME_MOUNT_PATH) console.warn('WARNING: no volume is attached. Accounts, stalls and photos will be erased on the next deploy.');
const adminUsers = (process.env.ADMIN_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);

const { server, stop } = createApp({
  dataDir,
  worldFile: process.env.WORLD_FILE || path.join(__dirname, '..', 'world', 'index.html'),
  adminUsers,
  trustProxy: process.env.TRUST_PROXY === '1' || hosted,
});
server.listen(port, () => console.log(`Luma server on http://localhost:${port}  (data: ${dataDir})`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop().then(() => process.exit(0)));
