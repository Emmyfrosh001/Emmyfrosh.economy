'use strict';
// Crash plane — browser side. The server owns the round and the crash point; this file only draws it
// and sends bet / cancel / cash-out requests.
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();

const ERR = {
  not_logged_in: 'Please log in first.',
  bad_amount: 'Enter a valid stake (1 or more).',
  bad_auto: 'Auto cash out must be 1.01x or more.',
  already_bet: 'This panel already has a bet.',
  insufficient: 'Not enough credits for that stake.',
  no_bet: 'There is no bet to do that with.',
  too_late: 'Too late. The plane already flew away.',
  rate_limited: 'Slow down a little and try again.',
  not_needed: 'You still have credits.',
  bad_request: 'Something went wrong. Refresh the page.'
};

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || 'failed');
  return j;
}

let toastT;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 's-toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4500);
}

// "any amount": 250, 1,500, 2.5k, 1m …
function parseAmt(s) {
  const m = String(s).toLowerCase().replace(/[,\s_]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return 0;
  return Math.floor(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
}
function parseX(s) { const v = Number(String(s).replace(',', '.').replace(/x/i, '').trim()); return Number.isFinite(v) && v >= 1.01 && v <= 1000 ? Math.floor(v * 100) / 100 : 0; }

// ── state ───────────────────────────────────────────────────
let S = null;                  // last snapshot from the server
let off = 0;                   // server clock minus browser clock
const pending = [false, false];
const autoTried = [0, 0];      // round id we already auto-bet for
let prevRound = null;          // { id, hash, seed } of the round that just ended (for the fairness box)
let lastPhase = '';

const panels = [0, 1].map(i => {
  const el = document.querySelector(`.panel[data-slot="${i}"]`);
  return { el, amt: el.querySelector('.amt'), autoOn: el.querySelector('.autoOn'), autoAt: el.querySelector('.autoAt'), autoBet: el.querySelector('.autoBet'), go: el.querySelector('.go'), key: '' };
});

// remember each panel's settings on this device
function loadPrefs() {
  panels.forEach((p, i) => {
    try {
      const j = JSON.parse(localStorage.getItem('crash.p' + i) || '{}');
      if (j.amt) p.amt.value = j.amt;
      if (j.at) p.autoAt.value = j.at;
      p.autoOn.checked = !!j.on;
    } catch {}
  });
}
function savePrefs() {
  panels.forEach((p, i) => { try { localStorage.setItem('crash.p' + i, JSON.stringify({ amt: p.amt.value, at: p.autoAt.value, on: p.autoOn.checked })); } catch {} });
}
loadPrefs();

const balance = () => (S && S.me ? S.me.balance : 0);
const serverNow = () => Date.now() + off;
function multNow() { return S && S.phase === 'flying' ? Math.exp(S.rate * (serverNow() - S.startAt) / 1000) : S && S.phase === 'crashed' ? S.crash : 1; }

// ── live stream ─────────────────────────────────────────────
let es;
function connect() {
  es = new EventSource('/aviator/stream');
  es.addEventListener('s', (e) => { try { onSnap(JSON.parse(e.data)); } catch {} });
  es.onopen = () => { $('conn').hidden = true; };
  es.onerror = () => { $('conn').hidden = false; };
}

function onSnap(s) {
  off = s.now - Date.now();
  if (s.phase === 'crashed' && lastPhase !== 'crashed') {
    prevRound = { id: s.id, hash: s.hash, seed: s.seed };
    $('live').textContent = 'The plane flew away at ' + s.crash.toFixed(2) + 'x';
    showFair();
  }
  lastPhase = s.phase;
  S = s;

  const me = !!s.me;
  $('balChip').hidden = !me; $('hdLogin').hidden = me; $('hdSignup').hidden = me; $('loginNote').hidden = me;
  if (me) $('bal').textContent = fmt(s.me.balance);
  $('refill').hidden = !(me && s.me.balance < 100 && !s.me.bets.length);

  renderHist(); renderBets(); renderFairHead();
  autoBets();
  renderPanels(true);
}

function renderHist() {
  const h = $('hist'); h.replaceChildren();
  for (const v of S.history) {
    const sp = document.createElement('span');
    sp.className = v >= 10 ? 'c3' : v >= 2 ? 'c2' : 'c1';
    sp.textContent = v.toFixed(2) + 'x';
    h.append(sp);
  }
}

function renderBets() {
  const rows = $('betRows'); rows.replaceChildren();
  for (const b of S.bets) {
    const tr = document.createElement('tr');
    tr.className = b.cashed != null ? 'won' : (S.phase === 'crashed' ? 'lost' : '');
    const a = document.createElement('td'); a.textContent = b.name;
    const st = document.createElement('td'); st.className = 'n'; st.textContent = fmt(b.amount);
    const c = document.createElement('td'); c.className = 'n';
    c.textContent = b.cashed != null ? b.cashed.toFixed(2) + 'x  +' + fmt(b.win) : '–';
    tr.append(a, st, c); rows.append(tr);
  }
  $('betsEmpty').hidden = S.bets.length > 0;
  $('plCount').textContent = S.players ? S.players + (S.players === 1 ? ' bet' : ' bets') : '';
}

function renderFairHead() { $('fRound').textContent = '#' + S.id; $('fHash').textContent = S.hash; }
async function showFair() {
  if (!prevRound) return;
  $('fSeed').textContent = prevRound.seed; $('fOk').textContent = ''; $('fOk').className = '';
  try {
    if (!(window.crypto && crypto.subtle)) return;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prevRound.seed));
    const hex = [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
    const ok = hex === prevRound.hash;
    $('fOk').textContent = ok ? '✓ matches the hash shown before the flight' : '✗ does not match';
    $('fOk').className = ok ? '' : 'bad';
  } catch {}
}

// ── bet panels ──────────────────────────────────────────────
// which bet does this panel show right now, and what should its button do?
function panelState(i) {
  const me = S && S.me;
  if (!S) return { text: 'CONNECTING…', act: null };
  if (!me) return { text: 'LOG IN TO PLAY', act: 'login' };
  const mine = me.bets.filter(b => b.slot === i);
  const live = mine.find(b => !b.next), nxt = mine.find(b => b.next);
  if (live && S.phase === 'flying' && live.cashed == null) return { text: 'CASH OUT', sub: fmt(Math.floor(live.amount * multNow())), cls: 'cash', act: 'cash' };
  if (nxt) return { text: 'CANCEL', sub: 'bet for next round', cls: 'cancel', act: 'cancel' };
  if (live && S.phase === 'waiting') return { text: 'CANCEL', sub: fmt(live.amount) + ' staked', cls: 'cancel', act: 'cancel' };
  if (live && live.cashed != null) return { text: 'WON +' + fmt(live.win), sub: 'cashed out at ' + live.cashed.toFixed(2) + 'x', cls: 'won', act: null };
  if (live) return { text: 'LOST', sub: '−' + fmt(live.amount), cls: 'lost', act: null };
  const amt = parseAmt(panels[i].amt.value);
  return S.phase === 'waiting'
    ? { text: 'BET', sub: amt ? fmt(amt) : '', act: 'bet' }
    : { text: 'BET', sub: 'for next round', act: 'bet' };
}

function renderPanels(force) {
  panels.forEach((p, i) => {
    const st = panelState(i);
    const key = st.text + '|' + (st.sub || '') + '|' + (st.cls || '') + '|' + pending[i];
    if (!force && key === p.key) return;
    p.key = key;
    p.go.className = 'go' + (st.cls ? ' ' + st.cls : '');
    p.go.disabled = !st.act || pending[i];
    p.go.replaceChildren(document.createTextNode(st.text));
    if (st.sub) { const s = document.createElement('small'); s.textContent = st.sub; p.go.append(s); }
  });
}

function autoBets() {
  if (!S || !S.me || S.phase !== 'waiting') return;
  panels.forEach((p, i) => {
    if (!p.autoBet.checked || pending[i] || autoTried[i] === S.id) return;
    if (S.me.bets.some(b => b.slot === i)) return;
    autoTried[i] = S.id;
    placeBet(i, true);
  });
}

async function placeBet(i, quiet) {
  const p = panels[i];
  const amount = parseAmt(p.amt.value);
  if (!amount) return toast(ERR.bad_amount, true);
  let auto = null;
  if (p.autoOn.checked) { auto = parseX(p.autoAt.value); if (!auto) return toast(ERR.bad_auto, true); }
  pending[i] = true; renderPanels(true);
  try {
    const r = await api('/aviator/bet', { slot: i, amount, auto });
    if (S && S.me) { S.me.balance = r.balance; S.me.bets.push({ slot: i, amount, auto, cashed: null, win: null, next: S.phase !== 'waiting' }); $('bal').textContent = fmt(r.balance); }
  } catch (e) {
    if (quiet && e.message === 'insufficient') p.autoBet.checked = false;
    toast(ERR[e.message] || 'Could not place the bet.', true);
  } finally { pending[i] = false; renderPanels(true); }
}

async function cancelBet(i) {
  pending[i] = true; renderPanels(true);
  try {
    const r = await api('/aviator/cancel', { slot: i });
    if (S && S.me) {
      const k = S.me.bets.findIndex(b => b.slot === i && (b.next || S.phase === 'waiting'));
      if (k >= 0) S.me.bets.splice(k, 1);
      S.me.balance = r.balance; $('bal').textContent = fmt(r.balance);
    }
  } catch (e) { toast(ERR[e.message] || 'Could not cancel.', true); }
  finally { pending[i] = false; renderPanels(true); }
}

async function cashOut(i) {
  pending[i] = true; renderPanels(true);
  try {
    const r = await api('/aviator/cashout', { slot: i });
    if (S && S.me) {
      const b = S.me.bets.find(x => x.slot === i && !x.next);
      if (b) { b.cashed = r.at; b.win = r.win; }
      S.me.balance = r.balance; $('bal').textContent = fmt(r.balance);
    }
    toast('Cashed out at ' + r.at.toFixed(2) + 'x  ·  won ' + fmt(r.win));
  } catch (e) { toast(ERR[e.message] || 'Could not cash out.', true); }
  finally { pending[i] = false; renderPanels(true); }
}

panels.forEach((p, i) => {
  p.go.addEventListener('click', () => {
    const st = panelState(i);
    if (pending[i] || !st.act) return;
    if (st.act === 'login') { location.href = '/login?next=%2Faviator'; return; }
    savePrefs();
    if (st.act === 'bet') placeBet(i);
    else if (st.act === 'cancel') cancelBet(i);
    else if (st.act === 'cash') cashOut(i);
  });
  p.el.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t || t === p.go) return;
    const cur = parseAmt(p.amt.value) || 0;
    if (t.dataset.set) p.amt.value = t.dataset.set === 'max' ? String(Math.max(1, balance())) : t.dataset.set;
    else if (t.dataset.act === 'plus') p.amt.value = String(Math.max(1, cur + stepFor(cur)));
    else if (t.dataset.act === 'minus') p.amt.value = String(Math.max(1, cur - stepFor(cur - 1)));
    savePrefs(); renderPanels(true);
  });
  p.amt.addEventListener('input', () => { savePrefs(); renderPanels(true); });
  p.autoAt.addEventListener('input', savePrefs);
  p.autoOn.addEventListener('change', savePrefs);
});
// +/- steps grow with the stake so any amount is quick to reach
function stepFor(n) { return n >= 1e6 ? 100000 : n >= 1e5 ? 10000 : n >= 1e4 ? 1000 : n >= 1e3 ? 100 : n >= 100 ? 10 : 1; }

