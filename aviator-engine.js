'use strict';
// ================================================================
// Crash-plane game engine (zero dependencies).
//   • One shared round for everybody: WAITING (bets open) → FLYING → CRASHED → repeat
//   • The server decides the crash point; the browser only draws it
//   • Provably fair: the hash of the round's secret is shown BEFORE the flight,
//     the secret itself is revealed AFTER the crash so anyone can re-check it
//   • Manual cash out + auto cash out (checked on the server every 50 ms)
//   • Players use PRACTICE CREDITS kept in data/aviator.json (not the bot wallet)
// ================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE      = Math.min(0.2, Math.max(0, Number(process.env.AVIATOR_EDGE ?? 0.03)));   // house edge, 3% like most crash games
const WAIT_MS   = 6000;      // betting window
const CRASHED_MS = 3500;     // how long the "flew away" screen stays
const RATE      = 0.075;     // multiplier = e^(RATE * seconds)  →  2x at ~9s, 10x at ~31s
const MAX_MULT  = 1000;
const START_CREDITS = 10000;
const MAX_STAKE = 1e9;
const TICK_MS   = 50;

const mult = (ms) => Math.exp(RATE * Math.max(0, ms) / 1000);
const timeFor = (m) => Math.log(m) / RATE * 1000;   // how long until the plane reaches multiplier m
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;

function crashPointFrom(seed, roundId) {
  const h = crypto.createHmac('sha256', seed).update(String(roundId)).digest('hex');
  const r = parseInt(h.slice(0, 13), 16) / 2 ** 52;                 // 0 ≤ r < 1, uniform
  const raw = (1 - EDGE) / (1 - r);                                  // P(crash ≥ x) = (1-edge)/x
  return Math.min(MAX_MULT, Math.max(1, floor2(raw)));
}

