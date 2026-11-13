'use strict';
/**
 * The document store behind the world: JSON documents at slash-separated paths,
 * with the access rules the world relies on enforced here, on the server.
 *
 *   data/users/<id>/...   private to that account (not even an admin reads it)
 *   apps/<id>             a stall application: its owner and admins
 *   stalls/<id>           everyone reads, admins write (a stall opens only when approved)
 *   keys/<id>             everyone reads, the account itself writes its public key
 *   dm/<id>/to/<other>    the two people in the conversation read (the content is
 *                         end-to-end encrypted anyway), only the sender writes
 *   dmidx/<to>__<from>    "you have mail" markers: the sender writes its own
 *   reports/<id>          the reporter and admins
 *   mod/<doc>             everyone reads, admins write (bans, the active event)
 */
const SEG = /^[A-Za-z0-9_.:@+~-]{1,200}$/;
const MAX_DOC_BYTES = 256 * 1024;

class StoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function parsePath(path, wantDoc) {
  if (typeof path !== 'string' || path.length > 1000) throw new StoreError('invalid_argument');
  const segs = path.split('/');
  if (segs.length > 16 || !segs.every((s) => SEG.test(s) && s !== '.' && s !== '..')) throw new StoreError('invalid_argument');
  if ((segs.length % 2 === 0) !== wantDoc) throw new StoreError('invalid_argument');
  return segs;
}

/** May this user read / write this document? */
function can(user, action, segs, data) {
  const write = action === 'write', id = user.id, admin = !!user.admin;
  switch (segs[0]) {
    case 'data': return segs[1] === 'users' && segs[2] === id && segs.length >= 4;
    case 'apps': return segs.length === 2 && (segs[1] === id || admin);
    case 'stalls': return segs.length === 2 && (!write || admin);
    case 'keys': return segs.length === 2 && (!write || segs[1] === id || admin);
    case 'dm': return segs.length === 4 && segs[2] === 'to' && (write ? segs[1] === id || admin : segs[1] === id || segs[3] === id || admin);
    case 'dmidx': {
      if (segs.length !== 2) return false;
      if (!write) return segs[1].startsWith(id + '__') || segs[1].endsWith('__' + id) || admin;
      if (admin) return true;
      if (!segs[1].endsWith('__' + id)) return false;
      return data === undefined || (data && data.from === id && segs[1] === data.to + '__' + id);
    }
    case 'reports': return segs.length === 2 && (segs[1] === id || admin);
    case 'mod': return segs.length === 2 && (!write || admin);
    default: return false;
  }
}

module.exports = function createStore(db) {
  const q = {
    get: db.prepare('SELECT data, updated FROM docs WHERE path = ?'),
    put: db.prepare('INSERT INTO docs(path,coll,data,updated) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated'),
    del: db.prepare('DELETE FROM docs WHERE path = ?'),
    list: db.prepare('SELECT path, data FROM docs WHERE coll = ? ORDER BY path LIMIT 2000'),
  };
  const listeners = new Set();
  const changed = (path) => { for (const fn of listeners) { try { fn(path); } catch (e) { /* a listener must not break a write */ } } };

  function checkBody(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreError('invalid_argument');
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw new StoreError('invalid_argument');
    return json;
  }
  function merge(into, from, depth = 0) {
    if (depth > 32) throw new StoreError('invalid_argument');
    for (const k of Object.keys(from)) {
      const v = from[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object' && !Array.isArray(into[k])) merge(into[k], v, depth + 1);
      else into[k] = v;
    }
    return into;
  }
  const raw = (path) => { const r = q.get.get(path); return r ? JSON.parse(r.data) : null; };

  return {
    StoreError,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Reads straight from the table, with no access check: for the server's own use. */
    raw,
    get(user, path) {
      const segs = parsePath(path, true);
      if (!can(user, 'read', segs)) return { exists: false };
      const d = raw(path);
      return d ? { exists: true, data: d } : { exists: false };
    },
    set(user, path, data) {
      const segs = parsePath(path, true), json = checkBody(data);
      if (!can(user, 'write', segs, data)) throw new StoreError('invalid_argument');
      q.put.run(path, segs.slice(0, -1).join('/'), json, Date.now());
      changed(path);
    },
    update(user, path, data) {
      const segs = parsePath(path, true);
      checkBody(data);
      const cur = raw(path);
      if (!cur) throw new StoreError('invalid_argument');
      const next = merge(cur, data);
      if (!can(user, 'write', segs, next)) throw new StoreError('invalid_argument');
      q.put.run(path, segs.slice(0, -1).join('/'), checkBody(next), Date.now());
      changed(path);
    },
    delete(user, path) {
      const segs = parsePath(path, true);
      if (!can(user, 'write', segs)) throw new StoreError('invalid_argument');
      q.del.run(path);
      changed(path);
    },
    /** The documents directly inside a collection that this user may read. */
    list(user, coll, where) {
      const segs = parsePath(coll, false), out = [];
      if (where && (typeof where.f !== 'string' || where.op !== '==')) throw new StoreError('invalid_argument');
      for (const row of q.list.all(coll)) {
        const p = row.path.split('/');
        if (p.length !== segs.length + 1 || !can(user, 'read', p)) continue;
        const data = JSON.parse(row.data);
        if (where && data[where.f] !== where.v) continue;
        out.push({ id: p[p.length - 1], data });
      }
      return out;
    },
  };
};
module.exports.can = can;
