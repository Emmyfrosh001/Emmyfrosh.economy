'use strict';
// ================================================================
// Virtual football (TV) engine — zero dependencies, same wallet rules as the crash plane.
//   • One shared timetable for everybody: a new round kicks off every 3 minutes. The NEXT round is always open for
//     betting (3:00 countdown) while the CURRENT round is on TV: PLAY (90s = 90 match minutes) → FULL TIME (10s)
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

const EVERY = 180000, PLAY_MS = 90000, END_MS = 10000;   // a new round kicks off every EVERY ms (3 minutes). On TV: PLAY 90s (1 second = 1 match minute) → FULL TIME 10s → rest
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
// difficulty = how much the house keeps. v = virtual TV · r = real matches (taken off the real bookmaker prices)
const MODES = { easy: { label: 'Easy', v: 0.04, r: 0 }, normal: { label: 'Normal', v: 0.08, r: null }, hard: { label: 'Hard', v: 0.15, r: null } };   // r: null = filled in below from REAL_EDGE
const DEFAULTS = { enabled: true, virtual: true, real: true, live: true, mode: 'normal', minBet: 1, maxBet: 0 };   // enabled = master lock · maxBet 0 = no limit

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
  const mode = MODES[s.mode] ? s.mode : 'normal', on = (v, d) => v === undefined ? d : v !== false && v !== 0 && v !== '0';
  return { enabled: on(s.enabled, true), virtual: on(s.virtual, true), real: on(s.real, true), live: on(s.live, true), mode, edge: MODES[mode].v, minBet, maxBet };
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
  if (!store.logos || typeof store.logos !== 'object') store.logos = {};
  if (!store.logoMiss || typeof store.logoMiss !== 'object') store.logoMiss = {};
  store.settings = cleanSettings(store.settings);
  const real = store.real = Object.assign({ events: {}, bets: [], lastFetch: 0, lastError: '', credits: null, diag: {}, codes: {}, stats: { staked: 0, paid: 0 } }, store.real || {});
  if (!real.events || typeof real.events !== 'object') real.events = {};
  if (!real.codes || typeof real.codes !== 'object') real.codes = {};
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
  function vPicks(raw) {                                                       // → the server's picks for the NEXT round, or null when something is wrong
    raw = Array.isArray(raw) ? raw : [];
    const seen = new Set(), picks = [];
    for (const p of raw) {
      const m = Number(p && p.m), i = Number(p && p.i), k = p && p.k ? String(p.k) : 'x';
      const opts = OPTS[k] || 0;
      if (!opts || !Number.isInteger(m) || m < 0 || m >= MATCHES || !Number.isInteger(i) || i < 0 || i >= opts || seen.has(m)) return null;
      if (!nxt.fx[m].o[k][i]) return null;                                      // locked selection
      seen.add(m); picks.push({ m, k, i, odd: nxt.fx[m].o[k][i] });             // the SERVER's odds, frozen now; one pick per match so legs are never linked
    }
    return picks.length && picks.length <= MAX_PICKS ? picks : null;
  }
  function placeBet(acc, body) {
    const s = store.settings;
    if (!s.enabled || !s.virtual) return { status: 400, error: 'game_off' };
    if (Number(body.round) !== nxt.id) return { status: 400, error: 'stale' };
    if (Date.now() >= nxt.kick - 1000) return { status: 400, error: 'closed' };
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    if (amount < s.minBet) return { status: 400, error: 'below_min' };
    if (s.maxBet && amount > s.maxBet) return { status: 400, error: 'above_max' };
    const picks = vPicks(body.picks);
    if (!picks) return { status: 400, error: 'bad_picks' };
    if (nxt.bets.filter(b => b.number === acc.number).length >= MAX_BETS) return { status: 400, error: 'too_many' };
    const w = walletOf(acc);
    if (!w) return { status: 400, error: 'no_wallet' };
    if (w.have < 1) return { status: 400, error: 'no_money' };
    if (w.have < amount) return { status: 400, error: 'insufficient' };
    const odds = Math.round(picks.reduce((x, p) => x * p.odd, 1) * 100) / 100;
    ledger(acc.number, w.jid, w.name).pending -= amount;                                         // the stake leaves the wallet right now
    store.stats.staked += amount;
    const b = { id: crypto.randomBytes(6).toString('hex'), number: acc.number, jid: w.jid, name: w.name || acc.name, picks, amount, odds, win: null };
    b.code = saveVCode(nxt, picks, acc.number);
    store.inflight[b.id] = { number: acc.number, jid: w.jid, name: b.name, amount };
    nxt.bets.push(b); touch();
    return { status: 200, id: b.id };
  }
  // change a virtual ticket while its round is still open for betting (the round has not kicked off)
  function editBet(acc, body) {
    const s = store.settings;
    if (!s.enabled || !s.virtual) return { status: 400, error: 'game_off' };
    if (Number(body.round) !== nxt.id) return { status: 400, error: 'stale' };
    if (Date.now() >= nxt.kick - 1000) return { status: 400, error: 'closed' };
    const b = nxt.bets.find(x => x.id === String(body.id) && x.number === acc.number);
    if (!b) return { status: 404, error: 'no_ticket' };
    const amount = body.amount === undefined ? b.amount : Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    if (amount < s.minBet) return { status: 400, error: 'below_min' };
    if (s.maxBet && amount > s.maxBet) return { status: 400, error: 'above_max' };
    const picks = vPicks(body.picks);
    if (!picks) return { status: 400, error: 'bad_picks' };
    const diff = amount - b.amount;
    if (diff > 0) { const w = walletOf(acc); if (!w) return { status: 400, error: 'no_wallet' }; if (w.have < diff) return { status: 400, error: 'insufficient' }; }
    if (diff) { ledger(acc.number, b.jid, b.name).pending -= diff; store.stats.staked += diff; }
    b.picks = picks; b.amount = amount; b.odds = Math.round(picks.reduce((x, p) => x * p.odd, 1) * 100) / 100;
    if (store.inflight[b.id]) store.inflight[b.id].amount = amount;
    b.code = saveVCode(nxt, picks, acc.number);
    touch(); return { status: 200, id: b.id };
  }

  // ── virtual booking codes: share the picks of the OPEN round. A code works until that round kicks off (then it shows as expired).
  //    7 letters / numbers (real-match codes have 6, so the two never mix up).
  const vcodes = {};
  function saveVCode(r, picks, number) {
    let code; do { code = Array.from({ length: 7 }, () => CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)]).join(''); } while (vcodes[code]);
    vcodes[code] = { round: r.id, kick: r.kick, by: number, at: Date.now(), picks: picks.map(p => { const f = r.fx[p.m]; return { m: p.m, k: p.k, i: p.i, h: f.h.n, a: f.a.n, lg: LG[f.lg][0] }; }) };
    const keys = Object.keys(vcodes); if (keys.length > 3000) keys.forEach(k => { if (vcodes[k].round < r.id - 3) delete vcodes[k]; });
    return code;
  }
  function makeVCode(acc, body) {
    if (!store.settings.enabled || !store.settings.virtual) return { status: 400, error: 'game_off' };
    if (Number(body.round) !== nxt.id) return { status: 400, error: 'stale' };
    const picks = vPicks(body.picks); if (!picks) return { status: 400, error: 'bad_picks' };
    return { status: 200, code: saveVCode(nxt, picks, acc.number) };
  }
  function vCodeView(code) {
    code = String(code).toUpperCase(); const c = vcodes[code]; if (!c) return null;
    const now = Date.now(), live = c.round === nxt.id, status = live ? (now < nxt.kick - 1000 ? 'open' : 'closed') : 'expired';
    return { ok: true, virtual: true, now, code, round: c.round, nextId: nxt.id, status, kick: c.kick,
      legs: c.picks.map(p => ({ m: p.m, k: p.k, i: p.i, h: p.h, a: p.a, lg: p.lg, odd: live ? (nxt.fx[p.m].o[p.k] || [])[p.i] || null : null })) };
  }


  // ═══════════════ REAL football (real fixtures, real odds, real results) ═══════════════
  // Data: The Odds API (https://the-odds-api.com). Needs env ODDS_API_KEY. Without it this part stays switched off.
  // REAL_SOURCE = "free" (default): every match comes from ESPN's free public scoreboard (no key, no credit limit) and the server CALCULATES the odds.
  //               "odds": the old way, real bookmaker odds from The Odds API (needs a valid ODDS_API_KEY, 500 free credits a month).
  const FREE = String(process.env.REAL_SOURCE || 'free').trim().toLowerCase() !== 'odds';
  const ODDS_KEY = FREE ? '' : String(process.env.ODDS_API_KEY || '').trim();
  const REAL_ON = FREE || !!ODDS_KEY;
  // REAL_LEAGUES = "auto" (default): every soccer league that is in season right now (free lookup), the big ones first, at most REAL_AUTO_MAX of them.
  // Or give a fixed list, e.g. REAL_LEAGUES=soccer_epl,soccer_spain_la_liga
  const LEAGUES_RAW = String(process.env.REAL_LEAGUES || 'auto').trim();
  const AUTO = /^auto$/i.test(LEAGUES_RAW);
  const LEAGUES = AUTO ? [] : LEAGUES_RAW.split(',').map(x => x.trim()).filter(Boolean);
  const AUTO_MAX = Math.max(1, Number(process.env.REAL_AUTO_MAX) || 25);                         // leagues fetched (every league in season, big ones first)
  const LIVE_MS = Math.max(60, Number(process.env.REAL_LIVE_SEC) || 90) * 1000;                  // live-score check while games are in play (1-2 credits per league with a game on)
  const EMPTY_SKIP_MS = 6 * 3600000;                                                              // a league with no games in the next DAYS is not asked again for 6h (saves credits)
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
  const R_EDGE = { easy: 0, normal: REAL_EDGE, hard: Math.min(0.3, REAL_EDGE + 0.05) };
  MODES.normal.r = R_EDGE.normal; MODES.hard.r = R_EDGE.hard; MODES.easy.r = R_EDGE.easy;
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
        const prev = real.diag && real.diag[lg];
        if (prev && prev.n === 0 && !prev.err && Date.now() - (prev.at || 0) < EMPTY_SKIP_MS) { diag[lg] = prev; continue; }
        try {
          const list = await getJson(API + encodeURIComponent(lg) + '/odds/?apiKey=' + encodeURIComponent(ODDS_KEY) + '&regions=' + REGIONS + '&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso&commenceTimeTo=' + to);
          diag[lg] = { n: Array.isArray(list) ? list.length : 0, err: '', at: Date.now() };
          for (const e of Array.isArray(list) ? list : []) {
            const t = Date.parse(e.commence_time), o = parseOdds(e); if (!o.x || !Number.isFinite(t)) continue;
            const old = real.events[e.id];
            if (old && old.status !== 'open') continue;
            if (old && old.t <= Date.now()) continue;                       // kicked off: the odds stay frozen
            real.events[e.id] = compose({ id: e.id, lg, lgName: LEAGUE_NAME[lg] || TITLES[lg] || lg, h: e.home_team, a: e.away_team, t, base: o, ex: old ? old.ex : {}, exAt: old ? old.exAt : 0, status: 'open', gh: null, ga: null });
          }
        } catch (x) { err = String(x.message || x).slice(0, 120); diag[lg] = { n: 0, err, at: Date.now() }; }
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
    if (ev.status !== 'done') return Date.now() >= ev.t ? { res: 'pend', live: ev.live ? ev.live.gh + '-' + ev.live.ga : null, ck: clockOf(ev) } : { res: 'pend' };
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
  // ═══════ LIVE games: clock, live prices, betting while a game is being played ═══════
  // A live game can be bet on only while its score AND its prices are fresh, and never straight after a goal until new prices arrive
  // (otherwise someone watching TV could bet at the old price). The owner can switch live betting off in the admin page.
  const LIVE_FRESH_MS = 2 * LIVE_MS + 20000;
  const FINISHED = new Set(['FT', 'AET', 'PEN']);
  function setLive(ev, gh, ga, min, st, src) {
    const now = Date.now(), o = ev.live;
    if ((!o && gh + ga > 0) || (o && (o.gh !== gh || o.ga !== ga))) ev.scAt = now;          // a goal: bets stay paused until prices from AFTER it arrive
    ev.live = { gh, ga, at: now, min: Number.isFinite(min) ? min : null, st: st || null, src };
    touch();
  }
  // → null (not started) or { ph: '1H' | 'HT' | '2H' | 'ET' | 'FT', min, plus, left, est }   est = worked out from kick-off, not from a data feed
  function clockOf(ev, now) {
    now = now || Date.now();
    const l = ev.live, feed = l && l.st && now - l.at < 6 * 60000;
    if (now < ev.t && !feed) return null;
    let ph, min, est = !feed;
    if (feed) {
      ph = FINISHED.has(l.st) ? 'FT' : ['BT', 'P'].includes(l.st) ? 'ET' : l.st; min = Number.isFinite(l.min) ? l.min : (ph === '2H' ? 46 : 1);
      if (ph === '1H' || ph === '2H') min += Math.floor((now - l.at) / 60000);              // keeps ticking between two polls
      if (ph === 'HT') min = 45;
    } else {
      const e = (now - ev.t) / 60000;
      if (e < 45) { ph = '1H'; min = Math.floor(e) + 1; } else if (e < 60) { ph = 'HT'; min = 45; } else { ph = '2H'; min = 45 + Math.floor(e - 60) + 1; }
    }
    const cap = ph === '1H' ? 45 : ph === '2H' ? 90 : 0, plus = cap && min > cap ? min - cap : 0;
    if (cap) min = Math.min(min, cap);
    return { ph, min, plus, est, left: ph === '1H' || ph === '2H' ? Math.max(0, 90 - min) : ph === 'HT' ? 45 : 0 };
  }
  // can this game take a bet right now?  → { ok, why }
  function canBet(ev, now) {
    now = now || Date.now();
    if (!ev || ev.status !== 'open') return { ok: false, why: 'closed' };
    if (now <= ev.t - CLOSE_MS) return { ok: true };
    if (now < ev.t) return { ok: false, why: 'closed' };                                      // the last minute before kick-off
    if (ev.free) return { ok: false, why: 'closed' };                                         // calculated odds never move, so no betting once the game has started
    if (!store.settings.live) return { ok: false, why: 'live_off' };
    const l = ev.live, c = clockOf(ev, now);
    if (c && (c.ph === 'FT' || c.ph === 'ET' || (c.ph === '2H' && c.min >= 85))) return { ok: false, why: 'closed' };
    if (!l || now - l.at > LIVE_FRESH_MS || !ev.oddsAt || now - ev.oddsAt > LIVE_FRESH_MS || ev.oddsAt < (ev.scAt || 0)) return { ok: false, why: 'live_wait' };
    return { ok: true };
  }
  const isStarted = (ev, now) => (now || Date.now()) >= ev.t;
  // the prices players see: the real prices, moved by the difficulty (easy / normal / hard). On a live game, lines that are already decided are removed.
  function oddsFor(ev) {
    const f = (1 - R_EDGE[store.settings.mode]) / (1 - REAL_EDGE), live = isStarted(ev), l = live && ev.live ? ev.live : { gh: 0, ga: 0 }, out = {};
    for (const [k, arr] of Object.entries(ev.o || {})) {
      if (live && /^[oha]\d+$/.test(k)) { const g = k[0] === 'o' ? l.gh + l.ga : k[0] === 'h' ? l.gh : l.ga; if (g > ouLine(k)) continue; }
      out[k] = arr.map(v => v == null ? null : Math.min(100, Math.max(1.01, Math.round(v * f * 100) / 100)));
    }
    return out;
  }
  let liveBusy = false;
  async function refreshLiveOdds() {                                                          // fresh prices for the games being played right now
    if (!ODDS_KEY || liveBusy || !store.settings.live) return; liveBusy = true;
    try {
      const now = Date.now(), lgs = [...new Set(Object.values(real.events).filter(ev => ev.status === 'open' && now >= ev.t && now < ev.t + 130 * 60000).map(ev => ev.lg))];
      if (!lgs.length || creditsLow(MIN_CREDITS)) return;
      for (const lg of lgs) {
        try {
          const list = await getJson(API + encodeURIComponent(lg) + '/odds/?apiKey=' + encodeURIComponent(ODDS_KEY) + '&regions=' + REGIONS + '&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso');
          for (const e of Array.isArray(list) ? list : []) {
            const ev = real.events[e.id]; if (!ev || ev.status !== 'open' || Date.now() < ev.t) continue;
            const o = parseOdds(e); if (!o.x) continue;
            ev.base = o; ev.ex = {}; compose(ev); ev.oddsAt = Date.now(); touch();
          }
        } catch (x) { real.lastError = String(x.message || x).slice(0, 120); }
      }
    } finally { liveBusy = false; }
  }

  // ── optional 2nd API: API-Football (api-sports.io) → exact match minute, quicker live scores, H2H and live statistics. Key: FOOTBALL_API_KEY
  const AF_KEY = String(process.env.FOOTBALL_API_KEY || process.env.API_FOOTBALL_KEY || '').trim();
  const AF = 'https://v3.football.api-sports.io', AF_LIVE_MS = Math.max(30, Number(process.env.FOOTBALL_LIVE_SEC) || 60) * 1000;
  const afInfo = { left: null, at: 0, error: '' };
  async function afGet(p) {
    const r = await fetch(AF + p, { headers: { 'x-apisports-key': AF_KEY }, signal: AbortSignal.timeout(15000) });
    const left = r.headers.get('x-ratelimit-requests-remaining'); if (left !== null && left !== '' && Number.isFinite(Number(left))) { afInfo.left = Number(left); afInfo.at = Date.now(); }
    if (!r.ok) throw new Error('football api ' + r.status);
    const j = await r.json(), er = j && j.errors;
    if (er && (Array.isArray(er) ? er.length : Object.keys(er).length)) throw new Error('football api: ' + JSON.stringify(er).slice(0, 100));
    return Array.isArray(j.response) ? j.response : [];
  }
  const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ss', 'ssc', 'fk', 'sk', 'bk', 'club', 'de', 'cd', 'ud', 'the', 'calcio']);
  const toks = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(x => x && !STOP.has(x));
  function sameTeam(a, b) {
    const x = toks(a), y = toks(b); if (!x.length || !y.length) return false;
    const sx = x.join(' '), sy = y.join(' '); if (sx === sy) return true;
    if (sx.length >= 4 && sy.length >= 4 && (sx.includes(sy) || sy.includes(sx))) return true;
    const n = x.filter(t => y.includes(t)).length; return n >= 1 && n / Math.max(x.length, y.length) >= 0.5;
  }
  const fxMatches = (ev, f) => f && f.teams && f.fixture && sameTeam(ev.h, f.teams.home.name) && sameTeam(ev.a, f.teams.away.name) && Math.abs(Date.parse(f.fixture.date) - ev.t) < 3 * 3600000;
  const afLink = (ev, f) => { ev.afId = f.fixture.id; ev.afH = f.teams.home.id; ev.afA = f.teams.away.id; if (f.teams.home.logo && !store.logos[ev.h]) store.logos[ev.h] = f.teams.home.logo; if (f.teams.away.logo && !store.logos[ev.a]) store.logos[ev.a] = f.teams.away.logo; };
  let afBusy = false;
  async function afLive() {                                                                    // ONE call gives every live game in the world
    if (!AF_KEY || afBusy) return;
    const now = Date.now(), evs = Object.values(real.events).filter(ev => ev.status === 'open' && now >= ev.t - 5 * 60000 && now < ev.t + 150 * 60000);
    if (!evs.length) return; afBusy = true;
    try {
      for (const f of await afGet('/fixtures?live=all')) {
        const ev = evs.find(e => e.afId === f.fixture.id) || evs.find(e => fxMatches(e, f)); if (!ev) continue;
        afLink(ev, f);
        const gh = f.goals && f.goals.home, ga = f.goals && f.goals.away, st = f.fixture.status || {};
        if (Number.isInteger(gh) && Number.isInteger(ga)) setLive(ev, gh, ga, st.elapsed, st.short, 'af');
      }
      afInfo.error = '';
    } catch (x) { afInfo.error = String(x.message || x).slice(0, 120); }
    finally { afBusy = false; }
  }
  const afDay = {}, h2hCache = new Map(), statCache = new Map();
  async function afFindId(ev) {
    if (ev.afId) return true;
    const d = new Date(ev.t).toISOString().slice(0, 10); let c = afDay[d];
    if (!c || Date.now() - c.at > 3600000) c = afDay[d] = { at: Date.now(), list: await afGet('/fixtures?date=' + d) };
    const f = c.list.find(x => fxMatches(ev, x)); if (!f) return false;
    afLink(ev, f); touch(); return true;
  }
  const STAT_ROWS = [['Ball Possession', 'Possession'], ['Total Shots', 'Shots'], ['Shots on Goal', 'Shots on target'], ['Corner Kicks', 'Corners'], ['Fouls', 'Fouls'],
    ['Yellow Cards', 'Yellow cards'], ['Red Cards', 'Red cards'], ['Goalkeeper Saves', 'Saves'], ['Offsides', 'Offsides']];
  async function infoView(ev) {                                                                // what the (i) / chart icon on a match shows
    const now = Date.now(), l = ev.live, out = { ok: true, id: ev.id, lg: ev.lgName, h: ev.h, a: ev.a, t: ev.t, api: !!AF_KEY,
      sc: ev.status === 'done' ? [ev.gh, ev.ga] : l && now >= ev.t ? [l.gh, l.ga] : null, fin: ev.status === 'done', ck: clockOf(ev, now), h2h: null, stats: null };
    if (!AF_KEY) return out;
    try {
      if (!(await afFindId(ev))) return out;
      const key = ev.afH + '-' + ev.afA; let h = h2hCache.get(key);
      if (!h || now - h.at > 12 * 3600000) {
        const list = await afGet('/fixtures/headtohead?h2h=' + key + '&last=8');
        h = { at: now, rows: list.filter(f => f.fixture.id !== ev.afId && f.goals && Number.isInteger(f.goals.home) && Number.isInteger(f.goals.away))
          .map(f => ({ d: f.fixture.date, lg: f.league && f.league.name, h: f.teams.home.name, a: f.teams.away.name, hid: f.teams.home.id, gh: f.goals.home, ga: f.goals.away })).slice(0, 8) }; h2hCache.set(key, h);
      }
      let hw = 0, aw = 0, dr = 0;
      h.rows.forEach(r => { const mine = r.hid === ev.afH ? r.gh - r.ga : r.ga - r.gh; if (mine > 0) hw++; else if (mine < 0) aw++; else dr++; });
      out.h2h = { rows: h.rows.map(r => ({ d: r.d, lg: r.lg, h: r.h, a: r.a, gh: r.gh, ga: r.ga })), sum: [hw, dr, aw] };
      if (now >= ev.t) {
        let st = statCache.get(ev.afId);
        if (!st || now - st.at > 30000) {
          const res = await afGet('/fixtures/statistics?fixture=' + ev.afId), hs = res.find(x => x.team && x.team.id === ev.afH) || res[0], as = res.find(x => x.team && x.team.id === ev.afA) || res[1];
          const val = (t, k) => { const r = t && (t.statistics || []).find(x => x.type === k); return r ? (r.value === null ? 0 : r.value) : null; };
          st = { at: now, rows: hs && as ? STAT_ROWS.map(([k, label]) => ({ k: label, h: val(hs, k), a: val(as, k) })).filter(r => r.h !== null || r.a !== null) : [] }; statCache.set(ev.afId, st);
        }
        out.stats = st.rows;
      }
    } catch (x) { out.error = 'Data is not available right now.'; afInfo.error = String(x.message || x).slice(0, 120); }
    return out;
  }

  let scoring = false;
  // Live scores + final scores. Only leagues that have a game in play (or just finished) are asked, so nothing is spent on quiet leagues.
  //   plain call = 1 credit (live + coming games) · with daysFrom = 2 credits (also finished games, used once a game could be over)
  async function pollScores() {
    if (scoring) return; scoring = true;
    try {
      const now = Date.now(), used = new Set(real.bets.filter(b => b.status === 'open').flatMap(b => b.picks.map(p => p.e)));
      for (const ev of Object.values(real.events)) if (ev.status === 'open' && used.has(ev.id) && now > ev.t + VOID_MS) { ev.status = 'void'; touch(); }   // never finished: stakes come back
      const started = Object.values(real.events).filter(ev => ev.status === 'open' && now >= ev.t && now < ev.t + VOID_MS);
      const byLg = new Map();
      for (const ev of started) { if (!byLg.has(ev.lg)) byLg.set(ev.lg, []); byLg.get(ev.lg).push(ev); }
      if (ODDS_KEY && !creditsLow(2)) for (const [lg, evs] of byLg) {
        try {
          const couldBeOver = evs.some(ev => now > ev.t + 95 * 60000);
          const list = await getJson(API + encodeURIComponent(lg) + '/scores/?apiKey=' + encodeURIComponent(ODDS_KEY) + (couldBeOver ? '&daysFrom=2' : '') + '&dateFormat=iso');
          for (const r of Array.isArray(list) ? list : []) {
            const ev = real.events[r.id]; if (!ev || ev.status !== 'open' || !Array.isArray(r.scores)) continue;
            const g = (n) => { const x = r.scores.find(z => z.name === n); return x ? parseInt(x.score, 10) : NaN; };
            const gh = g(ev.h), ga = g(ev.a);
            if (!Number.isInteger(gh) || !Number.isInteger(ga)) continue;
            if (r.completed) { ev.gh = gh; ev.ga = ga; ev.status = 'done'; ev.live = null; touch(); }
            else if (now >= ev.t && !(ev.live && ev.live.src === 'af' && now - ev.live.at < 2.5 * AF_LIVE_MS)) setLive(ev, gh, ga, null, null, 'odds');     // score of a game being played now
          }
        } catch (x) { real.lastError = String(x.message || x).slice(0, 120); }
      }
      settleBets();
      const cut = now - 14 * 86400000, live = new Set(real.bets.filter(b => b.status === 'open').flatMap(b => b.picks.map(p => p.e)));
      for (const [id, ev] of Object.entries(real.events)) if (!live.has(id) && ev.t < now - 86400000) { delete real.events[id]; touch(); }
      if (real.bets.length > 3000 || real.bets.some(b => b.status !== 'open' && b.done < cut)) { real.bets = real.bets.filter(b => b.status === 'open' || b.done >= cut).slice(-3000); touch(); }
    } finally { scoring = false; }
  }
  // ═══════ FREE feed (default): every match, live score and final result from ESPN's public scoreboard. No key, no credit limit. ═══════
  // No free feed carries bookmaker prices, so the SERVER works the odds out from team strength with the same model as the TV matches
  // (known clubs use their rating, others use their league record). Odds are made once per match and then stay fixed. Betting closes at kick-off.
  // FREE_LEAGUES=eng.1,esp.1,... picks leagues · FREE_REFRESH_MIN (30) how often the fixture list is refreshed · FREE_LIVE_SEC (60) live score check
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
  const ESPN_LG = { 'eng.1': 'Premier League', 'uefa.champions': 'Champions League', 'esp.1': 'La Liga', 'ita.1': 'Serie A', 'ger.1': 'Bundesliga', 'fra.1': 'Ligue 1',
    'uefa.europa': 'Europa League', 'uefa.europa.conf': 'Conference League', 'eng.2': 'Championship', 'eng.3': 'League One', 'eng.fa': 'FA Cup', 'eng.league_cup': 'League Cup',
    'ned.1': 'Eredivisie', 'por.1': 'Primeira Liga', 'sco.1': 'Scottish Premiership', 'bel.1': 'Belgian Pro League', 'tur.1': 'Super Lig', 'gre.1': 'Greek Super League',
    'esp.2': 'La Liga 2', 'ita.2': 'Serie B', 'ger.2': '2. Bundesliga', 'fra.2': 'Ligue 2', 'esp.copa_del_rey': 'Copa del Rey', 'ita.coppa_italia': 'Coppa Italia', 'ger.dfb_pokal': 'DFB Pokal',
    'uefa.nations': 'UEFA Nations League', 'fifa.friendly': 'International Friendly', 'fifa.world': 'World Cup', 'fifa.worldq.uefa': 'World Cup Qualifiers (Europe)',
    'fifa.worldq.caf': 'World Cup Qualifiers (Africa)', 'fifa.worldq.conmebol': 'World Cup Qualifiers (S. America)', 'uefa.euroq': 'Euro Qualifiers', 'caf.nations': 'AFCON',
    'caf.champions': 'CAF Champions League', 'arg.1': 'Primera Division - Argentina', 'bra.1': 'Brasileirao', 'usa.1': 'MLS', 'mex.1': 'Liga MX', 'jpn.1': 'J1 League', 'aus.1': 'A-League',
    'sau.1': 'Saudi Pro League', 'rsa.1': 'South African Premier Division' };
  Object.assign(LEAGUE_NAME, ESPN_LG);
  const FREE_LEAGUES = String(process.env.FREE_LEAGUES || '').split(',').map(x => x.trim()).filter(x => /^[a-z0-9_.]+$/i.test(x)), FREE_LG = FREE_LEAGUES.length ? FREE_LEAGUES : Object.keys(ESPN_LG);
  const FREE_REFRESH = Math.max(5, Number(process.env.FREE_REFRESH_MIN) || 30) * 60000, FREE_LIVE_MS = Math.max(30, Number(process.env.FREE_LIVE_SEC) || 60) * 1000;
  const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
  async function espnRaw(slug, from, to) {                                                  // → { status, events }  (from/to omitted = ESPN's own "current / next matchday")
    const r = await fetch(ESPN + encodeURIComponent(slug) + '/scoreboard' + (from ? '?limit=300&dates=' + ymd(from) + '-' + ymd(to) : ''), { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    if (r.status === 404 || r.status === 400) return { status: r.status, events: [] };
    if (!r.ok) throw new Error('espn ' + r.status);
    const j = await r.json().catch(() => ({}));
    return { status: 200, events: Array.isArray(j.events) ? j.events : [] };
  }
  async function espnGet(slug, from, to) {                                                  // dated range first; if that is empty, ESPN's default scoreboard (its current / next matchday)
    const a = await espnRaw(slug, from, to);
    if (a.events.length || a.status !== 200) return a;
    return espnRaw(slug).catch(() => a);
  }
  // strength of a team (1.0 weak .. ~1.95 elite): the club ratings above when the name matches, else the league record (W-D-L), else average
  const KNOWN_T = LG.flatMap(([, ts]) => ts);
  function knownStrength(name) {
    const nt = toks(name); if (!nt.length) return null;
    const ns = nt.join(' '); let best = null, bp = 0;
    for (const t of KNOWN_T) for (const c of [t.n, ALIAS[t.n]]) {
      if (!c) continue; const ct = toks(c); if (!ct.length) continue;
      const p = ct.join(' ') === ns ? 1e3 : ct.every(x => nt.includes(x)) && nt.length <= ct.length + 2 ? ct.length : 0;
      if (p > bp) { bp = p; best = t; }
    }
    return best ? best.s : null;
  }
  function strengthOf(name, comp) {
    const k = knownStrength(name); if (k) return k;
    const rec = ((comp && comp.records) || []).map(r => /^(\d+)-(\d+)-(\d+)/.exec(String(r && r.summary || ''))).find(Boolean);
    if (rec) {
      const w = +rec[1], d = +rec[2], l = +rec[3], n = w + d + l;
      if (n >= 3) { const ppg = (3 * w + d) / n, s = 0.95 + 0.33 * ppg, wt = n / (n + 6); return Math.max(1, Math.min(1.9, wt * s + (1 - wt) * 1.2)); }
    }
    return 1.2;
  }
  function freeOdds(h, a, hc, ac) {
    const f = fixture({ s: strengthOf(h, hc) }, { s: strengthOf(a, ac) }, 0, REAL_EDGE, 0), o = {};
    for (const [k, arr] of Object.entries(f.o)) { if (k === 'cs' || k === 'u1' || k === 'u2') continue; if (arr.some(v => v != null)) o[k] = arr; }   // the markets a real match can settle
    return o;
  }
  const STATE = (nm, period) => /FIRST_HALF/.test(nm) ? '1H' : /HALFTIME|HALF_TIME/.test(nm) ? 'HT' : /SECOND_HALF/.test(nm) ? '2H' : /EXTRA|OVERTIME|SHOOTOUT|PENALT/.test(nm) ? 'ET' : period === 1 ? '1H' : period === 2 ? '2H' : null;
  function applyFree(slug, e) {                                                             // → 1 when a new open match was seen
    const c = e && e.competitions && e.competitions[0], cs = c && Array.isArray(c.competitors) ? c.competitors : [];
    const H = cs.find(x => x.homeAway === 'home'), A = cs.find(x => x.homeAway === 'away'); if (!H || !A || !e.id) return 0;
    const hn = H.team && (H.team.displayName || H.team.name), an = A.team && (A.team.displayName || A.team.name), t = Date.parse(e.date || c.date);
    if (!hn || !an || !Number.isFinite(t)) return 0;
    const sx = (e.status && e.status.type) || (c.status && c.status.type) || {}, nm = String(sx.name || ''), state = sx.state, id = 'e' + e.id;
    if (H.team.logo && !store.logos[hn]) store.logos[hn] = H.team.logo; if (A.team.logo && !store.logos[an]) store.logos[an] = A.team.logo;
    let ev = real.events[id];
    if (/POSTPONED|CANCEL|ABANDON/i.test(nm)) { if (ev && ev.status === 'open') { ev.status = 'void'; touch(); } return 0; }
    if (state === 'pre') {
      if (ev) { if (ev.status === 'open' && ev.t > Date.now() && ev.t !== t) { ev.t = t; touch(); } return 0; }          // moved to another time: keep the same match
      if (t <= Date.now()) return 0;
      const o = freeOdds(hn, an, H, A); if (!o.x) return 0;
      ev = real.events[id] = { id, lg: slug, lgName: ESPN_LG[slug] || slug, h: hn, a: an, t, base: o, ex: {}, exAt: 0, status: 'open', gh: null, ga: null, free: true };
      compose(ev); touch(); return 1;
    }
    if (!ev || ev.status !== 'open') return 0;                                              // a game we never listed (no odds) is ignored
    const gh = parseInt(H.score, 10), ga = parseInt(A.score, 10); if (!Number.isInteger(gh) || !Number.isInteger(ga)) return 0;
    if (state === 'in') {
      const st = STATE(nm, e.status && e.status.period), mn = parseInt(String((e.status && e.status.displayClock) || '').replace(/[^0-9+].*$/, ''), 10);
      setLive(ev, gh, ga, st === 'HT' ? 45 : mn, st, 'free'); return 0;
    }
    if (state === 'post') {
      if (/AET|PEN|EXTRA|SHOOT/i.test(nm)) { ev.status = 'void'; ev.live = null; touch(); return 0; }          // score includes extra time / shootout: stakes come back
      ev.gh = gh; ev.ga = ga; ev.status = 'done'; ev.live = null; touch();
    }
    return 0;
  }
  let freeBusy = false;
  async function pollFree(full) {                                                           // full = fixtures for every league · else only leagues with a game being played / just finished
    if (!FREE || freeBusy) return; freeBusy = true;
    try {
      const now = Date.now(), diag = {}; let errs = [], fresh = 0;
      const act = new Set(Object.values(real.events).filter(ev => ev.free && ev.status === 'open' && now >= ev.t - 5 * 60000 && now < ev.t + VOID_MS).map(ev => ev.lg));
      const lgs = full ? FREE_LG : FREE_LG.filter(x => act.has(x)); if (!lgs.length && !full) { settleBets(); return; }
      const from = now - 2 * 86400000, to = now + DAYS * 86400000;
      for (let i = 0; i < lgs.length; i += 6) await Promise.all(lgs.slice(i, i + 6).map(async (lg) => {
        try {
          const got = await espnGet(lg, from, to); let n = 0;
          for (const e of got.events) { try { fresh += applyFree(lg, e); if (e && e.status && e.status.type && e.status.type.state === 'pre') n++; } catch (x) { } }
          if (full) diag[lg] = { n, err: got.status !== 200 ? 'ESPN does not know the league code "' + lg + '"' : '', raw: got.events.length, at: now };
        } catch (x) { const m = String(x.message || x).slice(0, 100); errs.push(m); if (full) diag[lg] = { n: 0, err: m, at: now }; }
      }));
      if (full) { real.diag = diag; real.lastFetch = now; real.lastError = errs.length === lgs.length && errs.length ? 'match feed: ' + errs[0] : ''; }
      touch();
    } finally { freeBusy = false; }
    pollScores();                                                                           // settle tickets, void games that never finished, clean old games
  }
  if (FREE) {
    setTimeout(() => pollFree(true), 3000).unref();
    setInterval(() => { if (Date.now() - real.lastFetch >= FREE_REFRESH) pollFree(true); }, 60000).unref();
    setInterval(() => pollFree(false), FREE_LIVE_MS).unref();
  }
  if (ODDS_KEY) {
    setTimeout(refreshReal, 3000).unref();
    setInterval(() => { if (Date.now() - real.lastFetch >= REFRESH_MS) refreshReal(); }, 60000).unref();
    setInterval(refreshExtras, 20 * 60000).unref();                                  // matches that come within range later get their extra markets too
    setInterval(() => { pollScores(); refreshLiveOdds(); }, LIVE_MS).unref();
    setTimeout(() => { pollScores(); refreshLiveOdds(); }, 15000).unref();
  }
  if (AF_KEY) { setInterval(afLive, AF_LIVE_MS).unref(); setTimeout(afLive, 8000).unref(); }

  // ── booking codes (defined first: a code is also made for every real bet you place) ──
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_KEEP_MS = 14 * 86400000, MAX_CODES = 5000;
  function saveCode(picks, number) {                                           // picks: [{ e, k, i }]  → 6-letter code
    const list = [];
    for (const p of picks) { const ev = real.events[p.e]; if (ev) list.push({ e: ev.id, k: p.k, i: p.i, h: ev.h, a: ev.a, t: ev.t, lg: ev.lgName }); }
    if (!list.length) return null;
    let code; do { code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)]).join(''); } while (real.codes[code]);
    real.codes[code] = { picks: list, at: Date.now(), by: number };
    const keys = Object.keys(real.codes);
    if (keys.length > MAX_CODES) {                                            // keep the newest MAX_CODES (and nothing older than 14 days)
      const cut = Date.now() - CODE_KEEP_MS, byAge = keys.sort((x, y) => real.codes[y].at - real.codes[x].at);
      byAge.forEach((k, ix) => { if (ix >= MAX_CODES || real.codes[k].at < cut) delete real.codes[k]; });
    }
    return code;
  }

  function placeReal(acc, body) {
    const s = store.settings;
    if (!REAL_ON) return { status: 400, error: 'real_off' };
    if (!s.enabled || !s.real) return { status: 400, error: 'game_off' };
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    if (amount < s.minBet) return { status: 400, error: 'below_min' };
    if (s.maxBet && amount > s.maxBet) return { status: 400, error: 'above_max' };
    const raw = Array.isArray(body.picks) ? body.picks : [], seen = new Set(), picks = [];
    for (const p of raw) {
      const ev = real.events[p && p.e], k = p && p.k ? String(p.k) : 'x', i = Number(p && p.i), od = ev && ev.status === 'open' ? oddsFor(ev) : {};
      if (!ev || ev.status !== 'open' || seen.has(ev.id)) return { status: 400, error: 'bad_picks' };
      const cb = canBet(ev); if (!cb.ok) return { status: 400, error: cb.why };                     // started games: only when live betting is on and the prices are fresh
      if (!od[k] || !Number.isInteger(i) || i < 0 || i >= od[k].length || od[k][i] == null) return { status: 400, error: 'bad_picks' };
      seen.add(ev.id); picks.push({ e: ev.id, k, i, odd: od[k][i], h: ev.h, a: ev.a, t: ev.t });   // the SERVER's odds, frozen now
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
    const id = crypto.randomBytes(6).toString('hex'), code = saveCode(picks, acc.number);
    real.bets.push({ id, number: acc.number, jid: w.jid, name: w.name || acc.name, picks, amount, odds, status: 'open', win: null, at: Date.now(), code });
    touch(); flushSync();
    return { status: 200, id, code };
  }

  // ── edit a real ticket. A game that has not started can be changed, removed, or a new game added.
  //    A game that has started (or is closing) is LOCKED: it stays on the ticket with its old odds. The stake can change too.
  const realLocked = (ev, t) => !ev || ev.status !== 'open' || Date.now() > (ev.t || t) - CLOSE_MS;
  function editReal(acc, body) {
    const s = store.settings;
    if (!REAL_ON) return { status: 400, error: 'real_off' };
    if (!s.enabled || !s.real) return { status: 400, error: 'game_off' };
    const b = real.bets.find(x => x.id === String(body.id) && x.number === acc.number);
    if (!b) return { status: 404, error: 'no_ticket' };
    if (b.status !== 'open') return { status: 400, error: 'not_editable' };
    const orig = new Map(b.picks.map(p => [p.e, p]));
    const raw = Array.isArray(body.picks) ? body.picks : [], seen = new Set(), picks = [];
    for (const p of raw) {
      const id = p && p.e, k = p && p.k ? String(p.k) : 'x', i = Number(p && p.i), o = orig.get(id), ev = real.events[id];
      if (seen.has(id)) return { status: 400, error: 'bad_picks' };
      if (o && o.k === k && o.i === i) { seen.add(id); picks.push(o); continue; }                    // unchanged leg keeps its old odds
      if (o && realLocked(ev, o.t)) return { status: 400, error: 'locked_leg' };                      // a started game cannot be changed
      if (!ev || ev.status !== 'open') return { status: 400, error: 'bad_picks' };
      const cb = canBet(ev); if (!cb.ok) return { status: 400, error: cb.why };
      const od = oddsFor(ev); if (!od[k] || !Number.isInteger(i) || i < 0 || i >= od[k].length || od[k][i] == null) return { status: 400, error: 'bad_picks' };
      seen.add(id); picks.push({ e: ev.id, k, i, odd: od[k][i], h: ev.h, a: ev.a, t: ev.t });
    }
    for (const [id, o] of orig) if (!seen.has(id) && realLocked(real.events[id], o.t)) return { status: 400, error: 'locked_leg' };   // a started game cannot be dropped
    if (!picks.length || picks.length > MAX_PICKS) return { status: 400, error: 'bad_picks' };
    const amount = body.amount === undefined ? b.amount : Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STAKE) return { status: 400, error: 'bad_amount' };
    if (amount < s.minBet) return { status: 400, error: 'below_min' };
    if (s.maxBet && amount > s.maxBet) return { status: 400, error: 'above_max' };
    const diff = amount - b.amount;
    if (diff > 0) {
      const w = walletOf(acc);
      if (!w) return { status: 400, error: 'no_wallet' };
      if (w.have < diff) return { status: 400, error: 'insufficient' };
    }
    if (diff) { ledger(acc.number, b.jid, b.name).pending -= diff; store.stats.staked += diff; real.stats.staked += diff; }
    b.picks = picks; b.amount = amount; b.odds = Math.round(picks.reduce((x, p) => x * p.odd, 1) * 100) / 100;
    b.edits = (b.edits || 0) + 1; b.code = saveCode(picks, acc.number) || b.code;
    touch(); flushSync();
    return { status: 200, id: b.id, code: b.code };
  }

  // ── booking codes: share a slip. The code stores WHICH games / picks (not the odds); whoever loads it gets today's prices.
  //    Every game is shown, but only games that have not started can be added to the betslip (live games would be bet at stale odds).
  function makeCode(acc, body) {
    const raw = Array.isArray(body.picks) ? body.picks : [], seen = new Set(), picks = [];
    for (const p of raw) {
      const ev = real.events[p && p.e], k = p && p.k ? String(p.k) : 'x', i = Number(p && p.i);
      if (!ev || seen.has(ev.id) || !ev.o[k] || !Number.isInteger(i) || i < 0 || i >= ev.o[k].length) return { status: 400, error: 'bad_picks' };
      seen.add(ev.id); picks.push({ e: ev.id, k, i });
    }
    if (!picks.length || picks.length > MAX_PICKS) return { status: 400, error: 'bad_picks' };
    const code = saveCode(picks, acc.number); touch(); return { status: 200, code };
  }
  function codeView(code) {
    const c = real.codes[String(code).toUpperCase()]; if (!c) return null;
    const now = Date.now();
    return { ok: true, now, code: String(code).toUpperCase(), at: c.at, legs: c.picks.map(p => {
      const ev = real.events[p.e]; let st, score = null, odd = null;
      if (!ev) st = 'ended';
      else if (ev.status === 'done') { st = 'done'; score = ev.gh + '-' + ev.ga; }
      else if (ev.status === 'void') st = 'void';
      else if (now >= ev.t) { st = now > ev.t + MIN_END_MS ? 'ended' : 'live'; if (ev.live) score = ev.live.gh + '-' + ev.live.ga; }
      else if (now > ev.t - CLOSE_MS) st = 'closed';
      else st = 'open';
      if (ev && ev.o) { const od = oddsFor(ev); if (od[p.k]) odd = od[p.k][p.i]; }
      if (ev && ev.status === 'open' && now >= ev.t && canBet(ev).ok && odd != null) st = 'open';                 // live game that can be bet on right now
      if (st === 'open' && odd == null) st = 'nomarket';
      return { e: p.e, k: p.k, i: p.i, h: p.h, a: p.a, t: p.t, lg: p.lg, st, odd, score };
    }) };
  }
  function realView(acc) {
    const now = Date.now(), w = acc ? walletOf(acc) : null, s = store.settings;
    const day0 = new Date(now); day0.setHours(0, 0, 0, 0);                    // server midnight: today's finished games stay on the list
    const evs = Object.values(real.events).filter(ev => (ev.status === 'open' && ev.t > now - 4 * 3600000) || (ev.status === 'done' && ev.t > Math.min(now - 6 * 3600000, day0.getTime()))).sort((a, b) => a.t - b.t).slice(0, 250)
      .map(ev => ({ id: ev.id, lg: ev.lgName, h: ev.h, a: ev.a, t: ev.t, o: oddsFor(ev), closed: !canBet(ev, now).ok, why: canBet(ev, now).why || '',
        sc: ev.status === 'done' ? [ev.gh, ev.ga] : ev.live && now >= ev.t ? [ev.live.gh, ev.live.ga] : null, fin: ev.status === 'done', ck: ev.status === 'done' ? { ph: 'FT', min: 90, plus: 0, left: 0, est: false } : clockOf(ev, now) }));
    const mine = acc ? real.bets.filter(b => b.number === acc.number).slice(-30).reverse()
      .map(b => ({ id: b.id, at: b.at, picks: b.picks.map((p, ix) => Object.assign({ e: p.e, k: p.k, i: p.i, odd: p.odd, h: p.h, a: p.a, t: p.t }, b.res ? b.res[ix] : legRes(p))), amount: b.amount, odds: b.odds, status: b.status, win: b.win, code: b.code || null, edits: b.edits || 0 })) : [];
    return { ok: true, now, on: REAL_ON && s.enabled && s.real, locked: !s.enabled || !s.real, liveOn: s.live && !FREE, mode: s.mode, setup: !REAL_ON, limits: { min: s.minBet, max: s.maxBet }, events: evs, mine, balance: w ? w.have : null, updated: real.lastFetch, error: real.lastError || '', days: DAYS, diag: Object.entries(real.diag || {}).map(([k, v]) => ({ lg: LEAGUE_NAME[k] || TITLES[k] || k, n: v.n, err: v.err })) };
  }

  // ── what the browser sees ───────────────────────────────────
  // The page asks every second, so big things are only sent when they changed: the next round's odds (?nx=its id),
  // the current round's teams + goals (?cu=its id), and past tickets / results (?rs=last settled id).
  const csNames = CS.map(c => c.join('-')).concat('Other');
  function ticket(b, r) {
    const done = r.settled, st = r === nxt ? 'open' : done ? (b.win ? 'won' : 'lost') : 'live';
    return { id: b.id, round: r.id, kick: r.kick, amount: b.amount, odds: b.odds, win: done ? b.win : null, st, n: b.picks.length, code: b.code || null,
      legs: b.picks.map(p => { const f = r.fx[p.m]; return Object.assign({ m: p.m, h: f.h.n, a: f.a.n, k: p.k, i: p.i, odd: p.odd },
        done ? { res: wins(f, p.k, p.i) ? 'won' : 'lost', score: f.gh + '-' + f.ga } : { res: 'pend' }); }) };
  }
  function view(acc, q) {
    q = q || {};
    const s = store.settings, w = acc ? walletOf(acc) : null;
    const out = {
      ok: true, now: Date.now(), enabled: s.enabled && s.virtual, mode: s.mode, limits: { min: s.minBet, max: s.maxBet },
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

  // ── club logos: looked up once per club on TheSportsDB (free, key 123) and kept in the data file. The page shows the logo, or the coloured crest until one is found.
  //    LOGOS=off switches it off · THESPORTSDB_KEY=your key (optional)
  const LOGO_ON = !/^(off|0|none|no)$/i.test(String(process.env.LOGOS || 'on')), SDB_KEY = String(process.env.THESPORTSDB_KEY || '123').trim();
  const ALIAS = { 'Man City': 'Manchester City', 'Man United': 'Manchester United', 'Nottm Forest': 'Nottingham Forest', 'Sheffield Utd': 'Sheffield United', 'Atletico': 'Atletico Madrid', 'Athletic': 'Athletic Bilbao',
    'Betis': 'Real Betis', 'Celta': 'Celta Vigo', 'Rayo': 'Rayo Vallecano', 'Alaves': 'Alaves', 'Gladbach': 'Borussia Monchengladbach', 'Dortmund': 'Borussia Dortmund', 'Leipzig': 'RB Leipzig', 'Leverkusen': 'Bayer Leverkusen',
    'Frankfurt': 'Eintracht Frankfurt', 'Bayern': 'Bayern Munich', 'Koln': 'FC Koln', 'Mainz': 'Mainz 05', 'Hoffenheim': 'TSG Hoffenheim', 'Dusseldorf': 'Fortuna Dusseldorf', 'Hertha': 'Hertha Berlin', 'Hannover': 'Hannover 96',
    'Nurnberg': 'Nurnberg', 'Munster': 'Preussen Munster', 'Osnabruck': 'VfL Osnabruck', 'Cottbus': 'Energie Cottbus', 'Dresden': 'Dynamo Dresden', 'Rostock': 'Hansa Rostock', 'Regensburg': 'Jahn Regensburg', 'Karlsruhe': 'Karlsruher SC',
    'Paderborn': 'Paderborn', 'Magdeburg': 'Magdeburg', 'Darmstadt': 'Darmstadt 98', 'Braunschweig': 'Eintracht Braunschweig', 'Elversberg': 'Elversberg', 'Ulm': 'SSV Ulm', 'Holstein Kiel': 'Holstein Kiel', 'Greuther Furth': 'Greuther Furth',
    'Inter': 'Inter Milan', 'Roma': 'AS Roma', 'PSG': 'Paris SG', 'Monaco': 'AS Monaco', 'Sporting': 'Sporting CP', 'PSV': 'PSV Eindhoven', 'Salzburg': 'Red Bull Salzburg', 'Shakhtar': 'Shakhtar Donetsk', 'Basel': 'FC Basel',
    'Copenhagen': 'FC Copenhagen', 'Red Star': 'Red Star Belgrade', 'Racing': 'Racing Santander', 'Valladolid': 'Real Valladolid', 'Sporting Gijon': 'Sporting Gijon', 'Preston': 'Preston North End', 'Derby': 'Derby County',
    'Cardiff': 'Cardiff City', 'Swansea': 'Swansea City', 'Hull': 'Hull City', 'Stoke': 'Stoke City', 'Leicester': 'Leicester City', 'Norwich': 'Norwich City', 'Coventry': 'Coventry City', 'Bristol City': 'Bristol City', 'Luton': 'Luton Town',
    'Ipswich': 'Ipswich Town', 'Tottenham': 'Tottenham Hotspur', 'West Ham': 'West Ham United', 'Wolves': 'Wolverhampton Wanderers', 'Newcastle': 'Newcastle United', 'Leeds': 'Leeds United', 'Brighton': 'Brighton & Hove Albion', 'Brentford': 'Brentford' };
  const strictToks = (n) => toks(n).filter(x => x !== 'and');
  function pickBadge(term, teams) {
    const q = strictToks(term), qs = q.join(' '), ok = (teams || []).filter(t => /soccer|football/i.test(t.strSport || 'Soccer'));
    const names = (t) => [t.strTeam, ...String(t.strAlternate || '').split(',')].filter(Boolean);
    const exact = ok.find(t => names(t).some(n => strictToks(n).join(' ') === qs));
    const part = ok.find(t => { const r = strictToks(t.strTeam); return !r.some(x => ['women', 'ladies', 'u17', 'u18', 'u19', 'u20', 'u21', 'u23', 'ii', 'b'].includes(x)) && q.every(x => r.includes(x)); });
    const t = exact || part; return t ? (t.strBadge || t.strTeamBadge || '') : '';
  }
  let logoBusy = false, logoPause = 0;
  async function logoStep() {
    if (!LOGO_ON || logoBusy || Date.now() < logoPause) return; logoBusy = true;
    try {
      const names = [...new Set([...Object.values(real.events).filter(e => e.status === 'open').flatMap(e => [e.h, e.a]), ...LG.flatMap(([, ts]) => ts.map(t => t.n))])];
      const name = names.find(n => !store.logos[n] && !(store.logoMiss[n] && Date.now() - store.logoMiss[n] < 7 * 86400000)); if (!name) return;
      const term = ALIAS[name] || name;
      const r = await fetch('https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(SDB_KEY) + '/searchteams.php?t=' + encodeURIComponent(term), { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { logoPause = Date.now() + 65000; return; }
      if (!r.ok) throw new Error('logo api ' + r.status);
      const j = await r.json().catch(() => ({})), url = pickBadge(term, j && j.teams);
      if (url) store.logos[name] = url.replace(/^http:/, 'https:') + '/small'; else store.logoMiss[name] = Date.now();
      touch();
    } catch (x) { logoPause = Date.now() + 30000; }
    finally { logoBusy = false; }
  }
  if (LOGO_ON) setInterval(logoStep, 2600).unref();

  // ── admin helpers (optional) ────────────────────────────────
  function setSettings(patch) {
    const clean = cleanSettings(Object.assign({}, store.settings, patch || {}));
    store.settings = clean; touch(); return { settings: clean };
  }
  const adminInfo = () => ({ modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { label: v.label, virtual: v.v, real: v.r }])), settings: store.settings, apiFootball: { on: !!AF_KEY, left: afInfo.left, error: afInfo.error }, round: { next: nxt.id, nextBets: nxt.bets.length, live: cur.id, liveBets: cur.bets.length }, real: { on: REAL_ON, source: FREE ? 'free' : 'odds', events: Object.keys(real.events).length, openBets: real.bets.filter(b => b.status === 'open').length, lastFetch: real.lastFetch, lastError: real.lastError, credits: real.credits, extraMarkets: EXTRA_MKTS, leagues: AUTO ? 'auto' : LEAGUES, stats: real.stats }, stats: Object.assign({ houseNet: store.stats.staked - store.stats.paid }, store.stats) });

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
    if (p === '/football/real/debug' && req.method === 'GET') {                              // open in a browser: /football/real/debug?lg=uefa.nations  → what ESPN answers, raw
      if (hit('fbd', clientIp(req), 20, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const lg = String(new URL(req.url, 'http://x').searchParams.get('lg') || 'uefa.nations').replace(/[^a-z0-9_.]/gi, '').slice(0, 40), out = { ok: true, lg, source: FREE ? 'free' : 'odds', now: new Date().toISOString() };
      const brief = (e) => ({ id: e.id, date: e.date, name: e.name, state: e.status && e.status.type && e.status.type.state, type: e.status && e.status.type && e.status.type.name });
      try { const a = await espnRaw(lg, Date.now() - 86400000, Date.now() + DAYS * 86400000); out.range = { status: a.status, count: a.events.length, first: a.events.slice(0, 6).map(brief) }; } catch (x) { out.range = { error: String(x.message || x) }; }
      try { const b = await espnRaw(lg); out.plain = { status: b.status, count: b.events.length, first: b.events.slice(0, 6).map(brief) }; } catch (x) { out.plain = { error: String(x.message || x) }; }
      out.listed = Object.values(real.events).filter(e => e.lg === lg).length;
      const part = (t, x) => [t + ': ' + (x.error ? 'ERROR ' + x.error : 'HTTP ' + x.status + ' · ' + x.count + ' games')].concat((x.first || []).map(e => '   - ' + [e.name || e.id, e.date, e.state].join(' | '))).join('\n');
      const txt = ['League code: ' + lg, 'Source: ' + out.source, 'Server time: ' + out.now, '', part('Next 7 days', out.range), '', part('ESPN current / next matchday', out.plain), '', 'Games from this league in our list: ' + out.listed].join('\n');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#000;color:#eee;font:16px/1.5 monospace;padding:16px"><pre style="white-space:pre-wrap;word-break:break-word">' + txt.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>');
    }
    const im = p.match(/^\/football\/real\/info\/([A-Za-z0-9]{4,64})$/);
    if (im && req.method === 'GET') {
      if (hit('fbi', clientIp(req), 90, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const ev = real.events[im[1]]; if (!ev) return send(res, 404, { ok: false, error: 'no_match' });
      return send(res, 200, await infoView(ev));
    }
    const vm = p.match(/^\/football\/code\/([A-Za-z0-9]{4,12})$/);
    if (vm && req.method === 'GET') {
      if (hit('fbk', clientIp(req), 60, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const v = vCodeView(vm[1]); return v ? send(res, 200, v) : send(res, 404, { ok: false, error: 'no_code' });
    }
    if (p === '/football/code' && req.method === 'POST') {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
      if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });
      if (hit('fbk', acc.number, 30, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const r = makeVCode(acc, await readBody(req));
      return r.status === 200 ? send(res, 200, { ok: true, code: r.code }) : send(res, r.status, { ok: false, error: r.error });
    }
    if (p === '/football/logos' && req.method === 'GET') {
      if (hit('fbl', clientIp(req), 120, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      return send(res, 200, { ok: true, logos: Object.fromEntries(Object.entries(store.logos).filter(([, u]) => u)) });
    }
    const cm = p.match(/^\/football\/real\/code\/([A-Za-z0-9]{4,12})$/);
    if (cm && req.method === 'GET') {
      if (hit('fbk', clientIp(req), 60, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const v = codeView(cm[1]); return v ? send(res, 200, v) : send(res, 404, { ok: false, error: 'no_code' });
    }
    if (p === '/football/real/code' && req.method === 'POST') {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
      if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });
      if (hit('fbk', acc.number, 30, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const r = makeCode(acc, await readBody(req));
      return r.status === 200 ? send(res, 200, { ok: true, code: r.code }) : send(res, r.status, { ok: false, error: r.error });
    }
    const isReal = p === '/football/real/bet', isEditReal = p === '/football/real/edit', isEditV = p === '/football/edit';
    if (req.method !== 'POST' || (p !== '/football/bet' && !isReal && !isEditReal && !isEditV)) return send(res, 404, { ok: false, error: 'not_found' });
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 403, { ok: false, error: 'bad_request' });
    if (!acc) return send(res, 401, { ok: false, error: 'not_logged_in' });
    if (hit('fbb', acc.number, 60, 60000)) return send(res, 429, { ok: false, error: 'rate_limited' });
    if (isReal || isEditReal) {
      const rr = (isEditReal ? editReal : placeReal)(acc, await readBody(req));
      if (rr.status !== 200) return send(res, rr.status, { ok: false, error: rr.error });
      return send(res, 200, { ok: true, id: rr.id, code: rr.code, balance: (walletOf(acc) || {}).have });
    }
    const r = (isEditV ? editBet : placeBet)(acc, await readBody(req));
    if (r.status !== 200) return send(res, r.status, { ok: false, error: r.error });
    return send(res, 200, { ok: true, id: r.id, balance: (walletOf(acc) || {}).have });
  }

  return { handle, onAck, setSettings, adminInfo, hold: (number) => Math.max(0, -net(number)) };
};
