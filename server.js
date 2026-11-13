'use strict';
// ================================================================
// Coupon Hub — coupon API + public leaderboard + admin dashboard
// Zero dependencies. Node 18+.   Start:  node server.js
// ================================================================
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── .env loader (so it works without extra packages) ────────────
try {
  const t = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// ── config ──────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT, 10) || 3939;
const API_KEY    = String(process.env.COUPON_API_KEY || '').trim();
const ADMIN_USER = String(process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASS = String(process.env.ADMIN_PASSWORD || '');
const SITE_NAME  = String(process.env.SITE_NAME || 'Coupon Hub').slice(0, 40);
const DATA_DIR   = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const FORCE_SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const PUBLIC_BOARD = String(process.env.PUBLIC_LEADERBOARD || 'on').toLowerCase() !== 'off';
const SESSION_HOURS = 8;

const problems = [];
if (API_KEY.length < 16) problems.push('COUPON_API_KEY must be at least 16 characters.');
if (ADMIN_PASS.length < 10 || ADMIN_PASS === 'change-me-please') problems.push('ADMIN_PASSWORD must be at least 10 characters (and not the example value).');
if (problems.length) {
  console.error('\n❌ Cannot start:\n - ' + problems.join('\n - ') + '\n\nRun "node setup.js" to generate safe values.\n');
  process.exit(1);
}
const SESSION_SECRET = String(process.env.SESSION_SECRET || '') ||
  crypto.createHash('sha256').update('session:' + API_KEY + ':' + ADMIN_PASS).digest('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ── storage ─────────────────────────────────────────────────────
let db = { coupons: {}, users: {}, usersUpdatedAt: 0, adjustments: [], audit: [], accounts: {}, balances: {}, signups: {}, logins: {}, market: { shop: [], coins: [], listings: [], updatedAt: 0 }, jobs: [] };
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = Object.assign(db, loaded);
} catch {}
for (const k of ['coupons', 'users', 'accounts', 'balances', 'signups', 'logins']) if (!db[k] || typeof db[k] !== 'object') db[k] = {};
if (!db.market || typeof db.market !== 'object') db.market = { shop: [], coins: [], listings: [], updatedAt: 0 };
for (const k of ['shop', 'coins', 'listings']) if (!Array.isArray(db.market[k])) db.market[k] = [];
for (const k of ['adjustments', 'audit', 'jobs']) if (!Array.isArray(db[k])) db[k] = [];
if (!db.chats || typeof db.chats !== 'object') db.chats = {};   // live chat: visitors <-> customer care
if (!Array.isArray(db.transfers)) db.transfers = [];            // player -> player money transfers made on the site

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function addAudit(by, action, detail) {
  db.audit.unshift({ at: Date.now(), by, action, detail });
  if (db.audit.length > 500) db.audit.length = 500;
}

// ── helpers ─────────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function safeEq(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }

function parseAmount(s) {
  const t = String(s ?? '').toLowerCase().replace(/[,$_\s]/g, '');
  const mm = t.match(/^(\d+(?:\.\d+)?)([kmbt])?$/);
  if (!mm) return NaN;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[mm[2]] || 1;
  return Math.floor(parseFloat(mm[1]) * mult);
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function seg() {
  const b = crypto.randomBytes(4);
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
function makeCode() {
  let c;
  do { c = `CPN-${seg()}-${seg()}-${seg()}`; } while (db.coupons[c]);
  return c;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

// sliding-window rate limiter
const buckets = new Map();
function hit(name, key, max, windowMs) {
  const k = name + ':' + key;
  const now = Date.now();
  const arr = (buckets.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now);
  buckets.set(k, arr);
  return arr.length > max;
}
function peek(name, key, max, windowMs) {
  const now = Date.now();
  return (buckets.get(name + ':' + key) || []).filter(t => now - t < windowMs).length >= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.some(t => now - t < 3600000)) buckets.delete(k);
  for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k);
  for (const [k, s] of usessions) if (s.exp < now) usessions.delete(k);
  for (const [k, c] of Object.entries(db.chats)) if (now - c.updatedAt > 30 * 86400000) delete db.chats[k];
}, 120000).unref();

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'too_big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(httpError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  }, SEC_HEADERS, extra));
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon'
};
function sendFile(res, rel) {
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { ok: false, error: 'not_found' });
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, { ok: false, error: 'not_found' });
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Content-Length': buf.length
    }, SEC_HEADERS));
    res.end(buf);
  });
}

// ── admin sessions ──────────────────────────────────────────────
const sessions = new Map();   // sid -> { user, exp }
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function getSession(req, cookie = 'sid', store = sessions) {
  const raw = parseCookies(req)[cookie];
  if (!raw) return null;
  const [sid, mac] = raw.split('.');
  if (!sid || !mac || !safeEq(sign(sid), mac)) return null;
  const s = store.get(sid);
  if (!s || s.exp < Date.now()) { store.delete(sid); return null; }
  return { sid, user: s.user };
}
function cookieHeader(req, value, maxAge, name = 'sid') {
  const secure = FORCE_SECURE_COOKIE || String(req.headers['x-forwarded-proto'] || '') === 'https';
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// ── player accounts (hashes come from the bot — never plain passwords) ──
const usessions = new Map();   // sid -> { user: <last10 number>, exp }
const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const DUMMY_HASH = 's1$' + '0'.repeat(32) + '$' + '0'.repeat(128);
function checkPass(hash, pw) {
  try {
    const [v, salt, hex] = String(hash || DUMMY_HASH).split('$');
    if (v !== 's1') return false;
    const key = crypto.scryptSync(String(pw), salt, 64);
    const want = Buffer.from(hex, 'hex');
    return want.length === key.length && crypto.timingSafeEqual(key, want);
  } catch { return false; }
}
const SIGNUP_TTL = 3600000;
function hashPassAsync(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(String(pw), salt, 64, (err, key) => err ? reject(err) : resolve(`s1$${salt}$${key.toString('hex')}`));
  });
}
const keyOf = (token) => crypto.createHash('sha256').update('chat:' + String(token)).digest('hex').slice(0, 24);
function chatKey(req) {
  const t = parseCookies(req).cid;
  return t && /^[A-Za-z0-9_-]{20,64}$/.test(t) ? keyOf(t) : null;
}
function killSessions(number) { for (const [k, v] of usessions) if (v.user === number) usessions.delete(k); }
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newVerifyCode() {
  let c;
  do { const b = crypto.randomBytes(8); c = ''; for (let i = 0; i < 8; i++) c += CODE_ALPHA[b[i] % 32]; } while (db.signups[c]);
  return c;
}
const JOB_TTL = 180000;
const OPEN = (a) => a.status === 'pending' || a.status === 'sent';
function newJob(fields) {
  const j = Object.assign({ id: crypto.randomBytes(6).toString('hex'), status: 'pending', createdAt: Date.now() }, fields);
  db.jobs.unshift(j);
  if (db.jobs.length > 1500) db.jobs.length = 1500;
  return j;
}

