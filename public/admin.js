'use strict';
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function td(text, cls) { return el('td', cls || '', text); }
function when(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }

const ERRORS = {
  wrong_login: 'Wrong username or password.',
  too_many_attempts: 'Too many attempts. Wait 15 minutes and try again.',
  player_not_found: 'That player is no longer in the latest standings.',
  bad_amount: 'Enter a valid amount, like 5000, 10k or 2.5m.',
  bad_claims: 'People per code must be between 1 and 100000.',
  not_logged_in: 'Your session ended. Sign in again.',
  cannot_cancel: 'That edit was already sent to the bot.',
  not_found: 'Not found.',
  bot_not_synced: 'The bot has not sent the market yet. Wait a moment and try again.',
  bad_item: 'Pick an item from the list.',
  bad_qty: 'Enter a valid quantity, like 10 or 1k.',
  bad_price: 'Enter a valid price, like 5000 or 2.5m.',
  listing_not_found: 'That listing is gone. Refresh the list.',
  bad_op: 'Unknown action.',
  account_not_found: 'That account is gone. Refresh the list.',
  bad_password: 'Password must be 6–40 characters with no spaces.',
  bad_id: 'ID must be 2–24 letters, numbers or _ (no spaces).',
  bad_name: 'Give it a name.',
  id_taken: 'That ID is already used by a good or a coin. Pick another.',
  id_builtin: 'That ID belongs to a built-in item. Use its Price button instead.',
  not_custom: 'Only goods and coins you created can be removed.',
  chat_not_found: 'That chat is gone. Refresh the list.',
  empty: 'Type a message first.',
  bad_difficulty: 'Pick Easy, Normal or Hard.',
  bad_limits: 'The biggest stake cannot be smaller than the smallest stake.'
};

async function api(path, method, body) {
  const opt = { method: method || 'GET', headers: {} };
  if (opt.method !== 'GET') {
    opt.headers['Content-Type'] = 'application/json';
    opt.headers['X-Requested-With'] = 'XMLHttpRequest';
    opt.body = JSON.stringify(body || {});
  }
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/admin/login') { showLogin(); throw new Error('not_logged_in'); }
  if (!r.ok || j.ok === false) throw new Error(j.error || 'failed');
  return j;
}

let toastTimer;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}
const say = (e) => toast(ERRORS[e.message] || 'Something went wrong. Try again.', true);

// ── views ───────────────────────────────────────────────────────
function showLogin() { $('dashView').hidden = true; $('loginView').hidden = false; $('u').focus(); }
function showDash(info) {
  $('loginView').hidden = true; $('dashView').hidden = false;
  $('brand').textContent = info.siteName + ' admin';
  document.title = info.siteName + ' admin';
  refreshAll();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').hidden = true;
  try {
    await api('/admin/login', 'POST', { username: $('u').value, password: $('p').value });
    $('p').value = '';
    showDash(await api('/admin/api/me'));
  } catch (err) {
    $('loginErr').textContent = ERRORS[err.message] || 'Could not sign in.';
    $('loginErr').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  try { await api('/admin/logout', 'POST'); } catch {}
  showLogin();
});

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
  if (b.dataset.tab === 'overview') loadOverview();
  if (b.dataset.tab === 'players') loadUsers();
  if (b.dataset.tab === 'market') loadMarket();
  if (b.dataset.tab === 'chats') loadChats();
  if (b.dataset.tab === 'accounts') loadAccounts();
  if (b.dataset.tab === 'coupons') loadCoupons();
  if (b.dataset.tab === 'activity') loadActivity();
  if (b.dataset.tab === 'game') loadGame(true);
}));

function refreshAll() { loadOverview(); loadUsers(); loadMarket(); loadCoupons(); loadActivity(); loadChats(); }

