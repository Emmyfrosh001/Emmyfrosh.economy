'use strict';
// Slot machine — browser side. The server spins the reels and decides every win;
// this file only draws the result (and sends the stake).
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();
const EMO = { cherry: '🍒', lemon: '🍋', grape: '🍇', bell: '🔔', star: '⭐', gem: '💎', seven: '7️⃣', wild: '🃏' };
const ERR = {
  not_logged_in: 'Please log in first.',
  bad_amount: 'Enter a valid stake.',
  too_big: 'That stake is above the maximum.',
  insufficient: 'Not enough money in your wallet for that stake.',
  no_money: 'Your wallet is empty. You can play again when you have money.',
  no_wallet: 'Your wallet was not found yet. Use the bot once, then try again.',
  game_off: 'The slot machine is closed right now.',
  rate_limited: 'Slow down a little and try again.',
  bad_request: 'Something went wrong. Refresh the page.'
};
let S = null, me = false, bal = 0, spinning = false, autoLeft = 0, stopAuto = false, toastT, grid = null, lineTimer = null;
const REELS = 3, ROWS = 3;

function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 's-toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4500);
}
function parseAmt(s) {                          // 250, 1,500, 2.5k, 1m …
  const m = String(s).toLowerCase().replace(/[,\s_]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  return m ? Math.floor(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : 0;
}
const stake = () => parseAmt($('amt').value);

// ── drawing ─────────────────────────────────────────────────
const SYM_LIST = Object.keys(EMO);
const rnd = () => SYM_LIST[Math.floor(Math.random() * 7)];            // (wild is rare, so blur symbols skip it)
function cellEl(sym) { const d = document.createElement('div'); d.className = 'cell ' + sym; d.textContent = EMO[sym]; d.dataset.s = sym; return d; }
function buildReels() {
  const box = $('reels'); box.replaceChildren();
  grid = [[], [], []];
  for (let r = 0; r < REELS; r++) {
    const reel = document.createElement('div'), strip = document.createElement('div'); reel.className = 'reel'; strip.className = 'strip';
    for (let row = 0; row < ROWS; row++) { const s = rnd(); grid[row][r] = s; strip.append(cellEl(s)); }
    reel.append(strip); box.append(reel);
  }
}
function cellAt(row, reel) { return $('reels').children[reel].querySelector('.strip').children[row]; }
function cellH() { return $('reels').children[0].querySelector('.cell').getBoundingClientRect().height; }

function clearWins() {
  clearTimeout(lineTimer); $('lineSvg').replaceChildren(); $('winPop').hidden = true; $('reels').classList.remove('dim');
  document.querySelectorAll('#reels .hit').forEach(c => c.classList.remove('hit'));
}
function spinReel(r, final, ms, turbo) {        // slide a long strip down: [final 3 … random … old 3]
  return new Promise(res => {
    const reel = $('reels').children[r], old = reel.querySelector('.strip'), h = cellH();
    const n = (turbo ? 9 : 16) + r * (turbo ? 3 : 6), strip = document.createElement('div'); strip.className = 'strip';
    for (let i = 0; i < ROWS; i++) strip.append(cellEl(final[i]));
    for (let i = 0; i < n; i++) strip.append(cellEl(rnd()));
    [...old.children].forEach(c => strip.append(c.cloneNode(true)));
    const total = strip.children.length;
    strip.style.transform = 'translateY(' + (-(total - ROWS) * h) + 'px)';
    reel.replaceChildren(strip);
    void strip.offsetHeight;
    strip.style.transition = 'transform ' + ms + 'ms cubic-bezier(.12,.7,.2,1.04)';
    strip.style.transform = 'translateY(0)';
    setTimeout(() => {                           // keep only the 3 visible cells
      const keep = [...strip.children].slice(0, ROWS), s2 = document.createElement('div'); s2.className = 'strip';
      keep.forEach(c => s2.append(c)); reel.replaceChildren(s2); res();
    }, ms + 30);
  });
}
async function animate(g, turbo) {
  const tasks = [];
  for (let r = 0; r < REELS; r++) {
    const col = [g[0][r], g[1][r], g[2][r]];
    tasks.push(spinReel(r, col, (turbo ? 450 : 1100) + r * (turbo ? 130 : 420), turbo));
  }
  await Promise.all(tasks);
  grid = g;
}
function showWins(res, amount) {
  clearWins();
  if (!res.wins.length) return;
  const hits = new Set();
  res.wins.forEach(w => { const ln = S.lines[w.line]; for (let r = 0; r < w.count; r++) hits.add(ln[r] + ',' + r); });
  hits.forEach(k => { const [row, r] = k.split(',').map(Number); cellAt(row, r).classList.add('hit'); });
  $('reels').classList.add('dim');
  const svg = $('lineSvg');
  const draw = (idx) => {
    svg.replaceChildren();
    const w = res.wins[idx % res.wins.length], ln = S.lines[w.line];
    const pts = ln.map((row, r) => ((r + .5) * 100) + ',' + ((row + .5) * 100)).join(' ');
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); pl.setAttribute('points', pts); svg.append(pl);
  };
  draw(0); let i = 0;
  if (res.wins.length > 1) lineTimer = setInterval(() => draw(++i), 900);
  const ratio = res.win / amount;
  $('winTag').textContent = ratio >= 50 ? 'MEGA WIN' : ratio >= 20 ? 'BIG WIN' : 'WIN';
  $('winAmt').textContent = fmt(res.win); $('winPop').hidden = false;
}
function bigBanner(res, amount) {
  const ratio = res.win / amount; if (ratio < 20) return Promise.resolve();
  $('bwTag').textContent = ratio >= 50 ? 'MEGA WIN' : 'BIG WIN'; $('bwAmt').textContent = fmt(res.win); $('bigWin').hidden = false;
  return new Promise(r => setTimeout(() => { $('bigWin').hidden = true; r(); }, 2200));
}
function setBal(n) { bal = n; $('bal').textContent = fmt(n); }
function countTo(el, to, ms) {
  const from = Number(String(el.textContent).replace(/[^0-9]/g, '')) || 0, t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); el.textContent = fmt(Math.round(from + (to - from) * k)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ── spinning ────────────────────────────────────────────────
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || 'failed');
  return j;
}
function ui() {
  $('spin').disabled = spinning && !autoLeft;
  $('spin').classList.toggle('stop', autoLeft > 0);
  $('spin').firstElementChild.textContent = autoLeft > 0 ? 'STOP' : 'SPIN';
  $('auto').classList.toggle('on', autoLeft > 0);
  $('auto').textContent = autoLeft > 0 ? 'Auto ' + autoLeft : 'Auto';
  $('totBet').textContent = fmt(stake() || 0);
}
async function doSpin() {
  if (spinning) return false;
  if (!me) { toast('Please log in first.', true); return false; }
  if (!S.enabled) { toast(ERR.game_off, true); return false; }
  const amount = stake();
  if (!amount || amount < S.minBet) { toast('The minimum stake is ' + fmt(S.minBet) + '.', true); return false; }
  if (S.maxBet && amount > S.maxBet) { toast('The maximum stake is ' + fmt(S.maxBet) + '.', true); return false; }
  if (amount > bal) { toast(bal < 1 ? ERR.no_money : ERR.insufficient, true); return false; }
  spinning = true; ui(); clearWins(); $('lastWin').classList.remove('won');
  let res;
  try { res = await api('/slots/spin', { amount }); }
  catch (e) { spinning = false; ui(); toast(ERR[e.message] || 'No connection. Try again.', true); return false; }
  setBal(bal - amount);                                               // the stake leaves the wallet now…
  await animate(res.grid, $('turbo').checked);
  showWins(res, amount);
  $('lastWin').textContent = fmt(res.win); $('lastWin').classList.toggle('won', res.win > 0);
  if (res.win > 0) { countTo($('bal'), res.balance, 600); bal = res.balance; } else setBal(res.balance);   // …and the win lands when the reels stop
  await bigBanner(res, amount);
  spinning = false; ui(); gate();
  return res;
}
function gate() {                               // notes under the machine
  $('balChip').hidden = !me; $('hdLogin').hidden = me; $('hdSignup').hidden = me; $('loginNote').hidden = me;
  $('noMoney').hidden = !(me && S.hasWallet && bal < Math.max(1, S.minBet));
  $('closedNote').hidden = S.enabled;
}
async function autoLoop() {
  while (autoLeft > 0 && !stopAuto) {
    const r = await doSpin();
    if (!r) break;
    autoLeft--; ui();
    await new Promise(x => setTimeout(x, r.win ? (r.wins.length ? 1400 : 900) : 350));
  }
  autoLeft = 0; stopAuto = false; ui();
}
$('spin').onclick = () => { if (autoLeft > 0) { stopAuto = true; autoLeft = 0; ui(); return; } doSpin(); };
$('auto').onclick = (e) => { e.stopPropagation(); if (autoLeft > 0) { stopAuto = true; autoLeft = 0; ui(); return; } $('autoMenu').hidden = !$('autoMenu').hidden; };
$('autoMenu').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (!b) return; $('autoMenu').hidden = true; autoLeft = +b.dataset.n; stopAuto = false; ui(); autoLoop(); };
document.addEventListener('click', () => { $('autoMenu').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); $('spin').click(); } });

