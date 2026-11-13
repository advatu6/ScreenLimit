'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let base, close, dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-test-'));
  const world = path.join(dir, 'world.html');
  fs.writeFileSync(world, '<!DOCTYPE html><html><body><p>world</p></body></html>');
  const { server, stop } = createApp({ dataDir: dir, worldFile: world, limits: { register: 1000 } });
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  close = () => { for (const s of sockets) s.close(); return stop(); };
});
test.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = (url, body, token) => fetch(base + url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const register = async (username, password = 'secret12') => { const r = await post('/api/register', { username, password, agree: true }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const sockets = [];
const open = (token) => new Promise((res, rej) => { const s = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true }); sockets.push(s); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const db = (s, msg) => new Promise((res) => s.emit('db', msg, res));
const next = (s, ev, pred = () => true, ms = 2000) => new Promise((res, rej) => { const t = setTimeout(() => { s.off(ev, h); rej(new Error('timeout waiting for ' + ev)); }, ms); const h = (m) => { if (pred(m)) { clearTimeout(t); s.off(ev, h); res(m); } }; s.on(ev, h); });

let admin, ann, ben;

test('accounts: register, log in, wrong password, taken name, recovery', async () => {
  admin = await register('Admin1');
  ann = await register('ann');
  ben = await register('בן_דוד');
  assert.equal(admin.user.admin, true, 'the first account is the admin');
  assert.equal(ann.user.admin, false);
  assert.match(ann.recovery, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  assert.equal((await post('/api/register', { username: 'ANN', password: 'secret12', agree: true })).status, 409, 'names are unique regardless of case');
  assert.equal((await post('/api/register', { username: 'x', password: 'secret12', agree: true })).body.error, 'bad_username');
  assert.equal((await post('/api/register', { username: 'carl', password: '123', agree: true })).body.error, 'bad_password');
  assert.equal((await post('/api/register', { username: 'carl', password: 'secret12' })).body.error, 'terms');

  assert.equal((await post('/api/login', { username: 'ann', password: 'wrong-pass' })).status, 401);
  const ok = await post('/api/login', { username: 'Ann', password: 'secret12' });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.id, ann.user.id);

  const me = await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + ok.body.token } }).then((r) => r.json());
  assert.equal(me.user.username, 'ann'); assert.equal(me.banned, false);
  assert.equal((await fetch(base + '/api/me')).status, 401);
  assert.equal((await fetch(base + '/api/me', { headers: { Authorization: 'Bearer nonsense-nonsense-nonsense' } })).status, 401);

  assert.equal((await post('/api/reset', { username: 'ann', recovery: 'AAAA-AAAA-AAAA', password: 'newpass1' })).status, 401);
  const reset = await post('/api/reset', { username: 'ann', recovery: ann.recovery.toLowerCase(), password: 'newpass1' });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.body.recovery, ann.recovery, 'a used recovery code is replaced');
  assert.equal((await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + ann.token } })).status, 401, 'old logins end when the password is reset');
  assert.equal((await post('/api/login', { username: 'ann', password: 'secret12' })).status, 401);
  ann.token = reset.body.token;

  await post('/api/logout', {}, ok.body.token);
});

test('passwords and tokens are not stored in the clear', () => {
  const raw = fs.readFileSync(path.join(dir, 'luma.db')).toString('latin1') + (fs.existsSync(path.join(dir, 'luma.db-wal')) ? fs.readFileSync(path.join(dir, 'luma.db-wal')).toString('latin1') : '');
  assert.ok(!raw.includes('secret12') && !raw.includes('newpass1'));
  assert.ok(!raw.includes(admin.token) && !raw.includes(ben.token));
  assert.ok(!raw.includes(ben.recovery));
});

test('logging in is rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post('/api/login', { username: 'ben_nobody', password: 'nope-nope' });
  assert.equal(last.status, 429);
});

test('the socket needs a valid login', async () => {
  await assert.rejects(open('not-a-real-token-not-a-real-token'), /unauthorized/);
});