// ── overview ────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const o = await api('/admin/api/overview');
    const box = $('stats');
    box.replaceChildren();
    [
      ['Players', fmt(o.players)],
      ['Money in circulation', '$' + fmt(o.totalMoney)],
      ['Coupons still open', fmt(o.activeCoupons)],
      ['Coupon value unclaimed', '$' + fmt(o.couponValueLeft)],
      ['Changes waiting for the bot', fmt(o.pendingEdits)],
      ['Players with a site login', fmt(o.accounts)],
      ['Banned accounts', fmt(o.bannedAccounts)],
      ['Site orders (24h)', fmt(o.ordersToday)],
      ['Last bot update', o.usersUpdatedAt ? new Date(o.usersUpdatedAt).toLocaleString() : 'never']
    ].forEach(([k, v]) => {
      const d = el('div', 'stat');
      d.append(el('span', 'stat-v', v), el('span', 'stat-k', k));
      box.append(d);
    });
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}

// ── players ─────────────────────────────────────────────────────
let page = 1, pages = 1, query = '', selected = null;

async function loadUsers() {
  try {
    const j = await api('/admin/api/users?page=' + page + '&q=' + encodeURIComponent(query));
    page = j.page; pages = j.pages;
    const body = $('userRows');
    body.replaceChildren();
    $('userEmpty').hidden = j.users.length > 0;
    j.users.forEach(u => {
      const tr = el('tr', selected && selected.id === u.id ? 'sel' : '');
      const nameCell = td(u.name, 'name');
      if (u.pending) nameCell.append(el('span', 'badge', 'edit pending'));
      const btn = el('button', 'btn small', 'Edit');
      btn.type = 'button';
      btn.addEventListener('click', () => pickUser(u));
      const act = el('td'); act.append(btn);
      tr.append(nameCell, td('$' + fmt(u.balance), 'n'), td('$' + fmt(u.bank), 'n'), td(fmt(u.gams), 'n'), td(String(u.level), 'n'), act);
      body.append(tr);
    });
    $('pageInfo').textContent = `Page ${page} of ${pages} · ${fmt(j.count)} players`;
    $('prev').disabled = page <= 1;
    $('next').disabled = page >= pages;
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}

function pickUser(u) {
  selected = u;
  $('editTarget').textContent = `${u.name} — wallet $${fmt(u.balance)}, bank $${fmt(u.bank)}, gams ${fmt(u.gams)}`;
  $('applyBtn').disabled = false;
  $('amount').focus();
  loadUsers();
}

$('searchBtn').addEventListener('click', () => { query = $('search').value; page = 1; loadUsers(); });
$('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('searchBtn').click(); } });
$('prev').addEventListener('click', () => { if (page > 1) { page--; loadUsers(); } });
$('next').addEventListener('click', () => { if (page < pages) { page++; loadUsers(); } });

$('editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selected) return;
  const op = $('op').value, field = $('field').value, amount = $('amount').value;
  const label = { add: 'Add', remove: 'Remove', set: 'Set to' }[op];
  const fname = { balance: 'wallet', bank: 'bank', gams: 'gams' }[field];
  if (!confirm(`${label} ${amount} ${fname} for ${selected.name}?`)) return;
  try {
    await api('/admin/api/adjust', 'POST', { user: selected.id, field, op, amount });
    toast(`Edit queued for ${selected.name}. The bot applies it within about 30 seconds.`);
    $('amount').value = '';
    loadUsers(); loadOverview(); loadActivity();
  } catch (err) { say(err); }
});


// ── market ──────────────────────────────────────────────────────
let mData = null;

async function loadMarket() {
  try {
    mData = await api('/admin/api/market');
    const sel = $('mItem');
    if (sel.options.length !== mData.shop.length + mData.coins.length) {
      sel.replaceChildren();
      const g1 = document.createElement('optgroup'); g1.label = 'Shop items';
      mData.shop.forEach(x => g1.append(new Option(`${x.name} (shop $${fmt(x.price)})`, x.key)));
      const g2 = document.createElement('optgroup'); g2.label = 'Coins';
      mData.coins.forEach(x => g2.append(new Option(`${x.name} (rate $${fmt(x.price)})`, x.key)));
      sel.append(g1, g2);
    }
    $('marketNote').textContent = mData.updatedAt
      ? `Last update from the bot: ${new Date(mData.updatedAt).toLocaleTimeString()}. Changes are applied by the bot within about 10 seconds.`
      : 'The bot has not sent the market yet.';
    renderMarket(); renderItems();
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}

function renderMarket() {
  if (!mData) return;
  const q = $('mSearch').value.toLowerCase().trim();
  const body = $('mRows'); body.replaceChildren();
  const rows = mData.listings.filter(l => !q || l.name.toLowerCase().includes(q) || l.seller.toLowerCase().includes(q) || l.id === q);
  $('mEmpty').hidden = rows.length > 0;
  rows.forEach(l => {
    const tr = el('tr', l.closedUntil ? 'used' : '');
    const nameCell = td(l.name, 'name');
    if (l.kind === 'admin') nameCell.append(el('span', 'badge admin-b', 'yours'));
    const st = el('td');
    st.append(document.createTextNode(l.closedUntil ? 'Closed' : 'Open'));
    if (l.closedUntil) st.append(el('span', 'badge closed', l.closedUntil > Date.now() + 5 * 365 * 86400000 ? 'until reopened' : 'opens ' + new Date(l.closedUntil).toLocaleString()));
    if (l.pending) st.append(el('span', 'badge', 'change pending'));
    const acts = el('td', 'acts');
    const mk = (label, cls, fn) => { const b = el('button', 'btn small ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); acts.append(b); };
    if (l.closedUntil) mk('Open', '', () => op('open', l));
    else mk('Close', '', () => { const m = prompt('Close for how many minutes? (leave empty = until you open it again)', ''); if (m !== null) op('close', l, { minutes: m }); });
    mk('+ Stock', '', () => { const v = prompt(`Add how many to "${l.name}"?`, ''); if (v) op('topup', l, { qty: v }); });
    mk('Price', '', () => { const v = prompt(`New price each for "${l.name}" (now $${fmt(l.price)})`, ''); if (v) op('price', l, { price: v }); });
    mk('Remove', 'danger', () => { if (confirm(`Remove listing #${l.id} (${l.name})?` + (l.kind === 'player' ? ' The items go back to the seller.' : ''))) op('remove', l); });
    tr.append(td('#' + l.id), nameCell, td(fmt(l.qty), 'n'), td('$' + fmt(l.price), 'n'), td(l.seller), st, acts);
    body.append(tr);
  });
}

async function op(name, l, extra) {
  try {
    await api('/admin/api/market/op', 'POST', Object.assign({ op: name, ref: l.id }, extra || {}));
    toast('Queued. The bot applies it within about 10 seconds.');
    l.pending = true; renderMarket(); loadOverview();
    setTimeout(loadMarket, 12000);
  } catch (err) { say(err); }
}

// ── goods & coins ───────────────────────────────────────────────
function renderItems() {
  if (!mData) return;
  const q = $('iSearch').value.toLowerCase().trim();
  const body = $('iRows'); body.replaceChildren();
  const all = [...mData.shop.map(x => Object.assign({ type: 'Good' }, x)), ...mData.coins.map(x => Object.assign({ type: 'Coin' }, x))]
    .filter(x => !q || x.key.includes(q) || x.name.toLowerCase().includes(q));
  all.sort((a, b) => (b.custom ? 1 : 0) - (a.custom ? 1 : 0));   // yours first
  all.forEach(x => {
    const tr = el('tr');
    const nameCell = td(x.name, 'name');
    if (x.custom) nameCell.append(el('span', 'badge admin-b', 'yours'));
    const acts = el('td', 'acts');
    const mk = (label, cls, fn) => { const b = el('button', 'btn small ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); acts.append(b); };
    mk('Price', '', async () => {
      const v = prompt(`New ${x.type === 'Coin' ? 'rate' : 'price'} for "${x.name}" (now $${fmt(x.price)})`, '');
      if (!v) return;
      try { await api('/admin/api/item/price', 'POST', { key: x.key, price: v }); toast('Queued. The bot applies it within about 10 seconds.'); setTimeout(loadMarket, 12000); } catch (err) { say(err); }
    });
    if (x.custom) mk('Remove', 'danger', async () => {
      if (!confirm(`Remove "${x.name}"? It disappears from the shop, the market AND every player's inventory.`)) return;
      try { await api('/admin/api/item/delete', 'POST', { key: x.key }); toast('Queued. The bot removes it within about 10 seconds.'); setTimeout(loadMarket, 12000); } catch (err) { say(err); }
    });
    tr.append(td(x.key), nameCell, td(x.type), td('$' + fmt(x.price), 'n'), acts);
    body.append(tr);
  });
}
$('iSearch').addEventListener('input', renderItems);
$('iKind').addEventListener('change', () => { $('iPriceLbl').textContent = $('iKind').value === 'coin' ? 'Rate (price of 1 coin)' : 'Price'; });
$('itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/api/item/add', 'POST', { kind: $('iKind').value, key: $('iKey').value, name: $('iName').value, price: $('iPrice').value });
    toast('Queued. It shows up in the shop / market within about 10 seconds.');
    $('iKey').value = ''; $('iName').value = ''; $('iPrice').value = '';
    setTimeout(loadMarket, 12000);
  } catch (err) { say(err); }
});

$('mSearch').addEventListener('input', renderMarket);
$('mAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/api/market/add', 'POST', { item: $('mItem').value, qty: $('mQty').value, price: $('mPrice').value, sellerName: $('mSeller').value });
    toast('Queued. It shows on the market within about 10 seconds.');
    $('mQty').value = ''; $('mPrice').value = '';
    setTimeout(loadMarket, 12000);
  } catch (err) { say(err); }
});


