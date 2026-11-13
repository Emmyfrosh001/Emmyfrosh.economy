'use strict';
// ================================================================
// Virtual football (TV) engine — zero dependencies, same wallet rules as the crash plane.
//   • One shared round for everybody: BET (20s) → PLAY (45s = 90 match minutes) → FULL TIME (7s) → repeat
//   • 4 matches per round. The SERVER draws every result and every goal minute; the browser only plays it.
//     Goal minutes are not sent until betting has closed.
//   • Players stake REAL WALLET MONEY. Stakes and wins go through a small ledger that is sent to the bot
//     as ONE net "add" / "remove" per player (same trick as aviator-engine.js).
//   • Settings (on/off, house edge, min/max stake) live in data/football.json
// ================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BET_MS = 20000, PLAY_MS = 45000, END_MS = 7000, CYCLE = BET_MS + PLAY_MS + END_MS;
const MAX_STAKE = 1e12, MAX_WIN = 1e14, MAX_PICKS = 4, MAX_BETS = 5;
const DEFAULTS = { enabled: true, edge: 0.08, minBet: 1, maxBet: 0 };   // edge = share the house keeps; maxBet 0 = no limit

const TEAMS = [['Arsenal', 'ARS', '#e5322d', 1.75], ['Chelsea', 'CHE', '#2a5bd7', 1.5], ['Liverpool', 'LIV', '#c8102e', 1.8],
  ['Man City', 'MCI', '#6cabdd', 1.95], ['Barcelona', 'BAR', '#a50044', 1.8], ['Real Madrid', 'RMA', '#f2f2f2', 1.9],
  ['Inter', 'INT', '#0d6fd1', 1.6], ['Napoli', 'NAP', '#2a9be0', 1.4], ['Dortmund', 'BVB', '#fdd835', 1.45],
  ['Leipzig', 'RBL', '#dd0741', 1.35], ['PSG', 'PSG', '#ff8a1f', 1.85], ['Juventus', 'JUV', '#e8e8e8', 1.55]]
  .map(([n, c, col, s]) => ({ n, c, col, s }));

const rnd = () => crypto.randomInt(0, 1e9) / 1e9;
const poisson = (l) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
const pmf = (l, k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * Math.pow(l, k) / f; };
const pub = (t) => ({ n: t.n, c: t.c, col: t.col });

function cleanSettings(s) {
  s = s || {};
  const int = (v, d) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_STAKE) : d; };
  const minBet = Math.max(1, int(s.minBet, DEFAULTS.minBet));
  let maxBet = int(s.maxBet, DEFAULTS.maxBet);
  if (maxBet && maxBet < minBet) maxBet = minBet;
  let edge = Number(s.edge); if (!Number.isFinite(edge) || edge < 0 || edge > 0.4) edge = DEFAULTS.edge;
  return { enabled: s.enabled !== false, edge, minBet, maxBet };
}