test('store rules: what each person may read and write', async () => {
  const sa = await open(admin.token), s1 = await open(ann.token), s2 = await open(ben.token);
  const A = ann.user.id, B = ben.user.id;
  const ok = (r, what) => assert.equal(r.ok, true, what + ': ' + JSON.stringify(r));
  const no = (r, what) => assert.equal(r.err, 'invalid_argument', what + ': ' + JSON.stringify(r));

  // a private save
  ok(await db(s1, { op: 'set', path: `data/users/${A}/save`, data: { coins: 5 } }), 'own save');
  assert.deepEqual((await db(s1, { op: 'get', path: `data/users/${A}/save` })).doc, { exists: true, data: { coins: 5 } });
  assert.deepEqual((await db(s2, { op: 'get', path: `data/users/${A}/save` })).doc, { exists: false }, 'others cannot read it');
  assert.deepEqual((await db(sa, { op: 'get', path: `data/users/${A}/save` })).doc, { exists: false }, 'not even the admin');
  no(await db(s2, { op: 'set', path: `data/users/${A}/save`, data: { coins: 999 } }), 'writing into another save');

  // stalls open only through the admin
  no(await db(s1, { op: 'set', path: `stalls/${A}`, data: { name: 'x' } }), 'opening a stall alone');
  ok(await db(s1, { op: 'set', path: `apps/${A}`, data: { name: 'קרמיקה', status: 'pending', phone: '050' } }), 'own application');
  assert.equal((await db(s2, { op: 'get', path: `apps/${A}` })).doc.exists, false, 'applications are private');
  assert.equal((await db(s2, { op: 'list', path: 'apps' })).docs.length, 0);
  assert.equal((await db(sa, { op: 'list', path: 'apps' })).docs.length, 1, 'the admin sees every application');
  ok(await db(sa, { op: 'set', path: `stalls/${A}`, data: { name: 'קרמיקה', cat: 'art' } }), 'admin approves');
  ok(await db(sa, { op: 'update', path: `apps/${A}`, data: { status: 'approved' } }), 'admin marks approved');
  assert.equal((await db(s1, { op: 'get', path: `apps/${A}` })).doc.data.status, 'approved');
  assert.equal((await db(s1, { op: 'get', path: `apps/${A}` })).doc.data.phone, '050', 'update merges');
  assert.equal((await db(s2, { op: 'list', path: 'stalls' })).docs[0].data.name, 'קרמיקה', 'everyone sees approved stalls');
  no(await db(s1, { op: 'update', path: 'stalls/none', data: { a: 1 } }), 'update of a missing document');

  // keys and private messages
  ok(await db(s1, { op: 'set', path: `keys/${A}`, data: { pub: { x: 1 } } }), 'own key');
  no(await db(s2, { op: 'set', path: `keys/${A}`, data: { pub: { x: 2 } } }), "replacing someone's key");
  assert.equal((await db(s2, { op: 'get', path: `keys/${A}` })).doc.exists, true, 'keys are public');
  ok(await db(s1, { op: 'set', path: `dm/${A}/to/${B}`, data: { m: [{ t: 1, iv: 'a', c: 'b' }] } }), 'own outbox');
  no(await db(s2, { op: 'set', path: `dm/${A}/to/${B}`, data: { m: [] } }), "writing as someone else");
  assert.equal((await db(s2, { op: 'get', path: `dm/${A}/to/${B}` })).doc.exists, true, 'the recipient reads it');
  assert.equal((await db(sa, { op: 'get', path: `dm/${A}/to/${B}` })).doc.exists, true, 'admin can moderate the store');
  const s3 = await open((await register('carla')).token);
  assert.equal((await db(s3, { op: 'get', path: `dm/${A}/to/${B}` })).doc.exists, false, 'a third person cannot');
  ok(await db(s1, { op: 'set', path: `dmidx/${B}__${A}`, data: { to: B, from: A, at: 5, n: 'אן' } }), 'own marker');
  no(await db(s1, { op: 'set', path: `dmidx/${B}__${A}`, data: { to: B, from: B, at: 5 } }), 'a marker that lies about the sender');
  no(await db(s3, { op: 'set', path: `dmidx/${B}__${A}`, data: { to: B, from: A, at: 9 } }), "someone else's marker");
  assert.equal((await db(s2, { op: 'list', path: 'dmidx', where: { f: 'to', op: '==', v: B } })).docs.length, 1);
  assert.equal((await db(s3, { op: 'list', path: 'dmidx' })).docs.length, 0, 'markers show only to the two sides');

  // reports and moderation
  ok(await db(s2, { op: 'set', path: `reports/${B}`, data: { list: [{ id: 'r1', reason: 'x' }] } }), 'own report');
  assert.equal((await db(s1, { op: 'list', path: 'reports' })).docs.length, 0);
  assert.equal((await db(sa, { op: 'list', path: 'reports' })).docs.length, 1);
  no(await db(s1, { op: 'set', path: 'mod/event', data: { id: 'hanukkah', on: true } }), 'switching an event on');
  ok(await db(sa, { op: 'set', path: 'mod/event', data: { id: 'hanukkah', on: true } }), 'admin switches it on');
  assert.equal((await db(s1, { op: 'get', path: 'mod/event' })).doc.data.on, true);

  // anything else, and malformed input
  no(await db(s1, { op: 'set', path: 'secrets/x', data: { a: 1 } }), 'unknown collection');
  no(await db(s1, { op: 'set', path: `data/users/${A}/save`, data: [1, 2] }), 'non-object body');
  no(await db(s1, { op: 'set', path: `data/users/${A}/../x`, data: {} }), 'path tricks');
  no(await db(s1, { op: 'get', path: 'stalls' }), 'collection path as a document');
  no(await db(s1, { op: 'set', path: `data/users/${A}/big`, data: { s: 'x'.repeat(300 * 1024) } }), 'oversized document');
});