// ── customer chat ───────────────────────────────────────────────
let chatId = null;
const chatOpen = () => !$('tab-chats').hidden && !$('dashView').hidden;

async function loadChats() {
  try {
    const j = await api('/admin/api/chats');
    const b = $('chatBadge'); b.hidden = !j.unread; b.textContent = j.unread;
    if (!chatOpen()) return;
    const box = $('chatList'); box.replaceChildren();
    $('chatEmpty').hidden = j.items.length > 0;
    j.items.forEach(c => {
      const it = el('button', 'chat-item' + (c.id === chatId ? ' on' : '')); it.type = 'button';
      const top = el('strong'); top.append(el('span', '', c.name + (c.number ? ' · ' + c.number : '')));
      if (c.unread) top.append(el('span', 'dot', String(c.unread)));
      it.append(top, el('small', '', (c.lastFrom === 'admin' ? 'You: ' : '') + c.last), el('small', '', when(c.updatedAt)));
      it.addEventListener('click', () => { chatId = c.id; loadChats(); loadChat(true); });
      box.append(it);
    });
    if (chatId) loadChat(false);
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}

async function loadChat(scroll) {
  if (!chatId) return;
  try {
    const j = await api('/admin/api/chats/messages?id=' + encodeURIComponent(chatId));
    $('chatBox').hidden = false;
    $('chatWho').textContent = j.name + (j.number ? ' · ' + j.number : '');
    const m = $('chatMsgs');
    const near = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    m.replaceChildren();
    j.messages.forEach(x => {
      const d = el('div', 'chat-m ' + x.from);
      d.append(el('span', '', x.text), el('time', '', new Date(x.at).toLocaleString()));
      m.append(d);
    });
    if (scroll || near) m.scrollTop = m.scrollHeight;
  } catch (e) { if (e.message === 'chat_not_found') { chatId = null; $('chatBox').hidden = true; } else if (e.message !== 'not_logged_in') say(e); }
}

$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chatText').value.trim();
  if (!text || !chatId) return;
  try {
    await api('/admin/api/chats/reply', 'POST', { id: chatId, text });
    $('chatText').value = '';
    loadChat(true); loadChats();
  } catch (err) { say(err); }
});
$('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });
$('chatDel').addEventListener('click', async () => {
  if (!chatId || !confirm('Delete this whole chat?')) return;
  try { await api('/admin/api/chats/delete', 'POST', { id: chatId }); chatId = null; $('chatBox').hidden = true; loadChats(); } catch (err) { say(err); }
});
setInterval(() => { if (!$('dashView').hidden && !document.hidden) loadChats(); }, 5000);

// ── accounts ────────────────────────────────────────────────────
let accQuery = '';
async function loadAccounts() {
  try {
    const j = await api('/admin/api/accounts?q=' + encodeURIComponent(accQuery));
    const body = $('accRows'); body.replaceChildren();
    $('accEmpty').hidden = j.items.length > 0;
    $('accNote').textContent = `${fmt(j.total)} account(s), ${fmt(j.banned)} banned, ${fmt(j.waiting)} sign-up(s) waiting for WhatsApp confirmation. Changes are applied by the bot within about 10 seconds.`;
    j.items.forEach(a => {
      const tr = el('tr', a.banned ? 'used' : '');
      const st = el('td');
      st.append(document.createTextNode(a.banned ? 'Banned' : 'Active'));
      if (a.banned) st.append(el('span', 'badge closed', 'no login'));
      if (a.pending) st.append(el('span', 'badge', 'change pending'));
      const acts = el('td', 'acts');
      const mk = (label, cls, fn) => { const b = el('button', 'btn small ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); acts.append(b); };
      mk('Change password', '', async () => {
        const pw = prompt(`New password for ${a.name} (${a.number}). 6–40 characters, no spaces.`, '');
        if (!pw) return;
        try { await api('/admin/api/accounts/password', 'POST', { number: a.number, password: pw }); toast('Password changed. Tell the player the new one.'); loadAccounts(); } catch (e) { say(e); }
      });
      mk(a.banned ? 'Unban' : 'Ban', a.banned ? '' : 'warn', async () => {
        if (!confirm(`${a.banned ? 'Unban' : 'Ban'} ${a.name} (${a.number})?` + (a.banned ? '' : ' They will be logged out and cannot buy on the website.'))) return;
        try { await api('/admin/api/accounts/ban', 'POST', { number: a.number, banned: !a.banned }); toast(a.banned ? 'Unbanned.' : 'Banned.'); loadAccounts(); } catch (e) { say(e); }
      });
      mk('Delete login', 'danger', async () => {
        if (!confirm(`Delete the website login for ${a.name} (${a.number})? Their game money and items are not touched. They can create a new account.`)) return;
        try { await api('/admin/api/accounts/delete', 'POST', { number: a.number }); toast('Login deleted.'); loadAccounts(); } catch (e) { say(e); }
      });
      tr.append(td(a.name, 'name'), td(a.number), td('$' + fmt(a.balance), 'n'), td(a.lastLogin ? when(a.lastLogin) : 'never'), st, acts);
      body.append(tr);
    });
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}
$('accSearchBtn').addEventListener('click', () => { accQuery = $('accSearch').value; loadAccounts(); });
$('accSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('accSearchBtn').click(); } });

// ── coupons ─────────────────────────────────────────────────────
let lastCodes = [];

$('couponForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const j = await api('/admin/api/coupons', 'POST', {
      amount: $('cAmount').value, maxClaims: $('cPersons').value,
      count: $('cCount').value, note: $('cNote').value
    });
    lastCodes = j.codes;
    const ul = $('newCodeList');
    ul.replaceChildren();
    j.codes.forEach(c => {
      const li = el('li');
      li.append(el('code', '', c), document.createTextNode(` — $${fmt(j.amount)} · ${j.maxClaims} person(s)`));
      ul.append(li);
    });
    $('newCodes').hidden = false;
    toast(`${j.codes.length} code(s) created.`);
    loadCoupons(); loadOverview();
  } catch (err) { say(err); }
});

$('copyAll').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(lastCodes.join('\n')); toast('Codes copied.'); }
  catch { toast('Copy failed. Select the codes and copy them by hand.', true); }
});

