'use strict';
// Football TV — browser side. The server owns the fixtures, odds, goal minutes, tickets and your wallet.
// This file only draws the match, keeps the clock and sends your bet.
//   • The NEXT round is always open for booking (countdown to kick-off) while the CURRENT round plays on TV.
//   • Markets: 1X2, 1UP, 2UP, double chance, GG/NG, correct score, goals Over/Under, home / away Over,
//     1st half + 2nd half (1X2, double chance, Over/Under), 1X2 & Over/Under, double chance & Over/Under, GG & Over/Under, corners.
//   • Real matches: real fixtures + odds, and LIVE betting while the game is being played (virtual TV is pre-match only).
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();

const ERR = {
  not_logged_in: 'Please log in first.', game_off: 'Football betting is closed right now.',
  closed: 'Betting for this round has just closed.', stale: 'Those matches have kicked off. Pick again from the new round.',
  bad_amount: 'Enter a valid stake (1 or more).', bad_picks: 'Pick 1 to 10 different matches. Locked odds (-) cannot be picked.',
  too_many: 'You have too many open bets. Wait for some to finish.', no_wallet: 'Your wallet was not found yet. Use the bot once, then try again.',
  no_money: 'Your wallet is empty.', insufficient: 'Not enough money in your wallet for that stake.',
  below_min: 'That stake is below the minimum.', above_max: 'That stake is above the maximum.',
  rate_limited: 'Slow down a little and try again.', bad_request: 'Something went wrong. Refresh the page.',
  real_off: 'Real football betting is not switched on yet.',
  live_off: 'Live betting is switched off right now.', live_wait: 'Odds for this live game are updating. Try again in a moment.',
  live_goal: 'A goal was just scored. Live odds are being updated. Try again in a few seconds.',
  odds_changed: 'The live odds just changed. Check the new odds on your betslip, then tap Place Bet again.',
  locked_leg: 'A game that has already started cannot be changed or removed.', not_editable: 'This ticket can no longer be edited.', no_ticket: 'Ticket not found. Refresh the page.'
};
function errText(code) {
  const src = slipMode === 'r' ? R : S, lim = src && src.limits;
  if (code === 'below_min' && lim) return 'The minimum stake is ' + fmt(lim.min) + '.';
  if (code === 'above_max' && lim) return 'The maximum stake is ' + fmt(lim.max) + '.';
  return ERR[code] || 'Something went wrong. Try again.';
}
function parseAmt(s) {
  const m = String(s).toLowerCase().replace(/[,\s_]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  return m ? Math.floor(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : 0;
}
let toastT;
function toast(msg, bad, link) {
  const t = $('toast'); t.textContent = msg; t.className = 's-toast' + (bad ? ' bad' : '') + (link ? ' tap' : ''); t.hidden = false;
  t.onclick = link ? () => { t.hidden = true; setTab('b'); window.scrollTo({ top: 0, behavior: 'smooth' }); } : null;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 6000);
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// ── markets (Sporty-style) ──────────────────────────────────
// key letters:  x 1X2 · u1/u2 1UP/2UP · dc double chance · dnb draw no bet · gg GG/NG · cs correct score · oNN goals · hNN / aNN home / away goals
//   p1 / p2 = 1st / 2nd half 1X2 · d1 / d2 = 1st / 2nd half double chance · fNN / sNN = 1st / 2nd half goals · cNN / chNN / caNN = corners (total / home / away)
//   woNN = Home/Draw/Away WIN OR Over/Under (either one is enough) · xoNN = 1X2 & Over/Under · doNN = double chance & Over/Under · goNN = GG/NG & Over/Under
const pfx = (k) => String(k).replace(/\d+$/, '');
const lineOf = (k) => Number(String(k).replace(/^[a-z]+/, '')) / 10;     // 'o25' → 2.5 · 'xo15' → 1.5
const L1 = (k) => lineOf(k).toFixed(1);
const PF = { o: 'Goals O/U ', h: 'Home goals O/U ', a: 'Away goals O/U ', f: '1st half goals O/U ', s: '2nd half goals O/U ', c: 'Corners O/U ', ch: 'Home corners O/U ', ca: 'Away corners O/U ',
  xo: '1X2 & Over/Under ', wo: 'Win or Over/Under ', do: 'Double chance & Over/Under ', go: 'GG/NG & Over/Under ' };
const FIXED = { x: '1X2', u1: '1X2 - 1UP', u2: '1X2 - 2UP', dc: 'Double chance', dnb: 'Draw no bet', gg: 'GG / NG', cs: 'Correct score', p1: '1st half - 1X2', p2: '2nd half - 1X2', d1: '1st half - Double chance', d2: '2nd half - Double chance' };
const mName = (k) => FIXED[k] || (PF[pfx(k)] || 'Market ') + L1(k);
const pName = (k, i) => {
  if (k === 'x' || k === 'u1' || k === 'u2' || k === 'p1' || k === 'p2') return ['Home', 'Draw', 'Away'][i];
  if (k === 'dnb') return ['Home (draw = money back)', 'Away (draw = money back)'][i];
  if (k === 'dc' || k === 'd1' || k === 'd2') return ['Home or Draw', 'Home or Away', 'Draw or Away'][i];
  if (k === 'gg') return ['GG (both teams score)', 'NG (not both score)'][i];
  if (k === 'cs') { const c = (S && S.cs) || []; return c[i] === 'Other' || c[i] === undefined ? 'Any other score' : 'Score ' + c[i]; }
  const p = pfx(k), l = L1(k);
  if (p === 'xo') return ['Home', 'Draw', 'Away'][i % 3] + ' & ' + (i < 3 ? 'Over ' : 'Under ') + l;
  if (p === 'wo') return ['Home win', 'Draw', 'Away win'][i % 3] + ' or ' + (i < 3 ? 'Over ' : 'Under ') + l;
  if (p === 'do') return ['Home or Draw', 'Home or Away', 'Draw or Away'][i >> 1] + ' & ' + (i % 2 ? 'Under ' : 'Over ') + l;
  if (p === 'go') return (i < 2 ? 'GG' : 'NG') + ' & ' + (i % 2 ? 'Under ' : 'Over ') + l;
  return ({ h: 'Home ', a: 'Away ', ch: 'Home ', ca: 'Away ' }[p] || '') + (i ? 'Under ' : 'Over ') + l;
};
const O_ = ['Over', 'Under'];
const MKTS = [
  { id: 'x', name: '1X2', k: 'x', cols: ['1', 'X', '2'] },
  { id: 'dc', name: 'Double chance', k: 'dc', cols: ['1X', '12', 'X2'] },
  { id: 'gg', name: 'GG / NG', k: 'gg', cols: ['GG', 'NG'] },
  { id: 'ou', name: 'Goals O/U', p: 'o', cols: O_ },
  { id: 'xo', name: '1X2 & O/U', p: 'xo', combo: [0, 1, 2, 3, 4, 5], cols: ['1', 'X', '2'] },
  { id: 'wo', name: 'Win or O/U', p: 'wo', combo: [0, 1, 2, 3, 4, 5], cols: ['1', 'X', '2'] },
  { id: 'do', name: 'Double chance & O/U', p: 'do', combo: [0, 2, 4, 1, 3, 5], cols: ['1X', '12', 'X2'] },
  { id: 'go', name: 'GG/NG & O/U', p: 'go', combo: [null, 0, 2, null, 1, 3], cols: ['', 'GG', 'NG'] },
  { id: 'p1', name: '1st half 1X2', k: 'p1', cols: ['1', 'X', '2'] },
  { id: 'd1', name: '1st half DC', k: 'd1', cols: ['1X', '12', 'X2'] },
  { id: 'f', name: '1st half O/U', p: 'f', cols: O_ },
  { id: 'p2', name: '2nd half 1X2', k: 'p2', cols: ['1', 'X', '2'] },
  { id: 'd2', name: '2nd half DC', k: 'd2', cols: ['1X', '12', 'X2'] },
  { id: 's', name: '2nd half O/U', p: 's', cols: O_ },
  { id: 'cr', name: 'Corners O/U', p: 'c', cols: O_ },
  { id: 'tc', name: 'Team corners', p: 'cha', cols: ['Home Over', 'Away Over'] },
  { id: 'tg', name: 'Home / Away Over', p: 'ha', cols: ['Home Over', 'Away Over'] },
  { id: 'dnb', name: 'Draw no bet', k: 'dnb', cols: ['1', '2'] },
  { id: 'u1', name: '1X2 - 1UP', k: 'u1', cols: ['1', 'X', '2'] },
  { id: 'u2', name: '1X2 - 2UP', k: 'u2', cols: ['1', 'X', '2'] },
  { id: 'cs', name: 'Correct score', k: 'cs', cols: ['Score', 'Odds'], two: true }
];
const basePfx = (p) => p === 'ha' ? 'h' : p === 'cha' ? 'ch' : p;           // which lines the "2.5 v" box lists
const keysOf = (o, p) => Object.keys(o).filter(k => pfx(k) === p && k.length > p.length).sort((a, b) => lineOf(a) - lineOf(b));
const hasM = (o, m) => m.k ? !!o[m.k] : m.p === 'ha' ? keysOf(o, 'h').length > 0 && keysOf(o, 'a').length > 0 : m.p === 'cha' ? keysOf(o, 'ch').length > 0 && keysOf(o, 'ca').length > 0 : keysOf(o, m.p).length > 0;
const near = (o, p) => { const ks = keysOf(o, p).filter(k => o[k][0] != null && o[k][1] != null); return ks.length ? ks.reduce((b, k) => Math.abs(o[k][0] - o[k][1]) < Math.abs(o[b][0] - o[b][1]) ? k : b) : null; };
const COMBO_DEF = 2.5;                                                      // combos open on the 2.5 line (the header box changes it for all matches)
const ORDER = ['x', 'dc', 'gg', 'p1', 'd1', 'p2', 'd2', 'u1', 'u2', 'dnb'];
const moreOrder = (o) => [...ORDER, ...['o', 'xo', 'wo', 'do', 'go', 'f', 's', 'h', 'a', 'c', 'ch', 'ca'].flatMap(p => keysOf(o, p)), 'cs'].filter(k => o[k]);

// ── state ───────────────────────────────────────────────────
// S = light state polled every second · NX = next round (odds, open to bet) · CU = current round (on TV) · RC / HI = past tickets / results
let S = null, NX = null, CU = null, RC = [], HI = [], rsId = 0, R = null, off = 0, roff = 0, tab = 'v', slipMode = 'v';
let editing = null, dayInit = false, curTk = null;       // editing = { real, id, locked: { gameId: pick }, keep: Set, round }
let picks = {}, rpicks = {}, watched = 0, lastNext = 0, lastCur = 0, busy = false, fails = 0, rLoading = false;
const UI = { v: { mk: 'x', lg: 0, line: 'near' }, r: { mk: 'x', lg: 'all', day: 'all', line: 'near' } }, rowLine = {}, rowCs = {}, openMore = new Set();
const serverNow = () => Date.now() + off;
const nleft = () => S ? S.nextKick - serverNow() : 0;
function cphase() {                                           // the round that is on TV
  if (!S || !CU) return { ph: 'wait', min: 0, left: 0 };
  const t = S.timing, e = serverNow() - CU.kick;
  if (e < 0) return { ph: 'wait', min: 0, left: 0 };
  if (e < t.play) return { ph: 'play', min: Math.min(90, Math.floor(e / t.play * 90)), left: t.play - e };
  return { ph: e < t.play + t.end ? 'end' : 'done', min: 90, left: 0 };
}
const score = (f, m) => { let a = 0, b = 0; (f.goals || []).forEach(g => { if (g.m <= m) g.side ? b++ : a++; }); return [a, b]; };
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const cur = () => slipMode === 'r' ? rpicks : picks;
const lockedList = () => editing && editing.real && slipMode === 'r' ? Object.keys(editing.locked) : [];
const total = () => { const p = cur(); const l = lockedList().reduce((x, e) => x * editing.locked[e].odd, 1); return Object.keys(p).reduce((x, m) => x * p[m].odd, l); };
const slipCount = () => Object.keys(cur()).length + lockedList().length;
async function copyText(t, b, done) {                       // works on http pages too (no clipboard API there)
  let ok = false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); ok = true; } } catch {}
  if (!ok) { try { const a = document.createElement('textarea'); a.value = t; a.setAttribute('readonly', ''); a.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.append(a); a.select(); a.setSelectionRange(0, 99999); ok = document.execCommand('copy'); a.remove(); } catch {} }
  const old = b.textContent; b.textContent = ok ? (done || 'Copied ✓') : 'Press and hold to copy'; setTimeout(() => { b.textContent = old; }, 2200);
}

