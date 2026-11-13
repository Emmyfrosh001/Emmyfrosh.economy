'use strict';
// Football TV — browser side. The server owns the fixtures, odds, goal minutes and your wallet.
// This file only draws the match, keeps the clock and sends your bet.
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();

const ERR = {
  not_logged_in: 'Please log in first.', game_off: 'Football betting is closed right now.',
  closed: 'Betting is closed. Wait for the next round.', stale: 'That round is over. Pick again for the new round.',
  bad_amount: 'Enter a valid stake (1 or more).', bad_picks: 'Pick 1 to 4 different matches.',
  too_many: 'You can place up to 5 bets per round.', no_wallet: 'Your wallet was not found yet. Use the bot once, then try again.',
  no_money: 'Your wallet is empty.', insufficient: 'Not enough money in your wallet for that stake.',
  below_min: 'That stake is below the minimum.', above_max: 'That stake is above the maximum.',
  rate_limited: 'Slow down a little and try again.', bad_request: 'Something went wrong. Refresh the page.'
};
function errText(code) {
  const lim = S && S.limits;
  if (code === 'below_min' && lim) return 'The minimum stake is ' + fmt(lim.min) + '.';
  if (code === 'above_max' && lim) return 'The maximum stake is ' + fmt(lim.max) + '.';
  return ERR[code] || 'Something went wrong. Try again.';
}
function parseAmt(s) {
  const m = String(s).toLowerCase().replace(/[,\s_]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  return m ? Math.floor(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : 0;
}
let toastT;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 's-toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4500);
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// ── state ───────────────────────────────────────────────────
let S = null, off = 0, picks = {}, watched = 0, lastRound = 0, lastPhase = '', busy = false, fails = 0;
const serverNow = () => Date.now() + off;
function clock() {
  if (!S) return { ph: 'wait', left: 0, min: 0 };
  const t = S.timing, e = serverNow() - S.round.start;
  if (e < t.bet) return { ph: 'bet', left: t.bet - e, min: 0 };
  if (e < t.bet + t.play) return { ph: 'play', left: t.bet + t.play - e, min: Math.min(90, Math.floor((e - t.bet) / t.play * 90)) };
  return { ph: 'end', left: Math.max(0, t.bet + t.play + t.end - e), min: 90 };
}
const score = (f, m) => { let a = 0, b = 0; (f.goals || []).forEach(g => { if (g.m <= m) g.side ? b++ : a++; }); return [a, b]; };
const mmss = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const total = () => Object.keys(picks).reduce((p, m) => p * picks[m].odd, 1);

async function load() {
  try {
    const r = await fetch('/football/state', { credentials: 'same-origin', cache: 'no-store' });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error('bad');
    off = j.now - Date.now(); S = j; fails = 0; $('conn').hidden = true;
    if (S.round.id !== lastRound) { lastRound = S.round.id; picks = {}; lastPhase = ''; }
    renderTop(); renderMine(); renderResults(); renderBtn();
  } catch { if (++fails > 2) $('conn').hidden = false; }
}

// ── page pieces ─────────────────────────────────────────────
function renderTop() {
  const logged = S.balance !== null;
  $('balChip').hidden = !logged; if (logged) $('bal').textContent = fmt(S.balance);
  $('hdLogin').hidden = logged; $('hdSignup').hidden = logged;
  $('loginNote').hidden = logged; $('closedNote').hidden = S.enabled;
}
function renderList() {
  const c = clock(), live = c.ph !== 'bet', box = $('list');
  box.replaceChildren(el('div', 'fb-lg', 'Virtual League · Round ' + S.round.id));
  S.round.fx.forEach(f => {
    const card = el('div', 'fx' + (watched === f.id ? ' on' : ''));
    const top = el('div', 'fx-top'); top.append(el('span', '', ''), el('button', 'watch', watched === f.id ? 'On TV' : 'Watch'));
    top.lastChild.type = 'button'; top.lastChild.onclick = () => { watched = f.id; renderList(); };
    top.firstChild.dataset.st = f.id;
    const teams = el('div', 'fx-teams'); const sc = el('span', 'fx-score', live ? '0 : 0' : 'vs'); sc.dataset.sc = f.id;
    teams.append(el('span', '', f.h.n), sc, el('span', '', f.a.n));
    const odds = el('div', 'odds');
    f.o.forEach((o, i) => {
      const b = el('button', 'odd'); b.type = 'button'; b.disabled = live || !S.enabled;
      b.setAttribute('aria-pressed', String(!!picks[f.id] && picks[f.id].i === i));
      b.append(el('small', '', ['1', 'X', '2'][i]), el('b', '', o.toFixed(2)));
      b.onclick = () => {
        if (picks[f.id] && picks[f.id].i === i) delete picks[f.id]; else picks[f.id] = { i, odd: o };
        renderList(); renderBtn();
      };
      odds.append(b);
    });
    card.append(top, teams, odds); box.append(card);
  });
  paint();
}
function paint() {
  if (!S) return;
  const c = clock();
  if (c.ph !== lastPhase) { lastPhase = c.ph; if (S) renderList(); return; }
  S.round.fx.forEach(f => {
    const sc = document.querySelector('[data-sc="' + f.id + '"]'), st = document.querySelector('[data-st="' + f.id + '"]');
    const [a, b] = score(f, c.min);
    if (sc && c.ph !== 'bet') sc.textContent = a + ' : ' + b;
    if (st) { st.textContent = c.ph === 'bet' ? 'Kick-off soon' : c.ph === 'play' ? '● LIVE ' + c.min + "'" : 'Full time'; st.className = c.ph === 'play' ? 'fx-live' : ''; }
  });
  $('ph').textContent = c.ph === 'bet' ? 'Betting open · kick-off in' : c.ph === 'play' ? 'Match in play · full time in' : 'Full time · next round in';
  $('clk').textContent = mmss(c.left);
  const w = S.round.fx[watched]; if (w) $('chan').textContent = 'Match ' + (watched + 1) + ' · ' + w.h.c + ' v ' + w.a.c;
}
function renderBtn() {
  const n = Object.keys(picks).length;
  $('open').textContent = 'Betslip (' + n + ')' + (n ? ' · ' + total().toFixed(2) : '');
  $('open').disabled = !n;
}
const label = (p) => { const f = S.round.fx[p.m]; return f.h.c + ' v ' + f.a.c + ' · ' + ['Home', 'Draw', 'Away'][p.i]; };
function renderMine() {
  const box = $('mine'); box.replaceChildren();
  const c = clock(), rows = [];
  S.mine.forEach(b => rows.push({ t: b.picks.length + ' pick' + (b.picks.length > 1 ? 's' : '') + ' · ' + fmt(b.amount) + ' @ ' + b.odds.toFixed(2), r: c.ph === 'end' && b.win !== null ? (b.win ? ['won', 'Won +' + fmt(b.win)] : ['lost', 'Lost']) : ['pend', 'Pending'] }));
  S.recent.slice(0, 10).forEach(b => { if (b.round !== S.round.id) rows.push({ t: 'Round ' + b.round + ' · ' + b.n + ' pick' + (b.n > 1 ? 's' : '') + ' · ' + fmt(b.amount) + ' @ ' + b.odds.toFixed(2), r: b.win ? ['won', 'Won +' + fmt(b.win)] : ['lost', 'Lost'] }); });
  if (!rows.length) return box.append(el('p', 'empty', S.balance === null ? 'Log in to see your bets.' : 'No bets yet. Pick a result and place a bet.'));
  rows.forEach(x => { const d = el('div', 'line'); d.append(el('span', '', x.t), el('span', x.r[0], x.r[1])); box.append(d); });
}
function renderResults() {
  const box = $('results'); box.replaceChildren();
  if (!S.history.length) return box.append(el('p', 'empty', 'Results show here after the first full time.'));
  S.history.slice(0, 3).forEach(h => { const d = el('div', 'line'); d.append(el('span', '', 'Round ' + h.id), el('span', 'pend', h.r.join('  ·  '))); box.append(d); });
}

// ── betslip ─────────────────────────────────────────────────
function renderSlip() {
  const box = $('sels'); box.replaceChildren();
  Object.keys(picks).forEach(m => {
    const p = { m: +m, i: picks[m].i }, row = el('div', 'sel'), l = el('div'), r = el('div');
    const nm = S.round.fx[m]; l.append(el('b', '', nm.h.n + ' v ' + nm.a.n), el('span', '', '1X2 · ' + ['Home', 'Draw', 'Away'][p.i]));
    const rm = el('button', '', 'Remove'); rm.type = 'button';
    rm.onclick = () => { delete picks[m]; renderList(); renderBtn(); Object.keys(picks).length ? renderSlip() : $('slip').close(); };
    r.append(el('b', '', picks[m].odd.toFixed(2)), document.createElement('br'), rm); row.append(l, r); box.append(row);
  });
  $('tot').textContent = total().toFixed(2);
  $('win').textContent = fmt(Math.floor(parseAmt($('stake').value) * total()));
}
$('open').onclick = () => { $('msg').textContent = ''; renderSlip(); $('slip').showModal(); };
$('close').onclick = () => $('slip').close();
$('stake').oninput = renderSlip;
document.querySelectorAll('.chips [data-set]').forEach(b => b.onclick = () => {
  $('stake').value = b.dataset.set === 'max' ? String(S && S.balance || 0) : b.dataset.set; renderSlip();
});
$('place').onclick = async () => {
  if (busy) return;
  const amount = parseAmt($('stake').value);
  if (amount < 1) { $('msg').textContent = ERR.bad_amount; return; }
  busy = true; $('place').disabled = true; $('msg').textContent = '';
  try {
    const r = await fetch('/football/bet', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ round: S.round.id, amount, picks: Object.keys(picks).map(m => ({ m: +m, i: picks[m].i })) })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) { $('msg').textContent = errText(j.error); if (j.error === 'stale') { picks = {}; load(); } }
    else { picks = {}; $('slip').close(); toast('Bet placed. Good luck!'); await load(); }
  } catch { $('msg').textContent = 'No connection. Try again.'; }
  busy = false; $('place').disabled = false;
};