$('refill').addEventListener('click', async () => {
  try { const r = await api('/aviator/refill', {}); if (S && S.me) S.me.balance = r.balance; $('bal').textContent = fmt(r.balance); $('refill').hidden = true; toast('Practice credits added.'); }
  catch (e) { toast(ERR[e.message] || 'Could not add credits.', true); }
});

// ── canvas ──────────────────────────────────────────────────
const cv = $('cv'), g = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
function resize() {
  const r = cv.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2.5); W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
}
new ResizeObserver(resize).observe(cv);
resize();

const plane = new Image(); let planeOk = false;
plane.onload = () => { planeOk = true; }; plane.src = '/plane.svg';

const FONT = '"Avenir Next","Segoe UI",system-ui,-apple-system,Roboto,sans-serif';
const RED = '#e5163c';
const WAIT_TOTAL = 6000;

function drawRays(cx, cy, rot, alpha) {
  const R = Math.hypot(W, H) * 1.2, n = 20;
  g.save(); g.translate(cx, cy); g.rotate(rot);
  g.fillStyle = `rgba(255,255,255,${alpha})`;
  for (let i = 0; i < n; i++) { g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, i * 2 * Math.PI / n, (i + 0.5) * 2 * Math.PI / n); g.closePath(); g.fill(); }
  g.restore();
}