// ── wallet + transfers ──────────────────────────────────────────
// find a player by WhatsApp number (last 10 digits) or by the bot's id. Looks in the
// fast balance feed first, then in the leaderboard feed, so the wallet is never blank.
function findPlayer(key, jid) {
  const srcs = [db.balances, db.users];
  if (jid) for (const src of srcs) if (src[jid]) return { jid, w: src[jid] };
  if (key && key.length >= 7) for (const src of srcs) for (const id of Object.keys(src)) if (last10(id) === key) return { jid: id, w: src[id] };
  return null;
}
function queueAdj(user, name, op, amount, t, leg, field) {
  db.adjustments.unshift({
    id: crypto.randomBytes(6).toString('hex'), user, name: String(name || 'Player').slice(0, 60),
    field: field || 'balance', op, amount, status: 'pending', createdAt: Date.now(), by: 'site', transferId: t.id, leg
  });
  if (db.adjustments.length > 1000) db.adjustments.length = 1000;
}
// the bot reports each leg of a transfer: take the money first, give it only after that worked
function transferLeg(a, ok, r) {
  const t = db.transfers.find(x => x.id === a.transferId);
  if (!t) return;
  const now = Date.now();
  const fF = t.fromField || 'balance', tF = t.toField || 'balance';   // deposit/withdraw move money between wallet and bank
  const bump = (jid, field, delta) => {
    if (field === 'balance' && Number.isFinite(Number(r && r.balance))) return;   // the bot already told us the new balance
    for (const src of [db.balances, db.users]) if (src[jid]) src[jid][field] = Math.max(0, (src[jid][field] || 0) + delta);
  };
  if (a.leg === 'debit') {
    if (ok) { bump(t.from, fF, -t.amount); t.status = 'crediting'; queueAdj(t.to, t.toName, 'add', t.amount, t, 'credit', tF); }
    else { t.status = 'failed'; t.error = String((r && r.error) || 'failed').slice(0, 80); t.doneAt = now; }
  } else if (a.leg === 'credit') {
    if (ok) { bump(t.to, tF, t.amount); t.status = 'done'; t.doneAt = now; }
    else { t.status = 'refunding'; t.error = 'credit_failed'; queueAdj(t.from, t.fromName, 'add', t.amount, t, 'refund', fF); }
  } else if (a.leg === 'refund') {
    if (ok) bump(t.from, fF, t.amount);
    t.status = 'failed'; t.error = ok ? 'refunded' : 'refund_failed'; t.doneAt = now;
    if (!ok) addAudit('site', 'transfer_refund_failed', `${t.amount} to ${t.fromName} (transfer ${t.id})`);
  }
}

// ── routing ─────────────────────────────────────────────────────
const FIELDS = ['balance', 'bank', 'gams'];
const OPS    = ['add', 'remove', 'set'];

