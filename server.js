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
let db = { coupons: {}, users: {}, usersUpdatedAt: 0, adjustments: [], audit: [] };
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = Object.assign(db, loaded);
} catch {}
for (const k of ['coupons', 'users']) if (!db[k] || typeof db[k] !== 'object') db[k] = {};
for (const k of ['adjustments', 'audit']) if (!Array.isArray(db[k])) db[k] = [];

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
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.some(t => now - t < 3600000)) buckets.delete(k);
  for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k);
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
function getSession(req) {
  const raw = parseCookies(req).sid;
  if (!raw) return null;
  const [sid, mac] = raw.split('.');
  if (!sid || !mac || !safeEq(sign(sid), mac)) return null;
  const s = sessions.get(sid);
  if (!s || s.exp < Date.now()) { sessions.delete(sid); return null; }
  return { sid, user: s.user };
}
function cookieHeader(req, value, maxAge) {
  const secure = FORCE_SECURE_COOKIE || String(req.headers['x-forwarded-proto'] || '') === 'https';
  return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
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
  const BOT = ['/coupon/create', '/coupon/redeem', '/api/sync', '/api/pending', '/api/ack'];
  if (BOT.includes(p)) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
    if (hit('botfail', ip, 20, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    if (!safeEq(req.headers['x-api-key'] || '', API_KEY)) {
      hit('botfail', ip, 20, 60000);
      return send(res, 401, { ok: false, error: 'unauthorized' });
    }
    const body = await readBody(req, p === '/api/sync' ? 6 * 1024 * 1024 : 20000);

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

    if (p === '/api/pending') {
      const now = Date.now();
      const jobs = [];
      for (const a of db.adjustments) {
        if (jobs.length >= 50) break;
        const redeliver = a.status === 'sent' && now - (a.sentAt || 0) > 180000;
        if (a.status === 'pending' || redeliver) {
          a.status = 'sent'; a.sentAt = now;
          jobs.push({ id: a.id, user: a.user, field: a.field, op: a.op, amount: a.amount });
        }
      }
      if (jobs.length) save();
      return send(res, 200, { ok: true, jobs });
    }

    if (p === '/api/ack') {
      const results = Array.isArray(body.results) ? body.results.slice(0, 100) : [];
      for (const r of results) {
        const a = db.adjustments.find(x => x.id === String(r?.id));
        if (!a || a.status === 'done' || a.status === 'cancelled') continue;
        a.status = r.ok ? 'done' : 'failed';
        a.doneAt = Date.now();
        if (!r.ok) a.error = String(r.error || 'failed').slice(0, 80);
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
        pendingEdits: db.adjustments.filter(a => a.status === 'pending' || a.status === 'sent').length,
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
      if (!a || a.status !== 'pending') return send(res, 400, { ok: false, error: 'cannot_cancel' });
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

    if (p === '/admin/api/audit') return send(res, 200, { ok: true, items: db.audit.slice(0, 100) });

    return send(res, 404, { ok: false, error: 'not_found' });
  }

  // ─────────── pages ───────────
  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return sendFile(res, 'index.html');
    if (p === '/admin' || p === '/admin/') return sendFile(res, 'admin.html');
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
