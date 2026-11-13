'use strict';
// 💬 Customer-care live chat bubble — small, round, draggable. No login needed.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const SIZE = 46, MARGIN = 8;
  let open = false, msgs = [], unread = 0, lastCount = -1, sending = false, named = false;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }

  async function api(path, method, body) {
    const opt = { method: method || 'GET', headers: {} };
    if (opt.method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-Requested-With'] = 'XMLHttpRequest'; opt.body = JSON.stringify(body || {}); }
    const r = await fetch(path, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) { const e = new Error(j.error || 'failed'); throw e; }
    return j;
  }

  // ── build the DOM ───────────────────────────────────────────
  const bubble = el('button', 'cc-bubble'); bubble.type = 'button'; bubble.setAttribute('aria-label', 'Chat with customer care');
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path'); path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 5v2h10V9H7Zm0 4v2h7v-2H7Z');
  svg.append(path); bubble.append(svg);
  const badge = el('span', 'cc-badge'); badge.hidden = true; bubble.append(badge);

  const panel = el('section', 'cc-panel'); panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Customer care chat');
  const head = el('header', 'cc-head');
  const ht = el('div', 'cc-title'); ht.append(el('strong', '', 'Customer care'), el('span', '', 'Chat with us here — no login needed'));
  const close = el('button', 'cc-x', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close chat');
  head.append(ht, close);
  const list = el('div', 'cc-msgs');
  const err = el('p', 'cc-err'); err.hidden = true;
  const form = el('form', 'cc-form'); form.autocomplete = 'off';
  const nameIn = el('input', 'cc-name'); nameIn.type = 'text'; nameIn.maxLength = 30; nameIn.placeholder = 'Your name (optional)'; nameIn.setAttribute('aria-label', 'Your name');
  const row = el('div', 'cc-row');
  const input = el('textarea', 'cc-input'); input.rows = 1; input.maxLength = 500; input.placeholder = 'Type your message…'; input.setAttribute('aria-label', 'Message');
  const send = el('button', 'cc-send', 'Send'); send.type = 'submit';
  row.append(input, send);
  form.append(nameIn, row);
  const zoom = el('div', 'cc-zoom');
  const zoomTxt = el('span', '', 'Chat taking too long?');
  const zoomBtn = el('button', 'cc-zoom-btn', 'Request a Zoom call'); zoomBtn.type = 'button';
  zoom.append(zoomTxt, zoomBtn);
  panel.append(head, list, err, zoom, form);
  document.body.append(bubble, panel);

  const savedName = store('ccName'); if (savedName) nameIn.value = savedName;

  // ── position (draggable, remembered) ────────────────────────
  let pos = null;
  try { pos = JSON.parse(store('ccPos') || 'null'); } catch {}
  function clamp() {
    const w = window.innerWidth, h = window.innerHeight;
    pos.x = Math.min(Math.max(MARGIN, pos.x), w - SIZE - MARGIN);
    pos.y = Math.min(Math.max(MARGIN, pos.y), h - SIZE - MARGIN);
  }
  function place() {
    if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) pos = { x: window.innerWidth - SIZE - 14, y: window.innerHeight - SIZE - 90 };
    clamp();
    bubble.style.left = pos.x + 'px'; bubble.style.top = pos.y + 'px';
    placePanel();
  }
  function placePanel() {
    if (window.innerWidth <= 480) { panel.style.left = ''; panel.style.top = ''; return; }   // phones: bottom sheet (css)
    const w = Math.min(340, window.innerWidth - 16), h = Math.min(430, window.innerHeight - 16);
    let x = pos.x + SIZE - w; x = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    let y = pos.y - h - 10; if (y < 8) y = Math.min(pos.y + SIZE + 10, window.innerHeight - h - 8);
    panel.style.left = x + 'px'; panel.style.top = Math.max(8, y) + 'px';
  }

  let drag = null;
  bubble.addEventListener('pointerdown', (e) => {
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false, id: e.pointerId };
    try { bubble.setPointerCapture(e.pointerId); } catch {}
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true; bubble.classList.add('drag');
    pos.x = drag.ox + dx; pos.y = drag.oy + dy; place();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved; drag = null; bubble.classList.remove('drag');
    if (moved) { store('ccPos', JSON.stringify(pos)); suppress = true; setTimeout(() => { suppress = false; }, 50); }
  };
  let suppress = false;
  bubble.addEventListener('pointerup', endDrag);
  bubble.addEventListener('pointercancel', endDrag);
  bubble.addEventListener('click', () => { if (!suppress) toggle(); });
  window.addEventListener('resize', place);

  // ── rendering ───────────────────────────────────────────────
  // only plain http(s) links become tappable (so a Zoom link from customer care can be opened)
  function linkify(text) {
    const f = document.createDocumentFragment();
    const re = /https?:\/\/[^\s<>"']+/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) f.append(text.slice(last, m.index));
      const a = el('a', '', m[0]); a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      f.append(a); last = m.index + m[0].length;
    }
    if (last < text.length) f.append(text.slice(last));
    return f;
  }
  function hhmm(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function render() {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.replaceChildren();
    const hi = el('div', 'cc-m admin'); hi.append(el('span', '', 'Hi! 👋 Ask us anything — you do not need to log in. If you forgot your website password, tell us your WhatsApp number and we will help.'));
    list.append(hi);
    msgs.forEach(m => {
      const d = el('div', 'cc-m ' + (m.from === 'admin' ? 'admin' : 'me'));
      const sp = el('span'); sp.append(linkify(m.text));
      d.append(sp, el('time', '', hhmm(m.at)));
      list.append(d);
    });
    zoom.classList.toggle('hot', msgs.length >= 6);   // the chat is getting long: make the Zoom button stand out
    if (nearBottom || lastCount !== msgs.length) list.scrollTop = list.scrollHeight;
    lastCount = msgs.length;
  }
  function showBadge(n) { badge.hidden = !n || open; badge.textContent = n > 9 ? '9+' : String(n || ''); bubble.classList.toggle('ping', !!n && !open); }
  function showErr(t) { err.textContent = t || ''; err.hidden = !t; }

  // ── talking to the server ───────────────────────────────────
  async function poll() {
    if (document.hidden) return;
    try {
      const j = await api('/chat/api/messages' + (open ? '?open=1' : ''));
      const before = msgs.length;
      msgs = j.messages;
      if (j.name && j.name !== 'Visitor' && !nameIn.value) nameIn.value = j.name;
      named = msgs.length > 0;
      nameIn.hidden = named;
      unread = j.unread || 0; showBadge(unread);
      if (open && (msgs.length !== before || lastCount === -1)) render();
    } catch {}
  }
  setInterval(() => { poll(); }, 4000);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true; send.disabled = true; showErr('');
    try {
      if (nameIn.value.trim()) store('ccName', nameIn.value.trim());
      await api('/chat/api/send', 'POST', { text, name: nameIn.value });
      input.value = ''; autosize();
      msgs.push({ from: 'user', text, at: Date.now() }); render();
      list.scrollTop = list.scrollHeight;
      nameIn.hidden = true;
    } catch (er) {
      showErr(er.message === 'rate_limited' ? 'You are sending too fast. Wait a moment.' : er.message === 'busy' ? 'Chat is busy. Try again soon.' : 'Could not send. Try again.');
    }
    sending = false; send.disabled = false; input.focus();
  });
  zoomBtn.addEventListener('click', () => {
    if (!input.value.trim()) input.value = 'I would like a Zoom call please. My WhatsApp number is: ';
    autosize(); input.focus();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 90) + 'px'; }
  input.addEventListener('input', autosize);

  function toggle(prefill) {
    open = !open;
    if (typeof prefill === 'string' && open) { if (!input.value) input.value = prefill; autosize(); }
    panel.hidden = !open; bubble.classList.toggle('on', open);
    showBadge(unread);
    if (open) { place(); render(); poll(); setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50); }
  }
  close.addEventListener('click', () => toggle());

  // other scripts (e.g. "forgot password") can open the chat with a ready-made message
  window.openSupportChat = (prefill) => { if (!open) toggle(prefill); else if (typeof prefill === 'string' && !input.value) { input.value = prefill; input.focus(); } };

  place(); poll();
})();
