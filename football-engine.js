'use strict';
// ================================================================
// Virtual football (TV) engine — zero dependencies, same wallet rules as the crash plane.
//   • One shared timetable for everybody: a new round kicks off every 90s. The NEXT round is always open for
//     betting (1:30 countdown) while the CURRENT round is on TV: PLAY (45s = 90 match minutes) → FULL TIME (7s)
//   • 80 matches per round: 20 in each of 4 leagues (England, Spain, Germany, Champions), 40 teams per league.
//     Markets: 1X2, 1UP, 2UP, double chance, GG/NG, correct score, goals Over/Under (0.5-6.5), home / away Over/Under.
//     The SERVER draws every result and every goal minute; the browser only plays it.
//     Goal minutes are not sent until betting has closed.
//   • Players stake REAL WALLET MONEY. Stakes and wins go through a small ledger that is sent to the bot
//     as ONE net "add" / "remove" per player (same trick as aviator-engine.js).
//   • REAL football (optional): real fixtures + real bookmaker odds from The Odds API, settled from real final scores.
//     Turn it on with env ODDS_API_KEY (and optionally REAL_LEAGUES, REAL_EDGE, REAL_REFRESH_MIN).
//   • Settings (on/off, house edge, min/max stake) live in data/football.json
// ================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVERY = 90000, PLAY_MS = 45000, END_MS = 7000;   // a new round kicks off every EVERY ms
const MAX_STAKE = 1e12, MAX_WIN = 1e14, MAX_PICKS = 10, MAX_BETS = 8, PER = 20, CAP = 6;
// virtual markets (every market is an array of odds):
//   x = 1X2 · u1 / u2 = 1X2 with 1UP / 2UP early payout · dc = double chance (1X, 12, X2) · gg = GG / NG (both teams score)
//   cs = correct score (the CS list + "Other") · oNN = total goals Over/Under NN/10 · hNN / aNN = HOME / AWAY team goals
const LINES = { o: [.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5], h: [.5, 1.5, 2.5, 3.5], a: [.5, 1.5, 2.5, 3.5] };
const CS = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 1], [2, 1], [3, 1], [4, 1], [1, 2], [1, 3], [1, 4], [2, 2], [3, 2], [2, 3], [3, 3]];
const OPTS = { x: 3, u1: 3, u2: 3, dc: 3, gg: 2, cs: CS.length + 1 };
for (const [p, ls] of Object.entries(LINES)) ls.forEach(l => { OPTS[p + Math.round(l * 10)] = 2; });
const lineOf = (k) => Number(k.slice(1)) / 10;