async function load() {
  try {
    const q = '?nx=' + (NX ? NX.id : 0) + '&cu=' + (CU ? CU.id : 0) + '&rs=' + rsId;
    const r = await fetch('/football/state' + q, { credentials: 'same-origin', cache: 'no-store' });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error('bad');
    off = j.now - Date.now(); fails = 0; $('conn').hidden = true;
    if (j.next) NX = j.next; if (j.cur) CU = j.cur;
    if (j.recent) { RC = j.recent; HI = j.history || []; rsId = j.settledId; }
    S = j;
    if (S.nextId !== lastNext) {                                // kick-off: the old "next" round is now on TV, a new round is open
      const had = lastNext !== 0 && (Object.keys(picks).length > 0 || $('slip').open);
      lastNext = S.nextId; picks = {}; openMore.clear(); if (editing && !editing.real) { editing = null; renderEditBar(); }
      if (had && slipMode === 'v') { if ($('slip').open) $('slip').close(); toast('Kick-off! A new round is open. Pick again.', false); }
      renderList();
    }
    if (CU && CU.id !== lastCur) { lastCur = CU.id; const per = S.per; if (!CU.fx[watched]) watched = UI.v.lg * per; buildLive(); }
    renderTop(); renderMine(); renderResults(); renderBtn(); paint();
  } catch { if (++fails > 2) $('conn').hidden = false; }
}
async function loadReal() {
  if (rLoading) return; rLoading = true;
  try {
    const r = await fetch('/football/real/state', { credentials: 'same-origin', cache: 'no-store' });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error('bad');
    roff = j.now - Date.now(); R = j;
    let dropped = 0;
    Object.keys(rpicks).forEach(id => {
      if (editing && editing.keep.has(id)) return;
      const ev = R.events.find(e => e.id === id);
      if (!ev || ev.closed) { if (ev && ev.sc !== undefined && Date.now() + roff >= ev.t) dropped++; delete rpicks[id]; return; }
      const pk = rpicks[id], now = ev.o && ev.o[pk.k] ? ev.o[pk.k][pk.i] : null;                      // LIVE game: the price on your slip follows the live price
      if (now == null) { delete rpicks[id]; dropped++; }
      else if (Date.now() + roff >= ev.t && Math.abs(now - pk.odd) > 0.004) { pk.moved = now > pk.odd ? 'up' : 'down'; pk.odd = now; }
    });
    if (dropped) toast('A live game on your slip is paused (goal or odds updating) or that market closed. Pick it again in a moment.', true);
    renderTop(); renderReal(); renderMine(); renderBtn();
    if (curTk && curTk.real && $('ticketDlg').open) { const t = R.mine.find(x => x.id === curTk.id); if (t) openTicket(t, true); }
  } catch {}
  rLoading = false;
}

// ── tabs + rooms ────────────────────────────────────────────
function setTab(t) {
  tab = t;
  document.querySelectorAll('.fb-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $('panelV').hidden = t !== 'v'; $('panelR').hidden = t !== 'r'; $('panelB').hidden = t !== 'b';
  if (t === 'r') slipMode = 'r'; if (t === 'v') slipMode = 'v';
  if (t !== 'v') loadReal();
  renderBtn(); paint();
}
document.querySelectorAll('.fb-tabs [data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));

// ── page pieces ─────────────────────────────────────────────
function renderTop() {
  const src = S || R, logged = !!src && src.balance !== null, bal = S && S.balance !== null ? S.balance : (R ? R.balance : null);
  $('balChip').hidden = !logged; if (logged) $('bal').textContent = fmt(bal);
  $('hdLogin').hidden = logged; $('hdSignup').hidden = logged;
  $('loginNote').hidden = logged || !src; $('closedNote').hidden = true;
  const lv = !!S && !S.enabled, lr = !!R && !!R.locked;                // the owner closed a room: show a lock instead of the games
  $('lockV').hidden = !lv; $('panelV').classList.toggle('locked', lv); $('lockR').hidden = !lr; $('panelR').classList.toggle('locked', lr);
}
const OPT6 = /^(xo|do|wo)\d+$/;
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const LOGOS = {};                                                    // club name → logo image (the server looks them up once and keeps them)
const plainCrest = (t) => { const c = el('span', 'crest', t.c.slice(0, 1)); c.style.background = t.col; c.style.color = lum(t.col) > .6 ? '#111' : '#fff'; return c; };
const crest = (t) => {
  const u = t.l || LOGOS[t.n]; if (!u) return plainCrest(t);                                        // t.l = the real logo the server sent with the match
  const w = el('span', 'crest logo'), im = new Image(); im.alt = t.n; im.decoding = 'async'; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.src = u;
  im.onerror = () => { if (t.l && t.l === u) t.l = ''; else delete LOGOS[t.n]; if (w.isConnected) w.replaceWith(plainCrest(t)); };       // a broken link falls back to the coloured crest
  w.append(im); return w;
};
async function loadLogos() {
  try {
    const r = await fetch('/football/logos', { cache: 'no-store' }), j = await r.json(); if (!r.ok || !j.ok) return;
    const before = Object.keys(LOGOS).length; let changed = false;
    Object.entries(j.logos).forEach(([n, u]) => { if (LOGOS[n] !== u) { LOGOS[n] = u; changed = true; } });
    if (changed || before !== Object.keys(LOGOS).length) { renderList(); renderReal(); buildLive(); }
  } catch {}
}
const stars = (n) => { const s = el('span', 'stars'); for (let i = 0; i < 5; i++) s.append(el('i', i < n ? 'on' : '', '★')); return s; };
const teamLine = (t, goals) => { const r = el('div', 'tl'); r.append(crest(t), el('span', 'tn', t.n)); if (t.st) r.append(stars(t.st)); if (goals !== undefined && goals !== null) r.append(el('b', 'sg', String(goals))); return r; };

function cell(it, store, dis, redraw, k, i, label, tag) {
  const o = it.o[k], b = el('button', 'cell' + (tag ? ' cb' : '')); b.type = 'button';
  if (!o || o[i] == null) { b.disabled = true; b.setAttribute('aria-label', 'Locked'); b.append(el('b', '', '-')); return b; }
  const on = !!store[it.id] && store[it.id].k === k && store[it.id].i === i;
  b.disabled = dis; b.dataset.has = '1'; b.setAttribute('aria-pressed', String(on)); if (label) b.setAttribute('aria-label', label);
  if (tag) b.append(el('small', '', tag));                                                         // O / U in front of a combo price
  b.append(el('b', '', o[i].toFixed(2)));
  b.onclick = () => { if (on) delete store[it.id]; else store[it.id] = { k, i, odd: o[i] }; redraw(); renderBtn(); };
  return b;
}
function lineSelect(it, ui, p, redraw) {            // the "2.5 v" box in front of Over / Under
  const pp = basePfx(p), ks = keysOf(it.o, pp), sel = el('select', 'lsel'); sel.setAttribute('aria-label', 'Line');
  const c = rowLine[it.id] || ui.line, shown = c === 'near' ? near(it.o, pp) : pp + Math.round(c * 10);
  ks.forEach(k => { const o = el('option', '', L1(k)); o.value = lineOf(k); if (lineOf(k) === lineOf(shown || ks[0])) o.selected = true; sel.append(o); });
  sel.onchange = () => { rowLine[it.id] = Number(sel.value); redraw(); };
  return sel;
}
function csSelect(it, redraw) {                      // pick which score to show / bet on
  const names = (S && S.cs) || [], o = it.o.cs, sel = el('select', 'lsel'); sel.setAttribute('aria-label', 'Correct score');
  let best = -1; o.forEach((v, ix) => { if (ix < o.length - 1 && v != null && (best < 0 || v < o[best])) best = ix; });
  const pick = rowCs[it.id] === undefined ? best : rowCs[it.id];
  names.forEach((n, ix) => { const op = el('option', '', n === 'Other' ? 'Other' : n); op.value = ix; if (ix === pick) op.selected = true; sel.append(op); });
  sel.onchange = () => { rowCs[it.id] = Number(sel.value); redraw(); };
  return [sel, pick];
}
function matchRow(it, ui, store, dis, redraw) {
  const m = MKTS.find(x => x.id === ui.mk) || MKTS[0], row = el('div', 'sp-row' + (it.live ? ' islive' : ''));
  const main = el('div', 'sp-main'), teams = el('div', 'sp-teams');
  teams.append(teamLine(it.h, it.sc ? it.sc[0] : null), teamLine(it.a, it.sc ? it.sc[1] : null));
  teams.classList.add('tap'); teams.tabIndex = 0; teams.setAttribute('role', 'button'); teams.setAttribute('aria-label', 'Open all markets of ' + it.h.n + ' v ' + it.a.n);
  teams.onclick = () => openDetail(it); teams.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(it); } };
  const odds = el('div', 'sp-odds');
  if (m.id === 'cs') { const [sel, pick] = csSelect(it, redraw), c = cell(it, store, dis, redraw, 'cs', pick, 'Correct score'); c.style.gridColumn = 'span 2'; odds.append(sel, c); }
  else if (m.k) { if (m.cols.length === 2) odds.append(el('span')); m.cols.forEach((c, i) => odds.append(cell(it, store, dis, redraw, m.k, i, c))); }
  else if (m.combo) {                                                      // 1X2 & O/U · double chance & O/U · GG & O/U: two rows (Over / Under), line chosen in the header
    const want = rowLine[it.id] || (ui.line === 'near' ? COMBO_DEF : ui.line), ks = keysOf(it.o, m.p), k = ks.includes(m.p + Math.round(want * 10)) ? m.p + Math.round(want * 10) : ks.includes(m.p + Math.round(COMBO_DEF * 10)) ? m.p + Math.round(COMBO_DEF * 10) : ks[0];
    odds.classList.add('combo');
    m.combo.forEach((ix, n) => { if (ix === null) { odds.append(el('span')); return; } odds.append(cell(it, store, dis, redraw, k, ix, pName(k, ix), (m.p === 'do' ? ix % 2 : m.p === 'go' ? ix % 2 : ix >= 3 ? 1 : 0) ? 'U' : 'O')); });
  }
  else {
    const L = rowLine[it.id] || ui.line, key = (p) => L === 'near' ? near(it.o, p) : p + Math.round(L * 10);
    odds.append(lineSelect(it, ui, m.p, redraw));
    if (m.p === 'ha' || m.p === 'cha') { const [a, b] = m.p === 'ha' ? ['h', 'a'] : ['ch', 'ca']; odds.append(cell(it, store, dis, redraw, key(a), 0, 'Home Over'), cell(it, store, dis, redraw, key(b), 0, 'Away Over')); }
    else { const k = key(m.p); odds.append(cell(it, store, dis, redraw, k, 0, 'Over'), cell(it, store, dis, redraw, k, 1, 'Under')); }
  }
  main.append(teams, odds);
  const foot = el('div', 'sp-foot'), n = Object.values(it.o).reduce((s, a) => s + a.filter(v => v != null).length, 0) - odds.querySelectorAll('[data-has]').length;
  const more = el('button', 'more', (openMore.has(it.id) ? '− ' : '+') + n + (openMore.has(it.id) ? '' : '  ›')); more.type = 'button';
  more.onclick = () => { openMore.has(it.id) ? openMore.delete(it.id) : openMore.add(it.id); redraw(); };
  foot.append(more, el('span', 'st' + (it.live ? ' live' : ''), it.meta || ''));
  if (it.real) {                                                       // the chart icon: head-to-head + live statistics
    const ib = el('button', 'info'); ib.type = 'button'; ib.setAttribute('aria-label', 'Match info: head to head and statistics');
    ib.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 3v18h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 15l4-5 3 3 5-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    ib.onclick = () => openInfo(it); foot.append(ib);
  }
  row.append(main, foot);
  if (openMore.has(it.id)) {
    const box = el('div', 'sp-more'), order = moreOrder(it.o);
    order.forEach(k => {
      const r = el('div', 'mrow'); r.append(el('span', 'ml', mName(k)));
      const g = el('div', 'mc' + (k === 'cs' ? ' cs' : '') + (OPT6.test(k) ? ' six' : '')); it.o[k].forEach((_, i) => { const c = cell(it, store, dis, redraw, k, i); c.prepend(el('small', '', k === 'cs' ? (S.cs[i] || '') : pName(k, i))); g.append(c); }); r.append(g); box.append(r);
    });
    row.append(box);
  }
  return row;
}
function leagueHead(name, ui, items, redraw) {
  const m = MKTS.find(x => x.id === ui.mk) || MKTS[0], h = el('div', 'sp-head');
  const nm = el('div', 'lgn'); nm.append(el('span', 'flag', name.slice(0, 2).toUpperCase()), el('b', '', name)); h.append(nm);
  const mid = el('div', 'hmid');
  if (!m.k) {
    const s = el('select', 'near'); s.setAttribute('aria-label', 'Line for all matches');
    const ls = [...new Set(items.flatMap(it => keysOf(it.o, basePfx(m.p)).map(lineOf)))].sort((a, b) => a - b), shown = m.combo && ui.line === 'near' ? COMBO_DEF : ui.line;
    (m.combo ? ls.map(l => [l, l.toFixed(1)]) : [['near', 'Near'], ...ls.map(l => [l, l.toFixed(1)])]).forEach(([v, t]) => { const o = el('option', '', t); o.value = v; if (String(shown) === String(v)) o.selected = true; s.append(o); });
    s.onchange = () => { ui.line = s.value === 'near' ? 'near' : Number(s.value); items.forEach(it => delete rowLine[it.id]); redraw(); };
    mid.append(s);
  }
  h.append(mid);
  const cols = el('div', 'hcols' + (m.two ? ' two' : '')); (m.cols.length === 2 && !m.two ? ['', ...m.cols] : m.cols).forEach(c => cols.append(el('span', '', c))); h.append(cols);
  return h;
}
function marketTabs(box, ui, items, redraw) {
  box.replaceChildren();
  MKTS.filter(m => items.some(it => hasM(it.o, m))).forEach(m => {
    const b = el('button', 'mt', m.name); b.type = 'button'; b.setAttribute('aria-selected', String(ui.mk === m.id));
    b.onclick = () => { ui.mk = m.id; ui.line = 'near'; redraw(); };
    box.append(b);
  });
}