async function loadCoupons() {
  try {
    const j = await api('/admin/api/coupons');
    const body = $('couponRows');
    body.replaceChildren();
    $('couponEmpty').hidden = j.items.length > 0;
    j.items.forEach(c => {
      const tr = el('tr', c.claims >= c.maxClaims ? 'used' : '');
      const code = el('td'); code.append(el('code', '', c.code));
      const del = el('button', 'btn small danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm('Delete ' + c.code + '? Nobody will be able to redeem it.')) return;
        try { await api('/admin/api/coupons/delete', 'POST', { code: c.code }); toast('Coupon deleted.'); loadCoupons(); loadOverview(); }
        catch (err) { say(err); }
      });
      const act = el('td'); act.append(del);
      tr.append(code, td('$' + fmt(c.amount), 'n'), td(`${c.claims} / ${c.maxClaims}`, 'n'),
        td(c.note || (c.createdBy === 'bot' ? 'Made in WhatsApp' : '')), td(when(c.createdAt)), act);
      body.append(tr);
    });
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}

// ── crash plane game ────────────────────────────────────────────
const DIFF_TEXT = {
  easy: 'Players win more often. The house keeps about 1% of all stakes.',
  normal: 'Balanced. The house keeps about 5% of all stakes.',
  hard: 'Players lose more often. The house keeps about 12% of all stakes, and about 1 round in 8 crashes instantly.'
};
async function loadGame(fillForm) {
  try {
    const j = await api('/admin/api/game');
    const sel = $('gDiff');
    if (!sel.options.length) {
      Object.entries(j.difficulties).forEach(([k, v]) => sel.append(new Option(`${v.label} (house keeps ${Math.round(v.edge * 100)}%)`, k)));
    }
    if (fillForm) {
      sel.value = j.settings.difficulty;
      $('gOn').value = j.settings.enabled ? '1' : '0';
      $('gMin').value = String(j.settings.minBet);
      $('gMax').value = j.settings.maxBet ? String(j.settings.maxBet) : '';
    }
    $('gDiffNote').textContent = DIFF_TEXT[sel.value] || '';
    const box = $('gStats'); box.replaceChildren();
    const st = j.stats;
    [
      ['Mode now', j.difficulties[j.settings.difficulty].label + (j.settings.enabled ? '' : ' (game is OFF)')],
      ['Watching now', fmt(j.watching)],
      ['Bets this round', fmt(j.round.bets)],
      ['Total staked', '$' + fmt(st.staked)],
      ['Total paid to players', '$' + fmt(st.paid)],
      [st.houseNet >= 0 ? 'House is up' : 'House is down', '$' + fmt(Math.abs(st.houseNet))]
    ].forEach(([k, v]) => { const d = el('div', 'stat'); d.append(el('span', 'stat-v', v), el('span', 'stat-k', k)); box.append(d); });
    const body = $('gWait'); body.replaceChildren();
    $('gWaitEmpty').hidden = j.waiting.length > 0;
    j.waiting.forEach(w => {
      const tr = el('tr');
      const status = w.sent ? 'Sent to bot' : (w.tries ? `Bot could not apply it yet (tried ${w.tries}×), retrying` : 'Will be sent in a moment');
      tr.append(td(w.name, 'name'), td((w.amount > 0 ? '+' : '−') + '$' + fmt(Math.abs(w.amount)), 'n'), td(status));
      body.append(tr);
    });
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}
$('gDiff').addEventListener('change', () => { $('gDiffNote').textContent = DIFF_TEXT[$('gDiff').value] || ''; });
$('gameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/api/game', 'POST', { difficulty: $('gDiff').value, enabled: $('gOn').value === '1', minBet: $('gMin').value, maxBet: $('gMax').value });
    toast('Game settings saved. A new difficulty starts with the next round.');
    loadGame(true); loadActivity();
  } catch (err) { say(err); }
});
$('gReset').addEventListener('click', async () => {
  if (!confirm('Reset the staked / paid totals to zero? Player wallets are not touched.')) return;
  try { await api('/admin/api/game/reset-stats', 'POST'); toast('Totals reset.'); loadGame(); } catch (err) { say(err); }
});
setInterval(() => { if (!$('dashView').hidden && !document.hidden && !$('tab-game').hidden) loadGame(); }, 5000);