function niceStep(list, min) { for (const s of list) if (s >= min) return s; return list[list.length - 1]; }

function draw() {
  requestAnimationFrame(draw);
  if (!W || !H) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const now = serverNow(), t = performance.now();
  const phase = S ? S.phase : 'waiting';

  const pl = Math.max(38, W * 0.07), pb = 30, pt = 16, pr = Math.max(14, W * 0.03);
  const PW = W - pl - pr, PH = H - pt - pb;
  const ox = pl, oy = H - pb;                     // where the curve starts (bottom-left of the plot)

  // time in the flight (seconds) and the multiplier
  let ts = 0, m = 1;
  if (S && phase === 'flying') { ts = Math.max(0, (now - S.startAt) / 1000); m = Math.exp(S.rate * ts); }
  else if (S && phase === 'crashed') { ts = Math.log(S.crash) / S.rate; m = S.crash; }
  const rate = S ? S.rate : 0.075;

  // background
  g.fillStyle = '#0b0d17'; g.fillRect(0, 0, W, H);
  const bg = g.createRadialGradient(ox, oy, 10, ox, oy, Math.hypot(W, H));
  bg.addColorStop(0, '#1d1530'); bg.addColorStop(1, '#0b0d17');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  drawRays(ox, oy, t / (phase === 'flying' ? 9000 : 26000), phase === 'crashed' ? 0.018 : 0.035);

  // the "camera": the plot rescales as the plane climbs, exactly so the plane settles on the upper right
  const Xs = Math.max(8, ts / 0.8);                         // seconds across the plot
  const Ys = Math.max(0.9, (m - 1) / 0.72);                 // multiplier units up the plot
  const X = (sec) => ox + (sec / Xs) * PW;
  const Y = (mm) => oy - ((mm - 1) / Ys) * PH;

  // axes + ticks
  g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(ox, pt); g.lineTo(ox, oy); g.lineTo(W - pr, oy); g.stroke();
  g.fillStyle = 'rgba(200,212,245,.55)'; g.font = `600 11px ${FONT}`;
  const sStep = niceStep([1, 2, 5, 10, 15, 30, 60, 120], 70 / (PW / Xs));
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let k = sStep; k <= Xs; k += sStep) { const x = X(k); g.fillRect(x, oy, 1, 5); g.fillText(k + 's', x, oy + 8); }
  const yStep = niceStep([0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000], 38 / (PH / Ys));
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = Math.ceil(1 / yStep + 1e-9) * yStep; v <= 1 + Ys; v += yStep) {
    if (v <= 1) continue; const y = Y(v); g.fillRect(ox - 5, y, 5, 1);
    g.fillText((Math.round(v * 100) / 100) + 'x', ox - 9, y);
  }

  // the curve (red line + soft red fill under it)
  let head = { x: ox, y: oy }, ang = -0.32;
  const N = 90;
  if (phase !== 'waiting' && ts > 0) {
    g.beginPath(); g.moveTo(ox, oy);
    let px = ox, py = oy, qx = ox, qy = oy;
    for (let i = 1; i <= N; i++) {
      const sec = ts * i / N;
      const x = X(sec), y = Y(Math.exp(rate * sec));
      g.lineTo(x, y);
      if (i === N - 1) { qx = x; qy = y; }
      px = x; py = y;
    }
    head = { x: px, y: py };
    ang = Math.max(-0.62, Math.min(-0.04, Math.atan2(py - qy, px - qx)));
    const lineEnd = { x: px, y: py };
    g.lineTo(px, oy); g.closePath();
    const fill = g.createLinearGradient(0, pt, 0, oy);
    fill.addColorStop(0, 'rgba(229,22,60,.50)'); fill.addColorStop(1, 'rgba(229,22,60,.06)');
    g.fillStyle = fill; g.fill();
    g.beginPath(); g.moveTo(ox, oy);
    for (let i = 1; i <= N; i++) { const sec = ts * i / N; g.lineTo(X(sec), Y(Math.exp(rate * sec))); }
    g.strokeStyle = phase === 'crashed' ? 'rgba(229,22,60,.55)' : RED; g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
    head = lineEnd;
  }

  // the plane: follows the curve, then hovers and bobs once it reaches the top of the screen
  const pw = Math.max(64, Math.min(150, W * 0.17)), ph = pw / 2;
  let ax = head.x, ay = head.y, rot = ang, alpha = 1;
  if (phase === 'flying') {
    const settle = Math.max(0, Math.min(1, (ts - 5) / 2));
    ay += Math.sin(t / 420) * PH * 0.018 * settle + Math.sin(t / 170) * 1.2;
    rot += Math.sin(t / 420 + 0.6) * 0.05 * settle;
  } else if (phase === 'waiting') {
    ay += Math.sin(t / 380) * 2.5; rot = -0.12;
  } else if (phase === 'crashed' && S) {
    const since = Math.max(0, Date.now() + off - S.crashedAt);     // fly away to the right, up and off screen
    const q = since / 520;
    ax += q * q * W * 0.55; ay -= q * q * H * 0.22; rot = -0.35 - Math.min(q * 0.2, 0.3);
    alpha = Math.max(0, 1 - q / 1.6);
  }
  if (alpha > 0) {
    g.save(); g.globalAlpha = alpha; g.translate(ax, ay); g.rotate(rot);
    if (planeOk) g.drawImage(plane, -pw * 0.55, -ph * 0.72, pw, ph);
    else { g.fillStyle = RED; g.beginPath(); g.moveTo(pw * 0.4, 0); g.lineTo(-pw * 0.5, -ph * 0.3); g.lineTo(-pw * 0.5, ph * 0.3); g.closePath(); g.fill(); }
    if (phase !== 'crashed') {                                       // spinning propeller blur on the nose
      const k = Math.abs(Math.sin(t / 32));
      g.fillStyle = 'rgba(235,240,255,.55)'; g.beginPath();
      g.ellipse(pw * 0.375, -ph * 0.17, pw * 0.012 + 1, ph * (0.16 + 0.14 * k), 0, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  // texts
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (!S) {
    g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `700 ${Math.min(26, W * 0.06)}px ${FONT}`; g.fillText('Connecting…', W / 2, H * 0.45);
  } else if (phase === 'waiting') {
    const left = Math.max(0, S.waitEnd - now);
    g.fillStyle = '#fff'; g.font = `800 ${Math.min(30, W * 0.065)}px ${FONT}`;
    g.fillText('WAITING FOR NEXT ROUND', W / 2, H * 0.40);
    const bw = Math.min(260, W * 0.5), bx = W / 2 - bw / 2, by = H * 0.40 + 34;
    g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(bx, by, bw, 6);
    g.fillStyle = RED; g.fillRect(bx, by, bw * Math.min(1, left / WAIT_TOTAL), 6);
    g.fillStyle = 'rgba(255,255,255,.65)'; g.font = `600 ${Math.min(15, W * 0.04)}px ${FONT}`;
    g.fillText('Place your bets · ' + (left / 1000).toFixed(1) + 's', W / 2, by + 28);
  } else {
    const big = Math.round(Math.min(W * 0.15, 104));
    g.font = `900 ${big}px ${FONT}`;
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.35)';
    const txt = m.toFixed(2) + 'x';
    if (phase === 'crashed') {
      g.fillStyle = '#ff3b57';
      g.font = `800 ${Math.round(big * 0.3)}px ${FONT}`; g.fillText('FLEW AWAY!', W / 2, H * 0.30);
      g.font = `900 ${big}px ${FONT}`;
    } else g.fillStyle = '#fff';
    g.strokeText(txt, W / 2, H * 0.44); g.fillText(txt, W / 2, H * 0.44);
  }

  renderPanels(false);     // keeps the CASH OUT amount ticking
}
requestAnimationFrame(draw);

connect();