// 40 teams per league → 20 matches per league every round.  "Name|CODE|strength"
const T = (txt) => txt.trim().split(/\s*;\s*/).map(x => x.split('|'));
const LGDATA = [
  ['England', T(`Arsenal|ARS|1.75; Aston Villa|AST|1.45; Bournemouth|BOU|1.3; Brentford|BRE|1.3; Brighton|BHA|1.35; Chelsea|CHE|1.5; Crystal Palace|CRY|1.3; Everton|EVE|1.25;
    Fulham|FUL|1.25; Ipswich|IPS|1.1; Leicester|LEI|1.15; Liverpool|LIV|1.8; Man City|MCI|1.95; Man United|MUN|1.6; Newcastle|NEW|1.45; Nottm Forest|NFO|1.3; Southampton|SOU|1.1;
    Tottenham|TOT|1.5; West Ham|WHU|1.3; Wolves|WOL|1.2; Leeds|LEE|1.3; Sunderland|SUN|1.2; Burnley|BUR|1.25; Sheffield Utd|SHU|1.2; Norwich|NOR|1.15; Middlesbrough|MID|1.15;
    Coventry|COV|1.1; Watford|WAT|1.1; Blackburn|BLB|1.1; Stoke|STK|1.1; Swansea|SWA|1.1; Cardiff|CAR|1.05; Bristol City|BRC|1.05; Hull|HUL|1.05; Millwall|MLW|1.05;
    Preston|PNE|1.05; QPR|QPR|1.05; Derby|DER|1.05; Plymouth|PLY|1.0; Luton|LUT|1.1`)],
  ['Spain', T(`Barcelona|BAR|1.8; Real Madrid|RMA|1.9; Atletico|ATM|1.65; Sevilla|SEV|1.3; Valencia|VAL|1.3; Villarreal|VIL|1.35; Betis|BET|1.3; Real Sociedad|RSO|1.35;
    Athletic|ATH|1.45; Girona|GIR|1.35; Celta|CEL|1.2; Osasuna|OSA|1.2; Getafe|GET|1.15; Mallorca|MLL|1.15; Rayo|RAY|1.15; Alaves|ALA|1.1; Las Palmas|LPA|1.1; Espanyol|ESP|1.1;
    Leganes|LEG|1.05; Valladolid|VLD|1.05; Sporting Gijon|SPG|1.1; Racing|RAC|1.05; Elche|ELC|1.05; Levante|LEV|1.1; Granada|GRA|1.1; Almeria|ALM|1.05; Malaga|MAL|1.05;
    Zaragoza|ZAR|1.05; Oviedo|OVI|1.05; Cadiz|CAD|1.05; Eibar|EIB|1.0; Tenerife|TEN|1.0; Burgos|BUG|1.0; Cordoba|COR|1.0; Huesca|HUE|1.0; Mirandes|MIR|1.0; Albacete|ALB|1.0;
    Castellon|CAS|1.0; Cartagena|CTG|1.0; Ferrol|FER|1.0`)],
  ['Germany', T(`Bayern|BAY|1.95; Dortmund|BVB|1.45; Leipzig|RBL|1.35; Leverkusen|B04|1.6; Frankfurt|SGE|1.3; Wolfsburg|WOB|1.2; Stuttgart|STU|1.3; Freiburg|SCF|1.2;
    Gladbach|BMG|1.2; Hoffenheim|TSG|1.2; Mainz|M05|1.15; Werder Bremen|SVW|1.15; Augsburg|FCA|1.1; Union Berlin|FCU|1.1; Heidenheim|HDH|1.1; Bochum|BOC|1.05; St Pauli|STP|1.05;
    Holstein Kiel|KIE|1.0; Hamburg|HSV|1.15; Schalke|S04|1.1; Hertha|BSC|1.1; Koln|KOE|1.1; Hannover|H96|1.05; Dusseldorf|F95|1.05; Nurnberg|FCN|1.0; Karlsruhe|KSC|1.0;
    Kaiserslautern|FCK|1.0; Paderborn|SCP|1.0; Magdeburg|FCM|1.0; Darmstadt|D98|1.0; Greuther Furth|SGF|1.0; Braunschweig|EBS|1.0; Elversberg|SVE|1.0; Ulm|ULM|1.0;
    Regensburg|SSV|1.0; Munster|PRE|1.0; Osnabruck|VFL|1.0; Cottbus|FCE|1.0; Dresden|SGD|1.0; Rostock|FCH|1.0`)],
  ['Champions', T(`Inter|INT|1.6; Napoli|NAP|1.4; Juventus|JUV|1.55; AC Milan|MIL|1.55; Roma|ROM|1.4; Lazio|LAZ|1.35; Atalanta|ATA|1.45; Fiorentina|FIO|1.25; PSG|PSG|1.85;
    Marseille|OM|1.35; Monaco|ASM|1.35; Lyon|OL|1.3; Lille|LIL|1.3; Nice|NIC|1.2; Benfica|BEN|1.35; Porto|POR|1.35; Sporting|SPO|1.4; Braga|SCB|1.2; Ajax|AJX|1.3; PSV|PSV|1.4;
    Feyenoord|FEY|1.3; Celtic|CEL|1.15; Rangers|RAN|1.15; Galatasaray|GAL|1.25; Fenerbahce|FEN|1.25; Besiktas|BJK|1.15; Club Brugge|BRU|1.2; Anderlecht|AND|1.1;
    Salzburg|SAL|1.15; Shakhtar|SHA|1.15; Dinamo Zagreb|DZG|1.1; Young Boys|YB|1.05; Basel|BAS|1.05; Copenhagen|COP|1.05; Olympiacos|OLY|1.1; PAOK|PAO|1.05;
    Slavia Prague|SLP|1.1; Sparta Prague|SPR|1.05; Red Star|RSB|1.05; Rapid Vienna|RAP|1.0`)]
];
const KNOWN = { ARS: '#e5322d', CHE: '#2a5bd7', LIV: '#c8102e', MCI: '#6cabdd', MUN: '#da291c', TOT: '#4a6fe0', NEW: '#9a9a9a', AST: '#8b2f4f', BAR: '#a50044', RMA: '#f2f2f2', ATM: '#cb3524',
  BAY: '#dc052d', BVB: '#fdd835', RBL: '#dd0741', B04: '#e32219', INT: '#0d6fd1', NAP: '#2a9be0', JUV: '#e8e8e8', MIL: '#fb090b', PSG: '#ff8a1f', BEN: '#e83030', AJX: '#d2122e', POR: '#3f7be0' };
const hex = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
function autoColor(name) {                          // a steady colour per club for the ones without a famous kit
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const l = .52, sat = .62, k = (n) => (n + h / 30) % 12, aa = sat * Math.min(l, 1 - l), f = (n) => l - aa * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + hex(f(0)) + hex(f(8)) + hex(f(4));
}
const LG = LGDATA.map(([n, ts]) => [n, ts.map(([tn, c, sv]) => { const s = Number(sv); return { n: tn, c, col: KNOWN[c] || autoColor(tn), s, st: Math.max(1, Math.min(5, Math.round((s - 1) / .95 * 4) + 1)) }; })]);
const MATCHES = LG.length * PER;
const DEFAULTS = { enabled: true, edge: 0.08, minBet: 1, maxBet: 0 };   // edge = share the house keeps; maxBet 0 = no limit

