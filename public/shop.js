'use strict';
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

const ERR = {
  wrong_login: 'Wrong number or password.',
  too_many_attempts: 'Too many attempts. Wait 15 minutes.',
  not_logged_in: 'Please log in first.',
  no_listing: 'That listing is gone (sold out or removed).',
  closed: 'This stall is closed right now.',
  own_listing: 'You cannot buy your own listing.',
  not_enough_stock: 'Not enough stock left.',
  insufficient: 'You do not have enough money in your wallet.',
  out_of_stock: 'Out of stock in the shop right now. Try the market.',
  bad_item: 'That item is not available.',
  bad_qty: 'Enter a valid quantity.',
  too_many_pending: 'You already have orders waiting. Please wait a moment.',
  rate_limited: 'Slow down a little and try again.',
  bot_offline: 'The bot did not answer in time. You were not charged. Try again.',
  banned: 'This account has been banned.',
  not_verified: 'Almost there: confirm your number first. Send the .verify code to the bot on WhatsApp.',
  exists: 'This number already has an account. Log in instead. Forgot the password? Chat with customer care.',
  bad_number: 'Enter your full WhatsApp number with country code.',
  bad_password: 'Password must be 6–40 characters with no spaces.',
  busy: 'The site is busy. Try again in a few minutes.',
  mismatch: 'The two passwords are not the same.',
  player_not_found: 'The bot cannot find your player. Send any command to the bot first.'
};

let state = null, tab = 'shop', timer = null;

// 💬 customer care: the round chat bubble (chat.js) opens with a ready-made message
function askCare(text) { if (window.openSupportChat) window.openSupportChat(text); }
$('forgotChat').addEventListener('click', () => askCare('I forgot my website password. My WhatsApp number is: '));
$('signupHelp').addEventListener('click', () => askCare('I already have an account but forgot my password. My WhatsApp number is: '));

async function api(path, method, body) {
  const opt = { method: method || 'GET', headers: {} };
  if (opt.method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-Requested-With'] = 'XMLHttpRequest'; opt.body = JSON.stringify(body || {}); }
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) { const e = new Error(j.error || 'failed'); e.data = j; throw e; }
  return j;
}

let toastT;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 's-toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 6000);
}

