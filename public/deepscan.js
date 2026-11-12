/* Deep prevention scan card (Forecast page). Calls POST /api/deep-scan, which fans out on Render Workflows. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var I = function (n, s) { return window.UIcon ? window.UIcon(n, s) : ''; };
  var usd = function (n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); };
  var level = function (s) { return s >= 60 ? 'high' : s >= 35 ? 'medium' : 'low'; };

  function where(cfg) {
    var w = cfg && cfg.workflows;
    $('dsWhere').innerHTML = w && w.enabled
      ? '<span class="pill ok">' + I('server', 13) + ' Render Workflows · ' + esc(w.slug) + '</span>'
      : '<span class="pill neutral">' + I('server', 13) + ' Runs in-process (Render Workflows not configured)</span>';
  }
  fetch('/api/config').then(function (r) { return r.json(); }).then(where).catch(function () {});

  function render(r) {
    var meta = r.executed_on === 'render-workflows'
      ? 'Ran on <b>Render Workflows</b>: ' + r.task_runs + ' task runs on separate instances' + (r.run_id ? ' · run <code>' + esc(r.run_id) + '</code>' : '') + ' · ' + ((r.wall_ms || r.duration_ms) / 1000).toFixed(1) + 's'
      : 'Ran in-process: the same ' + r.task_runs + ' tasks, executed locally · ' + (r.duration_ms / 1000).toFixed(1) + 's';
    var head = '<tr><th>Fixes applied</th>' + r.growth.map(function (g) { return '<th class="num">' + g + '× sales</th>'; }).join('') + '</tr>';
    var body = r.combos.map(function (c) {
      return '<tr><td>' + esc(c.label) + '</td>' + r.growth.map(function (g) {
        var cell = r.matrix.filter(function (x) { return x.combo === c.key && x.multiplier === g; })[0] || {};
        var lv = level(cell.score);
        return '<td class="num"><span class="hm ' + lv + '" title="' + esc(c.label + ' at ' + g + '× sales: score ' + cell.score + ', ' + usd(cell.at_risk_usd) + ' at high risk') + '">' + cell.score + '</span></td>';
      }).join('') + '</tr>';
    }).join('');
    var best = null;
    r.growth.slice().reverse().forEach(function (g) {
      if (best) return;
      var ok = r.combos.filter(function (c) {
        var cell = r.matrix.filter(function (x) { return x.combo === c.key && x.multiplier === g; })[0];
        return cell && cell.score < 60;
      });
      if (ok.length) best = { g: g, combo: ok[0] };
    });
    var takeaway = best
      ? 'Up to <b>' + best.g + '× sales</b>, <b>' + esc(best.combo.label.toLowerCase()) + '</b> keeps you out of the high-risk zone.'
      : 'Even with every fix, a big sales surge pushes you into the high-risk zone. Ship with tracking and pace growth.';
    var rc = (r.root_causes || []).map(function (c) {
      return '<div class="ds-rc"><div><b>' + esc(c.sku) + '</b> <span class="pill high">' + (c.stats ? c.stats.vs_shop + '× shop average' : '') + '</span> <span class="pill neutral">AI inference</span></div>' +
        '<div style="margin-top:4px">' + esc(c.problem) + '</div>' +
        (c.evidence_quotes || []).map(function (q) { return '<blockquote>"' + esc(q) + '"</blockquote>'; }).join('') +
        (c.recommendation ? '<div class="small"><b>Fix:</b> ' + esc(c.recommendation) + '</div>' : '') + '</div>';
    }).join('');
    $('dsOut').innerHTML =
      '<div class="ds-meta small muted">' + meta + '</div>' +
      '<div class="ds-take">' + I('sparkle', 15) + '<span>' + takeaway + '</span></div>' +
      '<div class="scroll"><table class="tbl hm-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="small muted" style="margin-top:6px">Hold-risk score (0–100). Green below 35, amber 35–59, red 60 and above. Deterministic rules from risk.js.</div>' +
      (rc ? '<h3 class="ds-h3">Product root cause</h3>' + rc : '');
  }

  function run() {
    var b = $('dsRun');
    b.disabled = true; b.classList.add('busy'); $('dsRunTxt').textContent = 'Scanning…';
    $('dsOut').innerHTML = '<div class="skel" style="height:260px"></div>';
    fetch('/api/deep-scan', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.error) throw new Error(r.error);
      render(r);
    }).catch(function (e) {
      $('dsOut').innerHTML = '<div class="empty">Scan failed: ' + esc(e.message) + '</div>';
    }).then(function () { b.disabled = false; b.classList.remove('busy'); $('dsRunTxt').textContent = 'Run deep scan again'; });
  }
  document.addEventListener('DOMContentLoaded', function () { if ($('dsRun')) $('dsRun').onclick = run; });
  if (document.readyState !== 'loading' && $('dsRun')) $('dsRun').onclick = run;
})();
