'use strict';
/** What a player's presence may carry, and the server-side copy of the chat filter. */
const BAD_LONG = ['שרמוט', 'מזדיי', 'כוס אמא', 'כוס אמק', 'כוסאמא', 'כוסאמק', 'כוסעמק', 'בן זונה', 'בת זונה', 'בנזונה', 'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigg'];
const BAD_TOK = ['זונה', 'זונות', 'זין', 'חרא', 'מניאק', 'מניאקית', 'מפגר', 'מפגרת', 'dick', 'ass'];

function cleanChat(t) {
  t = String(t).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 60);
  if (!t) return '';
  if (/\d[\d\s\-.]{5,}\d/.test(t) || /(https?:|www\.|\.com|\.co\.|\.net|\.org|@)/i.test(t)) return '';
  for (const b of BAD_LONG) t = t.replace(new RegExp(b, 'gi'), '***');
  return t.split(/(\s+)/).map((tok) => {
    const core = tok.replace(/^[^a-zA-Zא-ת]+|[^a-zA-Zא-ת]+$/g, '').toLowerCase();
    return core && (BAD_TOK.includes(core) || BAD_TOK.includes(core.replace(/^[וה]/, ''))) ? '***' : tok;
  }).join('');
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0);

/** Keeps only the fields the world knows, each within its limits. */
function cleanPresence(p, uid, prev, now) {
  if (!p || typeof p !== 'object') return null;
  const z = str(p.z, 40);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(z)) return null;
  const out = {
    n: str(p.n, 14), c: /^#[0-9a-f]{6}$/i.test(p.c) ? p.c : '#6fb7ff', h: str(p.h, 24), z,
    x: num(p.x, 0, 1400), y: num(p.y, 0, 900), em: str(p.em, 8), emAt: num(p.emAt, 0, 1e14),
    pt: str(p.pt, 24), cf: p.cf === 1 ? 1 : 0, ac: str(p.ac, 24), fa: str(p.fa, 12),
    s: p.s === uid ? uid : '', say: '', sayAt: 0,
  };
  const say = cleanChat(str(p.say, 60)), sayAt = num(p.sayAt, 0, 1e14);
  if (say && prev && sayAt === prev.sayAt) { out.say = prev.say; out.sayAt = prev.sayAt; }        // the same message, still showing
  else if (say && (!prev || !prev._saidAt || now - prev._saidAt >= 1500)) { out.say = say; out.sayAt = sayAt; out._saidAt = now; }
  if (prev && prev._saidAt && !out._saidAt) out._saidAt = prev._saidAt;
  return out;
}

module.exports = { cleanChat, cleanPresence };