// ── activity ────────────────────────────────────────────────────
const STATUS = { pending: 'Waiting for bot', sent: 'Sent to bot', done: 'Applied', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' };
const JOBNAME = { buy: 'Order', m_add: 'Add goods', m_remove: 'Remove', m_close: 'Close', m_open: 'Open', m_topup: 'Top up', m_price: 'Change price', item_add: 'Create good / coin', item_price: 'Change item price', item_del: 'Remove good / coin', acct_pass: 'Change password', acct_ban: 'Ban / unban', acct_del: 'Delete login' };

async function loadActivity() {
  try {
    const [a, l, jb] = await Promise.all([api('/admin/api/adjustments'), api('/admin/api/audit'), api('/admin/api/jobs')]);
    const ab = $('adjRows'); ab.replaceChildren();
    a.items.forEach(x => {
      const tr = el('tr');
      const fname = { balance: 'wallet', bank: 'bank', gams: 'gams' }[x.field];
      const verb = { add: 'Add', remove: 'Remove', set: 'Set to' }[x.op];
      const st = STATUS[x.status] + (x.error ? ` (${x.error})` : '');
      const act = el('td');
      if (x.status === 'pending') {
        const b = el('button', 'btn small', 'Cancel'); b.type = 'button';
        b.addEventListener('click', async () => {
          try { await api('/admin/api/adjust/cancel', 'POST', { id: x.id }); loadActivity(); loadUsers(); loadOverview(); } catch (err) { say(err); }
        });
        act.append(b);
      }
      tr.append(td(when(x.createdAt)), td(x.name, 'name'), td(`${verb} ${fmt(x.amount)} ${fname}`), td(st), act);
      ab.append(tr);
    });
    const jr = $('jobRows'); jr.replaceChildren();
    jb.items.forEach(x => {
      const tr = el('tr');
      const what = `${JOBNAME[x.type] || x.type}` + (x.msg ? ' — ' + x.msg : (x.ref ? ' #' + x.ref : '') + (x.item ? ' ' + x.item : '') + (x.qty ? ' × ' + fmt(x.qty) : '') + (x.price ? ' @ $' + fmt(x.price) : ''));
      tr.append(td(when(x.createdAt)), td(x.who || '', 'name'), td(what, 'name'), td((STATUS[x.status] || x.status) + (x.error ? ` (${x.error})` : '')));
      jr.append(tr);
    });
    const lb = $('auditRows'); lb.replaceChildren();
    l.items.forEach(x => {
      const tr = el('tr');
      tr.append(td(when(x.at)), td(x.action.replace(/_/g, ' ')), td(x.detail));
      lb.append(tr);
    });
  } catch (e) { if (e.message !== 'not_logged_in') say(e); }
}

// ── start ───────────────────────────────────────────────────────
(async () => {
  try { showDash(await api('/admin/api/me')); } catch { showLogin(); }
})();
setInterval(() => { if (!$('dashView').hidden && !document.hidden) { loadOverview(); } }, 30000);
