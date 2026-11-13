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
  player_not_found: 'The bot cannot find your player. Send any command to the bot first.',
  recipient_not_found: 'No player found with that number. Check it, and make sure they have used the bot.',
  self: 'You cannot send money to yourself.',
  bad_amount: 'Enter a valid amount.',
  credit_failed: 'Could not reach the other player. Your money was returned.',
  refunded: 'Could not reach the other player. Your money was returned.',
  refund_failed: 'Something went wrong. Contact customer care with this transfer.',
  nothing_to_move: 'There is nothing to move.',
  bad_op: 'Something went wrong. Try again.'
};

let state = null, tab = 'shop', timer = null, wantWallet = location.hash === '#wallet';

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
  $('hdLogin').hidden = !!me;
  $('hdSignup').hidden = !!me;
  $('meBar').hidden = !me;
  $('logoutBtn').hidden = !me;
  $('ordersTab').hidden = !me;
  $('walletTab').hidden = !me;
  $('invTab').hidden = !me;
  if (me) {
    $('meName').textContent = me.name; $('meBal').textContent = '$' + fmt(me.balance); $('meBank').textContent = '$' + fmt(me.bank);
    $('wWallet').textContent = '$' + fmt(me.balance); $('wBank').textContent = '$' + fmt(me.bank); $('wTotal').textContent = '$' + fmt((me.balance || 0) + (me.bank || 0));
    if (wantWallet) { wantWallet = false; setTab('wallet'); }
  }
  else if (wantWallet) { location.replace('/login?next=' + encodeURIComponent('/shop#wallet')); return; }   // /shop#wallet while logged out → log in first
  else if (tab === 'orders' || tab === 'wallet' || tab === 'inv') setTab('shop');
  $('updated').textContent = state.updatedAt ? 'Updated ' + new Date(state.updatedAt).toLocaleTimeString() : 'Waiting for the bot…';
  render();
  if (tab === 'orders') loadOrders();
  if (tab === 'inv') renderInv();
  if (tab === 'wallet' && !sending && !moving) loadTransfers();
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
    'Buy', () => me ? openBuy({ kind: 'shop', ref: x.key, name: x.name, price: x.price }) : needLogin(),
    { off: x.out, badge: x.out ? 'Out' : '', badgeCls: 'out' })));

  const mg = $('marketGrid'); mg.replaceChildren();
  const ls = state.listings.filter(x => hit(x.name) || hit(x.item) || hit(x.seller))
    .sort((a, b) => a.item === b.item ? a.price - b.price : a.name.localeCompare(b.name));
  $('marketEmpty').hidden = ls.length > 0;
  ls.forEach(l => {
    const closed = l.closedUntil > Date.now();
    const sub = `${fmt(l.qty)} left · ${l.seller}` + (closed ? ` · opens in ${left(l.closedUntil)}` : '');
    mg.append(card(l.name, sub, '$' + fmt(l.price) + ' each',
      l.mine ? 'Yours' : 'Buy',
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

// not logged in and tapped Buy: ask them to log in or sign up (no big login box on the page)
function needLogin() { $('loginModal').hidden = false; }
$('loginModalClose').addEventListener('click', () => { $('loginModal').hidden = true; });
$('loginModal').addEventListener('click', (e) => { if (e.target === $('loginModal')) $('loginModal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('loginModal').hidden = true; });

function setTab(t) {
  tab = t;
  document.querySelectorAll('.s-tab[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.s-panel').forEach(p => { p.hidden = p.id !== 'tab-' + t; });
  $('q').parentElement.hidden = t === 'orders' || t === 'wallet' || t === 'inv';
  if (t === 'orders') loadOrders();
  if (t === 'wallet') { loadTransfers(); load(); }
  if (t === 'inv') { renderInv(); load(); }
}
document.querySelectorAll('.s-tab[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
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

// ── inventory ─────────────────────────────────────────────────
function renderInv() {
  const inv = state && state.me ? state.me.inventory : null;
  const box = $('invList'); box.replaceChildren();
  const empty = $('invEmpty');
  if (inv === null || inv === undefined) { empty.textContent = 'Your inventory is not available yet. It will show here soon.'; empty.hidden = false; return; }
  empty.textContent = 'Your inventory is empty. Buy something from the Shop or Market.';
  empty.hidden = inv.length > 0;
  inv.forEach(x => {
    const r = el('div', 'order');
    r.append(el('strong', '', x.name), el('span', 's-muted', '× ' + fmt(x.qty)));
    box.append(r);
  });
}

// ── wallet: send money ────────────────────────────────────────
let sending = false, moving = false;
function amt(v) {
  const m = String(v || '').toLowerCase().replace(/[,$_\s]/g, '').match(/^(\d+(?:\.\d+)?)([kmbt])?$/);
  if (!m) return NaN;
  return Math.floor(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]] || 1));
}
function sstatus(msg, cls) { const s = $('sendStatus'); s.textContent = msg; s.className = 's-status ' + (cls || ''); s.hidden = false; }

async function loadTransfers() {
  if (!state || !state.me) return;
  try {
    const j = await api('/shop/api/transfers');
    const box = $('xferList'); box.replaceChildren();
    $('xferEmpty').hidden = j.items.length > 0;
    j.items.forEach(t => {
      const out = t.dir === 'out';
      const label = t.kind === 'deposit' ? 'Deposited $' + fmt(t.amount) + ' to your bank'
        : t.kind === 'withdraw' ? 'Withdrew $' + fmt(t.amount) + ' from your bank'
        : (out ? 'Sent $' : 'Received $') + fmt(t.amount) + (out ? ' to ' : ' from ') + t.name;
      const r = el('div', 'order ' + (t.status === 'failed' ? 'failed' : t.status === 'done' ? 'done' : ''));
      r.append(
        el('strong', '', label),
        el('span', 's-muted', new Date(t.at).toLocaleString() + ' · ' + (t.status === 'done' ? 'Done' : t.status === 'failed' ? 'Failed' + (t.error ? ' — ' + (ERR[t.error] || t.error) : '') : 'Processing…'))
      );
      box.append(r);
    });
  } catch {}
}

// deposit (wallet → bank) and withdraw (bank → wallet)
function bstatus(msg, cls) { const s = $('bankStatus'); s.textContent = msg; s.className = 's-status ' + (cls || ''); s.hidden = false; }
async function bankMove(op) {
  if (moving || sending) return;
  const raw = $('bankAmt').value.trim().toLowerCase();
  const amount = raw === 'all' ? 'all' : amt(raw);
  if (amount !== 'all' && (!Number.isInteger(amount) || amount < 1)) return bstatus(ERR.bad_amount, 'bad');
  moving = true; $('depBtn').disabled = true; $('withBtn').disabled = true;
  bstatus(op === 'deposit' ? 'Depositing…' : 'Withdrawing…');
  try {
    const j = await api('/shop/api/bank', 'POST', { op, amount });
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await api('/shop/api/send?id=' + j.id);
      if (s.status === 'done') {
        bstatus('✅ ' + (op === 'deposit' ? 'Deposited $' + fmt(s.amount) + ' to your bank.' : 'Withdrew $' + fmt(s.amount) + ' to your wallet.'), 'ok');
        $('bankAmt').value = '';
        return;
      }
      if (s.status === 'failed') { bstatus('❌ ' + (ERR[s.error] || 'It failed. Nothing was moved.'), 'bad'); return; }
    }
    bstatus('Still working. Check “Recent transfers” in a minute.', 'bad');
  } catch (err) {
    let m = ERR[err.message] || 'Something went wrong. Try again.';
    if (err.message === 'insufficient') m = (op === 'withdraw' ? 'Not enough money in your bank.' : 'Not enough money in your wallet.') + (err.data && err.data.have !== undefined ? ' You can move up to $' + fmt(err.data.have) + '.' : '');
    bstatus('❌ ' + m, 'bad');
    if (err.message === 'not_logged_in') load();
  } finally {
    moving = false; $('depBtn').disabled = false; $('withBtn').disabled = false;
    await load(); loadTransfers();
  }
}
$('bankForm').addEventListener('submit', (e) => e.preventDefault());
$('depBtn').addEventListener('click', () => bankMove('deposit'));
$('withBtn').addEventListener('click', () => bankMove('withdraw'));

$('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  const number = $('sendNum').value.trim();
  const amount = amt($('sendAmt').value);
  if (!Number.isInteger(amount) || amount < 1) return sstatus(ERR.bad_amount, 'bad');
  sending = true; $('sendGo').disabled = true;
  sstatus('Checking the number…');
  try {
    const who = await api('/shop/api/lookup?number=' + encodeURIComponent(number));
    if (!confirm('Send $' + fmt(amount) + ' to ' + who.name + '?')) { sstatus('Cancelled.'); return; }
    sstatus('Sending…');
    const j = await api('/shop/api/send', 'POST', { number, amount });
    sstatus('Sent to the bot. Waiting for it to move the money…');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await api('/shop/api/send?id=' + j.id);
      if (s.status === 'done') {
        sstatus('✅ Sent $' + fmt(s.amount) + ' to ' + s.name + '.', 'ok');
        $('sendAmt').value = '';
        toast('Money sent to ' + s.name + '.');
        return;
      }
      if (s.status === 'failed') { sstatus('❌ ' + (ERR[s.error] || 'The transfer failed. You were not charged.'), 'bad'); return; }
    }
    sstatus('Still working. Check “Recent transfers” in a minute.', 'bad');
  } catch (err) {
    let m = ERR[err.message] || 'Something went wrong. Try again.';
    if (err.message === 'insufficient' && err.data) m += ' You can send up to $' + fmt(err.data.have) + '.';
    sstatus('❌ ' + m, 'bad');
    if (err.message === 'not_logged_in') load();
  } finally {
    sending = false; $('sendGo').disabled = false;
    await load(); loadTransfers();
  }
});

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

// ── logout ────────────────────────────────────────────────────
$('logoutBtn').addEventListener('click', async () => { try { await api('/shop/logout', 'POST'); } catch {} await load(); });

load();
setInterval(() => { if (!document.hidden && $('buyModal').hidden) load(); }, 20000);
