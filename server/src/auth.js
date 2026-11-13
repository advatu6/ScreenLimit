'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const TOKEN_TTL = 60 * 24 * 3600 * 1000; // a login lasts 60 days from its last use
const USERNAME_RE = /^[A-Za-z0-9_֐-׿]{3,16}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normName = (s) => String(s).normalize('NFKC').toLowerCase();
async function hashSecret(secret, salt) {
  return (await scrypt(String(secret), salt, 32)).toString('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newRecoveryCode() {
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length] + (i % 4 === 3 && i < 11 ? '-' : '');
  return s;
}

/** Counts attempts per key inside a sliding window. Kept in memory: a restart clears it. */
class Limiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key) {
    const now = Date.now(), list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) { this.hits.set(key, list); return false; }
    list.push(now); this.hits.set(key, list);
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > this.windowMs) this.hits.delete(k);
    return true;
  }
}

class AuthError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

module.exports = function createAuth(db, { adminUsers = [], limits = {} } = {}) {
  const admins = new Set(adminUsers.map(normName));
  const q = {
    byName: db.prepare('SELECT * FROM users WHERE uname = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) n FROM users'),
    insert: db.prepare('INSERT INTO users(id,username,uname,salt,hash,rec_salt,rec_hash,admin,created) VALUES(?,?,?,?,?,?,?,?,?)'),
    setPass: db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?'),
    setRec: db.prepare('UPDATE users SET rec_salt=?, rec_hash=? WHERE id=?'),
    addToken: db.prepare('INSERT INTO tokens(hash,uid,created,seen) VALUES(?,?,?,?)'),
    token: db.prepare('SELECT * FROM tokens WHERE hash = ?'),
    touch: db.prepare('UPDATE tokens SET seen=? WHERE hash=?'),
    delToken: db.prepare('DELETE FROM tokens WHERE hash=?'),
    delTokens: db.prepare('DELETE FROM tokens WHERE uid=?'),
    purge: db.prepare('DELETE FROM tokens WHERE seen < ?'),
  };
  // per address: wrong guesses are slow to try, yet a family or a classroom behind one router can still sign up
  const loginLimit = new Limiter(limits.login || 10, 10 * 60 * 1000);
  const registerLimit = new Limiter(limits.register || 20, 60 * 60 * 1000);
  const resetLimit = new Limiter(limits.reset || 6, 60 * 60 * 1000);

  const pub = (u) => ({ id: u.id, username: u.username, admin: !!u.admin || admins.has(u.uname) });
  function checkPassword(p) {
    if (typeof p !== 'string' || p.length < 6 || p.length > 128) throw new AuthError('bad_password', 'הסיסמה צריכה להיות באורך 6 תווים לפחות.');
  }
  function issueToken(uid) {
    const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    q.addToken.run(sha(token), uid, now, now);
    return token;
  }
  async function setRecovery(uid) {
    const code = newRecoveryCode(), salt = crypto.randomBytes(16).toString('hex');
    q.setRec.run(salt, await hashSecret(code, salt), uid);
    return code;
  }

  return {
    AuthError,
    async register({ username, password, agree }, ip) {
      if (!registerLimit.allow(ip)) throw new AuthError('rate_limited', 'יותר מדי הרשמות מהמכשיר הזה. אפשר לנסות שוב מאוחר יותר.', 429);
      if (agree !== true) throw new AuthError('terms', 'כדי להירשם צריך לאשר את תנאי השימוש.');
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new AuthError('bad_username', 'שם המשתמש צריך להיות באורך 3 עד 16 תווים: אותיות, ספרות או קו תחתון.');
      checkPassword(password);
      const uname = normName(username);
      if (q.byName.get(uname)) throw new AuthError('taken', 'שם המשתמש הזה כבר תפוס.', 409);
      const id = 'u_' + crypto.randomBytes(12).toString('base64url'), salt = crypto.randomBytes(16).toString('hex');
      // with no admins named in the settings, whoever registers first runs the world
      const hash = await hashSecret(password, salt), first = admins.size === 0 && q.count.get().n === 0;
      try { q.insert.run(id, username, uname, salt, hash, null, null, first ? 1 : 0, Date.now()); }
      catch (e) { throw new AuthError('taken', 'שם המשתמש הזה כבר תפוס.', 409); }
      const recovery = await setRecovery(id);
      return { token: issueToken(id), user: pub(q.byId.get(id)), recovery };
    },
    async login({ username, password }, ip) {
      const uname = normName(username || '');
      if (!loginLimit.allow(ip + '|' + uname)) throw new AuthError('rate_limited', 'יותר מדי ניסיונות כניסה. אפשר לנסות שוב בעוד כמה דקות.', 429);
      const u = q.byName.get(uname);
      // hash even when the user is unknown, so the answer takes the same time either way
      const hash = await hashSecret(String(password || ''), u ? u.salt : '00');
      if (!u || !safeEqual(hash, u.hash)) throw new AuthError('bad_login', 'שם המשתמש או הסיסמה שגויים.', 401);
      return { token: issueToken(u.id), user: pub(u) };
    },
    async reset({ username, recovery, password }, ip) {
      const uname = normName(username || '');
      if (!resetLimit.allow(ip + '|' + uname)) throw new AuthError('rate_limited', 'יותר מדי ניסיונות. אפשר לנסות שוב מאוחר יותר.', 429);
      checkPassword(password);
      const u = q.byName.get(uname), code = String(recovery || '').trim().toUpperCase();
      const hash = await hashSecret(code, u && u.rec_salt ? u.rec_salt : '00');
      if (!u || !u.rec_hash || !safeEqual(hash, u.rec_hash)) throw new AuthError('bad_recovery', 'שם המשתמש או קוד השחזור שגויים.', 401);
      const salt = crypto.randomBytes(16).toString('hex');
      q.setPass.run(salt, await hashSecret(password, salt), u.id);
      q.delTokens.run(u.id);
      const next = await setRecovery(u.id);
      return { token: issueToken(u.id), user: pub(u), recovery: next };
    },
    async newRecovery(uid) { return setRecovery(uid); },
    /** The user a login token belongs to, or null. */
    userFor(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const h = sha(token), row = q.token.get(h), now = Date.now();
      if (!row) return null;
      if (now - row.seen > TOKEN_TTL) { q.delToken.run(h); return null; }
      if (now - row.seen > 3600 * 1000) q.touch.run(now, h);
      const u = q.byId.get(row.uid);
      return u ? pub(u) : null;
    },
    logout(token) { if (typeof token === 'string') q.delToken.run(sha(token)); },
    purgeOld() { q.purge.run(Date.now() - TOKEN_TTL); },
  };
};
