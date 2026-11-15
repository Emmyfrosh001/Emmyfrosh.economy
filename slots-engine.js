'use strict';
// ================================================================
// Slot machine engine (zero dependencies) – 3 reels x 3 rows, 5 pay lines, wild.
//   • The SERVER spins the reels (crypto random). The browser only draws the result.
//   • One spin is settled instantly, so there is nothing to "hold": the stake leaves the wallet
//     and the win is added in the same moment. Money goes to the bot exactly like the crash
//     plane does it (small ledger -> ONE net add/remove at a time -> the bot applies it).
//   • Difficulty = the share of all stakes the house keeps in the long run (the real,
//     exact return is worked out from the reels below – nothing is guessed).
//   • Admin settings (on/off, difficulty, min/max stake) live in data/slots.json.
// ================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIFFICULTY = {
  easy:   { label: 'Easy',   rtp: 0.97 },
  normal: { label: 'Normal', rtp: 0.94 },
  hard:   { label: 'Hard',   rtp: 0.88 }
};
const DEFAULTS = { enabled: true, difficulty: 'normal', minBet: 1, maxBet: 0 };     // maxBet 0 = no limit
const MAX_STAKE = 1e12;

// symbols, rarest last. 'wild' replaces every symbol except itself.
const SYMS = ['cherry', 'lemon', 'grape', 'bell', 'star', 'gem', 'seven', 'wild'];
// how many of each symbol sit on each reel's 32-stop strip (3 reels)
const STRIP = [
  [7, 7, 6, 5, 3, 2, 1, 1],
  [7, 7, 6, 5, 3, 2, 1, 1],
  [7, 7, 6, 5, 3, 2, 1, 1]
];
const REELS = STRIP.length;
// pay for 3 matching symbols on a line, as a multiple of the line bet (the stake is split over 5 lines; scaled a little by difficulty)
const BASE_PAY = { cherry: 8, lemon: 11, grape: 17, bell: 28, star: 56, gem: 112, seven: 280, wild: 560 };
const LINES = [[1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0]];     // row used on each reel
const round2 = (x) => Math.round(x * 100) / 100;

// what a line of five symbols pays (as a multiple of the line bet), with the given pay table
function linePay(three, pay) {
  let s = null;
  for (const x of three) { if (x !== 'wild') { s = x; break; } }
  if (s === null) s = 'wild';
  for (const x of three) if (x !== s && x !== 'wild') return null;
  return { sym: s, count: 3, mult: pay[s] };
}
function payTable(rtp) {                       // scale the base table so the exact return equals the target
  const base = exactRtp(BASE_PAY), k = rtp / base, out = {};
  for (const s of SYMS) out[s] = round2(BASE_PAY[s] * k);
  return out;
}
function exactRtp(pay) {                       // every reel picks a symbol independently -> add up all 8^3 outcomes
  const P = STRIP.map(r => r.map(c => c / 32));
  let ev = 0, hit = 0;
  const walk = (i, three, p) => {
    if (i === REELS) { const w = linePay(three, pay); if (w) { ev += p * w.mult; hit += p; } return; }
    for (let k = 0; k < 8; k++) if (P[i][k] > 0) walk(i + 1, three.concat(SYMS[k]), p * P[i][k]);
  };
  walk(0, [], 1);
  exactRtp.hit = hit;
  return ev;                                   // per unit of line bet = per unit of stake (stake is split over the lines)
}
const strips = STRIP.map((cnt, r) => {          // a fixed, evenly mixed order for each reel
  const arr = []; cnt.forEach((c, k) => { for (let i = 0; i < c; i++) arr.push(SYMS[k]); });
  let seed = 12345 + r * 977; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
});