// ── virtual: the NEXT round is the betting list ─────────────
const vItems = () => NX.fx.map(f => ({ id: f.id, lg: f.lg, h: f.h, a: f.a, o: f.o, meta: 'Round ' + NX.id }));
function renderList() { renderListMain(); if (DET) renderDetail(); }
function renderListMain() {
  if (!S || !NX) return;
  const ui = UI.v, dis = nleft() <= 1000 || !S.enabled, all = vItems(), items = all.filter(it => it.lg === ui.lg), box = $('list');
  const tabs = $('lgTabs'); tabs.replaceChildren();
  S.leagues.forEach((n, i) => { const b = el('button', 'lt', n); b.type = 'button'; b.setAttribute('aria-selected', String(ui.lg === i)); b.onclick = () => { ui.lg = i; watched = i * S.per; buildLive(); renderList(); }; tabs.append(b); });
  marketTabs($('mkTabs'), ui, all, renderList);
  if (!MKTS.some(m => m.id === ui.mk && all.some(it => hasM(it.o, m)))) ui.mk = 'x';
  box.replaceChildren(leagueHead(S.leagues[ui.lg], ui, items, renderList));
  items.forEach(it => box.append(matchRow(it, ui, picks, dis, renderList)));
  $('nextTitle').textContent = 'Next round · Round ' + NX.id;
}
// live strip: every match of the selected league that is on TV right now
function buildLive() {
  const box = $('liveRow'); box.replaceChildren(); if (!CU || !S) return;
  CU.fx.filter(f => f.lg === UI.v.lg).forEach(f => {
    const b = el('button', 'lv'); b.type = 'button'; b.dataset.lv = f.id;
    b.onclick = () => { watched = f.id; paintLive(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    b.append(el('span', 'lv-t', f.h.c + ' v ' + f.a.c), el('b', 'lv-s', '0 - 0')); box.append(b);
  });
  $('liveTitle').textContent = 'On TV now · Round ' + CU.id + ' · ' + S.leagues[UI.v.lg];
  paintLive();
}
function paintLive() {
  if (!CU || !S) return;
  const c = cphase();
  CU.fx.forEach(f => {
    const b = document.querySelector('[data-lv="' + f.id + '"]'); if (!b) return;
    const [x, y] = score(f, c.min); b.querySelector('.lv-s').textContent = x + ' - ' + y;
    b.className = 'lv' + (watched === f.id ? ' on' : '') + (c.ph === 'play' ? ' live' : '');
  });
}
function paint() {
  if (!S) return;
  const c = cphase(), left = nleft(), dis = left <= 1000 || !S.enabled;
  if (NX && dis !== lastDis) { lastDis = dis; renderList(); }
  $('ph').textContent = 'Next kick-off in'; $('clk').textContent = mmss(left);
  $('tvst').textContent = c.ph === 'play' ? "● LIVE " + c.min + "'" : c.ph === 'wait' ? '' : 'FULL TIME';
  paintLive();
  const w = CU && CU.fx[watched]; if (w) $('chan').textContent = 'Round ' + CU.id + ' · ' + w.h.c + ' v ' + w.a.c;
  $('nextRound').textContent = tab === 'r' ? 'Real matches' : 'Kick-off in ' + mmss(left);
}
let lastDis = null;
function renderBtn() {
  const n = slipCount(), on = (tab === 'v' && !!S && S.enabled) || (tab === 'r' && !!R && !R.locked);
  $('open').textContent = 'Betslip' + (n ? ' (' + n + ') · ' + total().toFixed(2) : '');
  $('open').disabled = !n || !on;
  const fn = $('fabN'); fn.hidden = !n; fn.textContent = String(n); $('fab').hidden = tab === 'b';
  const db = document.querySelector('.det-bar button'); if (db) { db.textContent = $('open').textContent; db.disabled = $('open').disabled; }     // the details page's own betslip button
}

const LG_PRI = ['England - Premier League', 'International Clubs - UEFA Champions League', 'England - EFL Cup', 'Spain - LaLiga', 'Germany - Bundesliga', 'Italy - Coppa Italia', 'Italy - Serie A', 'France - Ligue 1', 'International Clubs - UEFA Europa League', 'Spain - Copa del Rey', "International Clubs - UEFA Women's Champions League"];
const lgRank = (n) => { const i = LG_PRI.indexOf(n); return i < 0 ? 99 : i; };
// ── real matches ────────────────────────────────────────────
const fmtTime = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const dayWord = (t) => sameDay(t, Date.now()) ? 'Today' : sameDay(t, Date.now() + 86400000) ? 'Tomorrow' : new Date(t).toLocaleDateString([], { weekday: 'long' });
const dayLabel = (t) => dayWord(t) + ' · ' + new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });     // Today · 14 Nov / Monday · 16 Nov
const until = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm' : Math.floor(m / 1440) + 'd ' + Math.floor(m % 1440 / 60) + 'h'; };
const ckText = (ck) => !ck ? '' : ck.ph === 'HT' ? 'HT' : ck.ph === 'FT' ? 'FT' : ck.ph === 'ET' ? 'Extra time' : ck.min + (ck.plus ? '+' + ck.plus : '') + "'";
const leftText = (ck) => !ck || (ck.ph !== '1H' && ck.ph !== '2H') ? (ck && ck.ph === 'HT' ? 'half-time' : '') : ck.left > 0 ? (ck.est ? '~' : '') + ck.left + ' min left' : 'added time';
const rTeam = (n, logo) => ({ n, c: n.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(), col: '#64748b', st: 0, l: logo || '' });
// one real match as a list item (used by the list AND by the match details page)
const mkRealItem = (ev, now) => { const shut = !!ev.closed;                // the server decides: before kick-off, or live with fresh odds
    const started = now >= ev.t && !ev.fin, ck = ev.ck, why = ev.why === 'live_wait' ? ' · updating odds…' : ev.why === 'live_goal' ? ' · ⚽ goal! odds updating…' : ev.why === 'live_off' ? ' · live betting off' : '';
    return { id: ev.id, real: true, live: started, t: ev.t, lgn: ev.lg, h: rTeam(ev.h, ev.hl), a: rTeam(ev.a, ev.al), o: ev.o, closed: shut, sc: ev.sc || null, fin: !!ev.fin,
      meta: ev.lg + ' · ' + fmtClock(ev.t) + ' · ' + (ev.fin ? 'Full time' : started ? '● LIVE ' + [ckText(ck), leftText(ck)].filter(Boolean).join(' · ') + why : shut ? 'Closing' : 'in ' + until(ev.t - now)) }; };