module.exports = function createAviator(opts) {
  const { dataDir, send, readBody, getAcc, clientIp, hit, SEC_HEADERS } = opts;
  const FILE = path.join(dataDir, 'aviator.json');

  // ── wallets (practice credits) ──────────────────────────────
  let store = { wallets: {}, inflight: {}, history: [] };
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
  // a restart in the middle of a round must never eat anybody's stake: give back every unsettled bet
  for (const [id, b] of Object.entries(store.inflight || {})) store.wallets[b.number] = (store.wallets[b.number] || 0) + b.amount;
  store.inflight = {};
  if (!Array.isArray(store.history)) store.history = [];

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

  const bal = (n) => { if (store.wallets[n] === undefined) { store.wallets[n] = START_CREDITS; touch(); } return store.wallets[n]; };
  const credit = (n, x) => { store.wallets[n] = bal(n) + x; touch(); };

  // ── the round ───────────────────────────────────────────────
  let roundNo = 0;
  let round = null;          // current round
  let queued = new Map();    // bets placed while a round is flying: key -> bet (they join the next round)
  let timer = null;

  function newRound() {
    roundNo++;
    const seed = crypto.randomBytes(24).toString('hex');
    round = {
      id: roundNo, seed, hash: crypto.createHash('sha256').update(seed).digest('hex'),
      crash: crashPointFrom(seed, roundNo),
      phase: 'waiting', waitEnd: Date.now() + WAIT_MS, startAt: 0, crashedAt: 0,
      bets: new Map()
    };
    for (const [k, b] of queued) { b.round = round.id; round.bets.set(k, b); }   // stakes were already taken when queued
    queued = new Map();
    broadcast();
    timer = setTimeout(takeOff, WAIT_MS);
  }

  function takeOff() {
    round.phase = 'flying';
    round.startAt = Date.now();
    broadcast();
    timer = setInterval(tick, TICK_MS);
  }

  function settle(b, at) {                      // a win
    b.cashed = at;
    b.win = Math.floor(b.amount * at);
    credit(b.number, b.win);
    delete store.inflight[b.id];
    touch();
  }

  function tick() {
    const elapsed = Date.now() - round.startAt;
    const m = Math.min(mult(elapsed), round.crash);           // never look past the crash point
    let changed = false;
    for (const b of round.bets.values()) {
      if (b.cashed == null && b.auto && b.auto <= m) { settle(b, b.auto); changed = true; }   // exact auto value, not whatever the tick saw
    }
    if (elapsed >= timeFor(round.crash)) return crash();
    if (changed) broadcast();
  }

  function crash() {
    clearInterval(timer);
    round.phase = 'crashed';
    round.crashedAt = Date.now();
    for (const b of round.bets.values()) if (b.cashed == null) { b.win = 0; delete store.inflight[b.id]; }
    store.history.unshift(round.crash);
    if (store.history.length > 40) store.history.length = 40;
    touch();
    broadcast();
    timer = setTimeout(newRound, CRASHED_MS);
  }

  // ── what the browser is allowed to see ──────────────────────
  const mask = (s) => { s = String(s || 'Player'); return s.length <= 2 ? s[0] + '***' : s.slice(0, 1) + '***' + s.slice(-1); };
  function snapshot(acc) {
    const r = round, now = Date.now();
    const s = {
      now, phase: r.phase, id: r.id, hash: r.hash, waitEnd: r.waitEnd, startAt: r.startAt,
      rate: RATE, history: store.history.slice(0, 18),
      bets: [...r.bets.values()].map(b => ({ name: mask(b.name), amount: b.amount, cashed: b.cashed ?? null, win: b.win ?? null })).sort((a, b) => b.amount - a.amount).slice(0, 60),
      players: r.bets.size
    };
    if (r.phase === 'crashed') { s.crash = r.crash; s.seed = r.seed; s.crashedAt = r.crashedAt; }
    if (acc) {
      const mine = [];
      for (const [k, b] of r.bets) if (b.number === acc.number) mine.push({ slot: b.slot, amount: b.amount, auto: b.auto, cashed: b.cashed ?? null, win: b.win ?? null, next: false });
      for (const b of queued.values()) if (b.number === acc.number) mine.push({ slot: b.slot, amount: b.amount, auto: b.auto, cashed: null, win: null, next: true });
      s.me = { name: acc.name, balance: bal(acc.number), bets: mine };
    }
    return s;
  }

  // ── live connections (Server-Sent Events) ───────────────────
  const clients = new Set();
  let bcastT = null;
  function broadcast(soon) {
    if (soon) { if (bcastT) return; bcastT = setTimeout(() => { bcastT = null; broadcast(); }, 250); return; }
    for (const c of clients) pushTo(c);
  }
  function pushTo(c) {
    try { c.res.write('event: s\ndata: ' + JSON.stringify(snapshot(c.acc)) + '\n\n'); } catch { clients.delete(c); }
  }
  setInterval(() => { for (const c of clients) { try { c.res.write(': hb\n\n'); } catch { clients.delete(c); } } }, 15000).unref();
  setInterval(() => { if (clients.size) broadcast(); }, 1000).unref();   // keeps every browser's clock and balance fresh

  // ── bet actions ─────────────────────────────────────────────
  const keyOf = (n, slot) => n + ':' + slot;
  const findBet = (n, slot) => {
    const k = keyOf(n, slot);
    if (queued.has(k)) return { b: queued.get(k), where: 'queued', k };
    if (round.bets.has(k)) return { b: round.bets.get(k), where: 'round', k };
    return null;
  };

  function placeBet(acc, body) {
    const slot = Number(body.slot) === 1 ? 1 : 0;
    const amount = Math.floor(Number(String(body.amount ?? '').replace(/[,\s]/g, '')));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    let auto = null;
    if (body.auto !== null && body.auto !== undefined && body.auto !== '' && body.auto !== false) {
      auto = floor2(Number(body.auto));
      if (!Number.isFinite(auto) || auto < 1.01 || auto > MAX_MULT) return { status: 400, error: 'bad_auto' };
    }
    // one bet per panel per round. While the plane is flying you may line up a bet for the NEXT round
    // even if this panel already has a bet in the current one.
    const had = findBet(acc.number, slot);
    if (had && !(had.where === 'round' && round.phase !== 'waiting')) return { status: 400, error: 'already_bet' };
    if (bal(acc.number) < amount) return { status: 400, error: 'insufficient' };
    credit(acc.number, -amount);
    const b = { id: crypto.randomBytes(6).toString('hex'), number: acc.number, name: acc.name, slot, amount, auto, cashed: null, win: null };
    store.inflight[b.id] = { number: acc.number, amount };
    // bets made while the plane is in the air (or just crashed) wait for the next round
    if (round.phase === 'waiting') { b.round = round.id; round.bets.set(keyOf(acc.number, slot), b); }
    else queued.set(keyOf(acc.number, slot), b);
    touch(); broadcast(true);
    return { status: 200 };
  }

  function cancelBet(acc, body) {
    const slot = Number(body.slot) === 1 ? 1 : 0;
    const f = findBet(acc.number, slot);
    if (!f) return { status: 400, error: 'no_bet' };
    if (f.where === 'round' && round.phase !== 'waiting') return { status: 400, error: 'too_late' };
    (f.where === 'queued' ? queued : round.bets).delete(f.k);
    delete store.inflight[f.b.id];
    credit(acc.number, f.b.amount);
    broadcast(true);
    return { status: 200 };
  }

  function cashOut(acc, body) {
    const slot = Number(body.slot) === 1 ? 1 : 0;
    const b = round.bets.get(keyOf(acc.number, slot));              // only a bet that is in the air can be cashed out
    if (!b || b.cashed != null) return { status: 400, error: 'no_bet' };
    if (round.phase !== 'flying') return { status: 400, error: 'too_late' };
    const m = mult(Date.now() - round.startAt);                     // the SERVER's clock decides, not the browser's
    if (m >= round.crash) return { status: 400, error: 'too_late' };
    const at = Math.max(1, floor2(m));
    settle(b, at);
    broadcast(true);
    return { status: 200, at, win: b.win };
  }

  // ── http entry point (called from server.js for everything under /aviator/) ──
  const conns = new Map();   // ip -> open streams
  async function handle(req, res, p) {
    const acc = getAcc(req);
    if (p === '/aviator/stream' && req.method === 'GET') {
      const ip = clientIp(req);
      if ((conns.get(ip) || 0) >= 12) return send(res, 429, { ok: false, error: 'rate_limited' });
      conns.set(ip, (conns.get(ip) || 0) + 1);
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
      }, SEC_HEADERS, { 'Cache-Control': 'no-store, no-transform' }));
      res.write('retry: 1500\n\n');
      const c = { res, acc };
      clients.add(c);
      pushTo(c);
      req.on('close', () => { clients.delete(c); const n = (conns.get(ip) || 1) - 1; if (n <= 0) conns.delete(ip); else conns.set(ip, n); });
      return;
    }
    if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not_found' });
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
    if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });
    if (hit('avi', acc.number, 120, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    const body = await readBody(req);
    let r;
    if (p === '/aviator/bet') r = placeBet(acc, body);
    else if (p === '/aviator/cancel') r = cancelBet(acc, body);
    else if (p === '/aviator/cashout') r = cashOut(acc, body);
    else if (p === '/aviator/refill') {
      if (bal(acc.number) >= 100) r = { status: 400, error: 'not_needed' };
      else { store.wallets[acc.number] = START_CREDITS; touch(); r = { status: 200 }; }
    }
    else return send(res, 404, { ok: false, error: 'not_found' });
    if (r.status !== 200) return send(res, r.status, { ok: false, error: r.error });
    const out = { ok: true, balance: bal(acc.number) };
    if (r.at) { out.at = r.at; out.win = r.win; }
    return send(res, 200, out);
  }

  newRound();
  return { handle, _test: { crashPointFrom, mult, timeFor, EDGE } };
};