function cleanSettings(s) {
  s = s || {};
  const int = (v, def) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_STAKE) : def; };
  const minBet = Math.max(1, int(s.minBet, DEFAULTS.minBet));
  let maxBet = int(s.maxBet, DEFAULTS.maxBet);
  if (maxBet && maxBet < minBet) maxBet = minBet;
  return { enabled: s.enabled !== false, difficulty: DIFFICULTY[s.difficulty] ? s.difficulty : DEFAULTS.difficulty, minBet, maxBet };
}
function spinGrid(rand) {                       // grid[row][reel]
  const g = [[], [], []];
  for (let r = 0; r < REELS; r++) { const stop = rand(strips[r].length); for (let row = 0; row < 3; row++) g[row][r] = strips[r][(stop + row) % strips[r].length]; }
  return g;
}
function settleGrid(grid, pay, stake) {
  const wins = []; let sum = 0;
  LINES.forEach((ln, i) => {
    const row3 = ln.map((row, r) => grid[row][r]), w = linePay(row3, pay);
    if (w) { wins.push({ line: i, sym: w.sym, count: w.count, mult: w.mult }); sum += w.mult; }
  });
  const total = Math.min(MAX_STAKE * 10, Math.floor(stake * sum / LINES.length + 1e-9));
  wins.forEach(w => { w.win = Math.floor(stake * w.mult / LINES.length + 1e-9); });
  return { wins, win: total };
}