function renderReal() { renderRealMain(); if (DET) renderDetail(); }
function renderRealMain() {
  const box = $('rlist'), note = $('rnote'), info = $('rinfo'); if (!R) return;
  if (R.locked) { box.replaceChildren(); return; }
  const now = Date.now() + roff, ui = UI.r, tabs = $('lgTabsR'), dtabs = $('dayTabsR');
  if (R.setup || !R.on) {
    note.hidden = false; info.hidden = true; box.replaceChildren(); $('mkTabsR').replaceChildren(); tabs.replaceChildren(); dtabs.replaceChildren();
    note.replaceChildren(el('strong', '', R.setup ? 'Real matches are not switched on yet.' : 'Betting is closed right now.'), el('span', 's-muted', ' Please check again later. The virtual TV is open.'));
    return;
  }
  note.hidden = true; box.replaceChildren();
  const all = R.events.map(ev => mkRealItem(ev, now)).sort((a, b) => a.t - b.t);
  info.hidden = false;
  info.textContent = 'Today and the next 7 days. Kick-off times are in your time (' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local') + ').' + (R.updated ? ' Odds updated ' + fmtClock(R.updated) + '.' : '');
  // day tabs (Today · Tomorrow · Mon 16 …) and league tabs
  const days = [...new Set(all.map(it => new Date(it.t).toDateString()))];
  const nLive = all.filter(it => it.live).length;
  if (!dayInit && all.length) { dayInit = true; const td = new Date(now).toDateString(); if (nLive) ui.day = 'live'; else if (days.includes(td)) ui.day = td; }     // open on the LIVE games, else TODAY's games
  if (ui.day !== 'all' && !(ui.day === 'live' && nLive) && !days.includes(ui.day)) ui.day = 'all';
  dtabs.replaceChildren();
  if (days.length) [['all', 'All days (' + all.length + ')'], ...(nLive ? [['live', '🔴 Live now (' + nLive + ')']] : []), ...days.map(d => { const f = all.find(it => new Date(it.t).toDateString() === d); return [d, dayWord(f.t) + ' (' + all.filter(it => new Date(it.t).toDateString() === d).length + ')']; })].forEach(([v, t]) => {
    const b = el('button', 'lt' + (v === 'live' ? ' livetab' : ''), t); b.type = 'button'; b.setAttribute('aria-selected', String(ui.day === v)); b.onclick = () => { ui.day = v; renderReal(); }; dtabs.append(b);
  });
  const byDay = all.filter(it => ui.day === 'all' || (ui.day === 'live' ? it.live : new Date(it.t).toDateString() === ui.day));
  const lgs = [...new Set(byDay.map(it => it.lgn))].sort((a, b) => (lgRank(a) - lgRank(b)) || a.localeCompare(b));
  if (ui.lg !== 'all' && !lgs.includes(ui.lg)) ui.lg = 'all';
  tabs.replaceChildren();
  if (lgs.length > 1) [['all', 'All leagues (' + byDay.length + ')'], ...lgs.map(l => [l, l + ' (' + byDay.filter(it => it.lgn === l).length + ')'])].forEach(([v, t]) => {
    const b = el('button', 'lt', t); b.type = 'button'; b.setAttribute('aria-selected', String(ui.lg === v)); b.onclick = () => { ui.lg = v; renderReal(); }; tabs.append(b);
  });
  const items = byDay.filter(it => ui.lg === 'all' || it.lgn === ui.lg);
  marketTabs($('mkTabsR'), ui, all, renderReal);
  if (!MKTS.some(m => m.id === ui.mk && all.some(it => hasM(it.o, m)))) ui.mk = 'x';
  if (!all.length) {
    box.append(el('p', 'empty', R.updated ? 'No real matches to bet on in the next ' + (R.days || 7) + ' days. New fixtures appear here automatically.' : 'Loading real fixtures…'));
    const why = (R.diag || []).slice().sort((a, b) => (b.err ? 1 : 0) - (a.err ? 1 : 0)).map(d => d.lg + ': ' + (d.err || (d.n ? d.n + ' matches, odds not posted yet' : 'no matches'))).slice(0, 45);       // tells the owner WHY the list is empty
    if (R.error) why.unshift('Match feed says: ' + R.error);
    if (why.length) { const w = el('div', 'empty'); why.forEach(t => w.append(el('div', '', '• ' + t))); box.append(w); }
    return;
  }
  box.append(leagueHead(ui.lg === 'all' ? 'All leagues' : ui.lg, ui, items, renderReal));
  let day = '';
  items.forEach(it => { const d = dayLabel(it.t); if (d !== day) { day = d; box.append(el('div', 'day-sep', d)); } box.append(matchRow(it, ui, rpicks, it.closed || !R.on, renderReal)); });
}


// ── MATCH DETAILS: tap a match → every market of that game, in groups (All · Main · Goals · Combos · Half · Corners) ──
let DET = null;
const DET_TABS = [['all', 'All'], ['main', 'Main'], ['goals', 'Goals'], ['combo', 'Combos'], ['half', 'Half'], ['corners', 'Corners']];
function detItem() {
  if (!DET) return null;
  if (DET.real) { const ev = R && R.events.find(e => e.id === DET.id); return ev ? mkRealItem(ev, Date.now() + roff) : null; }
  return NX ? vItems().find(i => i.id === DET.id) || null : null;
}
function openDetail(it) {
  DET = { id: it.id, real: !!it.real, tab: 'all', shut: new Set() };
  try { history.pushState({ fbdet: 1 }, ''); } catch (e) { }
  document.body.classList.add('det-open'); $('detail').hidden = false; $('detail').scrollTop = 0; renderDetail();
}
function hideDetail() { DET = null; $('detail').hidden = true; $('detail').replaceChildren(); document.body.classList.remove('det-open'); }
function closeDetail() { if (history.state && history.state.fbdet) history.back(); else hideDetail(); }
addEventListener('popstate', () => { if (DET) hideDetail(); });
function detSections(it, store, dis, redraw) {
  const o = it.o, out = [], has = (k) => o[k] && o[k].some(v => v != null);
  const simple = (title, tab, k, lab) => {
    if (!has(k)) return; const g = el('div', 'dg c' + o[k].length);
    o[k].forEach((_, i) => { const c = cell(it, store, dis, redraw, k, i, lab[i]); c.prepend(el('span', 'dl', lab[i])); g.append(c); });
    out.push({ title, tab, node: g });
  };
  const lines = (title, tab, p) => {                                             // Over / Under table: one row per line
    const ks = keysOf(o, p).filter(has); if (!ks.length) return;
    const g = el('div', 'dg tbl'); g.style.setProperty('--n', '2'); g.append(el('span'), el('span', 'dh', 'Over'), el('span', 'dh', 'Under'));
    ks.forEach(k => { g.append(el('span', 'dline', L1(k))); [0, 1].forEach(i => g.append(cell(it, store, dis, redraw, k, i, pName(k, i)))); });
    out.push({ title, tab, node: g });
  };
  const combo = (title, tab, p, cols, ix) => {                                   // e.g. Home / Draw / Away  x  Over / Under per line
    const ks = keysOf(o, p).filter(has); if (!ks.length) return;
    const g = el('div', 'dg tbl'); g.style.setProperty('--n', String(cols.length)); g.append(el('span')); cols.forEach(c => g.append(el('span', 'dh', c)));
    ks.forEach(k => [0, 1].forEach(u => { g.append(el('span', 'dline', (u ? 'Under ' : 'Over ') + L1(k))); cols.forEach((_, c) => g.append(cell(it, store, dis, redraw, k, ix(c, u), pName(k, ix(c, u))))); }));
    out.push({ title, tab, node: g });
  };
  const HDA = ['Home', 'Draw', 'Away'], DC = ['Home or Draw', 'Home or Away', 'Draw or Away'];
  simple('1X2', 'main', 'x', HDA); simple('Double Chance', 'main', 'dc', DC); simple('GG / NG', 'main', 'gg', ['GG', 'NG']); simple('Draw No Bet', 'main', 'dnb', ['Home', 'Away']);
  simple('1X2 - 1UP', 'main', 'u1', HDA); simple('1X2 - 2UP', 'main', 'u2', HDA);
  lines('Over/Under', 'goals', 'o'); lines('Home Over/Under', 'goals', 'h'); lines('Away Over/Under', 'goals', 'a');
  if (has('cs')) { const g = el('div', 'dg c3'); it.o.cs.forEach((_, i) => { const n = (S && S.cs && S.cs[i]) || ''; const c = cell(it, store, dis, redraw, 'cs', i, n); c.prepend(el('span', 'dl', n === 'Other' || n === '' ? 'Any other' : n)); g.append(c); }); out.push({ title: 'Correct Score', tab: 'goals', node: g }); }
  combo('1X2 & Over/Under', 'combo', 'xo', HDA, (c, u) => u * 3 + c); combo('Win or Over/Under', 'combo', 'wo', HDA, (c, u) => u * 3 + c);
  combo('Double Chance & Over/Under', 'combo', 'do', DC, (c, u) => c * 2 + u); combo('GG/NG & Over/Under', 'combo', 'go', ['GG', 'NG'], (c, u) => c * 2 + u);
  simple('1st Half - 1X2', 'half', 'p1', HDA); simple('1st Half - Double Chance', 'half', 'd1', DC); lines('1st Half - Over/Under', 'half', 'f');
  simple('2nd Half - 1X2', 'half', 'p2', HDA); simple('2nd Half - Double Chance', 'half', 'd2', DC); lines('2nd Half - Over/Under', 'half', 's');
  lines('Corners Over/Under', 'corners', 'c'); lines('Home Corners Over/Under', 'corners', 'ch'); lines('Away Corners Over/Under', 'corners', 'ca');
  return out;
}
function renderDetail() {
  const root = $('detail'); if (!DET) return;
  const it = detItem(), keep = root.scrollTop; root.replaceChildren();
  const top = el('div', 'det-top'), back = el('button', 'det-back'); back.type = 'button'; back.setAttribute('aria-label', 'Back'); back.textContent = '←'; back.onclick = closeDetail;
  top.append(back, el('b', '', 'Details')); root.append(top);
  if (!it) { root.append(el('p', 'empty', 'This match is no longer available.')); return; }
  const store = DET.real ? rpicks : picks, redraw = DET.real ? renderReal : renderList, dis = DET.real ? (it.closed || !R.on) : (nleft() <= 1000 || !S.enabled);
  const wrap = el('div', 'det-wrap'), hd = el('div', 'det-hd');
  hd.append(el('div', 'det-lg', it.real ? it.lgn : (S && S.leagues[it.lg]) || ''), el('div', 'det-st' + (it.live ? ' live' : ''), (it.real ? it.meta.replace(it.lgn + ' · ', '') : it.meta) || ''));
  [it.h, it.a].forEach((t, i) => { const r = el('div', 'det-team'), n = el('div', 'det-tn'); n.append(crest(t), el('span', '', t.n)); r.append(n, el('b', 'det-sc', it.sc ? String(it.sc[i]) : '-')); hd.append(r); });
  if (dis && it.real && !it.fin) hd.append(el('p', 'det-warn', it.live ? 'Live betting on this game is paused for a moment (odds updating). Try again shortly.' : 'Betting on this game is closed.'));
  const secs = detSections(it, store, dis, redraw), tabs = el('div', 'det-tabs'); tabs.setAttribute('role', 'tablist');
  const have = DET_TABS.filter(([id]) => id === 'all' || secs.some(s => s.tab === id)); if (!have.some(([id]) => id === DET.tab)) DET.tab = 'all';
  have.forEach(([id, name]) => { const b = el('button', '', name); b.type = 'button'; b.setAttribute('aria-selected', String(DET.tab === id)); b.onclick = () => { DET.tab = id; renderDetail(); root.scrollTop = 0; }; tabs.append(b); });
  wrap.append(hd, tabs);
  const list = secs.filter(s => DET.tab === 'all' || s.tab === DET.tab);
  if (!list.length) wrap.append(el('p', 'empty', 'No markets here yet.'));
  list.forEach(s => {
    const box = el('section', 'det-sec'), h = el('button', 'det-sh'), shut = DET.shut.has(s.title); h.type = 'button'; h.setAttribute('aria-expanded', String(!shut));
    h.append(el('span', 'car', shut ? '▸' : '▾'), el('span', '', s.title)); h.onclick = () => { shut ? DET.shut.delete(s.title) : DET.shut.add(s.title); renderDetail(); };
    box.append(h); if (!shut) box.append(s.node); wrap.append(box);
  });
  root.append(wrap);
  const bar = el('div', 'det-bar'), bt = el('button', '', $('open').textContent); bt.type = 'button'; bt.disabled = $('open').disabled; bt.onclick = () => $('open').click(); bar.append(bt); root.append(bar);
  root.scrollTop = keep;
}