module.exports = function createFootball(opts) {
  // same helpers as aviator-engine.js:
  // getWallet(acc) → { jid, name, balance } | null,  queueAdj(jid, name, op, amount) → { id },  getAdj(id) → adjustment | null
  const { dataDir, send, readBody, getAcc, getWallet, queueAdj, getAdj, save, clientIp, hit } = opts;
  const FILE = path.join(dataDir, 'football.json');

  let store = { ledger: {}, inflight: {}, recent: {}, history: [], settings: {}, nextId: 1, stats: { rounds: 0, staked: 0, paid: 0, since: Date.now() } };
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
  if (!store.ledger || typeof store.ledger !== 'object') store.ledger = {};
  if (!store.recent || typeof store.recent !== 'object') store.recent = {};
  if (!Array.isArray(store.history)) store.history = [];
  store.settings = cleanSettings(store.settings);

  const ledger = (number, jid, name) => {
    let l = store.ledger[number];
    if (!l) l = store.ledger[number] = { jid, name, pending: 0, inflight: 0, adjId: null, retryAt: 0, fails: 0 };
    if (jid) l.jid = jid; if (name) l.name = name;
    return l;
  };
  const net = (number) => { const l = store.ledger[number]; return l ? l.pending + l.inflight : 0; };
  // a restart in the middle of a round must never eat a stake: give back every unsettled bet
  for (const b of Object.values(store.inflight || {})) if (b && b.number && b.jid) ledger(b.number, b.jid, b.name).pending += b.amount;
  store.inflight = {};

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

  const walletOf = (acc) => {
    const w = getWallet(acc);
    return w ? { jid: w.jid, name: w.name, have: Math.max(0, Math.floor(w.balance + net(acc.number))) } : null;
  };
  const credit = (b, x) => { ledger(b.number, b.jid, b.name).pending += x; touch(); };

  // ── settling with the bot (same as the crash plane) ─────────
  function check(l) {
    if (!l.adjId) return false;
    const a = getAdj(l.adjId), st = a && a.status;
    if (st === 'done') { l.inflight = 0; l.adjId = null; l.fails = 0; touch(); return true; }
    if (!a || st === 'failed' || st === 'cancelled') {
      l.pending += l.inflight; l.inflight = 0; l.adjId = null; l.fails++;
      l.retryAt = Date.now() + Math.min(300000, 20000 * l.fails); touch(); return true;
    }
    return false;
  }
  function onAck(id) { for (const l of Object.values(store.ledger)) if (l.adjId === id) check(l); }
  setInterval(() => {
    const now = Date.now(); let queued = false;
    for (const [n, l] of Object.entries(store.ledger)) {
      if (l.adjId) { check(l); continue; }
      if (!l.pending) { if (!l.inflight) { delete store.ledger[n]; touch(); } continue; }
      if (now < l.retryAt || !l.jid) continue;
      const a = queueAdj(l.jid, l.name, l.pending > 0 ? 'add' : 'remove', Math.abs(l.pending));
      l.adjId = a.id; l.inflight = l.pending; l.pending = 0; queued = true; touch();
    }
    if (queued) save();
  }, 1000).unref();

  // ── fixtures + round ────────────────────────────────────────
  function fixture(h, a, id, edge) {
    const lh = 1.35 * Math.pow(h.s / a.s, .6) * 1.08, la = 1.15 * Math.pow(a.s / h.s, .6);
    const p = [0, 0, 0];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) p[i > j ? 0 : i === j ? 1 : 2] += pmf(lh, i) * pmf(la, j);
    const t = p[0] + p[1] + p[2];
    const o = p.map(x => Math.min(50, Math.max(1.05, Math.round((1 - edge) / (x / t) * 100) / 100)));
    const gh = Math.min(poisson(lh), 6), ga = Math.min(poisson(la), 6), goals = [];
    for (let i = 0; i < gh; i++) goals.push({ m: 1 + crypto.randomInt(0, 89), side: 0 });
    for (let i = 0; i < ga; i++) goals.push({ m: 1 + crypto.randomInt(0, 89), side: 1 });
    goals.sort((x, y) => x.m - y.m);
    return { id, h, a, o, goals, gh, ga, res: gh > ga ? 0 : gh === ga ? 1 : 2 };
  }
  let round = null;
  function newRound() {
    const t = [...TEAMS].sort(() => rnd() - .5), edge = store.settings.edge;
    round = { id: store.nextId++, start: Date.now(), fx: [0, 1, 2, 3].map(i => fixture(t[i * 2], t[i * 2 + 1], i, edge)), bets: [], settled: false };
    touch();
  }
  const phase = () => {
    const e = Date.now() - round.start;
    return e < BET_MS ? 'bet' : e < BET_MS + PLAY_MS ? 'play' : 'end';
  };

  function settle() {
    round.settled = true;
    for (const b of round.bets) {
      const ok = b.picks.every(p => round.fx[p.m].res === p.i);
      b.win = ok ? Math.min(MAX_WIN, Math.floor(b.amount * b.odds)) : 0;
      delete store.inflight[b.id];
      if (b.win) { credit(b, b.win); store.stats.paid += b.win; }
      const r = store.recent[b.number] || (store.recent[b.number] = []);
      r.unshift({ round: round.id, amount: b.amount, odds: b.odds, win: b.win, n: b.picks.length });
      if (r.length > 20) r.length = 20;
    }
    store.stats.rounds++;
    store.history.unshift({ id: round.id, r: round.fx.map(f => f.h.c + ' ' + f.gh + '-' + f.ga + ' ' + f.a.c) });
    if (store.history.length > 8) store.history.length = 8;
    touch();
  }
  setInterval(() => {
    if (Date.now() - round.start >= CYCLE) { if (!round.settled) settle(); newRound(); return; }
    if (!round.settled && phase() === 'end') settle();
  }, 250).unref();

  // ── placing a bet ───────────────────────────────────────────
  function placeBet(acc, body) {
    const s = store.settings;
    if (!s.enabled) return { status: 400, error: 'game_off' };
    if (phase() !== 'bet') return { status: 400, error: 'closed' };
    if (Number(body.round) !== round.id) return { status: 400, error: 'stale' };
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    if (amount < s.minBet) return { status: 400, error: 'below_min' };
    if (s.maxBet && amount > s.maxBet) return { status: 400, error: 'above_max' };
    const raw = Array.isArray(body.picks) ? body.picks : [];
    const seen = new Set(), picks = [];
    for (const p of raw) {
      const m = Number(p && p.m), i = Number(p && p.i);
      if (!Number.isInteger(m) || m < 0 || m > 3 || !Number.isInteger(i) || i < 0 || i > 2 || seen.has(m)) return { status: 400, error: 'bad_picks' };
      seen.add(m); picks.push({ m, i });
    }
    if (!picks.length || picks.length > MAX_PICKS) return { status: 400, error: 'bad_picks' };
    if (round.bets.filter(b => b.number === acc.number).length >= MAX_BETS) return { status: 400, error: 'too_many' };
    const w = walletOf(acc);
    if (!w) return { status: 400, error: 'no_wallet' };
    if (w.have < 1) return { status: 400, error: 'no_money' };
    if (w.have < amount) return { status: 400, error: 'insufficient' };
    const odds = Math.round(picks.reduce((x, p) => x * round.fx[p.m].o[p.i], 1) * 100) / 100;   // the SERVER's odds, never the browser's
    ledger(acc.number, w.jid, w.name).pending -= amount;                                         // the stake leaves the wallet right now
    store.stats.staked += amount;
    const b = { id: crypto.randomBytes(6).toString('hex'), number: acc.number, jid: w.jid, name: w.name || acc.name, picks, amount, odds, win: null };
    store.inflight[b.id] = { number: acc.number, jid: w.jid, name: b.name, amount };
    round.bets.push(b); touch();
    return { status: 200 };
  }

  // ── what the browser sees ───────────────────────────────────
  function view(acc) {
    const ph = phase(), s = store.settings;
    const w = acc ? walletOf(acc) : null;
    return {
      ok: true, now: Date.now(), enabled: s.enabled, limits: { min: s.minBet, max: s.maxBet },
      timing: { bet: BET_MS, play: PLAY_MS, end: END_MS },
      round: {
        id: round.id, start: round.start,
        fx: round.fx.map(f => ({ id: f.id, h: pub(f.h), a: pub(f.a), o: f.o, goals: ph === 'bet' ? null : f.goals }))   // no goal minutes before kick-off
      },
      mine: acc ? round.bets.filter(b => b.number === acc.number).map(b => ({ picks: b.picks, amount: b.amount, odds: b.odds, win: ph === 'end' ? b.win : null })) : [],
      recent: acc ? (store.recent[acc.number] || []) : [],
      history: store.history,
      balance: w ? w.have : null
    };
  }

  // ── admin helpers (optional) ────────────────────────────────
  function setSettings(patch) {
    const clean = cleanSettings(Object.assign({}, store.settings, patch || {}));
    store.settings = clean; touch(); return { settings: clean };
  }
  const adminInfo = () => ({ settings: store.settings, round: { id: round.id, phase: phase(), bets: round.bets.length }, stats: Object.assign({ houseNet: store.stats.staked - store.stats.paid }, store.stats) });

  // ── http entry point (server.js sends everything under /football/ here) ──
  async function handle(req, res, p) {
    const acc = getAcc(req);
    if (p === '/football/state' && req.method === 'GET') {
      if (hit('fbs', clientIp(req), 300, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      return send(res, 200, view(acc));
    }
    if (req.method !== 'POST' || p !== '/football/bet') return send(res, 404, { ok: false, error: 'not_found' });
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
    if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });
    if (hit('fbb', acc.number, 60, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    const r = placeBet(acc, await readBody(req));
    if (r.status !== 200) return send(res, r.status, { ok: false, error: r.error });
    return send(res, 200, { ok: true, balance: (walletOf(acc) || {}).have });
  }

  newRound();
  return { handle, onAck, setSettings, adminInfo, hold: (number) => Math.max(0, -net(number)) };
};