test('subscriptions deliver changes live, and only to those allowed', async () => {
  const sa = await open(admin.token), s2 = await open(ben.token);
  const B = ben.user.id;
  const first = next(s2, 'snap', (m) => m.sid === 'stalls');
  s2.emit('sub', { sid: 'stalls', path: 'stalls', coll: true });
  assert.equal((await first).docs.length, 1);
  const change = next(s2, 'snap', (m) => m.sid === 'stalls' && m.docs.length === 2);
  await db(sa, { op: 'set', path: `stalls/${B}`, data: { name: 'עוגות' } });
  assert.ok((await change).docs.some((d) => d.data.name === 'עוגות'));

  s2.emit('sub', { sid: 'mine', path: `apps/${B}`, coll: false });
  await next(s2, 'snap', (m) => m.sid === 'mine' && !m.doc.exists);
  const got = next(s2, 'snap', (m) => m.sid === 'mine' && m.doc.exists);
  await db(s2, { op: 'set', path: `apps/${B}`, data: { name: 'עוגות', status: 'pending' } });
  assert.equal((await got).doc.data.status, 'pending');

  const gone = next(s2, 'snap', (m) => m.sid === 'stalls' && m.docs.length === 1);
  await db(sa, { op: 'delete', path: `stalls/${B}` });
  await gone;
  s2.emit('unsub', 'stalls');
});

test('presence: people on the same island see each other, chat is filtered', async () => {
  const s1 = await open(ann.token), s2 = await open(ben.token);
  const seen = next(s1, 'peers', (m) => m.peers.length === 2);
  s1.emit('presence', { n: 'אן', c: '#ff8f70', h: 'none', z: 'plaza', x: 700, y: 500 });
  s2.emit('presence', { n: 'בן', c: 'red; drop', h: 'none', z: 'plaza', x: 99999, y: 400, s: 'someone-else', extra: 'ignored' });
  const m = await seen, other = m.peers.find((p) => p.by === ben.user.id);
  assert.equal(other.presence.x, 1400, 'coordinates are clamped');
  assert.equal(other.presence.c, '#6fb7ff', 'a bad colour is replaced');
  assert.equal(other.presence.s, '', 'you cannot claim to be another stall owner');
  assert.equal(other.presence.extra, undefined);

  const said = next(s1, 'peers', (x) => x.peers.some((p) => p.by === ben.user.id && p.presence.say));
  s2.emit('presence', { n: 'בן', z: 'plaza', x: 10, y: 10, say: 'שלום לכולם', sayAt: 1 });
  assert.equal((await said).peers.find((p) => p.by === ben.user.id).presence.say, 'שלום לכולם');

  await new Promise((r) => setTimeout(r, 1600));
  const link = next(s1, 'peers', (x) => x.peers.some((p) => p.by === ben.user.id && p.presence.x === 11));
  s2.emit('presence', { n: 'בן', z: 'plaza', x: 11, y: 10, say: 'בואו ל www.example.com', sayAt: 2 });
  assert.equal((await link).peers.find((p) => p.by === ben.user.id).presence.say, '', 'links never reach the others');

  const left = next(s1, 'peers', (x) => x.z === 'plaza' && x.peers.length === 1);
  s2.emit('presence', { n: 'בן', z: 'beach', x: 10, y: 10 });
  await left;
});

test('uploads: images only, checked by content', async () => {
  const up = (body, type, token = ann.token) => fetch(base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': type }, body }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const good = await up(PNG, 'image/png');
  assert.equal(good.status, 200); assert.match(good.body.id, /^[0-9a-f]{32}$/);
  const back = await fetch(base + good.body.url);
  assert.equal(back.headers.get('content-type'), 'image/png');
  assert.equal(back.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), PNG);
  assert.equal((await up(Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 415, 'html pretending to be a png');
  assert.equal((await up(Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);
  assert.equal((await up(PNG, 'image/png', 'bad-token-bad-token-bad-token')).status, 401);
  assert.equal((await up(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), 'image/png')).status, 413);
  assert.equal((await fetch(base + '/_blob/' + '0'.repeat(32))).status, 404);
  assert.equal((await fetch(base + '/_blob/..%2Fluma.db')).status, 404);
});

test('a suspended account is cut off at once and cannot return', async () => {
  const sa = await open(admin.token), s2 = await open(ben.token);
  const kicked = next(s2, 'banned');
  await db(sa, { op: 'set', path: 'mod/bans', data: { ids: { [ben.user.id]: { n: 'בן', at: 1 } } } });
  await kicked;
  await assert.rejects(open(ben.token), /banned/);
  const me = await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + ben.token } }).then((r) => r.json());
  assert.equal(me.banned, true);
  await db(sa, { op: 'set', path: 'mod/bans', data: { ids: {} } });
  (await open(ben.token)).close();
});

test('pages: the world is served with the connector injected', async () => {
  const html = await fetch(base + '/world').then((r) => r.text());
  assert.ok(html.includes('<script src="/shim.js"></script>') && html.includes('<p>world</p>'));
  const home = await fetch(base + '/');
  assert.match(await home.text(), /איי לומה/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/shim.js')).status, 200);
  assert.equal((await fetch(base + '/manifest.webmanifest')).status, 200);
});
