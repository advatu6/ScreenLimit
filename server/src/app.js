'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const openDb = require('./db');
const createAuth = require('./auth');
const createStore = require('./store');
const { cleanPresence } = require('./chat');

const MAX_UPLOAD = 5 * 1024 * 1024, MAX_FILES_PER_USER = 80, MAX_SOCKETS_PER_USER = 4;
const IMAGE_TYPES = {
  'image/png': (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8',
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

/**
 * Builds the whole server: accounts, the document store, uploads, and the live room.
 * Nothing listens until you call `.listen()` on the returned http server.
 */
function createApp({ dataDir, worldFile, adminUsers = [], trustProxy = false, limits } = {}) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = openDb(path.join(dataDir, 'luma.db'));
  const auth = createAuth(db, { adminUsers, limits });
  const store = createStore(db);
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 400 * 1024, serveClient: true });
  if (trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const bans = () => { const d = store.raw('mod/bans'); return (d && d.ids && typeof d.ids === 'object') ? d.ids : {}; };
  const isBanned = (u) => !u.admin && !!bans()[u.id];

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use('/api', express.json({ limit: '20kb' }));

  const bearer = (req) => { const h = req.get('authorization') || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
  const needUser = (req, res, next) => {
    const u = auth.userFor(bearer(req));
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    req.user = u; next();
  };
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) {
      if (e instanceof auth.AuthError) return res.status(e.status).json({ error: e.code, message: e.message });
      console.error(e); res.status(500).json({ error: 'server', message: 'משהו השתבש. אפשר לנסות שוב.' });
    }
  };

  app.post('/api/register', wrap((req) => auth.register(req.body || {}, req.ip)));
  app.post('/api/login', wrap((req) => auth.login(req.body || {}, req.ip)));
  app.post('/api/reset', wrap((req) => auth.reset(req.body || {}, req.ip)));
  app.post('/api/logout', (req, res) => { auth.logout(bearer(req)); res.json({ ok: true }); });
  app.get('/api/me', needUser, (req, res) => res.json({ user: req.user, banned: isBanned(req.user) }));
  app.post('/api/recovery', needUser, wrap(async (req) => ({ recovery: await auth.newRecovery(req.user.id) })));

  // uploads: images only, checked by their first bytes, stored under a random id
  const q = {
    addFile: db.prepare('INSERT INTO files(id,uid,type,size,created) VALUES(?,?,?,?,?)'),
    file: db.prepare('SELECT * FROM files WHERE id = ?'),
    fileCount: db.prepare('SELECT COUNT(*) n FROM files WHERE uid = ?'),
  };
  app.post('/api/upload', needUser, express.raw({ type: Object.keys(IMAGE_TYPES), limit: MAX_UPLOAD }), (req, res) => {
    if (isBanned(req.user)) return res.status(403).json({ error: 'banned' });
    const type = (req.get('content-type') || '').split(';')[0].trim(), body = req.body;
    if (!IMAGE_TYPES[type] || !Buffer.isBuffer(body) || !body.length) return res.status(415).json({ error: 'unsupported_type' });
    if (!IMAGE_TYPES[type](body)) return res.status(415).json({ error: 'unsupported_type' });
    if (q.fileCount.get(req.user.id).n >= MAX_FILES_PER_USER) return res.status(409).json({ error: 'quota_or_state' });
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'uploads', id), body);
    q.addFile.run(id, req.user.id, type, body.length, Date.now());
    res.json({ id, url: '/_blob/' + id, sizeBytes: body.length, contentType: type });
  });
  app.use('/api/upload', (err, req, res, next) => res.status(err && err.type === 'entity.too.large' ? 413 : 400).json({ error: err && err.type === 'entity.too.large' ? 'too_large' : 'invalid_request' }));
  app.get('/_blob/:id', (req, res) => {
    const row = /^[0-9a-f]{32}$/.test(req.params.id) && q.file.get(req.params.id);
    if (!row) return res.status(404).end();
    res.set({ 'Content-Type': row.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    fs.createReadStream(path.join(dataDir, 'uploads', row.id)).on('error', () => res.status(404).end()).pipe(res);
  });

  // pages
  const pub = path.join(__dirname, '..', 'public');
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'auth.html')));
  app.get('/world', (req, res) => {
    fs.readFile(worldFile, 'utf8', (err, html) => {
      if (err) return res.status(500).send('world file missing');
      const inject = '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#fbf6ec"><script src="/socket.io/socket.io.js"></script><script src="/shim.js"></script>';
      res.set('Cache-Control', 'no-cache').type('html').send(html.replace('<body>', '<body>' + inject));
    });
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.static(pub, { index: false, maxAge: '1h' }));

  // ---- live: one socket per open tab ----
  const subs = new Map();          // 'd:<path>' or 'c:<collection>' -> Set of "socketId|subId"
  const peers = new Map();         // socket.id -> { uid, presence }
  const dirty = new Set();         // zones whose peer list changed since the last tick
  const perUser = new Map();       // uid -> number of open sockets
  const key = (sub) => (sub.coll ? 'c:' : 'd:') + sub.path;

  io.use((socket, next) => {
    const u = auth.userFor(socket.handshake.auth && socket.handshake.auth.token);
    if (!u) return next(new Error('unauthorized'));
    if (isBanned(u)) return next(new Error('banned'));
    if ((perUser.get(u.id) || 0) >= MAX_SOCKETS_PER_USER) return next(new Error('too_many'));
    socket.data.user = u; next();
  });

  function snapshot(user, sub) {
    return sub.coll ? { docs: store.list(user, sub.path, sub.where) } : { doc: store.get(user, sub.path) };
  }
  store.onChange((p) => {
    const coll = p.split('/').slice(0, -1).join('/');
    for (const k of ['d:' + p, 'c:' + coll]) {
      for (const ref of subs.get(k) || []) {
        const [sid, subId] = ref.split('|'), s = io.sockets.sockets.get(sid);
        if (!s) continue;
        const sub = s.data.subs.get(subId);
        if (sub) { try { s.emit('snap', Object.assign({ sid: subId }, snapshot(s.data.user, sub))); } catch (e) { /* skip */ } }
      }
    }
    if (p === 'mod/bans') for (const s of io.sockets.sockets.values()) if (isBanned(s.data.user)) { s.emit('banned'); s.disconnect(true); }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.data.subs = new Map();
    perUser.set(user.id, (perUser.get(user.id) || 0) + 1);
    let ops = 0, opsAt = Date.now(), moves = 0, movesAt = Date.now();
    const allow = () => { const now = Date.now(); if (now - opsAt > 10000) { ops = 0; opsAt = now; } return ++ops <= 120; };

    socket.on('db', (m, ack) => {
      if (typeof ack !== 'function') return;
      if (!m || typeof m !== 'object') return ack({ err: 'invalid_argument' });
      if (!allow()) return ack({ err: 'resource_exhausted' });
      try {
        if (m.op === 'get') return ack({ ok: true, doc: store.get(user, m.path) });
        if (m.op === 'list') return ack({ ok: true, docs: store.list(user, m.path, m.where) });
        if (isBanned(user)) return ack({ err: 'revoked' });
        if (m.op === 'set') store.set(user, m.path, m.data);
        else if (m.op === 'update') store.update(user, m.path, m.data);
        else if (m.op === 'delete') store.delete(user, m.path);
        else return ack({ err: 'invalid_argument' });
        ack({ ok: true });
      } catch (e) { ack({ err: e instanceof store.StoreError ? e.code : 'unavailable' }); if (!(e instanceof store.StoreError)) console.error(e); }
    });

    socket.on('sub', (m) => {
      if (!m || typeof m.sid !== 'string' || m.sid.length > 40 || socket.data.subs.size >= 64) return;
      const sub = { path: m.path, coll: !!m.coll, where: m.where };
      try {
        const first = snapshot(user, sub);       // also validates the path
        socket.data.subs.set(m.sid, sub);
        if (!subs.has(key(sub))) subs.set(key(sub), new Set());
        subs.get(key(sub)).add(socket.id + '|' + m.sid);
        socket.emit('snap', Object.assign({ sid: m.sid }, first));
      } catch (e) { socket.emit('snap', { sid: m.sid, err: e instanceof store.StoreError ? e.code : 'unavailable' }); }
    });
    const dropSub = (sid) => { const sub = socket.data.subs.get(sid); if (!sub) return; socket.data.subs.delete(sid); const set = subs.get(key(sub)); if (set) { set.delete(socket.id + '|' + sid); if (!set.size) subs.delete(key(sub)); } };
    socket.on('unsub', (sid) => dropSub(String(sid)));

    socket.on('presence', (p) => {
      const now = Date.now();
      if (now - movesAt > 1000) { moves = 0; movesAt = now; }
      if (++moves > 25) return;
      const prev = peers.get(socket.id), clean = cleanPresence(p, user.id, prev && prev.presence, now);
      if (!clean) return;
      if (prev && prev.presence.z !== clean.z) { socket.leave('z:' + prev.presence.z); dirty.add(prev.presence.z); }
      if (!prev || prev.presence.z !== clean.z) socket.join('z:' + clean.z);
      peers.set(socket.id, { uid: user.id, presence: clean });
      dirty.add(clean.z);
    });

    socket.on('disconnect', () => {
      for (const sid of [...socket.data.subs.keys()]) dropSub(sid);
      const p = peers.get(socket.id);
      if (p) { peers.delete(socket.id); dirty.add(p.presence.z); }
      const n = (perUser.get(user.id) || 1) - 1;
      if (n > 0) perUser.set(user.id, n); else perUser.delete(user.id);
    });
  });

  // ten times a second, everyone in a zone that changed gets that zone's current list
  const tick = setInterval(() => {
    if (!dirty.size) return;
    const zones = [...dirty]; dirty.clear();
    for (const z of zones) {
      const list = [];
      for (const [sid, p] of peers) if (p.presence.z === z) { const { _saidAt, ...presence } = p.presence; list.push({ peer: sid, by: p.uid, presence }); }
      io.to('z:' + z).emit('peers', { z, peers: list, online: peers.size });
    }
  }, 100);
  const purge = setInterval(() => auth.purgeOld(), 6 * 3600 * 1000);
  tick.unref(); purge.unref();

  /** Stops everything: disconnects everyone, closes the port and the database. */
  const stop = () => new Promise((resolve) => {
    clearInterval(tick); clearInterval(purge);
    io.close(() => { try { db.close(); } catch (e) { /* already closed */ } resolve(); });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
  return { server, app, io, db, auth, store, stop };
}

module.exports = { createApp };
