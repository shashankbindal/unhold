/* Unhold dashboard app. Shared state + hash router + SSE agent run. No external dependencies. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var qa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var I = function (n, s, c) { return window.UIcon(n, s, c); };
  var usd = function (n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); };
  var usd2 = function (n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var isSim = function (src) { return /^simulated/i.test(String(src || '')); };
  var getJSON = function (url, opts) {
    return fetch(url, opts).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  };
  var LEVEL_COLOR = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--ok)', resolved: 'var(--ok)' };
  var levelOf = function (score) { return score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low'; };

  /* ---------- shared state ---------- */
  var S = {
    assessment: null, before: null, report: null, explanations: {},
    approvals: {}, // id -> {ev, status:'pending'|'done'|'error', refund_id}
    config: null, history: null, audit: [], rules: null,
    running: false, es: null, route: 'overview', range: 30,
    q: '', level: 'all', fix: 'all', sort: { key: 'risk', dir: -1 },
    drawerOrder: null, payloadCache: {}
  };
  window.UnholdState = S;

  /* ---------- icons in static markup ---------- */
  function hydrateIcons(root) {
    qa('[data-icon]', root).forEach(function (el) {
      if (el.dataset.hydrated) return;
      el.insertAdjacentHTML('afterbegin', I(el.dataset.icon, Number(el.dataset.size) || 16));
      el.dataset.hydrated = '1';
    });
  }
  hydrateIcons(document);

  /* ---------- tooltips ---------- */
  var tip = $('tip');
  function tipify(root) {
    qa('svg title', root).forEach(function (t) {
      var p = t.parentNode; if (p && p.setAttribute) p.setAttribute('data-tip', t.textContent);
      t.parentNode.removeChild(t);
    });
  }
  document.addEventListener('mousemove', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) { tip.classList.remove('on'); return; }
    tip.textContent = t.getAttribute('data-tip');
    var x = e.clientX + 14, y = e.clientY + 14, w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 10;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 10;
    tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.classList.add('on');
  });

  /* ---------- router ---------- */
  var ROUTES = ['overview', 'orders', 'forecast', 'agent', 'settings'];
  function route() {
    var r = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
    if (ROUTES.indexOf(r) < 0) r = 'overview';
    S.route = r;
    ROUTES.forEach(function (n) { $('page-' + n).hidden = n !== r; });
    qa('#nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.route === r); if (a.dataset.route === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('crumb').textContent = $('page-' + r).dataset.title;
    document.title = $('page-' + r).dataset.title + ' | Unhold';
    $('shell').classList.remove('nav-open');
    if (r === 'overview' || r === 'forecast') renderCharts();
    if (r === 'settings') loadAudit();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  /* ---------- sidebar ---------- */
  try { if (localStorage.getItem('unhold.sb') === '1') $('shell').classList.add('collapsed'); } catch (e) { /* ignore */ }
  $('sbCollapse').onclick = function () {
    var c = $('shell').classList.toggle('collapsed');
    $('sbCollapse').innerHTML = I(c ? 'expand' : 'collapse');
    $('sbCollapse').setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar');
    try { localStorage.setItem('unhold.sb', c ? '1' : '0'); } catch (e) { /* ignore */ }
    setTimeout(renderCharts, 200);
  };
  if ($('shell').classList.contains('collapsed')) $('sbCollapse').innerHTML = I('expand');
  $('menuBtn').onclick = function () { $('shell').classList.add('nav-open'); };
  $('scrim').onclick = function () { $('shell').classList.remove('nav-open'); };

  /* ---------- header controls ---------- */
  $('gSearch').addEventListener('input', function () {
    S.q = this.value; $('oSearch').value = S.q;
    if (S.route !== 'orders') location.hash = '#/orders';
    renderOrdersTable();
  });
  $('oSearch').addEventListener('input', function () { S.q = this.value; $('gSearch').value = S.q; renderOrdersTable(); });
  $('range').addEventListener('change', function () { S.range = Number(this.value); renderKpis(); });

  /* ---------- helpers ---------- */
  function pendingApprovalFor(orderId) {
    for (var k in S.approvals) { var a = S.approvals[k]; if (a.ev.order_id === orderId && a.status !== 'done') return a; }
    return null;
  }
  function fixInfo(o) {
    if (o.level === 'resolved' || o.refunded) return { key: 'none', cls: 'ok', icon: 'checkCircle', text: 'Refunded' };
    if (o.fix && o.fix.type === 'UPLOAD_TRACKING') return { key: 'UPLOAD_TRACKING', cls: 'todo', icon: 'upload', text: 'Upload tracking (' + (o.fix.carrier || '') + ')' };
    if (o.fix && o.fix.type === 'REFUND') return { key: 'REFUND', cls: 'appr', icon: 'hand', text: 'Refund needs approval' };
    if (o.trackersOnPayPal && o.trackersOnPayPal.length) return { key: 'none', cls: 'ok', icon: 'checkCircle', text: 'Tracking on PayPal' };
    return { key: 'none', cls: 'none', icon: 'dot', text: 'No action needed' };
  }
  function fixHtml(o) { var f = fixInfo(o); return '<span class="fix ' + f.cls + '">' + I(f.icon, 14) + esc(f.text) + '</span>'; }
  function pill(level, text) { return '<span class="pill ' + esc(level) + '">' + esc(text || level) + '</span>'; }
  function topFactor(o) {
    var f = (o.factors || []).slice().sort(function (a, b) { return b.points - a.points; })[0];
    return f ? f.label : '';
  }
  function fmtTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return esc(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  function auditStatus(e) {
    var r = e.result || {};
    if (r.error || r.ok === false) return ['bad', 'Failed'];
    if (/PROPOSE|QUEUE|PENDING/i.test(e.action)) return ['warn', 'Pending approval'];
    if (/ASSESS/i.test(e.action)) return ['neutral', 'Scored'];
    return ['ok', 'Completed'];
  }
  function spark(values, opts) {
    opts = opts || {};
    if (!values || values.length < 2) return '';
    var W = 220, H = 34, max = Math.max.apply(null, values.map(function (v) { return v.v; }).concat([1]));
    var step = W / (values.length - (opts.bars ? 0 : 1));
    var col = opts.color || 'var(--c2)', s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="34" preserveAspectRatio="none" aria-hidden="true">';
    if (opts.bars) {
      values.forEach(function (p, i) {
        var h = Math.max(2, (p.v / max) * (H - 2));
        s += '<rect data-tip="' + esc(p.tip) + '" x="' + (i * step + 1).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(2, step - 3).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5" style="fill:' + (p.color || col) + '"/>';
      });
    } else {
      var pts = values.map(function (p, i) { return [i * step, H - 3 - (p.v / max) * (H - 6)]; });
      var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('');
      s += '<path d="' + d + 'L' + W + ',' + H + 'L0,' + H + 'Z" style="fill:' + col + ';fill-opacity:.08"/>';
      s += '<path d="' + d + '" vector-effect="non-scaling-stroke" style="fill:none;stroke:' + col + ';stroke-width:1.75"/>';
      values.forEach(function (p, i) {
        s += '<rect data-tip="' + esc(p.tip) + '" x="' + (pts[i][0] - step / 2).toFixed(1) + '" y="0" width="' + step.toFixed(1) + '" height="' + H + '" style="fill:transparent"/>';
      });
    }
    return s + '</svg>';
  }

  /* ---------- overview ---------- */
  function deltaBadge(from, to, fmt, lowerIsBetter) {
    if (from == null || to == null || from === to) return '';
    var good = lowerIsBetter === false ? to > from : to < from;
    return '<span class="delta ' + (good ? 'good' : 'bad') + '" data-tip="Before the agent: ' + esc(fmt(from)) + '">' + I(to < from ? 'arrowDown' : 'arrowUp', 12) + esc(fmt(from)) + '</span>';
  }
  function renderKpis() {
    var a = S.assessment; if (!a) return;
    var acc = a.account, b = S.before && S.before.account;
    var orders = a.orders.slice().sort(function (x, y) { return y.risk - x.risk; });
    var riskSpark = spark(orders.map(function (o) { return { v: o.risk, tip: o.item + ': risk ' + o.risk, color: LEVEL_COLOR[o.level] }; }), { bars: true });
    var highs = orders.filter(function (o) { return o.level === 'high'; });
    var amtSpark = highs.length > 1 ? spark(highs.map(function (o) { return { v: Number(o.amount), tip: o.item + ': ' + usd2(o.amount), color: 'var(--bad)' }; }), { bars: true }) : '';
    var refundSpark = '', refundNote = '';
    if (S.history && S.history.refunds_by_day) {
      var days = S.history.refunds_by_day.filter(function (d) { return d.day > -S.range; }).sort(function (x, y) { return x.day - y.day; });
      var total = days.reduce(function (s, d) { return s + (d.count || 0); }, 0);
      refundSpark = spark(days.map(function (d) { return { v: d.count || 0, tip: (d.day === 0 ? 'Today' : (-d.day) + 'd ago') + ': ' + (d.count || 0) + ' refunds, ' + usd(d.amount) }; }), { color: 'var(--c4)' });
      refundNote = total + ' refunds in the last ' + S.range + ' days (simulated history)';
    }
    var line = acc.days_to_limitation_line;
    $('kpis').innerHTML =
      '<div class="card kpi"><div class="k">' + I('gauge') + 'Hold-risk score</div>' +
        '<div class="v">' + acc.score + '<span class="muted small">/ 100</span>' + deltaBadge(b && b.score, acc.score, String) + '</div>' +
        '<div class="sub">' + pill(levelOf(acc.score)) + ' Per-order risk, highest first</div><div class="spark">' + riskSpark + '</div></div>' +
      '<div class="card kpi"><div class="k">' + I('alert') + 'At high risk</div>' +
        '<div class="v">' + usd(acc.at_risk_usd) + deltaBadge(b && b.at_risk_usd, acc.at_risk_usd, usd) + '</div>' +
        '<div class="sub">' + highs.length + ' high-risk order' + (highs.length === 1 ? '' : 's') + '</div><div class="spark">' + amtSpark + '</div></div>' +
      '<div class="card kpi"><div class="k">' + I('lock') + 'Held now <span class="pill sim">Simulated</span></div>' +
        '<div class="v">' + usd(acc.held_total_usd) + deltaBadge(b && b.held_total_usd, acc.held_total_usd, usd) + '</div>' +
        '<div class="sub">The sandbox never withholds funds; holds are simulated.</div></div>' +
      '<div class="card kpi"><div class="k">' + I('calendar') + 'Days to limitation-risk line</div>' +
        '<div class="v">' + (line == null ? 'Clear' : line + '<span class="muted small">days</span>') + deltaBadge(b && b.days_to_limitation_line, line, function (x) { return x == null ? 'clear' : x + 'd'; }, false) + '</div>' +
        '<div class="sub">' + (refundNote || 'Refund pace at current trend') + '</div><div class="spark">' + refundSpark + '</div></div>';
  }
  function renderGauge() {
    var a = S.assessment; if (!a) return;
    var sc = a.account.score, lvl = levelOf(sc), L = Math.PI * 80;
    var was = S.before && S.before.account.score !== sc ? 'was ' + S.before.account.score : 'out of 100';
    $('gauge').innerHTML = '<div class="gauge"><svg viewBox="0 0 200 112" width="200" height="112" role="img" aria-label="Hold-risk score ' + sc + ' of 100">' +
      '<path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--surface-2)" stroke-width="14" stroke-linecap="round"/>' +
      '<path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="' + LEVEL_COLOR[lvl] + '" stroke-width="14" stroke-linecap="round" stroke-dasharray="' + L.toFixed(1) + '" stroke-dashoffset="' + (L * (1 - sc / 100)).toFixed(1) + '" style="transition:stroke-dashoffset .6s ease"/>' +
      '</svg><div class="gnum"><b style="color:' + LEVEL_COLOR[lvl] + '">' + sc + '</b><span>' + esc(was) + '</span></div></div>';
    var highs = a.orders.filter(function (o) { return o.level === 'high'; }).length;
    $('headline').textContent = highs ? highs + ' order' + (highs > 1 ? 's are' : ' is') + ' likely to get held: ' + usd(a.account.at_risk_usd) + ' at risk.' : 'No orders at high risk right now.';
  }
  function renderAttention() {
    var a = S.assessment; if (!a) return;
    var rows = a.orders.filter(function (o) { return o.level !== 'resolved'; }).sort(function (x, y) { return y.risk - x.risk; }).slice(0, 5);
    $('attention').innerHTML = rows.length ? '<table class="tbl"><thead><tr><th>Order</th><th class="num">Amount</th><th>Risk</th><th>Fix</th></tr></thead><tbody>' +
      rows.map(function (o) {
        return '<tr class="click" data-order="' + esc(o.orderId) + '"><td><div class="ellip" style="max-width:180px;font-weight:500">' + esc(o.item) + '</div><div class="muted small mono">' + esc(o.orderId) + '</div></td>' +
          '<td class="num">' + usd2(o.amount) + '</td><td>' + pill(o.level, o.level + ' ' + o.risk) + '</td><td>' + fixHtml(o) + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">No open orders need attention.</div>';
  }
  function renderRecent() {
    var rows = S.audit.slice().reverse().slice(0, 8);
    $('recentActivity').innerHTML = rows.length ? '<table class="tbl"><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Status</th></tr></thead><tbody>' +
      rows.map(function (e) {
        var st = auditStatus(e);
        return '<tr><td class="muted small" style="white-space:nowrap">' + fmtTime(e.at) + '</td><td><b style="font-weight:600">' + esc(e.action) + '</b>' +
          (e.payload && e.payload.order_id ? '<div class="muted small mono">' + esc(e.payload.order_id) + '</div>' : '') + '</td><td>' + esc(e.actor) + '</td><td>' + pill(st[0], st[1]) + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">No activity yet. Run the agent to see actions here.</div>';
  }

  /* ---------- charts ---------- */
  function renderCharts() {
    if (!S.assessment || !window.UnholdCharts) return;
    if (S.route !== 'overview' && S.route !== 'forecast') return;
    try { window.UnholdCharts.render(S.assessment, S.before); } catch (e) { console.error(e); }
    ['chartFactors', 'chartSku', 'chartOrders'].forEach(function (id) { tipify($(id)); });
  }
  // charts.js re-renders on resize; re-apply custom tooltips afterwards
  window.addEventListener('resize', function () { setTimeout(function () { ['chartFactors', 'chartSku', 'chartOrders'].forEach(function (id) { tipify($(id)); }); }, 220); });

  /* ---------- orders table ---------- */
  function filteredOrders() {
    var a = S.assessment; if (!a) return [];
    var q = S.q.trim().toLowerCase();
    var rows = a.orders.filter(function (o) {
      if (S.level !== 'all' && o.level !== S.level) return false;
      if (S.fix !== 'all' && fixInfo(o).key !== S.fix) return false;
      if (q && (o.orderId + ' ' + o.item + ' ' + o.sku).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var k = S.sort.key, d = S.sort.dir;
    rows.sort(function (x, y) {
      var a1 = x[k], b1 = y[k];
      if (k === 'amount' || k === 'risk' || k === 'daysAgo') { a1 = Number(a1); b1 = Number(b1); }
      else { a1 = String(a1 || '').toLowerCase(); b1 = String(b1 || '').toLowerCase(); }
      return a1 < b1 ? -d : a1 > b1 ? d : 0;
    });
    return rows;
  }
  function renderOrdersTable(flashIds) {
    if (!S.assessment) return;
    var rows = filteredOrders();
    qa('#ordersTbl th[data-sort]').forEach(function (th) {
      var old = th.querySelector('.sort-ic'); if (old) old.remove();
      th.setAttribute('aria-sort', th.dataset.sort === S.sort.key ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
      if (th.dataset.sort === S.sort.key) th.insertAdjacentHTML('beforeend', '<span class="sort-ic">' + I(S.sort.dir > 0 ? 'arrowUp' : 'arrowDown', 12) + '</span>');
    });
    $('ordersBody').innerHTML = rows.length ? rows.map(function (o) {
      var flash = flashIds && flashIds[o.orderId];
      return '<tr class="click' + (flash ? ' flash' : '') + '" data-order="' + esc(o.orderId) + '" tabindex="0">' +
        '<td class="mono">' + esc(o.orderId) + '</td><td class="num">' + esc(o.daysAgo) + 'd</td>' +
        '<td><div class="ellip" style="max-width:200px">' + esc(o.item) + '</div></td><td class="mono">' + esc(o.sku) + '</td>' +
        '<td class="num">' + usd2(o.amount) + '</td>' +
        '<td><div class="riskcell">' + pill(o.level) + '<span class="riskbar"><i style="width:' + o.risk + '%;background:' + LEVEL_COLOR[o.level] + '"></i></span><span class="rv">' + o.risk + '</span></div></td>' +
        '<td><div class="ellip" title="' + esc(topFactor(o)) + '">' + esc(topFactor(o) || 'None') + '</div></td><td>' + fixHtml(o) + '</td></tr>';
    }).join('') : '<tr><td colspan="8"><div class="empty">No orders match these filters.</div></td></tr>';
    $('ordersFoot').textContent = 'Showing ' + rows.length + ' of ' + S.assessment.orders.length + ' orders';
  }
  qa('#ordersTbl th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.dataset.sort;
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'item' || k === 'sku' || k === 'orderId' ? 1 : -1) };
      renderOrdersTable();
    });
  });
  qa('#levelSeg button').forEach(function (b) {
    b.addEventListener('click', function () {
      S.level = b.dataset.level;
      qa('#levelSeg button').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
      renderOrdersTable();
    });
  });
  $('fixFilter').addEventListener('change', function () { S.fix = this.value; renderOrdersTable(); });
  $('exportCsv').onclick = function () {
    var rows = filteredOrders();
    var cell = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [['order_id', 'age_days', 'item', 'sku', 'amount_usd', 'risk', 'level', 'top_factor', 'fix_status']].concat(rows.map(function (o) {
      return [o.orderId, o.daysAgo, o.item, o.sku, o.amount, o.risk, o.level, topFactor(o), fixInfo(o).text];
    })).map(function (r) { return r.map(cell).join(','); }).join('\n');
    var blob = new Blob([lines], { type: 'text/csv' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'unhold-orders.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };
  document.addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('tr[data-order]');
    if (tr) openDrawer(tr.dataset.order);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeDrawer(); $('shell').classList.remove('nav-open'); }
    if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-order]')) openDrawer(e.target.dataset.order);
  });

  /* ---------- drawer ---------- */
  var lastFocus = null;
  function openDrawer(id) {
    S.drawerOrder = id; lastFocus = document.activeElement;
    renderDrawer();
    $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false'); $('dScrim').classList.add('open');
    setTimeout(function () { $('dClose').focus(); }, 50);
  }
  function closeDrawer() {
    if (!S.drawerOrder) return;
    S.drawerOrder = null;
    $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); $('dScrim').classList.remove('open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $('dClose').onclick = closeDrawer; $('dScrim').onclick = closeDrawer;
  function renderDrawer() {
    var id = S.drawerOrder; if (!id || !S.assessment) return;
    var o = S.assessment.orders.filter(function (x) { return x.orderId === id; })[0];
    if (!o) { $('dBody').innerHTML = '<div class="empty">Order not found.</div>'; return; }
    $('dTitle').textContent = o.item;
    $('dSub').innerHTML = '<b class="tnum" style="color:var(--ink)">' + usd2(o.amount) + '</b>' + pill(o.level, o.level + ' risk ' + o.risk) + '<span class="mono">' + esc(o.orderId) + '</span>';
    var factors = (o.factors || []).length ? '<div class="flist">' + o.factors.map(function (f) {
      var sim = isSim(f.source);
      return '<div><span class="pts">+' + esc(f.points) + '</span><span class="lb">' + esc(f.label) + '<div class="srcl">' + esc(f.source) + '</div></span><span class="pill ' + (sim ? 'sim' : 'ver') + '">' + (sim ? 'Simulated' : 'Verified') + '</span></div>';
    }).join('') + '</div>' : '<div class="empty">No risk factors on this order.</div>';
    var ai = S.explanations[id] ? '<div class="dsec"><h3>Explanation</h3><div class="ai-box"><span class="pill ai">AI inference</span> ' + esc(S.explanations[id]) + '</div></div>' : '';
    var events = S.audit.filter(function (e) { return e.payload && e.payload.order_id === id; });
    var tl = '<li><time>' + esc(o.daysAgo) + ' days ago</time>Order created and captured on PayPal' + (o.captureId ? ' <span class="mono muted">' + esc(o.captureId) + '</span>' : '') + '</li>' +
      (o.shipped ? '<li><time>Shipping export</time>Shipped via ' + esc(o.carrier) + (o.tracking ? ' <span class="mono muted">' + esc(o.tracking) + '</span>' : '') + '</li>' : '<li><time>Shipping export</time>Not shipped yet</li>') +
      events.map(function (e) { var st = auditStatus(e); return '<li><time>' + fmtTime(e.at) + ' &middot; ' + esc(e.actor) + '</time>' + esc(e.action) + ' ' + pill(st[0], st[1]) + '</li>'; }).join('');
    var ap = pendingApprovalFor(id), action;
    if (ap) action = approvalCard(ap, true);
    else {
      var fi = fixInfo(o);
      action = '<div class="flist"><div><span class="fix ' + fi.cls + '">' + I(fi.icon, 14) + esc(fi.text) + '</span></div></div>' +
        '<p class="note">Fix assigned by deterministic code.' + (o.fix && o.fix.type === 'REFUND' ? ' Run the agent to queue this refund for your approval.' : '') + '</p>';
    }
    $('dBody').innerHTML =
      '<div class="dsec"><h3>Why this score</h3>' + factors + '</div>' + ai +
      '<div class="dsec"><h3>Action</h3><div id="dAction"></div></div>' +
      '<div class="dsec"><h3>Timeline</h3><ul class="timeline">' + tl + '</ul></div>' +
      '<div class="dsec"><details class="payload" id="dPayload"><summary>' + I('chevronDown', 14) + 'PayPal API payload <span class="muted small mono" style="font-weight:400">GET /v2/checkout/orders/' + esc(id) + '</span></summary><pre id="dPre">Loading...</pre></details></div>';
    var slot = $('dAction');
    if (typeof action === 'string') slot.innerHTML = action; else slot.appendChild(action);
    $('dPayload').addEventListener('toggle', function () {
      if (!this.open) return;
      if (S.payloadCache[id]) { $('dPre').textContent = S.payloadCache[id]; return; }
      getJSON('/api/order/' + encodeURIComponent(id)).then(function (j) {
        S.payloadCache[id] = JSON.stringify(j, null, 2); if (S.drawerOrder === id && $('dPre')) $('dPre').textContent = S.payloadCache[id];
      }).catch(function (e) { if ($('dPre')) $('dPre').textContent = 'Payload unavailable (' + e.message + ').'; });
    });
  }

  /* ---------- approvals ---------- */
  function approvalCard(ap, compact) {
    var ev = ap.ev, d = document.createElement('div');
    d.className = 'appr' + (ap.status === 'done' ? ' done' : '');
    d.innerHTML = '<div class="amt tnum">' + usd2(ev.amount) + '</div><div class="what">Refund &middot; ' + esc(ev.item) + '</div>' +
      (compact ? '' : '<div class="muted small mono">' + esc(ev.order_id) + '</div>') +
      '<div style="font-size:13px;margin-top:6px">' + esc(ev.reason) + '</div>' +
      '<div class="cando"><div class="y">' + I('checkCircle', 14) + '<span><b>Can do:</b> resolve a late order before the buyer opens a dispute.</span></div>' +
      '<div class="n">' + I('xCircle', 14) + '<span><b>Can\'t do:</b> release held funds. A refund returns money to the buyer.</span></div></div>' +
      '<div class="hash">' + I('lock', 13) + 'Bound to sha256 <code>' + esc(String(ev.payload_sha256 || '').slice(0, 16)) + '</code> of {order, capture, amount}</div>';
    var b = document.createElement('button'); b.className = 'btn primary';
    if (ap.status === 'done') { b.disabled = true; b.innerHTML = I('check', 14) + 'Refunded &middot; ' + esc(ap.refund_id || ''); b.className = 'btn'; }
    else if (ap.status === 'busy') { b.disabled = true; b.textContent = 'Refunding on PayPal...'; }
    else b.innerHTML = I('refund', 14) + 'Approve ' + esc(usd2(ev.amount)) + ' refund';
    b.onclick = function () { approve(ev.id); };
    d.appendChild(b);
    if (ap.error) d.insertAdjacentHTML('beforeend', '<div class="small" style="color:var(--bad);margin-top:8px">' + esc(ap.error) + '</div>');
    return d;
  }
  function renderApprovals() {
    var box = $('approvals'), list = Object.keys(S.approvals).map(function (k) { return S.approvals[k]; });
    box.innerHTML = list.length ? '' : '<div class="empty">Nothing to approve.</div>';
    list.forEach(function (ap) { box.appendChild(approvalCard(ap)); });
    var pending = list.filter(function (a) { return a.status !== 'done'; }).length;
    $('navAppr').textContent = pending ? pending : '';
  }
  function approve(id) {
    var ap = S.approvals[id]; if (!ap || ap.status === 'done' || ap.status === 'busy') return;
    ap.status = 'busy'; ap.error = null; renderApprovals(); renderDrawer();
    getJSON('/api/approve/' + encodeURIComponent(id), { method: 'POST' }).catch(function (e) { return { ok: false, error: e.message }; }).then(function (r) {
      if (r.ok) {
        ap.status = 'done'; ap.refund_id = r.refund_id;
        log('action', 'Refund executed on PayPal <span class="m">' + esc(r.refund_id) + ' (' + esc(r.status) + ')</span>');
        if (r.assessment) setAssessment(r.assessment, [ap.ev.order_id]);
        loadAudit();
      } else { ap.status = 'pending'; ap.error = r.error || 'Approval failed'; log('error', esc(ap.error)); }
      renderApprovals(); renderDrawer();
    });
  }

  /* ---------- feed / stepper ---------- */
  var FEED_ICON = { tool: 'tool', action: 'checkCircle', thought: 'thought', error: 'alert', approval: 'hand', code: 'code' };
  function log(kind, html) {
    var feed = $('log'); if (feed.querySelector('.empty')) feed.innerHTML = '';
    var d = document.createElement('div'); d.className = 'ev ' + kind;
    var t = new Date().toLocaleTimeString('en-US', { hour12: false });
    d.innerHTML = '<span class="eic">' + I(FEED_ICON[kind] || 'dot', 14) + '</span><span class="tx">' + html + '</span><time>' + t + '</time>';
    feed.appendChild(d); feed.scrollTop = feed.scrollHeight;
  }
  function step(n, state) { var el = $('st' + n); el.classList.remove('active', 'done'); if (state) el.classList.add(state); if (state === 'done') el.querySelector('.sn').innerHTML = I('check', 14); else el.querySelector('.sn').textContent = n; }

  /* ---------- report ---------- */
  function renderReport() {
    var r = S.report; if (!r) return;
    (r.order_explanations || []).forEach(function (e) { S.explanations[e.order_id] = e.explanation; });
    if (r.summary) { $('summary').hidden = false; $('summary').innerHTML = '<span class="pill ai">AI inference</span> <b>Unhold\'s take:</b> ' + esc(r.summary); }
    var cl = r.prevention_checklist || [];
    $('checklist').innerHTML = cl.length ? '<ol class="check">' + cl.map(function (t) { return '<li><span>' + esc(t) + '</span></li>'; }).join('') + '</ol>' : '<div class="empty">Nothing to do this week.</div>';
    var acc = S.assessment ? S.assessment.account : {}, stats = acc.sku_stats || {}, shop = acc.shop_refund_rate || 0;
    var causes = r.sku_root_causes || [];
    $('skus').innerHTML = causes.length ? causes.map(function (c) {
      var s = stats[c.sku], max = Math.max(s ? s.refund_rate : 0, shop, 0.01);
      return '<div class="sku"><div class="hd"><span class="mono">' + esc(c.sku) + '</span>' + (s ? '<span class="pill bad">' + esc(s.vs_shop) + 'x shop average</span>' : '') + '</div>' +
        '<div style="margin-top:4px">' + esc(c.problem) + '</div>' +
        (s ? '<div class="cmp"><div>This product: <b class="tnum">' + (s.refund_rate * 100).toFixed(0) + '%</b> refunded (' + s.refunds + '/' + s.orders + ')</div><div class="b"><i style="width:' + (s.refund_rate / max * 100) + '%;background:var(--bad)"></i></div>' +
          '<div>Shop average: <b class="tnum">' + (shop * 100).toFixed(0) + '%</b></div><div class="b"><i style="width:' + (shop / max * 100) + '%;background:var(--c1)"></i></div></div>' : '') +
        (c.evidence_quotes || []).map(function (q) { return '<blockquote>"' + esc(q) + '"</blockquote>'; }).join('') +
        '<div class="rec"><b>Fix:</b> ' + esc(c.recommendation) + '</div></div>';
    }).join('') : '<div class="empty">No product-level pattern found.</div>';
    var items = {}; ((S.assessment && S.assessment.orders) || []).forEach(function (o) { items[o.orderId] = o.item; });
    var msgs = r.buyer_messages || [];
    $('msgs').innerHTML = msgs.length ? '' : '<div class="empty">No at-risk buyers need a message.</div>';
    msgs.forEach(function (m) {
      var d = document.createElement('div'); d.className = 'msg';
      d.innerHTML = '<div style="font-weight:600">' + esc(items[m.order_id] || 'Order') + ' <span class="muted small mono">' + esc(m.order_id) + '</span></div>';
      var ta = document.createElement('textarea'); ta.value = m.message; ta.setAttribute('aria-label', 'Draft message to buyer');
      var b = document.createElement('button'); b.className = 'btn sm'; b.innerHTML = I('copy', 14) + 'Copy message';
      b.onclick = function () {
        var done = function () { b.innerHTML = I('check', 14) + 'Copied'; setTimeout(function () { b.innerHTML = I('copy', 14) + 'Copy message'; }, 1600); };
        if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); }); else { ta.select(); }
      };
      d.appendChild(ta); d.appendChild(b); $('msgs').appendChild(d);
    });
    renderDrawer();
  }

  /* ---------- assessment ---------- */
  function setAssessment(a, flash) {
    var prev = S.assessment, flashIds = {};
    if (prev) a.orders.forEach(function (o) { var p = prev.orders.filter(function (x) { return x.orderId === o.orderId; })[0]; if (p && p.risk !== o.risk) flashIds[o.orderId] = 1; });
    (flash || []).forEach(function (id) { flashIds[id] = 1; });
    S.assessment = a;
    var highs = a.orders.filter(function (o) { return o.level === 'high'; }).length;
    $('navHigh').textContent = highs ? highs : '';
    renderKpis(); renderGauge(); renderAttention(); renderOrdersTable(flashIds); renderCharts(); renderDrawer(); runSim();
  }

  /* ---------- what-if ---------- */
  var simTimer;
  function topSku(a) {
    var s = Object.keys((a && a.account.sku_stats) || {}).map(function (k) { return [k, a.account.sku_stats[k]]; })
      .filter(function (x) { return x[1].refunds >= 3; }).sort(function (x, y) { return y[1].vs_shop - x[1].vs_shop; })[0];
    return s ? s[0] : null;
  }
  function arrow(from, to, fmt, lowerIsBetter) {
    fmt = fmt || String; if (lowerIsBetter == null) lowerIsBetter = true;
    if (from === to) return '<span>' + esc(fmt(to)) + '</span>';
    var better = from == null ? false : to == null ? !lowerIsBetter : (to < from) === lowerIsBetter;
    return '<span class="from">' + esc(fmt(from)) + '</span>' + I('arrowRight', 14) + '<span class="' + (better ? 'down' : 'up') + '">' + esc(fmt(to)) + '</span>';
  }
  function runSim() {
    if (!S.assessment) return;
    var sku = topSku(S.assessment);
    $('w_skuname').textContent = sku || 'none flagged';
    $('w_multv').textContent = $('w_mult').value + 'x current pace';
    var scenario = { uploadAllTracking: $('w_track').checked, resolveLateOrders: $('w_late').checked, fixSkus: $('w_sku').checked && sku ? [sku] : [], salesMultiplier: Number($('w_mult').value) };
    getJSON('/api/whatif', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scenario) }).then(function (r) {
      if (!r || r.error) return;
      var cur = S.assessment.account, a = r.account;
      $('s_score').innerHTML = arrow(cur.score, a.score);
      $('s_risk').innerHTML = arrow(cur.at_risk_usd, a.at_risk_usd, usd);
      $('s_line').innerHTML = arrow(cur.days_to_limitation_line, a.days_to_limitation_line, function (x) { return x == null ? 'Clear' : x + 'd'; }, false);
    }).catch(function () { /* keep previous */ });
  }
  ['w_track', 'w_late', 'w_sku', 'w_mult'].forEach(function (id) { $(id).addEventListener('input', function () { clearTimeout(simTimer); simTimer = setTimeout(runSim, 120); }); });

  /* ---------- audit, rules, config ---------- */
  function loadAudit() {
    return getJSON('/api/audit').catch(function () { return []; }).then(function (rows) {
      S.audit = Array.isArray(rows) ? rows : [];
      renderRecent(); renderDrawer();
      $('audit').innerHTML = S.audit.length ? '<table class="tbl"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Order</th><th>Payload sha256</th><th>Status</th><th>Result</th></tr></thead><tbody>' +
        S.audit.slice().reverse().map(function (e) {
          var st = auditStatus(e);
          return '<tr><td style="white-space:nowrap">' + fmtTime(e.at) + '</td><td>' + esc(e.actor) + '</td><td><b style="font-weight:600">' + esc(e.action) + '</b></td>' +
            '<td class="mono small">' + esc((e.payload && e.payload.order_id) || '') + '</td><td><code data-tip="' + esc(e.payload_sha256) + '">' + esc(String(e.payload_sha256 || '').slice(0, 12)) + '</code></td>' +
            '<td>' + pill(st[0], st[1]) + '</td><td><div class="ellip mono small" style="max-width:280px" title="' + esc(JSON.stringify(e.result)) + '">' + esc(JSON.stringify(e.result)) + '</div></td></tr>';
        }).join('') + '</tbody></table>' : '<div class="empty">No audit entries yet.</div>';
    });
  }
  function loadRules() {
    getJSON('/api/rules').then(function (rules) {
      S.rules = rules;
      $('rules').innerHTML = rules.length ? '<table class="tbl"><thead><tr><th>Rule</th><th class="num">Points</th><th>Evidence source</th></tr></thead><tbody>' +
        rules.map(function (r) {
          var sim = /simulated/i.test(r.source);
          return '<tr><td><div style="font-weight:500">' + esc(r.label) + '</div><div class="muted small mono">' + esc(r.id) + '</div></td><td class="num"><b>+' + esc(r.points) + '</b></td><td>' + esc(r.source) + (sim ? ' <span class="pill sim">Simulated</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>' : '<div class="empty">No rules returned.</div>';
    }).catch(function () { $('rules').innerHTML = '<div class="empty">Rules unavailable.</div>'; });
  }
  function applyConfig(c) {
    S.config = c;
    var mock = c.paypal === 'mock';
    $('envBadge').className = 'env-badge ' + (mock ? 'mock' : 'sandbox');
    $('envText').textContent = mock ? 'Offline mock' : 'Sandbox';
    $('envBadge').setAttribute('title', mock ? 'Offline mock PayPal' : 'PayPal Sandbox');
    $('banner').hidden = false; $('banner').classList.toggle('mock', mock);
    $('bannerTxt').innerHTML = mock ? '<b>Offline mock PayPal</b> &mdash; PayPal calls go to a local mock that mimics the API.'
      : '<b>PayPal Sandbox</b> &mdash; orders and actions are real sandbox API calls; holds and history are simulated.';
    $('reset').hidden = !mock;
    var keys = c.keys, ks = function (v) { return v == null ? '<span class="pill neutral">Unknown</span>' : v ? '<span class="pill ok">Configured</span>' : '<span class="pill neutral">Not configured</span>'; };
    $('envInfo').innerHTML = '<div class="kv">' +
      '<div>PayPal mode</div><div>' + (mock ? '<span class="pill bad">Offline mock</span> Local mock that mimics the PayPal API' : '<span class="pill ver">Sandbox</span> Real PayPal sandbox API calls') + '</div>' +
      '<div>AI model</div><div>' + esc(c.model || 'Unknown') + '</div>' +
      '<div>PayPal credentials</div><div>' + ks(keys && keys.paypal) + '</div>' +
      '<div>Groq API key</div><div>' + ks(keys && keys.groq) + '</div>' +
      '<div>Anthropic API key</div><div>' + ks(keys && keys.anthropic) + '</div>' +
      '<div>Simulated data</div><div>Holds and the 30-day shop history are simulated.</div></div>' +
      '<p class="note" style="margin-top:12px">' + I('lock', 13).replace('class="ic "', 'class="ic " style="display:inline;vertical-align:-2px"') + ' Secret values are never displayed or requested in the UI. Keys are read from the server environment.</p>';
    var eps = c.endpoints || [];
    $('apis').innerHTML = eps.length ? '<table class="tbl"><thead><tr><th>API</th><th>Method</th><th>Path</th><th>Used for</th></tr></thead><tbody>' +
      eps.map(function (e) { return '<tr><td>' + esc(e.api) + '</td><td><span class="pill neutral mono">' + esc(e.method) + '</span></td><td class="mono small">' + esc(e.path) + '</td><td>' + esc(e.used_for) + '</td></tr>'; }).join('') + '</tbody></table>'
      : '<div class="empty">This server version does not report its PayPal endpoints.</div>';
  }
  getJSON('/api/config').catch(function () {
    return getJSON('/api/model').then(function (m) { return { paypal: m.paypal, model: m.model }; });
  }).then(applyConfig).catch(function () {
    $('envText').textContent = 'Unknown';
    $('envInfo').innerHTML = '<div class="empty">Environment info unavailable.</div>';
    $('apis').innerHTML = '<div class="empty">Endpoint list unavailable.</div>';
  });

  /* ---------- run agent ---------- */
  function setRunning(on, label) {
    S.running = on; $('run').disabled = on; $('run').classList.toggle('busy', on); $('runTxt').textContent = label;
    $('runState').textContent = on ? 'Running' : (label === 'Run again' ? 'Completed' : 'Idle');
    $('reset').disabled = on;
  }
  $('run').onclick = function () {
    if (S.running) return;
    if (S.route !== 'agent') location.hash = '#/agent';
    setRunning(true, 'Agent working...'); S.explanations = {}; S.report = null; S.approvals = {}; renderApprovals();
    $('log').innerHTML = '';
    for (var i = 1; i <= 4; i++) step(i, null);
    step(1, 'active');
    var es = new EventSource('/api/run'); S.es = es;
    es.onmessage = function (m) {
      var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.type === 'assessment') {
        if (ev.phase === 'before') { S.before = ev.data; step(1, 'done'); step(2, 'active'); log('code', 'Code scored ' + ev.data.orders.length + ' live orders <span class="m">(account score ' + ev.data.account.score + ')</span>'); }
        else log('code', 'Code re-scored after fixes <span class="m">' + (S.before ? S.before.account.score : '') + ' to ' + ev.data.account.score + '</span>');
        setAssessment(ev.data);
      }
      if (ev.type === 'tool') {
        if (['upload_tracking', 'propose_refund'].indexOf(ev.name) >= 0) { step(2, 'done'); step(3, 'active'); }
        if (ev.name === 'submit_report') { step(2, 'done'); step(3, 'done'); step(4, 'active'); }
        log('tool', '<code>' + esc(ev.name) + '</code> <span class="m">' + esc(JSON.stringify(ev.input || {}).slice(0, 110)) + '</span>');
      }
      if (ev.type === 'thought') log('thought', esc(ev.text));
      if (ev.type === 'action') { log('action', esc(ev.text) + ' <span class="m">(' + esc(ev.ref) + ')</span>'); loadAudit(); }
      if (ev.type === 'approval') {
        log('approval', 'Refund of ' + esc(usd2(ev.amount)) + ' for ' + esc(ev.item) + ' queued for your approval');
        S.approvals[ev.id] = { ev: ev, status: 'pending' }; renderApprovals(); renderDrawer();
      }
      if (ev.type === 'report') { S.report = ev.report; renderReport(); }
      if (ev.type === 'error') log('error', esc(ev.text));
      if (ev.type === 'done') {
        es.close(); S.es = null;
        for (var j = 1; j <= 4; j++) if ($('st' + j).classList.contains('active')) step(j, 'done');
        setRunning(false, 'Run again'); loadAudit(); renderKpis();
      }
    };
    es.onerror = function () { es.close(); S.es = null; setRunning(false, 'Retry'); log('error', 'Connection to the server was lost.'); };
  };

  $('reset').onclick = function () {
    if (S.running) return;
    $('reset').disabled = true; $('reset').querySelector('.hide-sm').textContent = 'Resetting...';
    getJSON('/api/reset', { method: 'POST' }).catch(function (e) { return { ok: false, error: e.message }; }).then(function (r) {
      if (!r.ok) { alert(r.error || 'Reset failed'); $('reset').disabled = false; $('reset').querySelector('.hide-sm').textContent = 'Reset demo'; return; }
      location.reload();
    });
  };

  /* ---------- tabs ---------- */
  qa('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      qa('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
      ['audit', 'env', 'apis', 'guard'].forEach(function (t) { $('tab-' + t).hidden = t !== b.dataset.tab; });
    });
  });

  /* ---------- boot ---------- */
  route();
  getJSON('/api/assessment').then(function (a) {
    if (a.error) throw new Error(a.error);
    setAssessment(a);
  }).catch(function (e) {
    var msg = '<div class="empty">Could not load orders: ' + esc(e.message) + '. Run <code>npm run seed</code> and <code>npm run seed:capture</code> first.</div>';
    $('kpis').innerHTML = '<div class="card" style="grid-column:1/-1">' + msg + '</div>';
    $('ordersBody').innerHTML = '<tr><td colspan="8">' + msg + '</td></tr>';
    ['attention', 'chartFactors', 'chartSku', 'chartOrders', 'gauge'].forEach(function (id) { $(id).innerHTML = '<div class="empty">No data.</div>'; });
  });
  getJSON('/api/history').then(function (h) { S.history = h; renderKpis(); }).catch(function () { S.history = null; });
  loadAudit(); loadRules();
})();
