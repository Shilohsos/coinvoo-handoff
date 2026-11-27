// Coinvoo dashboard — the one browser script. Progressive enhancement only: every screen works without it.
// No framework, no dependencies. Data from the server is only ever inserted with textContent, never as HTML.
(function () {
  'use strict';
  var doc = document;
  var root = doc.documentElement;
  var ICONS = window.CV_ICONS || {};

  function svg(name) {
    var s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name] || ''; // constant markup shipped with this script
    return s;
  }
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function typing(e) {
    var t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  // ---------- theme ----------
  function syncThemeButtons() {
    var light = root.getAttribute('data-theme') === 'light';
    doc.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', light ? 'true' : 'false');
      b.setAttribute('title', light ? 'Switch to dark theme' : 'Switch to light theme');
    });
  }
  function toggleTheme() {
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('cv-theme', next); } catch (e) { /* private mode */ }
    syncThemeButtons();
  }
  syncThemeButtons();

  // The shortcut hint says what this keyboard has.
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) {
    doc.querySelectorAll('.search-btn kbd').forEach(function (k) { k.textContent = 'Ctrl K'; });
  }

  // ---------- copy ----------
  function copyFrom(btn) {
    var text = btn.getAttribute('data-copy');
    var label = btn.querySelector('span') || btn;
    var done = function () {
      var old = label.textContent;
      label.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(function () { label.textContent = old; btn.classList.remove('copied'); }, 1300);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) && done(); });
    } else if (legacyCopy(text)) done();
  }
  function legacyCopy(text) {
    var t = doc.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.className = 'sr';
    doc.body.appendChild(t);
    t.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    doc.body.removeChild(t);
    return ok;
  }

  // ---------- clicks ----------
  doc.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-theme-toggle]')) { toggleTheme(); return; }
    var c = t.closest('[data-copy]');
    if (c) { e.preventDefault(); copyFrom(c); return; }
    if (t.closest('[data-menu]')) { doc.body.classList.toggle('nav-open'); return; }
    if (t.closest('.backdrop')) { doc.body.classList.remove('nav-open'); return; }
    if (t.closest('[data-cmdk]')) { e.preventDefault(); palette.open(); return; }
    var row = t.closest('tr[data-href]');
    if (row && !t.closest('a,button,input,select,textarea,summary,label,details,form')) {
      var sel = window.getSelection && String(window.getSelection());
      if (sel) return; // the operator is selecting text to copy, not opening the row
      var href = row.getAttribute('data-href');
      if (e.metaKey || e.ctrlKey) window.open(href, '_blank');
      else location.href = href;
    }
  });

  // Filters that apply themselves.
  doc.addEventListener('change', function (e) {
    var f = e.target.form;
    if (e.target.hasAttribute('data-autosubmit') && f) {
      if (f.requestSubmit) f.requestSubmit(); else f.submit();
    }
  });

  // Destructive forms ask first.
  doc.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // ---------- chart tooltips ----------
  var tip = null;
  var tipOn = null;
  function hideTip() {
    if (tip) tip.hidden = true;
    if (tipOn) { tipOn.classList.remove('on'); tipOn = null; }
  }
  function showTip(target, x, y) {
    if (!tip) { tip = el('div', 'tip'); tip.setAttribute('role', 'tooltip'); doc.body.appendChild(tip); }
    if (tipOn !== target) {
      if (tipOn) tipOn.classList.remove('on');
      tipOn = target;
      target.classList.add('on');
      tip.textContent = target.getAttribute('data-tip');
    }
    tip.hidden = false;
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var left = Math.min(window.innerWidth - w - 8, x + 14);
    var top = y + 16 + h > window.innerHeight ? y - h - 12 : y + 16;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }
  doc.addEventListener('mousemove', function (e) {
    var h = e.target.closest && e.target.closest('[data-tip]');
    if (h) showTip(h, e.clientX, e.clientY); else if (tipOn) hideTip();
  });
  doc.addEventListener('mouseleave', hideTip);
  doc.addEventListener('scroll', hideTip, true);

  // ---------- command palette ----------
  var PAGES = [
    ['Overview', '/dash', 'home', 'g o'], ['Members', '/dash/members', 'users', 'g m'],
    ['Events', '/dash/events', 'activity', 'g e'], ['Parked events', '/dash/events?tab=parked', 'inbox', ''],
    ['Campaigns', '/dash/campaigns', 'chart', 'g c'], ['Spend', '/dash/spend', 'wallet', 'g s'],
    ['Links', '/dash/links', 'link', 'g l'], ['System', '/dash/system', 'server', 'g y'],
    ['Create an ad link', '/dash/links#new-link', 'plus', ''], ['Enter spend', '/dash/spend#new-spend', 'plus', ''],
    ['Export members (CSV)', '/api/export/members.csv?period=all', 'download', ''],
    ['Export events (CSV, 30 days)', '/api/export/events.csv?period=30d', 'download', '']
  ];
  var palette = (function () {
    var box = null; var input = null; var list = null; var items = []; var active = 0;
    var timer = null; var ctrl = null; var lastQ = null;

    function build() {
      box = el('div', 'cmdk');
      box.hidden = true;
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', 'Search and jump');
      var panel = el('div', 'cmdk-box');
      var bar = el('div', 'cmdk-in');
      bar.appendChild(svg('search'));
      input = el('input');
      input.type = 'text';
      input.setAttribute('placeholder', 'Search members, events, links, campaigns — or jump to a page');
      input.setAttribute('aria-label', 'Search');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      bar.appendChild(input);
      var esc = el('kbd', null, 'Esc');
      bar.appendChild(esc);
      list = el('div', 'cmdk-list');
      list.setAttribute('role', 'listbox');
      var foot = el('div', 'cmdk-foot');
      foot.appendChild(el('span', null, '↑ ↓ to move'));
      foot.appendChild(el('span', null, 'Enter to open'));
      foot.appendChild(el('span', null, 'Telegram id, @username, trader id, event id or link token'));
      panel.appendChild(bar);
      panel.appendChild(list);
      panel.appendChild(foot);
      box.appendChild(panel);
      doc.body.appendChild(box);
      box.addEventListener('mousedown', function (e) { if (e.target === box) close(); });
      input.addEventListener('input', function () { schedule(input.value); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); go(items[active]); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    }
    function open() {
      if (!box) build();
      box.hidden = false;
      input.value = '';
      render(staticMatches(''), null);
      input.focus(); // at once: keys typed right after the shortcut must land in the box
    }
    function close() { if (box) box.hidden = true; if (ctrl) ctrl.abort(); }
    function isOpen() { return box && !box.hidden; }
    function staticMatches(q) {
      q = q.trim().toLowerCase();
      return PAGES.filter(function (p) { return !q || p[0].toLowerCase().indexOf(q) !== -1; })
        .map(function (p) { return { label: p[0], href: p[1], icon: p[2], sub: p[3] }; });
    }
    function schedule(q) {
      clearTimeout(timer);
      render(staticMatches(q), q.trim() ? { loading: true } : null);
      if (!q.trim()) return;
      timer = setTimeout(function () { search(q.trim()); }, 140);
    }
    function search(q) {
      if (ctrl) ctrl.abort();
      ctrl = window.AbortController ? new AbortController() : null;
      lastQ = q;
      fetch('/dash/search?q=' + encodeURIComponent(q), { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r.ok ? r.json() : { groups: [] }; })
        .then(function (data) { if (q === lastQ && isOpen()) render(staticMatches(q), data); })
        .catch(function () { /* aborted or offline: the page list still works */ });
    }
    function render(pages, remote) {
      list.textContent = '';
      items = [];
      var groups = [];
      if (remote && remote.groups) groups = remote.groups.filter(function (g) { return g.items && g.items.length; });
      groups.forEach(function (g) { section(g.label, g.items.map(function (i) { return { label: i.label, sub: i.sub, href: i.href, icon: g.icon }; })); });
      if (pages.length) section('Pages and actions', pages);
      if (!items.length) list.appendChild(el('div', 'cmdk-empty', remote && remote.loading ? 'Searching…' : 'No matches.'));
      active = 0;
      paint();
    }
    function section(label, rows) {
      list.appendChild(el('div', 'cmdk-group', label));
      rows.forEach(function (r) {
        var it = el('div', 'cmdk-item');
        it.setAttribute('role', 'option');
        it.appendChild(svg(r.icon || 'right'));
        it.appendChild(el('span', 't', r.label));
        if (r.sub) it.appendChild(el('small', null, r.sub));
        var idx = items.length;
        it.addEventListener('mousemove', function () { if (active !== idx) { active = idx; paint(); } });
        it.addEventListener('click', function () { go(r); });
        list.appendChild(it);
        items.push(r);
        r.node = it;
      });
    }
    function paint() {
      items.forEach(function (r, i) {
        r.node.classList.toggle('on', i === active);
        r.node.setAttribute('aria-selected', i === active ? 'true' : 'false');
      });
      if (items[active]) items[active].node.scrollIntoView({ block: 'nearest' });
    }
    function move(d) {
      if (!items.length) return;
      active = (active + d + items.length) % items.length;
      paint();
    }
    function go(r) { if (r && r.href) { close(); location.href = r.href; } }
    return { open: open, close: close, isOpen: isOpen };
  })();

  // ---------- keyboard ----------
  var pendingG = 0;
  var JUMP = { o: '/dash', m: '/dash/members', e: '/dash/events', c: '/dash/campaigns', s: '/dash/spend', l: '/dash/links', y: '/dash/system' };
  doc.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (palette.isOpen()) palette.close(); else palette.open(); return; }
    if (e.key === 'Escape') { doc.body.classList.remove('nav-open'); if (palette.isOpen()) palette.close(); return; }
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); palette.open(); return; }
    if (pendingG && Date.now() - pendingG < 1200 && JUMP[e.key]) { pendingG = 0; location.href = JUMP[e.key]; return; }
    pendingG = e.key === 'g' ? Date.now() : 0;
  });
})();
