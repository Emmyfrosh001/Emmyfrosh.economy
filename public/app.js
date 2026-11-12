'use strict';
const fmt = (n) => Number(n || 0).toLocaleString();
const compact = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n || 0));
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// small <svg><use href="#id"></svg> helper (the symbols live in index.html)
function icon(id, cls) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG_NS, 'use');
  u.setAttribute('href', '#' + id);
  u.setAttributeNS(XLINK, 'xlink:href', '#' + id);
  s.append(u);
  return s;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}

async function load() {
  try {
    const [t, s] = await Promise.all([
      fetch('/api/public/top?limit=50').then(r => r.json()),
      fetch('/api/public/stats').then(r => r.json())
    ]);

    if (s.siteName) {
      document.getElementById('siteName').textContent = s.siteName;
      document.title = s.siteName + ' — top players';
    }
    document.getElementById('meta').textContent =
      `${fmt(s.players)} players hold $${fmt(s.totalMoney)} in total. Updated ${ago(s.updatedAt)}.`;

    const tp = document.getElementById('tilePlayers');
    const tm = document.getElementById('tileMoney');
    tp.textContent = fmt(s.players);
    tm.textContent = '$' + compact(s.totalMoney);
    tm.title = '$' + fmt(s.totalMoney);

    const rows = document.getElementById('rows');
    const podium = document.getElementById('podium');
    rows.replaceChildren();
    podium.querySelectorAll('.pod').forEach(n => n.remove());

    const top = t.top || [];
    document.getElementById('empty').hidden = top.length > 0;

    if (t.hidden) {
      document.getElementById('empty').hidden = false;
      document.getElementById('empty').textContent = 'The leaderboard is private right now.';
    }

    top.slice(0, 3).forEach(u => {
      const d = el('div', 'pod pod-' + u.rank);
      d.append(icon('crown', 'crown pod-crown'),
        el('span', 'pod-rank', '#' + u.rank), el('span', 'pod-name', u.name), el('span', 'pod-total', '$' + fmt(u.total)));
      podium.append(d);
    });
    podium.hidden = top.length === 0;

    top.forEach(u => {
      const tr = el('tr', u.rank <= 3 ? 'top' : '');
      const rk = el('td', 'r');
      rk.append(el('span', 'rk ' + (u.rank <= 3 ? 'rk-' + u.rank : 'rk-n'), String(u.rank)));
      const lv = el('td', 'c');
      lv.append(el('span', 'lv' + (u.rank <= 3 ? '' : ' lv-dim'), 'Lv.' + u.level));
      tr.append(rk, el('td', 'name', u.name), el('td', 'job', u.job), lv, el('td', 'n money', '$' + fmt(u.total)));
      rows.append(tr);
    });
  } catch {
    document.getElementById('meta').textContent = 'Could not load standings. Try again in a minute.';
  }
}

// menu button
const menuBtn = document.getElementById('menuBtn');
const navMenu = document.getElementById('navMenu');
menuBtn.addEventListener('click', () => {
  const open = navMenu.hidden;
  navMenu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
});
navMenu.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') { navMenu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
});

load();
setInterval(load, 60000);