const total = (u) => (u.balance || 0) + (u.bank || 0);
const num0  = (n) => { n = Math.floor(Number(n)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e15) : 0; };

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);

  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  // ─────────── bot → site (needs API key) ───────────
  const BOT = ['/coupon/create', '/coupon/redeem', '/api/sync', '/api/market/sync', '/api/verify', '/api/pending', '/api/ack'];
  if (BOT.includes(p)) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
    // only FAILED key attempts count toward the limit (the bot polls every 10s)
    if (peek('botfail', ip, 20, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    if (!safeEq(req.headers['x-api-key'] || '', API_KEY)) {
      hit('botfail', ip, 20, 60000);
      return send(res, 401, { ok: false, error: 'unauthorized' });
    }
    const body = await readBody(req, (p === '/api/sync' || p === '/api/market/sync') ? 6 * 1024 * 1024 : 20000);

    if (p === '/coupon/create') {
      const amount = Math.floor(Number(body.amount));
      const maxClaims = Math.floor(Number(body.maxClaims)) || 1;
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e15) return send(res, 400, { ok: false, error: 'bad_amount' });
      if (maxClaims < 1 || maxClaims > 100000) return send(res, 400, { ok: false, error: 'bad_claims' });
      const code = makeCode();
      db.coupons[code] = { amount, maxClaims, claims: 0, claimedBy: [], createdAt: Date.now(), createdBy: 'bot', note: '' };
      save();
      return send(res, 200, { ok: true, code });
    }

    if (p === '/coupon/redeem') {
      const code = String(body.code || '').toUpperCase().trim();
      const user = String(body.user || '').trim();
      if (!code || !user) return send(res, 400, { ok: false, error: 'bad_request' });
      if (hit('redeem', user, 10, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const c = db.coupons[code];
      if (!c) return send(res, 200, { ok: false, error: 'invalid' });
      if (c.claims >= c.maxClaims) return send(res, 200, { ok: false, error: 'fully_claimed', maxClaims: c.maxClaims });
      if (c.claimedBy.includes(user)) return send(res, 200, { ok: false, error: 'already_claimed' });
      c.claims += 1;
      c.claimedBy.push(user);
      save();
      return send(res, 200, { ok: true, amount: c.amount, remaining: c.maxClaims - c.claims });
    }

    if (p === '/api/sync') {
      const list = Array.isArray(body.users) ? body.users.slice(0, 5000) : [];
      const users = {};
      for (const u of list) {
        const id = String(u?.id || '').slice(0, 100);
        if (!id) continue;
        users[id] = {
          name: String(u.name || 'Unknown user').slice(0, 60),
          balance: num0(u.balance), bank: num0(u.bank), gams: num0(u.gams),
          level: Math.max(1, num0(u.level)), job: String(u.job || 'Unemployed').slice(0, 40)
        };
      }
      db.users = users;
      db.usersUpdatedAt = Date.now();
      save();
      return send(res, 200, { ok: true, count: Object.keys(users).length });
    }

    if (p === '/api/market/sync') {
      const str = (v, n) => String(v ?? '').slice(0, n);
      const int = (v) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= 0 ? Math.min(v, 1e15) : 0; };
      db.market = {
        shop: (Array.isArray(body.shop) ? body.shop : []).slice(0, 400).map(x => ({ key: str(x.key, 40), name: str(x.name, 60), price: int(x.price), out: !!x.out, custom: !!x.custom })),
        coins: (Array.isArray(body.coins) ? body.coins : []).slice(0, 100).map(x => ({ key: str(x.key, 40), name: str(x.name, 60), price: int(x.price), custom: !!x.custom })),
        listings: (Array.isArray(body.listings) ? body.listings : []).slice(0, 1500).map(x => ({
          id: str(x.id, 20), item: str(x.item, 40), name: str(x.name, 60), qty: int(x.qty), price: int(x.price),
          seller: str(x.seller, 40), kind: ['admin', 'bot', 'player'].includes(x.kind) ? x.kind : 'player',
          seller_id: str(x.seller_id, 100), closedUntil: int(x.closedUntil), expiresAt: int(x.expiresAt)
        })),
        updatedAt: Date.now()
      };
      if (Array.isArray(body.accounts)) {
        const acc = {};
        for (const a of body.accounts.slice(0, 20000)) {
          const key = last10(a?.number);
          if (key.length < 7 || !/^s1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(String(a.hash || ''))) continue;
          acc[key] = { number: key, jid: str(a.jid, 100), hash: a.hash, name: str(a.name || 'Player', 60) };
        }
        for (const a of body.accounts.slice(0, 20000)) {
          const key = last10(a?.number);
          if (acc[key]) acc[key].banned = !!a.banned;
        }
        // admin changes the bot has not applied yet still win for now
        for (const a of db.jobs.filter(x => OPEN(x) && String(x.type).startsWith('acct_')).reverse()) {
          const k = Object.keys(acc).find(n => acc[n].jid === a.user);
          if (!k) continue;
          if (a.type === 'acct_pass') acc[k].hash = a.hash;
          else if (a.type === 'acct_ban') acc[k].banned = !!a.banned;
          else if (a.type === 'acct_del') delete acc[k];
        }
        db.accounts = acc;
        const now2 = Date.now();
        for (const [c, sgn] of Object.entries(db.signups)) if (acc[sgn.number] || now2 - sgn.createdAt > SIGNUP_TTL) delete db.signups[c];
      }
      if (body.balances && typeof body.balances === 'object') {
        const bal = {};
        for (const [jid, b] of Object.entries(body.balances).slice(0, 20000))
          bal[jid.slice(0, 100)] = { balance: int(b?.balance), bank: int(b?.bank), level: Math.max(1, int(b?.level)), name: str(b?.name || 'Player', 60) };
        db.balances = bal;
      }
      save();
      return send(res, 200, { ok: true, listings: db.market.listings.length, accounts: Object.keys(db.accounts).length });
    }

    if (p === '/api/verify') {
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const sg = db.signups[code];
      if (!sg) return send(res, 200, { ok: false, error: 'invalid_code' });
      if (Date.now() - sg.createdAt > SIGNUP_TTL) { delete db.signups[code]; save(); return send(res, 200, { ok: false, error: 'code_expired' }); }
      const who = last10(body.number);
      // the bot must tell us which WhatsApp number sent the code, and it must be the number that signed up
      if (!who || who !== sg.number) return send(res, 200, { ok: false, error: 'number_mismatch' });
      return send(res, 200, { ok: true, number: sg.number, hash: sg.hash });
    }

    if (p === '/api/pending') {
      const now = Date.now();
      const jobs = [];
      for (const a of db.adjustments) {
        if (jobs.length >= 50) break;
        if (a.transferId && a.leg === 'debit' && a.status === 'pending' && now - a.createdAt > 600000) {
          a.status = 'cancelled';   // bot was offline for 10 minutes: drop the transfer, nobody was charged
          const t = db.transfers.find(x => x.id === a.transferId);
          if (t && t.status === 'debiting') { t.status = 'failed'; t.error = 'bot_offline'; t.doneAt = now; }
          continue;
        }
        const redeliver = a.status === 'sent' && now - (a.sentAt || 0) > 180000;
        if (a.status === 'pending' || redeliver) {
          a.status = 'sent'; a.sentAt = now;
          jobs.push({ id: a.id, user: a.user, field: a.field, op: a.op, amount: a.amount });
        }
      }
      for (const a of db.jobs) {
        if (jobs.length >= 50) break;
        if (a.status === 'pending' && now - a.createdAt > JOB_TTL * 2) { a.status = 'expired'; a.error = 'bot_offline'; a.doneAt = now; continue; }
        const redeliver = a.status === 'sent' && now - (a.sentAt || 0) > JOB_TTL;
        if (a.status === 'pending' || redeliver) {
          a.status = 'sent'; a.sentAt = now;
          const { id, type, kind, ref, qty, item, price, sellerName, minutes, hash, banned, key, name } = a;
          jobs.push({ id, type, user: a.user, kind, ref, qty, item, price, sellerName, minutes, hash, banned, key, name });
        }
      }
      if (jobs.length) save();
      return send(res, 200, { ok: true, jobs });
    }

    if (p === '/api/ack') {
      const results = Array.isArray(body.results) ? body.results.slice(0, 100) : [];
      for (const r of results) {
        const id = String(r?.id);
        const a = db.adjustments.find(x => x.id === id) || db.jobs.find(x => x.id === id);
        if (!a || a.status === 'done' || a.status === 'cancelled') continue;
        a.status = r.ok ? 'done' : 'failed';
        a.doneAt = Date.now();
        if (!r.ok) a.error = String(r.error || 'failed').slice(0, 80);
        if (r.msg) a.msg = String(r.msg).slice(0, 200);
        if (Number.isFinite(Number(r.need))) a.need = Math.floor(Number(r.need));
        if (Number.isFinite(Number(r.left))) a.left = Math.floor(Number(r.left));
        if (Number.isFinite(Number(r.balance))) {
          a.balanceAfter = Math.floor(Number(r.balance));
          if (a.user && db.balances[a.user]) db.balances[a.user].balance = a.balanceAfter;
        }
        if (a.transferId) transferLeg(a, !!r.ok, r);
      }
      save();
      return send(res, 200, { ok: true });
    }
  }

  // ─────────── public data ───────────
  if (req.method === 'GET' && p === '/api/public/top') {
    if (hit('pub', ip, 120, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    if (!PUBLIC_BOARD) return send(res, 200, { ok: true, hidden: true, top: [] });
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
    const top = Object.values(db.users)
      .map(u => ({ name: u.name, level: u.level, job: u.job, total: total(u) }))
      .filter(u => u.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, limit)
      .map((u, i) => Object.assign({ rank: i + 1 }, u));
    return send(res, 200, { ok: true, top, updatedAt: db.usersUpdatedAt });
  }

  if (req.method === 'GET' && p === '/api/public/stats') {
    if (hit('pub', ip, 120, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    const us = Object.values(db.users);
    return send(res, 200, {
      ok: true, siteName: SITE_NAME, players: us.length,
      totalMoney: us.reduce((s, u) => s + total(u), 0), updatedAt: db.usersUpdatedAt
    });
  }

  // ─────────── live chat (no login needed) ───────────
  // A visitor gets a random secret cookie ("cid"); their chat is stored under a hash of it.
  if (p === '/chat/api/messages' && req.method === 'GET') {
    if (hit('chatpoll', ip, 150, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    const key = chatKey(req);
    const c = key && db.chats[key];
    if (!c) return send(res, 200, { ok: true, messages: [], unread: 0 });
    const unread = c.unreadUser || 0;
    if (url.searchParams.get('open') === '1' && unread) { c.unreadUser = 0; save(); }
    return send(res, 200, { ok: true, messages: c.messages.slice(-100).map(m => ({ from: m.from, text: m.text, at: m.at })), unread, name: c.name });
  }

  if (p === '/chat/api/send' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
    if (hit('chatip', ip, 30, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    const body = await readBody(req, 4000);
    const text = String(body.text || '').replace(/\r/g, '').trim().slice(0, 500);
    if (!text) return send(res, 400, { ok: false, error: 'empty' });
    let token = parseCookies(req).cid, extra = {};
    if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      token = crypto.randomBytes(24).toString('base64url');
      extra = { 'Set-Cookie': cookieHeader(req, token, 30 * 86400, 'cid') };
    }
    const key = keyOf(token);
    if (hit('chatc', key, 12, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    let c = db.chats[key];
    if (!c) {
      if (Object.keys(db.chats).length >= 3000) return send(res, 503, { ok: false, error: 'busy' });
      c = db.chats[key] = { id: key, name: 'Visitor', number: '', createdAt: Date.now(), updatedAt: Date.now(), unreadAdmin: 0, unreadUser: 0, messages: [] };
    }
    // logged-in players are identified by the server (never trust the browser for this)
    const us = getSession(req, 'usid', usessions);
    const acc = us ? db.accounts[us.user] : null;
    if (acc) { c.name = String((db.balances[acc.jid] && db.balances[acc.jid].name) || acc.name || 'Player').slice(0, 30); c.number = acc.number; }
    else {
      const nm = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (nm) c.name = nm;
    }
    c.messages.push({ from: 'user', text, at: Date.now() });
    if (c.messages.length > 300) c.messages.splice(0, c.messages.length - 300);
    c.unreadAdmin = (c.unreadAdmin || 0) + 1;
    c.updatedAt = Date.now();
    save();
    return send(res, 200, { ok: true }, extra);
  }

  // ─────────── players: login + shop ───────────
  if (p === '/shop/login' && req.method === 'POST') {
    const MAXTRY = parseInt(process.env.LOGIN_ATTEMPTS, 10) || 8;
    if (peek('ulogin', ip, 12, 15 * 60000)) return send(res, 429, { ok: false, error: 'too_many_attempts' });
    const body = await readBody(req);
    const key = last10(body.number);
    if (key.length >= 7 && peek('unum', key, MAXTRY, 15 * 60000)) return send(res, 429, { ok: false, error: 'too_many_attempts' });
    const acc = key.length >= 7 ? db.accounts[key] : null;
    const good = checkPass(acc && acc.hash, body.password) && !!acc;   // always runs scrypt
    if (!good) {
      // only WRONG attempts count toward the lockout (good logins used to eat the allowance)
      hit('ulogin', ip, 12, 15 * 60000);
      if (key.length >= 7) hit('unum', key, MAXTRY, 15 * 60000);
      // right password but not verified in WhatsApp yet? say so (only with the correct password)
      const pend = Object.values(db.signups).find(x => x.number === key && Date.now() - x.createdAt < SIGNUP_TTL);
      if (!acc && pend && checkPass(pend.hash, body.password)) return send(res, 403, { ok: false, error: 'not_verified' });
      await new Promise(r => setTimeout(r, 400));
      return send(res, 401, { ok: false, error: 'wrong_login' });
    }
    if (acc.banned) return send(res, 403, { ok: false, error: 'banned' });
    db.logins[key] = Date.now();
    const sid = crypto.randomBytes(24).toString('base64url');
    usessions.set(sid, { user: key, exp: Date.now() + 12 * 3600000 });
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, sid + '.' + sign(sid), 12 * 3600, 'usid') });
  }

  if (p === '/shop/signup' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
    if (hit('usignup', ip, 6, 3600000)) return send(res, 429, { ok: false, error: 'too_many_attempts' });
    const body = await readBody(req);
    const key = last10(body.number);
    const pw = String(body.password || '');
    if (key.length < 10) return send(res, 400, { ok: false, error: 'bad_number' });
    if (pw.length < 6 || pw.length > 40 || /\s/.test(pw)) return send(res, 400, { ok: false, error: 'bad_password' });
    if (hit('usignumber', key, 4, 3600000)) return send(res, 429, { ok: false, error: 'too_many_attempts' });
    if (db.accounts[key]) return send(res, 409, { ok: false, error: 'exists' });
    if (Object.keys(db.signups).length > 5000) return send(res, 503, { ok: false, error: 'busy' });
    for (const [c, sg] of Object.entries(db.signups)) if (sg.number === key) delete db.signups[c];   // newest request wins
    const code = newVerifyCode();
    db.signups[code] = { number: key, hash: await hashPassAsync(pw), createdAt: Date.now() };
    save();
    return send(res, 200, { ok: true, code: code.slice(0, 4) + '-' + code.slice(4), minutes: SIGNUP_TTL / 60000 });
  }

  if (p.startsWith('/shop/api/') || p === '/shop/logout') {
    if (hit('pub', ip, 240, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    const us = getSession(req, 'usid', usessions);
    let acc = us ? db.accounts[us.user] : null;
    if (acc && acc.banned) acc = null;
    if (us && (!acc)) { usessions.delete(us.sid); }
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'XMLHttpRequest')
      return send(res, 403, { ok: false, error: 'bad_request' });

    if (p === '/shop/logout' && req.method === 'POST') {
      if (us) usessions.delete(us.sid);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0, 'usid') });
    }

    if (p === '/shop/api/state') {
      const now = Date.now();
      const pl = acc ? findPlayer(acc.number, acc.jid) : null;
      const bal = pl ? pl.w : null;
      const m = db.market;
      return send(res, 200, {
        ok: true, siteName: SITE_NAME, updatedAt: m.updatedAt, shop: m.shop, coins: m.coins,
        listings: m.listings.map(l => ({
          id: l.id, item: l.item, name: l.name, qty: l.qty, price: l.price, seller: l.seller, kind: l.kind,
          closedUntil: l.closedUntil > now ? l.closedUntil : 0, expiresAt: l.expiresAt,
          mine: !!(acc && l.seller_id && l.seller_id === acc.jid)
        })),
        me: acc ? { name: (bal && bal.name) || acc.name, number: acc.number, balance: bal ? bal.balance : 0, bank: bal ? bal.bank : 0, level: bal ? bal.level : 1 } : null
      });
    }

    if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });

    // ── deposit (wallet → bank) and withdraw (bank → wallet) ──
    if (p === '/shop/api/bank' && req.method === 'POST') {
      if (hit('bank', acc.number, 10, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const b = await readBody(req);
      const op = String(b.op || '');
      if (op !== 'deposit' && op !== 'withdraw') return send(res, 400, { ok: false, error: 'bad_op' });
      const me = findPlayer(acc.number, acc.jid);
      if (!me) return send(res, 404, { ok: false, error: 'player_not_found' });
      const fF = op === 'deposit' ? 'balance' : 'bank', tF = op === 'deposit' ? 'bank' : 'balance';
      if (db.transfers.some(t => t.from === me.jid && t.to === me.jid && t.status === 'debiting')) return send(res, 429, { ok: false, error: 'too_many_pending' });
      const committed = db.transfers.filter(t => t.from === me.jid && t.status === 'debiting' && (t.fromField || 'balance') === fF).reduce((s, t) => s + t.amount, 0);
      const have = Math.max(0, (me.w[fF] || 0) - committed);
      const all = String(b.amount).toLowerCase() === 'all';
      const amount = all ? have : Number(String(b.amount ?? '').replace(/[,$\s]/g, ''));
      if (!Number.isInteger(amount) || amount < 1 || amount > 1e12) return send(res, 400, { ok: false, error: all ? 'nothing_to_move' : 'bad_amount' });
      if (amount > have) return send(res, 400, { ok: false, error: 'insufficient', need: amount, have });
      const t = {
        id: crypto.randomBytes(6).toString('hex'), owner: acc.number, toKey: acc.number, kind: op,
        from: me.jid, fromName: me.w.name || acc.name, to: me.jid, toName: me.w.name || acc.name,
        fromField: fF, toField: tF, amount, status: 'debiting', createdAt: Date.now()
      };
      db.transfers.unshift(t);
      if (db.transfers.length > 2000) db.transfers.length = 2000;
      queueAdj(me.jid, t.fromName, 'remove', amount, t, 'debit', fF);
      addAudit('site:' + acc.number, op, `${amount} ${t.fromName}`);
      save();
      return send(res, 200, { ok: true, id: t.id });
    }

    // ── wallet: look up who you are about to pay, send money, see transfers ──
    if (p === '/shop/api/lookup' && req.method === 'GET') {
      if (hit('lookup', acc.number, 30, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const key = last10(url.searchParams.get('number'));
      if (key.length < 10) return send(res, 400, { ok: false, error: 'bad_number' });
      if (key === acc.number) return send(res, 400, { ok: false, error: 'self' });
      const to = findPlayer(key, (db.accounts[key] || {}).jid);
      if (!to) return send(res, 404, { ok: false, error: 'recipient_not_found' });
      return send(res, 200, { ok: true, name: to.w.name || 'Player' });
    }

    if (p === '/shop/api/send' && req.method === 'POST') {
      if (hit('send', acc.number, 10, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const b = await readBody(req);
      const key = last10(b.number);
      const amount = Number(String(b.amount ?? '').replace(/[,$\s]/g, ''));
      if (key.length < 10) return send(res, 400, { ok: false, error: 'bad_number' });
      if (!Number.isInteger(amount) || amount < 1 || amount > 1e12) return send(res, 400, { ok: false, error: 'bad_amount' });
      if (key === acc.number) return send(res, 400, { ok: false, error: 'self' });
      const from = findPlayer(acc.number, acc.jid);
      if (!from) return send(res, 404, { ok: false, error: 'player_not_found' });
      const to = findPlayer(key, (db.accounts[key] || {}).jid);
      if (!to) return send(res, 404, { ok: false, error: 'recipient_not_found' });
      if (to.jid === from.jid) return send(res, 400, { ok: false, error: 'self' });
      const open = db.transfers.filter(t => t.from === from.jid && t.status === 'debiting' && (t.fromField || 'balance') === 'balance');
      if (open.length >= 3) return send(res, 429, { ok: false, error: 'too_many_pending' });
      const have = Math.max(0, (from.w.balance || 0) - open.reduce((s, t) => s + t.amount, 0));
      if (amount > have) return send(res, 400, { ok: false, error: 'insufficient', need: amount, have });
      const t = {
        id: crypto.randomBytes(6).toString('hex'), owner: acc.number, toKey: key,
        from: from.jid, fromName: from.w.name || acc.name, to: to.jid, toName: to.w.name || 'Player',
        amount, status: 'debiting', createdAt: Date.now()
      };
      db.transfers.unshift(t);
      if (db.transfers.length > 2000) db.transfers.length = 2000;
      queueAdj(from.jid, t.fromName, 'remove', amount, t, 'debit');
      addAudit('site:' + acc.number, 'transfer', `${amount} ${t.fromName} → ${t.toName}`);
      save();
      return send(res, 200, { ok: true, id: t.id });
    }

    if (p === '/shop/api/send' && req.method === 'GET') {
      const t = db.transfers.find(x => x.id === String(url.searchParams.get('id')) && x.owner === acc.number);
      if (!t) return send(res, 404, { ok: false, error: 'not_found' });
      const st = t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : 'pending';
      return send(res, 200, { ok: true, status: st, error: t.error || '', name: t.toName, amount: t.amount, kind: t.kind || 'send' });
    }

    if (p === '/shop/api/transfers') {
      const items = db.transfers.filter(t => t.owner === acc.number || t.toKey === acc.number).slice(0, 15).map(t => ({
        id: t.id, kind: t.kind || 'send', dir: t.owner === acc.number ? 'out' : 'in', name: t.owner === acc.number ? t.toName : t.fromName,
        amount: t.amount, at: t.createdAt,
        status: t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : 'pending', error: t.error || ''
      }));
      return send(res, 200, { ok: true, items });
    }

    if (p === '/shop/api/order' && req.method === 'POST') {
      if (hit('order', acc.number, 20, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const b = await readBody(req);
      const kind = String(b.kind || '');
      const qty = Math.floor(Number(b.qty));
      if (!Number.isFinite(qty) || qty < 1 || qty > 1e6) return send(res, 400, { ok: false, error: 'bad_qty' });
      if (db.jobs.filter(a => a.type === 'buy' && a.user === acc.jid && OPEN(a)).length >= 5)
        return send(res, 429, { ok: false, error: 'too_many_pending' });
      let ref;
      if (kind === 'market') {
        const l = db.market.listings.find(x => x.id === String(b.ref));
        if (!l) return send(res, 404, { ok: false, error: 'no_listing' });
        if (l.seller_id && l.seller_id === acc.jid) return send(res, 400, { ok: false, error: 'own_listing' });
        if (l.closedUntil > Date.now()) return send(res, 400, { ok: false, error: 'closed' });
        if (qty > l.qty) return send(res, 400, { ok: false, error: 'not_enough_stock', left: l.qty });
        ref = l.id;
      } else if (kind === 'shop') {
        const it = db.market.shop.find(x => x.key === String(b.ref));
        if (!it) return send(res, 404, { ok: false, error: 'bad_item' });
        if (it.out) return send(res, 400, { ok: false, error: 'out_of_stock' });
        ref = it.key;
      } else return send(res, 400, { ok: false, error: 'bad_kind' });
      const j = newJob({ type: 'buy', kind, ref, qty, user: acc.jid, userName: acc.name });
      save();
      return send(res, 200, { ok: true, id: j.id });
    }

    if (p === '/shop/api/order' && req.method === 'GET') {
      const j = db.jobs.find(x => x.id === String(url.searchParams.get('id')) && x.user === acc.jid);
      if (!j) return send(res, 404, { ok: false, error: 'not_found' });
      return send(res, 200, { ok: true, status: j.status, error: j.error || '', msg: j.msg || '', need: j.need, left: j.left, balance: j.balanceAfter });
    }

    if (p === '/shop/api/orders') {
      const items = db.jobs.filter(x => x.type === 'buy' && x.user === acc.jid).slice(0, 15)
        .map(j => ({ id: j.id, kind: j.kind, ref: j.ref, qty: j.qty, status: j.status, error: j.error || '', msg: j.msg || '', at: j.createdAt }));
      return send(res, 200, { ok: true, items });
    }
    return send(res, 404, { ok: false, error: 'not_found' });
  }

  // ─────────── admin login ───────────
  if (p === '/admin/login' && req.method === 'POST') {
    if (hit('login', ip, 8, 15 * 60000)) return send(res, 429, { ok: false, error: 'too_many_attempts' });
    const body = await readBody(req);
    const okUser = safeEq(String(body.username || ''), ADMIN_USER);
    const okPass = safeEq(String(body.password || ''), ADMIN_PASS);
    if (!(okUser && okPass)) {
      await new Promise(r => setTimeout(r, 500));
      return send(res, 401, { ok: false, error: 'wrong_login' });
    }
    const sid = crypto.randomBytes(24).toString('base64url');
    sessions.set(sid, { user: ADMIN_USER, exp: Date.now() + SESSION_HOURS * 3600000 });
    addAudit(ADMIN_USER, 'login', ip);
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, sid + '.' + sign(sid), SESSION_HOURS * 3600) });
  }

  // ─────────── admin API (session required) ───────────
  if (p.startsWith('/admin/api/') || p === '/admin/logout') {
    const sess = getSession(req);
    if (!sess) return send(res, 401, { ok: false, error: 'not_logged_in' });
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'XMLHttpRequest')
      return send(res, 403, { ok: false, error: 'bad_request' });
    const me = sess.user;

    if (p === '/admin/logout' && req.method === 'POST') {
      sessions.delete(sess.sid);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
    }

    if (p === '/admin/api/me') return send(res, 200, { ok: true, user: me, siteName: SITE_NAME });

    if (p === '/admin/api/overview') {
      const us = Object.values(db.users);
      const cs = Object.values(db.coupons);
      return send(res, 200, {
        ok: true,
        players: us.length,
        totalMoney: us.reduce((s, u) => s + total(u), 0),
        activeCoupons: cs.filter(c => c.claims < c.maxClaims).length,
        couponValueLeft: cs.reduce((s, c) => s + c.amount * Math.max(0, c.maxClaims - c.claims), 0),
        pendingEdits: db.adjustments.filter(OPEN).length + db.jobs.filter(a => OPEN(a) && a.type !== 'buy').length,
        accounts: Object.keys(db.accounts).length,
        bannedAccounts: Object.values(db.accounts).filter(a => a.banned).length,
        ordersToday: db.jobs.filter(a => a.type === 'buy' && a.status === 'done' && a.doneAt > Date.now() - 86400000).length,
        marketUpdatedAt: db.market.updatedAt,
        usersUpdatedAt: db.usersUpdatedAt
      });
    }

    if (p === '/admin/api/users') {
      const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
      const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
      const per = 25;
      let list = Object.entries(db.users).map(([id, u]) => Object.assign({ id, total: total(u) }, u));
      if (q) list = list.filter(u => u.name.toLowerCase().includes(q));
      list.sort((a, b) => b.total - a.total);
      const pages = Math.max(1, Math.ceil(list.length / per));
      const pg = Math.min(page, pages);
      const pendingIds = new Set(db.adjustments.filter(a => a.status === 'pending' || a.status === 'sent').map(a => a.user));
      const rows = list.slice((pg - 1) * per, pg * per).map(u => Object.assign({}, u, { pending: pendingIds.has(u.id) }));
      return send(res, 200, { ok: true, users: rows, count: list.length, page: pg, pages, updatedAt: db.usersUpdatedAt });
    }

    if (p === '/admin/api/adjust' && req.method === 'POST') {
      const b = await readBody(req);
      const user = String(b.user || '');
      const field = String(b.field || 'balance');
      const op = String(b.op || '');
      const amount = parseAmount(b.amount);
      if (!db.users[user]) return send(res, 404, { ok: false, error: 'player_not_found' });
      if (!FIELDS.includes(field)) return send(res, 400, { ok: false, error: 'bad_field' });
      if (!OPS.includes(op)) return send(res, 400, { ok: false, error: 'bad_op' });
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e15 || (op !== 'set' && amount === 0))
        return send(res, 400, { ok: false, error: 'bad_amount' });
      const a = {
        id: crypto.randomBytes(6).toString('hex'), user, name: db.users[user].name,
        field, op, amount, status: 'pending', createdAt: Date.now(), by: me
      };
      db.adjustments.unshift(a);
      if (db.adjustments.length > 1000) db.adjustments.length = 1000;
      addAudit(me, 'adjust', `${op} ${amount} ${field} → ${a.name}`);
      save();
      return send(res, 200, { ok: true, id: a.id });
    }

    if (p === '/admin/api/adjust/cancel' && req.method === 'POST') {
      const b = await readBody(req);
      const a = db.adjustments.find(x => x.id === String(b.id));
      if (!a || a.status !== 'pending' || a.transferId) return send(res, 400, { ok: false, error: 'cannot_cancel' });
      a.status = 'cancelled';
      addAudit(me, 'cancel_adjust', `${a.op} ${a.amount} ${a.field} → ${a.name}`);
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/adjustments') {
      return send(res, 200, { ok: true, items: db.adjustments.slice(0, 60) });
    }

    if (p === '/admin/api/coupons' && req.method === 'GET') {
      const items = Object.entries(db.coupons)
        .map(([code, c]) => ({ code, amount: c.amount, maxClaims: c.maxClaims, claims: c.claims, createdAt: c.createdAt, createdBy: c.createdBy, note: c.note || '' }))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 300);
      return send(res, 200, { ok: true, items });
    }

    if (p === '/admin/api/coupons' && req.method === 'POST') {
      const b = await readBody(req);
      const amount = parseAmount(b.amount);
      const maxClaims = Math.floor(Number(b.maxClaims)) || 1;
      const count = Math.min(50, Math.max(1, Math.floor(Number(b.count)) || 1));
      const note = String(b.note || '').slice(0, 60);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e15) return send(res, 400, { ok: false, error: 'bad_amount' });
      if (maxClaims < 1 || maxClaims > 100000) return send(res, 400, { ok: false, error: 'bad_claims' });
      const codes = [];
      for (let i = 0; i < count; i++) {
        const code = makeCode();
        db.coupons[code] = { amount, maxClaims, claims: 0, claimedBy: [], createdAt: Date.now(), createdBy: 'admin', note };
        codes.push(code);
      }
      addAudit(me, 'coupon_create', `${count} × ${amount} (${maxClaims} person each)`);
      save();
      return send(res, 200, { ok: true, codes, amount, maxClaims });
    }

    if (p === '/admin/api/coupons/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const code = String(b.code || '').toUpperCase();
      if (!db.coupons[code]) return send(res, 404, { ok: false, error: 'not_found' });
      delete db.coupons[code];
      addAudit(me, 'coupon_delete', code);
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/market' && req.method === 'GET') {
      const open = db.jobs.filter(a => OPEN(a) && String(a.type).startsWith('m_'));
      const rows = db.market.listings.map(l => Object.assign({}, l, { pending: open.some(a => a.ref === l.id) }))
        .sort((a, b) => a.item === b.item ? a.price - b.price : a.item.localeCompare(b.item));
      return send(res, 200, { ok: true, listings: rows, shop: db.market.shop, coins: db.market.coins, updatedAt: db.market.updatedAt, waiting: open.length });
    }

    if (p === '/admin/api/market/add' && req.method === 'POST') {
      const b = await readBody(req);
      const item = String(b.item || '').toLowerCase();
      const known = db.market.shop.some(x => x.key === item) || db.market.coins.some(x => x.key === item);
      if (!db.market.updatedAt) return send(res, 400, { ok: false, error: 'bot_not_synced' });
      if (!known) return send(res, 400, { ok: false, error: 'bad_item' });
      const qty = parseAmount(b.qty), price = parseAmount(b.price);
      if (!Number.isFinite(qty) || qty < 1 || qty > 1e9) return send(res, 400, { ok: false, error: 'bad_qty' });
      if (!Number.isFinite(price) || price < 1 || price > 1e15) return send(res, 400, { ok: false, error: 'bad_price' });
      const sellerName = String(b.sellerName || 'Official Store').trim().slice(0, 30) || 'Official Store';
      newJob({ type: 'm_add', item, qty, price, sellerName, by: me });
      addAudit(me, 'market_add', `${qty} × ${item} @ ${price} (${sellerName})`);
      save();
      return send(res, 200, { ok: true });
    }

    // ── create / re-price / remove goods & coins (the bot applies them) ──
    if (p === '/admin/api/item/add' && req.method === 'POST') {
      const b = await readBody(req);
      const kind = b.kind === 'coin' ? 'coin' : 'good';
      const key = String(b.key || '').trim().toLowerCase();
      const name = String(b.name || '').trim().slice(0, 40);
      const price = parseAmount(b.price);
      if (!/^[a-z0-9_]{2,24}$/.test(key)) return send(res, 400, { ok: false, error: 'bad_id' });
      if (!name) return send(res, 400, { ok: false, error: 'bad_name' });
      if (!Number.isFinite(price) || price < 1 || price > 1e15) return send(res, 400, { ok: false, error: 'bad_price' });
      const inShop = db.market.shop.find(x => x.key === key), inCoins = db.market.coins.find(x => x.key === key);
      if (kind === 'good' ? !!inCoins : !!inShop) return send(res, 400, { ok: false, error: 'id_taken' });
      const ex = kind === 'good' ? inShop : inCoins;
      if (ex && !ex.custom) return send(res, 400, { ok: false, error: 'id_builtin' });
      newJob({ type: 'item_add', kind, key, name, price, by: me });
      addAudit(me, 'item_add', `${kind} ${key} "${name}" @ ${price}`);
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/item/price' && req.method === 'POST') {
      const b = await readBody(req);
      const key = String(b.key || '').toLowerCase();
      const price = parseAmount(b.price);
      if (!db.market.shop.some(x => x.key === key) && !db.market.coins.some(x => x.key === key)) return send(res, 404, { ok: false, error: 'bad_item' });
      if (!Number.isFinite(price) || price < 1 || price > 1e15) return send(res, 400, { ok: false, error: 'bad_price' });
      newJob({ type: 'item_price', key, price, by: me });
      addAudit(me, 'item_price', `${key} → ${price}`);
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/item/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const key = String(b.key || '').toLowerCase();
      const it = db.market.shop.find(x => x.key === key) || db.market.coins.find(x => x.key === key);
      if (!it) return send(res, 404, { ok: false, error: 'bad_item' });
      if (!it.custom) return send(res, 400, { ok: false, error: 'not_custom' });
      newJob({ type: 'item_del', key, by: me });
      addAudit(me, 'item_delete', key);
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/market/op' && req.method === 'POST') {
      const b = await readBody(req);
      const op = String(b.op || '');
      const ref = String(b.ref || '');
      const l = db.market.listings.find(x => x.id === ref);
      if (!l) return send(res, 404, { ok: false, error: 'listing_not_found' });
      const job = { type: 'm_' + op, ref, by: me };
      if (op === 'remove' || op === 'open') {}
      else if (op === 'close') { const m = Math.floor(Number(b.minutes)); job.minutes = Number.isFinite(m) && m > 0 ? Math.min(m, 525600) : 0; }
      else if (op === 'topup') { const q = parseAmount(b.qty); if (!Number.isFinite(q) || q < 1 || q > 1e9) return send(res, 400, { ok: false, error: 'bad_qty' }); job.qty = q; }
      else if (op === 'price') { const pr = parseAmount(b.price); if (!Number.isFinite(pr) || pr < 1 || pr > 1e15) return send(res, 400, { ok: false, error: 'bad_price' }); job.price = pr; }
      else return send(res, 400, { ok: false, error: 'bad_op' });
      newJob(job);
      addAudit(me, 'market_' + op, `#${ref} ${l.name}` + (job.qty ? ` +${job.qty}` : '') + (job.price ? ` → ${job.price}` : '') + (job.minutes ? ` ${job.minutes}min` : ''));
      save();
      return send(res, 200, { ok: true });
    }

    // ── live chat inbox ──
    if (p === '/admin/api/chats' && req.method === 'GET') {
      const items = Object.values(db.chats).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200).map(c => {
        const last = c.messages[c.messages.length - 1] || {};
        return { id: c.id, name: c.name, number: c.number || '', unread: c.unreadAdmin || 0, updatedAt: c.updatedAt, last: String(last.text || '').slice(0, 80), lastFrom: last.from || '' };
      });
      return send(res, 200, { ok: true, items, unread: items.reduce((n, c) => n + (c.unread ? 1 : 0), 0) });
    }

    if (p === '/admin/api/chats/messages' && req.method === 'GET') {
      const c = db.chats[String(url.searchParams.get('id') || '')];
      if (!c) return send(res, 404, { ok: false, error: 'chat_not_found' });
      if (c.unreadAdmin) { c.unreadAdmin = 0; save(); }
      return send(res, 200, { ok: true, id: c.id, name: c.name, number: c.number || '', messages: c.messages.slice(-200) });
    }

    if (p === '/admin/api/chats/reply' && req.method === 'POST') {
      const b = await readBody(req, 4000);
      const c = db.chats[String(b.id || '')];
      if (!c) return send(res, 404, { ok: false, error: 'chat_not_found' });
      const text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 1000);
      if (!text) return send(res, 400, { ok: false, error: 'empty' });
      c.messages.push({ from: 'admin', text, at: Date.now() });
      if (c.messages.length > 300) c.messages.splice(0, c.messages.length - 300);
      c.unreadUser = (c.unreadUser || 0) + 1;
      c.unreadAdmin = 0;
      c.updatedAt = Date.now();
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/chats/delete' && req.method === 'POST') {
      const b = await readBody(req);
      if (!db.chats[String(b.id || '')]) return send(res, 404, { ok: false, error: 'chat_not_found' });
      delete db.chats[String(b.id)];
      addAudit(me, 'chat_delete', String(b.id));
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/accounts' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
      const open = db.jobs.filter(a => OPEN(a) && String(a.type).startsWith('acct_'));
      let list = Object.values(db.accounts).map(a => {
        const b = db.balances[a.jid] || {};
        return { number: a.number, name: (b.name || a.name || 'Player'), banned: !!a.banned, balance: b.balance || 0, bank: b.bank || 0,
                 lastLogin: db.logins[a.number] || 0, pending: open.some(x => x.user === a.jid) };
      });
      if (q) list = list.filter(a => a.number.includes(q.replace(/\D/g, '') || '\u0000') || a.name.toLowerCase().includes(q));
      list.sort((a, b) => a.name.localeCompare(b.name));
      const waiting = Object.values(db.signups).filter(x => Date.now() - x.createdAt < SIGNUP_TTL).length;
      return send(res, 200, { ok: true, items: list.slice(0, 500), total: Object.keys(db.accounts).length, banned: list.filter(a => a.banned).length, waiting });
    }

    if (p.startsWith('/admin/api/accounts/') && req.method === 'POST') {
      const b = await readBody(req);
      const key = last10(b.number);
      const acc = db.accounts[key];
      if (!acc) return send(res, 404, { ok: false, error: 'account_not_found' });
      if (p === '/admin/api/accounts/password') {
        const pw = String(b.password || '');
        if (pw.length < 6 || pw.length > 40 || /\s/.test(pw)) return send(res, 400, { ok: false, error: 'bad_password' });
        const hash = await hashPassAsync(pw);
        acc.hash = hash; killSessions(key);
        newJob({ type: 'acct_pass', user: acc.jid, number: key, hash, by: me });
        addAudit(me, 'account_password', `${acc.name} (${key})`);
      } else if (p === '/admin/api/accounts/ban') {
        const banned = !!b.banned;
        acc.banned = banned; if (banned) killSessions(key);
        newJob({ type: 'acct_ban', user: acc.jid, number: key, banned, by: me });
        addAudit(me, banned ? 'account_ban' : 'account_unban', `${acc.name} (${key})`);
      } else if (p === '/admin/api/accounts/delete') {
        killSessions(key); delete db.accounts[key];
        newJob({ type: 'acct_del', user: acc.jid, number: key, by: me });
        addAudit(me, 'account_delete', `${acc.name} (${key})`);
      } else return send(res, 404, { ok: false, error: 'not_found' });
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/admin/api/jobs') {
      return send(res, 200, { ok: true, items: db.jobs.slice(0, 80).map(a => ({
        id: a.id, type: a.type, status: a.status, createdAt: a.createdAt, doneAt: a.doneAt || 0,
        who: a.userName || a.by || '', ref: a.ref, item: a.item || a.key, qty: a.qty, price: a.price,
        error: a.error || '', msg: a.msg || ''
      })) });
    }

    if (p === '/admin/api/audit') return send(res, 200, { ok: true, items: db.audit.slice(0, 100) });

    return send(res, 404, { ok: false, error: 'not_found' });
  }

  // ─────────── pages ───────────
  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return sendFile(res, 'index.html');
    if (p === '/admin' || p === '/admin/') return sendFile(res, 'admin.html');
    if (p === '/shop' || p === '/shop/') return sendFile(res, 'shop.html');
    if (p === '/login' || p === '/login/' || p === '/signup' || p === '/signup/') return sendFile(res, 'login.html');
    if (/^\/[A-Za-z0-9_.-]+$/.test(p) && ['.css', '.js', '.svg', '.png', '.ico'].includes(path.extname(p)))
      return sendFile(res, p.slice(1));
  }
  return send(res, 404, { ok: false, error: 'not_found' });
}

http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    if (res.headersSent) return res.end();
    if (e.status) return send(res, e.status, { ok: false, error: e.message });
    console.error(e);
    send(res, 500, { ok: false, error: 'server_error' });
  }
}).listen(PORT, () => console.log(`🎟️  ${SITE_NAME} running on port ${PORT}  →  admin at /admin`));
