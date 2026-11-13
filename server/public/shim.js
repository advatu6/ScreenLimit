/*
 * Connects the world page to this server.
 * The world talks to `window.claude.use('db' | 'user' | 'room' | 'assets')`; this file
 * provides those four on top of the server's socket and upload endpoint, so the same
 * world file runs here unchanged.
 */
(() => {
  'use strict';
  const token = (() => { try { return localStorage.getItem('luma-token') || ''; } catch (e) { return ''; } })();
  const uid = (() => { try { return localStorage.getItem('luma-uid') || ''; } catch (e) { return ''; } })();
  const toLogin = () => { try { localStorage.removeItem('luma-token'); } catch (e) {} location.replace('/'); };
  if (!token || !uid) { toLogin(); return; }
  // a different account on this device must not inherit the previous one's local save
  try { if (localStorage.getItem('luma-save-uid') !== uid) { localStorage.removeItem('luma-save-v1'); localStorage.setItem('luma-save-uid', uid); } } catch (e) {}

  const me = fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } }).then((r) => {
    if (r.status === 401) { toLogin(); return new Promise(() => {}); }
    return r.json();
  }).then((j) => { if (j.banned) showBlock('החשבון הזה הושעה על ידי מנהל/ת העולם.'); return j.user; });

  const socket = io({ auth: { token }, transports: ['websocket', 'polling'] });
  let everConnected = false;
  const ready = new Promise((res) => socket.on('connect', () => { everConnected = true; res(); }));
  socket.on('connect_error', (e) => {
    if (e && e.message === 'unauthorized') toLogin();
    else if (e && e.message === 'banned') showBlock('החשבון הזה הושעה על ידי מנהל/ת העולם.');
    else if (e && e.message === 'too_many') showBlock('העולם כבר פתוח אצלך ביותר מדי חלונות. סוגרים אחד ומרעננים.');
  });
  socket.on('banned', () => showBlock('החשבון הזה הושעה על ידי מנהל/ת העולם.'));

  function showBlock(text) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fbf6ec;color:#4a3728;display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;padding:24px;text-align:center;font:500 18px Heebo,Arial,sans-serif';
    const p = document.createElement('p'); p.textContent = text;
    const b = document.createElement('button'); b.textContent = 'התנתקות'; b.style.cssText = 'padding:10px 22px;border-radius:999px;border:0;background:#f2c078;font:inherit;cursor:pointer';
    b.onclick = logout; d.append(p, b);
    (document.body || document.documentElement).append(d);
  }
  function logout() {
    fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {}).then(toLogin);
  }

  // ---- db ----
  const call = (msg) => ready.then(() => new Promise((res, rej) => {
    if (!socket.connected) return rej({ code: 'unavailable', message: 'offline' });
    socket.timeout(10000).emit('db', msg, (err, r) => {
      if (err || !r) return rej({ code: 'unavailable', message: 'no answer' });
      if (r.err) return rej({ code: r.err, message: r.err });
      res(r);
    });
  }));
  const frozen = (v) => JSON.parse(JSON.stringify(v));
  const docSnap = (path, d) => ({ id: path.split('/').pop(), exists: !!(d && d.exists), data: () => (d && d.exists ? frozen(d.data) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  const subsById = new Map(); let subN = 0;
  socket.on('snap', (m) => { const s = subsById.get(m.sid); if (!s) return; if (m.err) { subsById.delete(m.sid); if (s.error) s.error({ code: m.err, message: m.err }); return; } s.deliver(m); });
  socket.on('connect', () => { if (everConnected) for (const [sid, s] of subsById) socket.emit('sub', Object.assign({ sid }, s.spec)); });
  function subscribe(spec, deliver, error) {
    const sid = 's' + (++subN);
    subsById.set(sid, { spec, deliver, error });
    ready.then(() => { if (subsById.has(sid)) socket.emit('sub', Object.assign({ sid }, spec)); });
    return () => { if (subsById.delete(sid)) socket.emit('unsub', sid); };
  }
  const SEG = /^[A-Za-z0-9_.:@+~-]{1,200}$/;
  function check(path, wantDoc) {
    const segs = String(path).split('/');
    if (!segs.every((s) => SEG.test(s)) || (segs.length % 2 === 0) !== wantDoc) throw new TypeError('bad path: ' + path);
    return path;
  }
  function docRef(path) {
    check(path, true);
    return {
      id: path.split('/').pop(), path,
      get: () => call({ op: 'get', path }).then((r) => docSnap(path, r.doc)),
      set: (data) => call({ op: 'set', path, data: frozen(data) }).then(() => {}),
      update: (data) => call({ op: 'update', path, data: frozen(data) }).then(() => {}),
      delete: () => call({ op: 'delete', path }).then(() => {}),
      onSnapshot: (next, error) => subscribe({ path, coll: false }, (m) => next(docSnap(path, m.doc)), error),
      collection: (c) => collRef(path + '/' + c),
    };
  }
  function collRef(path, where) {
    check(path, false);
    const qs = (docs) => { const list = docs.map((d) => docSnap(path + '/' + d.id, { exists: true, data: d.data })); return { docs: list, size: list.length, empty: !list.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
    return {
      path,
      where: (f, op, v) => { if (op !== '==') throw new TypeError('only == is supported'); return collRef(path, { f, op, v }); },
      doc: (id) => docRef(path + '/' + (id || 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36))),
      get: () => call({ op: 'list', path, where }).then((r) => qs(r.docs)),
      onSnapshot: (next, error) => subscribe({ path, coll: true, where }, (m) => next(qs(m.docs)), error),
    };
  }
  const db = { doc: docRef, collection: collRef };

  // ---- user ----
  const user = { id: () => me.then((u) => u.id), isOwner: () => me.then((u) => !!u.admin), canEdit: () => me.then((u) => !!u.admin), can: () => Promise.resolve(true), me: () => me };

  // ---- room: who is on the same island right now ----
  const peerHandlers = new Set();
  socket.on('peers', (m) => {
    const list = m.peers.map((p) => ({ kind: 'viewer', peer: p.peer, by: p.by, isMe: p.by === uid, sameTab: p.peer === socket.id, guest: false, presence: p.presence, updatedAt: Date.now() }));
    for (const fn of peerHandlers) { try { fn({ peers: list, joined: [], left: [], updated: [] }); } catch (e) { setTimeout(() => { throw e; }); } }
  });
  socket.on('disconnect', () => { for (const fn of peerHandlers) { try { fn({ peers: [], joined: [], left: [], updated: [] }); } catch (e) {} } });
  let lastPresence = null;
  socket.on('connect', () => { if (lastPresence) socket.emit('presence', lastPresence); });
  const room = {
    presence: (p) => { lastPresence = Object.assign({}, lastPresence, p); if (socket.connected) socket.emit('presence', lastPresence); return Promise.resolve(); },
    onPeers: (fn) => { peerHandlers.add(fn); return () => peerHandlers.delete(fn); },
    peers: () => [], connected: () => socket.connected,
    emit: () => Promise.resolve(), on: () => () => {},
  };

  // ---- assets: image uploads ----
  const assets = {
    upload: (blob, options) => fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': (options && options.type) || blob.type || 'application/octet-stream' }, body: blob })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw { code: j.error || 'upstream_error', message: j.error || 'upload failed' }; return j; })),
    list: () => Promise.resolve({ assets: [], usage: {} }),
    delete: () => Promise.resolve({ deleted: false }),
  };

  const caps = { db, user, room, assets };
  window.claude = { use: (name) => me.then(() => caps[name] || null) };

  // a way out, added to the world's own menu
  addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('sideItems'); if (!box) return;
    const b = document.createElement('button'); b.textContent = 'התנתקות'; b.addEventListener('click', logout); box.append(b);
  });
})();