function left(ts) {
  const s = Math.max(0, Math.floor((ts - Date.now()) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd';
}

// ── load + render ─────────────────────────────────────────────
async function load() {
  try { state = await api('/shop/api/state'); } catch { $('updated').textContent = 'Could not reach the server. Retrying…'; return; }
  document.title = (state.siteName || 'Shop') + ' — Shop & Market';
  const me = state.me;
  $('loginView').hidden = !!me;
  $('meBar').hidden = !me;
  $('logoutBtn').hidden = !me;
  $('ordersTab').hidden = !me;
  if (me) { $('meName').textContent = me.name; $('meBal').textContent = '$' + fmt(me.balance); }
  else if (tab === 'orders') setTab('shop');
  $('updated').textContent = state.updatedAt ? 'Updated ' + new Date(state.updatedAt).toLocaleTimeString() : 'Waiting for the bot…';
  render();
  if (tab === 'orders') loadOrders();
}

function card(title, sub, price, btnText, onClick, opts = {}) {
  const c = el('div', 's-item' + (opts.off ? ' off' : ''));
  const head = el('div', 'it-head');
  head.append(el('span', 'it-name', title));
  if (opts.badge) head.append(el('span', 'it-badge ' + (opts.badgeCls || ''), opts.badge));
  c.append(head);
  if (sub) c.append(el('div', 'it-sub', sub));
  const foot = el('div', 'it-foot');
  foot.append(el('span', 'it-price', price));
  const b = el('button', 'btn-n small', btnText); b.type = 'button';
  if (opts.off) b.disabled = true; else b.addEventListener('click', onClick);
  foot.append(b);
  c.append(foot);
  return c;
}

function render() {
  if (!state) return;
  const q = $('q').value.toLowerCase().trim();
  const me = state.me;
  const hit = (s) => !q || String(s).toLowerCase().includes(q);

  const sg = $('shopGrid'); sg.replaceChildren();
  const items = state.shop.filter(x => hit(x.name) || hit(x.key));
  $('shopEmpty').hidden = items.length > 0;
  items.forEach(x => sg.append(card(x.name, x.out ? 'Out of stock — try the market' : '', '$' + fmt(x.price),
    me ? 'Buy' : 'Log in', () => me ? openBuy({ kind: 'shop', ref: x.key, name: x.name, price: x.price }) : needLogin(),
    { off: x.out, badge: x.out ? 'Out' : '', badgeCls: 'out' })));

  const mg = $('marketGrid'); mg.replaceChildren();
  const ls = state.listings.filter(x => hit(x.name) || hit(x.item) || hit(x.seller))
    .sort((a, b) => a.item === b.item ? a.price - b.price : a.name.localeCompare(b.name));
  $('marketEmpty').hidden = ls.length > 0;
  ls.forEach(l => {
    const closed = l.closedUntil > Date.now();
    const sub = `${fmt(l.qty)} left · ${l.seller}` + (closed ? ` · opens in ${left(l.closedUntil)}` : '');
    mg.append(card(l.name, sub, '$' + fmt(l.price) + ' each',
      l.mine ? 'Yours' : (me ? 'Buy' : 'Log in'),
      () => me ? openBuy({ kind: 'market', ref: l.id, name: l.name, price: l.price, max: l.qty, seller: l.seller }) : needLogin(),
      { off: closed || l.mine, badge: closed ? 'Closed' : '', badgeCls: 'out' }));
  });

  const rl = $('rateList'); rl.replaceChildren();
  const coins = state.coins.filter(c => hit(c.name) || hit(c.key));
  $('ratesEmpty').hidden = coins.length > 0 || !!q;
  coins.forEach(c => {
    const open = state.listings.filter(l => l.item === c.key && l.qty > 0 && !(l.closedUntil > Date.now()));
    const best = open.length ? open.reduce((a, b) => (b.price < a.price ? b : a)) : null;
    const row = el('div', 'rate');
    const top = el('div', 'rate-top');
    top.append(el('span', 'rate-name', c.name), el('strong', 'rate-val', '$' + fmt(c.price)));
    const sub = el('div', 'rate-sub', best ? `Cheapest on market: $${fmt(best.price)} (${best.seller}) · ${open.length} seller${open.length > 1 ? 's' : ''}` : 'No sellers on the market right now');
    row.append(top, sub);
    if (best && me && !best.mine) {
      const b = el('button', 'btn-n small', 'Buy cheapest'); b.type = 'button';
      b.addEventListener('click', () => openBuy({ kind: 'market', ref: best.id, name: best.name, price: best.price, max: best.qty, seller: best.seller }));
      row.append(b);
    }
    rl.append(row);
  });
}

function needLogin() { toast('Log in with your WhatsApp number to buy.', true); $('loginView').scrollIntoView({ behavior: 'smooth' }); $('num').focus(); }

function setTab(t) {
  tab = t;
  document.querySelectorAll('.s-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.s-panel').forEach(p => { p.hidden = p.id !== 'tab-' + t; });
  $('q').parentElement.hidden = t === 'orders';
  if (t === 'orders') loadOrders();
}
document.querySelectorAll('.s-tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('q').addEventListener('input', render);

// ── orders list ───────────────────────────────────────────────
const ST = { pending: 'Waiting for bot…', sent: 'Processing…', done: 'Done', failed: 'Failed', expired: 'Expired' };
async function loadOrders() {
  if (!state || !state.me) return;
  try {
    const j = await api('/shop/api/orders');
    const box = $('orderList'); box.replaceChildren();
    $('ordersEmpty').hidden = j.items.length > 0;
    j.items.forEach(o => {
      const r = el('div', 'order ' + o.status);
      const what = o.msg || `${o.kind === 'shop' ? 'Shop' : 'Market #'}${o.kind === 'shop' ? ': ' + o.ref : o.ref} × ${fmt(o.qty)}`;
      r.append(el('strong', '', what), el('span', 's-muted', new Date(o.at).toLocaleString() + ' · ' + (ST[o.status] || o.status) + (o.error ? ' — ' + (ERR[o.error] || o.error) : '')));
      box.append(r);
    });
  } catch {}
}

// ── buy dialog ────────────────────────────────────────────────
let cur = null, polling = false;
function openBuy(o) {
  cur = o;
  $('buyTitle').textContent = o.name;
  $('buyInfo').textContent = '$' + fmt(o.price) + ' each' + (o.seller ? ' · seller: ' + o.seller : '') + (o.max ? ' · ' + fmt(o.max) + ' available' : '');
  $('buyQty').value = 1;
  if (o.max) $('buyQty').max = o.max; else $('buyQty').removeAttribute('max');
  $('buyStatus').hidden = true; $('buyGo').disabled = false;
  total();
  $('buyModal').hidden = false;
  $('buyQty').focus(); $('buyQty').select();
}
function total() { const q = Math.max(0, Math.floor(Number($('buyQty').value) || 0)); $('buyTotal').textContent = '$' + fmt(q * (cur ? cur.price : 0)); }
$('buyQty').addEventListener('input', total);
$('buyCancel').addEventListener('click', () => { if (!polling) $('buyModal').hidden = true; });
$('buyModal').addEventListener('click', (e) => { if (e.target === $('buyModal') && !polling) $('buyModal').hidden = true; });

function status(msg, cls) { const s = $('buyStatus'); s.textContent = msg; s.className = 's-status ' + (cls || ''); s.hidden = false; }

$('buyGo').addEventListener('click', async () => {
  const qty = Math.floor(Number($('buyQty').value));
  if (!qty || qty < 1) return status('Enter a valid quantity.', 'bad');
  $('buyGo').disabled = true; polling = true;
  status('Sending your order…');
  try {
    const j = await api('/shop/api/order', 'POST', { kind: cur.kind, ref: cur.ref, qty });
    status('Order sent. Waiting for the bot…');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await api('/shop/api/order?id=' + j.id);
      if (s.status === 'done') {
        status('✅ ' + (s.msg || 'Purchased!'), 'ok');
        polling = false; $('buyGo').disabled = true; load();
        return;
      }
      if (s.status === 'failed' || s.status === 'expired') {
        let m = ERR[s.error] || 'The order failed.';
        if (s.error === 'insufficient' && s.need) m += ` You need $${fmt(s.need)}.`;
        if (s.error === 'not_enough_stock' && s.left !== undefined) m += ` Only ${fmt(s.left)} left.`;
        status('❌ ' + m, 'bad'); polling = false; $('buyGo').disabled = false; load();
        return;
      }
    }
    status('Still waiting. Check “My orders” in a minute — you are only charged if it says Done.', 'bad');
  } catch (e) {
    let m = ERR[e.message] || 'Something went wrong. Try again.';
    if (e.message === 'not_enough_stock' && e.data && e.data.left !== undefined) m += ` Only ${fmt(e.data.left)} left.`;
    status('❌ ' + m, 'bad');
    $('buyGo').disabled = false;
    if (e.message === 'not_logged_in') load();
  }
  polling = false;
});

// ── sign up ───────────────────────────────────────────────────
function authMode(signup) {
  $('authLogin').classList.toggle('on', !signup); $('authSignup').classList.toggle('on', signup);
  $('loginForm').hidden = signup; $('signupForm').hidden = !signup; $('verifyBox').hidden = true;
}
$('authLogin').addEventListener('click', () => authMode(false));
$('authSignup').addEventListener('click', () => authMode(true));
$('verifyDone').addEventListener('click', () => { authMode(false); $('num').value = $('sNum').value; $('pw').focus(); });
$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('signupErr').hidden = true;
  if ($('sPw').value !== $('sPw2').value) { $('signupErr').textContent = ERR.mismatch; $('signupErr').hidden = false; return; }
  try {
    const j = await api('/shop/signup', 'POST', { number: $('sNum').value, password: $('sPw').value });
    $('signupForm').hidden = true;
    $('verifyCode').textContent = '.verify ' + j.code;
    $('verifyMins').textContent = j.minutes;
    $('verifyBox').hidden = false;
    $('sPw').value = ''; $('sPw2').value = '';
  } catch (err) { $('signupErr').textContent = ERR[err.message] || 'Could not create the account.'; $('signupErr').hidden = false; }
});

// ── login / logout ────────────────────────────────────────────
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('loginErr').hidden = true;
  try {
    await api('/shop/login', 'POST', { number: $('num').value, password: $('pw').value });
    $('pw').value = '';
    await load(); toast('Welcome back!');
  } catch (err) { $('loginErr').textContent = ERR[err.message] || 'Could not log in.'; $('loginErr').hidden = false; }
});
$('logoutBtn').addEventListener('click', async () => { try { await api('/shop/logout', 'POST'); } catch {} await load(); });

load();
setInterval(() => { if (!document.hidden && $('buyModal').hidden) load(); }, 20000);