// ── booking codes: share a slip, load someone else's ─────────
async function shareCode(code, btn) {
  const link = location.origin + '/football#code=' + code;
  if (navigator.share) { try { await navigator.share({ title: 'Booking code ' + code, text: 'Booking code ' + code + ' — open it here: ' + link, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  copyText(link, btn, 'Link copied ✓');
}
function codeButtons(code) {                                           // Copy code · Copy link · Share
  const link = location.origin + '/football#code=' + code, a = el('button', 'btn-n small', 'Copy code'), b = el('button', 'btn-n small ghost-n', 'Copy link'), c = el('button', 'btn-n small ghost-n', 'Share');
  a.type = b.type = c.type = 'button'; a.onclick = () => copyText(code, a); b.onclick = () => copyText(link, b); c.onclick = () => shareCode(code, c);
  return [a, b, c];
}
const CODE_ST = { open: ['won', 'Added to slip'], closed: ['pend', 'Closing'], live: ['live', 'Live / started'], ended: ['pend', 'Started'], done: ['pend', 'Finished'], void: ['pend', 'Void'], nomarket: ['lost', 'No odds now'] };
function showCode(c) {
  const box = $('codeBox'); box.replaceChildren(); box.hidden = false;
  const added = c.legs.filter(l => l.st === 'open').length, h = el('div', 'cb-h'), x = el('button', 'cb-x', '×'); x.type = 'button'; x.onclick = () => { box.hidden = true; };
  h.append(el('b', '', 'Booking code ' + c.code + ' · ' + c.legs.length + ' game' + (c.legs.length > 1 ? 's' : '')), x); box.append(h);
  box.append(el('p', 's-muted small', added === c.legs.length ? 'All games are open. They are on your betslip with today\'s odds.'
    : added ? added + ' of ' + c.legs.length + ' games are open and on your betslip. The others have already started (or are locked) and cannot be bet on.'
    : 'None of these games can be bet on any more (started or locked). Prices on live games are not offered.'));
  c.legs.forEach(l => {
    const r = CODE_ST[l.st] || CODE_ST.ended, d = el('div', 'tk-leg'), a = el('div', 'tk-l1'), b = el('div', 'tk-l2');
    a.append(el('b', '', l.h + ' v ' + l.a), el('span', 'tk-st ' + r[0], l.st === 'done' && l.score ? 'Final ' + l.score : r[1]));
    b.append(el('span', '', mName(l.k) + ' · ' + pName(l.k, l.i)), el('b', '', l.odd != null && l.st === 'open' ? '@ ' + Number(l.odd).toFixed(2) : ''));
    d.append(a, b, el('div', 'tk-l3', (l.lg ? l.lg + ' · ' : '') + dayLabel(l.t) + ' · ' + fmtClock(l.t)));
    box.append(d);
  });
}
function showVCode(c) {
  const box = $('codeBoxV'); box.replaceChildren(); box.hidden = false;
  const added = c.legs.filter(l => l.odd != null).length, h = el('div', 'cb-h'), x = el('button', 'cb-x', '×'); x.type = 'button'; x.onclick = () => { box.hidden = true; };
  h.append(el('b', '', 'Booking code ' + c.code + ' · Round ' + c.round + ' · ' + c.legs.length + ' game' + (c.legs.length > 1 ? 's' : '')), x); box.append(h);
  box.append(el('p', 's-muted small', c.status === 'open' ? (added === c.legs.length ? 'All games are on your betslip. Place the bet before the round kicks off.' : added + ' of ' + c.legs.length + ' games are on your betslip. The others are locked.')
    : c.status === 'closed' ? 'Betting for this round has just closed.' : 'This code was for Round ' + c.round + ', which has already kicked off. Ask for a new code for the open round.'));
  c.legs.forEach(l => {
    const d = el('div', 'tk-leg'), a = el('div', 'tk-l1'), b = el('div', 'tk-l2');
    a.append(el('b', '', l.h + ' v ' + l.a), el('span', 'tk-st ' + (c.status === 'open' && l.odd != null ? 'won' : 'pend'), c.status === 'open' ? (l.odd != null ? 'Added to slip' : 'Locked') : 'Expired'));
    b.append(el('span', '', mName(l.k) + ' · ' + pName(l.k, l.i)), el('b', '', c.status === 'open' && l.odd != null ? '@ ' + Number(l.odd).toFixed(2) : ''));
    d.append(a, b, el('div', 'tk-l3', (l.lg || '') + ' · Round ' + c.round)); box.append(d);
  });
}
async function loadVCode(code) {
  try {
    const r = await fetch('/football/code/' + encodeURIComponent(code), { credentials: 'same-origin', cache: 'no-store' }), j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return toast(j.error === 'rate_limited' ? ERR.rate_limited : 'Booking code not found. Check it and try again.', true);
    setTab('v'); await load();
    if (j.status === 'open' && NX && NX.id === j.round) {
      picks = {}; j.legs.forEach(l => { if (l.odd != null) picks[l.m] = { k: l.k, i: l.i, odd: l.odd }; });
      if (j.legs.length && S) { UI.v.lg = Math.floor(j.legs[0].m / S.per); watched = UI.v.lg * S.per; buildLive(); }
    }
    showVCode(j); renderList(); renderBtn(); $('codeBoxV').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch { toast('No connection. Try again.', true); }
}
async function loadCode(code) {
  code = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); if (code.length < 4) return;
  if (code.length === 7) return loadVCode(code);                       // virtual codes have 7 characters, real-match codes 6
  for (let i = 0; i < 30 && (!R || rLoading); i++) { if (!R && !rLoading) loadReal(); await new Promise(r => setTimeout(r, 100)); }
  try {
    const r = await fetch('/football/real/code/' + encodeURIComponent(code), { credentials: 'same-origin', cache: 'no-store' }), j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return toast(j.error === 'rate_limited' ? ERR.rate_limited : 'Booking code not found. Check it and try again.', true);
    setTab('r'); await loadReal();
    Object.keys(rpicks).forEach(k => delete rpicks[k]);
    j.legs.forEach(l => { if (l.st === 'open' && l.odd != null && R && R.events.some(e => e.id === l.e && !e.closed)) rpicks[l.e] = { k: l.k, i: l.i, odd: l.odd }; });
    showCode(j); renderReal(); renderBtn(); $('codeBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch { toast('No connection. Try again.', true); }
}
$('codeForm').onsubmit = (e) => { e.preventDefault(); loadCode($('codeIn').value); };
$('codeFormV').onsubmit = (e) => { e.preventDefault(); loadCode($('codeInV').value); };
function showBook(code, snap, odds) {                                  // the booking-code card (like SportyBet's)
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  $('bkDate').textContent = z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  $('bkCode').textContent = code; $('bkOdds').textContent = odds.toFixed(2); $('bkPay').textContent = (100 * odds).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const box = $('bkSels'); box.replaceChildren();
  snap.forEach(s => { const r = el('div', 'bk-sel'), t = el('div', 'bk-s1'); t.append(el('b', '', s.pick), el('b', '', s.odd.toFixed(2))); r.append(t, el('span', '', s.t), el('span', 'mk', s.mk)); box.append(r); });
  $('bkAct').replaceChildren(...codeButtons(code)); if (!$('bookDlg').open) $('bookDlg').showModal();
}
$('bkClose').onclick = () => $('bookDlg').close();
$('mkCode').onclick = async () => {
  const real = slipMode === 'r', p = cur(); if (!Object.keys(p).length) return;
  const snap = Object.keys(p).map(m => ({ t: legInfo(m).t, pick: pName(p[m].k, p[m].i), mk: mName(p[m].k), odd: p[m].odd }));
  try {
    const body = real ? { picks: Object.keys(p).map(e => ({ e, k: p[e].k, i: p[e].i })) } : { round: S.nextId, picks: Object.keys(p).map(m => ({ m: +m, k: p[m].k, i: p[m].i })) };
    const r = await fetch(real ? '/football/real/code' : '/football/code', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) { $('msg').textContent = errText(j.error); return; }
    showBook(j.code, snap, total());
  } catch { $('msg').textContent = 'No connection. Try again.'; }
};

// ── my tickets (tap one to see exactly what you played) ─────
const RES = { won: ['won', 'Won'], lost: ['lost', 'Lost'], pend: ['pend', 'Pending'], void: ['pend', 'Void'] };
function tStatus(t, real) {
  if (real) return t.status === 'won' ? ['won', 'Won +' + fmt(t.win)] : t.status === 'lost' ? ['lost', 'Lost'] : t.status === 'void' ? ['pend', 'Refunded'] : ['pend', 'Open'];
  if (t.st === 'open') return ['pend', 'Open'];
  if (t.st === 'live') return ['live', 'In play'];
  const won = t.st === 'won' || (t.st === undefined && t.win > 0);
  return won ? ['won', 'Won +' + fmt(t.win)] : ['lost', 'Lost'];
}
function ticketCard(t, real) {
  const b = el('button', 'tk'); b.type = 'button';
  const st = tStatus(t, real), top = el('div', 'tk-top'), id = String(t.id || '').slice(0, 6).toUpperCase();
  top.append(el('b', '', 'Ticket ' + (id ? '#' + id : '') + ' · ' + (t.legs ? t.legs.length : t.n || t.picks.length) + ' pick' + ((t.legs ? t.legs.length : t.n || t.picks.length) > 1 ? 's' : '')), el('span', 'tk-st ' + st[0], st[1]));
  const sub = el('div', 'tk-sub'); sub.append(el('span', '', real ? 'Real matches' : 'Round ' + t.round), el('span', '', 'Stake ' + fmt(t.amount) + ' · Odds ' + Number(t.odds).toFixed(2)));
  b.append(top, sub, el('span', 'tk-go', 'View ticket  ›'));
  b.onclick = () => openTicket(t, real);
  return b;
}
function legs(t, real) { return real ? t.picks : (t.legs || []); }
const LOCK_MS = 60000;                                                // a game is locked once it is 1 minute from kick-off (same as the server)
const legStarted = (l) => !!l.t && Date.now() + roff >= l.t - LOCK_MS;
function canEdit(t, real) {                                           // can still change something on this ticket?
  if (real) return t.status === 'open' && !!R && R.on && t.picks.some(l => !legStarted(l));
  return t.st === 'open' && !!S && S.enabled && nleft() > 1500;
}
function openTicket(t, real) {
  curTk = { id: t.id, real };
  const box = $('tkBody'), L = legs(t, real), st = tStatus(t, real); box.replaceChildren();
  $('tkTitle').textContent = 'Ticket #' + String(t.id || '').slice(0, 8).toUpperCase();
  const head = el('div', 'tk-head'); head.append(el('span', 'tk-st ' + st[0], st[1]), el('span', 's-muted', real ? 'Real matches' + (t.edits ? ' · edited ' + t.edits + '×' : '') : 'Virtual · Round ' + t.round)); box.append(head);
  if (t.code && (real || t.st === 'open')) {                           // booking code of THIS ticket: copy it and send it to a friend (a virtual code works until its round kicks off)
    const c = el('div', 'tk-code'), lab = el('div'); lab.append(el('small', 's-muted', 'Booking code' + (real ? '' : ' · Round ' + t.round)), el('b', 'cd', t.code)); c.append(lab, ...codeButtons(t.code)); box.append(c);
  }
  if (!L.length) box.append(el('p', 'empty', 'This old ticket was saved before details were kept. It had ' + (t.n || '?') + ' picks.'));
  L.forEach(l => {
    const started = real && l.res === 'pend' && legStarted(l);
    const r = real && l.res === 'pend' && started ? ['live', l.live ? 'Live ' + l.live : 'Started'] : (RES[l.res] || RES.pend), d = el('div', 'tk-leg');
    const a = el('div', 'tk-l1'); a.append(el('b', '', l.h + ' v ' + l.a), el('span', 'tk-st ' + r[0], r[1]));
    const b = el('div', 'tk-l2'); b.append(el('span', '', mName(l.k) + ' · ' + pName(l.k, l.i)), el('b', '', '@ ' + Number(l.odd).toFixed(2)));
    d.append(a, b);
    if (l.score) d.append(el('div', 'tk-l3', 'Final score ' + l.score));
    else if (real && started && (l.live || l.ck)) d.append(el('div', 'tk-l3 live', '● ' + (l.live ? 'Score now ' + l.live : 'In play') + (l.ck ? ' · ' + [ckText(l.ck), leftText(l.ck)].filter(Boolean).join(' · ') : '')));
    else if (real && l.t) d.append(el('div', 'tk-l3', (started ? 'Started ' : 'Kick-off ') + fmtTime(l.t) + (real && t.status === 'open' && !started ? ' · you can still change this game' : (started && t.status === 'open' ? ' · locked' : ''))));
    box.append(d);
  });
  const sum = el('div', 'tk-sum'); const row = (a, b, cls) => { const r = el('div', 'row'); r.append(el('span', '', a), el('b', cls || '', b)); sum.append(r); };
  row('Stake', fmt(t.amount)); row('Total odds', Number(t.odds).toFixed(2));
  const open = real ? t.status === 'open' : (t.st === 'open' || t.st === 'live');
  if (open) row('Possible win', fmt(Math.floor(t.amount * t.odds)), 'win'); else if (t.win) row('Paid out', fmt(t.win), 'win'); else row('Paid out', t.status === 'void' ? fmt(t.amount) + ' (refund)' : '0');
  box.append(sum);
  if (canEdit(t, real)) {
    const eb = el('button', 'btn-n go', 'Edit this ticket'); eb.type = 'button'; eb.onclick = () => startEdit(t, real); box.append(eb);
    box.append(el('p', 's-muted small', real ? 'Games that have not started can be changed or removed, and you can add new ones or change the stake. Started games stay locked.' : 'You can change this ticket until the round kicks off.'));
  }
  if (!$('ticketDlg').open) $('ticketDlg').showModal();
}
$('tkClose').onclick = () => $('ticketDlg').close();
$('ticketDlg').addEventListener('close', () => { curTk = null; });
function renderMine() {
  const box = $('mine'), rb = $('realMine'); box.replaceChildren(); rb.replaceChildren();
  let open = 0;
  if (S) {
    const ids = new Set(S.mine.map(t => t.id)), list = [...S.mine.slice().reverse(), ...RC.filter(t => !ids.has(t.id))];
    open += S.mine.filter(t => t.st === 'open' || t.st === 'live').length;
    if (!list.length) box.append(el('p', 'empty', S.balance === null ? 'Log in to see your tickets.' : 'No virtual tickets yet. Pick matches in the next round and place a bet.'));
    list.forEach(t => box.append(ticketCard(t, false)));
  }
  if (!R || R.balance === null) rb.append(el('p', 'empty', 'Log in to see your tickets.'));
  else if (!R.mine.length) rb.append(el('p', 'empty', 'No real-match tickets yet.'));
  else { open += R.mine.filter(t => t.status === 'open').length; R.mine.forEach(t => rb.append(ticketCard(t, true))); }
  $('tabBtnB').textContent = '🎟️ My tickets' + (open ? ' (' + open + ')' : '');
}
function renderResults() {
  const box = $('results'); box.replaceChildren();
  if (!HI.length || !S) return box.append(el('p', 'empty', 'Results show here after the first full time.'));
  const h = HI[0], per = S.per, lg = UI.v.lg;
  $('resTitle').textContent = 'Last results · Round ' + h.id + ' · ' + S.leagues[lg];
  const g = el('div', 'res-grid'); h.r.slice(lg * per, (lg + 1) * per).forEach(x => g.append(el('span', '', x))); box.append(g);
}

// ── editing a ticket that was already placed ────────────────
function startEdit(t, real) {
  $('ticketDlg').close();
  if (real) {
    rpicks = {}; const locked = {}, keep = new Set();
    t.picks.forEach(l => { keep.add(l.e); const pk = { k: l.k, i: l.i, odd: l.odd, h: l.h, a: l.a, t: l.t }; if (legStarted(l)) locked[l.e] = pk; else rpicks[l.e] = pk; });
    editing = { real: true, id: t.id, locked, keep }; slipMode = 'r'; setTab('r');
  } else {
    picks = {}; t.legs.forEach(l => { picks[l.m] = { k: l.k, i: l.i, odd: l.odd }; });
    editing = { real: false, id: t.id, round: t.round, locked: {}, keep: new Set() }; slipMode = 'v'; setTab('v');
  }
  $('stake').value = String(t.amount);
  renderEditBar(); real ? renderReal() : renderList(); renderBtn(); renderSlip(); $('slip').showModal();
}
function endEdit() {
  const real = editing && editing.real; editing = null; if (real) rpicks = {}; else picks = {};
  if ($('slip').open) $('slip').close();
  renderEditBar(); real ? renderReal() : renderList(); renderBtn();
}
function renderEditBar() {
  const bar = $('editBar'); bar.hidden = !editing; if (!editing) return;
  bar.replaceChildren(el('b', '', 'Editing ticket #' + String(editing.id).slice(0, 6).toUpperCase()), el('span', 's-muted', ' Change games below (started games are locked), then save from the betslip.'));
  const o = el('button', 'btn-n small', 'Open betslip'), c = el('button', 'btn-n small ghost-n', 'Cancel edit'); o.type = c.type = 'button';
  o.onclick = () => { renderSlip(); $('slip').showModal(); }; c.onclick = endEdit; bar.append(o, c);
}

// ── betslip ─────────────────────────────────────────────────
function legInfo(m) {
  if (slipMode === 'r') { const ev = R && R.events.find(e => e.id === m), pk = rpicks[m] || (editing && editing.locked[m]); return ev ? { t: ev.h + ' v ' + ev.a } : pk && pk.h ? { t: pk.h + ' v ' + pk.a } : { t: 'Match' }; }
  const f = NX.fx[m]; return { t: f.h.n + ' v ' + f.a.n };
}
function renderSlip() {
  const box = $('sels'), p = cur(); box.replaceChildren();
  const ed = editing && (editing.real === (slipMode === 'r')) ? editing : null;
  $('slipTitle').textContent = (ed ? 'Edit ticket #' + String(ed.id).slice(0, 6).toUpperCase() : 'Betslip') + (slipMode === 'r' ? ' · Real matches' : ' · Round ' + (NX ? NX.id : ''));
  $('placeT').textContent = ed ? 'Save changes' : 'Place Bet'; $('slipN').textContent = String(slipCount());
  $('liveNote').hidden = !(slipMode === 'r' && Object.keys(p).some(e => { const ev = R && R.events.find(x => x.id === e); return ev && Date.now() + roff >= ev.t; }));
  lockedList().forEach(e => {                                         // started games: shown, cannot be removed
    const L = editing.locked[e], row = el('div', 'sel locked'), l = el('div'), r = el('div');
    l.append(el('b', '', L.h + ' v ' + L.a), el('span', '', mName(L.k) + ' · ' + pName(L.k, L.i) + ' · 🔒 started, locked'));
    r.append(el('b', '', L.odd.toFixed(2))); row.append(l, r); box.append(row);
  });
  Object.keys(p).forEach(m => {
    const row = el('div', 'sel'), x = el('button', 'sx', '✕'), body = el('div', 'sb'), top = el('div', 'st1');
    x.type = 'button'; x.setAttribute('aria-label', 'Remove');
    x.onclick = () => { delete p[m]; slipMode === 'r' ? renderReal() : renderList(); renderBtn(); slipCount() ? renderSlip() : $('slip').close(); };
    top.append(el('b', '', pName(p[m].k, p[m].i)), el('b', 'od' + (p[m].moved ? ' ' + p[m].moved : ''), (p[m].moved === 'up' ? '▲ ' : p[m].moved === 'down' ? '▼ ' : '') + p[m].odd.toFixed(2)));
    body.append(top, el('span', '', legInfo(m).t), el('span', 'mk', mName(p[m].k)));
    row.append(x, body); box.append(row);
  });
  $('mkCode').hidden = !Object.keys(p).length || !!ed;
  $('tot').textContent = total().toFixed(2);
  $('win').textContent = fmt(Math.floor(parseAmt($('stake').value) * total()));
  $('payNote').textContent = 'About to pay ' + fmt(parseAmt($('stake').value));
}
$('open').onclick = () => { $('msg').textContent = ''; $('codeOut').hidden = true; renderSlip(); $('slip').showModal(); };
$('slipClear').onclick = () => { const p = cur(); Object.keys(p).forEach(k => delete p[k]); slipMode === 'r' ? renderReal() : renderList(); renderBtn(); $('slip').close(); };
$('close').onclick = () => $('slip').close();
$('stake').oninput = renderSlip;
document.querySelectorAll('.chips [data-set]').forEach(b => b.onclick = () => {
  const bal = slipMode === 'r' ? (R && R.balance) : (S && S.balance);
  $('stake').value = b.dataset.set === 'max' ? String(bal || 0) : b.dataset.set; renderSlip();
});
$('place').onclick = async () => {
  if (busy) return;
  const amount = parseAmt($('stake').value), p = cur(), real = slipMode === 'r', ed = editing && editing.real === real ? editing : null;
  if (amount < 1) { $('msg').textContent = ERR.bad_amount; return; }
  Object.values(p).forEach(x => { delete x.moved; });                       // the player has now seen the price on the slip
  busy = true; $('place').disabled = true; $('msg').textContent = '';
  try {
    const all = real ? [...lockedList().map(e => ({ e, k: editing.locked[e].k, i: editing.locked[e].i })), ...Object.keys(p).map(e => ({ e, k: p[e].k, i: p[e].i, odd: p[e].odd }))]
      : Object.keys(p).map(m => ({ m: +m, k: p[m].k, i: p[m].i }));
    const body = real ? { amount, picks: all } : { round: S.nextId, amount, picks: all };
    if (ed) body.id = ed.id;
    const url = (ed ? (real ? '/football/real/edit' : '/football/edit') : (real ? '/football/real/bet' : '/football/bet'));
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) { $('msg').textContent = errText(j.error); if (j.error === 'stale') { picks = {}; load(); } if (j.error === 'locked_leg' || j.error === 'closed') loadReal(); if (j.error === 'odds_changed' || j.error === 'live_goal' || j.error === 'live_wait') { await loadReal(); if ($('slip').open && slipCount()) renderSlip(); } }
    else {
      Object.keys(p).forEach(k => delete p[k]); editing = null; renderEditBar(); $('slip').close();
      real ? renderReal() : renderList(); renderBtn(); await Promise.all([load(), loadReal()]);
      const find = () => { const mine = real ? (R && R.mine) : (S && S.mine); return mine && mine.find(x => x.id === j.id); };
      let t = find(); if (!t) { await new Promise(r => setTimeout(r, 400)); await Promise.all([load(), loadReal()]); t = find(); }
      if (t) openTicket(t, real);                                   // show the ticket right away, with its booking code to copy
      else toast(ed ? 'Ticket updated.' : 'Bet placed.', false, true);
    }
  } catch { $('msg').textContent = 'No connection. Try again.'; }
  busy = false; $('place').disabled = false;
};

// ── match info (chart icon): head to head + live statistics ──
let infoIt = null, infoTab = 'h2h', infoData = null, infoTimer = 0;
const shortDate = (d) => new Date(d).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
async function openInfo(it) {
  infoIt = it; infoData = null; infoTab = it.live || it.fin ? 'stats' : 'h2h';
  $('infoTitle').textContent = it.h.n + ' v ' + it.a.n; $('infoBody').replaceChildren(el('p', 'empty', 'Loading…'));
  renderInfoTabs(); if (!$('infoDlg').open) $('infoDlg').showModal();
  await loadInfo(); clearInterval(infoTimer); infoTimer = setInterval(() => { if ($('infoDlg').open) loadInfo(); else clearInterval(infoTimer); }, 15000);
}
async function loadInfo() {
  if (!infoIt) return;
  try {
    const r = await fetch('/football/real/info/' + encodeURIComponent(infoIt.id), { credentials: 'same-origin', cache: 'no-store' });
    infoData = await r.json().catch(() => ({ ok: false })); if (!r.ok) infoData = { ok: false };
  } catch { infoData = { ok: false }; }
  renderInfo();
}
function renderInfoTabs() {
  const box = $('infoTabs'); box.replaceChildren();
  [['stats', 'Live statistics'], ['h2h', 'H2H']].forEach(([k, t]) => { const b = el('button', 'lt', t); b.type = 'button'; b.setAttribute('aria-selected', String(infoTab === k)); b.onclick = () => { infoTab = k; renderInfoTabs(); renderInfo(); }; box.append(b); });
}
function renderInfo() {
  const d = infoData, body = $('infoBody'), head = $('infoHead'); body.replaceChildren(); head.replaceChildren();
  if (!d) return;
  const it = infoIt, sc = d.sc || it.sc, ck = d.ck;
  const top = el('div', 'inf-top');
  top.append(el('div', 'inf-lg', (d.lg || it.lgn || '') + ' · ' + fmtTime(d.t || it.t)));
  top.append(el('div', 'inf-clock' + (d.fin ? '' : (sc ? ' live' : '')), d.fin ? 'Full time' : sc ? [ckText(ck), leftText(ck)].filter(Boolean).join(' · ') : 'Starts ' + fmtClock(d.t || it.t)));
  const row = el('div', 'inf-score'); const tc = (t) => { const x = el('div', 'inf-team'); x.append(crest(t), el('b', '', t.n)); return x; };
  row.append(tc(it.h), el('span', 'big', sc ? sc[0] + ' : ' + sc[1] : 'vs'), tc(it.a)); top.append(row); head.append(top);
  if (d.ok === false) { body.append(el('p', 'empty', 'No data available right now.')); return; }
  if (infoTab === 'h2h') {
    const H = d.h2h, F = d.form;
    if (!H && !F) return body.append(el('p', 'empty', 'No previous matches found for these teams yet.'));
    const two = (l, mid, r, cls) => { const x = el('div', 'h2h-line' + (cls ? ' ' + cls : '')); x.append(el('b', 'l', l), el('span', 'm', mid), el('b', 'r', r)); return x; };
    const fx = (v) => v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1);
    if (H) {
      body.append(el('div', 'h2h-title', 'Previous meetings'));
      const s = H.sum, tot = s[0] + s[1] + s[2] || 1, sm = el('div', 'h2h-sum');
      [[it.h.n, 'wins', s[0], 'hw'], ['', 'draws', s[1], 'dr'], [it.a.n, 'wins', s[2], 'aw']].forEach(([n, k, v, c]) => { const x = el('div', c); x.append(el('small', '', n), el('small', '', k), el('b', '', String(v))); sm.append(x); });
      body.append(sm);
      const bar = el('div', 'h2h-bar'); [['hw', s[0]], ['dr', s[1]], ['aw', s[2]]].forEach(([c, v]) => { const i = el('i', c); i.style.flexGrow = String(v); if (v) bar.append(i); }); body.append(bar);
      body.append(el('div', 'h2h-title', 'Highest win'));
      const bw = (b) => b ? b.s + ' · ' + shortDate(b.d) : 'N/A'; body.append(two(bw(H.best[0]), '', bw(H.best[1]), 'small'));
      body.append(el('div', 'h2h-title', 'Averages'));
      body.append(two(fx(H.avg.pts[0]), 'Points', fx(H.avg.pts[1])), two(fx(H.avg.gf[0]), 'Goals scored', fx(H.avg.gf[1])));
      H.rows.forEach(r => { const x = el('div', 'h2h-row'); x.append(el('small', '', shortDate(r.d) + (r.lg ? ' · ' + r.lg : '')), el('span', '', r.h), el('b', '', r.gh + ' : ' + r.ga), el('span', '', r.a)); body.append(x); });
    } else body.append(el('p', 'empty', 'These two teams have no recorded meetings.'));
    if (F) {
      const pill = (r) => el('i', 'fp ' + r, r);
      body.append(el('div', 'h2h-title', 'Last 5 matches · form'));
      const fr = el('div', 'h2h-line'); [F.h, F.a].forEach((t, i) => { const w = el('div', 'fps' + (i ? ' r' : '')); if (t) t.rows.forEach(r => w.append(pill(r.r))); else w.append(el('small', '', 'N/A')); fr.append(w); });
      fr.insertBefore(el('span', 'm', 'Form'), fr.lastChild); body.append(fr);
      const row = (label, g) => two(F.h ? g(F.h) : '-', label, F.a ? g(F.a) : '-');
      body.append(row('Win / Draw / Loss', t => t.w + ' / ' + t.d + ' / ' + t.l), row('Avg goals scored', t => fx(t.gf)), row('Avg goals conceded', t => fx(t.ga)),
        row('Both teams scored', t => t.btts + '%'), row('Over 1.5', t => t.o15 + '%'), row('Over 2.5', t => t.o25 + '%'));
      [[it.h.n, F.h], [it.a.n, F.a]].forEach(([n, t]) => {
        if (!t) return; body.append(el('div', 'h2h-title', n));
        t.rows.forEach(r => { const x = el('div', 'h2h-row'); x.append(el('small', '', shortDate(r.d) + (r.lg ? ' · ' + r.lg : '')), el('span', '', r.h), el('b', '', r.gh + ' : ' + r.ga), el('span', '', r.a)); body.append(x); });
      });
    }
  } else {
    if (!d.stats || !d.stats.length) return body.append(el('p', 'empty', sc || d.fin ? 'Live statistics are not available for this match.' : 'Statistics show here when the game starts.'));
    d.stats.forEach(r => {
      const a = Number(r.h) || 0, b = Number(r.a) || 0, pct = String(r.h).includes('%'), ta = pct ? parseFloat(r.h) || 0 : a, tb = pct ? parseFloat(r.a) || 0 : b, tot = ta + tb;
      const x = el('div', 'st-row'), bar = el('div', 'st-bar');
      const l = el('i'), rr = el('i'); l.style.width = (tot ? ta / tot * 100 : 50) + '%'; rr.style.width = (tot ? tb / tot * 100 : 50) + '%'; bar.append(l, rr);
      const top2 = el('div', 'st-top'); top2.append(el('b', '', r.h === null ? '-' : String(r.h)), el('span', '', r.k), el('b', '', r.a === null ? '-' : String(r.a)));
      x.append(top2, bar); body.append(x);
    });
  }
}
$('infoClose').onclick = () => $('infoDlg').close();
$('infoDlg').addEventListener('close', () => { clearInterval(infoTimer); infoIt = null; });

// ── TV ──────────────────────────────────────────────────────
const cv = $('fbcv'), ctx = cv.getContext('2d'), W = 800, H = 450;
const F442 = [[.05, .5], [.18, .15], [.18, .38], [.18, .62], [.18, .85], [.38, .15], [.38, .38], [.38, .62], [.38, .85], [.5, .38], [.5, .62]];
let ball = [W / 2, H / 2], target = [W / 2, H / 2], nextPick = 0, flash = null, done = new Set(), lastKey = '', ref = [W / 2, H / 2];
const CROWD = Array.from({ length: 2 * 96 }, (_, i) => ({ x: 22 + (i % 96) * ((W - 44) / 95), top: i < 96, row: i % 2, c: ['#e5322d', '#2a5bd7', '#fdd835', '#f2f2f2', '#35d07f', '#a50044', '#ff8a1f'][(i * 7 + (i >> 2)) % 7] }));
function pitch() {
  ctx.fillStyle = '#0e7a38'; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 10; i++) { ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.05)'; ctx.fillRect(i * W / 10, 0, W / 10, H); }
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, W - 40, H - 40); ctx.beginPath(); ctx.moveTo(W / 2, 20); ctx.lineTo(W / 2, H - 20); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 55, 0, 7); ctx.stroke();
  [[20, 1], [W - 20, -1]].forEach(([x, d]) => {
    ctx.strokeRect(d > 0 ? x : x - 120, H / 2 - 100, 120, 200); ctx.strokeRect(d > 0 ? x : x - 45, H / 2 - 45, 45, 90);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(d > 0 ? x - 10 : x, H / 2 - 38, 10, 76);
  });
}
function crowd(t, cheer) {          // the people in the stands (top and bottom touchlines)
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W, 19); ctx.fillRect(0, H - 19, W, 19);
  CROWD.forEach((p, i) => {
    const y = (p.top ? 6 : H - 14) + p.row * 7 - (cheer ? Math.abs(Math.sin(t * 9 + i)) * 4 : Math.sin(t * 1.5 + i) * .8);
    ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x + (p.row ? 4 : 0), y, 3.1, 0, 7); ctx.fill();
  });
}
function person(x, y, r, fill, edge) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = 2; ctx.stroke(); }