module.exports = function createSlots(opts) {
  const { dataDir, send, readBody, getAcc, getWallet, queueAdj, getAdj, save, hit } = opts;
  const FILE = path.join(dataDir, 'slots.json');
  let store = { ledger: {}, settings: {}, stats: { spins: 0, staked: 0, paid: 0, since: Date.now() } };
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
  if (!store.ledger || typeof store.ledger !== 'object') store.ledger = {};
  if (!store.stats || typeof store.stats !== 'object') store.stats = { spins: 0, staked: 0, paid: 0, since: Date.now() };
  store.settings = cleanSettings(store.settings);

  const ledger = (number, jid, name) => {
    let l = store.ledger[number];
    if (!l) l = store.ledger[number] = { jid, name, pending: 0, inflight: 0, adjId: null, retryAt: 0, fails: 0 };
    if (jid) l.jid = jid; if (name) l.name = name;
    return l;
  };
  const net = (number) => { const l = store.ledger[number]; return l ? l.pending + l.inflight : 0; };

  let dirty = false, saving = false;
  function flush() {
    if (!dirty || saving) return;
    saving = true; dirty = false;
    const tmp = FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(store), (e) => {
      if (!e) fs.rename(tmp, FILE, () => { saving = false; if (dirty) flush(); });
      else { saving = false; dirty = true; }
    });
  }
  const touch = () => { dirty = true; };
  setInterval(flush, 1500).unref();
  const flushSync = () => { try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch {} };
  process.on('SIGTERM', () => { flushSync(); process.exit(0); });
  process.on('SIGINT', () => { flushSync(); process.exit(0); });
  touch();

  function walletOf(acc) {
    const w = getWallet(acc);
    if (!w) return null;
    return { jid: w.jid, name: w.name, have: Math.max(0, Math.floor(w.balance + net(acc.number))) };
  }
  function check(l) {
    if (!l.adjId) return false;
    const a = getAdj(l.adjId), st = a && a.status;
    if (st === 'done') { l.inflight = 0; l.adjId = null; l.fails = 0; touch(); return true; }
    if (!a || st === 'failed' || st === 'cancelled') {
      l.pending += l.inflight; l.inflight = 0; l.adjId = null; l.fails++;
      l.retryAt = Date.now() + Math.min(300000, 20000 * l.fails);
      touch(); return true;
    }
    return false;
  }
  function onAck(id) { for (const l of Object.values(store.ledger)) if (l.adjId === id) check(l); }
  function settleTick() {
    const now = Date.now();
    for (const [n, l] of Object.entries(store.ledger)) {
      if (l.adjId) { check(l); continue; }
      if (!l.pending) { if (!l.inflight) { delete store.ledger[n]; touch(); } continue; }
      if (now < l.retryAt || !l.jid) continue;
      const a = queueAdj(l.jid, l.name, l.pending > 0 ? 'add' : 'remove', Math.abs(l.pending));
      l.adjId = a.id; l.inflight = l.pending; l.pending = 0; touch(); save();
    }
  }
  setInterval(settleTick, 1000).unref();

  const recent = [];                           // last big wins, shown to everybody
  function spin(acc, body) {
    const st = store.settings;
    if (!st.enabled) return { status: 400, error: 'game_off' };
    const stake = Math.floor(Number(String(body && body.amount !== undefined ? body.amount : '').replace(/[,\s]/g, '')));
    if (!Number.isFinite(stake) || stake < st.minBet) return { status: 400, error: 'bad_amount' };
    if (stake > MAX_STAKE || (st.maxBet && stake > st.maxBet)) return { status: 400, error: 'too_big' };
    const w = walletOf(acc);
    if (!w) return { status: 400, error: 'no_wallet' };
    if (w.have < 1) return { status: 400, error: 'no_money' };
    if (w.have < stake) return { status: 400, error: 'insufficient' };
    const pay = payTable(DIFFICULTY[st.difficulty].rtp);
    const grid = spinGrid((n) => crypto.randomInt(n));
    const r = settleGrid(grid, pay, stake);
    const l = ledger(acc.number, w.jid, w.name);
    l.pending += r.win - stake;
    store.stats.spins++; store.stats.staked += stake; store.stats.paid += r.win;
    if (r.win >= stake * 20) { recent.unshift({ name: (w.name || acc.name || 'Player'), stake, win: r.win, t: Date.now() }); recent.length = Math.min(recent.length, 10); }
    touch();
    return { status: 200, grid, wins: r.wins, win: r.win };
  }

  function info() {
    const st = store.settings, pay = payTable(DIFFICULTY[st.difficulty].rtp);
    return { enabled: st.enabled, minBet: st.minBet, maxBet: st.maxBet, symbols: SYMS, pay, lines: LINES, reels: REELS, rtp: round2(exactRtp(pay) * 100) };
  }
  function setSettings(patch) {
    const next = Object.assign({}, store.settings, patch || {});
    if (patch && patch.difficulty !== undefined && !DIFFICULTY[patch.difficulty]) return { error: 'bad_difficulty' };
    const clean = cleanSettings(next);
    if (clean.maxBet !== next.maxBet && Number(next.maxBet) > 0) return { error: 'bad_limits' };
    store.settings = clean; touch();
    return { settings: clean };
  }
  function adminInfo() {
    const s = store.stats;
    return { settings: store.settings, difficulties: Object.fromEntries(Object.entries(DIFFICULTY).map(([k, v]) => [k, { label: v.label, rtp: v.rtp }])), stats: { spins: s.spins, staked: s.staked, paid: s.paid, houseNet: s.staked - s.paid, since: s.since } };
  }
  function resetStats() { store.stats = { spins: 0, staked: 0, paid: 0, since: Date.now() }; touch(); }

  async function handle(req, res, p) {
    const acc = getAcc(req);
    if (p === '/slots/state' && req.method === 'GET') {
      const w = acc ? walletOf(acc) : null;
      return send(res, 200, Object.assign({ ok: true, loggedIn: !!acc, balance: w ? w.have : null, hasWallet: !!w, recent }, info()));
    }
    if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not_found' });
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
    if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });
    if (hit('slot', acc.number, 150, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    if (p !== '/slots/spin') return send(res, 404, { ok: false, error: 'not_found' });
    const r = spin(acc, await readBody(req));
    if (r.status !== 200) return send(res, r.status, { ok: false, error: r.error });
    const w = walletOf(acc);
    return send(res, 200, { ok: true, grid: r.grid, wins: r.wins, win: r.win, balance: w ? w.have : 0 });
  }

  return {
    handle, onAck, setSettings, adminInfo, resetStats,
    hold: (number) => Math.max(0, -net(number)),
    _test: { exactRtp, payTable, spinGrid, settleGrid, linePay, DIFFICULTY, BASE_PAY }
  };
};
