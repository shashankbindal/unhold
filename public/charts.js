/* Unhold charts: dependency-free inline SVG. Exposes window.UnholdCharts.render(assessment, before). */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function isSimulated(src) { return /^simulated/i.test(String(src || '')); }
  function r1(v) { return Math.round(v * 10) / 10; }

  function widthOf(el) {
    var w = el && (el.clientWidth || (el.getBoundingClientRect && el.getBoundingClientRect().width));
    w = Math.floor(num(w));
    return clamp(w > 0 ? w : 600, 260, 900);
  }
  function svgOpen(w, h, label) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" ' +
      'preserveAspectRatio="xMinYMin meet" role="img" aria-label="' + esc(label) + '" ' +
      'style="display:block;max-width:100%;height:auto;font:inherit;font-size:11px;overflow:visible">';
  }
  function empty(msg) {
    return '<div style="color:var(--muted);font-size:12px;padding:8px 0">' + esc(msg) + '</div>';
  }
  function truncate(s, max) {
    s = String(s || '');
    return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
  }
  function charsFor(px) { return Math.max(8, Math.floor(px / 6.2)); }

  /* 1. Risk factors */
  function factorsChart(el, a) {
    var orders = (a && a.orders) || [];
    var map = {};
    orders.forEach(function (o) {
      if (!o || o.level === 'resolved') return;
      (o.factors || []).forEach(function (f) {
        if (!f) return;
        var key = f.label || f.id || 'Factor';
        if (!map[key]) map[key] = { label: key, points: 0, simulated: true, sources: {} };
        map[key].points += num(f.points);
        if (!isSimulated(f.source)) map[key].simulated = false;
        if (f.source) map[key].sources[f.source] = 1;
      });
    });
    var rows = Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (r) { return r.points > 0; })
      .sort(function (x, y) { return y.points - x.points; }).slice(0, 7);
    if (!rows.length) { el.innerHTML = empty('No open risk factors.'); return; }

    var W = widthOf(el), padR = 44, barH = 12, rowH = 34, top = 22;
    var max = rows[0].points || 1, track = W - padR;
    var H = top + rows.length * rowH + 4;
    var s = svgOpen(W, H, 'Risk points by factor');
    s += '<text x="0" y="11" style="fill:var(--muted)">' +
      '<tspan style="fill:var(--brand-2)">■</tspan> Verified data   ' +
      '<tspan style="fill:var(--muted);fill-opacity:.55">■</tspan> Simulated history</text>';
    rows.forEach(function (r, i) {
      var y = top + i * rowH, bw = Math.max(2, (r.points / max) * track);
      var tip = r.label + ': ' + r1(r.points) + ' pts (' + Object.keys(r.sources).join(', ') + ')';
      var fill = r.simulated ? 'fill:var(--muted);fill-opacity:.55' : 'fill:var(--brand-2)';
      s += '<g><title>' + esc(tip) + '</title>' +
        '<text x="0" y="' + (y + 11) + '" style="fill:var(--ink)">' + esc(truncate(r.label, charsFor(W))) + '</text>' +
        '<rect x="0" y="' + (y + 15) + '" width="' + track + '" height="' + barH + '" rx="3" style="fill:var(--line);fill-opacity:.35"/>' +
        '<rect x="0" y="' + (y + 15) + '" width="' + bw.toFixed(1) + '" height="' + barH + '" rx="3" style="' + fill + ';transition:width .4s ease"/>' +
        '<text x="' + (bw + 5).toFixed(1) + '" y="' + (y + 25) + '" style="fill:var(--ink);font-weight:600">' + esc(r1(r.points)) + '</text></g>';
    });
    el.innerHTML = s + '</svg>';
  }

  /* 2. SKU refund rates */
  function skuChart(el, a) {
    var acct = (a && a.account) || {};
    var stats = acct.sku_stats || {};
    var rows = Object.keys(stats).map(function (k) {
      var st = stats[k] || {};
      return { sku: k, rate: num(st.refund_rate), orders: num(st.orders), refunds: num(st.refunds), vs: num(st.vs_shop) };
    }).sort(function (x, y) { return y.rate - x.rate; });
    if (!rows.length) { el.innerHTML = empty('No SKU history yet.'); return; }

    var shop = num(acct.shop_refund_rate);
    var W = widthOf(el), labelW = Math.min(110, Math.round(W * 0.28)), padR = 92;
    var track = W - labelW - padR, rowH = 24, top = 18, barH = 13;
    var max = Math.max(shop, rows[0].rate, 0.01) * 1.08;
    var H = top + rows.length * rowH + 6;
    var x = function (v) { return labelW + (v / max) * track; };
    var s = svgOpen(W, H, 'Refund rate by SKU');
    rows.forEach(function (r, i) {
      var y = top + i * rowH, flagged = r.vs > 2 && r.refunds >= 3;
      var bw = Math.max(2, x(r.rate) - labelW);
      var fill = flagged ? 'fill:var(--bad)' : 'fill:var(--brand-2);fill-opacity:.45';
      var pct = (r.rate * 100).toFixed(1) + '%';
      var tip = r.sku + ': ' + pct + ' refund rate (' + r.refunds + '/' + r.orders + ' orders)' +
        (r.vs ? ', ' + r.vs.toFixed(1) + '× shop average' : '');
      s += '<g><title>' + esc(tip) + '</title>' +
        '<text x="' + (labelW - 6) + '" y="' + (y + 10) + '" text-anchor="end" style="fill:var(--ink)">' + esc(truncate(r.sku, charsFor(labelW - 6))) + '</text>' +
        '<rect x="' + labelW + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + barH + '" rx="3" style="' + fill + ';transition:width .4s ease"/>' +
        '<text x="' + (labelW + bw + 5).toFixed(1) + '" y="' + (y + 10) + '" style="fill:var(--ink)">' +
        '<tspan style="font-weight:600">' + esc(pct) + '</tspan>' +
        '<tspan style="fill:var(--muted)"> ' + esc(r.refunds + '/' + r.orders) + '</tspan></text></g>';
    });
    if (shop > 0) {
      var sx = x(shop).toFixed(1);
      s += '<g><title>' + esc('Shop average refund rate: ' + (shop * 100).toFixed(1) + '%') + '</title>' +
        '<line x1="' + sx + '" y1="' + (top - 4) + '" x2="' + sx + '" y2="' + (H - 2) + '" stroke-dasharray="4 3" style="stroke:var(--ink);stroke-opacity:.6;stroke-width:1"/>' +
        '<text x="' + sx + '" y="10" text-anchor="middle" style="fill:var(--muted)">' + esc('shop avg ' + (shop * 100).toFixed(1) + '%') + '</text></g>';
    }
    el.innerHTML = s + '</svg>';
  }

  /* 3. Per-order risk, before -> after */
  function levelColor(level) {
    return level === 'high' ? 'var(--bad)' : level === 'medium' ? 'var(--warn)' : 'var(--ok)';
  }
  function ordersChart(el, a, before) {
    var orders = ((a && a.orders) || []).slice().sort(function (x, y) { return num(y.risk) - num(x.risk); });
    if (!orders.length) { el.innerHTML = empty('No orders.'); return; }
    var prev = {};
    ((before && before.orders) || []).forEach(function (o) { if (o) prev[o.orderId] = o; });

    var W = widthOf(el), labelW = Math.min(170, Math.round(W * 0.36)), padR = 14;
    var track = W - labelW - padR, rowH = 24, top = 16;
    var H = top + orders.length * rowH + 4;
    var x = function (v) { return labelW + (clamp(num(v), 0, 100) / 100) * track; };
    var s = svgOpen(W, H, 'Risk score per order');
    s += '<defs><marker id="uhArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M0,0 L8,4 L0,8 z" style="fill:var(--muted)"/></marker></defs>';
    [[35, 'medium', 'var(--warn)'], [60, 'high', 'var(--bad)']].forEach(function (g) {
      var gx = x(g[0]).toFixed(1);
      s += '<line x1="' + gx + '" y1="' + (top - 4) + '" x2="' + gx + '" y2="' + (H - 2) + '" stroke-dasharray="2 3" style="stroke:var(--line);stroke-width:1"/>' +
        '<text x="' + (Number(gx) + 3) + '" y="9" style="fill:' + g[2] + ';font-size:10px">' + g[1] + '</text>';
    });
    s += '<text x="' + labelW + '" y="9" style="fill:var(--muted);font-size:10px">0</text>' +
      '<text x="' + (labelW + track) + '" y="9" text-anchor="end" style="fill:var(--muted);font-size:10px">100</text>';
    orders.forEach(function (o, i) {
      var cy = top + i * rowH + 8, risk = clamp(num(o.risk), 0, 100);
      var p = prev[o.orderId], b = p ? clamp(num(p.risk), 0, 100) : null;
      var changed = b !== null && b !== risk;
      var name = o.item || o.orderId || 'Order';
      var tip = name + (o.orderId ? ' (' + o.orderId + ')' : '') + ': risk ' + risk + ' (' + (o.level || '') + ')' +
        (changed ? ', was ' + b : '');
      s += '<g><title>' + esc(tip) + '</title>' +
        '<text x="0" y="' + (cy + 4) + '" style="fill:var(--ink)">' + esc(truncate(name, charsFor(labelW - 8))) + '</text>' +
        '<line x1="' + labelW + '" y1="' + cy + '" x2="' + (labelW + track) + '" y2="' + cy + '" style="stroke:var(--line);stroke-width:3;stroke-linecap:round"/>';
      if (changed) {
        var bx = x(b), ax = x(risk), dir = ax > bx ? -1 : 1;
        var col = risk < b ? 'var(--ok)' : 'var(--bad)';
        if (Math.abs(ax - bx) > 12) {
          s += '<line x1="' + (bx - dir * 5).toFixed(1) + '" y1="' + cy + '" x2="' + (ax + dir * 6).toFixed(1) + '" y2="' + cy +
            '" marker-end="url(#uhArrow)" style="stroke:var(--muted);stroke-width:1.5"/>';
        }
        s += '<circle cx="' + bx.toFixed(1) + '" cy="' + cy + '" r="4.5" style="fill:none;stroke:var(--muted);stroke-width:1.5"/>' +
          '<circle cx="' + ax.toFixed(1) + '" cy="' + cy + '" r="5" style="fill:' + col + '"/>';
      } else {
        s += '<circle cx="' + x(risk).toFixed(1) + '" cy="' + cy + '" r="5" style="fill:' + levelColor(o.level) + '"/>';
      }
      s += '</g>';
    });
    el.innerHTML = s + '</svg>';
  }

  var last = null;
  function q(id) { return typeof document !== 'undefined' && document.querySelector ? document.querySelector(id) : null; }
  function safe(fn, el) {
    if (!el) return;
    try { fn(); } catch (e) { el.innerHTML = empty('Chart unavailable.'); if (typeof console !== 'undefined') console.error(e); }
  }
  function render(assessment, before) {
    last = [assessment, before];
    var f = q('#chartFactors'), k = q('#chartSku'), o = q('#chartOrders');
    safe(function () { factorsChart(f, assessment); }, f);
    safe(function () { skuChart(k, assessment); }, k);
    safe(function () { ordersChart(o, assessment, before); }, o);
  }

  var t = null;
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', function () {
      if (!last) return;
      clearTimeout(t);
      t = setTimeout(function () { render(last[0], last[1]); }, 150);
    });
  }
  if (typeof window !== 'undefined') window.UnholdCharts = { render: render, esc: esc };
})();