const cvImgs = {};
function cvLogo(t) {                                                   // a club logo for the TV scoreboard (drawn once it has loaded)
  const u = t.l || LOGOS[t.n]; if (!u) return null; let im = cvImgs[u];
  if (!im) { im = cvImgs[u] = new Image(); im.referrerPolicy = 'no-referrer'; im.src = u; im.onerror = () => { if (t.l === u) t.l = ''; delete LOGOS[t.n]; }; }
  return im.complete && im.naturalWidth ? im : null;
}
function draw(now) {
  requestAnimationFrame(draw);
  if (!S || !CU) { pitch(); return; }
  const c = cphase(), f = CU.fx[watched] || CU.fx[0], [sh, sa] = score(f, c.min), t = now / 1000, playing = c.ph === 'play';
  const key = CU.id + '-' + f.id;
  if (key !== lastKey) {            // new match on screen: goals that already happened must NOT replay as "GOAL!"
    lastKey = key; flash = null; ball = [W / 2, H / 2]; target = [W / 2, H / 2];
    done = new Set((f.goals || []).filter(g => g.m <= c.min));
  }
  if (playing && f.goals) {
    const up = f.goals.find(g => !done.has(g) && g.m - c.min <= 3 && g.m > c.min);
    if (up) target = [up.side ? 24 : W - 24, H / 2 + Math.sin(up.m) * 40];
    else if (now > nextPick) { const side = Math.random() < .5; target = [side ? 80 + Math.random() * 320 : 400 + Math.random() * 320, 40 + Math.random() * (H - 80)]; nextPick = now + 900 + Math.random() * 700; }
    f.goals.forEach(g => { if (!done.has(g) && g.m <= c.min) { done.add(g); flash = { t: now, side: g.side }; ball = [W / 2, H / 2]; target = [W / 2, H / 2]; } });
  } else target = [W / 2, H / 2];
  const k = playing ? .055 : .08; ball[0] += (target[0] - ball[0]) * k; ball[1] += (target[1] - ball[1]) * k;
  pitch();
  crowd(t, flash && now - flash.t < 2600);
  [0, 1].forEach(side => {
    F442.forEach(([fx, fy], i) => {
      let x = side ? W - fx * W * .9 - 20 : fx * W * .9 + 20, y = fy * (H - 60) + 30;
      x += (playing ? (ball[0] - W / 2) * .22 : 0) * (i ? 1 : .3) + Math.sin(t * 1.4 + i * 1.7 + side) * (playing ? 9 : 2);
      y += Math.cos(t * 1.1 + i * 2.3) * (playing ? 8 : 2) + (playing ? (ball[1] - H / 2) * .1 : 0);
      person(x, y, 10, i ? (side ? f.a : f.h).col : '#f4c20d', i ? (side ? '#fff' : 'rgba(0,0,0,.45)') : '#111');   // goalkeeper (i = 0) wears a different colour
    });
  });
  ref[0] += (ball[0] - ref[0] - 26) * .04; ref[1] += (ball[1] - ref[1] + 22) * .04;
  person(ref[0], ref[1], 8, '#111', '#ffd23f');
  person(Math.max(40, Math.min(W - 40, ball[0])), 29, 7, '#ffd23f', '#111'); person(Math.max(40, Math.min(W - 40, ball[0] * .9 + 40)), H - 29, 7, '#ffd23f', '#111');
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(ball[0] + 3, ball[1] + 6, 7, 3, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ball[0], ball[1], 6.5, 0, 7); ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = '700 22px Segoe UI,Roboto,sans-serif'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(24, 26, 420, 40);
  ctx.fillStyle = f.h.col; ctx.fillRect(24, 26, 6, 40); const lh = cvLogo(f.h), la = cvLogo(f.a);
  if (lh) ctx.drawImage(lh, 36, 31, 30, 30);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(f.h.c, lh ? 72 : 40, 46);
  ctx.textAlign = 'center'; ctx.fillStyle = '#ffd23f'; ctx.fillText(sh + '  -  ' + sa, 196, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.fillText(f.a.c, la ? 318 : 350, 46);
  if (la) ctx.drawImage(la, 324, 31, 30, 30);
  ctx.fillStyle = f.a.col; ctx.fillRect(356, 26, 6, 40);
  ctx.fillStyle = '#d93a3a'; ctx.fillRect(368, 26, 76, 40); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 18px Segoe UI,sans-serif';
  ctx.fillText(c.ph === 'wait' ? "0'" : playing ? (c.min === 45 ? 'HT' : c.min + "'") : 'FT', 406, 46);
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(W - 150, 26, 126, 28); ctx.fillStyle = '#fff'; ctx.font = '600 13px Segoe UI,sans-serif'; ctx.fillText('VIRTUAL LEAGUE', W - 87, 40);
  const banner = (a, b) => { ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fillRect(0, H / 2 - 60, W, 120); ctx.fillStyle = '#fff'; ctx.font = '800 40px Segoe UI,sans-serif'; ctx.textAlign = 'center'; ctx.fillText(a, W / 2, H / 2 - 14); ctx.font = '600 20px Segoe UI,sans-serif'; ctx.fillStyle = '#ffd23f'; ctx.fillText(b, W / 2, H / 2 + 28); };
  if (!playing) banner('FULL TIME  ' + sh + ' - ' + sa, 'Next kick-off in ' + mmss(nleft()) + ' · book the next round now');
  else if (flash && now - flash.t < 2600) { const g = flash.side ? f.a : f.h; ctx.fillStyle = g.col; ctx.globalAlpha = .3 + .2 * Math.sin((now - flash.t) / 90); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; banner('GOAL!', g.n + '  ' + sh + ' - ' + sa); }
  ctx.fillStyle = 'rgba(0,0,0,.05)'; for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
}

setInterval(paint, 250);
setInterval(load, 1000);
let lastReal = 0;
setInterval(() => {
  const liveNow = !!R && R.events.some(e => !e.fin && Date.now() + roff >= e.t), gap = liveNow ? 7000 : 15000;
  if (Date.now() - lastReal < gap) return; lastReal = Date.now();
  if (tab !== 'v') loadReal(); else if (R) renderReal();
}, 2000);
load(); loadReal(); loadLogos(); setInterval(loadLogos, 12000); requestAnimationFrame(draw);
if (/^#code=/i.test(location.hash)) { setTab('r'); loadCode(location.hash.slice(6)); } else if (location.hash === '#real') setTab('r'); else if (location.hash === '#bets' || location.hash === '#tickets') setTab('b');

// ── the round booking-code / betslip button (like SportyBet) ──
$('fab').onclick = () => {
  const real = tab !== 'v'; $('codeFormV').hidden = real; $('codeForm').hidden = !real;
  if (slipCount()) { $('open').onclick(); return; }                    // picks on the slip: go straight to the betslip (no code box)
  $('codeDlg').showModal(); setTimeout(() => $(real ? 'codeIn' : 'codeInV').focus(), 50);
};
$('codeClose').onclick = () => $('codeDlg').close();
['codeForm', 'codeFormV'].forEach(id => $(id).addEventListener('submit', () => $('codeDlg').close()));
renderBtn();