const rnd = () => crypto.randomInt(0, 1e9) / 1e9;
const poisson = (l) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
const pmf = (l, k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * Math.pow(l, k) / f; };
const pub = (t) => ({ n: t.n, c: t.c, col: t.col, st: t.st });

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

  let store = { ledger: {}, inflight: {}, recent: {}, history: [], settings: {}, real: {}, nextId: 1, stats: { rounds: 0, staked: 0, paid: 0, since: Date.now() } };
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
  if (!store.ledger || typeof store.ledger !== 'object') store.ledger = {};
  if (!store.recent || typeof store.recent !== 'object') store.recent = {};
  if (!Array.isArray(store.history)) store.history = [];
  store.settings = cleanSettings(store.settings);
  const real = store.real = Object.assign({ events: {}, bets: [], lastFetch: 0, lastError: '', credits: null, diag: {}, stats: { staked: 0, paid: 0 } }, store.real || {});
  if (!real.events || typeof real.events !== 'object') real.events = {};
  if (!Array.isArray(real.bets)) real.bets = [];

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
  // goals are capped at CAP per team, so the odds are worked out from the SAME capped distribution that is drawn
  const capPmf = (l) => { const a = []; let t = 0; for (let k = 0; k < CAP; k++) { const p = pmf(l, k); a.push(p); t += p; } a.push(Math.max(0, 1 - t)); return a; };
  // chance that a team with r1 goals (other side r2) is EVER ahead by k+, goals arriving in random order (minutes are random)
  const evMemo = new Map();
  function evl(r1, r2, d, k) {
    if (d >= k) return 1; if (r1 === 0 || d + r1 < k) return 0;
    const key = r1 + ',' + r2 + ',' + d + ',' + k; if (evMemo.has(key)) return evMemo.get(key);
    const p1 = r1 / (r1 + r2), v = p1 * evl(r1 - 1, r2, d + 1, k) + (r2 ? (1 - p1) * evl(r1, r2 - 1, d - 1, k) : 0);
    evMemo.set(key, v); return v;
  }
  function fixture(h, a, id, edge, lg) {
    const lh = 1.35 * Math.pow(h.s / a.s, .6) * 1.08, la = 1.15 * Math.pow(a.s / h.s, .6);
    const ph = capPmf(lh), pa = capPmf(la), px = [0, 0, 0], tg = new Array(2 * CAP + 1).fill(0), u = { 1: [0, 0], 2: [0, 0] };
    for (let i = 0; i <= CAP; i++) for (let j = 0; j <= CAP; j++) {
      const p = ph[i] * pa[j]; px[i > j ? 0 : i === j ? 1 : 2] += p; tg[i + j] += p;
      for (const k of [1, 2]) { u[k][0] += p * (i > j ? 1 : evl(i, j, 0, k)); u[k][1] += p * (j > i ? 1 : evl(j, i, 0, k)); }   // winning outright always pays
    }
    const odd = (p, mx = 50) => { const r = (1 - edge) / Math.max(p, 1e-9); return r < 1.05 ? null : Math.min(mx, Math.round(r * 100) / 100); };   // near-certain outcomes are LOCKED (null), never paid at a loss
    const o = { x: px.map(p => odd(p)), dc: [px[0] + px[1], px[0] + px[2], px[1] + px[2]].map(p => odd(p)), u1: [odd(u[1][0]), odd(px[1]), odd(u[1][1])], u2: [odd(u[2][0]), odd(px[1]), odd(u[2][1])] };
    let gg = 0; for (let i = 1; i <= CAP; i++) for (let j = 1; j <= CAP; j++) gg += ph[i] * pa[j];
    o.gg = [odd(gg), odd(1 - gg)];
    const csp = CS.map(([i, j]) => ph[i] * pa[j]); o.cs = [...csp.map(p => odd(p, 500)), odd(1 - csp.reduce((x, y) => x + y, 0), 500)];
    for (const l of LINES.o) { let over = 0; tg.forEach((p, t) => { if (t > l) over += p; }); o['o' + Math.round(l * 10)] = [odd(over), odd(1 - over)]; }
    for (const l of LINES.h) { let ov = 0; ph.forEach((p, t) => { if (t > l) ov += p; }); o['h' + Math.round(l * 10)] = [odd(ov), odd(1 - ov)]; }
    for (const l of LINES.a) { let ov = 0; pa.forEach((p, t) => { if (t > l) ov += p; }); o['a' + Math.round(l * 10)] = [odd(ov), odd(1 - ov)]; }
    const gh = Math.min(poisson(lh), CAP), ga = Math.min(poisson(la), CAP), goals = [];
    for (let i = 0; i < gh; i++) goals.push({ m: 1 + crypto.randomInt(0, 89), side: 0 });
    for (let i = 0; i < ga; i++) goals.push({ m: 1 + crypto.randomInt(0, 89), side: 1 });
    goals.sort((x, y) => x.m - y.m);
    return { id, lg, h, a, o, goals, gh, ga, res: gh > ga ? 0 : gh === ga ? 1 : 2 };
  }
  // did this selection win? (1UP / 2UP: a team that was EVER 1 / 2 goals ahead is paid as a winner, even if it did not win)
  const everLead = (f, side, k) => { let d = 0; for (const g of f.goals) { d += g.side === side ? 1 : -1; if (d >= k) return true; } return false; };
  function wins(f, k, i) {
    const t = f.gh + f.ga;
    if (k === 'x') return f.res === i;
    if (k === 'gg') return (f.gh > 0 && f.ga > 0) === (i === 0);
    if (k === 'cs') return i < CS.length ? (f.gh === CS[i][0] && f.ga === CS[i][1]) : !CS.some(([x, y]) => x === f.gh && y === f.ga);
    if (k === 'dc') return i === 0 ? f.res !== 2 : i === 1 ? f.res !== 1 : f.res !== 0;
    if (k === 'u1' || k === 'u2') { const n = k === 'u1' ? 1 : 2; return i === 1 ? f.res === 1 : i === 0 ? (f.res === 0 || everLead(f, 0, n)) : (f.res === 2 || everLead(f, 1, n)); }
    const g = k[0] === 'o' ? t : k[0] === 'h' ? f.gh : f.ga;
    return (g > lineOf(k)) === (i === 0);
  }
  // two rounds live at once: `cur` is on TV (playing / full time), `nxt` is open for betting and kicks off at nxt.kick
  const mkRound = (kick) => {
    const edge = store.settings.edge, fx = [];
    LG.forEach(([, teams], li) => { const t = [...teams].sort(() => rnd() - .5); for (let i = 0; i < PER; i++) fx.push(fixture(t[i * 2], t[i * 2 + 1], fx.length, edge, li)); });
    touch(); return { id: store.nextId++, kick, fx, bets: [], settled: false };
  };
  let settledId = 0;
  let cur = mkRound(Date.now() - PLAY_MS - END_MS - 1000); cur.settled = true;     // an already-finished round, so the TV has something to show at start-up
  let nxt = mkRound(Date.now() + EVERY);
  const phaseOf = (r, now) => { now = now || Date.now(); return now < r.kick ? 'bet' : now < r.kick + PLAY_MS ? 'play' : now < r.kick + PLAY_MS + END_MS ? 'end' : 'done'; };

  function settle(r) {
    r.settled = true; settledId = r.id;
    for (const b of r.bets) {
      const legs = b.picks.map(p => { const f = r.fx[p.m]; return { h: f.h.n, a: f.a.n, k: p.k, i: p.i, odd: p.odd, res: wins(f, p.k, p.i) ? 'won' : 'lost', score: f.gh + '-' + f.ga }; });
      b.win = legs.every(l => l.res === 'won') ? Math.min(MAX_WIN, Math.floor(b.amount * b.odds)) : 0;
      delete store.inflight[b.id];
      if (b.win) { credit(b, b.win); store.stats.paid += b.win; }
      const list = store.recent[b.number] || (store.recent[b.number] = []);
      list.unshift({ id: b.id, round: r.id, kick: r.kick, amount: b.amount, odds: b.odds, win: b.win, n: b.picks.length, legs });
      if (list.length > 20) list.length = 20;
    }
    store.stats.rounds++;
    store.history.unshift({ id: r.id, r: r.fx.map(f => f.h.c + ' ' + f.gh + '-' + f.ga + ' ' + f.a.c) });
    if (store.history.length > 6) store.history.length = 6;
    touch();
  }
  setInterval(() => {
    const now = Date.now();
    if (!cur.settled && now >= cur.kick + PLAY_MS) settle(cur);
    if (now >= nxt.kick) { if (!cur.settled) settle(cur); cur = nxt; nxt = mkRound(cur.kick + EVERY); }
  }, 250).unref();

  // ── placing a bet ───────────────────────────────────────────
  function placeBet(acc, body) {
    const s = store.settings;
    if (!s.enabled) return { status: 400, error: 'game_off' };
    if (Number(body.round) !== nxt.id) return { status: 400, error: 'stale' };
    if (Date.now() >= nxt.kick - 1000) return { status: 400, error: 'closed' };
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    if (amount < s.minBet) return { status: 400, error: 'below_min' };
    if (s.maxBet && amount > s.maxBet) return { status: 400, error: 'above_max' };
    const raw = Array.isArray(body.picks) ? body.picks : [];
    const seen = new Set(), picks = [];
    for (const p of raw) {
      const m = Number(p && p.m), i = Number(p && p.i), k = p && p.k ? String(p.k) : 'x';
      const opts = OPTS[k] || 0;
      if (!opts || !Number.isInteger(m) || m < 0 || m >= MATCHES || !Number.isInteger(i) || i < 0 || i >= opts || seen.has(m)) return { status: 400, error: 'bad_picks' };
      if (!nxt.fx[m].o[k][i]) return { status: 400, error: 'bad_picks' };            // locked selection
      seen.add(m); picks.push({ m, k, i, odd: nxt.fx[m].o[k][i] });   // the SERVER's odds, frozen now   // one pick per match in a slip, so legs are never linked (e.g. Home win + Over 0.5)
    }
    if (!picks.length || picks.length > MAX_PICKS) return { status: 400, error: 'bad_picks' };
    if (nxt.bets.filter(b => b.number === acc.number).length >= MAX_BETS) return { status: 400, error: 'too_many' };
    const w = walletOf(acc);
    if (!w) return { status: 400, error: 'no_wallet' };
    if (w.have < 1) return { status: 400, error: 'no_money' };
    if (w.have < amount) return { status: 400, error: 'insufficient' };
    const odds = Math.round(picks.reduce((x, p) => x * p.odd, 1) * 100) / 100;
    ledger(acc.number, w.jid, w.name).pending -= amount;                                         // the stake leaves the wallet right now
    store.stats.staked += amount;
    const b = { id: crypto.randomBytes(6).toString('hex'), number: acc.number, jid: w.jid, name: w.name || acc.name, picks, amount, odds, win: null };
    store.inflight[b.id] = { number: acc.number, jid: w.jid, name: b.name, amount };
    nxt.bets.push(b); touch();
    return { status: 200 };
  }


  // ═══════════════ REAL football (real fixtures, real odds, real results) ═══════════════
  // Data: The Odds API (https://the-odds-api.com). Needs env ODDS_API_KEY. Without it this part stays switched off.
  const ODDS_KEY = String(process.env.ODDS_API_KEY || '').trim();
  // REAL_LEAGUES = "auto" (default): every soccer league that is in season right now (free lookup), the big ones first, at most REAL_AUTO_MAX of them.
  // Or give a fixed list, e.g. REAL_LEAGUES=soccer_epl,soccer_spain_la_liga
  const LEAGUES_RAW = String(process.env.REAL_LEAGUES || 'auto').trim();
  const AUTO = /^auto$/i.test(LEAGUES_RAW);
  const LEAGUES = AUTO ? [] : LEAGUES_RAW.split(',').map(x => x.trim()).filter(Boolean);
  const AUTO_MAX = Math.max(1, Number(process.env.REAL_AUTO_MAX) || 10);
  const DAYS = Math.min(14, Math.max(1, Number(process.env.REAL_DAYS) || 7));                  // today + the next DAYS-1 days
  const FIRST = ['soccer_epl', 'soccer_uefa_champs_league', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_one',
    'soccer_uefa_europa_league', 'soccer_efl_champ', 'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga', 'soccer_fifa_world_cup_qualifier', 'soccer_uefa_nations_league', 'soccer_international_friendlies', 'soccer_africa_cup_of_nations'];
  const TITLES = {};
  const REGIONS = String(process.env.REAL_REGIONS || 'eu').replace(/[^a-z,]/gi, '') || 'eu';
  // extra markets (GG/NG, double chance, draw no bet, more Over/Under lines, home / away goals) cost 1 credit per market per match,
  // so they are fetched only for matches starting soon and re-fetched slowly. REAL_EXTRA_MARKETS=off switches them off.
  const EXTRA_RAW = String(process.env.REAL_EXTRA_MARKETS === undefined ? 'btts,double_chance,draw_no_bet,alternate_totals,team_totals' : process.env.REAL_EXTRA_MARKETS).trim();
  const EXTRA_MKTS = /^(off|none|0|)$/i.test(EXTRA_RAW) ? [] : EXTRA_RAW.split(',').map(x => x.trim()).filter(x => /^[a-z0-9_]+$/.test(x));
  const EXTRA_HOURS = Math.max(1, Number(process.env.REAL_EXTRA_HOURS) || 36);                       // only matches starting within this many hours
  const EXTRA_REFRESH = Math.max(30, Number(process.env.REAL_EXTRA_REFRESH_MIN) || 720) * 60000;     // per match
  const EXTRA_PER_CYCLE = Math.max(1, Number(process.env.REAL_EXTRA_PER_CYCLE) || 12);              // matches per 20-minute cycle
  const MIN_CREDITS = Math.max(0, Number(process.env.REAL_MIN_CREDITS) || 40);                       // below this the extras pause (keeps credits for 1X2 + scores)
  const creditsLow = (n) => !!(real.credits && Date.now() - real.credits.at < 6 * 3600000 && real.credits.left < n);
  const LEAGUE_NAME = { soccer_epl: 'Premier League', soccer_uefa_champs_league: 'Champions League', soccer_spain_la_liga: 'La Liga',
    soccer_italy_serie_a: 'Serie A', soccer_germany_bundesliga: 'Bundesliga', soccer_france_ligue_one: 'Ligue 1',
    soccer_uefa_europa_league: 'Europa League', soccer_efl_champ: 'Championship', soccer_netherlands_eredivisie: 'Eredivisie',
    soccer_portugal_primeira_liga: 'Primeira Liga', soccer_africa_cup_of_nations: 'AFCON', soccer_fifa_world_cup: 'World Cup' };
  let REAL_EDGE = Number(process.env.REAL_EDGE); if (!Number.isFinite(REAL_EDGE) || REAL_EDGE < 0 || REAL_EDGE > 0.3) REAL_EDGE = 0.03;   // share trimmed off the real odds
  const REFRESH_MS = Math.max(10, Number(process.env.REAL_REFRESH_MIN) || 180) * 60000;
  const CLOSE_MS = 60000, MIN_END_MS = 125 * 60000, VOID_MS = 60 * 3600000, MAX_REAL_OPEN = 20;
  const API = 'https://api.the-odds-api.com/v4/sports/';
  const getJson = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const left = r.headers.get('x-requests-remaining');                       // keep an eye on the monthly credits
    if (left !== null && left !== '' && Number.isFinite(Number(left))) { real.credits = { left: Number(left), used: Number(r.headers.get('x-requests-used')) || 0, at: Date.now() }; touch(); }
    if (!r.ok) throw new Error('odds api ' + r.status + (r.status === 401 ? ' (wrong key)' : r.status === 429 ? ' (out of credits / too fast)' : ''));
    return r.json();
  };
  // average over the bookmakers that quote a price; with 3+ quotes the single highest one is dropped so one odd bookmaker cannot hand out a freak price
  const avg = (a) => { a = [...a].sort((x, y) => x - y); if (a.length >= 3) a.pop(); return a.reduce((x, y) => x + y, 0) / a.length; };
  const tidy = (p) => Math.min(100, Math.max(1.01, Math.round(p * (1 - REAL_EDGE) * 100) / 100));
  const half = (pt, max) => Number.isFinite(pt) && pt % 1 === 0.5 && pt > 0 && pt <= max;       // only .5 lines (no push / quarter lines)

  // The Odds API → our markets:  x 1X2 · dc double chance (1X, 12, X2) · dnb draw no bet (1, 2) · gg GG/NG · oNN total goals · hNN / aNN home / away goals
  function parseOdds(e) {
    const H = String(e.home_team || ''), A = String(e.away_team || '');
    const acc = {}, put = (k, i, n, price) => { (acc[k] || (acc[k] = Array.from({ length: n }, () => [])))[i].push(price); };
    for (const bm of e.bookmakers || []) for (const mk of bm.markets || []) for (const oc of mk.outcomes || []) {
      const price = Number(oc.price); if (!(price > 1)) continue;
      const name = String(oc.name || ''), desc = String(oc.description || ''), pt = Number(oc.point), ou = name === 'Over' ? 0 : name === 'Under' ? 1 : -1;
      switch (mk.key) {
        case 'h2h': case 'h2h_3_way': { const i = name === H ? 0 : /^draw$/i.test(name) ? 1 : name === A ? 2 : -1; if (i >= 0) put('x', i, 3, price); break; }
        case 'totals': case 'alternate_totals': if (ou >= 0 && half(pt, 6.5)) put('o' + Math.round(pt * 10), ou, 2, price); break;
        case 'team_totals': case 'alternate_team_totals': {
          const side = (desc === H || name === H) ? 'h' : (desc === A || name === A) ? 'a' : '';
          if (side && ou >= 0 && half(pt, 3.5)) put(side + Math.round(pt * 10), ou, 2, price); break;
        }
        case 'btts': { const i = /^yes$/i.test(name) ? 0 : /^no$/i.test(name) ? 1 : -1; if (i >= 0) put('gg', i, 2, price); break; }
        case 'draw_no_bet': { const i = name === H ? 0 : name === A ? 1 : -1; if (i >= 0) put('dnb', i, 2, price); break; }
        case 'double_chance': {
          const n = name.toLowerCase().replace(/\s+/g, ''), hasH = !!H && name.includes(H), hasA = !!A && name.includes(A), hasD = /draw/i.test(name);
          const i = (hasH && hasD) || n === '1x' ? 0 : (hasH && hasA) || n === '12' ? 1 : (hasD && hasA) || n === 'x2' ? 2 : -1;
          if (i >= 0) put('dc', i, 3, price); break;
        }
      }
    }
    const o = {};
    for (const [k, rows] of Object.entries(acc)) if (rows.every(r => r.length)) o[k] = rows.map(r => tidy(avg(r)));
    return o;
  }
  const compose = (ev) => { ev.o = Object.assign({}, ev.ex || {}, ev.base || {}); return ev; };     // 1X2 + main Over/Under from the main call win; the rest from the per-match call
  for (const ev of Object.values(real.events)) { if (!ev.base) ev.base = ev.o || {}; compose(ev); }
  async function pickLeagues() {                // free call (no credits): which soccer leagues are in season right now
    if (!AUTO) return LEAGUES;
    const all = await getJson(API + '?apiKey=' + encodeURIComponent(ODDS_KEY));
    const soc = (Array.isArray(all) ? all : []).filter(x => x && x.active && !x.has_outrights && /^soccer_/.test(x.key));
    soc.forEach(x => { TITLES[x.key] = x.title; });
    const rank = (k) => { const i = FIRST.indexOf(k); return i < 0 ? 999 : i; };
    return soc.map(x => x.key).sort((a, b) => rank(a) - rank(b)).slice(0, AUTO_MAX);
  }
  let refreshing = false, exBusy = false;
  async function refreshReal() {
    if (!ODDS_KEY || refreshing) return; refreshing = true;
    try {
      const to = new Date(Date.now() + DAYS * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'); let err = ''; const diag = {};
      if (creditsLow(4)) err = 'Odds API credits are used up. Real matches keep their last odds until the credits reset.';
      else for (const lg of await pickLeagues().catch((x) => { err = String(x.message || x).slice(0, 120); return LEAGUES; })) {
        try {
          const list = await getJson(API + encodeURIComponent(lg) + '/odds/?apiKey=' + encodeURIComponent(ODDS_KEY) + '&regions=' + REGIONS + '&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso&commenceTimeTo=' + to);
          diag[lg] = { n: Array.isArray(list) ? list.length : 0, err: '' };
          for (const e of Array.isArray(list) ? list : []) {
            const t = Date.parse(e.commence_time), o = parseOdds(e); if (!o.x || !Number.isFinite(t)) continue;
            const old = real.events[e.id];
            if (old && old.status !== 'open') continue;
            if (old && old.t <= Date.now()) continue;                       // kicked off: the odds stay frozen
            real.events[e.id] = compose({ id: e.id, lg, lgName: LEAGUE_NAME[lg] || TITLES[lg] || lg, h: e.home_team, a: e.away_team, t, base: o, ex: old ? old.ex : {}, exAt: old ? old.exAt : 0, status: 'open', gh: null, ga: null });
          }
        } catch (x) { err = String(x.message || x).slice(0, 120); diag[lg] = { n: 0, err }; }
      }
      if (Object.keys(diag).length) real.diag = diag;
      real.lastFetch = Date.now(); real.lastError = err; touch();
    } finally { refreshing = false; }
    refreshExtras();
  }
  // GG/NG, double chance, draw no bet, more Over/Under lines, home / away goals — one call per match (soonest first)
  async function refreshExtras() {
    if (!ODDS_KEY || !EXTRA_MKTS.length || exBusy) return; exBusy = true;
    try {
      const now = Date.now();
      const due = Object.values(real.events).filter(ev => ev.status === 'open' && ev.t > now + CLOSE_MS && ev.t < now + EXTRA_HOURS * 3600000 && now - (ev.exAt || 0) > EXTRA_REFRESH)
        .sort((a, b) => a.t - b.t).slice(0, EXTRA_PER_CYCLE);
      for (const ev of due) {
        if (creditsLow(MIN_CREDITS)) { real.lastError = 'Odds API credits are low: extra markets paused (1X2 and Over/Under still work).'; break; }
        ev.exAt = Date.now();                                                   // also on failure, so a bad match is not retried every cycle
        try {
          const d = await getJson(API + encodeURIComponent(ev.lg) + '/events/' + encodeURIComponent(ev.id) + '/odds?apiKey=' + encodeURIComponent(ODDS_KEY) + '&regions=' + REGIONS + '&markets=' + EXTRA_MKTS.join(',') + '&oddsFormat=decimal&dateFormat=iso');
          const x = parseOdds(d); delete x.x;
          if (Object.keys(x).length) { ev.ex = x; compose(ev); }
        } catch (x) { real.lastError = String(x.message || x).slice(0, 120); }
        touch();
      }
    } finally { exBusy = false; }
  }
  const ouLine = (k) => Number(k.slice(1)) / 10;
  const res3 = (ev) => ev.gh > ev.ga ? 0 : ev.gh === ev.ga ? 1 : 2;
  // → 'won' | 'lost' | 'void' (draw no bet on a draw = stake back on that leg), from the real final score
  function realLeg(ev, k, i) {
    const r = res3(ev);
    if (k === 'x') return r === i ? 'won' : 'lost';
    if (k === 'dc') return (i === 0 ? r !== 2 : i === 1 ? r !== 1 : r !== 0) ? 'won' : 'lost';
    if (k === 'dnb') return r === 1 ? 'void' : (r === i ? 'won' : 'lost');
    if (k === 'gg') return ((ev.gh > 0 && ev.ga > 0) === (i === 0)) ? 'won' : 'lost';
    const g = k[0] === 'o' ? ev.gh + ev.ga : k[0] === 'h' ? ev.gh : ev.ga;
    return ((g > ouLine(k)) === (i === 0)) ? 'won' : 'lost';
  }
  function evalBet(b) {                        // → null while undecided, else { st, win }
    let prod = 1, won = 0, pending = false;
    for (const p of b.picks) {
      const ev = real.events[p.e];
      if (!ev || ev.status === 'void') continue;                              // void leg: counts as odds 1.00
      if (ev.status !== 'done') { pending = true; continue; }
      const r = realLeg(ev, p.k, p.i);
      if (r === 'lost') return { st: 'lost', win: 0 };                        // one wrong leg loses the slip straight away
      if (r === 'void') continue;
      prod *= p.odd; won++;
    }
    if (pending) return null;
    return won ? { st: 'won', win: Math.min(MAX_WIN, Math.floor(b.amount * prod)) } : { st: 'void', win: b.amount };
  }
  const legRes = (p) => {
    const ev = real.events[p.e];
    if (!ev || ev.status === 'void') return { res: 'void' };
    if (ev.status !== 'done') return { res: 'pend' };
    return { res: realLeg(ev, p.k, p.i), score: ev.gh + '-' + ev.ga };
  };
  function settleBets() {
    for (const b of real.bets) {
      if (b.status !== 'open') continue;
      const r = evalBet(b); if (!r) continue;
      b.status = r.st; b.win = r.win; b.res = b.picks.map(legRes);
      if (r.st === 'won') { credit(b, r.win); real.stats.paid += r.win; store.stats.paid += r.win; }
      if (r.st === 'void') { credit(b, b.amount); real.stats.staked -= b.amount; store.stats.staked -= b.amount; }
      b.done = Date.now(); touch();
    }
  }
  let scoring = false;
  async function pollScores() {
    if (scoring) return; scoring = true;
    try {
      const now = Date.now(), used = new Set(real.bets.filter(b => b.status === 'open').flatMap(b => b.picks.map(p => p.e)));
      const need = Object.values(real.events).filter(ev => ev.status === 'open' && used.has(ev.id));
      for (const ev of need) if (now > ev.t + VOID_MS) { ev.status = 'void'; touch(); }            // never finished: stakes come back
      const lgs = new Set(need.filter(ev => ev.status === 'open' && now > ev.t + MIN_END_MS).map(ev => ev.lg));
      if (ODDS_KEY) for (const lg of lgs) {
        try {
          const list = await getJson(API + encodeURIComponent(lg) + '/scores/?apiKey=' + encodeURIComponent(ODDS_KEY) + '&daysFrom=3&dateFormat=iso');
          for (const r of Array.isArray(list) ? list : []) {
            const ev = real.events[r.id]; if (!ev || ev.status !== 'open' || !r.completed || !Array.isArray(r.scores)) continue;
            const g = (n) => { const x = r.scores.find(z => z.name === n); return x ? parseInt(x.score, 10) : NaN; };
            const gh = g(ev.h), ga = g(ev.a);
            if (Number.isInteger(gh) && Number.isInteger(ga)) { ev.gh = gh; ev.ga = ga; ev.status = 'done'; touch(); }
          }
        } catch (x) { real.lastError = String(x.message || x).slice(0, 120); }
      }
      settleBets();
      const cut = now - 14 * 86400000, live = new Set(real.bets.filter(b => b.status === 'open').flatMap(b => b.picks.map(p => p.e)));
      for (const [id, ev] of Object.entries(real.events)) if (!live.has(id) && ev.t < now - 86400000) { delete real.events[id]; touch(); }
      if (real.bets.length > 3000 || real.bets.some(b => b.status !== 'open' && b.done < cut)) { real.bets = real.bets.filter(b => b.status === 'open' || b.done >= cut).slice(-3000); touch(); }
    } finally { scoring = false; }
  }
  if (ODDS_KEY) {
    setTimeout(refreshReal, 3000).unref();
    setInterval(() => { if (Date.now() - real.lastFetch >= REFRESH_MS) refreshReal(); }, 60000).unref();
    setInterval(refreshExtras, 20 * 60000).unref();                                  // matches that come within range later get their extra markets too
    setInterval(pollScores, 300000).unref();
    setTimeout(pollScores, 15000).unref();
  }

  function placeReal(acc, body) {
    const s = store.settings;
    if (!ODDS_KEY) return { status: 400, error: 'real_off' };
    if (!s.enabled) return { status: 400, error: 'game_off' };
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    if (amount < s.minBet) return { status: 400, error: 'below_min' };
    if (s.maxBet && amount > s.maxBet) return { status: 400, error: 'above_max' };
    const raw = Array.isArray(body.picks) ? body.picks : [], seen = new Set(), picks = [];
    for (const p of raw) {
      const ev = real.events[p && p.e], k = p && p.k ? String(p.k) : 'x', i = Number(p && p.i);
      if (!ev || ev.status !== 'open' || seen.has(ev.id) || !ev.o[k] || !Number.isInteger(i) || i < 0 || i >= ev.o[k].length) return { status: 400, error: 'bad_picks' };
      if (Date.now() > ev.t - CLOSE_MS) return { status: 400, error: 'closed' };
      seen.add(ev.id); picks.push({ e: ev.id, k, i, odd: ev.o[k][i], h: ev.h, a: ev.a, t: ev.t });   // the SERVER's odds, frozen now
    }
    if (!picks.length || picks.length > MAX_PICKS) return { status: 400, error: 'bad_picks' };
    if (real.bets.filter(b => b.number === acc.number && b.status === 'open').length >= MAX_REAL_OPEN) return { status: 400, error: 'too_many' };
    const w = walletOf(acc);
    if (!w) return { status: 400, error: 'no_wallet' };
    if (w.have < 1) return { status: 400, error: 'no_money' };
    if (w.have < amount) return { status: 400, error: 'insufficient' };
    const odds = Math.round(picks.reduce((x, p) => x * p.odd, 1) * 100) / 100;
    ledger(acc.number, w.jid, w.name).pending -= amount;
    store.stats.staked += amount; real.stats.staked += amount;
    real.bets.push({ id: crypto.randomBytes(6).toString('hex'), number: acc.number, jid: w.jid, name: w.name || acc.name, picks, amount, odds, status: 'open', win: null, at: Date.now() });
    touch(); flushSync();
    return { status: 200 };
  }
  function realView(acc) {
    const now = Date.now(), w = acc ? walletOf(acc) : null, s = store.settings;
    const evs = Object.values(real.events).filter(ev => ev.status === 'open' && ev.t > now - 3 * 3600000).sort((a, b) => a.t - b.t).slice(0, 150)
      .map(ev => ({ id: ev.id, lg: ev.lgName, h: ev.h, a: ev.a, t: ev.t, o: ev.o, closed: now > ev.t - CLOSE_MS }));
    const mine = acc ? real.bets.filter(b => b.number === acc.number).slice(-30).reverse()
      .map(b => ({ id: b.id, at: b.at, picks: b.picks.map((p, ix) => Object.assign({ k: p.k, i: p.i, odd: p.odd, h: p.h, a: p.a, t: p.t }, b.res ? b.res[ix] : legRes(p))), amount: b.amount, odds: b.odds, status: b.status, win: b.win })) : [];
    return { ok: true, now, on: !!ODDS_KEY && s.enabled, setup: !ODDS_KEY, limits: { min: s.minBet, max: s.maxBet }, events: evs, mine, balance: w ? w.have : null, updated: real.lastFetch, error: real.lastError || '', days: DAYS, diag: Object.entries(real.diag || {}).map(([k, v]) => ({ lg: LEAGUE_NAME[k] || TITLES[k] || k, n: v.n, err: v.err })) };
  }

  // ── what the browser sees ───────────────────────────────────
  // The page asks every second, so big things are only sent when they changed: the next round's odds (?nx=its id),
  // the current round's teams + goals (?cu=its id), and past tickets / results (?rs=last settled id).
  const csNames = CS.map(c => c.join('-')).concat('Other');
  function ticket(b, r) {
    const done = r.settled, st = r === nxt ? 'open' : done ? (b.win ? 'won' : 'lost') : 'live';
    return { id: b.id, round: r.id, kick: r.kick, amount: b.amount, odds: b.odds, win: done ? b.win : null, st, n: b.picks.length,
      legs: b.picks.map(p => { const f = r.fx[p.m]; return Object.assign({ h: f.h.n, a: f.a.n, k: p.k, i: p.i, odd: p.odd },
        done ? { res: wins(f, p.k, p.i) ? 'won' : 'lost', score: f.gh + '-' + f.ga } : { res: 'pend' }); }) };
  }
  function view(acc, q) {
    q = q || {};
    const s = store.settings, w = acc ? walletOf(acc) : null;
    const out = {
      ok: true, now: Date.now(), enabled: s.enabled, limits: { min: s.minBet, max: s.maxBet },
      timing: { every: EVERY, play: PLAY_MS, end: END_MS }, per: PER, leagues: LG.map(l => l[0]), cs: csNames,
      curId: cur.id, curKick: cur.kick, nextId: nxt.id, nextKick: nxt.kick, settledId,
      mine: acc ? [...cur.bets, ...nxt.bets].filter(b => b.number === acc.number).map(b => ticket(b, cur.bets.includes(b) ? cur : nxt)) : [],
      balance: w ? w.have : null
    };
    if (String(q.nx) !== String(nxt.id)) out.next = { id: nxt.id, kick: nxt.kick, fx: nxt.fx.map(f => ({ id: f.id, lg: f.lg, h: pub(f.h), a: pub(f.a), o: f.o })) };
    if (String(q.cu) !== String(cur.id)) out.cur = { id: cur.id, kick: cur.kick, fx: cur.fx.map(f => ({ id: f.id, lg: f.lg, h: pub(f.h), a: pub(f.a), goals: f.goals })) };
    if (String(q.rs) !== String(settledId)) { out.recent = acc ? (store.recent[acc.number] || []) : []; out.history = store.history; }
    return out;
  }

  // ── admin helpers (optional) ────────────────────────────────
  function setSettings(patch) {
    const clean = cleanSettings(Object.assign({}, store.settings, patch || {}));
    store.settings = clean; touch(); return { settings: clean };
  }
  const adminInfo = () => ({ settings: store.settings, round: { next: nxt.id, nextBets: nxt.bets.length, live: cur.id, liveBets: cur.bets.length }, real: { on: !!ODDS_KEY, events: Object.keys(real.events).length, openBets: real.bets.filter(b => b.status === 'open').length, lastFetch: real.lastFetch, lastError: real.lastError, credits: real.credits, extraMarkets: EXTRA_MKTS, leagues: AUTO ? 'auto' : LEAGUES, stats: real.stats }, stats: Object.assign({ houseNet: store.stats.staked - store.stats.paid }, store.stats) });

  // ── http entry point (server.js sends everything under /football/ here) ──
  async function handle(req, res, p) {
    const acc = getAcc(req);
    if (p === '/football/state' && req.method === 'GET') {
      if (hit('fbs', clientIp(req), 3000, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      return send(res, 200, view(acc, Object.fromEntries(new URL(req.url, 'http://x').searchParams)));
    }
    if (p === '/football/real/state' && req.method === 'GET') {
      if (hit('fbr', clientIp(req), 1200, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      return send(res, 200, realView(acc));
    }
    const isReal = p === '/football/real/bet';
    if (req.method !== 'POST' || (p !== '/football/bet' && !isReal)) return send(res, 404, { ok: false, error: 'not_found' });
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
    if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });
    if (hit('fbb', acc.number, 60, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    if (isReal) {
      const rr = placeReal(acc, await readBody(req));
      if (rr.status !== 200) return send(res, rr.status, { ok: false, error: rr.error });
      return send(res, 200, { ok: true, balance: (walletOf(acc) || {}).have });
    }
    const r = placeBet(acc, await readBody(req));
    if (r.status !== 200) return send(res, r.status, { ok: false, error: r.error });
    return send(res, 200, { ok: true, balance: (walletOf(acc) || {}).have });
  }

  return { handle, onAck, setSettings, adminInfo, hold: (number) => Math.max(0, -net(number)) };
};