// ── stake box ───────────────────────────────────────────────
const LADDER = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 500000, 1000000];
$('plus').onclick = () => { const c = stake(); $('amt').value = String(LADDER.find(x => x > c) || c); ui(); };
$('minus').onclick = () => { const c = stake(), l = LADDER.filter(x => x < c); $('amt').value = String(l.length ? l[l.length - 1] : (S ? S.minBet : 1)); ui(); };
document.querySelectorAll('.chips button').forEach(b => b.onclick = () => {
  const v = b.dataset.set; let n = v === 'max' ? Math.max(1, Math.min(bal, S.maxBet || bal)) : +v;
  $('amt').value = String(n); ui();
});
$('amt').oninput = ui;
$('amt').onblur = () => { const n = stake(); if (n) $('amt').value = String(n); ui(); };

// ── page data ───────────────────────────────────────────────
const ord = ['seven', 'wild', 'gem', 'star', 'bell', 'grape', 'lemon', 'cherry'];
const x = (m) => { const v = m / 5; return (v >= 10 ? Math.round(v) : Math.round(v * 100) / 100) + 'x'; };
function renderPay() {
  const box = $('payRows'); box.replaceChildren();
  const head = document.createElement('div'); head.className = 'pay-row head'; head.innerHTML = '<span></span><span>3 in a row pays</span>'; box.append(head);
  ord.forEach(s => {
    const d = document.createElement('div'); d.className = 'pay-row';
    const e = document.createElement('span'); e.className = 'e'; e.textContent = EMO[s] + EMO[s] + EMO[s]; d.append(e);
    const sp = document.createElement('span'); sp.textContent = x(S.pay[s]); d.append(sp);
    box.append(d);
  });
  $('rtp').textContent = 'Pays back ' + S.rtp + '% over time';
}
function renderRecent() {
  const box = $('recent'); box.replaceChildren(); $('recentEmpty').hidden = !!(S.recent && S.recent.length);
  (S.recent || []).forEach(r => { const d = document.createElement('div'), n = document.createElement('span'), b = document.createElement('b'); n.textContent = r.name; b.textContent = '+' + fmt(r.win); d.append(n, b); box.append(d); });
}
async function loadState() {
  try {
    const r = await fetch('/slots/state', { credentials: 'same-origin', cache: 'no-store' }), j = await r.json();
    if (!j.ok) return;
    S = j; me = j.loggedIn; if (!spinning) setBal(j.balance || 0);
    renderPay(); renderRecent(); gate(); ui();
  } catch {}
}
buildReels();
loadState().then(() => { if (S) { $('amt').value = String(Math.max(S.minBet, Math.min(100, S.maxBet || 100))); ui(); } });
setInterval(() => { if (!spinning) loadState(); }, 15000);
window.addEventListener('resize', () => {});
