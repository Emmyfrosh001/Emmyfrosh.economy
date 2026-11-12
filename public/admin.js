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
  not_found: 'Not found.'
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
  if (b.dataset.tab === 'coupons') loadCoupons();
  if (b.dataset.tab === 'activity') loadActivity();
}));

function refreshAll() { loadOverview(); loadUsers(); loadCoupons(); loadActivity(); }

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
      ['Edits waiting for the bot', fmt(o.pendingEdits)],
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

// ── activity ────────────────────────────────────────────────────
const STATUS = { pending: 'Waiting for bot', sent: 'Sent to bot', done: 'Applied', failed: 'Failed', cancelled: 'Cancelled' };

async function loadActivity() {
  try {
    const [a, l] = await Promise.all([api('/admin/api/adjustments'), api('/admin/api/audit')]);
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
