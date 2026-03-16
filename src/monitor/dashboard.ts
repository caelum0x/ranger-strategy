/**
 * Comprehensive HTML monitoring dashboard for the Ranger vault agent.
 *
 * Returns a self-contained HTML string (no external dependencies) that
 * polls the JSON APIs every 30 seconds and renders a dark-themed,
 * responsive dashboard suitable for hackathon demo videos.
 */

export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ranger Delta-Neutral Vault</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d1117;
    --bg-card: #161b22;
    --bg-card-hover: #1c2333;
    --border: #30363d;
    --text: #c9d1d9;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --orange: #db6d28;
    --purple: #bc8cff;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    padding: 0;
    min-height: 100vh;
  }

  .container {
    max-width: 1440px;
    margin: 0 auto;
    padding: 20px;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 0 24px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .header h1 {
    font-size: 22px;
    font-weight: 600;
    color: #f0f6fc;
  }
  .header-meta {
    display: flex;
    align-items: center;
    gap: 16px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .health-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    color: #fff;
  }
  .grade-A { background: var(--green); }
  .grade-B { background: #238636; }
  .grade-C { background: var(--yellow); }
  .grade-D { background: var(--orange); }
  .grade-F { background: var(--red); }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
    animation: pulse 2s infinite;
  }
  .status-dot.green { background: var(--green); }
  .status-dot.yellow { background: var(--yellow); }
  .status-dot.red { background: var(--red); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .refresh-indicator {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Cards */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .card-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card-title .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* Metrics row */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .metric-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    transition: border-color 0.2s;
  }
  .metric-card:hover {
    border-color: var(--accent);
  }
  .metric-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .metric-value {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace;
    font-size: 22px;
    font-weight: 700;
    color: #f0f6fc;
  }
  .metric-sub {
    font-family: 'SF Mono', 'Fira Code', Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .warning { color: var(--yellow); }

  /* Grid layout */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 16px;
  }
  @media (max-width: 900px) {
    .grid-2, .grid-3 { grid-template-columns: 1fr; }
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: 'SF Mono', 'Fira Code', Menlo, Consolas, monospace;
    font-size: 13px;
  }
  th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid #21262d;
    white-space: nowrap;
  }
  tr:hover td {
    background: var(--bg-card-hover);
  }
  .side-long { color: var(--green); font-weight: 600; }
  .side-short { color: var(--red); font-weight: 600; }

  /* Confidence bars */
  .confidence-bar-container {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .confidence-bar-bg {
    flex: 1;
    height: 8px;
    background: #21262d;
    border-radius: 4px;
    overflow: hidden;
    max-width: 120px;
  }
  .confidence-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s ease;
  }

  /* Sparkline chart (CSS-only) */
  .aum-chart {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 100px;
    padding: 12px 0;
  }
  .aum-bar {
    flex: 1;
    min-width: 12px;
    background: var(--accent);
    border-radius: 3px 3px 0 0;
    transition: height 0.5s ease;
    position: relative;
    cursor: pointer;
    opacity: 0.7;
  }
  .aum-bar:hover {
    opacity: 1;
  }
  .aum-bar .tooltip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #1c2333;
    border: 1px solid var(--border);
    padding: 4px 8px;
    border-radius: 4px;
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    font-size: 11px;
    white-space: nowrap;
    color: var(--text);
    z-index: 10;
  }
  .aum-bar:hover .tooltip {
    display: block;
  }

  /* Reasoning box */
  .reasoning-box {
    background: #0d1117;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    font-family: 'SF Mono', 'Fira Code', Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-muted);
    max-height: 250px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .reasoning-box::-webkit-scrollbar {
    width: 6px;
  }
  .reasoning-box::-webkit-scrollbar-track {
    background: transparent;
  }
  .reasoning-box::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }

  /* Loading / Error states */
  .loading {
    color: var(--text-muted);
    font-style: italic;
    padding: 20px;
    text-align: center;
  }
  .error-text {
    color: var(--red);
    font-size: 12px;
  }

  /* Attribution list */
  .attr-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid #21262d;
  }
  .attr-item:last-child { border-bottom: none; }
  .attr-asset {
    font-weight: 600;
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
  }
  .attr-detail {
    font-size: 12px;
    color: var(--text-muted);
    font-family: 'SF Mono', Menlo, Consolas, monospace;
  }

  /* Vault report key-value */
  .kv-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 16px;
  }
  .kv-item {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid #21262d;
  }
  .kv-key {
    color: var(--text-muted);
    font-size: 12px;
  }
  .kv-val {
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    font-weight: 500;
  }

  /* Indexer info */
  .indexer-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 700px) {
    .indexer-grid { grid-template-columns: 1fr; }
  }

  .tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tag-blue { background: rgba(88,166,255,0.15); color: var(--accent); }
  .tag-green { background: rgba(63,185,80,0.15); color: var(--green); }
  .tag-yellow { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .tag-red { background: rgba(248,81,73,0.15); color: var(--red); }
  .tag-purple { background: rgba(188,140,255,0.15); color: var(--purple); }
</style>
</head>
<body>

<div class="container">

  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <h1>Ranger Delta-Neutral Vault</h1>
      <div class="health-badge grade-A" id="health-badge">-</div>
    </div>
    <div class="header-meta">
      <span><span class="status-dot green" id="status-dot"></span><span id="status-text">Connecting...</span></span>
      <span id="cycle-text">Cycle -</span>
      <span id="regime-text">-</span>
      <span class="refresh-indicator" id="refresh-text">Refreshing...</span>
    </div>
  </div>

  <!-- Key Metrics Row -->
  <div class="metrics-grid" id="metrics-grid">
    <div class="metric-card">
      <div class="metric-label">Total Capital</div>
      <div class="metric-value" id="m-total-capital">--</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Deployed</div>
      <div class="metric-value" id="m-deployed">--</div>
      <div class="metric-sub" id="m-idle">idle: --</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Total PnL</div>
      <div class="metric-value" id="m-pnl">--</div>
      <div class="metric-sub" id="m-funding-pnl">funding: --</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">APY Estimate</div>
      <div class="metric-value" id="m-apy">--</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Health Ratio</div>
      <div class="metric-value" id="m-health-ratio">--</div>
      <div class="metric-sub" id="m-health-score">score: --</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Drawdown</div>
      <div class="metric-value" id="m-drawdown">--</div>
    </div>
  </div>

  <!-- Positions + Yield -->
  <div class="grid-3">
    <!-- Positions Table -->
    <div class="card">
      <div class="card-title"><span class="dot"></span> Open Positions</div>
      <div id="positions-container">
        <div class="loading">Loading positions...</div>
      </div>
    </div>
    <!-- Yield Breakdown -->
    <div class="card">
      <div class="card-title"><span class="dot"></span> Yield Breakdown</div>
      <div id="yield-container">
        <div class="loading">Loading yield...</div>
      </div>
    </div>
  </div>

  <!-- Predictions + Indexer -->
  <div class="grid-2">
    <!-- Funding Predictions -->
    <div class="card">
      <div class="card-title"><span class="dot"></span> Funding Predictions</div>
      <div id="predictions-container">
        <div class="loading">Loading predictions...</div>
      </div>
    </div>
    <!-- Indexer Status -->
    <div class="card">
      <div class="card-title"><span class="dot"></span> Indexer Status</div>
      <div id="indexer-container">
        <div class="loading">Loading indexer...</div>
      </div>
    </div>
  </div>

  <!-- Indexer History + Vault Performance -->
  <div class="grid-2">
    <!-- Indexer History Chart -->
    <div class="card">
      <div class="card-title"><span class="dot"></span> AUM History</div>
      <div id="history-container">
        <div class="loading">Loading history...</div>
      </div>
    </div>
    <!-- Vault Performance -->
    <div class="card">
      <div class="card-title"><span class="dot"></span> Vault Performance</div>
      <div id="vault-container">
        <div class="loading">Loading vault...</div>
      </div>
    </div>
  </div>

  <!-- Trade Win/Loss Record -->
  <div class="row-2">
    <div class="card">
      <div class="card-title"><span class="dot"></span> Trade Win/Loss Record</div>
      <div id="winloss-container">
        <div class="loading">Loading trades...</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title"><span class="dot"></span> Recent Trades</div>
      <div id="recent-trades-container" style="max-height:240px;overflow-y:auto;">
        <div class="loading">Loading...</div>
      </div>
    </div>
  </div>

  <!-- LLM Reasoning -->
  <div class="card">
    <div class="card-title"><span class="dot"></span> LLM Reasoning</div>
    <div class="reasoning-box" id="reasoning-box">Waiting for data...</div>
  </div>

</div>

<script>
(function() {
  // ── Helpers ──────────────────────────────────────────────────

  function fmt(n, decimals) {
    if (n == null || isNaN(n)) return '--';
    decimals = decimals != null ? decimals : 2;
    var parts = Number(n).toFixed(decimals).split('.');
    parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
    return parts.join('.');
  }

  function fmtUsd(n, decimals) {
    if (n == null || isNaN(n)) return '--';
    return '$' + fmt(n, decimals != null ? decimals : 2);
  }

  function pnlClass(v) {
    if (v == null) return '';
    var n = parseFloat(v);
    if (n > 0) return 'positive';
    if (n < 0) return 'negative';
    return '';
  }

  function timeAgo(ts) {
    if (!ts) return '--';
    var now = Date.now();
    var t = typeof ts === 'number' ? ts : new Date(ts).getTime();
    var diff = Math.max(0, Math.round((now - t) / 1000));
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function secsAgo(s) {
    if (s == null) return '--';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function escHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function gradeClass(g) {
    return 'grade-' + (g || 'F');
  }

  function confidenceColor(c) {
    var n = parseFloat(c);
    if (n >= 0.8) return 'var(--green)';
    if (n >= 0.5) return 'var(--yellow)';
    return 'var(--red)';
  }

  async function fetchJson(url) {
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // ── Data fetching + rendering ──────────────────────────────

  var lastRefresh = null;

  async function refresh() {
    var results = await Promise.allSettled([
      fetchJson('/status'),
      fetchJson('/positions'),
      fetchJson('/yield'),
      fetchJson('/health'),
      fetchJson('/indexer'),
      fetchJson('/indexer/history'),
      fetchJson('/predictions'),
      fetchJson('/vault'),
      fetchJson('/trades')
    ]);

    var status = results[0].value;
    var positions = results[1].value;
    var yieldData = results[2].value;
    var health = results[3].value;
    var indexer = results[4].value;
    var history = results[5].value;
    var predictions = results[6].value;
    var vault = results[7].value;
    var trades = results[8].value;

    lastRefresh = Date.now();
    updateRefreshText();

    // ── Header / Status ──
    if (status) {
      var dot = document.getElementById('status-dot');
      var statusText = document.getElementById('status-text');
      statusText.textContent = status.status || 'unknown';
      dot.className = 'status-dot ' + (status.status === 'running' ? 'green' : 'yellow');
      document.getElementById('cycle-text').textContent = 'Cycle ' + (status.cycle != null ? status.cycle : '-');
      document.getElementById('regime-text').textContent = status.regime || '';

      // Key metrics from /status
      document.getElementById('m-total-capital').textContent = fmtUsd(status.totalCapital);
      document.getElementById('m-deployed').textContent = fmtUsd(status.deployedCapital);
      document.getElementById('m-idle').textContent = 'idle: ' + fmtUsd(status.idleCapital);
      var pnlEl = document.getElementById('m-pnl');
      pnlEl.textContent = fmtUsd(status.totalPnl, 4);
      pnlEl.className = 'metric-value ' + pnlClass(status.totalPnl);
      document.getElementById('m-funding-pnl').textContent = 'funding: ' + fmtUsd(status.fundingPnl, 4);
      document.getElementById('m-apy').textContent = status.apyEstimate || '--';
    }

    // ── Health ──
    if (health) {
      var badge = document.getElementById('health-badge');
      badge.textContent = health.grade || '-';
      badge.className = 'health-badge ' + gradeClass(health.grade);
      document.getElementById('m-health-ratio').textContent = fmt(health.healthRatio, 4);
      document.getElementById('m-health-score').textContent = 'score: ' + (health.healthScore != null ? health.healthScore + '/100' : '--');
      var ddEl = document.getElementById('m-drawdown');
      ddEl.textContent = fmt(health.drawdown, 2) + '%';
      var ddVal = parseFloat(health.drawdown);
      ddEl.className = 'metric-value' + (ddVal > 2 ? ' negative' : ddVal > 1 ? ' warning' : '');
    }

    // ── Positions Table ──
    renderPositions(positions);

    // ── Yield Breakdown ──
    renderYield(yieldData);

    // ── Predictions ──
    renderPredictions(predictions);

    // ── Indexer ──
    renderIndexer(indexer);

    // ── Indexer History Chart ──
    renderHistory(history);

    // ── Vault Performance ──
    renderVault(vault);

    // ── Win/Loss Record ──
    renderWinLoss(trades);

    // ── Reasoning ──
    if (predictions && predictions.reasoning) {
      var box = document.getElementById('reasoning-box');
      box.textContent = predictions.reasoning;
      box.scrollTop = box.scrollHeight;
    } else {
      document.getElementById('reasoning-box').textContent = 'No LLM reasoning available yet.';
    }
  }

  // ── Render helpers ─────────────────────────────────────────

  function renderPositions(data) {
    var container = document.getElementById('positions-container');
    if (!data) { container.innerHTML = '<div class="loading">Error loading positions</div>'; return; }
    if (!data.positions || data.positions.length === 0) {
      container.innerHTML = '<div class="loading">No open positions</div>';
      return;
    }
    var html = '<table><thead><tr>'
      + '<th>Asset</th><th>Side</th><th>Venue</th><th>Size</th>'
      + '<th>Notional</th><th>PnL</th><th>Leverage</th>'
      + '</tr></thead><tbody>';
    data.positions.forEach(function(p) {
      var sideClass = (p.side || '').toLowerCase().indexOf('long') >= 0 ? 'side-long' : 'side-short';
      html += '<tr>'
        + '<td>' + escHtml(p.asset) + '</td>'
        + '<td class="' + sideClass + '">' + escHtml(p.side) + '</td>'
        + '<td>' + escHtml(p.venue) + '</td>'
        + '<td>' + fmt(p.size, 6) + '</td>'
        + '<td>' + fmtUsd(p.notional) + '</td>'
        + '<td class="' + pnlClass(p.pnl) + '">' + fmtUsd(p.pnl, 4) + '</td>'
        + '<td>' + fmt(p.leverage, 2) + 'x</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderYield(data) {
    var container = document.getElementById('yield-container');
    if (!data || data.error) { container.innerHTML = '<div class="loading">Error loading yield</div>'; return; }
    var trendTag = '';
    if (data.trend) {
      var dir = data.trend.direction || 'flat';
      var tagClass = dir === 'improving' ? 'tag-green' : dir === 'declining' ? 'tag-red' : 'tag-blue';
      trendTag = '<span class="tag ' + tagClass + '">' + escHtml(dir) + '</span>';
    }

    var html = '<div style="margin-bottom:16px">'
      + '<div class="kv-item"><span class="kv-key">Net Yield</span><span class="kv-val">' + escHtml(data.netYield || '--') + '</span></div>'
      + '<div class="kv-item"><span class="kv-key">Annualized APY</span><span class="kv-val">' + escHtml(data.annualizedAPY || '--') + '</span></div>'
      + '<div class="kv-item"><span class="kv-key">Capital Utilization</span><span class="kv-val">' + escHtml(data.capitalUtilization || '--') + '</span></div>'
      + '<div class="kv-item"><span class="kv-key">Trend</span><span class="kv-val">' + trendTag + '</span></div>'
      + '</div>';

    if (data.assetAttribution && data.assetAttribution.length > 0) {
      html += '<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:8px">Asset Attribution</div>';
      data.assetAttribution.forEach(function(a) {
        html += '<div class="attr-item">'
          + '<div><span class="attr-asset">' + escHtml(a.asset) + '</span>'
          + ' <span class="tag tag-purple">' + escHtml(a.direction || a.spotSide) + '</span></div>'
          + '<div class="attr-detail">notional ' + fmtUsd(a.notional) + ' | daily ' + fmtUsd(a.dailyYield, 4) + ' | annual ' + fmtUsd(a.annualYield, 4) + '</div>'
          + '</div>';
      });
    }
    container.innerHTML = html;
  }

  function renderPredictions(data) {
    var container = document.getElementById('predictions-container');
    if (!data) { container.innerHTML = '<div class="loading">Error loading predictions</div>'; return; }

    var sourceTag = '<span class="tag ' + (data.source === 'LLM' ? 'tag-purple' : 'tag-blue') + '">' + escHtml(data.source || 'unknown') + '</span>';
    var regimeTag = '<span class="tag tag-yellow">' + escHtml(data.regime || '--') + '</span>';

    var html = '<div style="display:flex;gap:8px;margin-bottom:16px">' + sourceTag + regimeTag + '</div>';

    if (data.predictions && data.predictions.length > 0) {
      data.predictions.forEach(function(p) {
        var conf = p.confidence != null ? parseFloat(p.confidence) : null;
        var barWidth = conf != null ? Math.min(100, Math.round(conf * 100)) : 0;
        html += '<div style="margin-bottom:10px">'
          + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
          + '<span style="font-weight:600;font-family:monospace">' + escHtml(p.asset) + '</span>'
          + '<span style="font-size:12px;color:var(--text-muted)">history: ' + (p.historyLength != null ? p.historyLength : '--') + '</span>'
          + '</div>';
        if (conf != null) {
          html += '<div class="confidence-bar-container">'
            + '<div class="confidence-bar-bg"><div class="confidence-bar-fill" style="width:' + barWidth + '%;background:' + confidenceColor(conf) + '"></div></div>'
            + '<span style="font-family:monospace;font-size:12px">' + (barWidth) + '%</span>'
            + '</div>';
        }
        html += '</div>';
      });
    } else {
      html += '<div class="loading">No predictions available</div>';
    }
    container.innerHTML = html;
  }

  function renderIndexer(data) {
    var container = document.getElementById('indexer-container');
    if (!data) { container.innerHTML = '<div class="loading">Error loading indexer</div>'; return; }

    var html = '<div class="indexer-grid">';

    // Snapshot
    html += '<div>';
    html += '<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:8px">Latest Snapshot</div>';
    if (data.snapshot) {
      html += '<div class="kv-item"><span class="kv-key">AUM</span><span class="kv-val">' + fmtUsd(data.snapshot.aum, 0) + '</span></div>'
        + '<div class="kv-item"><span class="kv-key">Share Price</span><span class="kv-val">' + (data.snapshot.sharePrice ? fmt(data.snapshot.sharePrice, 6) : '--') + '</span></div>'
        + '<div class="kv-item"><span class="kv-key">Strategies</span><span class="kv-val">' + (data.snapshot.strategyCount != null ? data.snapshot.strategyCount : '--') + '</span></div>'
        + '<div class="kv-item"><span class="kv-key">Age</span><span class="kv-val">' + (data.snapshotAgeSec != null ? secsAgo(data.snapshotAgeSec) : '--') + '</span></div>';
    } else {
      html += '<div class="loading">No snapshot</div>';
    }
    html += '</div>';

    // Decision
    html += '<div>';
    html += '<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:8px">Latest Decision</div>';
    if (data.decision) {
      var actionTag = '<span class="tag tag-green">' + escHtml(data.decision.action) + '</span>';
      html += '<div class="kv-item"><span class="kv-key">Action</span><span class="kv-val">' + actionTag + '</span></div>'
        + '<div class="kv-item"><span class="kv-key">Confidence</span><span class="kv-val">' + fmt(data.decision.confidence, 2) + '</span></div>';
      if (data.decision.targetAllocation) {
        html += '<div class="kv-item"><span class="kv-key">Target Alloc</span><span class="kv-val">' + fmt(data.decision.targetAllocation, 2) + '</span></div>';
      }
      if (data.decision.targetLeverage) {
        html += '<div class="kv-item"><span class="kv-key">Target Lev</span><span class="kv-val">' + fmt(data.decision.targetLeverage, 2) + 'x</span></div>';
      }
      html += '<div class="kv-item"><span class="kv-key">Age</span><span class="kv-val">' + (data.decisionAgeSec != null ? secsAgo(data.decisionAgeSec) : '--') + '</span></div>';
      if (data.decision.rationale) {
        html += '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);line-height:1.5">' + escHtml(data.decision.rationale) + '</div>';
      }
    } else {
      html += '<div class="loading">No decision</div>';
    }
    html += '</div>';

    html += '</div>';

    if (data.strategyProfile) {
      html += '<div style="margin-top:12px"><span class="tag tag-blue">' + escHtml(data.strategyProfile) + '</span></div>';
    }

    container.innerHTML = html;
  }

  function renderHistory(data) {
    var container = document.getElementById('history-container');
    if (!data || !data.snapshots || data.snapshots.length === 0) {
      container.innerHTML = '<div class="loading">No history data</div>';
      return;
    }

    var snaps = data.snapshots;
    var aums = snaps.map(function(s) { return typeof s.aum === 'number' ? s.aum : parseFloat(s.aum) || 0; });
    var maxAum = Math.max.apply(null, aums);
    var minAum = Math.min.apply(null, aums);
    var range = maxAum - minAum || 1;

    var html = '<div class="aum-chart">';
    snaps.forEach(function(s, i) {
      var pct = ((aums[i] - minAum) / range) * 80 + 20; // min 20% height
      var label = fmtUsd(aums[i], 0) + ' | ' + timeAgo(s.timestamp);
      html += '<div class="aum-bar" style="height:' + pct + '%">'
        + '<div class="tooltip">' + escHtml(label) + '</div>'
        + '</div>';
    });
    html += '</div>';
    html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted)">'
      + '<span>' + timeAgo(snaps[0].timestamp) + '</span>'
      + '<span>' + timeAgo(snaps[snaps.length - 1].timestamp) + '</span>'
      + '</div>';

    // Recent decisions summary
    if (data.decisions && data.decisions.length > 0) {
      html += '<div style="margin-top:16px;font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:6px">Recent Decisions</div>';
      html += '<table><thead><tr><th>Action</th><th>Confidence</th><th>When</th></tr></thead><tbody>';
      data.decisions.slice(0, 5).forEach(function(d) {
        html += '<tr>'
          + '<td><span class="tag tag-green">' + escHtml(d.action) + '</span></td>'
          + '<td>' + fmt(d.confidence, 2) + '</td>'
          + '<td>' + timeAgo(d.createdAt) + '</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
    }

    container.innerHTML = html;
  }

  function renderVault(data) {
    var container = document.getElementById('vault-container');
    if (!data) { container.innerHTML = '<div class="loading">Error loading vault</div>'; return; }

    var html = '';
    var skip = { rangerVault: 1 };

    // Main performance metrics
    var keys = Object.keys(data).filter(function(k) { return !skip[k]; });
    if (keys.length > 0) {
      keys.forEach(function(k) {
        var val = data[k];
        if (typeof val === 'object' && val !== null) return;
        html += '<div class="kv-item"><span class="kv-key">' + escHtml(k) + '</span><span class="kv-val">' + escHtml(String(val)) + '</span></div>';
      });
    }

    // Ranger vault sub-section
    if (data.rangerVault) {
      html += '<div style="margin-top:16px;font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:8px">Ranger Earn Vault</div>';
      Object.keys(data.rangerVault).forEach(function(k) {
        html += '<div class="kv-item"><span class="kv-key">' + escHtml(k) + '</span><span class="kv-val">' + escHtml(String(data.rangerVault[k])) + '</span></div>';
      });
    }

    container.innerHTML = html || '<div class="loading">No vault data</div>';
  }

  function renderWinLoss(data) {
    var wlContainer = document.getElementById('winloss-container');
    var rtContainer = document.getElementById('recent-trades-container');
    if (!data || !data.winLoss) {
      wlContainer.innerHTML = '<div class="loading">No trade data yet</div>';
      rtContainer.innerHTML = '<div class="loading">No trades yet</div>';
      return;
    }

    var wl = data.winLoss;

    // Win/Loss summary
    var html = '<div class="metrics-row" style="margin-bottom:12px">';
    html += '<div class="metric"><span class="metric-label">Round Trips</span><span class="metric-value">' + (wl.totalRoundTrips || 0) + '</span></div>';
    html += '<div class="metric"><span class="metric-label">Wins</span><span class="metric-value positive">' + (wl.wins || 0) + '</span></div>';
    html += '<div class="metric"><span class="metric-label">Losses</span><span class="metric-value negative">' + (wl.losses || 0) + '</span></div>';
    html += '<div class="metric"><span class="metric-label">Win Rate</span><span class="metric-value">' + (wl.winRate || 'N/A') + '</span></div>';
    html += '</div>';

    // Per-asset breakdown
    if (wl.byAsset && Object.keys(wl.byAsset).length > 0) {
      html += '<table><thead><tr><th>Asset</th><th>Opens</th><th>Closes</th><th>Wins</th><th>Losses</th></tr></thead><tbody>';
      Object.keys(wl.byAsset).forEach(function(asset) {
        var a = wl.byAsset[asset];
        html += '<tr><td>' + escHtml(asset) + '</td><td>' + a.opens + '</td><td>' + a.closes + '</td>';
        html += '<td class="positive">' + a.wins + '</td><td class="negative">' + a.losses + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    // Also show trade summary
    if (data.summary) {
      html += '<div style="margin-top:12px;font-size:12px;color:var(--text-muted)">';
      html += 'Total signals: ' + (data.summary.totalSignals || 0);
      html += ' | Executed: ' + (data.summary.totalExecutions || 0);
      html += ' | Failed: ' + (data.summary.totalFailures || 0);
      html += ' | Flips: ' + (data.summary.totalFlips || 0);
      html += '</div>';
    }

    wlContainer.innerHTML = html;

    // Recent trades list
    if (wl.recentTrades && wl.recentTrades.length > 0) {
      var rtHtml = '<table><thead><tr><th>Time</th><th>Asset</th><th>Result</th><th>Reason</th></tr></thead><tbody>';
      wl.recentTrades.slice().reverse().forEach(function(t) {
        var resultClass = t.result === 'win' ? 'positive' : t.result === 'loss' ? 'negative' : '';
        rtHtml += '<tr><td style="white-space:nowrap">' + timeAgo(t.timestamp) + '</td>';
        rtHtml += '<td>' + escHtml(t.asset) + '</td>';
        rtHtml += '<td class="' + resultClass + '">' + t.result.toUpperCase() + '</td>';
        rtHtml += '<td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis">' + escHtml(t.reason) + '</td></tr>';
      });
      rtHtml += '</tbody></table>';
      rtContainer.innerHTML = rtHtml;
    } else {
      rtContainer.innerHTML = '<div class="loading">No closed trades yet</div>';
    }
  }

  // ── Refresh timer ──────────────────────────────────────────

  function updateRefreshText() {
    var el = document.getElementById('refresh-text');
    if (!lastRefresh) { el.textContent = 'Refreshing...'; return; }
    var ago = Math.round((Date.now() - lastRefresh) / 1000);
    el.textContent = 'Updated ' + ago + 's ago';
  }

  // Initial load
  refresh();

  // Auto-refresh every 30 seconds
  setInterval(refresh, 30000);

  // Update "updated X s ago" every second
  setInterval(updateRefreshText, 1000);

})();
</script>
</body>
</html>`;
}