// ── TV ──────────────────────────────────────────────────────
const cv = $('fbcv'), ctx = cv.getContext('2d'), W = 800, H = 450;
const F442 = [[.05, .5], [.18, .15], [.18, .38], [.18, .62], [.18, .85], [.38, .15], [.38, .38], [.38, .62], [.38, .85], [.5, .38], [.5, .62]];
let ball = [W / 2, H / 2], target = [W / 2, H / 2], nextPick = 0, flash = null, done = new Set(), lastKey = '';
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
function draw(now) {
  requestAnimationFrame(draw);
  if (!S) { pitch(); return; }
  const c = clock(), f = S.round.fx[watched] || S.round.fx[0], [sh, sa] = score(f, c.min), t = now / 1000, playing = c.ph === 'play';
  const key = S.round.id + '-' + f.id;
  if (key !== lastKey) { lastKey = key; done = new Set(); flash = null; ball = [W / 2, H / 2]; target = [W / 2, H / 2]; }
  if (playing && f.goals) {
    const up = f.goals.find(g => !done.has(g) && g.m - c.min <= 3 && g.m > c.min);
    if (up) target = [up.side ? 24 : W - 24, H / 2 + Math.sin(up.m) * 40];
    else if (now > nextPick) { const side = Math.random() < .5; target = [side ? 80 + Math.random() * 320 : 400 + Math.random() * 320, 40 + Math.random() * (H - 80)]; nextPick = now + 900 + Math.random() * 700; }
    f.goals.forEach(g => { if (!done.has(g) && g.m <= c.min) { done.add(g); flash = { t: now, side: g.side }; ball = [W / 2, H / 2]; target = [W / 2, H / 2]; } });
  } else target = [W / 2, H / 2];
  const k = playing ? .055 : .08; ball[0] += (target[0] - ball[0]) * k; ball[1] += (target[1] - ball[1]) * k;
  pitch();
  [0, 1].forEach(side => {
    ctx.fillStyle = (side ? f.a : f.h).col;
    F442.forEach(([fx, fy], i) => {
      let x = side ? W - fx * W * .9 - 20 : fx * W * .9 + 20, y = fy * (H - 60) + 30;
      x += (playing ? (ball[0] - W / 2) * .22 : 0) * (i ? 1 : .3) + Math.sin(t * 1.4 + i * 1.7 + side) * (playing ? 9 : 2);
      y += Math.cos(t * 1.1 + i * 2.3) * (playing ? 8 : 2) + (playing ? (ball[1] - H / 2) * .1 : 0);
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.fill(); ctx.strokeStyle = side ? '#fff' : 'rgba(0,0,0,.45)'; ctx.lineWidth = 2; ctx.stroke();
    });
  });
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(ball[0] + 3, ball[1] + 6, 7, 3, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ball[0], ball[1], 6.5, 0, 7); ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = '700 22px Segoe UI,Roboto,sans-serif'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(24, 26, 330, 40);
  ctx.fillStyle = f.h.col; ctx.fillRect(24, 26, 6, 40); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(f.h.c, 40, 46);
  ctx.textAlign = 'center'; ctx.fillStyle = '#ffd23f'; ctx.fillText(sh + '  -  ' + sa, 150, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.fillText(f.a.c, 262, 46);
  ctx.fillStyle = f.a.col; ctx.fillRect(264, 26, 6, 40);
  ctx.fillStyle = '#d93a3a'; ctx.fillRect(280, 26, 74, 40); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 18px Segoe UI,sans-serif';
  ctx.fillText(c.ph === 'bet' ? "0'" : c.ph === 'end' ? 'FT' : (c.min === 45 ? 'HT' : c.min + "'"), 317, 46);
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(W - 150, 26, 126, 28); ctx.fillStyle = '#fff'; ctx.font = '600 13px Segoe UI,sans-serif'; ctx.fillText('VIRTUAL LEAGUE', W - 87, 40);
  const banner = (a, b) => { ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fillRect(0, H / 2 - 60, W, 120); ctx.fillStyle = '#fff'; ctx.font = '800 40px Segoe UI,sans-serif'; ctx.textAlign = 'center'; ctx.fillText(a, W / 2, H / 2 - 14); ctx.font = '600 20px Segoe UI,sans-serif'; ctx.fillStyle = '#ffd23f'; ctx.fillText(b, W / 2, H / 2 + 28); };
  if (c.ph === 'bet') banner(f.h.n + ' v ' + f.a.n, 'Kick-off in ' + Math.ceil(c.left / 1000) + 's · place your bets');
  else if (c.ph === 'end') banner('FULL TIME  ' + sh + ' - ' + sa, 'Next round in ' + Math.ceil(c.left / 1000) + 's');
  else if (flash && now - flash.t < 2600) { const g = flash.side ? f.a : f.h; ctx.fillStyle = g.col; ctx.globalAlpha = .3 + .2 * Math.sin((now - flash.t) / 90); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; banner('GOAL!', g.n + '  ' + sh + ' - ' + sa); }
  ctx.fillStyle = 'rgba(0,0,0,.05)'; for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
}

setInterval(paint, 250);
setInterval(load, 1000);
load(); requestAnimationFrame(draw);
